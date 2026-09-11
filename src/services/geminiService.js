const axios = require('axios');
const { dbGet, dbRun } = require('../config/database');
const logger = require('../utils/logger');
const planService = require('./planService');

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
/**
 * Modelo por defecto, elegido midiendo y no por intuición. Latencias reales
 * contra esta misma llave, respondiendo lo mismo:
 *
 *   gemini-3.5-flash-lite     0.8 s   ← elegido
 *   gemini-flash-lite-latest  0.7 s   (alias móvil; se evita para que el
 *                                      comportamiento no cambie solo)
 *   gemini-3.6-flash          7.6 s   + 503 por saturación en horas pico
 *   gemini-3.5-flash          9.5 s
 *   gemini-2.5-flash          no disponible para esta llave
 *
 * Para atender WhatsApp con un catálogo cargado, la diferencia entre 0.8 s y
 * 8 s decide si el cliente sigue ahí. Un modelo "lite" alcanza de sobra para
 * responder con información que ya está en el prompt.
 */
const DEFAULT_MODEL = 'gemini-3.5-flash-lite';

/**
 * Si el modelo principal se cae o se satura, se intenta con estos antes de
 * derivar a un humano. Van de más rápido a más capaz.
 */
const MODELOS_RESPALDO = ['gemini-3.6-flash', 'gemini-3.5-flash'];

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
 * Configuración de generación para atención al cliente.
 *
 * `thinkingBudget: 0` es la clave del asunto. Los modelos Gemini recientes
 * razonan antes de responder, y ese razonamiento puede tardar decenas de
 * segundos. En producción se vio exactamente eso: peticiones de ~310 tokens
 * agotando 28 segundos de espera. Para contestar "¿cuánto vale el plan
 * básico?" con un catálogo cargado no hace falta deliberar: hace falta
 * responder rápido.
 *
 * `maxOutputTokens` acota la respuesta. Sin tope, el modelo puede irse por las
 * ramas y el cliente termina leyendo tres párrafos en WhatsApp — y cada token
 * de más que genera se paga. El guion de venta (seedInternal.js) pide "2 a 4
 * líneas", que en español ronda 60-90 tokens; 300 deja margen de sobra sin
 * dejar la puerta abierta a una respuesta de tres párrafos.
 */
const GENERACION = {
  temperature: 0.7,
  maxOutputTokens: 300,
  thinkingConfig: { thinkingBudget: 0 }
};

/** Quita thinkingConfig por si el modelo en uso no lo soporta. */
const sinPensamiento = (payload) => {
  const copia = JSON.parse(JSON.stringify(payload));
  if (copia.generationConfig) delete copia.generationConfig.thinkingConfig;
  return copia;
};

/**
 * ¿Conviene reintentar sin thinkingConfig?
 *
 * Cualquier 400 basta como señal. Gemini devuelve un escueto "Request contains
 * an invalid argument" sin decir cuál, así que buscar la palabra "thinking" en
 * el mensaje no sirve de nada: si nosotros mandamos ese campo y la API rechazó
 * la petición, ese campo es el primer sospechoso. Peor caso, se reintenta una
 * vez de más y falla igual; mejor caso, el cliente recibe su respuesta.
 */
const rechazaPensamiento = (error) => error.response?.status === 400;

/**
 * Llama a Gemini reintentando solo los fallos pasajeros. Dos intentos como
 * máximo: más que eso y el cliente percibe la demora, que es peor que derivar.
 */
const llamarGemini = async (url, payload, timeout = 20000) => {
  let cuerpo = payload;
  let ultimo;

  for (let intento = 1; intento <= 2; intento++) {
    try {
      return await axios.post(url, cuerpo, {
        headers: { 'Content-Type': 'application/json' },
        timeout
      });
    } catch (error) {
      ultimo = error;

      // Si este modelo no entiende thinkingConfig, se reintenta sin él en vez
      // de dejar al cliente sin respuesta por un detalle de compatibilidad.
      if (rechazaPensamiento(error) && cuerpo.generationConfig?.thinkingConfig) {
        logger.warn('El modelo no acepta thinkingConfig, reintentando sin él');
        cuerpo = sinPensamiento(cuerpo);
        continue;
      }

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
//
// Solo frases INEQUÍVOCAS. Antes estaban sueltas "asesor", "humano",
// "cancelar" o "una persona real", y en producción callaban al bot en medio
// de una venta: "¿eres humana?" o "¿me cancela el pedido?" no son pedidos de
// hablar con alguien, y la conversación quedaba muda para siempre.
const DEFAULT_HANDOFF_KEYWORDS = [
  'hablar con una persona', 'hablar con alguien del equipo', 'hablar con un asesor',
  'pásame con', 'pasame con', 'comunícame con', 'comunicame con',
  'quiero poner una queja', 'quiero poner un reclamo', 'demanda', 'abogado'
];

/**
 * Condiciones maestras de conversación, para TODOS los negocios, encima del
 * guion de cada uno. Nacen de las fallas vistas en producción: el agente
 * repetía la misma idea, volvía a saludar, reiniciaba el discurso de venta y
 * no contestaba lo que el cliente acababa de preguntar.
 */
const CONDICIONES_MAESTRAS = `CONDICIONES MAESTRAS DE CONVERSACIÓN (están por encima de todo lo demás)
1. Contesta primero, y de forma directa, lo que el cliente dijo en su ÚLTIMO mensaje. Si hizo dos preguntas, responde las dos.
2. Lee todo el historial antes de escribir. Nunca repitas una frase, una idea, una pregunta o un dato que ya dijiste en esta conversación. Si necesitas retomar algo, dilo con otras palabras y en una sola línea.
3. Nunca vuelvas a preguntar algo que el cliente ya respondió o que está en la memoria.
4. Saluda una sola vez en toda la conversación. Si ya hubo mensajes, entra directo al tema.
5. Avanza siempre un paso: cada respuesta debe aportar algo nuevo (un dato, una solución, una propuesta concreta). Nunca reinicies la presentación.
6. Si el cliente responde corto ("ok", "listo", "gracias", "ya"), confirma en una línea y propón el siguiente paso sin repetir lo anterior.
7. Si no entiendes el mensaje, pide una aclaración concreta en una línea. No adivines ni cambies de tema.
8. Si el cliente está molesto: primero reconoce su molestia en una frase, luego resuelve. Sin excusas largas.
9. Máximo dos intentos de cierre por conversación. Si el cliente no quiere, respeta y deja la puerta abierta.
10. Si el cliente repite su pregunta, es porque tu respuesta no le sirvió: responde distinto, más concreto.`;

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
      max_failed_attempts: 3,
      takes_orders: 1
    };
  }
  return config;
};

const detectHandoffKeyword = (text, customKeywords = []) => {
  const lower = (text || '').toLowerCase();
  const all = [...DEFAULT_HANDOFF_KEYWORDS, ...customKeywords];
  return all.find(kw => lower.includes(kw.toLowerCase())) || null;
};

/**
 * Marca con la que el modelo reporta, en su propia respuesta, un dato nuevo
 * de memoria — ver `extraerMemoria` más abajo.
 */
const ETIQUETA_MEMORIA = /\n?MEMORIA:\s*(.+?)\s*$/is;

/**
 * "Memoria" del cliente = lo mínimo para que suene como alguien que ya lo
 * conoce, sin gastar una llamada de IA aparte: se arma con lo que ya sabemos
 * gratis (nombre, `customer_notes` acumulado) y se le pide al mismo modelo
 * que, en la misma respuesta que ya le iba a dar al cliente, reporte al final
 * cualquier dato nuevo que haya aprendido — una única línea que el servidor
 * recorta antes de despachar el mensaje (ver `extraerMemoria`).
 */
const buildSystemInstruction = async (config, memoria = {}) => {
  let instruction = CONDICIONES_MAESTRAS + '\n\n' + (config.system_prompt || '');

  // Plan Premium: el bot también actúa como agente de ventas/marketing de
  // cara al cliente final, no solo en los reportes que pide el dueño — ver
  // reportService.js para esos. Se busca el plan activo del negocio (no del
  // cliente final) — es info interna, nunca se le dice al cliente qué plan
  // tiene contratado su vendedor.
  if (config.client_id) {
    try {
      const plan = await planService.getPlanActivo(config.client_id);
      if (plan?.name === 'Premium') {
        instruction += '\n\nEste negocio contrató el nivel de asesoría más alto: cuando la conversación lo amerite con naturalidad, puedes sugerir ideas de venta cruzada, promociones o mejoras para atraer más clientes — como lo haría un asesor de ventas, no un vendedor insistente. Nunca lo fuerces ni lo menciones si no viene al caso.';
      }
    } catch (e) {
      logger.warn('No se pudo leer el plan activo para la personalidad del bot', { clientId: config.client_id, error: e.message });
    }
  }

  try {
    const rules = JSON.parse(config.business_rules || '{}');
    if (Object.keys(rules).length) {
      instruction += '\n\nReglas de negocio a respetar siempre:\n' + JSON.stringify(rules, null, 2);
    }
  } catch (e) { /* business_rules mal formado, se ignora */ }

  if (config.knowledge_base) {
    instruction += '\n\nConocimiento previo del negocio (úsalo para responder con precisión, no inventes datos que no estén aquí):\n' + config.knowledge_base;
  }

  if (memoria.customerNotes) {
    instruction += `\n\nMEMORIA QUE YA TIENES DE ESTE CLIENTE (ya se conocen — suena familiar, no repitas preguntas que esto ya responde, no lo saludes como si fuera la primera vez):\n${memoria.customerNotes}`;
  }

  instruction += '\n\nSi el cliente pide explícitamente hablar con una persona, muestra frustración clara, o hace una pregunta que no puedes responder con el conocimiento previo, dilo honestamente y no inventes una respuesta.';

  instruction += '\n\nDespués de tu respuesta al cliente, si en ESTE mensaje aprendiste algo nuevo y útil de él (su nombre, su tipo de negocio, una preferencia, algo importante que contó), agrega una línea aparte al final que empiece exactamente con "MEMORIA:" seguida del dato en máximo 12 palabras. Si no aprendiste nada nuevo, no agregues esa línea. Es solo para el sistema — el cliente jamás la ve, así que nunca la menciones ni te disculpes por ella.';

  return instruction;
};

/**
 * Separa la línea "MEMORIA: ..." (si el modelo la agregó) del texto que sí
 * debe llegarle al cliente. Se aplica siempre, aunque el modelo no la haya
 * usado — así un despiste del modelo nunca deja esa etiqueta filtrarse a
 * WhatsApp.
 */
const extraerMemoria = (textoCrudo) => {
  const texto = textoCrudo || '';
  const match = texto.match(ETIQUETA_MEMORIA);
  if (!match) return { reply: texto.trim(), nota: null };

  const nota = match[1].trim().replace(/^["']|["']$/g, '');
  const reply = texto.slice(0, match.index).trim();
  return { reply: reply || texto.trim(), nota: nota && nota !== '-' ? nota : null };
};

/**
 * Suma una nota nueva a la memoria ya acumulada de un cliente, sin dejarla
 * crecer para siempre ni repetir lo mismo dos veces.
 */
const MEMORIA_MAX_NOTAS = 8;
const mergeMemoryNote = (notasExistentes, notaNueva) => {
  if (!notaNueva) return notasExistentes || null;

  const lista = (notasExistentes || '')
    .split('\n')
    .map((n) => n.trim())
    .filter(Boolean);

  const yaEstaba = lista.some((n) => n.toLowerCase() === notaNueva.toLowerCase());
  if (yaEstaba) return notasExistentes;

  lista.push(notaNueva);
  // Las más viejas se descartan primero: lo más útil suele ser lo reciente.
  return lista.slice(-MEMORIA_MAX_NOTAS).join('\n');
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
/**
 * Lista los modelos que la llave puede usar, con su ventana de contexto.
 * Sirve para elegir a cuál cambiarse cuando el de siempre se satura, en vez de
 * adivinar nombres.
 */
const listarModelos = async () => {
  if (!isConfigured()) return { configurada: false, modelos: [] };
  const { data } = await axios.get(
    `${GEMINI_API_URL}?key=${GEMINI_API_KEY}&pageSize=100`,
    { timeout: 15000 }
  );
  const modelos = (data.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => ({
      nombre: m.name.replace('models/', ''),
      entrada: m.inputTokenLimit,
      salida: m.outputTokenLimit
    }));
  return { configurada: true, total: modelos.length, modelos };
};

const generateBotResponse = async (clientId, conversationHistory, incoming, modeloForzado = null, memoria = {}) => {
  const config = await getBotConfig(clientId);

  // 1. Derivación por palabra clave (no gasta tokens de IA si ya sabemos que hay que derivar)
  if (incoming.text) {
    let customKeywords = [];
    try { customKeywords = JSON.parse(config.handoff_keywords || '[]'); } catch (e) {}
    const matched = detectHandoffKeyword(incoming.text, customKeywords);
    if (matched) {
      logger.info('Derivación a humano por palabra clave', { clientId, matched });
      return { handoff: `keyword: "${matched}"`, reply: null, memoryNote: null };
    }
  }

  if (!isConfigured()) {
    logger.warn('GEMINI_API_KEY no configurada — nodo de IA en modo simulación', { clientId });
    return {
      handoff: null,
      reply: '[Simulación — falta configurar GEMINI_API_KEY] Respuesta automática pendiente de activar.',
      memoryNote: null
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
  const systemInstruction = { parts: [{ text: await buildSystemInstruction(config, memoria) }] };

  // Cuando se fuerza un modelo (diagnóstico) se prueba solo ese, para que la
  // medición sea del modelo pedido y no de un respaldo.
  const principal = modeloForzado || config.ai_model || DEFAULT_MODEL;
  const aProbar = modeloForzado
    ? [principal]
    : [principal, ...MODELOS_RESPALDO.filter((m) => m !== principal)];

  let ultimoError;

  for (const model of aProbar) {
    try {
      const url = `${GEMINI_API_URL}/${model}:generateContent?key=${GEMINI_API_KEY}`;
      const response = await llamarGemini(url, {
        contents,
        systemInstruction,
        generationConfig: GENERACION
      });

      const crudo = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!crudo) {
        logger.warn('Gemini no devolvió texto utilizable', { clientId, model });
        ultimoError = new Error('sin texto');
        continue;
      }

      const { reply, nota } = extraerMemoria(crudo);
      if (!reply) {
        // El modelo respondió solo con la línea de memoria y nada para el
        // cliente — pasa a probar el siguiente modelo en vez de mandar vacío.
        logger.warn('Gemini no devolvió texto para el cliente tras quitar la memoria', { clientId, model });
        ultimoError = new Error('sin texto');
        continue;
      }

      if (model !== principal) {
        logger.warn('Respondió un modelo de respaldo', { clientId, principal, model });
      } else {
        logger.info('Respuesta del bot generada', { clientId, model, memoriaNueva: !!nota });
      }
      return { handoff: null, reply, memoryNote: nota };
    } catch (error) {
      ultimoError = error;
      logger.warn('Modelo falló, probando el siguiente si queda', {
        clientId, model, motivo: error.response?.data?.error?.message || error.message
      });
    }
  }

  // Agotados todos: derivar a un humano es preferible a inventar una respuesta.
  logger.error('Ningún modelo de Gemini respondió', {
    clientId,
    probados: aProbar,
    error: ultimoError?.response?.data || ultimoError?.message
  });
  return { handoff: 'error de IA', reply: null, memoryNote: null };
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

  // Bifurcación antes de gastar tokens: si el negocio no toma pedidos (venta
  // consultiva, capa B, soporte, etc.), esta llamada completa a Gemini nunca
  // iba a encontrar nada — se estaba pagando por una extracción imposible en
  // cada mensaje de cada conversación. Por defecto sigue en 1 (true) para no
  // tocar a nadie que ya dependa de esto (restaurantes, capa A).
  if (!Number(config.takes_orders)) return null;

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
        temperature: 0,
        maxOutputTokens: 800,
        thinkingConfig: { thinkingBudget: 0 }
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
 *
 * Actualización PARCIAL a propósito: un campo que el que llama no menciona
 * (`data.campo === undefined`) conserva el valor que ya tenía, en vez de
 * volver a su default. El panel de admin (botConfig.js) no conoce campos
 * como `takes_orders` u `owner_phone` — sin esto, guardar el conocimiento
 * previo desde ahí resetearía esos campos en cada guardado.
 */
const upsertBotConfig = async (clientId, data) => {
  const existing = await dbGet('SELECT * FROM bot_configs WHERE client_id = ?', [clientId]);

  const campo = (nombre, porDefecto) =>
    data[nombre] !== undefined ? data[nombre] : (existing ? existing[nombre] : porDefecto);

  const fields = {
    ai_provider: campo('ai_provider', 'gemini'),
    ai_model: campo('ai_model', DEFAULT_MODEL),
    system_prompt: campo('system_prompt', ''),
    business_rules: data.business_rules !== undefined
      ? JSON.stringify(data.business_rules)
      : (existing ? existing.business_rules : '{}'),
    knowledge_base: campo('knowledge_base', ''),
    handoff_keywords: data.handoff_keywords !== undefined
      ? JSON.stringify(data.handoff_keywords)
      : (existing ? existing.handoff_keywords : '[]'),
    max_failed_attempts: campo('max_failed_attempts', 3),
    // Por defecto 1 (true): quien no lo especifique se comporta como siempre
    // (restaurantes, capa A). Se apaga explícitamente en seedInternal.js.
    takes_orders: data.takes_orders !== undefined
      ? (data.takes_orders ? 1 : 0)
      : (existing ? existing.takes_orders : 1),
    // WhatsApp fijo del dueño — único número autorizado para inventario,
    // reservas y estados de cuenta (ver ownerService.js).
    owner_phone: campo('owner_phone', null),
    // Minutos antes de que un pedido pagado y sin entregar se ponga en alarma
    // roja en la tablet.
    alerta_pedido_minutos: campo('alerta_pedido_minutos', 15)
  };

  if (existing) {
    await dbRun(
      `UPDATE bot_configs SET ai_provider=?, ai_model=?, system_prompt=?, business_rules=?, knowledge_base=?, handoff_keywords=?, max_failed_attempts=?, takes_orders=?, owner_phone=?, alerta_pedido_minutos=?, updated_at=CURRENT_TIMESTAMP WHERE client_id=?`,
      [fields.ai_provider, fields.ai_model, fields.system_prompt, fields.business_rules, fields.knowledge_base, fields.handoff_keywords, fields.max_failed_attempts, fields.takes_orders, fields.owner_phone, fields.alerta_pedido_minutos, clientId]
    );
    return existing.id;
  }

  const result = await dbRun(
    `INSERT INTO bot_configs (client_id, ai_provider, ai_model, system_prompt, business_rules, knowledge_base, handoff_keywords, max_failed_attempts, takes_orders, owner_phone)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [clientId, fields.ai_provider, fields.ai_model, fields.system_prompt, fields.business_rules, fields.knowledge_base, fields.handoff_keywords, fields.max_failed_attempts, fields.takes_orders, fields.owner_phone]
  );
  return result.id;
};

module.exports = {
  isConfigured,
  generateBotResponse,
  extractOrder,
  getBotConfig,
  upsertBotConfig,
  detectHandoffKeyword,
  listarModelos,
  mergeMemoryNote
};
