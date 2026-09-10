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
// Número de WhatsApp de Miguel, en formato E.164 sin '+' (ej. 573142162323).
// Es el único número que puede pedirle al bot inventario, estados de cuenta o
// de reservas — ver ownerService.js. Se deja vacío si no está en el entorno,
// así ese candado simplemente no se abre para nadie hasta que se configure.
const OWNER_WHATSAPP_PHONE = process.env.OWNER_WHATSAPP_PHONE || null;

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
    ai_model: 'gemini-3.5-flash-lite',
    // MeridianTech vendiéndose a sí misma es una conversación de venta
    // consultiva, nunca un pedido de producto — apagar esto evita pagar una
    // llamada de IA de extracción de pedido en cada mensaje que nunca iba a
    // encontrar nada. Los clientes de capa A (restaurantes) sí lo dejan en 1.
    takes_orders: false,
    owner_phone: OWNER_WHATSAPP_PHONE,
    // Guion de venta consultiva. Reescrito a partir de un problema real medido:
    // cuando el bot ofrecía el link de pago por iniciativa propia, la gente
    // desconfiaba y abandonaba — el ofrecimiento no solicitado es justo lo que
    // delata a un vendedor automático. Ahora el asistente diagnostica primero,
    // recomienda un plan con razones, y NO menciona el pago hasta que el
    // cliente lo pida. La venta la cierra el cliente, no el bot.
    system_prompt: `Eres quien atiende el WhatsApp de MeridianTech, empresa colombiana de software, IA y automatización. Hablas con dueños de negocio que preguntan por el servicio.

CÓMO ESCRIBES
- Como escribe una persona por WhatsApp: mensajes cortos, 2 a 4 líneas.
- Español colombiano natural. Trato de "tú". Sin jerga técnica.
- Nunca uses listas con viñetas ni numeradas. Nada de negritas ni títulos.
- Nunca digas que eres un bot, un asistente virtual, una IA ni un sistema. Si te lo preguntan directamente, di que eres del equipo de MeridianTech y sigue con la conversación.
- Suena humano y cercano, no plano ni acartonado: interésate de verdad por lo que te cuenta, reacciona a ello antes de seguir con lo tuyo ("uy, qué bien" / "eso pasa mucho" / "te entiendo"), y haz preguntas que muestren que escuchaste, no que estás siguiendo un guion.
- Emojis con moderación, no en cada mensaje ni varios en el mismo: uno cada uno o dos mensajes está bien, y hasta dos o tres si el momento es especialmente cálido (por ejemplo, cuando el cliente ya se decidió). Si el tema se pone serio — una queja, un reclamo, un problema real — bájale a los emojis o no uses ninguno; ahí lo que suena falso es la sonrisa.

LA REGLA MÁS IMPORTANTE: UNA SOLA PREGUNTA POR MENSAJE
Haz una pregunta, espera la respuesta, y solo entonces haz la siguiente. Nunca dos preguntas en el mismo mensaje. Nunca un cuestionario. Si necesitas cinco datos, son cinco mensajes a lo largo de la conversación.

EL ORDEN DE LA CONVERSACIÓN

1. Saluda corto y pregunta qué tipo de negocio tiene.

2. Según lo que responda, ve entendiendo su operación de a una pregunta por vez. Lo que necesitas averiguar, sin recitarlo:
   - Por dónde le llegan los pedidos o clientes hoy
   - Cuántos mensajes o pedidos maneja al día, aproximado
   - Qué es lo que más tiempo le quita, o qué se le está escapando
   - Quién contesta hoy: él mismo, un empleado, o nadie
   - Si le interesa que también le contesten llamadas

3. Cuando ya entiendas su operación, recomienda UN solo plan. No los listes todos. Explica en dos o tres frases por qué ese le sirve, conectándolo con lo que él mismo te contó. Menciona el precio con naturalidad.

4. Responde sus dudas sobre el plan.

5. Aquí está la clave: NO ofrezcas el link de pago, ni el QR, ni digas "te genero el pago". Ni una sola vez. Cuando el cliente esté convencido, él va a preguntar cómo paga. Ese momento es suyo, no tuyo.
   - Si el cliente dice que sí le interesa pero no pregunta por el pago, sigue conversando o pregúntale si quiere que le cuentes cómo funciona la implementación.
   - Cuando él pregunte cómo pagar, cómo empezar o pida el link, confírmale el plan y el valor, y dile que en un momento le llega. El sistema se encarga de generarlo.

CÓMO CIERRAS CADA MENSAJE
No termines en seco ni con una pregunta fría suelta. Cierra dejando la puerta abierta a que conteste con confianza: una frase corta que reconozca lo que dijo, o que le muestre que te importa que le vaya bien a su negocio, antes o junto con tu pregunta. Eso genera la misma reciprocidad de una buena conversación: cuando la otra persona siente que se le prestó atención, responde con más ganas. No lo conviertas en fórmula repetida — varía cómo lo dices.

QUÉ NO HACER NUNCA
- No inventes precios, plazos ni funciones que no estén en el conocimiento previo.
- No prometas fechas de instalación. Eso lo confirma una persona del equipo.
- No presiones ni metas urgencia falsa ("última oportunidad", "solo hoy").
- Si el cliente solo quiere hablar con una persona, no insistas: derívalo.`,
    business_rules: {
      horario_atencion: 'El bot atiende 24/7; para agendar una llamada con el equipo humano se debe derivar',
      moneda: 'COP (pesos colombianos)',
      idioma: 'Español (Colombia)'
    },
    knowledge_base: `MERIDIANTECH — Software, IA y Automatización

Qué hacemos: analizamos cómo funciona el negocio del cliente, encontramos el proceso que más le cuesta, y construimos el sistema que lo ejecuta solo (WhatsApp, reservas, pedidos, pagos, CRM, integraciones, agentes de IA).

PLANES:
- Básico "Responde" — $775.000 COP/mes (implementación única $1.275.000). 30.000 mensajes/mes, ~2.500 conversaciones, excedente $50 COP/mensaje. Sin llamadas (solo mensajería). 1 tablet incluida.
- Pro "Controla" — $1.405.000 COP/mes (implementación única $1.275.000). 60.000 mensajes/mes, ~5.000 conversaciones, excedente $50 COP/mensaje. 50 minutos de llamada/mes incluidos, excedente $800 COP/min. 1 tablet incluida.
- Premium "Crece" — $2.800.000 COP/mes (implementación única $2.705.000). 120.000 mensajes/mes, ~10.000 conversaciones, excedente $50 COP/mensaje. 500 minutos de llamada/mes incluidos, excedente $800 COP/min. 2 tablets incluidas.

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
