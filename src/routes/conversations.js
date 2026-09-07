const express = require('express');
const Joi = require('joi');
const { verifyToken } = require('../middleware/auth');
const { dbGet, dbAll, dbRun } = require('../config/database');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * Módulo de supervisión en vivo de conversaciones (bot ↔ cliente final).
 *
 * Regla clave del producto: el dueño del negocio puede pausar el bot en
 * UNA conversación puntual (no globalmente), escribir él mismo, y
 * reactivar el bot cuando termine. El bot en sí (cualquiera sea el
 * proveedor elegido: Twilio/360dialog/etc.) debe consultar `mode` antes
 * de auto-responder — si mode != 'bot', no debe enviar nada automático.
 *
 * io (socket.io) se inyecta desde server.js para emitir eventos en vivo
 * a los dueños de negocio conectados a su sala `client:<id>`.
 */

let io = null;
const setIO = (socketIoInstance) => { io = socketIoInstance; };

const emitToClient = (clientId, event, payload) => {
  if (io) io.to(`client:${clientId}`).emit(event, payload);
};

// GET /api/conversations?client_id=1 - Bandeja en vivo de un negocio
router.get('/', verifyToken, async (req, res, next) => {
  try {
    const clientId = req.query.client_id;
    if (!clientId) {
      return res.status(400).json({ error: 'client_id requerido' });
    }

    const conversations = await dbAll(
      `SELECT * FROM conversations WHERE client_id = ? ORDER BY last_message_at DESC, created_at DESC LIMIT 100`,
      [clientId]
    );

    res.json({ success: true, data: conversations });
  } catch (error) {
    next(error);
  }
});

// GET /api/conversations/:id/messages - Historial de mensajes de una conversación
router.get('/:id/messages', verifyToken, async (req, res, next) => {
  try {
    const conversation = await dbGet('SELECT * FROM conversations WHERE id = ?', [req.params.id]);
    if (!conversation) {
      return res.status(404).json({ error: 'Conversación no encontrada' });
    }

    const messages = await dbAll(
      'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT 200',
      [req.params.id]
    );

    res.json({ success: true, data: { conversation, messages } });
  } catch (error) {
    next(error);
  }
});

// POST /api/conversations/:id/pause - El dueño pausa el bot en esta conversación
router.post('/:id/pause', verifyToken, async (req, res, next) => {
  try {
    const conversation = await dbGet('SELECT * FROM conversations WHERE id = ?', [req.params.id]);
    if (!conversation) {
      return res.status(404).json({ error: 'Conversación no encontrada' });
    }

    await dbRun('UPDATE conversations SET mode = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', ['human', conversation.id]);
    await dbRun(
      'INSERT INTO handoff_events (conversation_id, trigger_type, detail) VALUES (?, ?, ?)',
      [conversation.id, 'owner_paused', `Pausado manualmente por ${req.user.email}`]
    );

    logger.info('Bot pausado por el dueño', { conversationId: conversation.id, userId: req.user.id });
    emitToClient(conversation.client_id, 'conversation:mode_changed', { conversationId: conversation.id, mode: 'human' });

    res.json({ success: true, message: 'Bot pausado. Ahora puedes escribir tú directamente.' });
  } catch (error) {
    next(error);
  }
});

// POST /api/conversations/:id/resume - El dueño reactiva el bot en esta conversación
router.post('/:id/resume', verifyToken, async (req, res, next) => {
  try {
    const conversation = await dbGet('SELECT * FROM conversations WHERE id = ?', [req.params.id]);
    if (!conversation) {
      return res.status(404).json({ error: 'Conversación no encontrada' });
    }

    await dbRun('UPDATE conversations SET mode = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', ['bot', conversation.id]);
    await dbRun(
      'INSERT INTO handoff_events (conversation_id, trigger_type, detail) VALUES (?, ?, ?)',
      [conversation.id, 'owner_resumed', `Reactivado manualmente por ${req.user.email}`]
    );

    logger.info('Bot reactivado por el dueño', { conversationId: conversation.id, userId: req.user.id });
    emitToClient(conversation.client_id, 'conversation:mode_changed', { conversationId: conversation.id, mode: 'bot' });

    res.json({ success: true, message: 'Bot reactivado.' });
  } catch (error) {
    next(error);
  }
});

// POST /api/conversations/:id/messages - El dueño envía un mensaje como humano
// (el envío real por WhatsApp/IG/Messenger lo hace el conector del proveedor,
//  aquí solo se registra y se emite en vivo; el conector lo consume vía evento)
const sendMessageSchema = Joi.object({ content: Joi.string().min(1).required() });

router.post('/:id/messages', verifyToken, async (req, res, next) => {
  try {
    const { error, value } = sendMessageSchema.validate(req.body);
    if (error) {
      error.isJoi = true;
      throw error;
    }

    const conversation = await dbGet('SELECT * FROM conversations WHERE id = ?', [req.params.id]);
    if (!conversation) {
      return res.status(404).json({ error: 'Conversación no encontrada' });
    }

    const result = await dbRun(
      'INSERT INTO messages (conversation_id, sender_type, content) VALUES (?, ?, ?)',
      [conversation.id, 'owner', value.content]
    );

    await dbRun(
      'UPDATE conversations SET last_message_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [conversation.id]
    );

    const message = { id: result.id, conversation_id: conversation.id, sender_type: 'owner', content: value.content, created_at: new Date().toISOString() };

    logger.info('Mensaje enviado por el dueño', { conversationId: conversation.id, userId: req.user.id });
    emitToClient(conversation.client_id, 'conversation:new_message', message);

    res.status(201).json({ success: true, data: message });
  } catch (error) {
    next(error);
  }
});

module.exports = { router, setIO, emitToClient };
