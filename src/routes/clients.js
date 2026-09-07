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

// GET /api/clients - Listar todos los clientes (con búsqueda tipo "inventario")
router.get('/', verifyToken, async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 20);
    const offset = (page - 1) * limit;
    const search = (req.query.search || '').trim();

    let searchClause = '';
    const searchParams = [];
    if (search) {
      searchClause = 'AND (c.name LIKE ? OR c.email LIKE ? OR c.company LIKE ? OR c.phone LIKE ? OR c.tax_id LIKE ?)';
      const like = `%${search}%`;
      searchParams.push(like, like, like, like, like);
    }

    const clients = await dbAll(
      `SELECT c.*,
        COUNT(DISTINCT s.id) as active_subscriptions,
        SUM(CASE WHEN t.status = 'completed' THEN t.amount ELSE 0 END) as total_paid,
        MAX(CASE WHEN s.status = 'active' THEN p.name END) as current_plan,
        MAX(CASE WHEN s.status = 'active' THEN s.renewal_date END) as next_cutoff_date,
        MAX(CASE WHEN s.status = 'active' THEN p.price END) as current_plan_price
       FROM clients c
       LEFT JOIN subscriptions s ON c.id = s.client_id AND s.status = 'active'
       LEFT JOIN plans p ON s.plan_id = p.id
       LEFT JOIN transactions t ON c.id = t.client_id
       WHERE c.status = 'active' ${searchClause}
       GROUP BY c.id
       ORDER BY c.created_at DESC
       LIMIT ? OFFSET ?`,
      [...searchParams, limit, offset]
    );

    const countResult = await dbGet(
      `SELECT COUNT(*) as total FROM clients c WHERE c.status = 'active' ${searchClause}`,
      searchParams
    );
    const total = countResult.total;

    logger.info('Clientes listados', { page, limit, total, search: search || undefined });

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

// GET /api/clients/:id - Obtener un cliente (perfil / estado de cuenta completo)
router.get('/:id', verifyToken, async (req, res, next) => {
  try {
    const client = await dbGet(
      'SELECT * FROM clients WHERE id = ? AND status = ?',
      [req.params.id, 'active']
    );

    if (!client) {
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }

    // Estado de cuenta: suscripciones activas con plan y fecha de corte
    const subscriptions = await dbAll(
      `SELECT s.*, p.name as plan_name, p.price, p.currency, p.billing_cycle
       FROM subscriptions s
       JOIN plans p ON s.plan_id = p.id
       WHERE s.client_id = ?
       ORDER BY s.status = 'active' DESC, s.created_at DESC`,
      [client.id]
    );

    const totalPaidResult = await dbGet(
      `SELECT COALESCE(SUM(amount), 0) as total_paid, COUNT(*) as total_transactions
       FROM transactions WHERE client_id = ? AND status = 'completed'`,
      [client.id]
    );

    const lastActivity = await dbAll(
      `SELECT action, entity, created_at FROM activity_logs WHERE client_id = ? ORDER BY created_at DESC LIMIT 10`,
      [client.id]
    );

    logger.info('Cliente obtenido', { clientId: client.id });
    res.json({
      success: true,
      data: {
        ...client,
        subscriptions,
        total_paid: totalPaidResult.total_paid,
        total_transactions: totalPaidResult.total_transactions,
        recent_activity: lastActivity
      }
    });
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
