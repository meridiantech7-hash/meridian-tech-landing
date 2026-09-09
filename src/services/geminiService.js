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
 * Distingue un fallo pasajero de uno real.
 *
 * Gemini responde "This model is currently experiencing high demand" y agota el
 * tiempo de espera en horas pico. Sin reintento, cada uno de esos picos derivaba
 * la conversación a un humano como si el cliente hubiera pedido hablar con
 * alguien — el dueño recibe una alerta falsa y el cliente queda esperando.
 */
const esFalloPasajero = (error) => {
  if (error.code === 'ECONNABORTED' || /timeout/i.test(error.message || '')) return true;
  const status = error.response?.status;
  if (status === 429 || (status >= 500 && status < 600)) return true;
  const msg = error.response?.data?.error?.message || '';
  return /high demand|overloaded|try again later|unavailable/i.test(msg);
};

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Llama a Gemini reintentando solo los fallos pasajeros. Dos intentos como
 * máximo: más que eso y el cliente percibe la demora, que es peor que derivar.
 */
// 28s por intento: en producción `gemini-3.6-flash` pasó de 20s varias veces
// bajo carga y el bot derivaba a un humano por nada. Dos intentos de 28s dejan
// el peor caso en ~57s, que es mucho pero sigue siendo mejor que una derivación
// falsa — y solo ocurre cuando Google está saturado de verdad.
const llamarGemini = async (url, payload, timeout = 28000) => {
  let ultimo;
  for (let intento = 1; intento <= 2; intento++) {
    try {
      return await axios.post(url, payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout
      });
    } catch (error) {
      ultimo = error;
      if (intento === 2 || !esFalloPasajero(error)) throw error;
      logger.warn('Gemini saturado, reintentando una vez', {
        intento, motivo: error.response?.data?.error?.message || error.message
      });
      await esperar(1200);
    }
  }
  throw ultimo;
};

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

    const response = await llamarGemini(url, { contents, systemInstruction });

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
 * Lee la conversación y arma una orden estructurada, si es que hay una.
 *
 * Va en una llamada aparte de la respuesta al cliente y a propósito: obligar al
 * mismo turno a producir texto conversacional Y JSON estricto degrada las dos
 * cosas. Aquí se usa `responseMimeType: application/json` con esquema, así que
 * el modelo no puede devolver prosa ni ```json``` alrededor.
 *
 * Devuelve `null` cuando no hay pedido — que es el caso más común (saludos,
 * preguntas por precios, quejas). El que llama NO debe crear nada si es null.
 *
 * @returns {{items, customer_name, customer_phone, address, modality, total, notes, confidence}|null}
 */
const extractOrder = async (clientId, conversationHistory, incoming) => {
  if (!isConfigured()) return null;

  const config = await getBotConfig(clientId);

  const transcript = [...conversationHistory, { sender_type: 'end_customer', content: incoming.text || '' }]
    .filter(m => m.content)
    .map(m => `${m.sender_type === 'end_customer' ? 'CLIENTE' : 'NEGOCIO'}: ${m.content}`)
    .join('\n');

  if (!transcript.trim()) return null;

  const instruction = `Eres un extractor de pedidos. Lee la conversación y decide si el CLIENTE ya pidió algo concreto.

REGLAS ESTRICTAS:
- Si el cliente solo saluda, pregunta precios, horarios o se queja SIN pedir, devuelve has_order=false.
- Solo devuelve has_order=true cuando hay al menos un producto con cantidad clara.
- NO inventes productos, precios, direcciones ni teléfonos que no estén en la conversación.
- Si un dato no aparece, déjalo vacío. Es mejor vacío que inventado.
- confidence: "alta" si todo está explícito; "media" si dedujiste algo; "baja" si dudas.
- modality: "domicilio" si pidió envío, "recoger" si pasa por él, "mesa" si come ahí. Si no se sabe, "domicilio".
- total: suma en pesos colombianos, sin puntos ni decimales. Si no hay precios, 0.

${config.knowledge_base ? 'CATÁLOGO Y PRECIOS DEL NEGOCIO (úsalo para nombres y precios exactos):\n' + config.knowledge_base : ''}`;

  const schema = {
    type: 'OBJECT',
    properties: {
      has_order: { type: 'BOOLEAN' },
      confidence: { type: 'STRING', enum: ['alta', 'media', 'baja'] },
      customer_name: { type: 'STRING' },
      customer_phone: { type: 'STRING' },
      address: { type: 'STRING' },
      modality: { type: 'STRING', enum: ['domicilio', 'recoger', 'mesa'] },
      notes: { type: 'STRING' },
      total: { type: 'INTEGER' },
      items: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            nombre: { type: 'STRING' },
            cantidad: { type: 'INTEGER' },
            precio: { type: 'INTEGER' },
            notas: { type: 'STRING' }
          },
          required: ['nombre', 'cantidad']
        }
      }
    },
    required: ['has_order', 'confidence', 'items']
  };

  try {
    const model = config.ai_model || DEFAULT_MODEL;
    const url = `${GEMINI_API_URL}/${model}:generateContent?key=${GEMINI_API_KEY}`;

    const response = await llamarGemini(url, {
      systemInstruction: { parts: [{ text: instruction }] },
      contents: [{ role: 'user', parts: [{ text: transcript }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: schema,
        temperature: 0
      }
    });

    const raw = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    if (!parsed.has_order || !Array.isArray(parsed.items) || parsed.items.length === 0) {
      return null;
    }

    logger.info('La IA detectó un pedido en la conversación', {
      clientId, items: parsed.items.length, confianza: parsed.confidence
    });
    return { ...parsed, raw };
  } catch (error) {
    // Que falle la extracción NUNCA debe tumbar la respuesta al cliente: el bot
    // ya contestó, esto es un extra. Se registra y se sigue.
    logger.warn('No se pudo extraer el pedido de la conversación', {
      clientId, error: error.response?.data?.error?.message || error.message
    });
    return null;
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
  extractOrder,
  getBotConfig,
  upsertBotConfig,
  detectHandoffKeyword
};
