# 🏗️ INFRAESTRUCTURA MERIDIAN TECH - SISTEMA COMPLETO

## 📊 ARQUITECTURA GENERAL

```
┌─────────────────────────────────────────────────────────┐
│                    FRONTEND (Railway)                   │
│              Landing Page + Dashboard                   │
└────────────────┬────────────────────────────────────────┘
                 │ HTTPS
┌────────────────▼────────────────────────────────────────┐
│                    BACKEND API (Express)                │
│  ├─ /api/auth       (Autenticación JWT)                 │
│  ├─ /api/clients    (Gestión de clientes)               │
│  ├─ /api/plans      (Planes y productos)                │
│  ├─ /api/history    (Historial de transacciones)        │
│  ├─ /api/payments   (Integración con Bold)              │
│  └─ /api/config     (Configuración del sistema)         │
└────────────────┬────────────────────────────────────────┘
                 │
┌────────────────▼────────────────────────────────────────┐
│                  BASE DE DATOS (SQLite)                 │
│  ├─ users          (Cuentas administrativas)            │
│  ├─ clients        (Clientes/Empresas)                  │
│  ├─ plans          (Planes disponibles)                 │
│  ├─ subscriptions  (Suscripciones activas)              │
│  └─ transactions   (Historial de pagos)                 │
└─────────────────────────────────────────────────────────┘
                 │
┌────────────────▼────────────────────────────────────────┐
│              SERVICIOS EXTERNOS                         │
│  ├─ Bold.co        (Procesamiento de pagos)             │
│  └─ Email          (Notificaciones)                     │
└─────────────────────────────────────────────────────────┘
```

## 🗂️ ESTRUCTURA DE CARPETAS

```
meridian-web/
├── src/
│   ├── server.js              # Punto de entrada
│   ├── config/
│   │   ├── database.js        # Configuración SQLite
│   │   ├── bold.js            # Configuración Bold API
│   │   └── jwt.js             # Configuración JWT
│   ├── middleware/
│   │   ├── auth.js            # Verificación JWT
│   │   ├── errorHandler.js    # Manejo de errores
│   │   └── validate.js        # Validación de datos
│   ├── routes/
│   │   ├── auth.js            # Login/Registro
│   │   ├── clients.js         # CRUD de clientes
│   │   ├── plans.js           # Gestión de planes
│   │   ├── payments.js        # Pagos con Bold
│   │   ├── history.js         # Historial
│   │   └── admin.js           # Panel administrativo
│   ├── models/
│   │   ├── User.js
│   │   ├── Client.js
│   │   ├── Plan.js
│   │   ├── Subscription.js
│   │   └── Transaction.js
│   ├── services/
│   │   ├── boldService.js     # Integración Bold
│   │   ├── emailService.js    # Envío de emails
│   │   ├── authService.js     # Lógica de autenticación
│   │   └── paymentService.js  # Lógica de pagos
│   └── utils/
│       ├── logger.js          # Sistema de logs
│       ├── validators.js      # Funciones de validación
│       └── helpers.js         # Funciones auxiliares
├── public/
│   ├── index.html             # Landing page
│   ├── dashboard.html         # Panel administrativo
│   ├── css/
│   │   └── styles.css
│   └── js/
│       └── app.js
├── db/
│   ├── schema.sql             # Schema de la BD
│   └── seeds.sql              # Datos iniciales
├── .env                       # Variables de entorno
├── .env.example               # Ejemplo de env
├── .gitignore
├── package.json
├── package-lock.json
├── INFRAESTRUCTURA.md         # Este archivo
└── README.md
```

## 🔐 SEGURIDAD IMPLEMENTADA

### ✅ Autenticación
- JWT con refresh tokens
- Passwords hasheados con bcrypt
- Sesiones seguras

### ✅ Validación
- Validación de entrada en cada ruta
- Sanitización de datos
- CORS configurado

### ✅ Base de Datos
- SQL Injection prevention (prepared statements)
- Encriptación de datos sensibles
- Backups automáticos

### ✅ API
- Rate limiting
- HTTPS (Railway automático)
- Headers de seguridad
- CSP implementado

### ✅ Credenciales
- Variables de entorno (.env)
- Nunca en código/git
- Rotación regular

## 📦 DEPENDENCIAS

```json
{
  "express": "^4.18.2",
  "sqlite3": "^5.1.6",
  "bcryptjs": "^2.4.3",
  "jsonwebtoken": "^9.0.0",
  "joi": "^17.9.2",
  "dotenv": "^16.0.3",
  "cors": "^2.8.5",
  "axios": "^1.3.4",
  "nodemailer": "^6.9.1"
}
```

## 🚀 FUNCIONALIDADES PRINCIPALES

### 1️⃣ Autenticación
- ✅ Login de administradores
- ✅ Registro de nuevos usuarios
- ✅ Recuperación de contraseña
- ✅ Cambio de contraseña

### 2️⃣ Gestión de Clientes
- ✅ Crear/Editar/Eliminar clientes
- ✅ Historial completo por cliente
- ✅ Estados de suscripción
- ✅ Información de contacto

### 3️⃣ Planes y Productos
- ✅ Catálogo de planes (Básico, Pro, Premium)
- ✅ Precios en COP
- ✅ Características por plan
- ✅ Actualización de precios

### 4️⃣ Pagos con Bold
- ✅ Crear transacciones en Bold
- ✅ Webhooks para confirmación
- ✅ Registrar pagos en BD
- ✅ Estados de pago (pendiente, completado, fallido)

### 5️⃣ Historial y Reportes
- ✅ Historial de transacciones por cliente
- ✅ Exportar en CSV
- ✅ Filtros por fecha/estado
- ✅ Dashboard con métricas

### 6️⃣ Notificaciones
- ✅ Email al crear cliente
- ✅ Email de confirmación de pago
- ✅ Email de vencimiento de suscripción
- ✅ Email de bienvenida

## 🔄 FLUJO DE TRABAJO

### Flujo de Cliente
1. Cliente accede a landing page
2. Selecciona plan
3. Hace clic en "Contratar"
4. Redirecciona a checkout de Bold
5. Completa pago
6. Bold envía webhook de confirmación
7. Sistema crea cliente en BD
8. Envía email de bienvenida
9. Cliente accede a dashboard

### Flujo de Administrador
1. Admin entra a dashboard
2. Ve lista de clientes activos
3. Puede crear cliente manual
4. Ver historial de pagos
5. Actualizar planes
6. Generar reportes

## 📊 MODELOS DE BASE DE DATOS

### users
- id (PK)
- email (UNIQUE)
- password (hashed)
- name
- role (admin, viewer)
- created_at
- updated_at

### clients
- id (PK)
- name
- email
- phone
- company
- address
- city
- country
- tax_id
- payment_method
- created_at
- updated_at

### plans
- id (PK)
- name
- description
- price (COP)
- duration (monthly/yearly)
- features (JSON)
- active
- created_at

### subscriptions
- id (PK)
- client_id (FK)
- plan_id (FK)
- status (active, inactive, paused)
- start_date
- end_date
- renewal_date
- auto_renew
- created_at

### transactions
- id (PK)
- client_id (FK)
- plan_id (FK)
- amount
- currency
- status (pending, completed, failed, refunded)
- bold_transaction_id
- payment_method
- description
- created_at
- updated_at

## 🌐 ENDPOINTS API

### Autenticación
- `POST /api/auth/login` - Login
- `POST /api/auth/logout` - Logout
- `POST /api/auth/refresh` - Refresh token
- `POST /api/auth/forgot-password` - Recuperar contraseña

### Clientes
- `GET /api/clients` - Listar clientes
- `GET /api/clients/:id` - Obtener cliente
- `POST /api/clients` - Crear cliente
- `PUT /api/clients/:id` - Actualizar cliente
- `DELETE /api/clients/:id` - Eliminar cliente
- `GET /api/clients/:id/history` - Historial del cliente

### Planes
- `GET /api/plans` - Listar planes
- `GET /api/plans/:id` - Obtener plan
- `POST /api/plans` - Crear plan
- `PUT /api/plans/:id` - Actualizar plan
- `DELETE /api/plans/:id` - Eliminar plan

### Pagos
- `POST /api/payments/create` - Crear pago
- `GET /api/payments/:id` - Estado del pago
- `POST /api/payments/webhook/bold` - Webhook de Bold
- `GET /api/payments/history` - Historial de pagos

### Historial
- `GET /api/history` - Toda la historia
- `GET /api/history/client/:id` - Historial por cliente
- `GET /api/history/export` - Exportar CSV

## 🚀 DEPLOY EN RAILWAY

### Variables de Entorno
```
NODE_ENV=production
PORT=8080
DATABASE_URL=./data/meridian.db
JWT_SECRET=tu_secret_super_seguro
JWT_REFRESH_SECRET=refresh_secret_super_seguro
BOLD_MERCHANT_ID=WQOSMEMRNS
BOLD_API_KEY=tu_api_key
BOLD_SECRET_KEY=tu_secret_key
BOLD_WEBHOOK_SECRET=webhook_secret
EMAIL_SERVICE=gmail
EMAIL_USER=tu_email@gmail.com
EMAIL_PASSWORD=tu_app_password
```

### Comando de Start
```bash
npm start
```

## ✅ CHECKLIST DE IMPLEMENTACIÓN

- [ ] Crear estructura de carpetas
- [ ] Instalar dependencias
- [ ] Configurar SQLite y schema
- [ ] Implementar autenticación JWT
- [ ] Crear modelos y rutas de clientes
- [ ] Crear modelos y rutas de planes
- [ ] Integrar con Bold API
- [ ] Implementar webhooks
- [ ] Crear dashboard
- [ ] Implementar notificaciones por email
- [ ] Sistema de logs
- [ ] Testing
- [ ] Documentación API
- [ ] Deploy a Railway
- [ ] Monitoreo en producción

---

**Próximo paso**: Empezar implementación con `npm install` y crear la estructura base.
