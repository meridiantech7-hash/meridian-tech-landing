const express = require('express');
const Joi = require('joi');
const { verifyToken, exigirAccesoACliente, clienteForzado } = require('../middleware/auth');
const { dbGet, dbAll, dbRun } = require('../config/database');
const { emitToClient } = require('./conversations');
const logger = require('../utils/logger');
const planService = require('../services/planService');
const inventoryService = require('../services/inventoryService');
const metaSend = require('../services/metaSend');

const router = express.Router();

// Con el flujo en n8n las ordenes viven en Supabase, no en la base de Railway
// (ordersSupabase.js). Antes faltaba este puente: un pago confirmado por
// WhatsApp quedaba en Supabase y la tablet nunca lo mostraba.
// Con FLUJO_EN_N8N apagado sigue todo como antes.
const supabaseApp = require('../services/supabaseApp');
router.use((req, res, next) => (supabaseApp.activo()
  ? require('./ordersSupabase')(req, res, next)
  : next()));

/**
 * Órdenes del negocio — lo que ve y mueve la tablet en cocina/mostrador.
 *
 * Entran por tres caminos, y por eso `source` existe:
 *   - `bot`    → la IA las armó leyendo el chat del cliente final
 *   - `tablet` → alguien las digitó en el local
 *   - `jefe`   → las cargó el dueño desde su propio WhatsApp
 *
 * Las de la IA nacen en `por_confirmar`: nadie cocina hasta que una persona
 * las revise. Es la diferencia entre un asistente útil y uno que quema plata
 * cuando entiende mal un audio.
 */

const FLOW = ['por_confirmar', 'recibido', 'preparando', 'listo', 'entregado'];
const ALL_STATUSES = [...FLOW, 'cancelado'];

const itemSchema = Joi.object({
  nombre: Joi.string().required(),
  cantidad: Joi.number().integer().min(1).default(1),
  precio: Joi.number().integer().min(0).default(0),
  notas: Joi.string().allow('', null)
});

const createSchema = Joi.object({
  client_id: Joi.number().integer().required(),
  conversation_id: Joi.number().integer().allow(null),
  source: Joi.string().valid('bot', 'tablet', 'jefe').default('tablet'),
  channel_type: Joi.string().allow('', null),
  customer_name: Joi.string().allow('', null),
  customer_phone: Joi.string().allow('', null),
  address: Joi.string().allow('', null),
  modality: Joi.string().valid('domicilio', 'recoger', 'mesa').default('domicilio'),
  items: Joi.array().items(itemSchema).default([]),
  total: Joi.number().integer().min(0).default(0),
  notes: Joi.string().allow('', null),
  status: Joi.string().valid(...ALL_STATUSES)
});

/**
 * Consecutivo visible que se reinicia cada día: para el personal es más fácil
 * gritar "la 14" que "la 3271". El id real de base de datos no cambia.
 */
const nextOrderNumber = async (clientId) => {
  const row = await dbGet(
    `SELECT COUNT(*) AS n FROM orders
     WHERE client_id = ? AND date(created_at) = date('now','localtime')`,
    [clientId]
  );
  return String((row?.n || 0) + 1).padStart(3, '0');
};

const parseOrder = (o) => {
  if (!o) return o;
  let items = [];
  try { items = JSON.parse(o.items || '[]'); } catch (e) { items = []; }
  return { ...o, items };
};

// GET /api/orders?client_id=1&status=preparando&include_closed=false
router.get('/', verifyToken, async (req, res, next) => {
  try {
    // Forzado al cliente del usuario: el filtro no puede depender de lo que
    // manda el navegador.
    const forzado = clienteForzado(req.user);
    const clientId = forzado !== null ? forzado : req.query.client_id;
    if (!clientId) return res.status(400).json({ error: 'client_id requerido' });

    const params = [clientId];
    let sql = 'SELECT * FROM orders WHERE client_id = ?';

    if (req.query.status) {
      sql += ' AND status = ?';
      params.push(req.query.status);
    } else if (req.query.include_closed !== 'true') {
      // El tablero por defecto muestra solo lo vivo. Las entregadas y
      // canceladas de días pasados llenarían la pantalla sin aportar nada.
      sql += " AND (status NOT IN ('entregado','cancelado') OR date(created_at) = date('now','localtime'))";
    }

    sql += ' ORDER BY created_at DESC LIMIT 200';
    const orders = await dbAll(sql, params);

    res.json({ success: true, data: orders.map(parseOrder) });
  } catch (error) {
    next(error);
  }
});

// GET /api/orders/:id
router.get('/:id', verifyToken, async (req, res, next) => {
  try {
    const order = await dbGet('SELECT * FROM orders WHERE id = ?', [req.params.id]);
    if (!order) return res.status(404).json({ error: 'Orden no encontrada' });

    if (!exigirAccesoACliente(req, res, order.client_id)) return;
    const events = await dbAll(
      'SELECT * FROM order_events WHERE order_id = ? ORDER BY created_at ASC',
      [req.params.id]
    );
    res.json({ success: true, data: { order: parseOrder(order), events } });
  } catch (error) {
    next(error);
  }
});

// POST /api/orders — crear (manual desde la tablet, o del jefe)
router.post('/', verifyToken, async (req, res, next) => {
  try {
    const { error, value } = createSchema.validate(req.body);
    if (error) { error.isJoi = true; throw error; }

    // No se puede crear a nombre de otro negocio.
    if (!exigirAccesoACliente(req, res, value.client_id)) return;

    const order = await createOrder(value, req.user?.id);
    res.status(201).json({ success: true, data: order });
  } catch (error) {
    next(error);
  }
});

/**
 * Creación compartida: la usa el endpoint HTTP y también el webhook cuando la
 * IA arma una orden desde el chat, para que ambas rutas produzcan exactamente
 * el mismo registro y el mismo evento en vivo.
 */
async function createOrder(data, userId = null, aiMeta = {}) {
  const orderNumber = await nextOrderNumber(data.client_id);
  const status = data.status || (data.source === 'bot' ? 'por_confirmar' : 'recibido');

  const result = await dbRun(
    `INSERT INTO orders
      (client_id, conversation_id, order_number, status, source, channel_type,
       customer_name, customer_phone, address, modality, items, total, notes,
       ai_confidence, ai_raw)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      data.client_id, data.conversation_id || null, orderNumber, status,
      data.source || 'tablet', data.channel_type || 'manual',
      data.customer_name || null, data.customer_phone || null,
      data.address || null, data.modality || 'domicilio',
      JSON.stringify(data.items || []), data.total || 0, data.notes || null,
      aiMeta.confidence || null, aiMeta.raw || null
    ]
  );

  await dbRun(
    'INSERT INTO order_events (order_id, from_status, to_status, user_id, detail) VALUES (?,?,?,?,?)',
    [result.id, null, status, userId, `Creada desde ${data.source || 'tablet'}`]
  );

  const order = parseOrder(await dbGet('SELECT * FROM orders WHERE id = ?', [result.id]));

  // La tablet la pinta al instante, sin recargar ni esperar el siguiente sondeo
  emitToClient(data.client_id, 'order:new', order);
  logger.info('Orden creada', {
    orderId: order.id, numero: orderNumber, origen: data.source, status
  });

  return order;
}

// PATCH /api/orders/:id/status — mover en el tablero
const statusSchema = Joi.object({
  status: Joi.string().valid(...ALL_STATUSES).required(),
  detail: Joi.string().allow('', null)
});

router.patch('/:id/status', verifyToken, async (req, res, next) => {
  try {
    const { error, value } = statusSchema.validate(req.body);
    if (error) { error.isJoi = true; throw error; }

    const order = await dbGet('SELECT * FROM orders WHERE id = ?', [req.params.id]);
    if (!order) return res.status(404).json({ error: 'Orden no encontrada' });

    if (!exigirAccesoACliente(req, res, order.client_id)) return;
    if (order.status === value.status) {
      return res.json({ success: true, data: parseOrder(order), message: 'Sin cambios' });
    }

    // Una orden que la IA propuso no puede saltar a cocina sin que alguien la
    // acepte: para eso está /confirm, que además deja constancia de quién fue.
    if (order.status === 'por_confirmar' && !['cancelado'].includes(value.status)) {
      return res.status(409).json({
        error: 'Esta orden la propuso la IA y todavía no está confirmada.',
        hint: 'Revísala y usa POST /api/orders/:id/confirm para aceptarla.'
      });
    }

    await dbRun('UPDATE orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [value.status, order.id]);
    await dbRun(
      'INSERT INTO order_events (order_id, from_status, to_status, user_id, detail) VALUES (?,?,?,?,?)',
      [order.id, order.status, value.status, req.user?.id, value.detail || null]
    );

    const updated = parseOrder(await dbGet('SELECT * FROM orders WHERE id = ?', [order.id]));
    emitToClient(order.client_id, 'order:updated', updated);

    logger.info('Orden movida de estado', {
      orderId: order.id, de: order.status, a: value.status, userId: req.user?.id
    });
    res.json({ success: true, data: updated });
  } catch (error) {
    next(error);
  }
});

/**
 * Avisa al dueño por WhatsApp de algo que no pidió (inventario bajo). Usa el
 * mismo `metaSend` que el resto del sistema, resolviendo el phone_number_id
 * desde `channels` — si el canal o el owner_phone no están configurados
 * todavía para este cliente, se registra y no se rompe nada más (el pedido
 * ya quedó confirmado de todas formas).
 */
async function avisarDueno(clientId, texto) {
  try {
    const config = await dbGet('SELECT owner_phone FROM bot_configs WHERE client_id = ?', [clientId]);
    const canal = await dbGet(
      `SELECT external_account_id FROM channels WHERE client_id = ? AND channel_type = 'whatsapp' AND status = 'active'`,
      [clientId]
    );
    if (!config?.owner_phone || !canal?.external_account_id) {
      logger.warn('No se pudo avisar al dueño — falta owner_phone o canal de WhatsApp configurado', { clientId });
      return;
    }
    await metaSend.sendText({
      channelType: 'whatsapp',
      to: config.owner_phone,
      text: texto,
      phoneNumberId: canal.external_account_id
    });
  } catch (error) {
    logger.warn('Fallo avisando al dueño por WhatsApp', { clientId, error: error.message });
  }
}

// POST /api/orders/:id/confirm — aceptar una orden que armó la IA
router.post('/:id/confirm', verifyToken, async (req, res, next) => {
  try {
    const order = await dbGet('SELECT * FROM orders WHERE id = ?', [req.params.id]);
    if (!order) return res.status(404).json({ error: 'Orden no encontrada' });
    if (!exigirAccesoACliente(req, res, order.client_id)) return;

    if (order.status !== 'por_confirmar') {
      return res.status(409).json({ error: 'Esta orden ya estaba confirmada' });
    }

    await dbRun(
      `UPDATE orders SET status = 'recibido', confirmed_by = ?, confirmed_at = CURRENT_TIMESTAMP,
       updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [req.user?.id, order.id]
    );
    await dbRun(
      'INSERT INTO order_events (order_id, from_status, to_status, user_id, detail) VALUES (?,?,?,?,?)',
      [order.id, 'por_confirmar', 'recibido', req.user?.id, `Confirmada por ${req.user?.email || 'personal'}`]
    );

    const updated = parseOrder(await dbGet('SELECT * FROM orders WHERE id = ?', [order.id]));
    emitToClient(order.client_id, 'order:updated', updated);

    logger.info('Orden de la IA confirmada por una persona', { orderId: order.id, userId: req.user?.id });
    res.json({ success: true, data: updated });

    // Inventario en tiempo real (Premium): se descuenta acá, cuando la
    // orden ya es real, no cuando la IA solo creyó entenderla. Va después de
    // responder y en su propio try/catch — la confirmación ya se procesó y
    // no debe caerse porque falle esto.
    try {
      const plan = await planService.getPlanActivo(order.client_id);
      if (plan?.name === 'Premium') {
        const cruzaronUmbral = await inventoryService.descontarPorOrden(order.client_id, updated);
        const aviso = inventoryService.avisoBajoStock(cruzaronUmbral);
        if (aviso) await avisarDueno(order.client_id, aviso);
      }
    } catch (invError) {
      logger.warn('Fallo actualizando inventario al confirmar orden', { orderId: order.id, error: invError.message });
    }
  } catch (error) {
    next(error);
  }
});

// POST /api/orders/:id/pagado — marcar que ya entró la plata.
//
// Es un momento aparte de "confirmada" y de "recibido", y por eso lleva su
// propia hora: el reloj de la cocina arranca cuando el pedido está PAGADO, no
// cuando el cliente escribió. Un pedido sin pagar puede esperar; uno pagado
// que lleva media hora en cola es un cliente molesto y una devolución.
const pagoSchema = Joi.object({
  payment_method: Joi.string().allow('', null)
});

router.post('/:id/pagado', verifyToken, async (req, res, next) => {
  try {
    const { error, value } = pagoSchema.validate(req.body || {});
    if (error) { error.isJoi = true; throw error; }

    const order = await dbGet('SELECT * FROM orders WHERE id = ?', [req.params.id]);
    if (!order) return res.status(404).json({ error: 'Orden no encontrada' });
    if (!exigirAccesoACliente(req, res, order.client_id)) return;

    if (order.paid_at) {
      return res.status(409).json({ error: 'Esta orden ya estaba marcada como pagada' });
    }

    await dbRun(
      `UPDATE orders SET paid_at = CURRENT_TIMESTAMP, payment_method = ?,
       updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [value.payment_method || null, order.id]
    );
    await dbRun(
      'INSERT INTO order_events (order_id, from_status, to_status, user_id, detail) VALUES (?,?,?,?,?)',
      [order.id, order.status, order.status, req.user?.id,
       `Pago confirmado${value.payment_method ? ' (' + value.payment_method + ')' : ''}`]
    );

    const updated = parseOrder(await dbGet('SELECT * FROM orders WHERE id = ?', [order.id]));

    // Evento propio, no un 'order:updated' cualquiera: la tablet tiene que
    // poder distinguir "algo cambió" de "ENTRÓ UN PAGO" para sonar solo en el
    // segundo caso. Si sonara con cada cambio, en hora pico nadie le pararía
    // bolas al pito.
    emitToClient(order.client_id, 'order:paid', updated);

    logger.info('Pago de pedido confirmado', {
      orderId: order.id, clientId: order.client_id, total: order.total, userId: req.user?.id
    });
    res.json({ success: true, data: updated });
  } catch (error) {
    next(error);
  }
});

// PATCH /api/orders/:id — corregir datos (lo que la IA entendió mal)
const editSchema = Joi.object({
  customer_name: Joi.string().allow('', null),
  customer_phone: Joi.string().allow('', null),
  address: Joi.string().allow('', null),
  modality: Joi.string().valid('domicilio', 'recoger', 'mesa'),
  items: Joi.array().items(itemSchema),
  total: Joi.number().integer().min(0),
  notes: Joi.string().allow('', null)
}).min(1);

router.patch('/:id', verifyToken, async (req, res, next) => {
  try {
    const { error, value } = editSchema.validate(req.body);
    if (error) { error.isJoi = true; throw error; }

    const order = await dbGet('SELECT * FROM orders WHERE id = ?', [req.params.id]);
    if (!order) return res.status(404).json({ error: 'Orden no encontrada' });

    if (!exigirAccesoACliente(req, res, order.client_id)) return;
    const sets = [];
    const params = [];
    for (const [key, val] of Object.entries(value)) {
      sets.push(`${key} = ?`);
      params.push(key === 'items' ? JSON.stringify(val) : val);
    }
    params.push(order.id);

    await dbRun(`UPDATE orders SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, params);

    const updated = parseOrder(await dbGet('SELECT * FROM orders WHERE id = ?', [order.id]));
    emitToClient(order.client_id, 'order:updated', updated);

    logger.info('Orden corregida', { orderId: order.id, campos: Object.keys(value), userId: req.user?.id });
    res.json({ success: true, data: updated });
  } catch (error) {
    next(error);
  }
});

module.exports = { router, createOrder, FLOW, ALL_STATUSES };
