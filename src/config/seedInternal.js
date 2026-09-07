require('dotenv').config();
const { dbGet, dbRun, close } = require('./database');
const authService = require('../services/authService');
const geminiService = require('../services/geminiService');
const logger = require('../utils/logger');

/**
 * Registra:
 * 1. A Juan como segundo usuario administrador (acceso al panel + bandeja
 *    de conversaciones en vivo, capa A y capa B).
 * 2. A MeridianTech como su propio "cliente interno" (client_id, is_internal=1)
 *    para que use su propio producto sobre sí misma (Capa B del flujo).
 */

const JUAN_EMAIL = process.env.JUAN_EMAIL || 'jmendeznino18@gmail.com';
const JUAN_PASSWORD = process.env.JUAN_PASSWORD;

async function seedInternal() {
  // 1. Usuario de Juan
  const existingJuan = await dbGet('SELECT id FROM users WHERE email = ?', [JUAN_EMAIL]);
  if (existingJuan) {
    logger.info('✅ Usuario de Juan ya existe', { email: JUAN_EMAIL });
  } else {
    if (!JUAN_PASSWORD) {
      logger.warn('⚠️  JUAN_PASSWORD no configurado - omitiendo creación de usuario de Juan');
    } else {
      await authService.createUser(JUAN_EMAIL, JUAN_PASSWORD, 'Juan', 'admin');
      logger.info('✅ Usuario de Juan creado', { email: JUAN_EMAIL });
    }
  }

  // 2. Cliente interno: MeridianTech
  let internalClientId;
  const existingInternal = await dbGet('SELECT id FROM clients WHERE is_internal = 1');
  if (existingInternal) {
    internalClientId = existingInternal.id;
    logger.info('✅ Cliente interno MeridianTech ya existe', { clientId: internalClientId });
  } else {
    const result = await dbRun(
      `INSERT INTO clients (name, email, company, city, country, status, notes, is_internal)
       VALUES (?, ?, ?, ?, ?, 'active', ?, 1)`,
      [
        'MeridianTech',
        'meridiantech7@gmail.com',
        'MeridianTech SAS',
        'Medellín',
        'Colombia',
        'Cliente interno — MeridianTech usando su propio producto para automatizar su operación (Capa B del flujo).'
      ]
    );
    internalClientId = result.id;
    logger.info('✅ Cliente interno MeridianTech creado', { clientId: internalClientId });
  }

  // 3. Configuración del nodo de IA para MeridianTech (capa B) — conocimiento
  // real extraído de la propuesta de valor y los planes de la landing.
  await geminiService.upsertBotConfig(internalClientId, {
    ai_model: 'gemini-3.6-flash',
    system_prompt: 'Eres el asistente de atención de MeridianTech, una empresa colombiana de software, IA y automatización. Respondes por WhatsApp a personas que preguntan por los servicios. Tono: claro, directo, profesional pero cercano, sin tecnicismos innecesarios. Nunca inventes precios, plazos ni funcionalidades que no estén en el conocimiento previo.',
    business_rules: {
      horario_atencion: 'El bot atiende 24/7; para agendar una llamada con el equipo humano se debe derivar',
      moneda: 'COP (pesos colombianos)',
      idioma: 'Español (Colombia)'
    },
    knowledge_base: `MERIDIANTECH — Software, IA y Automatización

Qué hacemos: analizamos cómo funciona el negocio del cliente, encontramos el proceso que más le cuesta, y construimos el sistema que lo ejecuta solo (WhatsApp, reservas, pedidos, pagos, CRM, integraciones, agentes de IA).

PLANES:
- Básico "Responde" — $495.000 COP/mes (implementación única $850.000). 30.000 mensajes/mes, ~2.500 conversaciones, excedente $50 COP/mensaje. Sin llamadas (solo mensajería). 1 tablet incluida.
- Pro "Controla" — $995.000 COP/mes (implementación única $1.100.000). 60.000 mensajes/mes, ~5.000 conversaciones, excedente $50 COP/mensaje. 50 minutos de llamada/mes incluidos, excedente $800 COP/min. 1 tablet incluida.
- Premium "Crece" — $1.995.000 COP/mes (implementación única $1.800.000). 120.000 mensajes/mes, ~10.000 conversaciones, excedente $50 COP/mensaje. 500 minutos de llamada/mes incluidos, excedente $800 COP/min. 2 tablets incluidas.

Los precios son en pesos colombianos. Una conversación equivale a unos 12 mensajes. Cada proyecto se ajusta al alcance real: los planes son el punto de partida, no el techo — si el cliente pregunta algo muy específico de su caso, se debe derivar a una persona del equipo.

Contacto humano: WhatsApp +57 314 2162323.`,
    handoff_keywords: ['precio final', 'contrato', 'factura', 'descuento', 'reunión', 'demo en vivo']
  });
  logger.info('✅ Conocimiento previo del bot de MeridianTech configurado');
}

if (require.main === module) {
  seedInternal()
    .then(async () => { await close(); process.exit(0); })
    .catch(async (error) => {
      logger.error('❌ Error sembrando datos internos', error);
      await close();
      process.exit(1);
    });
}

module.exports = seedInternal;
