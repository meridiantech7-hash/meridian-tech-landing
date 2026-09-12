const express = require('express');
const crypto = require('crypto');
const sb = require('../services/supabaseApp');
const logger = require('../utils/logger');

/**
 * Los dos endpoints de privacidad que Meta exige antes de revisar la app:
 *
 *   - Desautorización: Meta avisa aquí cuando alguien quita la app, para que
 *     dejemos de guardar sus datos.
 *   - Eliminación de datos: Meta manda aquí la solicitud de borrado y espera
 *     una respuesta con una URL de estado y un código de confirmación con el
 *     que la persona pueda hacer seguimiento.
 *
 * Los dos llegan como POST con un `signed_request`: dos partes separadas por
 * punto, la firma y el cuerpo, ambas en base64url. La firma es un HMAC-SHA256
 * del cuerpo con la clave secreta de la app. Se verifica de verdad, porque sin
 * eso cualquiera podría disparar borrados de datos ajenos mandando un POST.
 *
 * Se prueban las dos claves que tenemos, la de la app principal y la de la
 * sub-app de Instagram, porque Meta firma con la de la app que origina el
 * evento. Es el mismo motivo por el que la verificación de firma del webhook
 * necesitó dos llaves.
 */

const router = express.Router();

const claves = () => [process.env.META_APP_SECRET, process.env.META_IG_APP_SECRET]
  .filter((c) => typeof c === 'string' && c.trim().length > 0);

const deBase64Url = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/**
 * Devuelve el cuerpo del signed_request si la firma cuadra con alguna de
 * nuestras claves, o null. Nunca lanza: un cuerpo mal formado es simplemente
 * inválido.
 */
function abrirSignedRequest(signed) {
  if (typeof signed !== 'string' || !signed.includes('.')) return null;
  const partes = signed.split('.');
  const firmaB64 = partes[0];
  const cuerpoB64 = partes[1];
  if (!firmaB64 || !cuerpoB64) return null;

  let firma;
  try { firma = deBase64Url(firmaB64); } catch (e) { return null; }

  for (const clave of claves()) {
    const esperada = crypto.createHmac('sha256', clave.trim()).update(cuerpoB64).digest();
    // timingSafeEqual exige el mismo largo; si difiere, no puede ser la firma.
    if (esperada.length === firma.length && crypto.timingSafeEqual(esperada, firma)) {
      try { return JSON.parse(deBase64Url(cuerpoB64).toString('utf8')); }
      catch (e) { return null; }
    }
  }
  return null;
}

// Código corto y legible, para que se pueda dictar sin ambigüedades.
const nuevoCodigo = () => 'MT-' + crypto.randomBytes(5).toString('hex').toUpperCase();

async function registrar(tipo, usuario, detalle) {
  const codigo = nuevoCodigo();
  if (sb.activo()) {
    try {
      await sb.insertar('solicitudes_privacidad', {
        tipo,
        codigo,
        plataforma: 'instagram',
        usuario_externo: usuario ? String(usuario) : null,
        detalle: detalle || null
      });
    } catch (error) {
      // El código ya se le va a prometer a Meta; que falle el registro no
      // puede tumbar la respuesta. Queda en el log para reconstruirlo a mano.
      logger.error('No se pudo registrar la solicitud de privacidad', { tipo, codigo, error: error.message });
    }
  }
  return codigo;
}

const BASE = (process.env.APP_URL || 'https://meridiantech.app').replace(/\/+$/, '');

const escapar = (v) => String(v == null ? '' : v).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const pagina = (cuerpo) => `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Eliminación de datos · MeridianTech</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;
    background:#0b0f14;color:#e8edf3;
    font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
  main{width:100%;max-width:520px;background:#121821;border:1px solid #1f2a37;
    border-radius:16px;padding:32px 28px}
  .marca{font-size:13px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;
    color:#93a4b8;margin:0 0 20px}
  h1{font-size:22px;line-height:1.25;margin:0 0 12px}
  p{margin:0 0 14px;color:#93a4b8}
  p:last-child{margin-bottom:0}
  .codigo{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#e8edf3}
  a{color:#2d6cff;font-weight:600}
</style></head>
<body><main><p class="marca">MeridianTech</p>${cuerpo}</main></body></html>`;

// POST /instagram/desautorizado - Meta avisa que alguien quitó la app.
router.post('/instagram/desautorizado', async (req, res) => {
  const datos = abrirSignedRequest(req.body && req.body.signed_request);
  if (!datos) {
    logger.warn('Desautorización con signed_request inválido');
    return res.status(400).json({ error: 'signed_request inválido' });
  }
  const codigo = await registrar('desautorizacion', datos.user_id, null);
  logger.info('Desautorización recibida', { codigo });
  res.json({ ok: true, confirmation_code: codigo });
});

// POST /datos/eliminar - Solicitud de borrado. Meta espera url + código.
router.post('/datos/eliminar', async (req, res) => {
  const datos = abrirSignedRequest(req.body && req.body.signed_request);
  if (!datos) {
    logger.warn('Solicitud de eliminación con signed_request inválido');
    return res.status(400).json({ error: 'signed_request inválido' });
  }
  const codigo = await registrar('eliminacion', datos.user_id, null);
  logger.info('Solicitud de eliminación recibida', { codigo });
  res.json({
    url: `${BASE}/datos/eliminar/estado?codigo=${encodeURIComponent(codigo)}`,
    confirmation_code: codigo
  });
});

/**
 * Página de estado. Es la URL que Meta le muestra a la persona, así que tiene
 * que abrir en un navegador y decir algo cierto: si el código existe, en qué
 * va; si no existe, que no existe. Sin código, explica el trámite.
 */
router.get('/datos/eliminar/estado', async (req, res) => {
  const codigo = typeof req.query.codigo === 'string' ? req.query.codigo.trim() : '';
  let estado = null;
  if (codigo && sb.activo()) {
    try {
      const filas = await sb.select('solicitudes_privacidad',
        `select=codigo,tipo,recibida_en,atendida_en&codigo=eq.${encodeURIComponent(codigo)}&limit=1`);
      estado = filas && filas[0] ? filas[0] : null;
    } catch (error) {
      logger.error('No se pudo consultar la solicitud de privacidad', { error: error.message });
    }
  }

  let cuerpo;
  if (!codigo) {
    cuerpo = `<h1>Eliminación de datos</h1>
      <p>Si quieres que borremos la información asociada a tu cuenta, escríbenos a
      <a href="mailto:meridiantech7@gmail.com">meridiantech7@gmail.com</a> y la eliminamos
      en un plazo máximo de 30 días.</p>
      <p>Si ya tienes un código de confirmación, abre el enlace que te entregó Meta.</p>`;
  } else if (!estado) {
    cuerpo = `<h1>No encontramos ese código</h1>
      <p>El código <span class="codigo">${escapar(codigo)}</span> no corresponde a ninguna
      solicitud registrada. Revisa que esté completo, o escríbenos a
      <a href="mailto:meridiantech7@gmail.com">meridiantech7@gmail.com</a>.</p>`;
  } else if (estado.atendida_en) {
    cuerpo = `<h1>Datos eliminados</h1>
      <p>La solicitud <span class="codigo">${escapar(codigo)}</span> se completó el
      ${escapar(String(estado.atendida_en).slice(0, 10))}. Ya no conservamos la información
      asociada a esa cuenta.</p>`;
  } else {
    cuerpo = `<h1>Solicitud en trámite</h1>
      <p>Recibimos la solicitud <span class="codigo">${escapar(codigo)}</span> el
      ${escapar(String(estado.recibida_en).slice(0, 10))} y la estamos procesando. El plazo
      máximo es de 30 días desde esa fecha.</p>`;
  }

  res.type('html').send(pagina(cuerpo));
});

// Meta y las personas a veces abren estas URL con GET. Que respondan algo
// sensato en vez de la landing, que fue el error de la primera vez.
router.get('/instagram/desautorizado', (req, res) => {
  res.type('html').send(pagina(`<h1>Autorización cancelada</h1>
    <p>Este punto recibe los avisos de Meta cuando una cuenta deja de autorizar a
    Meridian. Si además quieres que eliminemos tus datos, pídelo en
    <a href="/datos/eliminar/estado">esta página</a>.</p>`));
});

router.get('/datos/eliminar', (req, res) => res.redirect(302, '/datos/eliminar/estado'));

module.exports = router;
