const express = require('express');
const Joi = require('joi');
const { verifyToken } = require('../middleware/auth');
const { dbGet } = require('../config/database');
const geminiService = require('../services/geminiService');
const logger = require('../utils/logger');

const router = express.Router();

const configSchema = Joi.object({
  ai_provider: Joi.string().valid('gemini').default('gemini'),
  ai_model: Joi.string(),
  system_prompt: Joi.string().allow(''),
  business_rules: Joi.object(),
  knowledge_base: Joi.string().allow(''),
  handoff_keywords: Joi.array().items(Joi.string()),
  max_failed_attempts: Joi.number().integer().min(1).max(10)
});

/**
 * GET /api/bot-config/:clientId/diagnostico
 *
 * Mide cuánto tarda Gemini en responder, desde el mismo servidor que atiende a
 * los clientes. Existe porque en producción el bot empezó a agotar el tiempo de
 * espera y desde afuera no hay forma de distinguir tres causas muy distintas:
 * que Google esté lento, que la llave esté mal, o que el prompt del negocio se
 * haya vuelto tan grande que la petición sea pesada.
 *
 * Nunca devuelve la llave: solo el tiempo, el resultado y el tamaño del
 * conocimiento cargado.
 */
router.get('/:clientId/diagnostico', verifyToken, async (req, res, next) => {
  try {
    const config = await geminiService.getBotConfig(req.params.clientId);
    const inicio = Date.now();

    const { handoff, reply } = await geminiService.generateBotResponse(
      req.params.clientId,
      [],
      { text: 'Responde solamente con la palabra: listo' }
    );

    const ms = Date.now() - inicio;
    res.json({
      success: true,
      data: {
        configurada: geminiService.isConfigured(),
        modelo: config.ai_model,
        milisegundos: ms,
        segundos: +(ms / 1000).toFixed(1),
        respondio: !handoff,
        motivo_derivacion: handoff || null,
        respuesta: reply ? reply.slice(0, 120) : null,
        tamano_conocimiento: (config.knowledge_base || '').length,
        tamano_prompt: (config.system_prompt || '').length
      }
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/bot-config/:clientId - Ver configuración del nodo de IA de un cliente
router.get('/:clientId', verifyToken, async (req, res, next) => {
  try {
    const client = await dbGet('SELECT id, name FROM clients WHERE id = ?', [req.params.clientId]);
    if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });

    const config = await geminiService.getBotConfig(req.params.clientId);
    res.json({
      success: true,
      data: {
        ...config,
        business_rules: JSON.parse(config.business_rules || '{}'),
        handoff_keywords: JSON.parse(config.handoff_keywords || '[]'),
        configured: geminiService.isConfigured()
      }
    });
  } catch (error) {
    next(error);
  }
});

// PUT /api/bot-config/:clientId - Crear/actualizar reglas y conocimiento previo
router.put('/:clientId', verifyToken, async (req, res, next) => {
  try {
    const client = await dbGet('SELECT id FROM clients WHERE id = ?', [req.params.clientId]);
    if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });

    const { error, value } = configSchema.validate(req.body);
    if (error) {
      error.isJoi = true;
      throw error;
    }

    await geminiService.upsertBotConfig(req.params.clientId, value);

    logger.info('Configuración del bot actualizada', { clientId: req.params.clientId, userId: req.user.id });
    res.json({ success: true, message: 'Configuración guardada exitosamente' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
