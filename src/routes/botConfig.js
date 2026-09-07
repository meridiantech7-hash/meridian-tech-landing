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
