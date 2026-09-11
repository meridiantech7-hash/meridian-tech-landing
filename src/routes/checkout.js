const express = require('express');
const QRCode = require('qrcode');
const rateLimit = require('express-rate-limit');
const { dbGet, dbRun } = require('../config/database');
const boldService = require('../services/boldService');
const { datosDeTransferencia } = require('../services/ventaService');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * Página de pago alojada por nosotros.
 *
 * Hace falta porque el botón de Bold es un componente de página web, no un
 * enlace que se pueda enviar suelto por WhatsApp: necesita el script de Bold
 * corriendo en un navegador. Así que servimos una página por cada orden y lo
 * que viaja por el chat es su URL.
 *
 * La firma de integridad se calcula acá, en el servidor. Bold lo exige y la
 * razón es obvia: si se calculara en el navegador habría que mandarle la llave
 * secreta al cliente.
 */

const APP_URL = (process.env.APP_URL || 'https://meridiantech.app').replace(/\/$/, '');

const pesos = (n) => '$' + Number(n || 0).toLocaleString('es-CO');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

/** Estilos compartidos: la identidad de la landing, para que no parezca otro sitio. */
const ESTILOS = `
  :root{
    --black:#000; --surf:#0A0B0F; --line:#1C1E26; --mut:#6E7383;
    --txt:#EDEFF5; --white:#fff; --blue:#2B4BFF; --blue-lt:#7FA2FF; --green:#3FBF8F;
    --sans:'Archivo',system-ui,-apple-system,'Segoe UI',sans-serif;
    --mono:'IBM Plex Mono',ui-monospace,Menlo,monospace;
  }
  *{box-sizing:border-box}
  body{
    margin:0;background:var(--black);color:var(--txt);font-family:var(--sans);
    min-height:100vh;display:flex;flex-direction:column;align-items:center;
    justify-content:center;padding:24px;line-height:1.6;
  }
  .marca{font-weight:700;letter-spacing:.02em;margin-bottom:28px;font-size:19px;color:var(--white)}
  .marca span{color:var(--blue-lt)}
  .tarjeta{
    background:var(--surf);border:1px solid var(--line);border-radius:20px;
    padding:32px;max-width:440px;width:100%;
  }
  .eti{
    font-family:var(--mono);font-size:12px;text-transform:uppercase;
    letter-spacing:.1em;color:var(--mut);margin-bottom:8px;
  }
  h1{font-size:26px;margin:0 0 4px;line-height:1.2}
  .monto{font-size:40px;font-weight:700;margin:18px 0 2px;font-variant-numeric:tabular-nums}
  .periodo{color:var(--mut);font-size:15px;margin-bottom:26px}
  .fila{
    display:flex;justify-content:space-between;gap:16px;padding:11px 0;
    border-bottom:1px solid var(--line);font-size:15px;
  }
  .fila span:first-child{color:var(--mut)}
  .fila code{font-family:var(--mono);font-size:13px}
  .boton-zona{margin-top:26px;display:flex;justify-content:center;min-height:56px}
  .nota{color:var(--mut);font-size:13px;margin-top:22px;text-align:center}
  .estado{
    display:inline-flex;align-items:center;gap:8px;padding:7px 14px;border-radius:999px;
    font-size:13px;font-weight:600;margin-bottom:18px;
  }
  .estado.ok{background:rgba(63,191,143,.14);color:var(--green)}
  .estado.pend{background:rgba(127,162,255,.14);color:var(--blue-lt)}
  .estado.mal{background:rgba(255,92,92,.14);color:#ff5c5c}
  a{color:var(--blue-lt)}
  .pie{margin-top:30px;color:var(--mut);font-size:13px;text-align:center}
`;

const CABEZA = (titulo) => `<!DOCTYPE html>
<html lang="es-CO"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(titulo)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>${ESTILOS}</style>
</head><body>
<div class="marca">MERIDIAN<span>TECH</span></div>`;

const PIE = `<div class="pie">MERIDIAN TECH S.A.S. · NIT 902100512-0<br>
<a href="/privacidad">Privacidad</a> · <a href="/terminos">Términos</a></div>
</body></html>`;

const paginaSimple = (titulo, claseEstado, textoEstado, cuerpo) => `${CABEZA(titulo)}
<div class="tarjeta">
  <div class="estado ${claseEstado}">${esc(textoEstado)}</div>
  ${cuerpo}
</div>${PIE}`;

// ── Compra desde la web: elegir plan y pagar ────────────────────────────────
//
// Estas rutas van ANTES de /:orderId porque si no, "/pagar/plan/2" caería en
// el manejador de órdenes buscando una orden llamada "plan".
//
// Pide nombre y WhatsApp antes de cobrar. No es un trámite de más: hay que
// saber a quién instalarle el sistema, y si abandona el pago igual queda el
// prospecto con su teléfono para que alguien lo llame.

/** Límite propio: /pagar no está bajo /api, así que el limitador global no aplica. */
const limitePago = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  message: { error: 'Demasiados intentos. Espera unos minutos.' }
});

router.get('/plan/:planId', async (req, res, next) => {
  try {
    const plan = await dbGet(
      "SELECT * FROM plans WHERE id = ? AND status = 'active'",
      [req.params.planId]
    );
    if (!plan) {
      return res.status(404).send(paginaSimple(
        'Plan no encontrado — MeridianTech', 'mal', 'No encontrado',
        `<h1>Ese plan no está disponible</h1>
         <p style="color:#C9CDD8">Mira los planes en <a href="/">meridiantech.app</a>
         o escríbenos al <a href="https://wa.me/573142162323">+57 314 216 2323</a>.</p>`
      ));
    }

    res.send(`${CABEZA(`Contratar ${plan.name} — MeridianTech`)}
<div class="tarjeta">
  <div class="eti">Vas a contratar</div>
  <h1>${esc(plan.name)}</h1>
  <div class="monto">${pesos(plan.price)}</div>
  <div class="periodo">COP · pago mensual</div>

  <form method="POST" action="/pagar/plan/${plan.id}" style="display:flex;flex-direction:column;gap:14px;margin-top:8px">
    <label style="display:block">
      <span class="eti">Tu nombre</span>
      <input name="nombre" required maxlength="80" autocomplete="name"
        style="width:100%;padding:13px;border-radius:10px;border:1px solid var(--line);background:var(--black);color:var(--txt);font-size:16px;font-family:inherit">
    </label>
    <label style="display:block">
      <span class="eti">WhatsApp</span>
      <input name="whatsapp" required maxlength="20" inputmode="tel" placeholder="300 123 4567" autocomplete="tel"
        style="width:100%;padding:13px;border-radius:10px;border:1px solid var(--line);background:var(--black);color:var(--txt);font-size:16px;font-family:inherit">
    </label>
    <label style="display:block">
      <span class="eti">Nombre del negocio</span>
      <input name="empresa" maxlength="80" autocomplete="organization"
        style="width:100%;padding:13px;border-radius:10px;border:1px solid var(--line);background:var(--black);color:var(--txt);font-size:16px;font-family:inherit">
    </label>
    <button type="submit"
      style="margin-top:6px;padding:16px;border:none;border-radius:12px;background:var(--blue);color:#fff;font-weight:700;font-size:16px;font-family:inherit;cursor:pointer">
      Continuar al pago
    </button>
  </form>

  <p class="nota">Al continuar aceptas nuestros <a href="/terminos">términos</a> y
  la <a href="/privacidad">política de privacidad</a>.</p>
</div>${PIE}`);
  } catch (error) {
    next(error);
  }
});

router.post('/plan/:planId', limitePago, async (req, res, next) => {
  try {
    const plan = await dbGet(
      "SELECT * FROM plans WHERE id = ? AND status = 'active'",
      [req.params.planId]
    );
    if (!plan) return res.redirect(302, '/');

    const nombre = String(req.body.nombre || '').trim().slice(0, 80);
    const whatsapp = String(req.body.whatsapp || '').replace(/\D/g, '').slice(0, 20);
    const empresa = String(req.body.empresa || '').trim().slice(0, 80);

    if (!nombre || whatsapp.length < 7) {
      return res.status(400).send(paginaSimple(
        'Datos incompletos — MeridianTech', 'mal', 'Faltan datos',
        `<h1>Necesitamos tu nombre y WhatsApp</h1>
         <p style="color:#C9CDD8"><a href="/pagar/plan/${plan.id}">Volver al formulario</a></p>`
      ));
    }

    // Número en formato internacional colombiano, que es el que usa WhatsApp.
    const telefono = whatsapp.startsWith('57') ? whatsapp : `57${whatsapp}`;

    let cliente = await dbGet('SELECT * FROM clients WHERE phone = ?', [telefono]);
    if (!cliente) {
      const creado = await dbRun(
        `INSERT INTO clients (name, email, phone, company, status, notes)
         VALUES (?, ?, ?, ?, 'prospect', 'Vino del botón de pago de la web')`,
        [nombre, `${telefono}@web.prospecto`, telefono, empresa || null]
      );
      cliente = await dbGet('SELECT * FROM clients WHERE id = ?', [creado.id]);
      logger.info('Prospecto creado desde la web', { clientId: cliente.id, plan: plan.name });
    }

    const orderId = boldService.generateOrderId(cliente.id, plan.id);
    const descripcion = `MeridianTech - Plan ${plan.name}`;

    const link = await boldService.crearLinkDePago({
      reference: orderId,
      amount: plan.price,
      currency: plan.currency || 'COP',
      description: descripcion,
      callbackUrl: `${APP_URL}/pagar/${orderId}`
    });

    // Si Bold no da el link, se cobra por transferencia igual que por WhatsApp.
    // Antes esta página devolvía "pago no disponible": un cliente que ya había
    // decidido comprar se quedaba sin forma de pagar desde la web.
    const transferencia = !link.ok ? datosDeTransferencia() : null;
    if (!link.ok && transferencia) {
      await dbRun(
        `INSERT INTO transactions
          (client_id, plan_id, amount, currency, status, bold_transaction_id, description, payment_method)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, 'transferencia')`,
        [cliente.id, plan.id, plan.price, plan.currency || 'COP', orderId, descripcion]
      );
      logger.info('Cobro web por transferencia (Bold no disponible)', { orderId, clientId: cliente.id, plan: plan.name });

      const monto = '$' + Number(plan.price).toLocaleString('es-CO');
      const aviso = encodeURIComponent(
        `Hola, ya transferí el plan ${plan.name} (${monto}). Referencia ${orderId}. Te envío el comprobante.`
      );
      return res.status(200).send(paginaSimple(
        'Pagar por transferencia — MeridianTech', 'ok', 'Casi listo',
        `<h1>Plan ${esc(plan.name)} · ${esc(monto)} COP / mes</h1>
         <p style="color:#C9CDD8">Transfiere a esta llave desde tu banco o billetera:</p>
         <p style="font-size:1.6rem;font-weight:700;letter-spacing:.02em;margin:6px 0 2px">${esc(transferencia.llave)}</p>
         <p style="color:#C9CDD8;margin-top:0">${esc(transferencia.titular)} · NIT ${esc(transferencia.nit)}${transferencia.banco ? ' · ' + esc(transferencia.banco) : ''}</p>
         <p style="color:#C9CDD8">Referencia de tu compra: <b>${esc(orderId)}</b></p>
         <p style="color:#C9CDD8">Cuando transfieras, mándanos el comprobante por WhatsApp y activamos tu plan.</p>
         <p><a class="btn" href="https://wa.me/573142162323?text=${aviso}">Enviar comprobante por WhatsApp</a></p>`
      ));
    }

    if (!link.ok) {
      logger.error('No se pudo crear el link de pago desde la web', { orderId, motivo: link.motivo });
      return res.status(503).send(paginaSimple(
        'Pago temporalmente no disponible — MeridianTech', 'mal', 'No disponible',
        `<h1>No pudimos generar el pago</h1>
         <p style="color:#C9CDD8">Escríbenos al <a href="https://wa.me/573142162323">+57 314 216 2323</a>
         y lo hacemos por WhatsApp.</p>`
      ));
    }

    await dbRun(
      `INSERT INTO transactions
        (client_id, plan_id, amount, currency, status, bold_transaction_id, bold_payment_link, bold_payment_url, description)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
      [cliente.id, plan.id, plan.price, plan.currency || 'COP', orderId, link.paymentLink, link.url, descripcion]
    );

    logger.info('Cobro creado desde la web', { orderId, clientId: cliente.id, plan: plan.name });
    res.redirect(303, `/pagar/${orderId}`);
  } catch (error) {
    next(error);
  }
});

// ── Página de pago ──────────────────────────────────────────────────────────
router.get('/:orderId', async (req, res, next) => {
  try {
    const orderId = req.params.orderId;

    const tx = await dbGet(
      'SELECT * FROM transactions WHERE bold_transaction_id = ?',
      [orderId]
    );

    if (!tx) {
      return res.status(404).send(paginaSimple(
        'Cobro no encontrado — MeridianTech', 'mal', 'No encontrado',
        `<h1>Este enlace no es válido</h1>
         <p style="color:#C9CDD8">No encontramos un cobro con ese identificador.
         Puede que el enlace esté incompleto. Escríbenos por WhatsApp al
         <a href="https://wa.me/573142162323">+57 314 216 2323</a> y te lo generamos de nuevo.</p>`
      ));
    }

    const plan = await dbGet('SELECT * FROM plans WHERE id = ?', [tx.plan_id]);

    // Ya pagado: mostrarlo en vez de dejar que pague dos veces.
    if (tx.status === 'completed') {
      return res.send(paginaSimple(
        'Pago confirmado — MeridianTech', 'ok', '✓ Pago confirmado',
        `<h1>Ya recibimos tu pago</h1>
         <p style="color:#C9CDD8">Plan ${esc(plan?.name || '')} · ${pesos(tx.amount)}</p>
         <div class="fila"><span>Referencia</span><code>${esc(orderId)}</code></div>
         <p class="nota">Una persona del equipo te contacta para coordinar la implementación.</p>`
      ));
    }

    // El link real de pago ya se creó cuando se generó el cobro (ventaService
    // o el formulario de la web) — esta página ya NO aloja el pago en sí
    // (ese era el Botón de Pagos, el producto equivocado para esta cuenta).
    // Ahora es solo un redirector al checkout real de Bold.
    if (!tx.bold_payment_url) {
      logger.error('Cobro sin link de pago de Bold — se creó antes de la migración o Bold falló', { orderId });
      return res.status(503).send(paginaSimple(
        'Pago temporalmente no disponible — MeridianTech', 'mal', 'No disponible',
        `<h1>Este link de pago quedó incompleto</h1>
         <p style="color:#C9CDD8">Escríbenos al <a href="https://wa.me/573142162323">+57 314 216 2323</a>
         y te generamos uno nuevo.</p>`
      ));
    }

    logger.info('Redirigiendo al checkout real de Bold', { orderId });
    res.redirect(302, tx.bold_payment_url);
  } catch (error) {
    next(error);
  }
});

// ── QR del cobro ────────────────────────────────────────────────────────────
/**
 * Devuelve el QR como PNG. Se genera al vuelo en vez de guardarse: es
 * instantáneo, no ocupa disco, y así el QR nunca queda desincronizado del
 * cobro. Se manda por WhatsApp como imagen para quien prefiere escanear.
 */
router.get('/:orderId/qr.png', async (req, res, next) => {
  try {
    const orderId = req.params.orderId;
    const tx = await dbGet(
      'SELECT id, bold_payment_url FROM transactions WHERE bold_transaction_id = ?', [orderId]
    );
    if (!tx) return res.sendStatus(404);

    // El QR codifica el checkout real de Bold directamente — no nuestra
    // página, que ahora es solo un redirector (un salto de más al escanear).
    const destino = tx.bold_payment_url || `${APP_URL}/pagar/${orderId}`;
    const png = await QRCode.toBuffer(destino, {
      type: 'png',
      width: 600,
      margin: 2,
      errorCorrectionLevel: 'M',
      // Fondo blanco a propósito: los lectores de QR fallan con fondo oscuro.
      color: { dark: '#000000', light: '#FFFFFF' }
    });

    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(png);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
