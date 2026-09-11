const { dbExec, dbRun } = require('./database');
const logger = require('../utils/logger');

// Migraciones incrementales seguras: agregan columnas nuevas a tablas que ya
// existían en producción sin borrar datos. Cada ALTER se intenta y se ignora
// si la columna ya existe (SQLite no soporta "ADD COLUMN IF NOT EXISTS").
const migrations = [
  "ALTER TABLE plans ADD COLUMN messages_included INTEGER DEFAULT 0",
  "ALTER TABLE plans ADD COLUMN message_overage_price INTEGER DEFAULT 0",
  "ALTER TABLE plans ADD COLUMN call_minutes_included INTEGER DEFAULT 0",
  "ALTER TABLE plans ADD COLUMN minute_overage_price INTEGER DEFAULT 0",
  // Antes solo vivía como texto suelto en el guion del bot (seedInternal.js) —
  // ningún sistema podía consultarla. Ahora es un dato real del plan.
  "ALTER TABLE plans ADD COLUMN implementation_price INTEGER DEFAULT 0",
  // Minutos de audio con voz de personalidad (ElevenLabs) incluidos en el
  // plan — antes solo existía como número suelto en la hoja de costos, ahora
  // es un dato real del plan igual que call_minutes_included.
  "ALTER TABLE plans ADD COLUMN audio_minutes_included INTEGER DEFAULT 0",
  // Reportes de negocio que el bot puede generar por WhatsApp administrativo
  // (ver ownerService.js) — Pro: 2/mes con lo que el dueño pida; Premium: 4/mes
  // con análisis de mercado y plan de acción. 0 = el plan no incluye reportes.
  "ALTER TABLE plans ADD COLUMN monthly_reports_included INTEGER DEFAULT 0",
  "ALTER TABLE clients ADD COLUMN is_internal INTEGER DEFAULT 0",
  // Por defecto 1 (true): no cambia el comportamiento de ningún cliente que ya
  // toma pedidos (capa A, restaurantes). Se apaga explícitamente solo donde no
  // aplica — ver seedInternal.js — para no gastar una llamada de IA completa
  // extrayendo "pedidos" de una conversación de venta que nunca los tiene.
  "ALTER TABLE bot_configs ADD COLUMN takes_orders INTEGER DEFAULT 1",
  // "Memoria" del cliente final: notas persistentes por conversación (que ya
  // es única por client_id+channel_type+end_customer_id, o sea por persona)
  // para que el bot siga sonando familiar aunque el dato se haya salido de la
  // ventana de los últimos 20 mensajes. No agrega ninguna llamada de IA nueva
  // — se rellena con lo que el mismo modelo ya devuelve en su respuesta normal.
  "ALTER TABLE conversations ADD COLUMN customer_notes TEXT",
  // Número de WhatsApp del dueño del negocio, fijo por cliente. Es la única
  // identidad que se reconoce para operaciones sensibles (inventario, estados
  // de cuenta, reservas) — cualquier otro número que las pida se rechaza sin
  // gastar IA. Ver ownerService.js.
  "ALTER TABLE bot_configs ADD COLUMN owner_phone TEXT",
  // Migración a la API real de Bold (Link de Pagos) — antes se usaba el
  // Botón de Pagos, un producto distinto al que esta cuenta tiene habilitado.
  // Ver boldService.js.
  "ALTER TABLE transactions ADD COLUMN bold_payment_link TEXT",
  "ALTER TABLE transactions ADD COLUMN bold_payment_url TEXT",
  // El modelo guardado por cliente manda sobre el valor por defecto del código,
  // así que cambiar la constante no basta: hay que mover a los que ya existen.
  // Se migran solo los modelos que se midieron lentos o que dejaron de estar
  // disponibles; si alguien eligió otro a propósito, se respeta.
  `UPDATE bot_configs SET ai_model = 'gemini-3.5-flash-lite'
     WHERE ai_model IN ('gemini-3.6-flash','gemini-2.5-flash','gemini-1.5-flash','gemini-2.0-flash')`
];

async function runMigrations() {
  for (const sql of migrations) {
    try {
      await dbRun(sql);
    } catch (err) {
      if (!/duplicate column name/i.test(err.message)) {
        logger.warn('Migración omitida', { sql, error: err.message });
      }
    }
  }
}

const schema = `
-- Tabla de Usuarios (Administradores)
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT DEFAULT 'admin',
  status TEXT DEFAULT 'active',
  last_login DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Tabla de Clientes
CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  company TEXT,
  address TEXT,
  city TEXT,
  country TEXT DEFAULT 'Colombia',
  tax_id TEXT UNIQUE,
  status TEXT DEFAULT 'active',
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(email)
);

-- Tabla de Planes
CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  price INTEGER NOT NULL,
  currency TEXT DEFAULT 'COP',
  billing_cycle TEXT DEFAULT 'monthly',
  features TEXT,
  max_users INTEGER,
  max_storage INTEGER,
  messages_included INTEGER DEFAULT 0,
  message_overage_price INTEGER DEFAULT 0,
  call_minutes_included INTEGER DEFAULT 0,
  minute_overage_price INTEGER DEFAULT 0,
  implementation_price INTEGER DEFAULT 0, -- cobro único de puesta en marcha, aparte de la mensualidad
  audio_minutes_included INTEGER DEFAULT 0, -- minutos de voz ElevenLabs incluidos por mes
  monthly_reports_included INTEGER DEFAULT 0, -- reportes de negocio por WhatsApp administrativo, 0 = no incluye
  status TEXT DEFAULT 'active',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Tabla de Suscripciones
CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  plan_id INTEGER NOT NULL,
  status TEXT DEFAULT 'active',
  start_date DATETIME,
  end_date DATETIME,
  renewal_date DATETIME,
  auto_renew BOOLEAN DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
  FOREIGN KEY (plan_id) REFERENCES plans(id)
);

-- Tabla de Transacciones
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  plan_id INTEGER NOT NULL,
  subscription_id INTEGER,
  amount INTEGER NOT NULL,
  currency TEXT DEFAULT 'COP',
  status TEXT DEFAULT 'pending',
  payment_method TEXT,
  bold_transaction_id TEXT UNIQUE, -- nuestro "reference" (orderId), lo que Bold devuelve en data.metadata.reference
  bold_payment_link TEXT,          -- id propio de Bold para el link, ej. "LNK_H7S4xxx"
  bold_payment_url TEXT,           -- URL real de checkout.bold.co — lo que se manda al cliente
  description TEXT,
  receipt_url TEXT,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
  FOREIGN KEY (plan_id) REFERENCES plans(id),
  FOREIGN KEY (subscription_id) REFERENCES subscriptions(id)
);

-- Tabla de Actividades (Auditoria)
CREATE TABLE IF NOT EXISTS activity_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  client_id INTEGER,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id INTEGER,
  description TEXT,
  ip_address TEXT,
  user_agent TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (client_id) REFERENCES clients(id)
);

-- Canales conectados por cliente (WhatsApp/Instagram/Messenger, credenciales aisladas por negocio)
CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  channel_type TEXT NOT NULL,            -- whatsapp | instagram | messenger | voice
  provider TEXT,                          -- ej. twilio, 360dialog, meta_graph
  external_account_id TEXT,               -- id/número asignado por el proveedor para este cliente
  status TEXT DEFAULT 'active',           -- active | paused | disconnected
  owner_notify_phone TEXT,                -- número personal del dueño para alertas de derivación
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
  UNIQUE(client_id, channel_type)
);

-- Conversaciones entre el bot/negocio y el cliente final (el cliente del cliente)
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,             -- negocio dueño de la conversación
  channel_id INTEGER,
  channel_type TEXT NOT NULL,             -- whatsapp | instagram | messenger
  end_customer_id TEXT NOT NULL,          -- teléfono o external id del cliente final
  end_customer_name TEXT,
  customer_notes TEXT,                    -- "memoria" acumulada: datos del cliente que el bot ya aprendió (nombre, negocio, preferencias)
  mode TEXT DEFAULT 'bot',                -- bot | human | paused
  status TEXT DEFAULT 'open',             -- open | closed
  last_message_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
  FOREIGN KEY (channel_id) REFERENCES channels(id)
);

-- Configuración del "nodo de IA" por cliente: reglas, conocimiento previo y
-- condiciones de derivación a humano. Un registro por cliente (capa A =
-- clientes de MeridianTech, capa B = MeridianTech como su propio cliente
-- interno). Así cada negocio tiene su bot configurado de forma aislada.
CREATE TABLE IF NOT EXISTS bot_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL UNIQUE,
  ai_provider TEXT DEFAULT 'gemini',
  ai_model TEXT DEFAULT 'gemini-3.6-flash',
  system_prompt TEXT,             -- personalidad/instrucciones del bot
  business_rules TEXT,            -- reglas de negocio en JSON (horarios, políticas, etc.)
  knowledge_base TEXT,            -- conocimiento previo: catálogo, precios, FAQs (texto libre)
  handoff_keywords TEXT,          -- JSON array de palabras/frases que derivan a humano
  max_failed_attempts INTEGER DEFAULT 3,
  takes_orders INTEGER DEFAULT 1, -- si es 0, se salta extractOrder (ahorra una llamada de IA por mensaje en negocios que no toman pedidos, ej. venta consultiva)
  owner_phone TEXT,               -- WhatsApp fijo del dueño: único número autorizado para inventario, reservas y estados de cuenta
  status TEXT DEFAULT 'active',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
);

-- Mensajes individuales de cada conversación (para supervisión en vivo)
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL,
  sender_type TEXT NOT NULL,              -- bot | owner | end_customer
  content TEXT NOT NULL,
  external_message_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

-- Eventos de derivación a humano (auditoría de por qué se pausó/reactivó el bot)
CREATE TABLE IF NOT EXISTS handoff_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL,
  trigger_type TEXT NOT NULL,             -- keyword | sentiment | max_attempts | owner_paused | owner_resumed | menu_option
  detail TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

-- Órdenes / pedidos del negocio.
--
-- Los productos van como JSON en "items" en vez de una tabla aparte: el tablero
-- de la tablet los pinta tal cual y así una orden se lee de un solo golpe, sin
-- JOIN. Si algún día hace falta reportería por producto, se normaliza entonces.
--
-- "status" sigue el flujo que ya usaba la interfaz anterior de cocina:
--   por_confirmar → recibido → preparando → listo → entregado   (+ cancelado)
--
-- "por_confirmar" es el estado en el que caen las órdenes que arma la IA a
-- partir del chat: nadie cocina nada hasta que una persona la revise y acepte.
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  conversation_id INTEGER,                -- de qué chat salió (null si se creó a mano)
  order_number TEXT,                      -- consecutivo visible del día, ej. "A-014"
  status TEXT DEFAULT 'por_confirmar',
  source TEXT DEFAULT 'bot',              -- bot | tablet | jefe
  channel_type TEXT,                      -- whatsapp | instagram | messenger | manual
  customer_name TEXT,
  customer_phone TEXT,
  address TEXT,
  modality TEXT DEFAULT 'domicilio',      -- domicilio | recoger | mesa
  items TEXT DEFAULT '[]',                -- JSON: [{nombre, cantidad, precio, notas}]
  total INTEGER DEFAULT 0,                -- en pesos, sin decimales
  notes TEXT,
  ai_confidence TEXT,                     -- alta | media | baja (qué tan segura quedó la IA)
  ai_raw TEXT,                            -- lo que extrajo la IA, para auditar errores
  confirmed_by INTEGER,                   -- usuario que la aceptó
  confirmed_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL
);

-- Reservas / citas / programaciones del negocio (mesas, turnos, lo que aplique).
--
-- Igual que orders: "source" distingue si la agendó la IA desde un chat, la
-- tablet a mano, o el dueño desde su WhatsApp autorizado (ver ownerService.js).
-- "scheduled_at" es la fecha/hora de la reserva en sí, no cuándo se creó el
-- registro — así una reserva hecha ayer para hoy aparece en la agenda de hoy.
CREATE TABLE IF NOT EXISTS reservations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  conversation_id INTEGER,
  customer_name TEXT,
  customer_phone TEXT,
  party_size INTEGER,                     -- número de personas, si aplica
  scheduled_at DATETIME NOT NULL,         -- cuándo es la reserva
  status TEXT DEFAULT 'confirmada',       -- confirmada | pendiente | cancelada
  source TEXT DEFAULT 'tablet',           -- bot | tablet | jefe
  channel_type TEXT,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL
);

-- Bitácora de cambios de estado: quién movió la orden y cuándo. Sirve para
-- reclamos ("¿a qué hora se marcó lista?") y para medir tiempos de cocina.
CREATE TABLE IF NOT EXISTS order_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  user_id INTEGER,
  detail TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
);

-- Inventario en tiempo real (plan Premium). Arranca vacía por cliente — el
-- dueño la puebla por WhatsApp ("agrega 50 unidades de X"). Se descuenta sola
-- cuando una orden pasa de "por_confirmar" a "recibido" (inventoryService.js,
-- enganchado en POST /api/orders/:id/confirm), cruzando por nombre contra
-- orders.items. Cuando stock_quantity cruza low_stock_threshold se avisa al
-- dueño por WhatsApp sin que lo pida.
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  stock_quantity INTEGER NOT NULL DEFAULT 0,
  low_stock_threshold INTEGER NOT NULL DEFAULT 5,
  unit TEXT DEFAULT 'unidad',
  status TEXT DEFAULT 'active',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
  UNIQUE(client_id, name)
);

-- Índices para mejor desempeño
CREATE INDEX IF NOT EXISTS idx_orders_client_status ON orders(client_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_orders_conversation ON orders(conversation_id);
CREATE INDEX IF NOT EXISTS idx_order_events_order ON order_events(order_id);
CREATE INDEX IF NOT EXISTS idx_clients_email ON clients(email);
CREATE INDEX IF NOT EXISTS idx_clients_status ON clients(status);
CREATE INDEX IF NOT EXISTS idx_subscriptions_client ON subscriptions(client_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_transactions_client ON transactions(client_id);
CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_transactions_created ON transactions(created_at);
CREATE INDEX IF NOT EXISTS idx_activity_user ON activity_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_channels_client ON channels(client_id);
CREATE INDEX IF NOT EXISTS idx_conversations_client ON conversations(client_id);
CREATE INDEX IF NOT EXISTS idx_conversations_mode ON conversations(mode);
CREATE INDEX IF NOT EXISTS idx_conversations_last_msg ON conversations(last_message_at);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_handoff_conversation ON handoff_events(conversation_id);
CREATE INDEX IF NOT EXISTS idx_products_client ON products(client_id);
`;

async function setupDatabase() {
  logger.info('🗄️  Inicializando base de datos...');

  await dbExec(schema);
  await runMigrations();

  logger.info('✅ Base de datos inicializada correctamente');
  logger.info('📊 Tablas creadas:');
  logger.info('   - users (Administradores)');
  logger.info('   - clients (Clientes)');
  logger.info('   - plans (Planes)');
  logger.info('   - subscriptions (Suscripciones)');
  logger.info('   - transactions (Transacciones)');
  logger.info('   - activity_logs (Auditoria)');
  logger.info('   - channels (Canales WhatsApp/Instagram/Messenger/Voz por cliente)');
  logger.info('   - conversations (Conversaciones bot ↔ cliente final)');
  logger.info('   - messages (Mensajes para supervisión en vivo)');
  logger.info('   - handoff_events (Auditoría de derivación a humano)');
  logger.info('   - bot_configs (Reglas/conocimiento del nodo de IA por cliente)');
  logger.info('   - orders (Órdenes del negocio, tablero de la tablet)');
  logger.info('   - order_events (Bitácora de cambios de estado de cada orden)');
}

// Ejecutar si se llama directamente vía CLI (npm run setup)
if (require.main === module) {
  setupDatabase()
    .then(() => process.exit(0))
    .catch((error) => {
      logger.error('❌ Error inicializando BD:', error.message);
      process.exit(1);
    });
}

module.exports = setupDatabase;
