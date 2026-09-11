const { dbGet } = require('../config/database');
const planService = require('./planService');
const logger = require('../utils/logger');

/**
 * Qué cuesta de verdad sostener a un cliente, y cuánto margen queda.
 *
 * Existe para que la contabilidad se pueda CONSULTAR desde el sistema en vez
 * de reconstruirla a mano en una hoja cada vez que cambia un precio. Los
 * números de aquí no son un adorno: son los que deciden si un plan se puede
 * vender o si se está regalando trabajo.
 *
 * ⚠️ NADA DE ESTE ARCHIVO SALE HACIA UN CLIENTE. Es información interna de
 * MERIDIANTECH. Se expone únicamente al dueño por WhatsApp administrativo,
 * detrás del mismo candado `ownerService.esDueno` que usan reportService e
 * inventoryService. El asistente de ventas no puede responder nada de esto.
 *
 * Cada constante está marcada con su origen: OFICIAL (publicado por el
 * proveedor), MEDIDO (contado en nuestro propio código), ESTIMADO (supuesto
 * razonable, sin cifra oficial) o NEGOCIO (decisión de la empresa). Los
 * ESTIMADOS son los que hay que volver a mirar cuando salga el dato real.
 */

// La tasa fluctúa todas las semanas, así que va en variable de entorno y no a
// fuego: cambiarla no puede exigir un despliegue.
const TASA_USD_COP = Number(process.env.TASA_USD_COP) || 3150;

const GEMINI = {
  // OFICIAL — ai.google.dev/gemini-api/docs/pricing (gemini 3.5 flash-lite)
  entradaUSDPorMillon: 0.30,
  salidaUSDPorMillon: 2.50
};

// MEDIDO sobre seedInternal.js real. Se paga en CADA turno, no una vez: es el
// costo fijo de que el bot sepa quién es y qué vende.
const PROMPT_FIJO = {
  systemPrompt: 944,
  knowledgeBase: 331,
  reglasYCierre: 200
};

const POR_MENSAJE = {
  historialPromedio: 180,   // MEDIDO — ventana de los últimos 20 mensajes
  mensajeNuevo: 30,         // ESTIMADO
  respuestaBot: 85,         // MEDIDO — tope real maxOutputTokens: 300
  caracteresPorToken: 3.8   // ESTIMADO — español
};

const META = {
  // ESTIMADO — Meta cobra por conversación desde octubre de 2026 y todavía no
  // publicó la tarifa de servicio exacta para Colombia. Se usa la tarifa
  // "utility" como referencia. PENDIENTE: reemplazar por la oficial.
  costoConversacionUSD: 0.003,
  mensajesPorConversacion: 12,
  // OFICIAL — WhatsApp Calling, sin número aparte
  costoMinutoLlamadaCOP: 44
};

// OFICIAL — twilio.com/en-us/voice/pricing/co
// NO es el canal por defecto: WhatsApp Calling lo es. Twilio entra solo cuando
// un negocio necesita varias llamadas simultáneas.
const TWILIO = {
  alquilerNumeroUSD: 14,
  minutoEntranteUSD: 0.0945,
  minutoSalienteUSD: 0.0377   // referencia, no entra al cálculo
};

const ELEVENLABS = {
  primerMesUSD: 11,           // OFICIAL — con descuento, una sola vez
  recurrenteUSD: 22,          // OFICIAL — plan Creator
  creditosIncluidos: 121000,  // OFICIAL
  creditosPorCaracter: 0.5,   // OFICIAL — modelo Flash/Turbo
  caracteresPorMinuto: 1000,  // ESTIMADO — ElevenLabs no publica esta cifra
  excedenteUSDPorMilCaracteres: 0.18
};

// OFICIAL — bold.co/tarifas. Se descuenta de CUALQUIER cobro por Bold:
// la mensualidad y también la implementación.
const BOLD = { comision: 0.0329, iva: 0.19 };
const TASA_BOLD_EFECTIVA = BOLD.comision * (1 + BOLD.iva); // ≈ 3.9151%

// NEGOCIO — costo real de lo que se instala
const EQUIPO = {
  tabletBase: 650000,        // Galaxy A11+ (Básico/Pro, y una de las de Premium)
  segundaTabletPremium: 1100000,
  soportePorTablet: 45000,
  vidrioPorTablet: 15000,
  cargadorPorTablet: 35000,
  estuchePorTablet: 25000,
  manoDeObra: 0,             // no se cobra aparte
  otrosGastos: 50000         // imprevistos
};

// NEGOCIO — lo que la empresa paga cada mes exista o no un cliente
const FIJOS_USD = {
  claude: 100,
  supabase: 20,
  railway: 20,
  dominio: 10,
  twilioCuenta: 20,          // DISTINTO del número por cliente
  compraNumeroTwilio: 1      // una sola vez, se amortiza en 12 meses
};
const MESES_AMORTIZACION_NUMERO = 12;

// El bot propio de MeridianTech (capa B) también consume Gemini, y ese consumo
// es gasto fijo de la empresa, no de ningún cliente.
const MENSAJES_INTERNOS_MES = 30000;

// NEGOCIO — decisión interna, no es del sistema de cara al cliente.
// Se descuenta del margen del PRIMER mes de ESE cliente, no de los siguientes.
const REFERIDOS = { comisionFijaCOP: 100000, porcentajePrimerMes: 0.10 };

// Estructura lista para cuando se contrate la primera API adicional, para no
// tener que construirla desde cero después. Hoy está vacía a propósito.
const APIS_ADICIONALES = [
  // { nombre: 'X', costoUSDMes: 0, planQueLaPaga: 'Premium' }
];

const aCOP = (usd) => usd * TASA_USD_COP;

/** Tokens de entrada que se pagan en un turno cualquiera. */
const tokensEntradaPorMensaje = () =>
  PROMPT_FIJO.systemPrompt + PROMPT_FIJO.knowledgeBase + PROMPT_FIJO.reglasYCierre +
  POR_MENSAJE.historialPromedio + POR_MENSAJE.mensajeNuevo;

const costoGeminiPorMensaje = () => {
  const entrada = tokensEntradaPorMensaje() * GEMINI.entradaUSDPorMillon / 1e6;
  const salida = POR_MENSAJE.respuestaBot * GEMINI.salidaUSDPorMillon / 1e6;
  return aCOP(entrada + salida);
};

const costoMetaPorMensaje = () =>
  aCOP(META.costoConversacionUSD / META.mensajesPorConversacion);

const costoIAPorMensaje = () => costoGeminiPorMensaje() + costoMetaPorMensaje();

const costoPorMinutoElevenLabs = () =>
  aCOP(
    (ELEVENLABS.caracteresPorMinuto * ELEVENLABS.creditosPorCaracter) *
    (ELEVENLABS.recurrenteUSD / ELEVENLABS.creditosIncluidos)
  );

const comisionBold = (monto) => monto * TASA_BOLD_EFECTIVA;

/** Costo de las llamadas del plan, según el canal contratado. */
const costoLlamadas = (minutos, canal = 'whatsapp') => {
  if (!minutos) return 0;
  if (canal === 'twilio') {
    return aCOP(TWILIO.alquilerNumeroUSD) + aCOP(minutos * TWILIO.minutoEntranteUSD);
  }
  return minutos * META.costoMinutoLlamadaCOP;
};

/** Lo que cuesta de verdad instalar, incluidos los accesorios de cada tablet. */
const costoImplementacionReal = (esPremium) => {
  const tablets = esPremium ? 2 : 1;
  const equipo = EQUIPO.tabletBase + (esPremium ? EQUIPO.segundaTabletPremium : 0);
  const accesoriosPorTablet = EQUIPO.soportePorTablet + EQUIPO.vidrioPorTablet +
    EQUIPO.cargadorPorTablet + EQUIPO.estuchePorTablet;
  return equipo + tablets * accesoriosPorTablet + EQUIPO.manoDeObra + EQUIPO.otrosGastos;
};

const costoFijoTotalEmpresa = () => {
  const suscripciones = FIJOS_USD.claude + FIJOS_USD.supabase + FIJOS_USD.railway +
    FIJOS_USD.dominio + FIJOS_USD.twilioCuenta +
    FIJOS_USD.compraNumeroTwilio / MESES_AMORTIZACION_NUMERO;
  const apis = APIS_ADICIONALES.reduce((s, a) => s + (a.costoUSDMes || 0), 0);
  return aCOP(suscripciones + apis) +
    MENSAJES_INTERNOS_MES * costoIAPorMensaje() +
    aCOP(ELEVENLABS.recurrenteUSD);
};

/** Cuántos clientes están pagando hoy. Puede ser 0, y eso importa. */
const clientesActivos = async () => {
  const fila = await dbGet(
    `SELECT COUNT(DISTINCT client_id) as total FROM subscriptions WHERE status = 'active'`
  );
  return fila?.total || 0;
};

/**
 * El gasto fijo repartido, o null cuando todavía no hay clientes.
 *
 * Devolver null y no un número es deliberado: con cero clientes la división es
 * infinita, y "cada cliente aporta infinito" no es una cifra, es un error
 * disfrazado. Mientras no haya nadie pagando, el gasto fijo se reporta entero
 * y aparte — que es la verdad: lo está pagando la empresa de su bolsillo.
 */
const aporteFijoPorCliente = (total, activos) => (activos > 0 ? total / activos : null);

/**
 * Costo y margen real de un plan.
 *
 * @param {object} plan fila de `plans`
 * @param {object} opciones { canalLlamadas, activos, esPrimerMes, vinoPorReferido }
 */
const calcularPlan = (plan, opciones = {}) => {
  const canal = opciones.canalLlamadas || 'whatsapp';
  const activos = opciones.activos ?? 0;
  const esPremium = plan.name === 'Premium';

  const costoMensajes = (plan.messages_included || 0) * costoIAPorMensaje();
  const costoLlamada = costoLlamadas(plan.call_minutes_included || 0, canal);
  const costoAudio = (plan.audio_minutes_included || 0) * costoPorMinutoElevenLabs();
  const comision = comisionBold(plan.price);

  const fijoTotal = costoFijoTotalEmpresa();
  const aporteFijo = aporteFijoPorCliente(fijoTotal, activos);

  // Sin clientes reales no se le carga gasto fijo a nadie: inventarle un aporte
  // a un cliente que no existe haría ver los planes peor de lo que son.
  const costoMensual = costoMensajes + costoLlamada + costoAudio + comision + (aporteFijo ?? 0);
  const utilidad = plan.price - costoMensual;

  const implementacionCosto = costoImplementacionReal(esPremium);
  const comisionImplementacion = comisionBold(plan.implementation_price || 0);
  const utilidadImplementacion =
    (plan.implementation_price || 0) - implementacionCosto - comisionImplementacion;

  // El referido se descuenta UNA vez, del primer mes de ese cliente.
  const costoReferido = opciones.vinoPorReferido
    ? REFERIDOS.comisionFijaCOP + plan.price * REFERIDOS.porcentajePrimerMes
    : 0;

  return {
    plan: plan.name,
    precio: plan.price,
    mensual: {
      costoMensajes,
      costoLlamada,
      costoAudio,
      comisionBold: comision,
      aporteFijo,              // null si todavía no hay clientes
      costoTotal: costoMensual,
      utilidad,
      margen: plan.price ? utilidad / plan.price : 0
    },
    implementacion: {
      cobro: plan.implementation_price || 0,
      costoEquipoYMontaje: implementacionCosto,
      comisionBold: comisionImplementacion,
      // Dos vistas a proposito. "Bruta" es cobro - costo del equipo, que es
      // como se piensa el negocio al cotizar. "Neta" descuenta ademas la
      // comision de Bold, que es la plata que de verdad entra a la cuenta.
      // Si se cobra por transferencia, la comision no existe y la bruta es la
      // real — por eso se muestran las dos y no una sola.
      utilidadBruta: (plan.implementation_price || 0) - implementacionCosto,
      margenBruto: plan.implementation_price
        ? ((plan.implementation_price || 0) - implementacionCosto) / plan.implementation_price : 0,
      utilidad: utilidadImplementacion,
      margen: plan.implementation_price ? utilidadImplementacion / plan.implementation_price : 0
    },
    primerMes: {
      costoReferido,
      utilidad: utilidad + utilidadImplementacion - costoReferido
    }
  };
};

/**
 * Paquetes adicionales: mensajes o minutos sueltos, por fuera del plan.
 *
 * El precio NO se saca cargándole al cliente el gasto fijo de la empresa (la
 * contadora, Railway, Claude). Eso ya lo cubre la mensualidad. Un paquete
 * adicional solo tiene que cubrir su propio consumo y dejar margen — cargarle
 * otra vez la estructura seria cobrar dos veces lo mismo y sacaría precios que
 * nadie compra.
 *
 * Se calcula desde el costo real medido y se redondea hacia arriba a una cifra
 * vendible: nadie cotiza "$152.500".
 */
const MARGEN_OBJETIVO_PAQUETES = 0.80;

const TAMANOS = {
  mensajes: [5000, 10000, 25000, 50000],
  minutosWhatsapp: [100, 300, 600, 1000],
  minutosAudio: [50, 100, 200, 400]
};

/** Redondea hacia arriba a la decena de miles: una cifra que se pueda cotizar. */
const aPrecioVendible = (n) => Math.ceil(n / 10000) * 10000;

const armarPaquete = (cantidad, costoUnitario, unidad, precioExcedente, margen) => {
  const costo = cantidad * costoUnitario;
  const precio = aPrecioVendible(costo / (1 - margen));
  const utilidad = precio - costo;
  return {
    cantidad,
    unidad,
    costo,
    precio,
    utilidad,
    margen: utilidad / precio,
    precioUnitario: precio / cantidad,
    // Lo mismo comprado como excedente suelto, para mostrar el ahorro: es el
    // argumento de venta del paquete, y de paso confirma que el paquete no
    // salga más caro que no comprarlo.
    costaríaSuelto: precioExcedente ? cantidad * precioExcedente : null,
    ahorro: precioExcedente ? cantidad * precioExcedente - precio : null
  };
};

const paquetesSugeridos = (margen = MARGEN_OBJETIVO_PAQUETES) => {
  const porMensaje = costoIAPorMensaje();
  const porMinuto = META.costoMinutoLlamadaCOP;
  const porMinutoAudio = costoPorMinutoElevenLabs();

  return {
    margenObjetivo: margen,
    costosUnitarios: {
      mensaje: porMensaje,
      minutoWhatsapp: porMinuto,
      minutoAudio: porMinutoAudio
    },
    mensajes: TAMANOS.mensajes.map((n) =>
      armarPaquete(n, porMensaje, 'mensajes', 50, margen)),
    minutosWhatsapp: TAMANOS.minutosWhatsapp.map((n) =>
      armarPaquete(n, porMinuto, 'minutos de llamada', 800, margen)),
    minutosAudio: TAMANOS.minutosAudio.map((n) =>
      armarPaquete(n, porMinutoAudio, 'minutos de audio', null, margen))
  };
};

/** Foto completa: todos los planes activos más el gasto fijo de la empresa. */
const panorama = async (opciones = {}) => {
  const activos = await clientesActivos();
  const planes = await require('../config/database').dbAll(
    "SELECT * FROM plans WHERE status = 'active' ORDER BY price ASC"
  );
  const fijoTotal = costoFijoTotalEmpresa();

  return {
    tasaUSDCOP: TASA_USD_COP,
    clientesActivos: activos,
    gastoFijoMensual: fijoTotal,
    aporteFijoPorCliente: aporteFijoPorCliente(fijoTotal, activos),
    costoPorMensaje: costoIAPorMensaje(),
    costoPorMinutoAudio: costoPorMinutoElevenLabs(),
    planes: planes.map((p) => calcularPlan(p, { ...opciones, activos }))
  };
};

const pesos = (n) => '$' + Math.round(n).toLocaleString('es-CO');
const pct = (n) => (n * 100).toFixed(1) + '%';

/** ¿El dueño está preguntando por costos o margen? Se revisa sin gastar IA. */
const FRASES_COSTO = [
  'cuanto nos cuesta', 'cuánto nos cuesta', 'cuanto cuesta el plan', 'cuánto cuesta el plan',
  'margen real', 'cual es el margen', 'cuál es el margen', 'margen del plan',
  'costo real', 'costos reales', 'cuanto ganamos', 'cuánto ganamos',
  'rentabilidad', 'utilidad del plan', 'gasto fijo', 'cuanto gastamos', 'cuánto gastamos'
];

const normalizar = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

const FRASES_PAQUETES = [
  'paquete', 'paquetes', 'mensajes adicionales', 'minutos adicionales',
  'recarga', 'cuanto cobro por mensajes', 'cuánto cobro por mensajes',
  'venderle mensajes', 'venderle minutos', 'adicional de mensajes', 'adicional de minutos'
];

const esConsultaDePaquetes = (texto) => {
  const t = normalizar(texto);
  if (!t) return false;
  return FRASES_PAQUETES.some((f) => t.includes(normalizar(f)));
};

const esConsultaDeCostos = (texto) => {
  const t = normalizar(texto);
  if (!t) return false;
  return FRASES_COSTO.some((f) => t.includes(normalizar(f)));
};

/** Resumen para mandar por WhatsApp al dueño. Nunca sale de ahí. */
const resumenParaWhatsApp = async (texto) => {
  const datos = await panorama();

  const lineas = datos.planes.map((p) =>
    `${p.plan}: cobra ${pesos(p.precio)} · cuesta ${pesos(p.mensual.costoTotal)} · ` +
    `queda ${pesos(p.mensual.utilidad)} (${pct(p.mensual.margen)})`
  );

  const implementacion = datos.planes.map((p) =>
    `${p.plan}: cobra ${pesos(p.implementacion.cobro)} · cuesta ${pesos(p.implementacion.costoEquipoYMontaje)} · ` +
    `queda ${pesos(p.implementacion.utilidad)} (${pct(p.implementacion.margen)})`
  );

  const fijo = datos.aporteFijoPorCliente === null
    ? `Gasto fijo de la empresa: ${pesos(datos.gastoFijoMensual)} al mes, todavía sin repartir ` +
      `(no hay clientes activos, así que hoy lo estamos pagando nosotros completo).`
    : `Gasto fijo: ${pesos(datos.gastoFijoMensual)} al mes, ${pesos(datos.aporteFijoPorCliente)} por cliente ` +
      `(${datos.clientesActivos} activos).`;

  logger.info('Consulta de costos respondida al dueño', { texto: texto?.slice(0, 80) });

  return `MENSUALIDAD\n${lineas.join('\n')}\n\n` +
    `IMPLEMENTACIÓN\n${implementacion.join('\n')}\n\n` +
    `${fijo}\n\n` +
    `Cada mensaje cuesta ${pesos(datos.costoPorMensaje)} y cada minuto de audio ${pesos(datos.costoPorMinutoAudio)}. ` +
    `Dólar a ${datos.tasaUSDCOP}.`;
};

/** Los paquetes adicionales, listos para mandar por WhatsApp al dueño. */
const resumenPaquetesParaWhatsApp = () => {
  const SALTO = String.fromCharCode(10);
  const d = paquetesSugeridos();
  const linea = (x) =>
    `${x.cantidad.toLocaleString('es-CO')} ${x.unidad}: ${pesos(x.precio)} ` +
    `(cuesta ${pesos(x.costo)}, margen ${pct(x.margen)})` +
    (x.ahorro ? ` · suelto costaría ${pesos(x.costaríaSuelto)}` : '');

  logger.info('Consulta de paquetes adicionales respondida al dueño');

  return `PAQUETES SUGERIDOS (margen objetivo ${pct(d.margenObjetivo)})

` +
    `MENSAJES
${d.mensajes.map(linea).join(SALTO)}

` +
    `MINUTOS DE LLAMADA
${d.minutosWhatsapp.map(linea).join(SALTO)}

` +
    `MINUTOS DE AUDIO
${d.minutosAudio.map(linea).join(SALTO)}

` +
    `Costo real: ${pesos(d.costosUnitarios.mensaje)} por mensaje, ` +
    `${pesos(d.costosUnitarios.minutoWhatsapp)} por minuto de llamada, ` +
    `${pesos(d.costosUnitarios.minutoAudio)} por minuto de audio.
` +
    `El precio del paquete NO carga el gasto fijo de la empresa: eso ya lo cubre la mensualidad.`;
};

module.exports = {
  esConsultaDeCostos,
  esConsultaDePaquetes,
  resumenPaquetesParaWhatsApp,
  paquetesSugeridos,
  resumenParaWhatsApp,
  panorama,
  calcularPlan,
  costoIAPorMensaje,
  costoPorMinutoElevenLabs,
  costoFijoTotalEmpresa,
  costoImplementacionReal,
  comisionBold,
  clientesActivos,
  TASA_USD_COP
};
