const axios = require('axios');
const crypto = require('crypto');
const logger = require('../utils/logger');

/**
 * Integración con la API de Bold — "Pagos en línea" (Link de Pagos), que es
 * el producto que este comercio (WQO5MEMRNS) tiene habilitado. NO es el
 * "Botón de Pagos": ese es un producto distinto, con su propio widget de
 * navegador y firma de integridad, y usarlo contra una cuenta habilitada
 * para Link de Pagos es lo que causaba el error al pagar.
 *
 * Contrato real (confirmado contra developers.bold.co, no adivinado):
 *
 *   POST https://integrations.api.bold.co/online/link/v1
 *   Authorization: x-api-key <BOLD_API_KEY>
 *   { amount_type: "CLOSE", amount: { currency, total_amount }, reference, description }
 *   → { payload: { payment_link: "LNK_...", url: "https://checkout.bold.co/LNK_..." }, errors: [] }
 *
 * No existe un campo "order_id"/"metadata" en la creación — el identificador
 * propio viaja en `reference`, y Bold lo devuelve tal cual en
 * `data.metadata.reference` del webhook. Por eso `reference` es justo el
 * `orderId` que ya generábamos.
 */

const BOLD_API_KEY = process.env.BOLD_API_KEY;
const BOLD_WEBHOOK_SECRET = process.env.BOLD_WEBHOOK_SECRET;
const BOLD_LINKS_URL = 'https://integrations.api.bold.co/online/link/v1';

const isConfigured = () => !!BOLD_API_KEY;

/**
 * Genera un orderId único para la transacción — se usa como `reference` en
 * el link de pago (alfanumérico + guiones, cabe en el límite de 60 de Bold).
 */
const generateOrderId = (clientId, planId) => {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `MER-${clientId}-${planId}-${timestamp}-${random}`;
};

/**
 * Crea un link de pago real. Devuelve `{ ok:true, url, paymentLink }` o
 * `{ ok:false, motivo }` — nunca lanza, para que quien llama decida qué
 * decirle al cliente en vez de que se caiga toda la conversación.
 */
const crearLinkDePago = async ({ reference, amount, currency = 'COP', description, callbackUrl }) => {
  if (!isConfigured()) {
    logger.warn('Bold API no configurada — no se puede generar el link de pago');
    return { ok: false, motivo: 'Bold no está configurado (falta BOLD_API_KEY)' };
  }

  try {
    const body = {
      amount_type: 'CLOSE',
      amount: { currency, total_amount: Math.round(amount) },
      reference,
      description: (description || '').slice(0, 100)
    };
    if (callbackUrl) body.callback_url = callbackUrl;

    const { data } = await axios.post(BOLD_LINKS_URL, body, {
      headers: {
        Authorization: `x-api-key ${BOLD_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 15000
    });

    if (data.errors?.length) {
      const motivo = data.errors.map((e) => e.message || e.description || JSON.stringify(e)).join('; ');
      logger.warn('Bold rechazó la creación del link de pago', { reference, motivo });
      return { ok: false, motivo };
    }

    const { payment_link, url } = data.payload || {};
    if (!url) {
      logger.error('Bold respondió sin URL de pago', { reference, data });
      return { ok: false, motivo: 'Bold no devolvió una URL de pago' };
    }

    logger.info('Link de pago de Bold creado', { reference, paymentLink: payment_link });
    return { ok: true, paymentLink: payment_link, url };
  } catch (error) {
    logger.error('Fallo llamando a la API de Bold', {
      reference, error: error.response?.data || error.message
    });
    return { ok: false, motivo: 'No se pudo conectar con Bold en este momento' };
  }
};

/**
 * Verifica la firma `x-bold-signature` de un webhook entrante.
 *
 * Algoritmo real de Bold: HMAC-SHA256 sobre el cuerpo crudo codificado en
 * Base64 (no sobre el JSON re-serializado — el orden de llaves o un espacio
 * de más ya no coincidirían con lo que Bold firmó). `rawBody` debe ser el
 * Buffer/string tal como llegó, capturado por el `verify` de express.json.
 */
const verifyWebhookSignature = (rawBody, signature) => {
  if (!BOLD_WEBHOOK_SECRET) {
    logger.warn('BOLD_WEBHOOK_SECRET no configurado - webhook no verificado');
    return false;
  }
  if (!signature || !rawBody) return false;

  const base64Body = Buffer.from(rawBody).toString('base64');
  const expected = crypto
    .createHmac('sha256', BOLD_WEBHOOK_SECRET)
    .update(base64Body)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch (e) {
    return false;
  }
};

module.exports = {
  isConfigured,
  generateOrderId,
  crearLinkDePago,
  verifyWebhookSignature
};
