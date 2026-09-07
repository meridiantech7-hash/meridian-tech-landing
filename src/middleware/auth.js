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

module.exports = {
  verifyToken,
  requireRole
};
