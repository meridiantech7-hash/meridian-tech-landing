const logger = require('../utils/logger');

const errorHandler = (err, req, res, next) => {
  logger.error('Error en request', {
    message: err.message,
    stack: err.stack,
    url: req.originalUrl,
    method: req.method,
    ip: req.ip
  });

  // Errores de validación de Joi
  if (err.isJoi) {
    return res.status(400).json({
      error: 'Datos inválidos',
      details: err.details.map(d => ({
        field: d.path.join('.'),
        message: d.message
      }))
    });
  }

  // Errores de BD
  if (err.message && err.message.includes('UNIQUE constraint failed')) {
    return res.status(409).json({
      error: 'Este registro ya existe'
    });
  }

  if (err.message && err.message.includes('FOREIGN KEY constraint failed')) {
    return res.status(400).json({
      error: 'Referencia inválida'
    });
  }

  // Errores de BD genéricos
  if (err.code === 'SQLITE_CANTOPEN' || err.code === 'SQLITE_IOERR') {
    return res.status(500).json({
      error: 'Error de base de datos'
    });
  }

  // Error por defecto
  const statusCode = err.statusCode || 500;
  const message = process.env.NODE_ENV === 'production'
    ? 'Error interno del servidor'
    : err.message;

  res.status(statusCode).json({
    error: message,
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack })
  });
};

module.exports = errorHandler;
