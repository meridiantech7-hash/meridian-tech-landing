const express = require('express');
const Joi = require('joi');
const { verifyToken, exigirAccesoACliente, clienteForzado } = require('../middleware/auth');
const { dbGet, dbAll, dbRun } = require('../config/database');
const { emitToClient } = require('./conversations');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * Reservas / citas / programaciones del negocio — la agenda que ve la tablet.
 *
 * Mismo espíritu que orders.js: "source" distingue si la agendó la IA desde
 * un chat, alguien en el local, o el dueño desde su WhatsApp autorizado (ver
 * ownerService.js). `scheduled_at` es cuándo ES la reserva, no cuándo se
 * creó — así una que se agendó ayer para hoy aparece en la agenda de hoy.
 */

const ALL_STATUSES = ['confirmada', 'pendiente', 'cancelada'];

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
  status: Joi.string().valid(...ALL_STATUSES).default('confirmada')
});

const updateSchema = Joi.object({
  customer_name: Joi.string().allow('', null),
  customer_phone: Joi.string().allow('', null),
  party_size: Joi.number().integer().min(1).allow(null),
  scheduled_at: Joi.date().iso(),
  notes: Joi.string().allow('', null),
  status: Joi.string().valid(...ALL_STATUSES)
}).min(1);

// GET /api/reservations?client_id=1&date=2026-09-10  (por defecto: hoy)
router.get('/', verifyToken, async (req, res, next) => {
  try {
    // Forzado al cliente del usuario: el filtro no puede depender de lo que
    // manda el navegador.
    const forzado = clienteForzado(req.user);
    const clientId = forzado !== null ? forzado : req.query.client_id;
    if (!clientId) return res.status(400).json({ error: 'client_id requerido' });

    const fecha = req.query.date; // YYYY-MM-DD, opcional (calendario de Colombia)
    const params = [clientId];
    let sql = 'SELECT * FROM reservations WHERE client_id = ?';

    // `scheduled_at` se guarda en UTC. `'localtime'` de SQLite usa la zona del
    // SISTEMA OPERATIVO del servidor (en Railway, casi seguro UTC) — no la del
    // negocio. Colombia no tiene horario de verano, así que restar 5 horas fijas
    // antes de comparar la fecha da el día calendario correcto sin depender de
    // en qué zona horaria esté corriendo el servidor.
    // `rango` decide qué se ve. Existe por un defecto real: la agenda filtraba
    // SIEMPRE por el día de hoy, así que una reserva tomada hoy para el sábado
    // no aparecía en ninguna parte de la app — ni el día que se tomó, ni en
    // ninguna lista. Y una reserva es, por definición, para después.
    const rango = ['hoy', 'proximas', 'todas'].includes(req.query.rango)
      ? req.query.rango : 'hoy';

    if (fecha) {
      sql += " AND date(scheduled_at, '-5 hours') = date(?)";
      params.push(fecha);
    } else if (rango === 'proximas') {
      // De hoy en adelante: lo que todavía puede pasar.
      sql += " AND date(scheduled_at, '-5 hours') >= date('now', '-5 hours')";
    } else if (rango === 'hoy') {
      // Agenda del día: incluye lo agendado ayer (o antes) para hoy, y no
      // arrastra reservas viejas que ya pasaron.
      sql += " AND date(scheduled_at, '-5 hours') = date('now', '-5 hours')";
    }
    // 'todas' no agrega filtro de fecha: sirve para buscar una que se perdió.

    sql += " AND status != 'cancelada' ORDER BY scheduled_at ASC LIMIT 200";
    const reservas = await dbAll(sql, params);

    res.json({ success: true, data: reservas });
  } catch (error) {
    next(error);
  }
});

// GET /api/reservations/:id
router.get('/:id', verifyToken, async (req, res, next) => {
  try {
    const reserva = await dbGet('SELECT * FROM reservations WHERE id = ?', [req.params.id]);
    if (!reserva) return res.status(404).json({ error: 'Reserva no encontrada' });
    res.json({ success: true, data: reserva });
    if (!exigirAccesoACliente(req, res, reserva.client_id)) return;
  } catch (error) {
    next(error);
  }
});

// POST /api/reservations — crear (tablet, o el dueño desde WhatsApp)
router.post('/', verifyToken, async (req, res, next) => {
  try {
    const { error, value } = createSchema.validate(req.body);
    if (error) { error.isJoi = true; throw error; }

    // No se puede crear a nombre de otro negocio.
    if (!exigirAccesoACliente(req, res, value.client_id)) return;

    const reserva = await createReservation(value);
    res.status(201).json({ success: true, data: reserva });
  } catch (error) {
    next(error);
  }
});

/**
 * Creación compartida: la usa el endpoint HTTP y, más adelante, cualquier
 * flujo automático (IA o el dueño por WhatsApp) que agende una reserva —
 * para que todos produzcan el mismo registro y el mismo evento en vivo.
 */
async function createReservation(data) {
  const result = await dbRun(
    `INSERT INTO reservations
      (client_id, conversation_id, source, channel_type, customer_name,
       customer_phone, party_size, scheduled_at, notes, status)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      data.client_id, data.conversation_id || null, data.source || 'tablet',
      data.channel_type || 'manual', data.customer_name || null,
      data.customer_phone || null, data.party_size || null,
      new Date(data.scheduled_at).toISOString(), data.notes || null, data.status || 'confirmada'
    ]
  );

  const reserva = await dbGet('SELECT * FROM reservations WHERE id = ?', [result.id]);
  emitToClient(data.client_id, 'reservation:new', reserva);
  logger.info('Reserva creada', { reservationId: reserva.id, origen: data.source });
  return reserva;
}

// PATCH /api/reservations/:id — corregir o cambiar estado (confirmar/cancelar)
router.patch('/:id', verifyToken, async (req, res, next) => {
  try {
    const { error, value } = updateSchema.validate(req.body);
    if (error) { error.isJoi = true; throw error; }

    const reserva = await dbGet('SELECT * FROM reservations WHERE id = ?', [req.params.id]);
    if (!reserva) return res.status(404).json({ error: 'Reserva no encontrada' });

    if (!exigirAccesoACliente(req, res, reserva.client_id)) return;
    const sets = [];
    const params = [];
    for (const [key, val] of Object.entries(value)) {
      sets.push(`${key} = ?`);
      params.push(key === 'scheduled_at' ? new Date(val).toISOString() : val);
    }
    params.push(reserva.id);

    await dbRun(`UPDATE reservations SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, params);

    const actualizada = await dbGet('SELECT * FROM reservations WHERE id = ?', [reserva.id]);
    emitToClient(reserva.client_id, 'reservation:updated', actualizada);

    logger.info('Reserva actualizada', { reservationId: reserva.id, campos: Object.keys(value) });
    res.json({ success: true, data: actualizada });
  } catch (error) {
    next(error);
  }
});

module.exports = { router, createReservation };
