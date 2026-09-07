const express = require('express');
const Joi = require('joi');
const { verifyToken } = require('../middleware/auth');
const { dbGet, dbAll, dbRun } = require('../config/database');
const logger = require('../utils/logger');

const router = express.Router();

// Schema de validación
const clientSchema = Joi.object({
  name: Joi.string().required(),
  email: Joi.string().email().required(),
  phone: Joi.string(),
  company: Joi.string(),
  address: Joi.string(),
  city: Joi.string(),
  country: Joi.string().default('Colombia'),
  tax_id: Joi.string(),
  notes: Joi.string()
});

// GET /api/clients - Listar todos los clientes
router.get('/', verifyToken, async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 20);
    const offset = (page - 1) * limit;

    const clients = await dbAll(
      `SELECT c.*,
        COUNT(DISTINCT s.id) as active_subscriptions,
        SUM(CASE WHEN t.status = 'completed' THEN t.amount ELSE 0 END) as total_paid
       FROM clients c
       LEFT JOIN subscriptions s ON c.id = s.client_id AND s.status = 'active'
       LEFT JOIN transactions t ON c.id = t.client_id
       WHERE c.status = 'active'
       GROUP BY c.id
       ORDER BY c.created_at DESC
       LIMIT ? OFFSET ?`,
      [limit, offset]
    );

    const countResult = await dbGet('SELECT COUNT(*) as total FROM clients WHERE status = ?', ['active']);
    const total = countResult.total;

    logger.info('Clientes listados', { page, limit, total });

    res.json({
      success: true,
      data: clients,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/clients/:id - Obtener un cliente
router.get('/:id', verifyToken, async (req, res, next) => {
  try {
    const client = await dbGet(
      `SELECT c.*,
        COUNT(DISTINCT s.id) as active_subscriptions,
        GROUP_CONCAT(p.name, ', ') as plans
       FROM clients c
       LEFT JOIN subscriptions s ON c.id = s.client_id AND s.status = 'active'
       LEFT JOIN plans p ON s.plan_id = p.id
       WHERE c.id = ? AND c.status = 'active'
       GROUP BY c.id`,
      [req.params.id]
    );

    if (!client) {
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }

    logger.info('Cliente obtenido', { clientId: client.id });
    res.json({ success: true, data: client });
  } catch (error) {
    next(error);
  }
});

// POST /api/clients - Crear cliente
router.post('/', verifyToken, async (req, res, next) => {
  try {
    const { error, value } = clientSchema.validate(req.body);
    if (error) {
      error.isJoi = true;
      throw error;
    }

    const result = await dbRun(
      `INSERT INTO clients (name, email, phone, company, address, city, country, tax_id, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        value.name,
        value.email,
        value.phone || null,
        value.company || null,
        value.address || null,
        value.city || null,
        value.country,
        value.tax_id || null,
        value.notes || null
      ]
    );

    // Registrar actividad
    await dbRun(
      'INSERT INTO activity_logs (user_id, client_id, action, entity) VALUES (?, ?, ?, ?)',
      [req.user.id, result.id, 'CREATE', 'CLIENT']
    );

    logger.info('Cliente creado', { clientId: result.id, email: value.email });

    res.status(201).json({
      success: true,
      message: 'Cliente creado exitosamente',
      data: { id: result.id }
    });
  } catch (error) {
    next(error);
  }
});

// PUT /api/clients/:id - Actualizar cliente
router.put('/:id', verifyToken, async (req, res, next) => {
  try {
    const client = await dbGet('SELECT id FROM clients WHERE id = ?', [req.params.id]);
    if (!client) {
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }

    const { error, value } = clientSchema.validate(req.body, { presence: 'optional' });
    if (error) {
      error.isJoi = true;
      throw error;
    }

    const fields = Object.keys(value).filter(key => value[key] !== undefined);
    const values = Object.values(value).filter(v => v !== undefined);

    if (fields.length === 0) {
      return res.json({ success: true, message: 'Sin cambios que actualizar' });
    }

    const setClause = fields.map(f => `${f} = ?`).join(', ');

    await dbRun(
      `UPDATE clients SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [...values, req.params.id]
    );

    // Registrar actividad
    await dbRun(
      'INSERT INTO activity_logs (user_id, client_id, action, entity) VALUES (?, ?, ?, ?)',
      [req.user.id, req.params.id, 'UPDATE', 'CLIENT']
    );

    logger.info('Cliente actualizado', { clientId: req.params.id });
    res.json({ success: true, message: 'Cliente actualizado exitosamente' });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/clients/:id - Eliminar cliente (soft delete)
router.delete('/:id', verifyToken, async (req, res, next) => {
  try {
    const client = await dbGet('SELECT id FROM clients WHERE id = ?', [req.params.id]);
    if (!client) {
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }

    await dbRun('UPDATE clients SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', ['inactive', req.params.id]);

    // Registrar actividad
    await dbRun(
      'INSERT INTO activity_logs (user_id, client_id, action, entity) VALUES (?, ?, ?, ?)',
      [req.user.id, req.params.id, 'DELETE', 'CLIENT']
    );

    logger.info('Cliente eliminado', { clientId: req.params.id });
    res.json({ success: true, message: 'Cliente eliminado exitosamente' });
  } catch (error) {
    next(error);
  }
});

// GET /api/clients/:id/history - Historial de cliente
router.get('/:id/history', verifyToken, async (req, res, next) => {
  try {
    const client = await dbGet('SELECT id FROM clients WHERE id = ?', [req.params.id]);
    if (!client) {
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }

    const transactions = await dbAll(
      `SELECT t.*, p.name as plan_name
       FROM transactions t
       JOIN plans p ON t.plan_id = p.id
       WHERE t.client_id = ?
       ORDER BY t.created_at DESC
       LIMIT 50`,
      [req.params.id]
    );

    logger.info('Historial de cliente obtenido', { clientId: req.params.id });
    res.json({ success: true, data: transactions });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
