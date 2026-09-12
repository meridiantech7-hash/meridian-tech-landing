const express = require('express');
const sb = require('../services/supabaseApp');
const logger = require('../utils/logger');

/**
 * Cierra el círculo de "Conectar Instagram".
 *
 * El panel manda a la persona a autorizar en Meta; Meta la devuelve aquí con
 * un `code`. Ese código hay que cambiarlo por un token, y el token que entrega
 * el primer intercambio dura UNA HORA. Por eso se hace enseguida el segundo
 * intercambio, el de larga duración, que da 60 días. Sin ese paso el asistente
 * se caería cada hora.
 *
 * Importa que sea la cuenta de quien autoriza y no la nuestra: el panel
 * muestra el perfil que salga de aquí. Una pantalla que enseñe siempre la
 * misma cuenta sin importar quién se conecte estaría mintiendo.
 *
 * El token no se guarda en esta base ni en el código: va al Vault de Supabase
 * a través de app.guardar_cuenta_meta, y aquí solo queda el identificador de
 * la cuenta.
 */

const router = express.Router();

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v21.0';
const BASE = (process.env.APP_URL || 'https://meridiantech.app').replace(/\/+$/, '');
const REDIRECT = `${BASE}/instagram/conectado`;

// Los permisos que pedimos al conectar. Son exactamente los que la app usa:
// leer el perfil de la cuenta y atender sus mensajes.
const ALCANCE = 'instagram_business_basic,instagram_business_manage_messages';

const configurado = () => !!(process.env.META_IG_APP_ID && process.env.META_IG_APP_SECRET);

/** URL a la que se manda a la persona para que autorice su cuenta. */
function urlDeAutorizacion() {
  const u = new URL('https://www.instagram.com/oauth/authorize');
  u.searchParams.set('client_id', process.env.META_IG_APP_ID);
  u.searchParams.set('redirect_uri', REDIRECT);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', ALCANCE);
  return u.toString();
}

/**
 * code -> token de una hora -> token de 60 días -> perfil.
 *
 * Devuelve { ok, cuenta } o { ok:false, motivo }. El motivo se muestra en
 * pantalla, así que se conserva el texto de Meta: es lo único que distingue
 * "la cuenta no es profesional" de "el código ya se usó".
 */
async function canjear(code) {
  // 1. El código por un token corto.
  let r = await fetch('https://api.instagram.com/oauth/access_token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.META_IG_APP_ID,
      client_secret: process.env.META_IG_APP_SECRET,
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT,
      code
    })
  });
  let cuerpo = await r.json().catch(() => ({}));
  if (!r.ok || !cuerpo.access_token) {
    return { ok: false, motivo: cuerpo.error_message || cuerpo.error_description || `Meta respondió ${r.status}` };
  }
  const corto = cuerpo.access_token;

  // 2. El token corto por uno de 60 días. Si este paso falla no se continúa:
  //    guardar el de una hora dejaría la cuenta rota al rato, en silencio.
  const u = new URL(`https://graph.instagram.com/access_token`);
  u.searchParams.set('grant_type', 'ig_exchange_token');
  u.searchParams.set('client_secret', process.env.META_IG_APP_SECRET);
  u.searchParams.set('access_token', corto);
  r = await fetch(u.toString());
  cuerpo = await r.json().catch(() => ({}));
  if (!r.ok || !cuerpo.access_token) {
    const motivo = (cuerpo.error && cuerpo.error.message) || `Meta respondió ${r.status} al pedir el token largo`;
    return { ok: false, motivo };
  }
  const largo = cuerpo.access_token;
  const dias = cuerpo.expires_in ? Math.floor(cuerpo.expires_in / 86400) : 60;

  // 3. El perfil de esa cuenta, con su propio token.
  const p = new URL(`https://graph.instagram.com/${GRAPH_VERSION}/me`);
  p.searchParams.set('fields', 'id,username,name,profile_picture_url');
  p.searchParams.set('access_token', largo);
  r = await fetch(p.toString());
  const perfil = await r.json().catch(() => ({}));
  if (!r.ok || !perfil.id) {
    const motivo = (perfil.error && perfil.error.message) || `Meta respondió ${r.status} al leer el perfil`;
    return { ok: false, motivo };
  }

  if (!sb.activo()) return { ok: false, motivo: 'El almacenamiento no está disponible' };
  await sb.rpc('guardar_cuenta_meta', {
    p_plataforma: 'instagram',
    p_cuenta_id: String(perfil.id),
    p_usuario: perfil.username || null,
    p_nombre: perfil.name || null,
    p_foto: perfil.profile_picture_url || null,
    p_token: largo,
    p_dias: dias
  });

  return { ok: true, cuenta: { id: perfil.id, usuario: perfil.username || null } };
}

/**
 * Meta devuelve aquí. Con `code` se hace el canje y se redirige a la misma
 * página ya sin el código en la barra — un código de autorización en el
 * historial del navegador es un cabo suelto que no hace falta dejar.
 * Sin `code`, se deja pasar a la página estática de siempre.
 */
router.get('/instagram/conectado', async (req, res, next) => {
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  if (!code) return next();

  if (!configurado()) {
    logger.error('Falta META_IG_APP_ID o META_IG_APP_SECRET para conectar Instagram');
    return res.redirect(302, '/instagram/conectado?error=config');
  }

  try {
    const r = await canjear(code);
    if (!r.ok) {
      logger.warn('No se pudo conectar la cuenta de Instagram', { motivo: r.motivo });
      return res.redirect(302, '/instagram/conectado?error=' + encodeURIComponent(r.motivo));
    }
    logger.info('Cuenta de Instagram conectada', { usuario: r.cuenta.usuario });
    res.redirect(302, '/instagram/conectado?ok=1&usuario=' + encodeURIComponent(r.cuenta.usuario || ''));
  } catch (error) {
    logger.error('Error conectando Instagram', { error: error.message });
    res.redirect(302, '/instagram/conectado?error=' + encodeURIComponent('Error inesperado'));
  }
});

module.exports = { router, urlDeAutorizacion, configurado };
