// qonto/db_query/pool.js
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') }); // подхват .env на локали

const mysql = require('mysql2/promise');

// читаем переменные окружения (локаль/прод одинаковый интерфейс)
const cfg = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: (process.env.DB_PASS || '').trim(),
  database: process.env.DB_NAME || 'myshopdb',
  connectTimeout: 60000,

  // TLS для Railway; локально без TLS.
  // Если DB_HOST не localhost — считаем, что это production и включаем TLS.
  ...(process.env.DB_HOST && process.env.DB_HOST !== 'localhost' ? {
    ssl: {
      minVersion: 'TLSv1.2',
      servername: process.env.DB_HOST,
      rejectUnauthorized: false,   // у Railway self-signed прокси
    },
    enableKeepAlive: true,
    keepAliveInitialDelay: 1000,
  } : {})
};

let connPromise = null;

// единый ленивый коннект
async function getConn() {
  if (!connPromise) connPromise = mysql.createConnection(cfg);
  return connPromise;
}

// универсальный helper: query(sql, params)
async function query(sql, params = []) {
  const conn = await getConn();
  const [rows] = await conn.query(sql, params);
  return rows;
}

// health-пинг
async function ping() {
  const rows = await query('SELECT 1 AS ok');
  return !!(rows && rows[0] && rows[0].ok);
}

module.exports = { query, ping };
