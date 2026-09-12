const express = require('express');
const { verifyToken } = require('../middleware/auth');
const logger = require('../utils/logger');
const { urlDeAutorizacion, configurado } = require('./instagramOAuth');

/**
 * Estado de los canales de Meta dentro del panel.
 *
 * Existe por un motivo muy concreto: la revisión de la app en Meta exige
 * demostrar en video que la app efectivamente usa cada permiso que pide, y
 * "dentro de la app" quiere decir dentro de nuestra propia interfaz, no en las
 * herramientas de Meta. Dos requisitos textuales del formulario:
 *
 *   - instagram_business_basic: mostrar el usuario y los datos del perfil de la
 *     cuenta profesional de Instagram que se acaba de conectar.
 *   - pages_show_list: mostrar la lista de páginas a las que la app accede.
 *
 * De ahí las dos rutas de abajo. Solo leen; nada aquí modifica nada en Meta.
 *
 * El token nunca sale al navegador: el panel pide estos endpoints y el servidor
 * es el único que habla con Graph. Tampoco se registra en los logs.
 */

const router = express.Router();

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v21.0';

/**
 * Dos hosts y dos tokens, y no son intercambiables.
 *
 * Un token de Instagram Login (los que empiezan por IGAA) contra
 * graph.facebook.com responde `190 · Cannot parse access token`: ese host no
 * sabe leerlos. Va a graph.instagram.com. La lista de páginas, en cambio, es
 * del lado de Facebook y necesita el token de usuario, no el de Instagram.
 */
const INSTAGRAM = { base: `https://graph.instagram.com/${GRAPH_VERSION}`, token: () => process.env.META_IG_ACCESS_TOKEN || '' };
const FACEBOOK = { base: `https://graph.facebook.com/${GRAPH_VERSION}`, token: () => process.env.META_ACCESS_TOKEN || '' };

/**
 * Llama a Graph y devuelve { ok, datos } o { ok:false, motivo }.
 *
 * Los errores de Graph llegan con la descripción dentro del cuerpo y con
 * códigos HTTP que no siempre son 200/400, así que se lee el cuerpo siempre.
 * El mensaje de Meta se devuelve tal cual porque es lo único que permite
 * distinguir "token vencido" de "falta el permiso" de "la cuenta no es
 * profesional", y esa diferencia es justo la que hay que ver al grabar.
 */
async function graph(destino, ruta, params) {
  return graphConToken(destino, ruta, destino.token(), params);
}

/** Igual que graph(), pero con el token de una cuenta concreta. */
async function graphConToken(destino, ruta, token, params) {
  if (!token) return { ok: false, motivo: 'Falta configurar el token de Meta en el servidor' };

  const url = new URL(`${destino.base}${ruta}`);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  url.searchParams.set('access_token', token);

  let res;
  let cuerpo;
  try {
    res = await fetch(url.toString());
    cuerpo = await res.json();
  } catch (e) {
    logger.warn('Graph no respondió', { ruta, error: e.message });
    return { ok: false, motivo: 'Meta no respondió' };
  }

  if (!res.ok || cuerpo.error) {
    const motivo = (cuerpo.error && cuerpo.error.message) || `Meta respondió ${res.status}`;
    // Se registra la ruta y el motivo, nunca la URL: lleva el token.
    logger.warn('Graph devolvió error', { ruta, motivo });
    return { ok: false, motivo };
  }
  return { ok: true, datos: cuerpo };
}

// GET /api/canales/instagram/autorizar - A dónde mandar a la persona a
// autorizar su cuenta. La URL se arma en el servidor para que el
// identificador de la app y los permisos vivan en un solo sitio.
router.get('/instagram/autorizar', verifyToken, (req, res) => {
  if (!configurado()) {
    return res.status(503).json({ error: 'Falta configurar la app de Instagram en el servidor' });
  }
  res.json({ success: true, data: { url: urlDeAutorizacion() } });
});

/**
 * GET /api/canales/instagram - La cuenta conectada.
 *
 * Sale de app.cuentas_meta, no de una constante: cada negocio conecta la suya,
 * y el panel tiene que mostrar la que esa persona acaba de autorizar. El
 * perfil se lee en vivo con el token de esa misma cuenta, así que si el token
 * caducó se nota aquí en vez de fallar callado a la hora de responder.
 */
router.get('/instagram', verifyToken, async (req, res, next) => {
  try {
    if (!sb.activo()) return res.json({ success: true, data: { conectado: false, motivo: 'Almacenamiento no disponible' } });

    const filas = await sb.select('cuentas_meta',
      'select=cuenta_id,usuario,nombre,foto,expira_en,conectada_en&plataforma=eq.instagram&order=actualizada_en.desc&limit=1');
    const cuenta = filas && filas[0];
    if (!cuenta) {
      return res.json({ success: true, data: { conectado: false, motivo: 'Ninguna cuenta autorizada todavía' } });
    }

    // El token de ESA cuenta, nunca uno global.
    let token = null;
    try {
      token = await sb.rpc('token_cuenta_meta', { p_plataforma: 'instagram', p_cuenta_id: cuenta.cuenta_id });
    } catch (error) {
      logger.warn('No se pudo leer el token de la cuenta', { error: error.message });
    }

    const base = {
      conectado: true,
      id: cuenta.cuenta_id,
      usuario: cuenta.usuario,
      nombre: cuenta.nombre,
      foto: cuenta.foto,
      conectada_en: cuenta.conectada_en,
      expira_en: cuenta.expira_en
    };

    if (!token) return res.json({ success: true, data: { ...base, motivo: 'No se pudo leer el token guardado' } });

    const r = await graphConToken(INSTAGRAM, `/${cuenta.cuenta_id}`, token, {
      fields: 'id,username,name,profile_picture_url,followers_count,media_count'
    });
    if (!r.ok) return res.json({ success: true, data: { ...base, motivo: r.motivo } });

    const p = r.datos;
    res.json({
      success: true,
      data: {
        ...base,
        usuario: p.username || base.usuario,
        nombre: p.name || base.nombre,
        foto: p.profile_picture_url || base.foto,
        seguidores: typeof p.followers_count === 'number' ? p.followers_count : null,
        publicaciones: typeof p.media_count === 'number' ? p.media_count : null
      }
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/canales/paginas - Páginas de Facebook a las que la app accede.
router.get('/paginas', verifyToken, async (req, res, next) => {
  try {
    const r = await graph(FACEBOOK, '/me/accounts', { fields: 'id,name,category' });
    if (!r.ok) return res.json({ success: true, data: { paginas: [], motivo: r.motivo } });

    const paginas = (r.datos.data || []).map((p) => ({
      id: p.id,
      nombre: p.name,
      categoria: p.category || null
    }));
    res.json({ success: true, data: { paginas } });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
