const express = require('express');
const Joi = require('joi');
const { verifyToken } = require('../middleware/auth');
const { dbGet, dbAll, dbRun } = require('../config/database');
const logger = require('../utils/logger');

const router = express.Router();

const planSchema = Joi.object({
  name: Joi.string().required(),
  description: Joi.string(),
  price: Joi.number().integer().min(0).required(),
  currency: Joi.string().default('COP'),
  billing_cycle: Joi.string().valid('monthly', 'yearly').default('monthly'),
  features: Joi.array().items(Joi.string()),
  max_users: Joi.number().integer(),
  max_storage: Joi.number().integer()
});

// GET /api/plans - Listar planes (público, para landing page)
router.get('/', async (req, res, next) => {
  try {
    const plans = await dbAll(
      'SELECT * FROM plans WHERE status = ? ORDER BY price ASC',
      ['active']
    );

    const parsed = plans.map(p => ({
      ...p,
      features: p.features ? JSON.parse(p.features) : []
    }));

    res.json({ success: true, data: parsed });
  } catch (error) {
    next(error);
  }
});

// GET /api/plans/:id - Obtener un plan
router.get('/:id', async (req, res, next) => {
  try {
    const plan = await dbGet('SELECT * FROM plans WHERE id = ?', [req.params.id]);

    if (!plan) {
      return res.status(404).json({ error: 'Plan no encontrado' });
    }

    plan.features = plan.features ? JSON.parse(plan.features) : [];

    res.json({ success: true, data: plan });
  } catch (error) {
    next(error);
  }
});

// POST /api/plans - Crear plan (admin)
router.post('/', verifyToken, async (req, res, next) => {
  try {
    const { error, value } = planSchema.validate(req.body);
    if (error) {
      error.isJoi = true;
      throw error;
    }

    const result = await dbRun(
      `INSERT INTO plans (name, description, price, currency, billing_cycle, features, max_users, max_storage)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        value.name,
        value.description || null,
        value.price,
        value.currency,
        value.billing_cycle,
        JSON.stringify(value.features || []),
        value.max_users || null,
        value.max_storage || null
      ]
    );

    await dbRun(
      'INSERT INTO activity_logs (user_id, action, entity, entity_id) VALUES (?, ?, ?, ?)',
      [req.user.id, 'CREATE', 'PLAN', result.id]
    );

    logger.info('Plan creado', { planId: result.id, name: value.name });
    res.status(201).json({ success: true, data: { id: result.id } });
  } catch (error) {
    next(error);
  }
});

// PUT /api/plans/:id - Actualizar plan (admin)
router.put('/:id', verifyToken, async (req, res, next) => {
  try {
    const plan = await dbGet('SELECT id FROM plans WHERE id = ?', [req.params.id]);
    if (!plan) {
      return res.status(404).json({ error: 'Plan no encontrado' });
    }

    const { error, value } = planSchema.validate(req.body, { presence: 'optional' });
    if (error) {
      error.isJoi = true;
      throw error;
    }

    const updates = { ...value };
    if (updates.features) updates.features = JSON.stringify(updates.features);

    const fields = Object.keys(updates).filter(key => updates[key] !== undefined);
    const values = fields.map(f => updates[f]);

    if (fields.length === 0) {
      return res.json({ success: true, message: 'Sin cambios' });
    }

    const setClause = fields.map(f => `${f} = ?`).join(', ');
    await dbRun(
      `UPDATE plans SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [...values, req.params.id]
    );

    await dbRun(
      'INSERT INTO activity_logs (user_id, action, entity, entity_id) VALUES (?, ?, ?, ?)',
      [req.user.id, 'UPDATE', 'PLAN', req.params.id]
    );

    logger.info('Plan actualizado', { planId: req.params.id });
    res.json({ success: true, message: 'Plan actualizado exitosamente' });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/plans/:id - Desactivar plan (admin)
router.delete('/:id', verifyToken, async (req, res, next) => {
  try {
    const plan = await dbGet('SELECT id FROM plans WHERE id = ?', [req.params.id]);
    if (!plan) {
      return res.status(404).json({ error: 'Plan no encontrado' });
    }

    await dbRun('UPDATE plans SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', ['inactive', req.params.id]);

    await dbRun(
      'INSERT INTO activity_logs (user_id, action, entity, entity_id) VALUES (?, ?, ?, ?)',
      [req.user.id, 'DELETE', 'PLAN', req.params.id]
    );

    logger.info('Plan desactivado', { planId: req.params.id });
    res.json({ success: true, message: 'Plan desactivado exitosamente' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
