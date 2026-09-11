const express = require('express');
const { verifyToken, esStaff, clienteForzado } = require('../middleware/auth');
const callService = require('../services/callService');

const router = express.Router();

/**
 * Llamadas por WhatsApp. Lo que toca la configuración del número en Meta y
 * las pruebas contra Gemini es solo del equipo de MeridianTech: un usuario de
 * un restaurante no puede prender ni apagar las llamadas de la línea.
 */
const soloEquipo = (req, res, next) => {
  if (!esStaff(req.user)) return res.status(403).json({ error: 'Solo el equipo de MeridianTech' });
  next();
};

// GET /api/calls?client_id=1 — historial de llamadas del negocio
router.get('/', verifyToken, async (req, res, next) => {
  try {
    const forzado = clienteForzado(req.user);
    const clientId = forzado !== null ? forzado : req.query.client_id;
    if (!clientId) return res.status(400).json({ error: 'client_id requerido' });
    res.json({ success: true, data: await callService.listarLlamadas(clientId) });
  } catch (error) {
    next(error);
  }
});

// GET /api/calls/estado — cómo está el número en Meta (límite, calidad, llamadas)
router.get('/estado', verifyToken, soloEquipo, async (req, res, next) => {
  try {
    res.json({ success: true, data: await callService.estadoEnMeta() });
  } catch (error) {
    next(error);
  }
});

// POST /api/calls/configuracion  { habilitar: true|false }
router.post('/configuracion', verifyToken, soloEquipo, async (req, res, next) => {
  try {
    const r = await callService.configurarEnMeta({ habilitar: req.body?.habilitar === true });
    res.status(r.ok ? 200 : 409).json(r);
  } catch (error) {
    next(error);
  }
});

// GET /api/calls/diagnostico/gemini-live?n=5&modelo=...
router.get('/diagnostico/gemini-live', verifyToken, soloEquipo, async (req, res, next) => {
  try {
    const n = Math.min(8, Math.max(1, parseInt(req.query.n, 10) || 5));
    const r = await callService.probarConcurrenciaLive(n, req.query.modelo || undefined);
    res.json(r);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
