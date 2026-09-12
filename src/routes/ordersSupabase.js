const express = require('express');
const Joi = require('joi');
const { verifyToken, exigirAccesoACliente, clienteForzado } = require('../middleware/auth');
const sb = require('../services/supabaseApp');
const logger = require('../utils/logger');

/**
 * Órdenes cuando el flujo vive en n8n.
 *
 * Antes esto no existía: las órdenes solo vivían en la base de Railway, así
 * que un pago confirmado por WhatsApp —que lo registra n8n en Supabase— nunca
 * aparecía en la tablet. El cliente mandaba el comprobante, Valeria lo daba
 * por recibido, y en el tablero no salía nada.
 *
 * Mismas rutas y mismas respuestas que orders.js, para que la tablet no
 * distinga de dónde vienen.
 */

const router = express.Router();
const emitir = (...args) => require('./conversations').emitToClient(...args);

const ESTADOS = ['confirmado', 'preparando', 'listo', 'entregado', 'cancelado'];

// Lo que avanza el tablero, en orden. El personal lo mueve a mano desde la
// tablet: nadie adivina en que va un pedido.
const SIGUIENTE = { confirmado: 'preparando', preparando: 'listo', listo: 'entregado' };

// Cada paso avisa al cliente. Los textos los edita el negocio en flow_settings.
const AVISO = {
  preparando: 'pedido_texto_preparando',
  listo: 'pedido_texto_listo',
  entregado: 'pedido_texto_entregado'
};

/**
 * Avisa al cliente por el mismo canal por el que pidio y deja el mensaje en el
 * historial de la conversacion. Eso ultimo importa: si no queda registrado,
 * Valeria no sabe que ya se le dijo y puede contradecirse en el siguiente
 * mensaje.
 */
const avisarCliente = async (orden, nuevoEstado) => {
  const clave = AVISO[nuevoEstado];
  if (!clave || !orden.customer_phone) return;
  try {
    const [ajuste] = await sb.select('flow_settings', `key=eq.${clave}&select=value`);
    if (!ajuste || !ajuste.value) return;
    const texto = String(ajuste.value).replace('{numero}', orden.order_number || '');

    const metaSend = require('../services/metaSend');
    if (!metaSend.isConfigured()) return;
    await metaSend.sendText({
      channelType: orden.channel_type || 'whatsapp',
      to: orden.customer_phone,
      text: texto
    });

    if (orden.conversation_id) {
      await sb.rpc('guardar_saliente', {
        p_conversation_id: orden.conversation_id,
        p_remitente: 'bot',
        p_texto: texto,
        p_meta_id: null
      });
    }
    logger.info('Aviso de estado enviado', { orderId: orden.id, estado: nuevoEstado });
  } catch (error) {
    // Un aviso que falla no puede impedir que la cocina mueva el pedido.
    logger.warn('No se pudo avisar el cambio de estado', {
      orderId: orden.id, estado: nuevoEstado,
      error: error.response?.data?.message || error.message
    });
  }
};

const conClienteApp = async (o) => ({ ...o, client_id: await sb.aClienteApp(o.client_id) });

// GET /api/orders?client_id=1&status=preparando&include_closed=false
router.get('/', verifyToken, async (req, res, next) => {
  try {
    const forzado = clienteForzado(req.user);
    const appId = forzado !== null ? forzado : req.query.client_id;
    if (!appId) return res.status(400).json({ error: 'client_id requerido' });
    const supaId = await sb.aClienteSupabase(appId);

    const filtros = [`client_id=eq.${Number(supaId)}`];
    if (req.query.status && ESTADOS.includes(req.query.status)) {
      filtros.push(`status=eq.${req.query.status}`);
    } else if (req.query.include_closed !== 'true') {
      // Lo cerrado hoy se sigue viendo; lo de ayer estorba en el tablero.
      const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
      const inicio = new Date(`${hoy}T00:00:00-05:00`).toISOString();
      filtros.push(`or=(status.not.in.(entregado,cancelado),created_at.gte.${inicio})`);
    }

    const data = await sb.select('orders', `${filtros.join('&')}&select=*&order=created_at.desc&limit=200`);
    res.json({ success: true, data: data.map((o) => ({ ...o, client_id: Number(appId) })) });
  } catch (error) {
    next(error);
  }
});

router.get('/:id', verifyToken, async (req, res, next) => {
  try {
    const [o] = await sb.select('orders', `id=eq.${Number(req.params.id)}&select=*`);
    if (!o) return res.status(404).json({ error: 'Orden no encontrada' });
    const orden = await conClienteApp(o);
    if (!exigirAccesoACliente(req, res, orden.client_id)) return;
    res.json({ success: true, data: orden });
  } catch (error) {
    next(error);
  }
});

const createSchema = Joi.object({
  client_id: Joi.number().integer().required(),
  conversation_id: Joi.number().integer().allow(null),
  source: Joi.string().valid('bot', 'tablet', 'jefe').default('tablet'),
  channel_type: Joi.string().allow('', null),
  customer_name: Joi.string().allow('', null),
  customer_phone: Joi.string().allow('', null),
  concepto: Joi.string().allow('', null),
  modality: Joi.string().allow('', null),
  total: Joi.number().integer().min(0).allow(null),
  items: Joi.array().items(Joi.object()),
  notes: Joi.string().allow('', null),
  status: Joi.string().valid(...ESTADOS)
});

router.post('/', verifyToken, async (req, res, next) => {
  try {
    const { error, value } = createSchema.validate(req.body);
    if (error) { error.isJoi = true; throw error; }
    if (!exigirAccesoACliente(req, res, value.client_id)) return;

    const supaId = await sb.aClienteSupabase(value.client_id);
    const previas = await sb.select('orders', `client_id=eq.${Number(supaId)}&select=id`);
    const fecha = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' })
      .format(new Date()).slice(2).replace(/-/g, '');

    const [creada] = await sb.insertar('orders', {
      ...value,
      client_id: supaId,
      channel_type: value.channel_type || 'manual',
      // Lo que arma el bot entra sin confirmar: una persona lo revisa antes.
      status: value.status || (value.source === 'bot' ? 'por_confirmar' : 'recibido'),
      order_number: `MER-${fecha}-${String(previas.length + 1).padStart(3, '0')}`
    });

    const orden = { ...creada, client_id: Number(value.client_id) };
    sb.marcarEmitido(`o:${creada.id}:${creada.updated_at}`);
    emitir(orden.client_id, 'order:new', orden);
    logger.info('Orden creada', { orderId: orden.id, origen: value.source });
    res.status(201).json({ success: true, data: orden });
  } catch (error) {
    next(error);
  }
});

// PATCH /api/orders/:id/status — mover en el tablero
const statusSchema = Joi.object({
  status: Joi.string().valid(...ESTADOS).required(),
  detail: Joi.string().allow('', null)
});

router.patch('/:id/status', verifyToken, async (req, res, next) => {
  try {
    const { error, value } = statusSchema.validate(req.body);
    if (error) { error.isJoi = true; throw error; }

    const [o] = await sb.select('orders', `id=eq.${Number(req.params.id)}&select=*`);
    if (!o) return res.status(404).json({ error: 'Orden no encontrada' });
    const appId = await sb.aClienteApp(o.client_id);
    if (!exigirAccesoACliente(req, res, appId)) return;
    if (o.status === value.status) return res.json({ success: true, data: { ...o, client_id: appId } });

    // Solo se avanza al paso siguiente, o se cancela. Saltarse la preparacion
    // dejaria al cliente sin el aviso intermedio.
    if (value.status !== 'cancelado' && SIGUIENTE[o.status] !== value.status) {
      return res.status(409).json({
        error: `Desde "${o.status}" solo se puede pasar a "${SIGUIENTE[o.status] || 'cancelado'}"`
      });
    }

    const cambios = { status: value.status, updated_at: new Date().toISOString() };

    const [act] = await sb.actualizar('orders', `id=eq.${o.id}`, cambios);
    const orden = { ...act, client_id: appId };
    sb.marcarEmitido(`o:${act.id}:${act.updated_at}`);
    emitir(appId, 'order:updated', orden);
    logger.info('Orden actualizada', { orderId: o.id, de: o.status, a: value.status });
    res.json({ success: true, data: orden });

    // Despues de responder: la tablet no espera al aviso de WhatsApp.
    avisarCliente(orden, value.status);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
