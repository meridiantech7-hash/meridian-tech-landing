const crypto = require('crypto');
const logger = require('../utils/logger');

/**
 * Servicio de integración con Bold.co
 *
 * Bold usa un "botón de pagos" basado en un hash de integridad
 * generado con la llave secreta. El flujo es:
 * 1. El backend genera un orderId único y calcula el hash de integridad
 * 2. El frontend usa el script de Bold con esos datos para abrir el checkout
 * 3. Bold redirige/webhookea de vuelta con la confirmación
 *
 * Documentación: https://developers.bold.co
 */

const BOLD_API_KEY = process.env.BOLD_API_KEY;
const BOLD_SECRET_KEY = process.env.BOLD_SECRET_KEY;
const BOLD_MERCHANT_ID = process.env.BOLD_MERCHANT_ID;

const isConfigured = () => {
  return !!(BOLD_API_KEY && BOLD_SECRET_KEY);
};

/**
 * Genera el hash de integridad requerido por Bold para el botón de pagos.
 * Fórmula: SHA256(orderId + amount + currency + secretKey)
 */
const generateIntegritySignature = (orderId, amount, currency = 'COP') => {
  if (!BOLD_SECRET_KEY) {
    throw { statusCode: 500, message: 'Bold API no está configurada (falta BOLD_SECRET_KEY)' };
  }

  const chain = `${orderId}${amount}${currency}${BOLD_SECRET_KEY}`;
  return crypto.createHash('sha256').update(chain).digest('hex');
};

/**
 * Genera un orderId único para la transacción
 */
const generateOrderId = (clientId, planId) => {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `MER-${clientId}-${planId}-${timestamp}-${random}`;
};

/**
 * Prepara los datos necesarios para el botón de pago de Bold
 */
const createPaymentIntent = (orderId, amount, description, currency = 'COP') => {
  if (!isConfigured()) {
    logger.warn('Bold API no configurada - usando modo simulación');
  }

  const signature = isConfigured()
    ? generateIntegritySignature(orderId, amount, currency)
    : null;

  return {
    orderId,
    amount,
    currency,
    description,
    apiKey: BOLD_API_KEY || null,
    merchantId: BOLD_MERCHANT_ID,
    integritySignature: signature,
    configured: isConfigured()
  };
};

/**
 * Verifica la firma de un webhook entrante de Bold
 */
const verifyWebhookSignature = (payload, signature) => {
  if (!process.env.BOLD_WEBHOOK_SECRET) {
    logger.warn('BOLD_WEBHOOK_SECRET no configurado - webhook no verificado');
    return false;
  }

  const expectedSignature = crypto
    .createHmac('sha256', process.env.BOLD_WEBHOOK_SECRET)
    .update(JSON.stringify(payload))
    .digest('hex');

  return signature === expectedSignature;
};

module.exports = {
  isConfigured,
  generateOrderId,
  generateIntegritySignature,
  createPaymentIntent,
  verifyWebhookSignature
};
