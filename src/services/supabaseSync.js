const axios = require('axios');
const { dbGet } = require('../config/database');
const logger = require('../utils/logger');

/**
 * Réplica en Supabase (esquema `app`) de la memoria de la app: conversaciones
 * con su memoria, mensajes y reservas.
 *
 * Supabase es el respaldo que sobrevive a un volumen perdido en Railway y la
 * fuente que leen los flujos de n8n. Todo va con la clave service_role, que
 * solo vive en las variables de Railway; el esquema `app` no tiene permisos
 * para anon ni authenticated, así que desde afuera no se puede leer nada.
 *
 * Nunca frena la conversación: cada llamada es de fondo y si Supabase no
 * responde se registra y se sigue. Sin SUPABASE_URL o la clave, no hace nada.
 */

const URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const CLAVE = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const activo = () => !!(URL && CLAVE);

const cabeceras = (extra = {}) => ({
  apikey: CLAVE,
  Authorization: `Bearer ${CLAVE}`,
  'Content-Type': 'application/json',
  'Content-Profile': 'app',
  'Accept-Profile': 'app',
  ...extra
});

const upsert = async (tabla, fila, conflicto) => {
  const { data } = await axios.post(
    `${URL}/rest/v1/${tabla}?on_conflict=${conflicto}`,
    fila,
    { headers: cabeceras({ Prefer: 'resolution=merge-duplicates,return=representation' }), timeout: 10000 }
  );
  return Array.isArray(data) ? data[0] : data;
};

const insertar = async (tabla, fila) => {
  await axios.post(`${URL}/rest/v1/${tabla}`, fila, {
    headers: cabeceras({ Prefer: 'return=minimal' }), timeout: 10000
  });
};

const aFecha = (valor) => (valor ? new Date(String(valor).replace(' ', 'T') + (/[zZ+]/.test(String(valor)) ? '' : 'Z')).toISOString() : null);

// Negocios ya replicados y conversación del servidor → id en Supabase.
const clientesListos = new Set();
const idsConversacion = new Map();

const asegurarCliente = async (clientId) => {
  if (clientesListos.has(clientId)) return;
  const c = await dbGet('SELECT id, name, email, phone, company, is_internal, status FROM clients WHERE id = ?', [clientId]);
  if (!c) throw new Error(`cliente ${clientId} no existe en el servidor`);
  await upsert('clients', {
    id: c.id, name: c.name, email: c.email || `cliente${c.id}@sin-correo.local`,
    phone: c.phone, company: c.company, is_internal: !!c.is_internal, status: c.status || 'active'
  }, 'id');
  clientesListos.add(clientId);
};

const replicarConversacion = async (conversationId) => {
  const c = await dbGet('SELECT * FROM conversations WHERE id = ?', [conversationId]);
  if (!c) return null;
  await asegurarCliente(c.client_id);
  const fila = await upsert('conversations', {
    client_id: c.client_id,
    channel_type: c.channel_type,
    end_customer_id: c.end_customer_id,
    end_customer_name: c.end_customer_name,
    customer_notes: c.customer_notes,
    mode: c.mode,
    status: c.status,
    last_message_at: aFecha(c.last_message_at)
  }, 'client_id,channel_type,end_customer_id');
  if (fila?.id) idsConversacion.set(conversationId, fila.id);
  return fila?.id || null;
};

const deFondo = (etiqueta, fn) => {
  if (!activo()) return;
  fn().catch((error) => {
    logger.warn(`Supabase: no se replicó ${etiqueta}`, {
      error: error.response?.data?.message || error.message
    });
  });
};

/** Conversación con su memoria y su modo (bot/humano). */
const conversacion = (conversationId) => deFondo('la conversación', () => replicarConversacion(conversationId));

/** Un mensaje, del cliente o del negocio. */
const mensaje = (conversationId, remitente, contenido, externalId = null) => deFondo('el mensaje', async () => {
  let id = idsConversacion.get(conversationId);
  if (!id) id = await replicarConversacion(conversationId);
  if (!id) return;
  await insertar('messages', {
    conversation_id: id, sender_type: remitente, content: contenido, external_message_id: externalId
  });
});

/** Una reserva nueva o actualizada. */
const reserva = (r) => deFondo('la reserva', async () => {
  if (!r) return;
  await asegurarCliente(r.client_id);
  let conversacionId = null;
  if (r.conversation_id) {
    conversacionId = idsConversacion.get(r.conversation_id) || await replicarConversacion(r.conversation_id);
  }
  await upsert('reservations', {
    source_id: r.id,
    client_id: r.client_id,
    conversation_id: conversacionId,
    customer_name: r.customer_name,
    customer_phone: r.customer_phone,
    party_size: r.party_size,
    scheduled_at: aFecha(r.scheduled_at),
    status: r.status,
    source: r.source,
    channel_type: r.channel_type,
    notes: r.notes
  }, 'source_id');
});

module.exports = { activo, conversacion, mensaje, reserva };
