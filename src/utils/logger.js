const fs = require('fs');
const path = require('path');

// Crear directorio de logs si no existe
const logsDir = path.join(__dirname, '../../logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const logFile = path.join(logsDir, 'app.log');
const errorFile = path.join(logsDir, 'error.log');

const levels = {
  error: 'ERROR',
  warn: 'WARN',
  info: 'INFO',
  debug: 'DEBUG'
};

const colors = {
  error: '\x1b[31m',     // Red
  warn: '\x1b[33m',      // Yellow
  info: '\x1b[36m',      // Cyan
  debug: '\x1b[35m',     // Magenta
  reset: '\x1b[0m'
};

const getTimestamp = () => {
  return new Date().toISOString();
};

const formatMessage = (level, message, data = null) => {
  const timestamp = getTimestamp();
  const levelStr = levels[level];
  let msg = `[${timestamp}] [${levelStr}] ${message}`;
  if (data) {
    msg += ` | ${JSON.stringify(data)}`;
  }
  return msg;
};

const logger = {
  error: (message, data = null) => {
    const formatted = formatMessage('error', message, data);
    console.log(`${colors.error}${formatted}${colors.reset}`);
    fs.appendFileSync(errorFile, formatted + '\n');
    fs.appendFileSync(logFile, formatted + '\n');
  },

  warn: (message, data = null) => {
    const formatted = formatMessage('warn', message, data);
    console.log(`${colors.warn}${formatted}${colors.reset}`);
    fs.appendFileSync(logFile, formatted + '\n');
  },

  info: (message, data = null) => {
    const formatted = formatMessage('info', message, data);
    console.log(`${colors.info}${formatted}${colors.reset}`);
    fs.appendFileSync(logFile, formatted + '\n');
  },

  debug: (message, data = null) => {
    if (process.env.LOG_LEVEL === 'debug') {
      const formatted = formatMessage('debug', message, data);
      console.log(`${colors.debug}${formatted}${colors.reset}`);
      fs.appendFileSync(logFile, formatted + '\n');
    }
  }
};

module.exports = logger;
