const express = require('express');
const crypto = require('crypto');
const { dbGet, dbAll, dbRun } = require('../config/database');
const geminiService = require('../services/geminiService');
const metaSend = require('../services/metaSend');
const { emitToClient } = require('./conversations');
const { createOrder } = require('./orders');
const ventaService = require('../services/ventaService');
const ownerService = require('../services/ownerService');
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
// `.trim()` no es cosmético: al pegar la clave en el panel de Railway es fácil
// arrastrar un espacio o un salto de línea invisible, y un solo byte de más
// cambia por completo el HMAC. El síntoma es brutal — Meta entrega los mensajes
// y el servidor los rechaza todos con 401 — y la causa es invisible.
const APP_SECRET = (process.env.META_APP_SECRET || '').trim();

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
  if (!signature || !req.rawBody) {
    logger.warn('Webhook sin firma o sin cuerpo crudo', {
      tieneFirma: !!signature, tieneCuerpo: !!req.rawBody
    });
    return false;
  }

  const expected = 'sha256=' + crypto
    .createHmac('sha256', APP_SECRET)
    .update(req.rawBody)
    .digest('hex');

  let coincide = false;
  try {
    coincide = crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch (e) {
    coincide = false;
  }

  // Diagnóstico cuando NO coincide. Las firmas no son secretas (una viaja en la
  // cabecera y la otra se deriva de ella), así que se pueden registrar; la clave
  // nunca. Comparar ambas distingue "la clave está mal" de "el cuerpo llegó
  // alterado", que se arreglan de formas muy distintas.
  if (!coincide) {
    logger.warn('Firma HMAC no coincide', {
      recibida: signature,
      calculada: expected,
      bytesCuerpo: req.rawBody.length,
      largoClave: APP_SECRET.length
    });
  }

  return coincide;
};

// ── Normalizadores de payload ───────────────────────────────────────────────

/** WhatsApp Cloud API → mensajes normalizados */
const parseWhatsApp = (value) => {
  const out = [];
  const contacts = value.contacts || [];
  // El phone_number_id viene en cada evento. Se conserva porque es la clave que
  // identifica QUÉ número recibió el mensaje: cuando haya varios negocios
  // (capa A), es lo que permite responder por la línea correcta y no por la
  // de otro cliente.
  const phoneNumberId = value.metadata?.phone_number_id || null;

  (value.messages || []).forEach((m) => {
    const contact = contacts.find(c => c.wa_id === m.from);
    out.push({
      channel_type: 'whatsapp',
      end_customer_id: m.from,
      end_customer_name: contact?.profile?.name || null,
      text: m.text?.body || m.button?.text || m.interactive?.list_reply?.title || null,
      mediaId: m.image?.id || m.audio?.id || m.voice?.id || null,
      mediaType: m.image ? 'image' : (m.audio || m.voice) ? 'audio' : null,
      external_message_id: m.id,
      phone_number_id: phoneNumberId
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

  // Acuse de lectura: se manda incluso si el dueño tomó el control, porque el
  // cliente merece ver que su mensaje llegó aunque la respuesta tarde.
  if (msg.channel_type === 'whatsapp' && msg.external_message_id) {
    metaSend.markAsRead(msg.external_message_id, msg.phone_number_id).catch(() => {});
  }

  // Si el dueño tomó el control, el bot no responde
  if (conversation.mode !== 'bot') {
    logger.info('Mensaje recibido con bot inactivo', { conversationId: conversation.id, mode: conversation.mode });
    return;
  }

  // Candado de temas restringidos y atajos del dueño — se revisa ANTES que
  // todo lo demás, con lo que ya tenemos en `config` (una sola lectura, sin
  // IA): inventario, estados de cuenta y de reservas jamás los responde el
  // bot por cuenta propia, y los pedidos/reservas de hoy se le contestan al
  // dueño con una consulta directa a la base, no con la IA adivinando cifras.
  const config = await geminiService.getBotConfig(clientId);
  const esDueno = ownerService.esDueno(config, msg.end_customer_id);

  // Cambiar menú, precios o plan por WhatsApp se rechaza para TODOS, dueño
  // incluido: para eso existe la pestaña "Menú e info" de la tablet, que sí
  // guarda el cambio de forma controlada. Por texto libre no.
  if (ownerService.esSolicitudDeEdicion(msg.text)) {
    logger.info('Solicitud de edición de menú/precios/plan redirigida a la tablet', { conversationId: conversation.id, esDueno });
    await responderDirecto(clientId, conversation, msg, ownerService.MENSAJE_USA_TABLET);
    return;
  }

  if (!esDueno) {
    const temaRestringido = ownerService.esTemaRestringido(msg.text);
    if (temaRestringido) {
      logger.info('Tema restringido rechazado sin IA', { conversationId: conversation.id, tema: temaRestringido });
      await responderDirecto(clientId, conversation, msg, ownerService.MENSAJE_NO_AUTORIZADO);
      return;
    }
  } else if (ownerService.esConsultaPedidos(msg.text)) {
    const resumen = await ownerService.resumenPedidosHoy(clientId);
    await responderDirecto(clientId, conversation, msg, resumen);
    return;
  } else if (ownerService.esConsultaReservas(msg.text)) {
    const resumen = await ownerService.resumenReservasHoy(clientId);
    await responderDirecto(clientId, conversation, msg, resumen);
    return;
  }

  const history = await dbAll(
    'SELECT sender_type, content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT 20',
    [conversation.id]
  );

  // ¿El cliente está pidiendo pagar? Se revisa ANTES de llamar al modelo, por
  // dos razones: no gasta tokens, y sobre todo el mensaje de cobro lo armamos
  // nosotros con el monto exacto en vez de confiar en que el modelo no se
  // equivoque con una cifra. El asistente tiene prohibido ofrecer el pago; este
  // camino solo se abre cuando el cliente lo pide con sus palabras.
  const fraseDePago = ventaService.pidePagar(msg.text);
  if (fraseDePago) {
    logger.info('El cliente pidió pagar', {
      conversationId: conversation.id, frase: fraseDePago
    });
    const cobrado = await enviarCobro(clientId, conversation, msg);
    if (cobrado) return;
    // Si no se pudo determinar el plan, se sigue al flujo normal: el asistente
    // preguntará cuál plan quiere, que es lo correcto en vez de adivinar.
  }

  // Adjuntos: WhatsApp entrega un media id que hay que resolver contra la Graph
  // API; IG/Messenger entregan una URL firmada directamente en el webhook.
  // Se bajan aquí y se pasan a Gemini como bytes, que es lo que le permite
  // *oír* el audio y *ver* la imagen en vez de recibir solo un marcador.
  const incoming = { text: msg.text || null };

  if (msg.mediaType) {
    const media = msg.mediaId
      ? await metaSend.downloadWhatsAppMedia(msg.mediaId)
      : await metaSend.downloadFromUrl(msg.mediaUrl);

    if (media) {
      if (msg.mediaType === 'image') {
        incoming.imageBase64 = media.base64;
        incoming.imageMimeType = media.mimeType;
      } else {
        incoming.audioBase64 = media.base64;
        incoming.audioMimeType = media.mimeType;
      }
      logger.info('Adjunto descargado para el motor de IA', {
        conversationId: conversation.id, tipo: msg.mediaType, mime: media.mimeType
      });
    } else {
      // No se pudo bajar (token ausente, adjunto vencido o muy grande): el bot
      // sigue el flujo con el marcador de texto en vez de quedarse mudo.
      incoming.text = incoming.text || shownText;
      logger.warn('Adjunto no descargado, el bot responde solo con el texto', {
        conversationId: conversation.id, tipo: msg.mediaType
      });
    }
  }

  if (!incoming.text && !incoming.imageBase64 && !incoming.audioBase64) {
    incoming.text = shownText;
  }

  const { handoff, reply, memoryNote } = await geminiService.generateBotResponse(
    clientId,
    history.slice(0, -1),
    incoming,
    null,
    { customerNotes: conversation.customer_notes }
  );

  if (handoff) {
    // Se distingue POR QUÉ se deriva, y no es un detalle menor.
    //
    // Si el cliente pidió hablar con una persona, la conversación pasa a modo
    // humano y ahí se queda hasta que alguien la devuelva: eso es lo correcto.
    //
    // Pero si la IA simplemente falló (Google caído, saturado, sin respuesta),
    // dejarla en modo humano la silencia PARA SIEMPRE. Pasó en producción: una
    // falla pasajera de Gemini dejó la conversación muda, el cliente siguió
    // escribiendo y el bot no volvió a contestar nunca — parecía que el sistema
    // estaba roto cuando en realidad estaba obedeciendo. Un problema técnico
    // pasajero no puede tener consecuencias permanentes: se avisa al dueño,
    // pero el bot sigue habilitado para intentarlo en el próximo mensaje.
    const fueFallaTecnica = /error de IA|sin respuesta del modelo/i.test(handoff);

    if (!fueFallaTecnica) {
      await dbRun('UPDATE conversations SET mode = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', ['human', conversation.id]);
      emitToClient(clientId, 'conversation:mode_changed', { conversationId: conversation.id, mode: 'human', reason: handoff });
    } else {
      emitToClient(clientId, 'conversation:ai_failed', {
        conversationId: conversation.id, reason: handoff
      });
    }

    await dbRun('INSERT INTO handoff_events (conversation_id, trigger_type, detail) VALUES (?, ?, ?)',
      [conversation.id, fueFallaTecnica ? 'ai_error' : 'auto', handoff]);

    logger.info('Derivación desde webhook de Meta', {
      conversationId: conversation.id, reason: handoff,
      modo: fueFallaTecnica ? 'sigue en bot (falla técnica)' : 'pasa a humano'
    });

    // Se avisa al cliente final para que no quede en silencio esperando: sin
    // esto la derivación se siente como que el negocio dejó de responder.
    // El mensaje también cambia según el motivo: prometerle al cliente que "ya
    // le comunico con una persona" cuando en realidad se cayó Google es
    // mentirle, y además nadie lo va a atender.
    const aviso = fueFallaTecnica
      ? 'Disculpa, tuve un problema para procesar tu mensaje. ¿Me lo puedes repetir?'
      : 'Con gusto te comunico con una persona del equipo. En un momento te responden por acá. 🙌';
    const notice = await metaSend.sendText({
      channelType: msg.channel_type,
      to: msg.end_customer_id,
      text: aviso,
      phoneNumberId: msg.phone_number_id
    });
    if (notice.sent) {
      const noticeMsg = await dbRun(
        'INSERT INTO messages (conversation_id, sender_type, content, external_message_id) VALUES (?, ?, ?, ?)',
        [conversation.id, 'bot', aviso, notice.externalId || null]
      );
      emitToClient(clientId, 'conversation:new_message', {
        id: noticeMsg.id, conversation_id: conversation.id, sender_type: 'bot',
        content: aviso, created_at: new Date().toISOString()
      });
    }
    return;
  }

  // Se despacha ANTES de dar por buena la respuesta, para que el estado real
  // de entrega quede guardado junto al mensaje y visible en la bandeja.
  const dispatch = await metaSend.sendText({
    channelType: msg.channel_type,
    to: msg.end_customer_id,
    text: reply,
    phoneNumberId: msg.phone_number_id
  });

  const botMsg = await dbRun(
    'INSERT INTO messages (conversation_id, sender_type, content, external_message_id) VALUES (?, ?, ?, ?)',
    [conversation.id, 'bot', reply, dispatch.externalId || null]
  );
  await dbRun('UPDATE conversations SET last_message_at = CURRENT_TIMESTAMP WHERE id = ?', [conversation.id]);

  emitToClient(clientId, 'conversation:new_message', {
    id: botMsg.id, conversation_id: conversation.id, sender_type: 'bot', content: reply,
    delivered: dispatch.sent, created_at: new Date().toISOString()
  });

  if (!dispatch.sent) {
    // El dueño tiene que enterarse de que ese mensaje NO llegó, sobre todo si
    // fue por la ventana de 24h — ahí hace falta que él escriba primero.
    emitToClient(clientId, 'conversation:delivery_failed', {
      conversationId: conversation.id,
      messageId: botMsg.id,
      reason: dispatch.error?.reason,
      outsideWindow: !!dispatch.error?.outsideWindow
    });
  }

  logger.info('Respuesta del bot generada y despachada', {
    conversationId: conversation.id, canal: msg.channel_type, entregado: dispatch.sent
  });

  // Memoria del cliente: si el modelo reportó un dato nuevo en esta misma
  // respuesta, se guarda para que la próxima vez (aunque se salga de la
  // ventana de mensajes recientes) el bot lo siga sabiendo.
  if (memoryNote) {
    const notasActualizadas = geminiService.mergeMemoryNote(conversation.customer_notes, memoryNote);
    await dbRun('UPDATE conversations SET customer_notes = ? WHERE id = ?', [notasActualizadas, conversation.id]);
    logger.info('Memoria del cliente actualizada', { conversationId: conversation.id, nota: memoryNote });
  }

  // Después de responder, se revisa si en la conversación quedó un pedido.
  // Va al final y sin await del cliente final a propósito: si esto falla o
  // tarda, el cliente ya recibió su respuesta.
  await syncOrderFromConversation(clientId, conversation, history, incoming, msg);
}

/**
 * Manda un texto fijo (no lo escribe la IA), lo guarda y lo emite en vivo —
 * para el candado de temas restringidos y los atajos de consulta del dueño
 * (pedidos/reservas de hoy), donde la respuesta ya se armó con datos exactos
 * de la base y no tiene sentido pagar por que un modelo la redacte.
 */
async function responderDirecto(clientId, conversation, msg, texto) {
  const envio = await metaSend.sendText({
    channelType: msg.channel_type,
    to: msg.end_customer_id,
    text: texto,
    phoneNumberId: msg.phone_number_id
  });

  const guardado = await dbRun(
    'INSERT INTO messages (conversation_id, sender_type, content, external_message_id) VALUES (?, ?, ?, ?)',
    [conversation.id, 'bot', texto, envio.externalId || null]
  );
  await dbRun('UPDATE conversations SET last_message_at = CURRENT_TIMESTAMP WHERE id = ?', [conversation.id]);

  emitToClient(clientId, 'conversation:new_message', {
    id: guardado.id, conversation_id: conversation.id, sender_type: 'bot',
    content: texto, delivered: envio.sent, created_at: new Date().toISOString()
  });
}

/**
 * Genera y envía el cobro cuando el cliente lo pidió.
 *
 * El mensaje lo redactamos nosotros y no el modelo: la cifra y el enlace tienen
 * que ser exactos. Se manda el enlace y detrás el QR, porque hay gente que
 * desconfía de un link por WhatsApp pero sí escanea un código.
 *
 * @returns {boolean} true si se cobró; false si hay que seguir conversando
 */
async function enviarCobro(clientId, conversation, msg) {
  const cobro = await ventaService.generarCobro(conversation);

  if (!cobro.ok) {
    logger.info('No se generó cobro, sigue la conversación', { motivo: cobro.motivo });
    return false;
  }

  const monto = '$' + Number(cobro.monto).toLocaleString('es-CO');
  const texto =
    `Perfecto. Te dejo el pago del plan ${cobro.plan.name} por ${monto} COP mensuales.\n\n` +
    `${cobro.enlace}\n\n` +
    `Puedes pagar con tarjeta, PSE o Nequi. Cuando lo hagas me llega la confirmación ` +
    `y te contacto para coordinar la instalación.`;

  const envio = await metaSend.sendText({
    channelType: msg.channel_type,
    to: msg.end_customer_id,
    text: texto,
    phoneNumberId: msg.phone_number_id
  });

  const guardado = await dbRun(
    'INSERT INTO messages (conversation_id, sender_type, content, external_message_id) VALUES (?, ?, ?, ?)',
    [conversation.id, 'bot', texto, envio.externalId || null]
  );
  await dbRun('UPDATE conversations SET last_message_at = CURRENT_TIMESTAMP WHERE id = ?', [conversation.id]);

  emitToClient(clientId, 'conversation:new_message', {
    id: guardado.id, conversation_id: conversation.id, sender_type: 'bot',
    content: texto, delivered: envio.sent, created_at: new Date().toISOString()
  });

  // El QR va aparte y no bloquea: si falla, el enlace ya salió y la venta sigue viva.
  metaSend.sendImage({
    channelType: msg.channel_type,
    to: msg.end_customer_id,
    imageUrl: cobro.enlaceQr,
    caption: 'O escanea este código si prefieres',
    phoneNumberId: msg.phone_number_id
  }).catch(() => {});

  emitToClient(clientId, 'conversation:payment_sent', {
    conversationId: conversation.id,
    orderId: cobro.orderId,
    plan: cobro.plan.name,
    monto: cobro.monto
  });

  logger.info('Cobro enviado al cliente', {
    conversationId: conversation.id, orderId: cobro.orderId,
    plan: cobro.plan.name, entregado: envio.sent
  });
  return true;
}

/**
 * Arma o actualiza la orden que la IA detecte en el chat.
 *
 * Mientras el pedido siga en `por_confirmar` se ACTUALIZA en vez de crear otra:
 * un cliente que escribe "y súmame una gaseosa" no debe generar dos órdenes.
 * Una vez que una persona la confirma, deja de tocarse — a partir de ahí lo que
 * pida de más se maneja como orden nueva, que es como funciona una cocina.
 */
async function syncOrderFromConversation(clientId, conversation, history, incoming, msg) {
  try {
    const extracted = await geminiService.extractOrder(clientId, history.slice(0, -1), incoming);
    if (!extracted) return;

    const abierta = await dbGet(
      "SELECT * FROM orders WHERE conversation_id = ? AND status = 'por_confirmar' ORDER BY created_at DESC LIMIT 1",
      [conversation.id]
    );

    const datos = {
      customer_name: extracted.customer_name || conversation.end_customer_name || null,
      customer_phone: extracted.customer_phone || conversation.end_customer_id || null,
      address: extracted.address || null,
      modality: extracted.modality || 'domicilio',
      items: extracted.items || [],
      total: extracted.total || 0,
      notes: extracted.notes || null
    };

    if (abierta) {
      await dbRun(
        `UPDATE orders SET customer_name=?, customer_phone=?, address=?, modality=?,
         items=?, total=?, notes=?, ai_confidence=?, ai_raw=?, updated_at=CURRENT_TIMESTAMP
         WHERE id=?`,
        [datos.customer_name, datos.customer_phone, datos.address, datos.modality,
         JSON.stringify(datos.items), datos.total, datos.notes,
         extracted.confidence || null, extracted.raw || null, abierta.id]
      );
      const actualizada = await dbGet('SELECT * FROM orders WHERE id = ?', [abierta.id]);
      let items = [];
      try { items = JSON.parse(actualizada.items || '[]'); } catch (e) {}
      emitToClient(clientId, 'order:updated', { ...actualizada, items });
      logger.info('Pedido en curso actualizado desde el chat', {
        orderId: abierta.id, conversationId: conversation.id, items: datos.items.length
      });
      return;
    }

    await createOrder(
      {
        ...datos,
        client_id: clientId,
        conversation_id: conversation.id,
        source: 'bot',
        channel_type: msg.channel_type
      },
      null,
      { confidence: extracted.confidence, raw: extracted.raw }
    );
  } catch (error) {
    logger.error('Error sincronizando el pedido desde la conversación', {
      conversationId: conversation.id, error: error.message
    });
  }
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
