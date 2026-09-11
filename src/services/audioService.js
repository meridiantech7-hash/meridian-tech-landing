const axios = require('axios');
const { dbRun } = require('../config/database');
const logger = require('../utils/logger');

/**
 * Notas de voz de Valeria con ElevenLabs.
 *
 * Solo para lo que se dice mejor en voz que por escrito: cortesía,
 * agradecimiento, confirmación de pagos, y en general los mensajes cortos que
 * caben en menos de 10 segundos. Un mensaje con precios, enlaces o datos va
 * siempre por escrito: un número dictado hay que anotarlo y un enlace dictado
 * no sirve.
 *
 * FORMATO. WhatsApp muestra la burbuja de nota de voz (con transcripción y
 * botón de play) solo con audio .ogg en códec OPUS, mono y de hasta 512 KB.
 * ElevenLabs entrega opus_48000_*, así que no hace falta ffmpeg. Se revisa la
 * cabecera "OggS" de lo que llega; si no fuera Ogg se pide MP3 y se manda como
 * audio común — se oye igual, pero sin la burbuja de nota de voz.
 */

const API_KEY = process.env.ELEVENLABS_API_KEY;
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'JcWDFG8DiES2OzGhZJUJ';
// Flash v2.5: la de menor latencia, y la que usa costService para calcular el
// costo por minuto (0,5 créditos por carácter).
const MODELO = process.env.ELEVENLABS_MODEL || 'eleven_flash_v2_5';

const GRAPH = `https://graph.facebook.com/${process.env.META_GRAPH_VERSION || 'v21.0'}`;
const META_TOKEN = process.env.META_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID;

// Español hablado ronda los 15 caracteres por segundo: 10 s ≈ 150 caracteres.
const MAX_CARACTERES = 150;
const CARACTERES_POR_SEGUNDO = 15;

const estaConfigurado = () => !!(API_KEY && META_TOKEN && PHONE_NUMBER_ID);

/** Quita lo que no se debe leer en voz alta: emojis y los asteriscos de negrita. */
const limpiarParaVoz = (texto) => String(texto || '')
  .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu, '')
  .replace(/[*_~]/g, '')
  .replace(/\s+/g, ' ')
  .trim();

/**
 * ¿Este mensaje del bot va mejor en voz?
 * Corto (menos de 10 s) y sin cifras ni enlaces.
 */
const esCandidatoAVoz = (texto) => {
  const limpio = limpiarParaVoz(texto);
  if (!limpio || limpio.length > MAX_CARACTERES) return false;
  if (/https?:\/\/|www\.|\.app\b|\.com\b|\d/.test(limpio)) return false;
  return true;
};

const sintetizar = async (texto, formato) => {
  const { data } = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=${formato}`,
    { text: texto, model_id: MODELO },
    {
      headers: { 'xi-api-key': API_KEY, 'Content-Type': 'application/json', Accept: 'audio/*' },
      responseType: 'arraybuffer',
      timeout: 20000
    }
  );
  return Buffer.from(data);
};

const esOgg = (buf) => buf && buf.length > 4 && buf.slice(0, 4).toString('latin1') === 'OggS';

/** Sube el audio a Meta y devuelve el id del medio. */
const subirAMeta = async (buffer, mime, nombre, phoneNumberId) => {
  if (typeof FormData === 'undefined' || typeof Blob === 'undefined') {
    throw new Error('Este Node no trae FormData/Blob nativos (hace falta Node 18 o superior)');
  }
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mime);
  form.append('file', new Blob([buffer], { type: mime }), nombre);

  const resp = await fetch(`${GRAPH}/${phoneNumberId || PHONE_NUMBER_ID}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${META_TOKEN}` },
    body: form
  });
  const json = await resp.json();
  if (!resp.ok || !json.id) {
    throw new Error(`Meta rechazó el audio: ${json.error?.message || resp.status}`);
  }
  return json.id;
};

/**
 * Sintetiza el texto con la voz de Valeria y lo manda como nota de voz.
 * @returns {{sent:boolean, externalId?:string, motivo?:string, segundos?:number}}
 */
const enviarNotaDeVoz = async ({ to, texto, phoneNumberId, clientId }) => {
  if (!estaConfigurado()) {
    return { sent: false, motivo: 'audio no configurado (falta ELEVENLABS_API_KEY o Meta)' };
  }
  const limpio = limpiarParaVoz(texto);
  if (!limpio) return { sent: false, motivo: 'texto vacío para voz' };

  try {
    let buffer = await sintetizar(limpio, 'opus_48000_64');
    let mime = 'audio/ogg';
    let nombre = 'valeria.ogg';
    let comoNotaDeVoz = true;

    if (!esOgg(buffer)) {
      logger.warn('ElevenLabs no devolvió Ogg/Opus; se manda como MP3 sin burbuja de voz');
      buffer = await sintetizar(limpio, 'mp3_44100_64');
      mime = 'audio/mpeg';
      nombre = 'valeria.mp3';
      comoNotaDeVoz = false;
    }

    const mediaId = await subirAMeta(buffer, mime, nombre, phoneNumberId);

    const resp = await axios.post(
      `${GRAPH}/${phoneNumberId || PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'audio',
        audio: { id: mediaId, voice: comoNotaDeVoz }
      },
      { headers: { Authorization: `Bearer ${META_TOKEN}` }, timeout: 20000 }
    );

    const segundos = Math.max(1, Math.round(limpio.length / CARACTERES_POR_SEGUNDO));

    // Queda anotado para la contabilidad de minutos de audio de cada plan.
    if (clientId) {
      dbRun(
        "INSERT INTO activity_logs (client_id, action, entity, description) VALUES (?, 'audio_whatsapp', 'audio', ?)",
        [clientId, `${segundos}s · ${limpio.length} caracteres`]
      ).catch(() => {});
    }

    logger.info('Nota de voz enviada', { to, segundos, bytes: buffer.length, comoNotaDeVoz });
    return { sent: true, externalId: resp.data?.messages?.[0]?.id || null, segundos };
  } catch (error) {
    const motivo = error.response?.data
      ? (Buffer.isBuffer(error.response.data)
        ? error.response.data.toString('utf8').slice(0, 200)
        : JSON.stringify(error.response.data).slice(0, 200))
      : error.message;
    logger.error('No se pudo enviar la nota de voz', { to, motivo });
    return { sent: false, motivo };
  }
};

module.exports = { enviarNotaDeVoz, esCandidatoAVoz, limpiarParaVoz, estaConfigurado };
