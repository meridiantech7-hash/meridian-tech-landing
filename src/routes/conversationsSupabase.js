const express = require('express');
const Joi = require('joi');
const { verifyToken, exigirAccesoACliente, clienteForzado } = require('../middleware/auth');
const sb = require('../services/supabaseApp');
const metaSend = require('../services/metaSend');
const logger = require('../utils/logger');

/**
 * Bandeja de conversaciones cuando el flujo vive en n8n: mismas rutas y mismas
 * respuestas que conversations.js, pero sobre Supabase. La tablet no nota la
 * diferencia.
 */

const router = express.Router();
const emitir = (...args) => require('./conversations').emitToClient(...args);

/** Trae la conversación y verifica que el usuario pueda verla. */
const cargar = async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: 'id inválido' });
    return null;
  }
  const [c] = await sb.select('conversations', `id=eq.${id}&select=*`);
  if (!c) {
    res.status(404).json({ error: 'Conversación no encontrada' });
    return null;
  }
  const appId = await sb.aClienteApp(c.client_id);
  if (!exigirAccesoACliente(req, res, appId)) return null;
  return { ...c, client_id: appId };
};

router.get('/', verifyToken, async (req, res, next) => {
  try {
    const forzado = clienteForzado(req.user);
    const appId = forzado !== null ? forzado : req.query.client_id;
    if (!appId) return res.status(400).json({ error: 'client_id requerido' });

    const supaId = await sb.aClienteSupabase(appId);
    const data = await sb.select('conversations',
      `client_id=eq.${Number(supaId)}&select=*&order=last_message_at.desc.nullslast,created_at.desc&limit=100`);
    res.json({ success: true, data: data.map((c) => ({ ...c, client_id: Number(appId) })) });
  } catch (error) {
    next(error);
  }
});

router.get('/:id/messages', verifyToken, async (req, res, next) => {
  try {
    const conversation = await cargar(req, res);
    if (!conversation) return;
    // Los 200 más recientes, en orden de llegada.
    const messages = (await sb.select('messages',
      `conversation_id=eq.${conversation.id}&select=*&order=id.desc&limit=200`)).reverse();
    res.json({ success: true, data: { conversation, messages } });
  } catch (error) {
    next(error);
  }
});

const cambiarModo = (modo, motivo, aviso) => async (req, res, next) => {
  try {
    const conversation = await cargar(req, res);
    if (!conversation) return;
    await sb.rpc('cambiar_modo', {
      p_conversation_id: conversation.id, p_modo: modo, p_motivo: motivo,
      p_detalle: `${motivo === 'owner_paused' ? 'Pausado' : 'Reactivado'} manualmente por ${req.user.email}`
    });
    sb.marcarEmitido(`modo:${conversation.id}:${modo}`);
    emitir(conversation.client_id, 'conversation:mode_changed', { conversationId: conversation.id, mode: modo });
    logger.info(modo === 'human' ? 'Bot pausado por el dueño' : 'Bot reactivado por el dueño', {
      conversationId: conversation.id, userId: req.user.id
    });
    res.json({ success: true, message: aviso });
  } catch (error) {
    next(error);
  }
};

router.post('/:id/pause', verifyToken, cambiarModo('human', 'owner_paused', 'Bot pausado. Ahora puedes escribir tú directamente.'));
router.post('/:id/resume', verifyToken, cambiarModo('bot', 'owner_resumed', 'Bot reactivado.'));

router.delete('/:id', verifyToken, async (req, res, next) => {
  try {
    const conversation = await cargar(req, res);
    if (!conversation) return;
    const mensajes = await sb.select('messages', `conversation_id=eq.${conversation.id}&select=id`);

    // Las reservas sobreviven: pierden el vínculo con el chat, no se borran.
    await sb.actualizar('reservations', `conversation_id=eq.${conversation.id}`, { conversation_id: null });
    await sb.borrar('handoff_events', `conversation_id=eq.${conversation.id}`);
    await sb.borrar('messages', `conversation_id=eq.${conversation.id}`);
    await sb.borrar('conversations', `id=eq.${conversation.id}`);

    logger.info('Conversación borrada', {
      conversationId: conversation.id, telefono: conversation.end_customer_id, mensajes: mensajes.length
    });
    emitir(conversation.client_id, 'conversation:deleted', { conversationId: conversation.id });
    res.json({ success: true, data: { conversationId: conversation.id, mensajesBorrados: mensajes.length, pedidosDesvinculados: 0 } });
  } catch (error) {
    next(error);
  }
});

const sendMessageSchema = Joi.object({ content: Joi.string().min(1).required() });

router.post('/:id/messages', verifyToken, async (req, res, next) => {
  try {
    const { error, value } = sendMessageSchema.validate(req.body);
    if (error) { error.isJoi = true; throw error; }

    const conversation = await cargar(req, res);
    if (!conversation) return;

    const dispatch = await metaSend.sendText({
      channelType: conversation.channel_type,
      to: conversation.end_customer_id,
      text: value.content
    });

    const guardado = await sb.rpc('guardar_saliente', {
      p_conversation_id: conversation.id, p_remitente: 'owner',
      p_texto: value.content, p_meta_id: dispatch.externalId || null
    });
    sb.marcarEmitido(`m:${guardado.message_id}`);

    const message = {
      id: guardado.message_id, conversation_id: conversation.id, sender_type: 'owner',
      content: value.content, delivered: dispatch.sent, created_at: new Date().toISOString()
    };
    emitir(conversation.client_id, 'conversation:new_message', message);
    logger.info('Mensaje enviado por el dueño', { conversationId: conversation.id, userId: req.user.id, entregado: dispatch.sent });

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

module.exports = router;
