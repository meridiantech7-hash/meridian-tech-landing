const express = require('express');
const crypto = require('crypto');
const { dbGet, dbAll, dbRun } = require('../config/database');
const geminiService = require('../services/geminiService');
const { emitToClient } = require('./conversations');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * Webhook único de Meta para los TRES canales: WhatsApp Cloud API,
 * Instagram y Messenger.
 *
 * Meta exige dos comportamientos en la MISMA URL:
 *  - GET  → verificación inicial: responde el `hub.challenge` en texto plano
 *           si el `hub.verify_token` coincide con META_VERIFY_TOKEN.
 *  - POST → entrega de eventos. Se responde 200 de inmediato (Meta reintenta
 *           si tarda) y el procesamiento del bot ocurre después.
 *
 * Los payloads de WhatsApp y de IG/Messenger tienen formas distintas, así que
 * cada uno se normaliza a la misma estructura interna antes de pasar al motor
 * de IA — la misma que usa POST /api/conversations/incoming.
 */

const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;
const APP_SECRET = process.env.META_APP_SECRET;

// ── Verificación del webhook (GET) ──────────────────────────────────────────
router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token && token === VERIFY_TOKEN) {
    logger.info('Webhook de Meta verificado correctamente');
    return res.status(200).send(challenge);
  }

  logger.warn('Verificación de webhook de Meta rechazada', { mode, ip: req.ip });
  res.sendStatus(403);
});

/**
 * Verifica la firma X-Hub-Signature-256 que Meta envía en cada POST.
 * Sin META_APP_SECRET configurado no se puede validar; en ese caso se deja
 * pasar pero se registra la advertencia (para no bloquear las pruebas).
 */
const isValidSignature = (req) => {
  if (!APP_SECRET) {
    logger.warn('META_APP_SECRET no configurado — webhook sin verificar firma');
    return true;
  }
  const signature = req.get('x-hub-signature-256');
  if (!signature || !req.rawBody) return false;

  const expected = 'sha256=' + crypto
    .createHmac('sha256', APP_SECRET)
    .update(req.rawBody)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch (e) {
    return false;
  }
};

// ── Normalizadores de payload ───────────────────────────────────────────────

/** WhatsApp Cloud API → mensajes normalizados */
const parseWhatsApp = (value) => {
  const out = [];
  const contacts = value.contacts || [];
  (value.messages || []).forEach((m) => {
    const contact = contacts.find(c => c.wa_id === m.from);
    out.push({
      channel_type: 'whatsapp',
      end_customer_id: m.from,
      end_customer_name: contact?.profile?.name || null,
      text: m.text?.body || m.button?.text || m.interactive?.list_reply?.title || null,
      mediaId: m.image?.id || m.audio?.id || m.voice?.id || null,
      mediaType: m.image ? 'image' : (m.audio || m.voice) ? 'audio' : null,
      external_message_id: m.id
    });
  });
  return out;
};

/** Instagram / Messenger → mensajes normalizados */
const parseMessaging = (entry, channelType) => {
  const out = [];
  (entry.messaging || []).forEach((ev) => {
    if (!ev.message || ev.message.is_echo) return; // ignora los ecos del propio bot
    const attachment = (ev.message.attachments || [])[0];
    out.push({
      channel_type: channelType,
      end_customer_id: ev.sender?.id,
      end_customer_name: null,
      text: ev.message.text || null,
      mediaUrl: attachment?.payload?.url || null,
      mediaType: attachment?.type === 'image' ? 'image'
        : (attachment?.type === 'audio' ? 'audio' : null),
      external_message_id: ev.message.mid
    });
  });
  return out;
};

// ── Procesamiento del mensaje (misma lógica que /conversations/incoming) ────
async function processMessage(clientId, msg) {
  let conversation = await dbGet(
    'SELECT * FROM conversations WHERE client_id = ? AND channel_type = ? AND end_customer_id = ?',
    [clientId, msg.channel_type, msg.end_customer_id]
  );

  if (!conversation) {
    const created = await dbRun(
      `INSERT INTO conversations (client_id, channel_type, end_customer_id, end_customer_name, mode, last_message_at)
       VALUES (?, ?, ?, ?, 'bot', CURRENT_TIMESTAMP)`,
      [clientId, msg.channel_type, msg.end_customer_id, msg.end_customer_name]
    );
    conversation = await dbGet('SELECT * FROM conversations WHERE id = ?', [created.id]);
  }

  const shownText = msg.text || (msg.mediaType === 'image' ? '[imagen]' : msg.mediaType === 'audio' ? '[audio]' : '[mensaje]');

  await dbRun(
    'INSERT INTO messages (conversation_id, sender_type, content, external_message_id) VALUES (?, ?, ?, ?)',
    [conversation.id, 'end_customer', shownText, msg.external_message_id || null]
  );
  await dbRun('UPDATE conversations SET last_message_at = CURRENT_TIMESTAMP WHERE id = ?', [conversation.id]);

  emitToClient(clientId, 'conversation:new_message', {
    conversation_id: conversation.id, sender_type: 'end_customer', content: shownText, created_at: new Date().toISOString()
  });

  // Si el dueño tomó el control, el bot no responde
  if (conversation.mode !== 'bot') {
    logger.info('Mensaje recibido con bot inactivo', { conversationId: conversation.id, mode: conversation.mode });
    return;
  }

  const history = await dbAll(
    'SELECT sender_type, content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT 20',
    [conversation.id]
  );

  // NOTA: para imagen/audio, Meta entrega un media id (WhatsApp) o una URL
  // temporal (IG/Messenger). Descargarlos y pasarlos a Gemini requiere el
  // token de acceso permanente (META_ACCESS_TOKEN) — pendiente de configurar.
  // Hasta entonces, el bot recibe solo el texto y el marcador del adjunto.
  const { handoff, reply } = await geminiService.generateBotResponse(
    clientId,
    history.slice(0, -1),
    { text: shownText }
  );

  if (handoff) {
    await dbRun('UPDATE conversations SET mode = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', ['human', conversation.id]);
    await dbRun('INSERT INTO handoff_events (conversation_id, trigger_type, detail) VALUES (?, ?, ?)',
      [conversation.id, 'auto', handoff]);
    emitToClient(clientId, 'conversation:mode_changed', { conversationId: conversation.id, mode: 'human', reason: handoff });
    logger.info('Derivación automática a humano desde webhook de Meta', { conversationId: conversation.id, reason: handoff });
    return;
  }

  const botMsg = await dbRun('INSERT INTO messages (conversation_id, sender_type, content) VALUES (?, ?, ?)',
    [conversation.id, 'bot', reply]);
  emitToClient(clientId, 'conversation:new_message', {
    id: botMsg.id, conversation_id: conversation.id, sender_type: 'bot', content: reply, created_at: new Date().toISOString()
  });

  // NOTA: el envío de `reply` de vuelta al cliente final (Cloud API / Send API)
  // requiere META_ACCESS_TOKEN + phone_number_id. Queda registrado y visible en
  // la bandeja en vivo; el despacho real se activa al configurar ese token.
  logger.info('Respuesta del bot generada desde webhook de Meta', { conversationId: conversation.id, canal: msg.channel_type });
}

// ── Recepción de eventos (POST) ─────────────────────────────────────────────
router.post('/', async (req, res) => {
  if (!isValidSignature(req)) {
    logger.warn('Webhook de Meta con firma inválida', { ip: req.ip });
    return res.sendStatus(401);
  }

  // Responder ya: Meta reintenta si el webhook tarda más de unos segundos
  res.sendStatus(200);

  try {
    const body = req.body;
    if (!body || !body.object) return;

    // Se resuelve el negocio dueño del canal. Hoy hay un solo cliente interno
    // (MeridianTech, capa B). Cuando haya varios negocios (capa A), se resuelve
    // por el phone_number_id / page id contra la tabla `channels`.
    const internal = await dbGet('SELECT id FROM clients WHERE is_internal = 1');
    const clientId = internal?.id;
    if (!clientId) {
      logger.error('Webhook de Meta sin cliente interno configurado');
      return;
    }

    const messages = [];
    (body.entry || []).forEach((entry) => {
      if (body.object === 'whatsapp_business_account') {
        (entry.changes || []).forEach((ch) => {
          if (ch.field === 'messages' && ch.value) messages.push(...parseWhatsApp(ch.value));
        });
      } else if (body.object === 'instagram') {
        messages.push(...parseMessaging(entry, 'instagram'));
      } else if (body.object === 'page') {
        messages.push(...parseMessaging(entry, 'messenger'));
      }
    });

    for (const msg of messages) {
      if (!msg.end_customer_id) continue;
      await processMessage(clientId, msg);
    }
  } catch (error) {
    logger.error('Error procesando webhook de Meta', { error: error.message, stack: error.stack });
  }
});

module.exports = router;
