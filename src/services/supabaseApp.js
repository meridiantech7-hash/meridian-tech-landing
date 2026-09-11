const axios = require('axios');
const { dbGet } = require('../config/database');

/**
 * Acceso de la app (tablet y panel) a la memoria que atiende n8n.
 *
 * Desde que el flujo de mensajes vive en n8n, las conversaciones, los
 * mensajes y las reservas se guardan en Supabase (esquema `app`), no en la
 * base de Railway. Railway ya no decide nada: solo LEE para mostrar en la
 * tablet y ESCRIBE lo que hace una persona desde la tablet (pausar el bot,
 * responder, confirmar una reserva).
 *
 * Se activa con FLUJO_EN_N8N=true. Mientras esté apagado, la app sigue con su
 * base propia como antes: así el cambio se revierte en un minuto.
 *
 * La clave service_role solo vive en las variables de Railway.
 */

const URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const CLAVE = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

const activo = () => !!(URL && CLAVE && process.env.FLUJO_EN_N8N === 'true');

const cabeceras = (extra = {}) => ({
  apikey: CLAVE,
  Authorization: `Bearer ${CLAVE}`,
  'Accept-Profile': 'app',
  'Content-Profile': 'app',
  'Content-Type': 'application/json',
  ...extra
});

const select = async (tabla, query) =>
  (await axios.get(`${URL}/rest/v1/${tabla}?${query}`, { headers: cabeceras(), timeout: 10000 })).data;

const rpc = async (fn, args) =>
  (await axios.post(`${URL}/rest/v1/rpc/${fn}`, args, { headers: cabeceras(), timeout: 10000 })).data;

const insertar = async (tabla, datos) =>
  (await axios.post(`${URL}/rest/v1/${tabla}`, datos, {
    headers: cabeceras({ Prefer: 'return=representation' }), timeout: 10000
  })).data;

const actualizar = async (tabla, filtro, datos) =>
  (await axios.patch(`${URL}/rest/v1/${tabla}?${filtro}`, datos, {
    headers: cabeceras({ Prefer: 'return=representation' }), timeout: 10000
  })).data;

const borrar = async (tabla, filtro) =>
  axios.delete(`${URL}/rest/v1/${tabla}?${filtro}`, { headers: cabeceras(), timeout: 10000 });

// ── Cliente de la app ↔ cliente en Supabase ─────────────────────────────────
// El negocio interno (MeridianTech) puede tener un id distinto en cada base;
// los demás negocios conservan su número.
let internoSupa;
let internoApp;
const cargarInternos = async () => {
  if (internoSupa !== undefined) return;
  const [c] = await select('clients', 'is_internal=eq.true&select=id');
  const a = await dbGet('SELECT id FROM clients WHERE is_internal = 1');
  internoSupa = c ? Number(c.id) : null;
  internoApp = a ? Number(a.id) : null;
};
const aClienteSupabase = async (appId) => {
  await cargarInternos();
  return Number(appId) === internoApp ? internoSupa : Number(appId);
};
const aClienteApp = async (supaId) => {
  await cargarInternos();
  return Number(supaId) === internoSupa ? internoApp : Number(supaId);
};

// ── Eventos ya enviados a la tablet ─────────────────────────────────────────
// Lo que la tablet misma provoca se emite al instante desde la ruta; el
// vigilante en vivo (supabaseEnVivo.js) no lo vuelve a emitir.
const emitidos = new Map();
const marcarEmitido = (clave) => emitidos.set(clave, Date.now());
const yaEmitido = (clave) => {
  const ahora = Date.now();
  for (const [k, t] of emitidos) if (ahora - t > 10 * 60 * 1000) emitidos.delete(k);
  return emitidos.has(clave);
};

module.exports = {
  activo, select, rpc, insertar, actualizar, borrar,
  aClienteSupabase, aClienteApp, marcarEmitido, yaEmitido
};
