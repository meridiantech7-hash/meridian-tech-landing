const axios = require('axios');
const { dbAll } = require('../config/database');
const logger = require('../utils/logger');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

/**
 * Autorización por número de WhatsApp y atajos operativos para el dueño.
 *
 * Dos reglas de negocio, ninguna delegada a la IA a propósito:
 *
 * 1. El único número que puede pedir inventario, estados de cuenta o de
 *    reservas es el `owner_phone` fijo de `bot_configs`. Cualquier otro que
 *    lo pida se rechaza con un mensaje fijo, ANTES de llamar a Gemini — igual
 *    que `ventaService.pidePagar` o los `handoff_keywords`: si ya sabemos que
 *    hay que responder algo fijo, no tiene sentido pagar por una respuesta.
 * 2. Al dueño se le responden pedidos y reservas de hoy con una consulta
 *    directa a la base de datos, no con la IA adivinando — un número mal
 *    leído en un total no es un error que el negocio pueda permitirse.
 */

const esDueno = (config, endCustomerId) =>
  !!config.owner_phone && !!endCustomerId && config.owner_phone === endCustomerId;

/**
 * Temas que jamás responde la IA por cuenta propia, sin importar quién
 * pregunte — la respuesta siempre es fija, salvo que quien escribe sea el
 * dueño (ver `esConsultaPedidos`/`esConsultaReservas` para esos casos).
 */
const TEMAS_RESTRINGIDOS = [
  'inventario', 'actualizar el inventario', 'actualiza el inventario',
  'estado de cuenta', 'estados de cuenta', 'balance', 'balances',
  'estado de reservas', 'estados de reservas', 'reporte', 'reportes',
  'subir reporte', 'subir un reporte', 'cuánto han vendido', 'cuanto han vendido',
  'cuánto llevan vendido', 'cuanto llevan vendido'
];

const normalizar = (s) => (s || '')
  .toLowerCase()
  .normalize('NFD')
  .replace(/[̀-ͯ]/g, '');

const esTemaRestringido = (texto) => {
  const t = normalizar(texto);
  if (!t) return null;
  return TEMAS_RESTRINGIDOS.find((f) => t.includes(normalizar(f))) || null;
};

const MENSAJE_NO_AUTORIZADO =
  'Uy, esa información no la puedo compartir por este medio — no estamos autorizados para responder este tipo de cosas por aquí. Si necesitas algo puntual, mejor hablas directo con el encargado del negocio 🙌';

/**
 * ¿Están pidiendo CAMBIAR el menú o los precios (no solo preguntar por ellos)?
 *
 * Igual que inventario/reservas/pedidos: SOLO el dueño autorizado puede
 * pedirlo. La diferencia es que aquí sí se ejecuta (ver `aplicarCambioMenu`)
 * en vez de solo consultar — cualquier otro número lo tiene bloqueado de
 * forma fija, sin excepción.
 *
 * A propósito NO incluye "plan": "quiero cambiar de plan" es un cliente
 * pidiendo cambiar SU suscripción, una conversación legítima que el asistente
 * sí debe poder tener — muy distinto de editar el menú del negocio.
 */
const esSolicitudDeEdicion = (texto) => {
  const t = normalizar(texto);
  if (!t) return false;
  return /\b(cambiar?|actualizar?|modificar?|edita[r]?|sub[ei][r]?)\b[\s\S]{0,25}\b(menu|precio|precios)\b/.test(t);
};

const MENSAJE_EDICION_NO_AUTORIZADA =
  'Los cambios de menú o precios solo los puede pedir el encargado del negocio — no estamos autorizados para hacerlos por aquí 🙌';

/**
 * Aplica un cambio de menú/precios que pidió el DUEÑO, en lenguaje natural,
 * sobre el conocimiento previo de su propio negocio (`bot_configs.knowledge_base`
 * — el menú, precios y datos que el bot usa para responder a sus clientes).
 *
 * Deliberadamente solo toca `knowledge_base`, nunca `plans` (los planes de
 * MERIDIANTECH, que sí facturan de verdad vía Bold) — lo que el dueño de un
 * restaurante puede cambiar es SU menú, no lo que Meridian le cobra a él.
 *
 * Se le pide al modelo el texto COMPLETO de vuelta (no un parche) para no
 * arriesgarse a un merge mal hecho, y un resumen corto para que el dueño vea
 * de inmediato si se entendió bien — si no, lo corrige con otro mensaje.
 */
const aplicarCambioMenu = async (clientId, config, instruccion) => {
  if (!GEMINI_API_KEY) {
    return { ok: false, mensaje: 'No puedo hacer ese cambio ahora mismo — hazlo desde la tablet mientras tanto.' };
  }

  try {
    const { data } = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`,
      {
        systemInstruction: { parts: [{
          text: 'Mantienes actualizado el conocimiento previo de un negocio (menú, precios, horarios, datos que el bot usa para responder a sus clientes). ' +
            'Te dan el texto actual y un pedido de cambio en lenguaje natural del dueño. Devuelve el texto COMPLETO ya actualizado, aplicando SOLO lo que pidió, ' +
            'sin borrar ni inventar nada más, conservando el mismo formato y estilo del original. Si el pedido es ambiguo o no se puede aplicar con lo que hay, ' +
            'no inventes: dilo en el resumen y deja el conocimiento sin cambios.'
        }] },
        contents: [{
          role: 'user',
          parts: [{ text: `CONOCIMIENTO ACTUAL:\n${config.knowledge_base || '(vacío)'}\n\nPEDIDO DEL DUEÑO: "${instruccion}"` }]
        }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'OBJECT',
            properties: {
              nuevo_conocimiento: { type: 'STRING' },
              resumen: { type: 'STRING' },
              aplicado: { type: 'BOOLEAN' }
            },
            required: ['nuevo_conocimiento', 'resumen', 'aplicado']
          },
          temperature: 0
        }
      },
      { headers: { 'Content-Type': 'application/json' }, timeout: 20000 }
    );

    const bruto = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!bruto) return { ok: false, mensaje: 'No pude procesar ese cambio — hazlo desde la tablet mientras tanto.' };

    const parsed = JSON.parse(bruto);
    if (!parsed.aplicado || !parsed.nuevo_conocimiento) {
      return { ok: false, mensaje: parsed.resumen || 'No entendí bien el cambio — ¿me lo explicas de otra forma?' };
    }

    return { ok: true, nuevoConocimiento: parsed.nuevo_conocimiento, resumen: parsed.resumen };
  } catch (error) {
    logger.warn('Fallo aplicando cambio de menú por WhatsApp', {
      clientId, error: error.response?.data?.error?.message || error.message
    });
    return { ok: false, mensaje: 'Tuve un problema aplicando ese cambio — hazlo desde la tablet mientras tanto.' };
  }
};

/** ¿Pregunta por los pedidos/órdenes de hoy? */
const esConsultaPedidos = (texto) => {
  const t = normalizar(texto);
  return /pedidos? de hoy|c[oó]mo van los pedidos|estado de los pedidos|cu[aá]ntos pedidos/.test(t);
};

/** ¿Pregunta por las reservas de hoy? */
const esConsultaReservas = (texto) => {
  const t = normalizar(texto);
  return /reservas? de hoy|c[oó]mo van las reservas|agenda de hoy|qu[eé] reservas hay/.test(t);
};

const hora = (iso) => {
  try {
    return new Date(iso.replace(' ', 'T') + (iso.includes('Z') ? '' : 'Z'))
      .toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota' });
  } catch (e) { return ''; }
};

/** Resumen de los pedidos de hoy, listo para mandar por WhatsApp — sin IA. */
const resumenPedidosHoy = async (clientId) => {
  const pedidos = await dbAll(
    // Ver la nota de zona horaria en reservations.js: '-5 hours' fija el día
    // calendario de Colombia sin depender de la zona del servidor.
    `SELECT order_number, status, total, customer_name FROM orders
     WHERE client_id = ? AND date(created_at, '-5 hours') = date('now', '-5 hours')
     ORDER BY created_at ASC`,
    [clientId]
  );

  if (!pedidos.length) return 'Hoy todavía no ha entrado ningún pedido.';

  const totalDia = pedidos.reduce((s, p) => s + (p.total || 0), 0);
  const lineas = pedidos.map((p) =>
    `#${p.order_number} — ${p.customer_name || 'sin nombre'} · ${p.status} · $${(p.total || 0).toLocaleString('es-CO')}`
  );

  return `Hoy van ${pedidos.length} pedidos, por $${totalDia.toLocaleString('es-CO')} en total:\n\n${lineas.join('\n')}`;
};

/** Resumen de las reservas de hoy, listo para mandar por WhatsApp — sin IA. */
const resumenReservasHoy = async (clientId) => {
  const reservas = await dbAll(
    `SELECT customer_name, party_size, scheduled_at, status FROM reservations
     WHERE client_id = ? AND date(scheduled_at, '-5 hours') = date('now', '-5 hours') AND status != 'cancelada'
     ORDER BY scheduled_at ASC`,
    [clientId]
  );

  if (!reservas.length) return 'Hoy no hay reservas agendadas.';

  const lineas = reservas.map((r) =>
    `${hora(r.scheduled_at)} — ${r.customer_name || 'sin nombre'}${r.party_size ? ' (' + r.party_size + ' personas)' : ''} · ${r.status}`
  );

  return `Reservas de hoy (${reservas.length}):\n\n${lineas.join('\n')}`;
};

module.exports = {
  esDueno,
  esTemaRestringido,
  MENSAJE_NO_AUTORIZADO,
  esSolicitudDeEdicion,
  MENSAJE_EDICION_NO_AUTORIZADA,
  aplicarCambioMenu,
  esConsultaPedidos,
  esConsultaReservas,
  resumenPedidosHoy,
  resumenReservasHoy
};
