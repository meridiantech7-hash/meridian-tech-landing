const express = require('express');
const Joi = require('joi');
const { verifyToken, exigirAccesoACliente } = require('../middleware/auth');
const { dbGet } = require('../config/database');
const geminiService = require('../services/geminiService');
const ownerService = require('../services/ownerService');
const logger = require('../utils/logger');

const router = express.Router();

const configSchema = Joi.object({
  ai_provider: Joi.string().valid('gemini').default('gemini'),
  ai_model: Joi.string(),
  system_prompt: Joi.string().allow(''),
  business_rules: Joi.object(),
  knowledge_base: Joi.string().allow(''),
  handoff_keywords: Joi.array().items(Joi.string()),
  max_failed_attempts: Joi.number().integer().min(1).max(10),
  // Minutos que un pedido pagado puede esperar antes de ponerse en alarma en
  // la tablet. Lo decide cada negocio: no es lo mismo un asadero que una
  // pizzería.
  alerta_pedido_minutos: Joi.number().integer().min(1).max(240)
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
router.get('/modelos', verifyToken, async (req, res, next) => {
  try {
    res.json({ success: true, data: await geminiService.listarModelos() });
  } catch (error) {
    next(error);
  }
});

/**
 * Prueba un modelo concreto: /diagnostico?modelo=gemini-flash-latest
 * Sirve para encontrar cuál responde rápido cuando el de siempre se satura.
 */
router.get('/:clientId/diagnostico', verifyToken, async (req, res, next) => {
  try {
    if (!exigirAccesoACliente(req, res, req.params.clientId)) return;
    const config = await geminiService.getBotConfig(req.params.clientId);
    const inicio = Date.now();

    const { handoff, reply } = await geminiService.generateBotResponse(
      req.params.clientId,
      [],
      { text: 'Responde solamente con la palabra: listo' },
      req.query.modelo || null
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
    if (!exigirAccesoACliente(req, res, req.params.clientId)) return;
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
    if (!exigirAccesoACliente(req, res, req.params.clientId)) return;
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

/**
 * POST /api/bot-config/:clientId/ajuste
 *
 * El canal por el que el personal le pide cambios a Meridian escribiendo, en
 * vez de editar a mano el bloque de conocimiento previo.
 *
 * Nace de un problema de uso real: el textarea funcionaba, pero pedirle a
 * alguien en plena hora pico que encuentre la línea del precio de la gaseosa
 * en un bloque de texto largo, sin dañar el resto, es pedirle un trabajo de
 * digitador. Escribir "subió la gaseosa a 4.000" es lo que esa persona
 * haría de todas formas.
 *
 * Reutiliza el mismo motor que ya atiende al dueño por WhatsApp
 * (ownerService.aplicarCambioMenu): una sola forma de aplicar cambios, sin
 * dos comportamientos que se separen con el tiempo.
 */
const ajusteSchema = Joi.object({
  instruccion: Joi.string().min(3).max(1000).required()
});

router.post('/:clientId/ajuste', verifyToken, async (req, res, next) => {
  try {
    if (!exigirAccesoACliente(req, res, req.params.clientId)) return;

    const { error, value } = ajusteSchema.validate(req.body);
    if (error) { error.isJoi = true; throw error; }

    const config = await geminiService.getBotConfig(req.params.clientId);
    const cambio = await ownerService.aplicarCambioMenu(
      req.params.clientId, config, value.instruccion
    );

    if (!cambio.ok) {
      // No es un error del servidor: es que el pedido no se entendió o no se
      // pudo aplicar. Se devuelve 200 con aplicado:false para que la pantalla
      // muestre la explicación como una respuesta más de la conversación.
      return res.json({ success: true, data: { aplicado: false, respuesta: cambio.mensaje } });
    }

    await geminiService.upsertBotConfig(req.params.clientId, {
      knowledge_base: cambio.nuevoConocimiento
    });

    logger.info('Ajuste aplicado desde la terminal', {
      clientId: req.params.clientId,
      userId: req.user.id,
      resumen: cambio.resumen
    });

    res.json({
      success: true,
      data: {
        aplicado: true,
        respuesta: cambio.resumen,
        conocimiento: cambio.nuevoConocimiento
      }
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
