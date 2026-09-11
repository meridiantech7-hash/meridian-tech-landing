const axios = require('axios');
const { dbAll, dbGet } = require('../config/database');
const logger = require('../utils/logger');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

/**
 * Reportes de negocio por WhatsApp administrativo (Pro: 2/mes con lo que el
 * dueño pida; Premium: 4/mes con análisis de mercado y plan de acción).
 *
 * Mismo principio que el resto del candado del dueño (ownerService.js): los
 * NÚMEROS salen de una consulta real a la base, nunca de que el modelo los
 * adivine — la IA solo interpreta y redacta sobre datos que ya se calcularon
 * en código. Lo único que varía por plan es cuánto se le pide razonar sobre
 * esos datos.
 */

const FRASES_REPORTE = [
  'dame un reporte', 'hazme un reporte', 'quiero un reporte', 'necesito un reporte',
  'un informe', 'cómo van las ventas', 'como van las ventas', 'análisis de mi negocio',
  'analisis de mi negocio', 'análisis de ventas', 'analisis de ventas',
  'cómo va el negocio', 'como va el negocio', 'plan de acción', 'plan de accion'
];

const normalizar = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

const esSolicitudDeReporte = (texto) => {
  const t = normalizar(texto);
  if (!t) return false;
  return FRASES_REPORTE.some((f) => t.includes(normalizar(f)));
};

/** Igual criterio de "mes calendario Colombia" que ya usa reservations.js para "hoy". */
const FILTRO_MES_COLOMBIA = `strftime('%Y-%m', datetime(created_at, '-5 hours')) = strftime('%Y-%m', datetime('now', '-5 hours'))`;

/** Datos reales del mes — sin IA, consulta directa. */
const recolectarDatosDelMes = async (clientId) => {
  const pedidos = await dbAll(
    `SELECT items, total, status FROM orders WHERE client_id = ? AND status != 'cancelado' AND ${FILTRO_MES_COLOMBIA}`,
    [clientId]
  );
  const totalVentas = pedidos.reduce((s, p) => s + (p.total || 0), 0);

  const conteoItems = {};
  for (const pedido of pedidos) {
    let items = [];
    try { items = JSON.parse(pedido.items || '[]'); } catch (e) { /* items mal formado, se ignora */ }
    for (const it of items) {
      const nombre = (it.nombre || '').trim();
      if (!nombre) continue;
      conteoItems[nombre] = (conteoItems[nombre] || 0) + (Number(it.cantidad) || 1);
    }
  }
  const masPedidos = Object.entries(conteoItems)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([nombre, cantidad]) => `${nombre} (${cantidad})`);

  const { total: reservasDelMes } = await dbGetSeguro(
    `SELECT COUNT(*) as total FROM reservations WHERE client_id = ? AND status != 'cancelada' AND ${FILTRO_MES_COLOMBIA.replace(/created_at/g, 'scheduled_at')}`,
    [clientId]
  );

  const { total: conversacionesNuevas } = await dbGetSeguro(
    `SELECT COUNT(*) as total FROM conversations WHERE client_id = ? AND ${FILTRO_MES_COLOMBIA}`,
    [clientId]
  );

  return {
    pedidos: pedidos.length,
    totalVentas,
    masPedidos,
    reservasDelMes: reservasDelMes || 0,
    conversacionesNuevas: conversacionesNuevas || 0
  };
};

/** dbGet devuelve undefined si no hay fila — esto siempre da un objeto usable. */
async function dbGetSeguro(sql, params) {
  const fila = await dbGet(sql, params);
  return fila || { total: 0 };
}

/** Productos por agotarse — solo se llama para clientes Premium. */
const productosBajoStock = async (clientId) => {
  return dbAll(
    `SELECT name, stock_quantity, low_stock_threshold, unit FROM products
     WHERE client_id = ? AND status = 'active' AND stock_quantity <= low_stock_threshold`,
    [clientId]
  );
};

const construirPrompt = (plan, datos, bajoStock, solicitud) => {
  const resumen = `
DATOS REALES DE ESTE MES (no inventes ni cambies ninguno de estos números):
- Pedidos: ${datos.pedidos}, por un total de $${datos.totalVentas.toLocaleString('es-CO')} COP
- Más pedidos: ${datos.masPedidos.length ? datos.masPedidos.join(', ') : 'sin datos suficientes todavía'}
- Reservas del mes: ${datos.reservasDelMes}
- Conversaciones nuevas con clientes: ${datos.conversacionesNuevas}
${bajoStock.length ? `- Productos por agotarse: ${bajoStock.map((p) => `${p.name} (quedan ${p.stock_quantity} ${p.unit})`).join(', ')}` : ''}

LO QUE PIDIÓ EL DUEÑO: "${solicitud}"`;

  if (plan.name === 'Premium') {
    return `Eres el asesor de ventas y marketing de este negocio, dentro de su bot de WhatsApp. Con los datos reales de abajo, da un análisis breve de qué está funcionando y qué no, y un plan de acción concreto y priorizado (máximo 5 puntos) para lo que pidió el dueño. Si hay productos por agotarse, menciónalo como parte del plan. Nunca inventes una cifra que no esté en los datos — si algo no se puede saber con lo que hay, dilo. Responde en español de Colombia, listo para leer por WhatsApp (sin markdown de encabezados).
${resumen}`;
  }

  return `Respondes reportes de negocio dentro de un bot de WhatsApp. Con los datos reales de abajo, responde EXACTAMENTE lo que pidió el dueño — sin agregar análisis que no pidió, sin inventar ninguna cifra que no esté aquí. Si lo que pide no se puede responder con estos datos, dilo con honestidad. Responde en español de Colombia, listo para leer por WhatsApp (sin markdown de encabezados).
${resumen}`;
};

/**
 * Genera y devuelve el texto del reporte. Quien llama es responsable de
 * verificar el cupo del plan ANTES de llamar esto (planService) y de
 * registrar el uso DESPUÉS de que se mande con éxito.
 */
const generarReporte = async (clientId, plan, solicitud) => {
  const datos = await recolectarDatosDelMes(clientId);
  const bajoStock = plan.name === 'Premium' ? await productosBajoStock(clientId) : [];
  const prompt = construirPrompt(plan, datos, bajoStock, solicitud || 'un reporte general del negocio');

  if (!GEMINI_API_KEY) {
    return 'No puedo generar el reporte ahora mismo — falta la configuración de IA. Avísale al equipo de MeridianTech.';
  }

  try {
    const { data } = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`,
      {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 600 }
      },
      { headers: { 'Content-Type': 'application/json' }, timeout: 20000 }
    );

    const texto = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    return texto ? texto.trim() : 'No pude armar el reporte con los datos de este mes — intenta de nuevo en un momento.';
  } catch (error) {
    logger.warn('Fallo generando reporte por WhatsApp', {
      clientId, error: error.response?.data?.error?.message || error.message
    });
    return 'Tuve un problema generando el reporte — intenta de nuevo en un momento.';
  }
};

module.exports = { esSolicitudDeReporte, generarReporte, recolectarDatosDelMes };
