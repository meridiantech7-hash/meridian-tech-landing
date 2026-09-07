require('dotenv').config();
const { dbGet, dbRun, close } = require('./database');
const logger = require('../utils/logger');

const plans = [
  {
    name: 'Básico',
    description: 'Automatización esencial para empezar a escalar tu operación',
    price: 495000,
    currency: 'COP',
    billing_cycle: 'monthly',
    features: [
      'Automatización de hasta 3 procesos',
      'Soporte por WhatsApp',
      'Reportes mensuales',
      '1 usuario administrador'
    ],
    max_users: 1,
    max_storage: 5
  },
  {
    name: 'Pro',
    description: 'Automatización avanzada con IA para equipos en crecimiento',
    price: 995000,
    currency: 'COP',
    billing_cycle: 'monthly',
    features: [
      'Automatización de hasta 10 procesos',
      'Integraciones con IA',
      'Soporte prioritario',
      'Reportes en tiempo real',
      'Hasta 5 usuarios administradores'
    ],
    max_users: 5,
    max_storage: 25
  },
  {
    name: 'Premium',
    description: 'Solución integral de automatización e IA a medida',
    price: 1995000,
    currency: 'COP',
    billing_cycle: 'monthly',
    features: [
      'Automatizaciones ilimitadas',
      'IA personalizada para tu negocio',
      'Soporte dedicado 24/7',
      'Dashboard ejecutivo en tiempo real',
      'Usuarios ilimitados',
      'Consultoría estratégica mensual'
    ],
    max_users: null,
    max_storage: 100
  }
];

async function seedPlans() {
  try {
    logger.info('🌱 Sembrando planes iniciales...');

    for (const plan of plans) {
      const existing = await dbGet('SELECT id FROM plans WHERE name = ?', [plan.name]);

      if (existing) {
        logger.info(`   ↺ Plan "${plan.name}" ya existe, actualizando...`);
        await dbRun(
          `UPDATE plans SET description = ?, price = ?, currency = ?, billing_cycle = ?, features = ?, max_users = ?, max_storage = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [
            plan.description,
            plan.price,
            plan.currency,
            plan.billing_cycle,
            JSON.stringify(plan.features),
            plan.max_users,
            plan.max_storage,
            existing.id
          ]
        );
      } else {
        logger.info(`   ✓ Creando plan "${plan.name}" - $${plan.price.toLocaleString('es-CO')} COP`);
        await dbRun(
          `INSERT INTO plans (name, description, price, currency, billing_cycle, features, max_users, max_storage)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            plan.name,
            plan.description,
            plan.price,
            plan.currency,
            plan.billing_cycle,
            JSON.stringify(plan.features),
            plan.max_users,
            plan.max_storage
          ]
        );
      }
    }

    logger.info('✅ Planes sembrados exitosamente');
    await close();
    process.exit(0);
  } catch (error) {
    logger.error('❌ Error sembrando planes', error);
    process.exit(1);
  }
}

if (require.main === module) {
  seedPlans();
}

module.exports = seedPlans;
