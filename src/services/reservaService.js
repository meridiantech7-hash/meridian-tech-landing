const axios = require('axios');
const { dbGet, dbRun } = require('../config/database');
const geminiService = require('./geminiService');
const { createReservation } = require('../routes/reservations');
const { emitToClient } = require('../routes/conversations');
const logger = require('../utils/logger');

/**
 * Reservas que nacen de la conversación.
 *
 * Existe por un defecto real: la tabla de reservas y la pestaña de la tablet
 * funcionaban, pero NADIE las llenaba desde el chat. El agente conversaba,
 * el cliente decía "mañana a las 7 somos 4", y eso no quedaba en ninguna
 * parte — la reserva solo existía si alguien la digitaba a mano.
 *
 * Mismo patrón que los pedidos (syncOrderFromConversation): la IA lee la
 * conversación, y si hay una reserva con fecha y hora concretas la crea en
 * estado `pendiente` para que una persona la confirme. Para MeridianTech la
 * "reserva" es la demo que Valeria agenda; para un restaurante, la mesa.
 */

const MODELO = 'gemini-3.5-flash-lite';

/**
 * Filtro barato antes de gastar una llamada de IA: si el mensaje no trae nada
 * que suene a fecha, hora o agenda, no puede haber una reserva nueva. Sin esto
 * se pagaría una extracción por cada "hola" y cada "gracias".
 */
const PISTAS_DE_AGENDA = /\b(hoy|mañana|manana|pasado|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|reserv\w*|agend\w*|cita|demo|mesa|personas|somos|\d{1,2}\s?(:\d{2})?\s?(am|pm|a\.?\s?m\.?|p\.?\s?m\.?)|\d{1,2}:\d{2}|a las \d)/i;

const tienePistaDeAgenda = (texto) => PISTAS_DE_AGENDA.test(texto || '');

/** Fecha y hora actuales en Colombia, para que "mañana a las 3" se resuelva bien. */
const ahoraEnBogota = () => new Date().toLocaleString('es-CO', {
  timeZone: 'America/Bogota', weekday: 'long', year: 'numeric', month: 'long',
  day: 'numeric', hour: '2-digit', minute: '2-digit'
});

const extraerReserva = async (clientId, historial, textoNuevo) => {
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) return null;

  const config = await geminiService.getBotConfig(clientId);
  // Igual que takes_orders: el negocio que no agenda no paga esta llamada.
  if (config.takes_reservations !== undefined && !Number(config.takes_reservations)) return null;
  const recientes = [textoNuevo, ...historial.slice(-3).map((m) => m.content)].join(' ');
  if (!tienePistaDeAgenda(recientes)) return null;

  const transcripcion = [...historial, { sender_type: 'end_customer', content: textoNuevo }]
    .filter((m) => m.content)
    .slice(-14)
    .map((m) => `${m.sender_type === 'end_customer' ? 'CLIENTE' : 'NEGOCIO'}: ${m.content}`)
    .join('\n');

  const instruccion = `Lee la conversación y decide si quedó acordada una RESERVA, CITA o DEMO con fecha y hora concretas.

Ahora mismo en Colombia es: ${ahoraEnBogota()}.

REGLAS:
- tiene_reserva=true SOLO si hay un día y una hora concretos. "Esta semana" o "después te confirmo" NO es una reserva.
- fecha_hora: en formato ISO 8601 con zona horaria de Colombia, por ejemplo 2026-09-12T19:00:00-05:00. Resuelve "mañana", "el sábado", "a las 7" contra la fecha de arriba. Si dice "7" sin am/pm y es para comer, asume la noche.
- personas: cuántas personas, si se dijo. Si no, 0.
- nombre: el nombre del cliente si lo dijo.
- No inventes nada que no esté en la conversación. Ante la duda, tiene_reserva=false: una reserva mal puesta es peor que ninguna.`;

  try {
    const { data } = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODELO}:generateContent?key=${GEMINI_API_KEY}`,
      {
        systemInstruction: { parts: [{ text: instruccion }] },
        contents: [{ role: 'user', parts: [{ text: transcripcion }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'OBJECT',
            properties: {
              tiene_reserva: { type: 'BOOLEAN' },
              fecha_hora: { type: 'STRING' },
              personas: { type: 'INTEGER' },
              nombre: { type: 'STRING' },
              notas: { type: 'STRING' }
            },
            required: ['tiene_reserva']
          },
          temperature: 0
        }
      },
      { headers: { 'Content-Type': 'application/json' }, timeout: 20000 }
    );

    const bruto = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!bruto) return null;
    const r = JSON.parse(bruto);
    if (!r.tiene_reserva || !r.fecha_hora) return null;

    const cuando = new Date(r.fecha_hora);
    // Una fecha ilegible o en el pasado no se guarda: sería una reserva que
    // nadie puede cumplir, y aparecería en la tablet como si fuera real.
    if (isNaN(cuando) || cuando.getTime() < Date.now() - 60 * 60 * 1000) {
      logger.info('Reserva descartada: fecha inválida o pasada', { fecha: r.fecha_hora });
      return null;
    }

    return {
      scheduled_at: cuando.toISOString(),
      party_size: r.personas > 0 ? r.personas : null,
      customer_name: r.nombre || null,
      notes: r.notas || null
    };
  } catch (error) {
    logger.warn('Falló la extracción de reserva', {
      error: error.response?.data?.error?.message || error.message
    });
    return null;
  }
};

/**
 * Crea la reserva, o actualiza la que la misma conversación ya tenía pendiente
 * (el cliente cambió la hora). Nunca lanza: si falla, la conversación sigue.
 */
const sincronizarReserva = async (clientId, conversation, historial, textoNuevo, channelType) => {
  try {
    const datos = await extraerReserva(clientId, historial, textoNuevo);
    if (!datos) return null;

    const abierta = await dbGet(
      "SELECT * FROM reservations WHERE conversation_id = ? AND status = 'pendiente' ORDER BY created_at DESC LIMIT 1",
      [conversation.id]
    );

    const nombre = datos.customer_name || conversation.end_customer_name || null;

    if (abierta) {
      await dbRun(
        `UPDATE reservations SET scheduled_at = ?, party_size = COALESCE(?, party_size),
         customer_name = COALESCE(?, customer_name), notes = COALESCE(?, notes),
         updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [datos.scheduled_at, datos.party_size, nombre, datos.notes, abierta.id]
      );
      const actualizada = await dbGet('SELECT * FROM reservations WHERE id = ?', [abierta.id]);
      emitToClient(clientId, 'reservation:updated', actualizada);
      logger.info('Reserva pendiente actualizada desde el chat', {
        reservationId: abierta.id, conversationId: conversation.id
      });
      return actualizada;
    }

    // Nace 'pendiente': igual que los pedidos de la IA, una persona la confirma.
    return await createReservation({
      client_id: clientId,
      conversation_id: conversation.id,
      source: 'bot',
      channel_type: channelType,
      customer_name: nombre,
      customer_phone: conversation.end_customer_id,
      party_size: datos.party_size,
      scheduled_at: datos.scheduled_at,
      notes: datos.notes,
      status: 'pendiente'
    });
  } catch (error) {
    logger.error('Error sincronizando la reserva desde la conversación', {
      conversationId: conversation.id, error: error.message
    });
    return null;
  }
};

module.exports = { sincronizarReserva, extraerReserva, tienePistaDeAgenda };
