const axios = require('axios');
const { dbGet, dbAll, dbRun } = require('../config/database');
const { emitToClient } = require('../routes/conversations');
const logger = require('../utils/logger');

/**
 * Llamadas por WhatsApp (WhatsApp Business Calling API) — FASE 1.
 *
 * Qué hace esta fase: registra cada llamada que entra y cómo termina, la
 * muestra en la tablet, lee el estado de llamadas del número en Meta, y mide
 * cuántas sesiones de voz de Gemini Live aguanta la cuenta al tiempo.
 *
 * Qué NO hace todavía: contestar. Contestar exige responder la oferta SDP con
 * `pre_accept` + `accept` en 30 a 60 segundos y sostener el audio por WebRTC
 * (ICE + DTLS + SRTP, códec OPUS). Railway no expone UDP entrante, así que el
 * audio va a tener que pasar por un servidor TURN. Eso es la fase 2.
 *
 * Por eso habilitar las llamadas en el número está bloqueado hasta que exista
 * el puente (PUENTE_LLAMADAS_ACTIVO=true): con las llamadas activas y sin nadie
 * que conteste, cada cliente que llame se queda con "No contestada".
 */

const GRAPH = `https://graph.facebook.com/${process.env.META_GRAPH_VERSION || 'v21.0'}`;
const TOKEN = process.env.META_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID;
const auth = () => ({ Authorization: `Bearer ${TOKEN}` });

const PUENTE_ACTIVO = process.env.PUENTE_LLAMADAS_ACTIVO === 'true';

const aFecha = (epoch) => (epoch ? new Date(Number(epoch) * 1000).toISOString() : null);

/** Registra los eventos del webhook `calls` (connect y terminate). */
const manejarEventos = async (clientId, value) => {
  const contactos = value.contacts || [];

  for (const c of value.calls || []) {
    try {
      const contacto = contactos.find((x) => x.wa_id === c.from);
      const nombre = contacto?.profile?.name || null;

      if (c.event === 'connect') {
        const existe = await dbGet('SELECT id FROM calls WHERE call_id = ?', [c.id]);
        if (!existe) {
          await dbRun(
            `INSERT INTO calls (client_id, call_id, direction, from_number, from_name, status, started_at, raw_offer)
             VALUES (?, ?, ?, ?, ?, 'sonando', ?, ?)`,
            [clientId, c.id, c.direction || null, c.from || null, nombre,
             aFecha(c.timestamp), c.session?.sdp || null]
          );
        }
        emitToClient(clientId, 'call:incoming', {
          callId: c.id, from: c.from, nombre, direction: c.direction
        });
        logger.info('Llamada entrante por WhatsApp', {
          callId: c.id, from: c.from, puenteActivo: PUENTE_ACTIVO
        });
      } else if (c.event === 'terminate') {
        const estado = Array.isArray(c.status) ? c.status.join(', ') : (c.status || 'terminada');
        await dbRun(
          `UPDATE calls SET status = ?, ended_at = ?, duration_seconds = ? WHERE call_id = ?`,
          [estado, aFecha(c.end_time || c.timestamp), Number(c.duration) || 0, c.id]
        );
        emitToClient(clientId, 'call:ended', { callId: c.id, estado, duracion: Number(c.duration) || 0 });
        logger.info('Llamada terminada', { callId: c.id, estado, duracion: c.duration });
      } else {
        logger.info('Evento de llamada sin manejar', { callId: c.id, event: c.event });
      }
    } catch (error) {
      logger.error('Error registrando evento de llamada', { callId: c.id, error: error.message });
    }
  }
};

/**
 * Estado de llamadas del número y datos que deciden si se pueden activar:
 * Meta exige un límite de 2.000 conversaciones para habilitarlas.
 */
const estadoEnMeta = async () => {
  if (!TOKEN || !PHONE_NUMBER_ID) return { ok: false, error: 'Faltan META_ACCESS_TOKEN o META_PHONE_NUMBER_ID' };

  const resultado = { ok: true, puenteActivo: PUENTE_ACTIVO };
  try {
    const { data } = await axios.get(`${GRAPH}/${PHONE_NUMBER_ID}`, {
      headers: auth(),
      params: { fields: 'display_phone_number,verified_name,quality_rating,messaging_limit_tier,code_verification_status' },
      timeout: 15000
    });
    resultado.numero = data;
  } catch (error) {
    resultado.numero = { error: error.response?.data?.error?.message || error.message };
  }

  // El límite ahora se calcula por PORTAFOLIO, no por número, y el campo
  // messaging_limit_tier del número puede quedar desactualizado: después de
  // la verificación seguía diciendo TIER_250. La documentación de ese nodo da
  // 404, así que se prueba cada campo candidato por separado — Meta responde
  // error en los que no existen, y así se sabe cuál es el real.
  resultado.camposLimite = {};
  for (const campo of ['whatsapp_business_manager_messaging_limit', 'messaging_limit_tier', 'throughput', 'status', 'name_status', 'platform_type']) {
    try {
      const { data } = await axios.get(`${GRAPH}/${PHONE_NUMBER_ID}`, { headers: auth(), params: { fields: campo }, timeout: 10000 });
      resultado.camposLimite[campo] = data[campo] === undefined ? '(sin valor)' : data[campo];
    } catch (error) {
      resultado.camposLimite[campo] = `no existe: ${(error.response?.data?.error?.message || error.message).slice(0, 90)}`;
    }
  }

  const WABA_ID = process.env.META_WABA_ID;
  if (WABA_ID) {
    try {
      const { data } = await axios.get(`${GRAPH}/${WABA_ID}`, {
        headers: auth(),
        params: { fields: 'id,name,account_review_status,business_verification_status,ownership_type' },
        timeout: 15000
      });
      resultado.cuentaWhatsApp = data;
    } catch (error) {
      resultado.cuentaWhatsApp = { error: error.response?.data?.error?.message || error.message };
    }
  }

  // Qué campos del webhook tiene suscritos la app. Si 'calls' no está, Meta ni
  // siquiera avisa cuando alguien llama. Se consulta con el token de la APP
  // (id|secreto), que es el que exige este endpoint.
  const APP_ID = process.env.META_APP_ID;
  const APP_SECRET = (process.env.META_APP_SECRET || '').trim();
  if (APP_ID && APP_SECRET) {
    try {
      const { data } = await axios.get(`${GRAPH}/${APP_ID}/subscriptions`, {
        params: { access_token: `${APP_ID}|${APP_SECRET}` },
        timeout: 15000
      });
      resultado.webhook = (data.data || []).map((s) => ({
        objeto: s.object,
        activo: s.active,
        campos: (s.fields || []).map((f) => f.name)
      }));
    } catch (error) {
      resultado.webhook = { error: error.response?.data?.error?.message || error.message };
    }
  }
  try {
    const { data } = await axios.get(`${GRAPH}/${PHONE_NUMBER_ID}/settings`, { headers: auth(), timeout: 15000 });
    resultado.llamadas = data?.calling || data;
  } catch (error) {
    resultado.llamadas = { error: error.response?.data?.error?.message || error.message };
  }
  return resultado;
};

/** Activa o apaga las llamadas del número. Activar exige el puente listo. */
const configurarEnMeta = async ({ habilitar }) => {
  if (habilitar && !PUENTE_ACTIVO) {
    return {
      ok: false,
      error: 'No se activan las llamadas sin el puente de audio listo: cada cliente que llame quedaría con "No contestada". ' +
        'Cuando la fase 2 esté desplegada, se pone PUENTE_LLAMADAS_ACTIVO=true.'
    };
  }
  try {
    const { data } = await axios.post(
      `${GRAPH}/${PHONE_NUMBER_ID}/settings`,
      { calling: { status: habilitar ? 'ENABLED' : 'DISABLED', call_icon_visibility: 'DEFAULT', callback_permission_status: 'ENABLED' } },
      { headers: { ...auth(), 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    logger.info('Configuración de llamadas cambiada en Meta', { habilitar });
    return { ok: true, respuesta: data };
  } catch (error) {
    return { ok: false, error: error.response?.data?.error?.message || error.message };
  }
};

/**
 * Cuántas sesiones de voz de Gemini Live acepta la cuenta al mismo tiempo.
 *
 * Google no publica ese límite, y de él depende si se le pueden prometer a un
 * cliente 2 o 5 llamadas simultáneas. En vez de adivinarlo, se mide: se abren
 * N sesiones a la vez, se esperan TODAS abiertas, y recién ahí se cierran —
 * cerrarlas a medida que abren no mediría concurrencia.
 */
const probarConcurrenciaLive = async (n = 5, modelo = 'gemini-2.5-flash-native-audio-preview-12-2025') => {
  if (!process.env.GEMINI_API_KEY) return { ok: false, error: 'Falta GEMINI_API_KEY' };

  let GoogleGenAI, Modality;
  try {
    ({ GoogleGenAI, Modality } = require('@google/genai'));
  } catch (e) {
    return { ok: false, error: 'Falta la librería @google/genai' };
  }

  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const sesiones = [];

  const intentos = Array.from({ length: n }, (_, i) => new Promise((resolve) => {
    const inicio = Date.now();
    let listo = false;
    const fin = (r) => { if (listo) return; listo = true; clearTimeout(reloj); resolve({ intento: i + 1, ...r, ms: Date.now() - inicio }); };
    const reloj = setTimeout(() => fin({ ok: false, error: 'sin respuesta en 15 s' }), 15000);

    ai.live.connect({
      model: modelo,
      config: { responseModalities: [Modality.AUDIO] },
      callbacks: {
        onopen: () => {},
        onmessage: (m) => { if (m.setupComplete) fin({ ok: true }); },
        onerror: (e) => fin({ ok: false, error: e?.message || String(e) }),
        onclose: (e) => fin({ ok: false, error: `cerrada por el servidor: ${e?.code || ''} ${e?.reason || ''}`.trim() })
      }
    }).then((s) => sesiones.push(s)).catch((e) => fin({ ok: false, error: e.message }));
  }));

  const detalle = await Promise.all(intentos);
  // Todas se sostuvieron abiertas hasta aquí; ahora sí se cierran.
  sesiones.forEach((s) => { try { s.close(); } catch (e) { /* ya cerrada */ } });

  const abiertas = detalle.filter((d) => d.ok).length;
  logger.info('Prueba de concurrencia de Gemini Live', { modelo, pedidas: n, abiertas });
  return { ok: true, modelo, pedidas: n, abiertas, detalle };
};

const listarLlamadas = async (clientId) => dbAll(
  `SELECT id, call_id, direction, from_number, from_name, status, started_at, ended_at, duration_seconds, created_at
   FROM calls WHERE client_id = ? ORDER BY created_at DESC LIMIT 100`,
  [clientId]
);

module.exports = { manejarEventos, estadoEnMeta, configurarEnMeta, probarConcurrenciaLive, listarLlamadas, PUENTE_ACTIVO };
