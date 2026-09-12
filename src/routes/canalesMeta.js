const express = require('express');
const { verifyToken } = require('../middleware/auth');
const logger = require('../utils/logger');

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
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

// El token de Instagram es distinto del de WhatsApp (los generó Meta en flujos
// distintos), pero si solo hay uno configurado se usa ese.
const tokenIG = () => process.env.META_IG_ACCESS_TOKEN || process.env.META_ACCESS_TOKEN || '';

/**
 * Llama a Graph y devuelve { ok, datos } o { ok:false, motivo }.
 *
 * Los errores de Graph llegan con la descripción dentro del cuerpo y con
 * códigos HTTP que no siempre son 200/400, así que se lee el cuerpo siempre.
 * El mensaje de Meta se devuelve tal cual porque es lo único que permite
 * distinguir "token vencido" de "falta el permiso" de "la cuenta no es
 * profesional", y esa diferencia es justo la que hay que ver al grabar.
 */
async function graph(ruta, params) {
  const token = tokenIG();
  if (!token) return { ok: false, motivo: 'Falta configurar el token de Meta en el servidor' };

  const url = new URL(`${GRAPH}${ruta}`);
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

// GET /api/canales/instagram - Perfil de la cuenta profesional conectada.
router.get('/instagram', verifyToken, async (req, res, next) => {
  try {
    const id = process.env.META_IG_USER_ID;
    if (!id) {
      return res.json({
        success: true,
        data: { conectado: false, motivo: 'Falta configurar la cuenta de Instagram en el servidor' }
      });
    }

    const r = await graph(`/${id}`, {
      fields: 'id,username,name,profile_picture_url,followers_count,media_count'
    });
    if (!r.ok) return res.json({ success: true, data: { conectado: false, motivo: r.motivo } });

    const p = r.datos;
    res.json({
      success: true,
      data: {
        conectado: true,
        id: p.id,
        usuario: p.username,
        nombre: p.name || null,
        foto: p.profile_picture_url || null,
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
    const r = await graph('/me/accounts', { fields: 'id,name,category' });
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
