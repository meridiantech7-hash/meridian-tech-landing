require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server: SocketIOServer } = require('socket.io');
const jwt = require('jsonwebtoken');
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
const { router: conversationsRoutes, setIO } = require('./routes/conversations');
const botConfigRoutes = require('./routes/botConfig');
const { router: ordersRoutes } = require('./routes/orders');
const metaWebhookRoutes = require('./routes/metaWebhook');

const app = express();
const httpServer = http.createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: { origin: process.env.CORS_ORIGIN || '*' }
});
setIO(io);
const PORT = process.env.PORT || 8080;

// =====================
// MIDDLEWARES DE SEGURIDAD
// =====================

// La landing y el panel admin usan JS/CSS inline por diseño (sin bundler),
// así que la CSP debe permitirlo explícitamente vía header — un <meta> CSP en
// el HTML no basta: cuando hay header + meta, el navegador aplica la
// intersección (la más restrictiva gana), y el helmet() por defecto sin
// configurar bloqueaba todo el script inline (pantalla en negro).
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'", 'wss:', 'ws:'],
      frameAncestors: ["'self'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      objectSrc: ["'none'"]
    }
  }
}));
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));

// Rate limiting. Los webhooks quedan exentos: los llaman Meta y Bold, que
// pueden enviar ráfagas legítimas de eventos y reintentos — limitarlos haría
// perder mensajes de clientes. Su protección es la firma HMAC, no el límite.
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 900000,
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  skip: (req) => req.path.startsWith('/webhooks/') || req.path.includes('/webhook/')
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

// `verify` guarda el cuerpo crudo: Meta firma el POST del webhook con HMAC
// sobre los bytes exactos, así que hay que conservarlos antes del parseo.
app.use(express.json({
  limit: '10mb',
  verify: (req, res, buf) => { req.rawBody = buf; }
}));
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
app.use('/api/conversations', conversationsRoutes);
app.use('/api/bot-config', botConfigRoutes);
app.use('/api/orders', ordersRoutes);
// Webhook único de Meta (WhatsApp + Instagram + Messenger). Sin verifyToken:
// lo llama Meta, no un admin; se protege con hub.verify_token (GET) y
// firma HMAC X-Hub-Signature-256 (POST).
app.use('/api/webhooks/meta', metaWebhookRoutes);

// =====================
// SOCKET.IO — supervisión en vivo del bot por conversación
// =====================

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Token requerido'));
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    socket.user = decoded;
    next();
  } catch (err) {
    next(new Error('Token inválido'));
  }
});

io.on('connection', (socket) => {
  logger.debug('Socket conectado', { userId: socket.user?.id });

  // El dueño/admin se suscribe a la bandeja en vivo de un negocio puntual
  socket.on('join_client', (clientId) => {
    socket.join(`client:${clientId}`);
    logger.debug('Socket unido a sala de cliente', { clientId, userId: socket.user?.id });
  });

  socket.on('leave_client', (clientId) => {
    socket.leave(`client:${clientId}`);
  });

  socket.on('disconnect', () => {
    logger.debug('Socket desconectado', { userId: socket.user?.id });
  });
});

// Panel administrativo
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/admin.html'));
});

// Terminal de la tablet (PWA instalable en la Samsung del local)
app.get('/tablet', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/tablet.html'));
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

    // Sembrar/actualizar planes (la función ya hace UPDATE si el plan existe,
    // así que corre siempre para que los ajustes de precio se apliquen)
    const seedPlans = require('./config/seedPlans');
    await seedPlans();

    // Sembrar usuario de Juan + cliente interno MeridianTech (capa B del flujo)
    const seedInternal = require('./config/seedInternal');
    await seedInternal();

    // Iniciar servidor (http server, no app, para que Socket.io funcione)
    httpServer.listen(PORT, () => {
      logger.info(`🚀 Servidor iniciado en puerto ${PORT}`);
      logger.info(`🌐 URL: ${process.env.APP_URL}`);
      logger.info(`📊 Ambiente: ${process.env.NODE_ENV}`);
      logger.info(`📝 Logs: ./logs/app.log`);
      logger.info(`🔐 Seguridad: HTTPS habilitado, Rate limiting activo`);
      logger.info(`🔌 Socket.io activo para supervisión en vivo`);
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
