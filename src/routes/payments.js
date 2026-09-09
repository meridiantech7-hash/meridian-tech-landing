const express = require('express');
const Joi = require('joi');
const { verifyToken } = require('../middleware/auth');
const { dbGet, dbAll, dbRun } = require('../config/database');
const boldService = require('../services/boldService');
const metaSend = require('../services/metaSend');
const { emitToClient } = require('./conversations');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * Busca la conversación de WhatsApp desde la que se generó un cobro.
 *
 * El vínculo es el teléfono del cliente: cuando el cobro nace de un chat, el
 * prospecto se registró con ese número (ver ventaService.asegurarCliente).
 */
const conversacionDelCliente = async (clientId) => {
  const cliente = await dbGet('SELECT phone FROM clients WHERE id = ?', [clientId]);
  if (!cliente?.phone) return null;
  return await dbGet(
    `SELECT * FROM conversations WHERE end_customer_id = ?
     ORDER BY last_message_at DESC LIMIT 1`,
    [cliente.phone]
  );
};

/** Registra y emite un mensaje del bot en una conversación. */
const registrarMensajeBot = async (conversacion, texto, externalId, entregado) => {
  const guardado = await dbRun(
    'INSERT INTO messages (conversation_id, sender_type, content, external_message_id) VALUES (?, ?, ?, ?)',
    [conversacion.id, 'bot', texto, externalId || null]
  );
  await dbRun('UPDATE conversations SET last_message_at = CURRENT_TIMESTAMP WHERE id = ?', [conversacion.id]);
  emitToClient(conversacion.client_id, 'conversation:new_message', {
    id: guardado.id, conversation_id: conversacion.id, sender_type: 'bot',
    content: texto, delivered: entregado, created_at: new Date().toISOString()
  });
};

/**
 * Confirma el pago por el mismo chat donde se pidió.
 *
 * Nunca lanza: si falla la notificación, el pago YA está registrado y la
 * suscripción activa. Perder el aviso es molesto; perder el pago sería grave.
 */
async function confirmarPagoAlCliente(transaction, plan) {
  try {
    const conversacion = await conversacionDelCliente(transaction.client_id);
    if (!conversacion) return;

    const monto = '$' + Number(transaction.amount).toLocaleString('es-CO');
    const texto =
      `¡Listo! Recibimos tu pago de ${monto} COP por el plan ${plan?.name || ''}. ✅\n\n` +
      `Ya quedaste activo. En las próximas horas te contacta alguien del equipo ` +
      `para coordinar la instalación y dejarte todo funcionando.`;

    const envio = await metaSend.sendText({
      channelType: conversacion.channel_type,
      to: conversacion.end_customer_id,
      text: texto
    });
    await registrarMensajeBot(conversacion, texto, envio.externalId, envio.sent);

    // El dueño necesita saber que entró plata y que hay que instalar
    emitToClient(conversacion.client_id, 'payment:completed', {
      conversationId: conversacion.id,
      orderId: transaction.bold_transaction_id,
      monto: transaction.amount,
      plan: plan?.name
    });

    logger.info('Pago confirmado al cliente por su chat', {
      conversationId: conversacion.id, orderId: transaction.bold_transaction_id
    });
  } catch (error) {
    logger.error('No se pudo confirmar el pago al cliente', {
      transactionId: transaction.id, error: error.message
    });
  }
}

/**
 * Avisa que el pago fue rechazado, con el enlace para reintentar.
 *
 * Sin este aviso el cliente cree que quedó pagado y aparece el lunes esperando
 * la instalación. Es mejor decirlo de una y darle cómo reintentar.
 */
async function avisarPagoRechazado(transaction) {
  try {
    const conversacion = await conversacionDelCliente(transaction.client_id);
    if (!conversacion) return;

    const appUrl = (process.env.APP_URL || 'https://meridiantech.app').replace(/\/$/, '');
    const texto =
      `El pago no se pudo procesar. Puede ser un tema del banco o de la tarjeta.\n\n` +
      `Puedes intentar de nuevo acá: ${appUrl}/pagar/${transaction.bold_transaction_id}\n\n` +
      `Si sigue fallando dime y lo resolvemos por otro medio.`;

    const envio = await metaSend.sendText({
      channelType: conversacion.channel_type,
      to: conversacion.end_customer_id,
      text: texto
    });
    await registrarMensajeBot(conversacion, texto, envio.externalId, envio.sent);

    logger.info('Aviso de pago rechazado enviado', {
      conversationId: conversacion.id, orderId: transaction.bold_transaction_id
    });
  } catch (error) {
    logger.error('No se pudo avisar el rechazo del pago', {
      transactionId: transaction.id, error: error.message
    });
  }
}

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

      // Cerrar el círculo con quien pagó: si el cobro salió de una conversación
      // de WhatsApp, ahí mismo se confirma. Sin esto el cliente paga y queda en
      // el aire preguntándose si llegó — que es justo cuando escribe "ya pagué,
      // me confirmas?" y alguien tiene que atenderlo a mano.
      await confirmarPagoAlCliente(transaction, plan);
    } else if (newStatus === 'failed') {
      await avisarPagoRechazado(transaction);
    }

    res.json({ success: true, received: true });
  } catch (error) {
    logger.error('Error procesando webhook de Bold', { error: error.message });
    next(error);
  }
});

module.exports = router;
