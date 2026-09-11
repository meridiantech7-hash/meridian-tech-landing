const axios = require('axios');
const { dbAll, dbGet, dbRun } = require('../config/database');
const logger = require('../utils/logger');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

/**
 * Inventario en tiempo real (plan Premium). Dos formas de moverlo:
 * 1. El dueño lo ajusta por WhatsApp en lenguaje natural (ajustarInventario) —
 *    la IA solo INTERPRETA qué producto y qué cantidad, nunca decide el
 *    número: viene siempre del texto que el dueño escribió, igual patrón
 *    que aplicarCambioMenu en ownerService.js.
 * 2. Se descuenta solo cuando una orden se confirma de verdad
 *    (descontarPorOrden, enganchado en POST /api/orders/:id/confirm) — una
 *    orden en "por_confirmar" es solo lo que la IA creyó entender del chat,
 *    no algo que ya vaya a salir del inventario.
 */

const FRASES_INVENTARIO = [
  'agrega', 'agregar', 'suma', 'sumar', 'quedan', 'quedaron', 'actualiza el inventario',
  'actualizar inventario', 'resta', 'restar', 'descuenta', 'se acabó', 'se acabo',
  'nuevo producto', 'inventario de'
];

const normalizar = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

const esComandoInventario = (texto) => {
  const t = normalizar(texto);
  if (!t) return false;
  return FRASES_INVENTARIO.some((f) => t.includes(normalizar(f)));
};

/**
 * Interpreta el texto del dueño y aplica el ajuste. Devuelve { ok, mensaje }
 * listo para mandar por WhatsApp — nunca aplica un número que no haya
 * dicho el dueño explícitamente.
 */
const ajustarInventario = async (clientId, texto) => {
  if (!GEMINI_API_KEY) {
    return { ok: false, mensaje: 'No puedo ajustar el inventario ahora mismo — hazlo desde la tablet mientras tanto.' };
  }

  try {
    const { data } = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`,
      {
        systemInstruction: { parts: [{
          text: 'Interpretas un mensaje de WhatsApp donde el dueño de un negocio ajusta su inventario. Extrae SOLO lo que dice explícitamente: el nombre del producto, la cantidad (siempre un número positivo) y el tipo de movimiento. ' +
            'tipo="agregar" si suma stock, "restar" si lo descuenta, "fijar" si dice cuánto queda en total ("quedan 5 de X"). Si no hay número o no hay producto claro, aplicado=false.'
        }] },
        contents: [{ role: 'user', parts: [{ text: texto }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'OBJECT',
            properties: {
              producto: { type: 'STRING' },
              cantidad: { type: 'INTEGER' },
              tipo: { type: 'STRING', enum: ['agregar', 'restar', 'fijar'] },
              aplicado: { type: 'BOOLEAN' }
            },
            required: ['aplicado']
          },
          temperature: 0
        }
      },
      { headers: { 'Content-Type': 'application/json' }, timeout: 20000 }
    );

    const bruto = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!bruto) return { ok: false, mensaje: 'No entendí ese ajuste de inventario — ¿me lo escribes de otra forma? Ej: "quedan 10 de Coca-Cola".' };

    const parsed = JSON.parse(bruto);
    if (!parsed.aplicado || !parsed.producto || !parsed.cantidad) {
      return { ok: false, mensaje: 'No entendí ese ajuste de inventario — ¿me lo escribes de otra forma? Ej: "agrega 20 unidades de arroz".' };
    }

    const existente = await dbGet('SELECT * FROM products WHERE client_id = ? AND name = ?', [clientId, parsed.producto]);
    const base = existente ? existente.stock_quantity : 0;
    let nuevaCantidad = parsed.cantidad;
    if (parsed.tipo === 'agregar') nuevaCantidad = base + parsed.cantidad;
    if (parsed.tipo === 'restar') nuevaCantidad = base - parsed.cantidad;
    // tipo === 'fijar' ya queda en parsed.cantidad tal cual.
    nuevaCantidad = Math.max(nuevaCantidad, 0);

    if (existente) {
      await dbRun('UPDATE products SET stock_quantity = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [nuevaCantidad, existente.id]);
    } else {
      await dbRun('INSERT INTO products (client_id, name, stock_quantity) VALUES (?, ?, ?)', [clientId, parsed.producto, nuevaCantidad]);
    }

    logger.info('Inventario ajustado por WhatsApp', { clientId, producto: parsed.producto, nuevaCantidad });

    const producto = await dbGet('SELECT * FROM products WHERE client_id = ? AND name = ?', [clientId, parsed.producto]);
    let mensaje = `Listo ✅ ${parsed.producto}: quedan ${nuevaCantidad} ${producto?.unit || 'unidades'}.`;
    if (producto && producto.stock_quantity <= producto.low_stock_threshold) {
      mensaje += `\n\n⚠️ Ya está en el umbral de bajo stock (${producto.low_stock_threshold}).`;
    }
    return { ok: true, mensaje };
  } catch (error) {
    logger.warn('Fallo ajustando inventario por WhatsApp', {
      clientId, error: error.response?.data?.error?.message || error.message
    });
    return { ok: false, mensaje: 'Tuve un problema ajustando el inventario — hazlo desde la tablet mientras tanto.' };
  }
};

/**
 * Descuenta del inventario los items de una orden ya CONFIRMADA (no una que
 * la IA solo cree haber entendido). Cruza por nombre, sin distinguir
 * mayúsculas/acentos exactos de más — si el producto no existe en el
 * inventario del cliente simplemente no se toca (no se inventa uno nuevo
 * desde una orden, solo desde un ajuste explícito del dueño).
 *
 * Devuelve la lista de productos que quedaron en o bajo su umbral tras este
 * descuento, para que quien llame decida si avisa al dueño.
 */
const descontarPorOrden = async (clientId, order) => {
  let items = [];
  try { items = JSON.parse(order.items || '[]'); } catch (e) { return []; }
  if (!items.length) return [];

  const productos = await dbAll('SELECT * FROM products WHERE client_id = ? AND status = ?', [clientId, 'active']);
  const porNombre = new Map(productos.map((p) => [normalizar(p.name), p]));

  const cruzaronUmbral = [];
  for (const item of items) {
    const match = porNombre.get(normalizar(item.nombre || ''));
    if (!match) continue;

    const cantidad = Number(item.cantidad) || 1;
    const teniaStock = match.stock_quantity > match.low_stock_threshold;
    const nuevaCantidad = Math.max(match.stock_quantity - cantidad, 0);

    await dbRun('UPDATE products SET stock_quantity = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [nuevaCantidad, match.id]);
    match.stock_quantity = nuevaCantidad; // por si el mismo pedido repite el producto

    if (teniaStock && nuevaCantidad <= match.low_stock_threshold) {
      cruzaronUmbral.push({ ...match, stock_quantity: nuevaCantidad });
    }
  }
  return cruzaronUmbral;
};

const avisoBajoStock = (productos) => {
  if (!productos.length) return null;
  const lineas = productos.map((p) => `- ${p.name}: quedan ${p.stock_quantity} ${p.unit || 'unidades'} (umbral ${p.low_stock_threshold})`);
  return `⚠️ Inventario bajo — se está por agotar:\n\n${lineas.join('\n')}`;
};

module.exports = { esComandoInventario, ajustarInventario, descontarPorOrden, avisoBajoStock };
