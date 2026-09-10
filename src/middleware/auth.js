const jwt = require('jsonwebtoken');
const logger = require('../utils/logger');

const verifyToken = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];

  if (!token) {
    logger.warn('Token faltante en request', { ip: req.ip });
    return res.status(401).json({ error: 'Token requerido' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    logger.debug('Token verificado', { userId: decoded.id });
    next();
  } catch (error) {
    logger.warn('Token inválido', { error: error.message, ip: req.ip });
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expirado' });
    }
    res.status(401).json({ error: 'Token inválido' });
  }
};

const requireRole = (role) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'No autenticado' });
    }

    if (req.user.role !== role) {
      logger.warn('Acceso denegado por rol', {
        userId: req.user.id,
        requiredRole: role,
        userRole: req.user.role
      });
      return res.status(403).json({ error: 'Acceso denegado' });
    }

    next();
  };
};

/**
 * Aislamiento entre empresas.
 *
 * Sin esto, cualquier usuario con sesión podía leer los datos de cualquier
 * cliente cambiando el número en la URL: `/api/conversations/10/messages` no
 * preguntaba de quién era la conversación 10. Con dos administradores dueños
 * de todo no se notaba, pero el día que un restaurante tenga su propio login,
 * ese login alcanzaría para leer las ventas y los chats de los demás.
 *
 * La regla es una sola: quien no tiene empresa asignada (client_id null) es
 * personal de MERIDIANTECH y ve todo; quien la tiene, ve solo la suya.
 */

/** ¿Es del equipo de MeridianTech, con acceso a todos los negocios? */
const esStaff = (user) => !user || user.client_id === null || user.client_id === undefined;

/** ¿Este usuario puede ver los datos de este cliente? */
const puedeVerCliente = (user, clientId) => {
  if (esStaff(user)) return true;
  return Number(user.client_id) === Number(clientId);
};

/**
 * Corta la petición con 403 si el usuario no tiene nada que hacer en ese
 * cliente. Devuelve true cuando sí puede seguir, para usarlo como guarda:
 *
 *   if (!exigirAccesoACliente(req, res, conversation.client_id)) return;
 *
 * Responde 403 y no 404 a propósito: quien tiene sesión válida ya sabe que el
 * recurso existe, y un 404 mentiroso solo complica depurar. Lo que no se
 * revela es el CONTENIDO.
 */
const exigirAccesoACliente = (req, res, clientId) => {
  if (puedeVerCliente(req.user, clientId)) return true;
  logger.warn('Acceso denegado a datos de otro cliente', {
    userId: req.user?.id,
    empresaDelUsuario: req.user?.client_id,
    empresaPedida: clientId,
    ruta: req.originalUrl
  });
  res.status(403).json({ error: 'No tienes acceso a los datos de este negocio' });
  return false;
};

/**
 * El cliente al que hay que limitar una consulta de lista, o null si no hay
 * que limitarla. Se usa para forzar el filtro en los listados, donde no hay
 * un id puntual que revisar.
 */
const clienteForzado = (user) => (esStaff(user) ? null : Number(user.client_id));

module.exports = {
  verifyToken,
  requireRole,
  esStaff,
  puedeVerCliente,
  exigirAccesoACliente,
  clienteForzado
};
