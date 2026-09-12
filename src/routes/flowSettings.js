const express = require('express');
const Joi = require('joi');
const { verifyToken } = require('../middleware/auth');
const sb = require('../services/supabaseApp');
const logger = require('../utils/logger');

/**
 * Ajustes del flujo de Valeria, editables desde el panel.
 *
 * Viven en Supabase (app.flow_settings) porque es el flujo de n8n el que los
 * lee en cada mensaje: si se guardaran en la base de Railway, cambiar un
 * horario obligaría a tocar el flujo a mano.
 *
 * El horario es el caso que motivó esta ruta. Valeria responde mensajes a
 * cualquier hora, pero las visitas, demos e instalaciones solo se agendan
 * dentro del horario de oficina; cuando ese horario no existía en ninguna
 * parte, agendó una visita un domingo a las 9 de la mañana.
 */

const router = express.Router();

// Qué se puede editar desde el panel. Deliberadamente corto: las llaves de
// pago, los tokens y los guiones largos no se tocan desde aquí.
const EDITABLES = new Set([
  'horario_agenda',
  'horario_texto',
  'mensaje_fuera_horario',
  'espera_rafaga_seg',
  'humano_retoma_min',
  'audio_seguimiento_min',
  'memoria_dias_historial',
  'memoria_horas_cierre'
]);

const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * El horario se guarda como JSON con una clave por día (0 = domingo) y un par
 * [apertura, cierre], o null si ese día está cerrado. Se valida aquí y no solo
 * en el navegador: un horario invertido (cierra antes de abrir) dejaría la
 * agenda sin ninguna hora válida y Valeria rechazaría todas las citas.
 */
const validarHorario = (valor) => {
  let h;
  try { h = JSON.parse(valor); } catch (e) { return 'El horario no es un JSON válido'; }
  if (!h || typeof h !== 'object' || Array.isArray(h)) return 'El horario debe ser un objeto por día';
  for (const dia of ['0', '1', '2', '3', '4', '5', '6']) {
    if (!(dia in h)) return `Falta el día ${dia} en el horario`;
    const franja = h[dia];
    if (franja === null) continue;
    if (!Array.isArray(franja) || franja.length !== 2) return `El día ${dia} debe ser null o [apertura, cierre]`;
    if (!HORA.test(franja[0]) || !HORA.test(franja[1])) return `El día ${dia} tiene una hora con formato inválido (use HH:MM)`;
    if (franja[0] >= franja[1]) return `El día ${dia} cierra antes de abrir`;
  }
  return null;
};

const guardarSchema = Joi.object({
  ajustes: Joi.object().pattern(Joi.string(), Joi.string().allow('')).min(1).required()
});

// GET /api/flow-settings - Ajustes editables, con su descripción.
router.get('/', verifyToken, async (req, res, next) => {
  try {
    if (!sb.activo()) return res.status(503).json({ error: 'El flujo en n8n no está activo' });
    const filas = await sb.select('flow_settings', 'select=key,value,description,updated_at');
    res.json({
      success: true,
      data: filas
        .filter((f) => EDITABLES.has(f.key))
        .sort((a, b) => a.key.localeCompare(b.key))
    });
  } catch (error) {
    next(error);
  }
});

// PUT /api/flow-settings - Guarda uno o varios ajustes.
router.put('/', verifyToken, async (req, res, next) => {
  try {
    if (!sb.activo()) return res.status(503).json({ error: 'El flujo en n8n no está activo' });

    const { error, value } = guardarSchema.validate(req.body);
    if (error) { error.isJoi = true; throw error; }

    const claves = Object.keys(value.ajustes);
    const prohibida = claves.find((k) => !EDITABLES.has(k));
    if (prohibida) return res.status(400).json({ error: `El ajuste "${prohibida}" no se edita desde el panel` });

    if (value.ajustes.horario_agenda) {
      const problema = validarHorario(value.ajustes.horario_agenda);
      if (problema) return res.status(400).json({ error: problema });
    }

    for (const key of claves) {
      await sb.actualizar('flow_settings', `key=eq.${encodeURIComponent(key)}`, {
        value: value.ajustes[key],
        updated_at: new Date().toISOString()
      });
    }

    logger.info('Ajustes del flujo actualizados', { claves, userId: req.user.id });
    res.json({ success: true, message: 'Ajustes guardados' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
