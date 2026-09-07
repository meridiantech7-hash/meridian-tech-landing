const express = require('express');
const Joi = require('joi');
const { verifyToken } = require('../middleware/auth');
const { dbGet, dbAll, dbRun } = require('../config/database');
const boldService = require('../services/boldService');
const logger = require('../utils/logger');

const router = express.Router();

const createPaymentSchema = Joi.object({
  client_id: Joi.number().integer().required(),
  plan_id: Joi.number().integer().required()
});

// POST /api/payments/create - Crear intención de pago
router.post('/create', verifyToken, async (req, res, next) => {
  try {
    const { error, value } = createPaymentSchema.validate(req.body);
    if (error) {
      error.isJoi = true;
      throw error;
    }

    const client = await dbGet('SELECT * FROM clients WHERE id = ?', [value.client_id]);
    if (!client) {
      return res.status(404).json({ error: 'Cliente no encontrado' });
    }

    const plan = await dbGet('SELECT * FROM plans WHERE id = ?', [value.plan_id]);
    if (!plan) {
      return res.status(404).json({ error: 'Plan no encontrado' });
    }

    const orderId = boldService.generateOrderId(client.id, plan.id);
    const description = `MeridianTech - Plan ${plan.name}`;

    const paymentIntent = boldService.createPaymentIntent(
      orderId,
      plan.price,
      description,
      plan.currency
    );

    // Registrar transacción pendiente
    const result = await dbRun(
      `INSERT INTO transactions (client_id, plan_id, amount, currency, status, bold_transaction_id, description)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
      [client.id, plan.id, plan.price, plan.currency, orderId, description]
    );

    logger.info('Intención de pago creada', {
      transactionId: result.id,
      orderId,
      clientId: client.id,
      planId: plan.id,
      amount: plan.price
    });

    res.status(201).json({
      success: true,
      data: {
        transactionId: result.id,
        ...paymentIntent
      }
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/payments/:id - Estado de un pago
router.get('/:id', verifyToken, async (req, res, next) => {
  try {
    const transaction = await dbGet(
      `SELECT t.*, c.name as client_name, c.email as client_email, p.name as plan_name
       FROM transactions t
       JOIN clients c ON t.client_id = c.id
       JOIN plans p ON t.plan_id = p.id
       WHERE t.id = ?`,
      [req.params.id]
    );

    if (!transaction) {
      return res.status(404).json({ error: 'Transacción no encontrada' });
    }

    res.json({ success: true, data: transaction });
  } catch (error) {
    next(error);
  }
});

// GET /api/payments/history - Historial de todos los pagos (admin)
router.get('/history/all', verifyToken, async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 20);
    const offset = (page - 1) * limit;
    const status = req.query.status;

    let where = '';
    const params = [];
    if (status) {
      where = 'WHERE t.status = ?';
      params.push(status);
    }

    const transactions = await dbAll(
      `SELECT t.*, c.name as client_name, c.email as client_email, p.name as plan_name
       FROM transactions t
       JOIN clients c ON t.client_id = c.id
       JOIN plans p ON t.plan_id = p.id
       ${where}
       ORDER BY t.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    res.json({ success: true, data: transactions, pagination: { page, limit } });
  } catch (error) {
    next(error);
  }
});

// POST /api/payments/webhook/bold - Webhook de confirmación de Bold
router.post('/webhook/bold', async (req, res, next) => {
  try {
    const signature = req.headers['x-bold-signature'];
    const payload = req.body;

    logger.info('Webhook de Bold recibido', { payload });

    // Verificar firma si está configurado el secret
    if (process.env.BOLD_WEBHOOK_SECRET && !boldService.verifyWebhookSignature(payload, signature)) {
      logger.warn('Webhook de Bold con firma inválida', { ip: req.ip });
      return res.status(401).json({ error: 'Firma inválida' });
    }

    const { order_id, status, payment_method } = payload;

    if (!order_id) {
      return res.status(400).json({ error: 'order_id requerido' });
    }

    const transaction = await dbGet(
      'SELECT * FROM transactions WHERE bold_transaction_id = ?',
      [order_id]
    );

    if (!transaction) {
      logger.warn('Webhook para transacción no encontrada', { order_id });
      return res.status(404).json({ error: 'Transacción no encontrada' });
    }

    const newStatus = status === 'APPROVED' || status === 'approved' ? 'completed'
      : status === 'REJECTED' || status === 'rejected' ? 'failed'
      : 'pending';

    await dbRun(
      'UPDATE transactions SET status = ?, payment_method = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [newStatus, payment_method || null, transaction.id]
    );

    // Si el pago se completó, activar/renovar la suscripción
    if (newStatus === 'completed') {
      const existingSub = await dbGet(
        'SELECT id FROM subscriptions WHERE client_id = ? AND plan_id = ? AND status = ?',
        [transaction.client_id, transaction.plan_id, 'active']
      );

      const plan = await dbGet('SELECT * FROM plans WHERE id = ?', [transaction.plan_id]);
      const now = new Date();
      const renewalDate = new Date(now);
      if (plan.billing_cycle === 'yearly') {
        renewalDate.setFullYear(renewalDate.getFullYear() + 1);
      } else {
        renewalDate.setMonth(renewalDate.getMonth() + 1);
      }

      if (existingSub) {
        await dbRun(
          'UPDATE subscriptions SET renewal_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          [renewalDate.toISOString(), existingSub.id]
        );
      } else {
        await dbRun(
          `INSERT INTO subscriptions (client_id, plan_id, status, start_date, renewal_date)
           VALUES (?, ?, 'active', ?, ?)`,
          [transaction.client_id, transaction.plan_id, now.toISOString(), renewalDate.toISOString()]
        );
      }

      logger.info('Pago completado y suscripción activada', {
        transactionId: transaction.id,
        clientId: transaction.client_id
      });
    }

    res.json({ success: true, received: true });
  } catch (error) {
    logger.error('Error procesando webhook de Bold', { error: error.message });
    next(error);
  }
});

module.exports = router;
