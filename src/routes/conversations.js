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

// DELETE /api/conversations/:id — borra una conversación y su historial.
//
// Se borra de verdad, no se marca como inactiva: lo que se quiere quitar de
// acá son chats de prueba y basura, y dejarlos escondidos en la base solo
// engaña a quien mire después.
//
// El esquema ya deja el rastro limpio, y `PRAGMA foreign_keys = ON` lo hace
// cumplir: los mensajes y los eventos de derivación caen en cascada, mientras
// los pedidos y las reservas SOBREVIVEN y solo pierden el vínculo con el chat
// (ON DELETE SET NULL). Un pedido cobrado no puede desaparecer porque alguien
// borró una conversación.
router.delete('/:id', verifyToken, async (req, res, next) => {
  try {
    const conversation = await dbGet('SELECT * FROM conversations WHERE id = ?', [req.params.id]);
    if (!conversation) {
      return res.status(404).json({ error: 'Conversación no encontrada' });
    }

    // Se cuenta antes de borrar, para poder decir qué se llevó — que es la
    // diferencia entre confirmar un borrado y confiar en que salió bien.
    const cuenta = await dbGet(
      'SELECT COUNT(*) as n FROM messages WHERE conversation_id = ?', [req.params.id]
    );
    const pedidos = await dbGet(
      'SELECT COUNT(*) as n FROM orders WHERE conversation_id = ?', [req.params.id]
    );

    await dbRun('DELETE FROM conversations WHERE id = ?', [req.params.id]);

    await dbRun(
      'INSERT INTO activity_logs (user_id, client_id, action, entity) VALUES (?, ?, ?, ?)',
      [req.user.id, conversation.client_id, 'DELETE', 'CONVERSATION']
    );

    logger.info('Conversación borrada', {
      conversationId: conversation.id,
      telefono: conversation.end_customer_id,
      mensajes: cuenta.n,
      pedidosDesvinculados: pedidos.n
    });

    // Las otras pantallas abiertas tienen que soltarla, o quedan mostrando un
    // chat que ya no existe.
    emitToClient(conversation.client_id, 'conversation:deleted', { conversationId: conversation.id });

    res.json({
      success: true,
      data: {
        conversationId: conversation.id,
        mensajesBorrados: cuenta.n,
        pedidosDesvinculados: pedidos.n
      }
    });
  } catch (error) {
    next(error);
  }
});

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

// La ruta POST /api/conversations/incoming se eliminó a propósito.
//
// Era un segundo punto de entrada, SIN autenticación y con una copia vieja de
// la lógica: no tenía el candado de temas restringidos, ni la autorización del
// dueño, ni la detección de intención de pago, ni el partido en dos mensajes,
// ni la memoria al abrir la conversación. Cualquiera que conociera la URL
// podía conversar con el modelo a costa de la empresa, inyectar mensajes en
// cualquier client_id y saltarse todas esas reglas.
//
// El único camino de entrada es ahora POST /api/webhooks/meta, que verifica la
// firma X-Hub-Signature-256 antes de tocar nada. Si algún día se conecta otro
// proveedor de mensajería, su webhook va allí con su propia verificación de
// firma — no con una ruta abierta.

module.exports = { router, setIO, emitToClient };
