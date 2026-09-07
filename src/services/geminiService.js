const axios = require('axios');
const { dbGet, dbRun } = require('../config/database');
const logger = require('../utils/logger');

/**
 * Nodo de IA del flujo (Gemini Flash) — capa A (clientes de MeridianTech) y
 * capa B (MeridianTech como su propio cliente interno) comparten este mismo
 * servicio; lo único que cambia es la configuración cargada por client_id
 * desde `bot_configs` (reglas de negocio y conocimiento previo aislados por
 * negocio, aunque el motor es el mismo para todos).
 *
 * Multimodal nativo: texto, imagen y audio se envían al mismo modelo sin
 * necesidad de un transcriptor separado (Whisper) ni de un servicio de
 * visión aparte — Gemini los procesa directamente.
 */

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemini-3.6-flash';

const isConfigured = () => !!GEMINI_API_KEY;

/**
 * Palabras/frases por defecto que siempre disparan derivación a humano,
 * además de las que cada cliente configure en bot_configs.handoff_keywords.
 */
const DEFAULT_HANDOFF_KEYWORDS = [
  'hablar con una persona', 'hablar con alguien', 'asesor', 'humano',
  'quiero hablar con', 'una persona real', 'no eres una persona',
  'reclamo', 'queja', 'cancelar', 'demanda', 'abogado'
];

const getBotConfig = async (clientId) => {
  const config = await dbGet('SELECT * FROM bot_configs WHERE client_id = ? AND status = ?', [clientId, 'active']);
  if (!config) {
    logger.warn('Sin bot_config para el cliente, usando valores por defecto', { clientId });
    return {
      client_id: clientId,
      ai_model: DEFAULT_MODEL,
      system_prompt: 'Eres un asistente de atención al cliente. Responde de forma breve, clara y amable.',
      business_rules: '{}',
      knowledge_base: '',
      handoff_keywords: '[]',
      max_failed_attempts: 3
    };
  }
  return config;
};

const detectHandoffKeyword = (text, customKeywords = []) => {
  const lower = (text || '').toLowerCase();
  const all = [...DEFAULT_HANDOFF_KEYWORDS, ...customKeywords];
  return all.find(kw => lower.includes(kw.toLowerCase())) || null;
};

const buildSystemInstruction = (config) => {
  let instruction = config.system_prompt || '';

  try {
    const rules = JSON.parse(config.business_rules || '{}');
    if (Object.keys(rules).length) {
      instruction += '\n\nReglas de negocio a respetar siempre:\n' + JSON.stringify(rules, null, 2);
    }
  } catch (e) { /* business_rules mal formado, se ignora */ }

  if (config.knowledge_base) {
    instruction += '\n\nConocimiento previo del negocio (úsalo para responder con precisión, no inventes datos que no estén aquí):\n' + config.knowledge_base;
  }

  instruction += '\n\nSi el cliente pide explícitamente hablar con una persona, muestra frustración clara, o hace una pregunta que no puedes responder con el conocimiento previo, dilo honestamente y no inventes una respuesta.';

  return instruction;
};

/**
 * Convierte el historial de `messages` (bot|owner|end_customer) al formato
 * de turnos que espera la API de Gemini (role: user | model).
 */
const buildContents = (history, newMessagePart) => {
  const contents = history.map(m => ({
    role: m.sender_type === 'end_customer' ? 'user' : 'model',
    parts: [{ text: m.content }]
  }));
  contents.push({ role: 'user', parts: newMessagePart });
  return contents;
};

/**
 * Genera la respuesta del bot para un mensaje entrante.
 *
 * @param {number} clientId
 * @param {Array} conversationHistory - mensajes previos (más antiguo primero)
 * @param {object} incoming - { text, imageBase64, imageMimeType, audioBase64, audioMimeType }
 * @returns {{ handoff: string|null, reply: string|null }}
 *   handoff: motivo de derivación si aplica (y reply será null)
 *   reply: texto de respuesta del bot si no hubo derivación
 */
const generateBotResponse = async (clientId, conversationHistory, incoming) => {
  const config = await getBotConfig(clientId);

  // 1. Derivación por palabra clave (no gasta tokens de IA si ya sabemos que hay que derivar)
  if (incoming.text) {
    let customKeywords = [];
    try { customKeywords = JSON.parse(config.handoff_keywords || '[]'); } catch (e) {}
    const matched = detectHandoffKeyword(incoming.text, customKeywords);
    if (matched) {
      logger.info('Derivación a humano por palabra clave', { clientId, matched });
      return { handoff: `keyword: "${matched}"`, reply: null };
    }
  }

  if (!isConfigured()) {
    logger.warn('GEMINI_API_KEY no configurada — nodo de IA en modo simulación', { clientId });
    return {
      handoff: null,
      reply: '[Simulación — falta configurar GEMINI_API_KEY] Respuesta automática pendiente de activar.'
    };
  }

  // 2. Construir el mensaje multimodal (texto + imagen y/o audio si vienen)
  const newMessagePart = [];
  if (incoming.text) newMessagePart.push({ text: incoming.text });
  if (incoming.imageBase64) {
    newMessagePart.push({ inline_data: { mime_type: incoming.imageMimeType || 'image/jpeg', data: incoming.imageBase64 } });
  }
  if (incoming.audioBase64) {
    newMessagePart.push({ inline_data: { mime_type: incoming.audioMimeType || 'audio/ogg', data: incoming.audioBase64 } });
  }

  const contents = buildContents(conversationHistory, newMessagePart);
  const systemInstruction = { parts: [{ text: buildSystemInstruction(config) }] };

  try {
    const model = config.ai_model || DEFAULT_MODEL;
    const url = `${GEMINI_API_URL}/${model}:generateContent?key=${GEMINI_API_KEY}`;

    const response = await axios.post(url, { contents, systemInstruction }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 20000
    });

    const reply = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!reply) {
      logger.warn('Gemini no devolvió texto utilizable', { clientId, raw: response.data });
      return { handoff: 'sin respuesta del modelo', reply: null };
    }

    logger.info('Respuesta del bot generada', { clientId, model });
    return { handoff: null, reply };
  } catch (error) {
    logger.error('Error llamando a Gemini', { clientId, error: error.response?.data || error.message });
    return { handoff: 'error de IA', reply: null };
  }
};

/**
 * Crea o actualiza la configuración del bot de un cliente.
 */
const upsertBotConfig = async (clientId, data) => {
  const existing = await dbGet('SELECT id FROM bot_configs WHERE client_id = ?', [clientId]);

  const fields = {
    ai_provider: data.ai_provider || 'gemini',
    ai_model: data.ai_model || DEFAULT_MODEL,
    system_prompt: data.system_prompt || '',
    business_rules: JSON.stringify(data.business_rules || {}),
    knowledge_base: data.knowledge_base || '',
    handoff_keywords: JSON.stringify(data.handoff_keywords || []),
    max_failed_attempts: data.max_failed_attempts || 3
  };

  if (existing) {
    await dbRun(
      `UPDATE bot_configs SET ai_provider=?, ai_model=?, system_prompt=?, business_rules=?, knowledge_base=?, handoff_keywords=?, max_failed_attempts=?, updated_at=CURRENT_TIMESTAMP WHERE client_id=?`,
      [fields.ai_provider, fields.ai_model, fields.system_prompt, fields.business_rules, fields.knowledge_base, fields.handoff_keywords, fields.max_failed_attempts, clientId]
    );
    return existing.id;
  }

  const result = await dbRun(
    `INSERT INTO bot_configs (client_id, ai_provider, ai_model, system_prompt, business_rules, knowledge_base, handoff_keywords, max_failed_attempts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [clientId, fields.ai_provider, fields.ai_model, fields.system_prompt, fields.business_rules, fields.knowledge_base, fields.handoff_keywords, fields.max_failed_attempts]
  );
  return result.id;
};

module.exports = {
  isConfigured,
  generateBotResponse,
  getBotConfig,
  upsertBotConfig,
  detectHandoffKeyword
};
