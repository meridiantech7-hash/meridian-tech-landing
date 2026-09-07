const express = require('express');
const Joi = require('joi');
const authService = require('../services/authService');
const { verifyToken } = require('../middleware/auth');
const logger = require('../utils/logger');

const router = express.Router();

// Schema de validación
const loginSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().min(6).required()
});

const passwordSchema = Joi.object({
  oldPassword: Joi.string().min(6).required(),
  newPassword: Joi.string().min(6).required()
});

// POST /api/auth/login
router.post('/login', async (req, res, next) => {
  try {
    const { error, value } = loginSchema.validate(req.body);
    if (error) {
      error.isJoi = true;
      throw error;
    }

    const result = await authService.login(value.email, value.password);

    res.cookie('refreshToken', result.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000 // 7 días
    });

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  res.clearCookie('refreshToken');
  logger.info('Usuario deslogueado');
  res.json({ success: true, message: 'Sesión cerrada' });
});

// POST /api/auth/refresh
router.post('/refresh', (req, res, next) => {
  try {
    const refreshToken = req.cookies.refreshToken;

    if (!refreshToken) {
      return res.status(401).json({ error: 'Refresh token requerido' });
    }

    const result = authService.refreshAccessToken(refreshToken);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

// POST /api/auth/change-password
router.post('/change-password', verifyToken, async (req, res, next) => {
  try {
    const { error, value } = passwordSchema.validate(req.body);
    if (error) {
      error.isJoi = true;
      throw error;
    }

    await authService.updatePassword(req.user.id, value.oldPassword, value.newPassword);

    logger.info('Contraseña actualizada', { userId: req.user.id });
    res.json({ success: true, message: 'Contraseña actualizada exitosamente' });
  } catch (error) {
    next(error);
  }
});

// POST /api/auth/create-user (solo admin)
router.post('/create-user', verifyToken, async (req, res, next) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Acceso denegado' });
    }

    const schema = Joi.object({
      email: Joi.string().email().required(),
      password: Joi.string().min(6).required(),
      name: Joi.string().required(),
      role: Joi.string().valid('admin', 'viewer').default('admin')
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      error.isJoi = true;
      throw error;
    }

    const user = await authService.createUser(value.email, value.password, value.name, value.role);

    logger.info('Nuevo usuario creado por admin', { createdBy: req.user.id, newUser: user.id });
    res.status(201).json({ success: true, data: user });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
