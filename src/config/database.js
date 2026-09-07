const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');

// Crear carpeta de datos si no existe
const dataDir = path.join(__dirname, '../../data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'meridian.db');

// Conexión a la BD
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    logger.error('Error conectando a BD SQLite:', err);
    process.exit(1);
  }
  logger.info(`Base de datos conectada: ${dbPath}`);
});

// Habilitar foreign keys
db.run('PRAGMA foreign_keys = ON');

// Funciones auxiliares
const dbAll = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        logger.error('Error en dbAll:', err, 'SQL:', sql);
        reject(err);
      } else {
        resolve(rows || []);
      }
    });
  });
};

const dbGet = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        logger.error('Error en dbGet:', err, 'SQL:', sql);
        reject(err);
      } else {
        resolve(row || null);
      }
    });
  });
};

const dbRun = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) {
        logger.error('Error en dbRun:', err, 'SQL:', sql);
        reject(err);
      } else {
        resolve({ id: this.lastID, changes: this.changes });
      }
    });
  });
};

const dbExec = (sql) => {
  return new Promise((resolve, reject) => {
    db.exec(sql, (err) => {
      if (err) {
        logger.error('Error en dbExec:', err);
        reject(err);
      } else {
        resolve();
      }
    });
  });
};

module.exports = {
  db,
  dbAll,
  dbGet,
  dbRun,
  dbExec,
  close: () => {
    return new Promise((resolve, reject) => {
      db.close((err) => {
        if (err) {
          logger.error('Error cerrando BD:', err);
          reject(err);
        } else {
          logger.info('Base de datos cerrada');
          resolve();
        }
      });
    });
  }
};
