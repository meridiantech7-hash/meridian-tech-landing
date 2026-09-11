require('dotenv').config();
const { dbGet, dbRun, close } = require('./database');
const logger = require('../utils/logger');

/**
 * Precios recalculados dos veces (septiembre 2026) — ver historial completo
 * en el git log de este archivo para el detalle de las dos primeras vueltas
 * (margen cero corregido, luego recargo vs. margen neto corregido).
 *
 * 3ra vuelta (bajada de precio, misma semana): decisión de negocio — bajar
 * el precio de entrada para ser más competitivo, aceptando un margen real
 * más delgado (42-47% en vez de 60%+) pero todavía sano, verificado con la
 * hoja de costos real (Gemini, Meta, Twilio, ElevenLabs, Bold, fijos —
 * "Motor de Costo Real"). El precio de implementación NO cambió — solo la
 * mensualidad.
 *
 * De paso:
 *   - Pro y Premium suben los minutos de llamada incluidos (Pro 400→1.000,
 *     Premium 1.000→2.500) — con el costo real de WhatsApp Calling
 *     ($44 COP/min) esto casi no mueve el costo real, así que se puede dar
 *     más sin arriesgar el margen.
 *   - Se agregan minutos de audio con voz de personalidad (ElevenLabs) como
 *     dato real del plan, no solo texto de venta — ver audio_minutes_included
 *     en setupDatabase.js.
 *   - Se agrega monthly_reports_included: Pro 2/mes (lo que el dueño pida por
 *     WhatsApp administrativo), Premium 4/mes (con análisis de mercado y plan
 *     de acción — ver ownerService.js para dónde vive esa lógica).
 */
const plans = [
  {
    name: 'Básico',
    description: 'Automatización esencial para empezar a escalar tu operación',
    price: 800000,
    implementation_price: 1200000,
    currency: 'COP',
    billing_cycle: 'monthly',
    features: [
      'Automatización de hasta 3 procesos',
      'Soporte por WhatsApp',
      '100 min/mes de audio con voz de personalidad',
      '1 usuario administrador'
    ],
    max_users: 1,
    max_storage: 5,
    messages_included: 30000,
    message_overage_price: 50,
    call_minutes_included: 0,
    minute_overage_price: 0,
    audio_minutes_included: 100,
    monthly_reports_included: 0
  },
  {
    name: 'Pro',
    description: 'Automatización avanzada con IA para equipos en crecimiento',
    price: 1200000,
    implementation_price: 1200000,
    currency: 'COP',
    billing_cycle: 'monthly',
    features: [
      'Automatización de hasta 10 procesos',
      'Integraciones con IA',
      'Soporte prioritario',
      '1.000 min/mes de llamada · 200 min/mes de audio con personalidad',
      '2 reportes al mes por WhatsApp administrativo, con lo que pidas',
      'Hasta 5 usuarios administradores'
    ],
    max_users: 5,
    max_storage: 25,
    messages_included: 60000,
    message_overage_price: 50,
    call_minutes_included: 1000,
    minute_overage_price: 800,
    audio_minutes_included: 200,
    monthly_reports_included: 2
  },
  {
    name: 'Premium',
    description: 'Solución integral de automatización e IA a medida, con asesoría de crecimiento',
    price: 2200000,
    implementation_price: 2200000,
    currency: 'COP',
    billing_cycle: 'monthly',
    features: [
      'Automatizaciones ilimitadas',
      'IA personalizada para tu negocio',
      'Soporte dedicado 24/7',
      '2.500 min/mes de llamada · 400 min/mes de audio con personalidad',
      'Agente de ventas y marketing: asesoría de crecimiento de negocio',
      '4 reportes al mes por WhatsApp administrativo, con análisis de mercado y plan de acción',
      'Inventario en tiempo real con aviso de próximos a agotarse',
      'Usuarios ilimitados'
    ],
    max_users: null,
    max_storage: 100,
    messages_included: 120000,
    message_overage_price: 50,
    call_minutes_included: 2500,
    minute_overage_price: 800,
    audio_minutes_included: 400,
    monthly_reports_included: 4
  }
];

async function seedPlans() {
  logger.info('🌱 Sembrando planes iniciales...');

    for (const plan of plans) {
      const existing = await dbGet('SELECT id FROM plans WHERE name = ?', [plan.name]);

      if (existing) {
        logger.info(`   ↺ Plan "${plan.name}" ya existe, actualizando...`);
        await dbRun(
          `UPDATE plans SET description = ?, price = ?, implementation_price = ?, currency = ?, billing_cycle = ?, features = ?, max_users = ?, max_storage = ?,
             messages_included = ?, message_overage_price = ?, call_minutes_included = ?, minute_overage_price = ?,
             audio_minutes_included = ?, monthly_reports_included = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [
            plan.description,
            plan.price,
            plan.implementation_price,
            plan.currency,
            plan.billing_cycle,
            JSON.stringify(plan.features),
            plan.max_users,
            plan.max_storage,
            plan.messages_included,
            plan.message_overage_price,
            plan.call_minutes_included,
            plan.minute_overage_price,
            plan.audio_minutes_included,
            plan.monthly_reports_included,
            existing.id
          ]
        );
      } else {
        logger.info(`   ✓ Creando plan "${plan.name}" - $${plan.price.toLocaleString('es-CO')} COP`);
        await dbRun(
          `INSERT INTO plans (name, description, price, implementation_price, currency, billing_cycle, features, max_users, max_storage,
             messages_included, message_overage_price, call_minutes_included, minute_overage_price,
             audio_minutes_included, monthly_reports_included)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            plan.name,
            plan.description,
            plan.price,
            plan.implementation_price,
            plan.currency,
            plan.billing_cycle,
            JSON.stringify(plan.features),
            plan.max_users,
            plan.max_storage,
            plan.messages_included,
            plan.message_overage_price,
            plan.call_minutes_included,
            plan.minute_overage_price,
            plan.audio_minutes_included,
            plan.monthly_reports_included
          ]
        );
      }
    }

    logger.info('✅ Planes sembrados exitosamente');
}

if (require.main === module) {
  seedPlans()
    .then(async () => { await close(); process.exit(0); })
    .catch(async (error) => {
      logger.error('❌ Error sembrando planes', error);
      await close();
      process.exit(1);
    });
}

module.exports = seedPlans;
