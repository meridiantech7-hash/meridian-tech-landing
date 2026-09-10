const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { dbGet, dbRun, dbAll } = require('../config/database');
const logger = require('../utils/logger');

const generateTokens = (user) => {
  // client_id viaja en el token para no tener que ir a la base en cada
  // petición. Va como null explícito cuando el usuario es de MeridianTech:
  // así el middleware distingue "no tiene empresa asignada, ve todo" de
  // "el token es viejo y no trae el campo".
  const accessToken = jwt.sign(
    {
      id: user.id,
      email: user.email,
      role: user.role,
      client_id: user.client_id === undefined ? null : user.client_id
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
  );

  const refreshToken = jwt.sign(
    { id: user.id },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d' }
  );

  return { accessToken, refreshToken };
};

const hashPassword = async (password) => {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(password, salt);
};

const verifyPassword = async (password, hashedPassword) => {
  return bcrypt.compare(password, hashedPassword);
};

const login = async (email, password) => {
  logger.info('Intento de login', { email });

  const user = await dbGet('SELECT * FROM users WHERE email = ?', [email]);

  if (!user) {
    logger.warn('Login fallido - usuario no encontrado', { email });
    throw { statusCode: 401, message: 'Credenciales inválidas' };
  }

  const isPasswordValid = await verifyPassword(password, user.password);

  if (!isPasswordValid) {
    logger.warn('Login fallido - contraseña incorrecta', { email });
    throw { statusCode: 401, message: 'Credenciales inválidas' };
  }

  if (user.status !== 'active') {
    logger.warn('Login fallido - usuario inactivo', { email });
    throw { statusCode: 403, message: 'Usuario inactivo' };
  }

  // Actualizar último login
  await dbRun('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?', [user.id]);

  const { accessToken, refreshToken } = generateTokens(user);

  logger.info('Login exitoso', { userId: user.id, email });

  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role
    },
    accessToken,
    refreshToken
  };
};

const createUser = async (email, password, name, role = 'admin') => {
  logger.info('Creando nuevo usuario', { email, name, role });

  // Verificar si el usuario ya existe
  const existingUser = await dbGet('SELECT id FROM users WHERE email = ?', [email]);
  if (existingUser) {
    logger.warn('Intento de crear usuario duplicado', { email });
    throw { statusCode: 409, message: 'El email ya está registrado' };
  }

  const hashedPassword = await hashPassword(password);

  const result = await dbRun(
    'INSERT INTO users (email, password, name, role) VALUES (?, ?, ?, ?)',
    [email, hashedPassword, name, role]
  );

  logger.info('Usuario creado exitosamente', { userId: result.id, email });

  return {
    id: result.id,
    email,
    name,
    role
  };
};

const updatePassword = async (userId, oldPassword, newPassword) => {
  logger.info('Cambio de contraseña iniciado', { userId });

  const user = await dbGet('SELECT * FROM users WHERE id = ?', [userId]);

  if (!user) {
    throw { statusCode: 404, message: 'Usuario no encontrado' };
  }

  const isPasswordValid = await verifyPassword(oldPassword, user.password);

  if (!isPasswordValid) {
    logger.warn('Cambio de contraseña fallido - contraseña antigua incorrecta', { userId });
    throw { statusCode: 401, message: 'Contraseña actual incorrecta' };
  }

  const hashedPassword = await hashPassword(newPassword);

  await dbRun('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, userId]);

  logger.info('Contraseña actualizada exitosamente', { userId });
};

const refreshAccessToken = async (refreshToken) => {
  try {
    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);

    const user = await dbGet('SELECT * FROM users WHERE id = ?', [decoded.id]);

    if (!user || user.status !== 'active') {
      throw new Error('Usuario no válido');
    }

    const { accessToken } = generateTokens(user);

    return { accessToken };
  } catch (error) {
    logger.warn('Error al refrescar token', { error: error.message });
    throw { statusCode: 401, message: 'Refresh token inválido' };
  }
};

module.exports = {
  login,
  createUser,
  updatePassword,
  refreshAccessToken,
  generateTokens,
  hashPassword,
  verifyPassword
};
