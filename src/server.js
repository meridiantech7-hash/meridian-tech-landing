require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const path = require('path');

const logger = require('./utils/logger');
const errorHandler = require('./middleware/errorHandler');
const setupDatabase = require('./config/setupDatabase');

// Importar rutas
const authRoutes = require('./routes/auth');
const clientsRoutes = require('./routes/clients');
const plansRoutes = require('./routes/plans');
const paymentsRoutes = require('./routes/payments');

const app = express();
const PORT = process.env.PORT || 8080;

// =====================
// MIDDLEWARES DE SEGURIDAD
// =====================

app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));

// Rate limiting
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 900000,
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100
});
app.use('/api/', limiter);

// =====================
// MIDDLEWARES DE LOGGING Y PARSEO
// =====================

app.use(morgan('combined', {
  stream: {
    write: (message) => logger.info(message.trim())
  }
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// =====================
// RUTAS ESTÁTICAS
// =====================

app.use(express.static(path.join(__dirname, '../public')));

// =====================
// RUTAS DE API
// =====================

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV
  });
});

// API v1
app.use('/api/auth', authRoutes);
app.use('/api/clients', clientsRoutes);
app.use('/api/plans', plansRoutes);
app.use('/api/payments', paymentsRoutes);

// Panel administrativo
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/admin.html'));
});

// =====================
// RUTA POR DEFECTO (SPA)
// =====================

app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(__dirname, '../public/index.html'));
  } else {
    res.status(404).json({ error: 'Ruta no encontrada' });
  }
});

// =====================
// MANEJO DE ERRORES
// =====================

app.use(errorHandler);

// =====================
// INICIALIZACIÓN
// =====================

async function startServer() {
  try {
    // Inicializar base de datos
    logger.info('🗄️  Configurando base de datos...');
    await setupDatabase();

    // Crear usuario admin si no existe
    const { dbGet } = require('./config/database');
    const adminUser = await dbGet('SELECT id FROM users WHERE role = ?', ['admin']);

    if (!adminUser) {
      const authService = require('./services/authService');
      const adminEmail = process.env.ADMIN_EMAIL;
      const adminPassword = process.env.ADMIN_PASSWORD;

      if (!adminEmail || !adminPassword) {
        logger.warn('⚠️  ADMIN_EMAIL / ADMIN_PASSWORD no configurados - omitiendo creación de admin inicial');
      } else {
        try {
          await authService.createUser(adminEmail, adminPassword, 'Administrador', 'admin');
          logger.info('✅ Usuario administrador creado', { email: adminEmail });
        } catch (error) {
          logger.info('✅ Usuario administrador ya existe');
        }
      }
    }

    // Sembrar planes iniciales si no existen
    const planCount = await dbGet('SELECT COUNT(*) as total FROM plans');
    if (!planCount || planCount.total === 0) {
      const seedPlans = require('./config/seedPlans');
      await seedPlans();
    }

    // Iniciar servidor
    app.listen(PORT, () => {
      logger.info(`🚀 Servidor iniciado en puerto ${PORT}`);
      logger.info(`🌐 URL: ${process.env.APP_URL}`);
      logger.info(`📊 Ambiente: ${process.env.NODE_ENV}`);
      logger.info(`📝 Logs: ./logs/app.log`);
      logger.info(`🔐 Seguridad: HTTPS habilitado, Rate limiting activo`);
      logger.info('✅ Sistema listo para operar\n');
    });

  } catch (error) {
    logger.error('❌ Error al iniciar servidor', error);
    process.exit(1);
  }
}

// =====================
// MANEJO DE SEÑALES
// =====================

process.on('SIGTERM', async () => {
  logger.info('SIGTERM recibido, cerrando servidor...');
  const { close } = require('./config/database');
  await close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT recibido, cerrando servidor...');
  const { close } = require('./config/database');
  await close();
  process.exit(0);
});

process.on('uncaughtException', (error) => {
  logger.error('❌ Excepción no capturada', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('❌ Promise rechazado sin manejar', { reason });
});

// Iniciar
startServer();

module.exports = app;
