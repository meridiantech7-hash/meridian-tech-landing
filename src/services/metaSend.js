const axios = require('axios');
const logger = require('../utils/logger');

/**
 * Despacho de salida y descarga de adjuntos contra la Graph API de Meta.
 *
 * Cierra el único hueco que quedaba en el flujo: hasta ahora el bot generaba
 * la respuesta y la registraba en la bandeja en vivo, pero nadie la enviaba de
 * vuelta al cliente final. Aquí viven las tres operaciones que lo cierran:
 *
 *  - `sendText`      → responde por el mismo canal por el que entró el mensaje
 *  - `downloadMedia` → baja la imagen/audio para que Gemini lo procese de verdad
 *  - `markAsRead`    → los dos ticks azules, para que el cliente vea que se leyó
 *
 * WhatsApp, Instagram y Messenger usan endpoints distintos, así que el resto
 * del código solo llama a `sendText` con el `channel_type` y no se entera.
 */

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v21.0';
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

const ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID;
// Para IG/Messenger el envío va contra la página; `me` resuelve al dueño del
// token, que es lo correcto cuando se usa un token de página o de system user.
const PAGE_ID = process.env.META_PAGE_ID || 'me';

// Gemini acepta adjuntos en línea hasta ~20MB de request; se corta antes para
// no armar una petición que el modelo va a rechazar de todas formas.
const MAX_MEDIA_BYTES = 12 * 1024 * 1024;

const isConfigured = () => !!ACCESS_TOKEN;

const auth = () => ({ Authorization: `Bearer ${ACCESS_TOKEN}` });

/**
 * Traduce los errores de Meta a algo accionable en los logs.
 *
 * El caso que SIEMPRE aparece en producción es el 131047: WhatsApp solo permite
 * texto libre dentro de las 24h siguientes al último mensaje del cliente. Pasado
 * ese lapso hay que usar una plantilla aprobada. Se distingue explícitamente
 * porque no es un bug del código sino una regla de la plataforma, y el dueño del
 * negocio necesita saber que ese mensaje no salió.
 */
const describeError = (error) => {
  const err = error.response?.data?.error;
  if (!err) return { code: null, reason: error.message, outsideWindow: false };
  const outsideWindow = err.code === 131047 || /24 hours|outside.*window/i.test(err.message || '');
  return {
    code: err.code,
    subcode: err.error_subcode,
    reason: err.message,
    outsideWindow
  };
};

/**
 * Envía un texto al cliente final por el canal correspondiente.
 * @returns {{ sent: boolean, externalId?: string, error?: object }}
 */
const sendText = async ({ channelType, to, text, phoneNumberId }) => {
  if (!isConfigured()) {
    logger.warn('META_ACCESS_TOKEN no configurado — la respuesta queda registrada pero NO se envía', { channelType });
    return { sent: false, error: { reason: 'META_ACCESS_TOKEN no configurado' } };
  }
  if (!text) return { sent: false, error: { reason: 'texto vacío' } };

  try {
    let url;
    let payload;

    if (channelType === 'whatsapp') {
      const numberId = phoneNumberId || PHONE_NUMBER_ID;
      if (!numberId) {
        return { sent: false, error: { reason: 'META_PHONE_NUMBER_ID no configurado' } };
      }
      url = `${GRAPH}/${numberId}/messages`;
      payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: { preview_url: false, body: text }
      };
    } else {
      // Instagram y Messenger comparten la Send API de la plataforma Messenger
      url = `${GRAPH}/${PAGE_ID}/messages`;
      payload = {
        recipient: { id: to },
        message: { text },
        messaging_type: 'RESPONSE'
      };
    }

    const response = await axios.post(url, payload, { headers: auth(), timeout: 15000 });
    const externalId = response.data?.messages?.[0]?.id || response.data?.message_id || null;

    logger.info('Mensaje despachado a Meta', { channelType, to, externalId });
    return { sent: true, externalId };
  } catch (error) {
    const detail = describeError(error);
    if (detail.outsideWindow) {
      logger.warn('Mensaje NO enviado: fuera de la ventana de 24h de WhatsApp (requiere plantilla aprobada)', {
        channelType, to, ...detail
      });
    } else {
      logger.error('Error despachando mensaje a Meta', { channelType, to, ...detail });
    }
    return { sent: false, error: detail };
  }
};

/**
 * Marca el mensaje entrante como leído (solo WhatsApp lo soporta).
 * Es cosmético pero cambia la percepción: el cliente ve que su mensaje llegó
 * aunque el dueño haya tomado el control y tarde en contestar.
 */
const markAsRead = async (messageId, phoneNumberId) => {
  if (!isConfigured() || !messageId) return false;
  const numberId = phoneNumberId || PHONE_NUMBER_ID;
  if (!numberId) return false;

  try {
    await axios.post(
      `${GRAPH}/${numberId}/messages`,
      { messaging_product: 'whatsapp', status: 'read', message_id: messageId },
      { headers: auth(), timeout: 8000 }
    );
    return true;
  } catch (error) {
    // No es crítico: si falla, el flujo sigue igual
    logger.debug('No se pudo marcar como leído', { messageId, ...describeError(error) });
    return false;
  }
};

/**
 * Baja un adjunto de WhatsApp. Son dos pasos: primero el media id se resuelve
 * a una URL temporal, y esa URL exige el mismo token en el header (no es pública).
 * @returns {{ base64: string, mimeType: string }|null}
 */
const downloadWhatsAppMedia = async (mediaId) => {
  if (!isConfigured() || !mediaId) return null;

  try {
    const meta = await axios.get(`${GRAPH}/${mediaId}`, { headers: auth(), timeout: 10000 });
    const { url, mime_type: mimeType, file_size: fileSize } = meta.data || {};
    if (!url) return null;

    if (fileSize && fileSize > MAX_MEDIA_BYTES) {
      logger.warn('Adjunto demasiado grande, se omite', { mediaId, fileSize });
      return null;
    }

    const bin = await axios.get(url, {
      headers: auth(),
      responseType: 'arraybuffer',
      timeout: 25000,
      maxContentLength: MAX_MEDIA_BYTES
    });

    return { base64: Buffer.from(bin.data).toString('base64'), mimeType: mimeType || 'application/octet-stream' };
  } catch (error) {
    logger.error('Error bajando adjunto de WhatsApp', { mediaId, ...describeError(error) });
    return null;
  }
};

/**
 * Baja un adjunto de Instagram/Messenger, que llegan como URL firmada y
 * temporal en el propio webhook (no hace falta resolver un media id).
 */
const downloadFromUrl = async (mediaUrl) => {
  if (!mediaUrl) return null;
  try {
    const bin = await axios.get(mediaUrl, {
      responseType: 'arraybuffer',
      timeout: 25000,
      maxContentLength: MAX_MEDIA_BYTES
    });
    return {
      base64: Buffer.from(bin.data).toString('base64'),
      mimeType: bin.headers['content-type'] || 'application/octet-stream'
    };
  } catch (error) {
    logger.error('Error bajando adjunto por URL', { mediaUrl, reason: error.message });
    return null;
  }
};

module.exports = {
  isConfigured,
  sendText,
  markAsRead,
  downloadWhatsAppMedia,
  downloadFromUrl,
  GRAPH_VERSION
};
