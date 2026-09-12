const sb = require('./supabaseApp');
const logger = require('../utils/logger');

/**
 * Tablet en vivo cuando el flujo vive en n8n.
 *
 * n8n escribe en Supabase y la tablet escucha a Railway por Socket.io. Este
 * vigilante mira Supabase cada pocos segundos y avisa a la tablet de lo nuevo:
 * mensajes, cambios de modo (bot/persona) y reservas. Lo que la propia tablet
 * provocó ya se avisó desde la ruta y aquí no se repite.
 */

const CADA_MS = Number(process.env.TABLET_VIVO_MS || 3000);
const emitir = (...args) => require('../routes/conversations').emitToClient(...args);

let ultimoMensaje = null;
let desde = new Date().toISOString();
const modos = new Map();
let corriendo = false;

async function revisar() {
  if (corriendo || !sb.activo()) return;
  corriendo = true;
  const inicio = new Date(Date.now() - 2000).toISOString();
  try {
    if (ultimoMensaje === null) {
      const [m] = await sb.select('messages', 'select=id&order=id.desc&limit=1');
      ultimoMensaje = m ? Number(m.id) : 0;
    }

    const mensajes = await sb.select('messages',
      `id=gt.${ultimoMensaje}&select=id,conversation_id,sender_type,content,created_at,conversations(client_id)&order=id.asc&limit=200`);
    for (const m of mensajes) {
      ultimoMensaje = Number(m.id);
      if (sb.yaEmitido(`m:${m.id}`) || !m.conversations) continue;
      emitir(await sb.aClienteApp(m.conversations.client_id), 'conversation:new_message', {
        id: m.id, conversation_id: m.conversation_id, sender_type: m.sender_type,
        content: m.content, delivered: true, created_at: m.created_at
      });
    }

    const conversaciones = await sb.select('conversations',
      `updated_at=gt.${encodeURIComponent(desde)}&select=id,client_id,mode`);
    for (const c of conversaciones) {
      const antes = modos.get(c.id);
      modos.set(c.id, c.mode);
      if (antes === undefined || antes === c.mode || sb.yaEmitido(`modo:${c.id}:${c.mode}`)) continue;
      emitir(await sb.aClienteApp(c.client_id), 'conversation:mode_changed', { conversationId: c.id, mode: c.mode });
    }

    const reservas = await sb.select('reservations', `updated_at=gt.${encodeURIComponent(desde)}&select=*`);
    for (const r of reservas) {
      const clave = `r:${r.id}:${r.updated_at}`;
      if (sb.yaEmitido(clave)) continue;
      sb.marcarEmitido(clave);
      const reserva = { ...r, client_id: await sb.aClienteApp(r.client_id) };
      emitir(reserva.client_id, r.created_at === r.updated_at ? 'reservation:new' : 'reservation:updated', reserva);
    }

    // Ordenes que crea n8n cuando entra un comprobante de pago. Sin esto la
    // tablet solo las veia al recargar la pestana, y un pago confirmado por
    // WhatsApp pasaba desapercibido justo cuando hay que atenderlo.
    const ordenes = await sb.select('orders', `updated_at=gt.${encodeURIComponent(desde)}&select=*`);
    for (const o of ordenes) {
      const clave = `o:${o.id}:${o.updated_at}`;
      if (sb.yaEmitido(clave)) continue;
      sb.marcarEmitido(clave);
      const orden = { ...o, client_id: await sb.aClienteApp(o.client_id) };
      emitir(orden.client_id, o.created_at === o.updated_at ? 'order:new' : 'order:updated', orden);
    }

    desde = inicio;
  } catch (error) {
    logger.warn('Tablet en vivo: no se pudo revisar Supabase', {
      error: error.response?.data?.message || error.message
    });
  } finally {
    corriendo = false;
  }
}

const iniciar = () => {
  if (!sb.activo()) {
    logger.info('Tablet en vivo desde Supabase: apagado (FLUJO_EN_N8N no está en true)');
    return;
  }
  setInterval(revisar, CADA_MS);
  logger.info('Tablet en vivo desde Supabase: encendido', { cadaMs: CADA_MS });
};

module.exports = { iniciar };
