const express = require('express');
const Joi = require('joi');
const { verifyToken, exigirAccesoACliente, clienteForzado } = require('../middleware/auth');
const sb = require('../services/supabaseApp');
const logger = require('../utils/logger');

/**
 * Agenda de reservas cuando el flujo vive en n8n: la IA las guarda en
 * Supabase y la tablet las lee y las confirma aquí. Mismas rutas y mismas
 * respuestas que reservations.js.
 */

const router = express.Router();
const emitir = (...args) => require('./conversations').emitToClient(...args);

const ESTADOS = ['confirmada', 'pendiente', 'cancelada'];

const createSchema = Joi.object({
  client_id: Joi.number().integer().required(),
  conversation_id: Joi.number().integer().allow(null),
  source: Joi.string().valid('bot', 'tablet', 'jefe').default('tablet'),
  channel_type: Joi.string().allow('', null),
  customer_name: Joi.string().allow('', null),
  customer_phone: Joi.string().allow('', null),
  party_size: Joi.number().integer().min(1).allow(null),
  scheduled_at: Joi.date().iso().required(),
  notes: Joi.string().allow('', null),
  status: Joi.string().valid(...ESTADOS).default('confirmada')
});

const updateSchema = Joi.object({
  customer_name: Joi.string().allow('', null),
  customer_phone: Joi.string().allow('', null),
  party_size: Joi.number().integer().min(1).allow(null),
  scheduled_at: Joi.date().iso(),
  notes: Joi.string().allow('', null),
  status: Joi.string().valid(...ESTADOS)
}).min(1);

/** Inicio del día calendario en Colombia (UTC-5, sin horario de verano). */
const inicioDelDia = (fecha) => {
  const dia = fecha || new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
  return new Date(`${dia}T00:00:00-05:00`);
};

const conClienteApp = async (r) => ({ ...r, client_id: await sb.aClienteApp(r.client_id) });

router.get('/', verifyToken, async (req, res, next) => {
  try {
    const forzado = clienteForzado(req.user);
    const appId = forzado !== null ? forzado : req.query.client_id;
    if (!appId) return res.status(400).json({ error: 'client_id requerido' });
    const supaId = await sb.aClienteSupabase(appId);

    const rango = ['hoy', 'proximas', 'todas'].includes(req.query.rango) ? req.query.rango : 'hoy';
    const filtros = [`client_id=eq.${Number(supaId)}`, 'status=neq.cancelada'];
    if (req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)) {
      const ini = inicioDelDia(req.query.date);
      filtros.push(`scheduled_at=gte.${ini.toISOString()}`, `scheduled_at=lt.${new Date(ini.getTime() + 864e5).toISOString()}`);
    } else if (rango === 'hoy') {
      const ini = inicioDelDia();
      filtros.push(`scheduled_at=gte.${ini.toISOString()}`, `scheduled_at=lt.${new Date(ini.getTime() + 864e5).toISOString()}`);
    } else if (rango === 'proximas') {
      filtros.push(`scheduled_at=gte.${inicioDelDia().toISOString()}`);
    }

    const data = await sb.select('reservations', `${filtros.join('&')}&select=*&order=scheduled_at.asc&limit=200`);
    res.json({ success: true, data: data.map((r) => ({ ...r, client_id: Number(appId) })) });
  } catch (error) {
    next(error);
  }
});

router.get('/:id', verifyToken, async (req, res, next) => {
  try {
    const [r] = await sb.select('reservations', `id=eq.${Number(req.params.id)}&select=*`);
    if (!r) return res.status(404).json({ error: 'Reserva no encontrada' });
    const reserva = await conClienteApp(r);
    if (!exigirAccesoACliente(req, res, reserva.client_id)) return;
    res.json({ success: true, data: reserva });
  } catch (error) {
    next(error);
  }
});

router.post('/', verifyToken, async (req, res, next) => {
  try {
    const { error, value } = createSchema.validate(req.body);
    if (error) { error.isJoi = true; throw error; }
    if (!exigirAccesoACliente(req, res, value.client_id)) return;

    const [creada] = await sb.insertar('reservations', {
      ...value,
      client_id: await sb.aClienteSupabase(value.client_id),
      channel_type: value.channel_type || 'manual',
      scheduled_at: new Date(value.scheduled_at).toISOString()
    });
    const reserva = { ...creada, client_id: Number(value.client_id) };
    sb.marcarEmitido(`r:${creada.id}:${creada.updated_at}`);
    emitir(reserva.client_id, 'reservation:new', reserva);
    logger.info('Reserva creada', { reservationId: reserva.id, origen: value.source });
    res.status(201).json({ success: true, data: reserva });
  } catch (error) {
    next(error);
  }
});

router.patch('/:id', verifyToken, async (req, res, next) => {
  try {
    const { error, value } = updateSchema.validate(req.body);
    if (error) { error.isJoi = true; throw error; }

    const [r] = await sb.select('reservations', `id=eq.${Number(req.params.id)}&select=*`);
    if (!r) return res.status(404).json({ error: 'Reserva no encontrada' });
    const appId = await sb.aClienteApp(r.client_id);
    if (!exigirAccesoACliente(req, res, appId)) return;

    if (value.scheduled_at) value.scheduled_at = new Date(value.scheduled_at).toISOString();
    const [act] = await sb.actualizar('reservations', `id=eq.${r.id}`, value);
    const actualizada = { ...act, client_id: appId };
    sb.marcarEmitido(`r:${act.id}:${act.updated_at}`);
    emitir(appId, 'reservation:updated', actualizada);
    logger.info('Reserva actualizada', { reservationId: r.id, campos: Object.keys(value) });
    res.json({ success: true, data: actualizada });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
