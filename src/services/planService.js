const { dbGet, dbRun } = require('../config/database');

/**
 * Todo lo que necesita saber el bot sobre el plan de un cliente — qué
 * incluye, y cuánto lleva usado este mes. Un solo lugar para esto, en vez
 * de repetir el JOIN suscripciones+planes cada vez (ya se usaba suelto en
 * routes/clients.js).
 */

/**
 * Plan activo del cliente, o null si no tiene una suscripción activa (se
 * trata igual que "Básico sin nada extra" en todos los que llaman esto).
 */
const getPlanActivo = async (clientId) => {
  const plan = await dbGet(
    `SELECT p.* FROM subscriptions s
     JOIN plans p ON s.plan_id = p.id
     WHERE s.client_id = ? AND s.status = 'active'
     ORDER BY s.created_at DESC LIMIT 1`,
    [clientId]
  );
  return plan || null;
};

/**
 * Cuántos reportes ya se generaron este mes calendario (Colombia) para este
 * cliente. Se cuenta sobre activity_logs en vez de armar una tabla nueva
 * solo para un contador — un registro por reporte generado, mismo patrón
 * de auditoría que ya usa el resto del panel.
 */
const reportesUsadosEsteMes = async (clientId) => {
  const fila = await dbGet(
    `SELECT COUNT(*) as total FROM activity_logs
     WHERE client_id = ? AND action = 'reporte_whatsapp'
       AND strftime('%Y-%m', datetime(created_at, '-5 hours')) = strftime('%Y-%m', datetime('now', '-5 hours'))`,
    [clientId]
  );
  return fila?.total || 0;
};

const registrarReporteUsado = async (clientId, detalle) => {
  await dbRun(
    `INSERT INTO activity_logs (client_id, action, entity, description) VALUES (?, 'reporte_whatsapp', 'report', ?)`,
    [clientId, detalle || null]
  );
};

module.exports = { getPlanActivo, reportesUsadosEsteMes, registrarReporteUsado };
