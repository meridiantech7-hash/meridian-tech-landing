const axios = require('axios');
const { dbGet, dbAll, dbRun } = require('../config/database');
const boldService = require('./boldService');
const logger = require('../utils/logger');

/**
 * Cierre de venta por WhatsApp.
 *
 * Existe por un problema medido en producción: cuando el asistente ofrecía el
 * link de pago por iniciativa propia, la gente desconfiaba y abandonaba la
 * conversación. Un ofrecimiento de pago no solicitado es justo lo que delata a
 * un vendedor automático.
 *
 * La regla que implementa este módulo: **el cobro se genera únicamente cuando
 * el cliente lo pide**. El asistente diagnostica y recomienda; el link lo
 * dispara el cliente con su propia pregunta.
 */

const APP_URL = (process.env.APP_URL || 'https://meridiantech.app').replace(/\/$/, '');

/**
 * Frases con las que un cliente pide pagar. Se revisan ANTES de gastar tokens
 * de IA, igual que las de derivación a humano.
 *
 * A propósito NO incluye frases de interés genérico ("me interesa", "está
 * bien", "lo quiero"): esas significan que va avanzando, no que quiera pagar
 * ya, y cobrarle ahí sería exactamente el error que estamos corrigiendo.
 */
const FRASES_DE_PAGO = [
  'como pago', 'cómo pago', 'donde pago', 'dónde pago', 'como le pago',
  'cómo le pago', 'como puedo pagar', 'cómo puedo pagar', 'quiero pagar',
  'listo para pagar', 'medio de pago', 'método de pago', 'metodo de pago',
  'forma de pago', 'link de pago', 'el link', 'mandame el link',
  'mándame el link', 'envíame el link', 'enviame el link', 'pasame el link',
  'pásame el link', 'genera el link', 'generame el link', 'genérame el link',
  'el qr', 'un qr', 'código qr', 'codigo qr', 'datos para consignar',
  'a que cuenta', 'a qué cuenta', 'numero de cuenta', 'número de cuenta',
  'como hago la transferencia', 'cómo hago la transferencia',
  'como me inscribo', 'cómo me inscribo', 'quiero contratar',
  'donde firmo', 'dónde firmo'
];

/** Normaliza para comparar sin tildes ni mayúsculas. */
const normalizar = (s) => (s || '')
  .toLowerCase()
  .normalize('NFD')
  .replace(/[̀-ͯ]/g, '');

/**
 * ¿El cliente está pidiendo pagar?
 * @returns {string|null} la frase que coincidió, o null
 */
const pidePagar = (texto) => {
  const t = normalizar(texto);
  if (!t) return null;

  const frase = FRASES_DE_PAGO.find((f) => t.includes(normalizar(f)));
  if (frase) return frase;

  // "qr" suelto ("tienes qr?", "por qr") va con límites de palabra: como
  // subcadena aparecería dentro de otras palabras y cobraría de más.
  if (/\bqr\b/.test(t)) return 'qr';

  return null;
};

/**
 * Decide qué plan quedó acordado leyendo la conversación.
 *
 * Se usa IA porque la pista está en lenguaje natural ("me sirve el de un
 * millón", "el del medio", "el que incluye llamadas") y un simple buscador de
 * palabras se equivocaría cobrando el plan que no era — un error caro y
 * vergonzoso frente al cliente.
 *
 * Devuelve null si no hay un plan claro: en ese caso NO se cobra nada y se
 * deriva a una persona, que es infinitamente mejor que adivinar el monto.
 */
const detectarPlanAcordado = async (historial, planes) => {
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) return null;

  const transcripcion = historial
    .filter((m) => m.content)
    .map((m) => `${m.sender_type === 'end_customer' ? 'CLIENTE' : 'NEGOCIO'}: ${m.content}`)
    .join('\n');

  const catalogo = planes
    .map((p) => `- id ${p.id}: "${p.name}" — $${p.price.toLocaleString('es-CO')} COP/mes`)
    .join('\n');

  const instruccion = `Lee la conversación y decide QUÉ PLAN quedó acordado para cobrar.

PLANES DISPONIBLES:
${catalogo}

REGLAS:
- Devuelve plan_id solo si en la conversación se habló de un plan concreto y el cliente mostró acuerdo con ese.
- Si se mencionaron varios y no está claro cuál eligió, devuelve encontrado=false.
- Si el cliente nunca aceptó ninguno, devuelve encontrado=false.
- Ante la duda, encontrado=false. Cobrar el plan equivocado es peor que no cobrar.`;

  try {
    const { data } = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`,
      {
        systemInstruction: { parts: [{ text: instruccion }] },
        contents: [{ role: 'user', parts: [{ text: transcripcion }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'OBJECT',
            properties: {
              encontrado: { type: 'BOOLEAN' },
              plan_id: { type: 'INTEGER' },
              razon: { type: 'STRING' }
            },
            required: ['encontrado']
          },
          temperature: 0
        }
      },
      { headers: { 'Content-Type': 'application/json' }, timeout: 20000 }
    );

    const bruto = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!bruto) return null;

    const r = JSON.parse(bruto);
    if (!r.encontrado || !r.plan_id) {
      logger.info('No se pudo determinar el plan acordado', { razon: r.razon });
      return null;
    }
    return planes.find((p) => p.id === r.plan_id) || null;
  } catch (error) {
    logger.warn('Falló la detección del plan acordado', {
      error: error.response?.data?.error?.message || error.message
    });
    return null;
  }
};

/**
 * Registra al interesado como cliente si aún no existe.
 *
 * Hace falta porque `transactions` cuelga de `clients`: para cobrarle a alguien
 * primero tiene que existir. Y además tiene sentido comercial: quien pide pagar
 * deja de ser un curioso y pasa a ser un prospecto en el CRM, con su teléfono
 * y su historial, aunque el pago no se complete.
 */
const asegurarCliente = async (conversacion) => {
  const telefono = conversacion.end_customer_id;
  const nombre = conversacion.end_customer_name || `Prospecto ${telefono}`;

  const existente = await dbGet(
    'SELECT * FROM clients WHERE phone = ? OR email = ?',
    [telefono, `${telefono}@wa.prospecto`]
  );
  if (existente) return existente;

  const creado = await dbRun(
    `INSERT INTO clients (name, email, phone, status, notes)
     VALUES (?, ?, ?, 'prospect', ?)`,
    [
      nombre,
      // Correo sintético: la tabla lo exige y único, y el prospecto de WhatsApp
      // no tiene correo todavía. Se reemplaza cuando lo dé.
      `${telefono}@wa.prospecto`,
      telefono,
      `Creado automáticamente al pedir el pago por WhatsApp (conversación ${conversacion.id})`
    ]
  );

  logger.info('Prospecto registrado como cliente', { clientId: creado.id, telefono });
  return await dbGet('SELECT * FROM clients WHERE id = ?', [creado.id]);
};

/**
 * Datos para pagar por transferencia, o null si no están configurados.
 *
 * Van en variables de entorno y no en el código por dos razones: la cuenta
 * puede cambiar sin tener que desplegar, y no queda un número de cuenta de la
 * empresa escrito en un repositorio.
 *
 * PAGO_LLAVE es la llave de transferencias (Bre-B): el alias con el que se
 * recibe sin dictar número de cuenta ni banco.
 */
const datosDeTransferencia = () => {
  const llave = (process.env.PAGO_LLAVE || '').trim();
  if (!llave) return null;
  return {
    llave,
    titular: (process.env.PAGO_TITULAR || 'MERIDIAN TECH S.A.S.').trim(),
    banco: (process.env.PAGO_BANCO || 'Bold').trim(),
    nit: (process.env.PAGO_NIT || '902100512-0').trim()
  };
};

/**
 * Genera el cobro para una conversación en la que el cliente pidió pagar.
 *
 * @returns {{ok:true, plan, orderId, enlace, enlaceQr, monto}|{ok:false, motivo}}
 */
const generarCobro = async (conversacion) => {
  const planes = await dbAll(
    "SELECT id, name, price, currency FROM plans WHERE status = 'active' ORDER BY price ASC"
  );
  if (!planes.length) return { ok: false, motivo: 'no hay planes activos' };

  const historial = await dbAll(
    'SELECT sender_type, content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT 40',
    [conversacion.id]
  );

  const plan = await detectarPlanAcordado(historial, planes);
  if (!plan) {
    return { ok: false, motivo: 'no se pudo determinar el plan acordado' };
  }

  const cliente = await asegurarCliente(conversacion);
  const orderId = boldService.generateOrderId(cliente.id, plan.id);
  const descripcion = `MeridianTech - Plan ${plan.name}`;

  // El link de pago real se crea ANTES de guardar la transacción: si Bold
  // falla, es mejor no dejar un cobro "pendiente" fantasma sin forma de
  // pagarlo — se deriva a una persona, igual que cuando no se identifica el
  // plan (ver el comentario de más arriba: no cobrar es mejor que cobrar mal).
  const link = await boldService.crearLinkDePago({
    reference: orderId,
    amount: plan.price,
    currency: plan.currency || 'COP',
    description: descripcion,
    callbackUrl: `${APP_URL}/pagar/${orderId}`
  });

  // Si Bold no dio el link, se cobra por transferencia en vez de perder la
  // venta. Bold viene negando la llave con un "explicit deny" que no depende
  // de nuestro código, y mientras eso se resuelve un cliente decidido no puede
  // quedarse sin forma de pagar: se le pasan los datos de la cuenta.
  //
  // El cobro queda igual de registrado y con el mismo orderId, así que cuando
  // Bold se habilite no hay que migrar nada. Lo único distinto es que la
  // confirmación la hace una persona al ver la transferencia, no el webhook.
  if (!link.ok) {
    const transferencia = datosDeTransferencia();

    if (!transferencia) {
      logger.error('No se pudo crear el link de pago y no hay datos de transferencia configurados', {
        orderId, clientId: cliente.id, plan: plan.name, motivo: link.motivo
      });
      return { ok: false, motivo: `Bold no generó el link de pago: ${link.motivo}` };
    }

    await dbRun(
      `INSERT INTO transactions
        (client_id, plan_id, amount, currency, status, bold_transaction_id, description, payment_method)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, 'transferencia')`,
      [cliente.id, plan.id, plan.price, plan.currency || 'COP', orderId, descripcion]
    );

    logger.info('Cobro generado por transferencia (Bold no disponible)', {
      orderId, clientId: cliente.id, plan: plan.name, monto: plan.price,
      conversationId: conversacion.id, motivoBold: link.motivo
    });

    return {
      ok: true,
      porTransferencia: true,
      plan,
      orderId,
      monto: plan.price,
      transferencia
    };
  }

  await dbRun(
    `INSERT INTO transactions
      (client_id, plan_id, amount, currency, status, bold_transaction_id, bold_payment_link, bold_payment_url, description)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
    [cliente.id, plan.id, plan.price, plan.currency || 'COP', orderId, link.paymentLink, link.url, descripcion]
  );

  logger.info('Cobro generado a pedido del cliente', {
    orderId, clientId: cliente.id, plan: plan.name, monto: plan.price,
    conversationId: conversacion.id, paymentLink: link.paymentLink
  });

  return {
    ok: true,
    plan,
    orderId,
    monto: plan.price,
    // El enlace que se manda por WhatsApp es el de Bold directamente — más
    // confianza que un dominio propio, y es donde el cliente paga de verdad.
    enlace: link.url,
    enlaceQr: `${APP_URL}/pagar/${orderId}/qr.png`
  };
};

module.exports = {
  pidePagar,
  generarCobro,
  detectarPlanAcordado,
  FRASES_DE_PAGO
};
