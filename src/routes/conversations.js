const express = require('express');
const Joi = require('joi');
const { verifyToken } = require('../middleware/auth');
const { dbGet, dbAll, dbRun } = require('../config/database');
const geminiService = require('../services/geminiService');
const metaSend = require('../services/metaSend');
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

// POST /api/conversations/:id/messages - El dueño envía un mensaje como humano.
// Se despacha por el mismo canal y el mismo número del negocio, así que para el
// cliente final es indistinguible del bot: no ve dos líneas ni sabe que hubo
// un cambio de manos.
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

    const dispatch = await metaSend.sendText({
      channelType: conversation.channel_type,
      to: conversation.end_customer_id,
      text: value.content
    });

    const result = await dbRun(
      'INSERT INTO messages (conversation_id, sender_type, content, external_message_id) VALUES (?, ?, ?, ?)',
      [conversation.id, 'owner', value.content, dispatch.externalId || null]
    );

    await dbRun(
      'UPDATE conversations SET last_message_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [conversation.id]
    );

    const message = {
      id: result.id, conversation_id: conversation.id, sender_type: 'owner',
      content: value.content, delivered: dispatch.sent, created_at: new Date().toISOString()
    };

    logger.info('Mensaje enviado por el dueño', {
      conversationId: conversation.id, userId: req.user.id, entregado: dispatch.sent
    });
    emitToClient(conversation.client_id, 'conversation:new_message', message);

    // Si no salió, se responde 202: quedó guardado y visible, pero el dueño
    // tiene que saber que el cliente NO lo recibió (lo más probable: pasaron
    // más de 24h desde el último mensaje del cliente y WhatsApp exige plantilla).
    if (!dispatch.sent) {
      return res.status(202).json({
        success: true,
        data: message,
        warning: dispatch.error?.outsideWindow
          ? 'Guardado, pero NO entregado: pasaron más de 24 horas desde el último mensaje del cliente. WhatsApp solo permite plantillas aprobadas fuera de esa ventana.'
          : `Guardado, pero NO entregado: ${dispatch.error?.reason || 'error de envío'}`
      });
    }

    res.status(201).json({ success: true, data: message });
  } catch (error) {
    next(error);
  }
});

// POST /api/conversations/incoming — punto de entrada único para CUALQUIER
// proveedor de mensajería (Twilio/360dialog/Meta directo). El conector real
// de cada canal (aún por conectar, ver INFRAESTRUCTURA.md) solo necesita
// traducir su payload a esta forma; toda la lógica de bot/derivación vive
// aquí una sola vez.
//
// ⚠️ Sin autenticación de usuario porque no la llama un admin logueado sino
// el conector del proveedor — cuando se conecte Twilio real, esta ruta debe
// protegerse verificando la firma de la petición (igual que el webhook de
// Bold en payments.js), no con verifyToken.
const incomingSchema = Joi.object({
  client_id: Joi.number().integer().required(),
  channel_type: Joi.string().valid('whatsapp', 'instagram', 'messenger').required(),
  end_customer_id: Joi.string().required(),
  end_customer_name: Joi.string().allow(''),
  text: Joi.string().allow(''),
  imageBase64: Joi.string(),
  imageMimeType: Joi.string(),
  audioBase64: Joi.string(),
  audioMimeType: Joi.string()
}).or('text', 'imageBase64', 'audioBase64');

router.post('/incoming', async (req, res, next) => {
  try {
    const { error, value } = incomingSchema.validate(req.body);
    if (error) {
      error.isJoi = true;
      throw error;
    }

    // 1. Buscar o crear la conversación
    let conversation = await dbGet(
      'SELECT * FROM conversations WHERE client_id = ? AND channel_type = ? AND end_customer_id = ?',
      [value.client_id, value.channel_type, value.end_customer_id]
    );

    if (!conversation) {
      const result = await dbRun(
        `INSERT INTO conversations (client_id, channel_type, end_customer_id, end_customer_name, mode, last_message_at)
         VALUES (?, ?, ?, ?, 'bot', CURRENT_TIMESTAMP)`,
        [value.client_id, value.channel_type, value.end_customer_id, value.end_customer_name || null]
      );
      conversation = await dbGet('SELECT * FROM conversations WHERE id = ?', [result.id]);
    }

    // 2. Guardar el mensaje entrante del cliente final
    const incomingText = value.text || (value.imageBase64 ? '[imagen]' : '[audio]');
    await dbRun(
      'INSERT INTO messages (conversation_id, sender_type, content) VALUES (?, ?, ?)',
      [conversation.id, 'end_customer', incomingText]
    );
    await dbRun(
      'UPDATE conversations SET last_message_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [conversation.id]
    );
    emitToClient(conversation.client_id, 'conversation:new_message', {
      conversation_id: conversation.id, sender_type: 'end_customer', content: incomingText, created_at: new Date().toISOString()
    });

    // 3. Si el bot está pausado o en modo humano, no responder automáticamente
    if (conversation.mode !== 'bot') {
      logger.info('Mensaje recibido pero el bot no está activo en esta conversación', { conversationId: conversation.id, mode: conversation.mode });
      return res.json({ success: true, data: { conversationId: conversation.id, botResponded: false, mode: conversation.mode } });
    }

    // 4. Historial reciente para dar contexto al bot
    const history = await dbAll(
      'SELECT sender_type, content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT 20',
      [conversation.id]
    );

    const { handoff, reply } = await geminiService.generateBotResponse(value.client_id, history.slice(0, -1), {
      text: value.text,
      imageBase64: value.imageBase64,
      imageMimeType: value.imageMimeType,
      audioBase64: value.audioBase64,
      audioMimeType: value.audioMimeType
    });

    if (handoff) {
      await dbRun('UPDATE conversations SET mode = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', ['human', conversation.id]);
      await dbRun(
        'INSERT INTO handoff_events (conversation_id, trigger_type, detail) VALUES (?, ?, ?)',
        [conversation.id, 'auto', handoff]
      );
      logger.info('Derivación automática a humano', { conversationId: conversation.id, reason: handoff });
      emitToClient(conversation.client_id, 'conversation:mode_changed', { conversationId: conversation.id, mode: 'human', reason: handoff });
      return res.json({ success: true, data: { conversationId: conversation.id, botResponded: false, handoff } });
    }

    // 5. Despachar, guardar y emitir la respuesta del bot
    const dispatch = await metaSend.sendText({
      channelType: conversation.channel_type,
      to: conversation.end_customer_id,
      text: reply
    });

    const botMsg = await dbRun(
      'INSERT INTO messages (conversation_id, sender_type, content, external_message_id) VALUES (?, ?, ?, ?)',
      [conversation.id, 'bot', reply, dispatch.externalId || null]
    );
    await dbRun('UPDATE conversations SET last_message_at = CURRENT_TIMESTAMP WHERE id = ?', [conversation.id]);
    const botMessage = {
      id: botMsg.id, conversation_id: conversation.id, sender_type: 'bot',
      content: reply, delivered: dispatch.sent, created_at: new Date().toISOString()
    };
    emitToClient(conversation.client_id, 'conversation:new_message', botMessage);

    res.json({
      success: true,
      data: { conversationId: conversation.id, botResponded: true, reply, delivered: dispatch.sent }
    });
  } catch (error) {
    next(error);
  }
});

module.exports = { router, setIO, emitToClient };
