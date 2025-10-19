// qonto/db_query/pool.js  (ESM-версия)
import mysql from "mysql2/promise";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

// ── .env локально (в проде переменные придут из окружения Railway) ─────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../.env") }); // локальная разработка

// ── Сбор конфигурации из переменных окружения ──────────────────────────────────
// Поддерживаем оба имени пароля: DB_PASSWORD и DB_PASS (как у тебя было)
const env = {
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "root",
  password: (process.env.DB_PASSWORD ?? process.env.DB_PASS ?? "").trim(),
  database: process.env.DB_NAME || "qonto",
};

// Альтернатива: если задана DATABASE_URL (mysql://user:pass@host:port/db)
// разберём её в поля конфига.
if (process.env.DATABASE_URL) {
  const u = new URL(process.env.DATABASE_URL);
  env.host = u.hostname || env.host;
  env.port = Number(u.port || env.port);
  env.user = decodeURIComponent(u.username || env.user);
  env.password = decodeURIComponent(u.password || env.password);
  env.database = decodeURIComponent(u.pathname.replace(/^\//, "")) || env.database;
}

// TLS/keep-alive: включаем для не-локального хоста (например, Railway)
const needTLS = env.host !== "localhost" && env.host !== "127.0.0.1";
const baseCfg = {
  host: env.host,
  port: env.port,
  user: env.user,
  password: env.password,
  database: env.database,
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_POOL || 10),
  queueLimit: 0,
  connectTimeout: 60_000,
  enableKeepAlive: true,
  keepAliveInitialDelay: 1_000,
  timezone: "Z",
  ...(needTLS
    ? {
        ssl: {
          minVersion: "TLSv1.2",
          servername: env.host,
          // на многих PaaS используется прокси/TLS без цепочки — не валим коннект
          rejectUnauthorized: false,
        },
      }
    : {}),
};

// ── Пул соединений ─────────────────────────────────────────────────────────────
export const pool = mysql.createPool(baseCfg);

// Удобный helper: SELECT/INSERT/UPDATE
export async function query(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows;
}

// Health-пинг для /health и логов старта
export async function ping() {
  const [row] = await pool.query("SELECT 1 AS ok");
  return !!row && (row.ok === 1 || row.ok === "1");
}

// Корректное завершение при остановке процесса
const shutdown = async () => {
  try {
    await pool.end();
    // eslint-disable-next-line no-process-exit
    process.exit(0);
  } catch {
    process.exit(1);
  }
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
