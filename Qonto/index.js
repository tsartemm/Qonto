import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import fs from 'fs';
import express from 'express';
import cors from 'cors';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import cookieParser from 'cookie-parser';
import mysql from 'mysql2/promise';
import axios from 'axios';
import nodemailer from 'nodemailer';
import { OAuth2Client } from 'google-auth-library';
import multer from 'multer';
import http from 'http';
import { Server } from 'socket.io';
import crypto from 'crypto';

/* Optional SMS via Twilio (only if configured) */
let twilioClient = null;
const SMS_PROVIDER = process.env?.SMS_PROVIDER || '';
try {
  if (SMS_PROVIDER === 'twilio') {
    const { default: twilio } = await import('twilio');
    if (process.env.TWILIO_SID && process.env.TWILIO_AUTH_TOKEN) {
      twilioClient = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH_TOKEN);
    }
  }
} catch (_) { /* optional dependency */ }

// === .env from server/.env
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '.env') });

// === SQL loader (generated) ===
import { readFileSync } from 'fs';
import { resolve as _resolve } from 'path';

function _parseQueries(filePath) {
  let src = '';
  try { src = readFileSync(filePath, 'utf8'); } catch (_) { /* optional */ }
  const map = {};
  let current = null, buf = [];
  const lines = src.split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\s*--\s*name:\s*(\w+)/i);
    if (m) {
      if (current && buf.length) map[current] = buf.join('\n').trim();
      current = m[1];
      buf = [];
    } else {
      buf.push(line);
    }
  }
  if (current && buf.length) map[current] = buf.join('\n').trim();
  return map;
}

const SQL = Object.freeze({
  ..._parseQueries(_resolve(__dirname, 'sql/queries.sql')),
  ..._parseQueries(_resolve(__dirname, 'sql/schema.sql')),
});
// === /SQL loader ===

// === CORS
const allowedOrigins = (process.env.CLIENT_ORIGIN || 'http://localhost:3000').split(',');

// === Express app
const app = express();

// Static uploads
const uploadsRoot = path.resolve(__dirname, 'uploads');
fs.mkdirSync(uploadsRoot, { recursive: true });
app.use('/uploads', express.static(uploadsRoot));

// Base middlewares
app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json());
app.use(cookieParser());

/* ===== Avatars upload ===== */
const avatarDir = path.join(uploadsRoot, 'avatars');
try { fs.mkdirSync(avatarDir, { recursive: true }); } catch {}
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, avatarDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '.jpg');
    const uid = (req.user && req.user.id) ? req.user.id : 'anon';
    cb(null, `${uid}_${Date.now()}${ext}`);
  }
});
const upload = multer({ storage });

/* ===== Chat attachments upload ===== */
const chatUploadsDir = path.join(uploadsRoot, 'chat');
fs.mkdirSync(chatUploadsDir, { recursive: true });
const chatStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, chatUploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '');
    const safeName = `${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`;
    cb(null, safeName);
  }
});
function isAllowedAttachment(file) {
  const ok = [
    'image/png','image/jpeg','image/webp','image/gif',
    'application/pdf','image/heic','image/heif'
  ];
  return ok.includes(file.mimetype);
}
const uploadChat = multer({
  storage: chatStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => cb(null, isAllowedAttachment(file))
});

/* ===== HTTP + Socket.IO ===== */
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: allowedOrigins, credentials: true } });

// Presence map
const onlineUsers = new Map(); // userId -> Set<socketId>
function _attach(userId, socketId) {
  if (!userId) return;
  if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set());
  onlineUsers.get(userId).add(socketId);
}
function _detach(userId, socketId) {
  const set = onlineUsers.get(userId);
  if (!set) return;
  set.delete(socketId);
  if (set.size === 0) onlineUsers.delete(userId);
}
function isOnline(userId) { return onlineUsers.has(Number(userId)); }
function emitToUser(userId, event, payload) { io.to(`user:${userId}`).emit(event, payload); }

app.locals.isOnline = isOnline;
app.locals.emitToUser = emitToUser;

io.on('connection', (socket) => {
  let userId = null;

  socket.on('auth', (uid) => {
    userId = Number(uid);
    if (!userId) return;
    socket.join(`user:${userId}`);
    _attach(userId, socket.id);
    io.emit('presence:update', { userId, online: true });
  });

  socket.on('thread:join', (threadId) => {
    if (!threadId) return;
    socket.join(`thread:${Number(threadId)}`);
  });

  socket.on('thread:typing', ({ threadId, from }) => {
    socket.to(`thread:${Number(threadId)}`).emit('thread:typing', { threadId: Number(threadId), from });
  });

  socket.on('disconnect', () => {
    if (userId) {
      _detach(userId, socket.id);
      if (!isOnline(userId)) {
        io.emit('presence:update', { userId, online: false });
      }
    }
  });
});

/* ===== MySQL ===== */
const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  timezone: '+00:00',
});

(async () => {
  try {
    const [r] = await db.query(SQL.select_general);
    console.log('Connected DB =', r[0].db);
  } catch (e) {
    console.error('DB ping failed:', e.message || e);
  }
})();

const DB_NAME = process.env.DB_NAME;

async function ensureUsersExtraSchema() {
  try {
    const [c1] = await db.query(
      SQL.select_information_schema,
      [DB_NAME]
    );
    if (!c1[0].cnt) {
      await db.query(SQL.alter_general);
      console.log('✅ users.contact_email added');
    }
    const [c2] = await db.query(
      SQL.select_information_schema_02,
      [DB_NAME]
    );
    if (!c2[0].cnt) {
      await db.query(SQL.alter_general_02);
      console.log('✅ users.avatar_url added');
    }
  } catch (e) {
    console.error('ensureUsersExtraSchema error:', e?.message || e);
  }
}

const JWT_SECRET = process.env.JWT_SECRET || 'dev_jwt_secret';

/* ====== OpenRouter (AI) ====== */
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'mistralai/mistral-7b-instruct:free';
const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
const OPENROUTER_SITE_URL = (process.env.CLIENT_ORIGIN || 'http://localhost:3000').split(',')[0];
const OPENROUTER_TITLE = process.env.OPENROUTER_APP_TITLE || 'MyShop Assistant';
if (!OPENROUTER_API_KEY) {
  console.warn('⚠️ OPENROUTER_API_KEY не найден. /api/chat вернёт 503, пока не настроите ключ.');
}

/* ===== Helpers ===== */
const random6 = () => Math.floor(100000 + Math.random() * 900000).toString();
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const normalizePhone = (raw) => {
  if (!raw) return '';
  let p = String(raw).replace(/[^\d+]/g, '');
  if (!p.startsWith('+') && /^\d+$/.test(p)) p = '+' + p;
  return p;
};

async function getUserById(id) {
  const [rows] = await db.query(
    SQL.select_users,
    [id]
  );
  return rows[0] || null;
}
async function findUserByEmail(email) {
  const [rows] = await db.query(SQL.select_users_02, [email]);
  return rows[0] || null;
}
async function findUserByPhone(phone) {
  const [rows] = await db.query(SQL.select_users_03, [phone]);
  return rows[0] || null;
}
async function ensureUniqueUsername(base) {
  let u = (base || 'user').toString().replace(/[^a-z0-9._-]/gi, '').toLowerCase();
  if (!u) u = 'user';
  let candidate = u, i = 0;
  while (true) {
    const [r] = await db.query(SQL.select_users_04, [candidate]);
    if (!r.length) return candidate;
    i += 1;
    candidate = `${u}${i}`;
    if (i > 50) candidate = `${u}-${Date.now().toString().slice(-6)}`;
  }
}
async function createUserByEmail({ email, first_name, last_name }) {
  const base = (email || '').split('@')[0] || 'user';
  const username = await ensureUniqueUsername(base);
  const password_hash = '';
  const phone = '';
  const [res] = await db.query(
    SQL.insert_general,
    [first_name || '', last_name || '', username, password_hash, phone, email]
  );
  return { id: res.insertId, email, first_name, last_name, username };
}

async function sendOtpEmail(to, code) {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
  });
  const from = process.env.SMTP_FROM || 'no-reply@example.com';
  const info = await transporter.sendMail({
    from, to,
    subject: 'Ваш код подтверждения',
    text: `Ваш шестизначный код: ${code}. Он действителен 10 минут.`,
    html: `<p>Ваш шестизначный код: <b>${code}</b></p><p>Срок действия: 10 минут.</p>`
  });
  console.log('✉️ Отправлено письмо:', info.messageId);
}
async function sendOtpSms(to, code) {
  if (SMS_PROVIDER !== 'twilio') throw new Error('SMS_PROVIDER не настроен (twilio)');
  if (!twilioClient) throw new Error('Twilio клиент не инициализирован');
  const from = process.env.TWILIO_FROM;
  if (!from) throw new Error('TWILIO_FROM не задан в .env');
  const resp = await twilioClient.messages.create({ from, to, body: `Ваш код: ${code} (действителен 10 минут)` });
  console.log('📲 SMS отправлено:', resp.sid);
}
async function verifyGoogleIdToken(idToken) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) throw new Error('GOOGLE_CLIENT_ID не задан в .env');
  const client = new OAuth2Client(clientId);
  const ticket = await client.verifyIdToken({ idToken, audience: clientId });
  return ticket.getPayload();
}

/* ===== Auth middlewares ===== */
function extractToken(req) {
  const auth = req.headers.authorization || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  return bearer || req.cookies.token || null;
}
app.use(async (req, res, next) => {
  const token = extractToken(req);
  if (!token) { req.user = null; return next(); }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = await getUserById(payload.id);
  } catch {
    req.user = null;
  }
  next();
});
function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ message: 'Unauthorized' });
  next();
}
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ message: 'Forbidden' });
  next();
}
function requireApprovedSeller(req, res, next) {
  if (!req.user || req.user.seller_status !== 'approved') {
    return res.status(403).json({ message: 'Seller not approved' });
  }
  next();
}

/* ===== Ensure schemas ===== */
async function ensureCategoriesSchema() {
  try {
    await db.query(
      SQL.create_general
    );
  } catch (err) {
    console.error('ensureCategoriesSchema error:', err);
  }
}
async function ensureProductsSchema() {
  try {
    const [c1] = await db.query(
      SQL.select_information_schema_03,
      [DB_NAME]
    );
    if (!c1[0].cnt) {
      await db.query(SQL.alter_general_03);
      console.log('✅ products.category добавлен');
    }
    const [cStat] = await db.query(
      SQL.select_information_schema_04,
      [DB_NAME]
    );
    if (!cStat[0].cnt) {
      await db.query(SQL.alter_general_04);
      console.log('✅ products.status добавлен');
    }
    const [c2] = await db.query(
      SQL.select_information_schema_05,
      [DB_NAME]
    );
    if (!c2[0].cnt) {
      await db.query(SQL.alter_general_05);
      console.log('✅ products.created_at добавлен');
    }
    const [cPrev] = await db.query(
      SQL.select_information_schema_06,
      [DB_NAME]
    );
    if (!cPrev[0].cnt) {
      await db.query(SQL.alter_general_06);
      console.log('✅ products.preview_image_url добавлен');
    }
    const [i1] = await db.query(
      SQL.select_information_schema_07,
      [DB_NAME]
    );
    if (!i1[0].cnt) {
      await db.query(`CREATE INDEX idx_products_category ON products(category)`);
      console.log('✅ индекс idx_products_category создан');
    }
    const [i2] = await db.query(
      SQL.select_information_schema_08,
      [DB_NAME]
    );
    if (!i2[0].cnt) {
      await db.query(`CREATE INDEX idx_products_created_at ON products(created_at)`);
      console.log('✅ индекс idx_products_created_at создан');
    }
  } catch (e) {
    console.error('ensureProductsSchema error:', e.message || e);
  }
}

(async () => {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS email_otps (
        id INT AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        code_hash VARCHAR(255) NOT NULL,
        expires_at DATETIME NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_email (email)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS phone_otps (
        id INT AUTO_INCREMENT PRIMARY KEY,
        phone VARCHAR(64) NOT NULL,
        code_hash VARCHAR(255) NOT NULL,
        expires_at DATETIME NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_phone (phone)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    console.log('✅ email_otps / phone_otps tables ensured');
    await ensureUsersExtraSchema();
    await ensureCategoriesSchema();
    await ensureProductsSchema();
  } catch (e) {
    console.error('Не удалось инициализировать таблицы:', e?.message || e);
  }
})();

/* ===== Username/password auth (basic) ===== */
app.post('/api/register', async (req, res) => {
  try {
    const { firstName, lastName, username, password, phone, email } = req.body;
    if (!firstName || !lastName || !username || !password || !phone || !email) {
      return res.status(400).json({ error: 'Все поля обязательны.' });
    }
    const [exists] = await db.query(SQL.select_users_05, [username, email]);
    if (exists.length) return res.status(400).json({ error: 'Пользователь с таким логином или email уже существует.' });

    const password_hash = await bcrypt.hash(password, 10);
    const [result] = await db.query(
      SQL.insert_general_02,
      [firstName, lastName, username, password_hash, phone, email]
    );

    const user = await getUserById(result.insertId);
    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
    res.cookie('token', token, { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 });
    res.json({ success: true, user });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера.', detail: err.message });
  }
});
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Логин и пароль обязательны.' });
  try {
    const [rows] = await db.query(SQL.select_users_06, [username]);
    if (!rows.length) return res.status(400).json({ error: 'Неверные учетные данные.' });

    const userRow = rows[0];
    const match = await bcrypt.compare(password, userRow.password_hash);
    if (!match) return res.status(400).json({ error: 'Неверные учетные данные.' });

    const token = jwt.sign({ id: userRow.id }, JWT_SECRET, { expiresIn: '7d' });
    res.cookie('token', token, { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 });

    const user = await getUserById(userRow.id);
    res.json({ success: true, user });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера.' });
  }
});

/* ===== Auth: email/password simple ===== */
app.post('/api/register-email', async (req, res) => {
  try {
    let { firstName, lastName, password, phone, email } = req.body;
    if (!firstName || !lastName || !password || !phone || !email) {
      return res.status(400).json({ error: 'Заполните все обязательные поля.' });
    }
    phone = normalizePhone(phone);

    const [emailExists] = await db.query(SQL.select_users_07, [email]);
    if (emailExists.length) return res.status(400).json({ error: 'Пользователь с таким email уже существует.' });

    const [phoneExists] = await db.query(SQL.select_users_08, [phone]);
    if (phoneExists.length) return res.status(400).json({ error: 'Этот номер телефона уже используется.' });

    const base = (email || '').split('@')[0] || 'user';
    const username = await ensureUniqueUsername(base);
    const password_hash = await bcrypt.hash(password, 10);

    const [result] = await db.query(
      SQL.insert_general_02,
      [firstName, lastName, username, password_hash, phone, email]
    );

    const user = await getUserById(result.insertId);
    res.json({ ok: true, id: result.insertId, user });
  } catch (e) {
    console.error('register-email error:', e);
    res.status(500).json({ error: e?.message || 'Ошибка регистрации.' });
  }
});
app.post('/api/login-email', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Укажите email и пароль.' });

    const [rows] = await db.query(SQL.select_users_02, [email]);
    const userRow = rows?.[0];
    if (!userRow) return res.status(400).json({ error: 'Неверный email или пароль.' });

    const match = await bcrypt.compare(password, userRow.password_hash || '');
    if (!match) return res.status(400).json({ error: 'Неверный email или пароль.' });

    const token = jwt.sign({ id: userRow.id }, JWT_SECRET, { expiresIn: '7d' });
    res.cookie('token', token, { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 });

    const user = await getUserById(userRow.id);
    res.json({ ok: true, user });
  } catch (e) {
    console.error('login-email error:', e);
    res.status(500).json({ error: 'Ошибка входа.' });
  }
});

/* ===== Email registration with OTP (3 steps) ===== */
const jwtRegSecret = process.env.JWT_REG_SECRET || (JWT_SECRET + '_reg');
app.post('/api/register-email/start', async (req, res) => {
  try {
    let { firstName, lastName, email, phone } = req.body || {};
    firstName = (firstName||'').trim();
    lastName  = (lastName||'').trim();
    email     = (email||'').trim();
    phone     = normalizePhone(phone||'');

    if (!firstName || !email) return res.status(400).json({ error: 'Заповніть всі поля!!!' });

    const [[e1]] = await db.query(SQL.select_users_09,[email]);
    if (e1) return res.status(400).json({ error: 'Користувач з таким email вже існує.' });
    if (phone) {
      const [[p1]] = await db.query(SQL.select_users_10,[phone]);
      if (p1) return res.status(400).json({ error: 'Цей номер теелфону вже використовується' });
    }

    const code = random6();
    const hash = sha256(code);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    console.log('[OTP start]', email, code, sha256(code));

    await db.query(
      SQL.insert_general_03,
      [email, hash, expiresAt]
    );

    await sendOtpEmail(email, code);

    const reg_token = jwt.sign(
      { email, firstName, lastName, phone, stage: 'otp' },
      jwtRegSecret,
      { expiresIn: '15m' }
    );

    res.json({ ok: true, email, reg_token });
  } catch (e) {
    console.error('register-email/start', e);
    res.status(500).json({ error: 'Помилка старту реєстрації' });
  }
});
app.post('/api/register-email/verify', async (req, res) => {
  try {
    let { email, code } = req.body || {};
    email = (email||'').trim();
    code = (code||'').trim();

    console.log('[OTP verify] incoming', email, code, 'calc=', sha256(code));

    if (!email || !/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Некоректний код' });

    const [[row]] = await db.query(SQL.select_email_otps, [email]);
    console.log('[OTP verify] row', row?.email, row?.code_hash);
    if (!row) return res.status(400).json({ error: 'Код не запрошений або прострочений' });
    if (new Date(row.expires_at).getTime() < Date.now()) return res.status(400).json({ error: 'Код прострочений' });
    if (sha256(code) !== row.code_hash) return res.status(400).json({ error: 'Невірний код' });

    await db.query(SQL.delete_email_otps, [email]);

    const reg_token = jwt.sign({ email, stage: 'finish-allowed' }, jwtRegSecret, { expiresIn: '15m' });
    res.json({ ok: true, reg_token });
  } catch (e) {
    console.error('register-email/verify', e);
    res.status(500).json({ error: 'Помилка підтвердження коду' });
  }
});
app.post('/api/register-email/finish', async (req, res) => {
  try {
    const { reg_token, password } = req.body || {};
    if (!reg_token || !password) return res.status(400).json({ error: 'Не вистачає даних' });

    let payload;
    try { payload = jwt.verify(reg_token, jwtRegSecret); }
    catch { return res.status(400).json({ error: 'Недійсний або прострочений токен' }); }

    if (payload.stage !== 'finish-allowed' && payload.stage !== 'otp') {
      return res.status(400).json({ error: 'Невірний етап реєстрації' });
    }

    const email = payload.email;
    const [[exists]] = await db.query(SQL.select_users_09, [email]);
    if (exists) return res.status(400).json({ error: 'Email вже використовується' });

    const first_name = payload.firstName || '';
    const last_name  = payload.lastName  || '';
    const phone      = payload.phone     || '';

    const usernameBase = (email || '').split('@')[0] || 'user';
    const username = await ensureUniqueUsername(usernameBase);
    const password_hash = await bcrypt.hash(password, 10);

    const [ins] = await db.query(
      SQL.insert_general_02,
      [first_name, last_name, username, password_hash, phone, email]
    );

    const token = jwt.sign({ id: ins.insertId }, JWT_SECRET, { expiresIn: '7d' });
    res.cookie('token', token, { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 });
    res.json({ ok: true, user: await getUserById(ins.insertId) });
  } catch (e) {
    console.error('register-email/finish', e);
    res.status(500).json({ error: 'Не вдалося завершити реєстрацію' });
  }
});

/* ===== Google OAuth + Email OTP ===== */
app.post('/api/auth/google/start', async (req, res) => {
  try {
    const { id_token } = req.body;
    if (!id_token) return res.status(400).json({ error: 'id_token is required' });
    const payload = await verifyGoogleIdToken(id_token);
    const email = payload.email;
    if (!email) return res.status(400).json({ error: 'Email не найден в токене' });

    const code = random6();
    const hash = sha256(code);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await db.query(
      SQL.insert_general_04,
      [email, hash, expiresAt]
    );

    await sendOtpEmail(email, code);
    res.json({ ok: true, email });
  } catch (e) {
    console.error('google/start error:', e);
    res.status(500).json({ error: 'Ошибка при старте Google входа' });
  }
});
app.post('/api/auth/google/verify', async (req, res) => {
  try {
    const { id_token, code } = req.body;
    if (!id_token || !code) return res.status(400).json({ error: 'id_token и code обязательны' });

    const payload = await verifyGoogleIdToken(id_token);
    const email = payload.email;
    if (!email) return res.status(400).json({ error: 'Email не найден в токене' });

    const [rows] = await db.query(SQL.select_email_otps_02, [email]);
    const row = rows?.[0];
    if (!row) return res.status(400).json({ error: 'Код не запрошен или истёк' });
    if (new Date(row.expires_at).getTime() < Date.now()) return res.status(400).json({ error: 'Код истёк, запросите новый' });
    if (sha256(code) !== row.code_hash) return res.status(400).json({ error: 'Неверный код' });

    await db.query(SQL.delete_email_otps_02, [email]);

    let user = await findUserByEmail(email);
    if (!user) {
      user = await createUserByEmail({
        email,
        first_name: payload.given_name || '',
        last_name: payload.family_name || ''
      });
    }

    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
    res.cookie('token', token, { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 });

    const fullUser = await getUserById(user.id);
    res.json({ ok: true, user: fullUser });
  } catch (e) {
    console.error('google/verify error:', e);
    res.status(500).json({ error: 'Ошибка при подтверждении кода' });
  }
});

/* ===== Phone linking + Phone OTP login ===== */
app.post('/api/me/update-phone', requireAuth, async (req, res) => {
  try {
    let { phone, password } = req.body || {};
    if (!phone) return res.status(400).json({ error: 'Укажите номер телефона' });

    phone = normalizePhone(phone);

    const [exists] = await db.query(SQL.select_users_11, [phone, req.user.id]);
    if (exists.length) return res.status(400).json({ error: 'Этот номер уже привязан к другому аккаунту' });

    if (password && password.length < 6) {
      return res.status(400).json({ error: 'Пароль должен быть не короче 6 символов' });
    }

    if (password) {
      const password_hash = await bcrypt.hash(password, 10);
      await db.query(SQL.update_general, [phone, password_hash, req.user.id]);
    } else {
      await db.query(SQL.update_general_02, [phone, req.user.id]);
    }

    res.json({ ok: true, phone });
  } catch (e) {
    console.error('update-phone error:', e);
    res.status(500).json({ error: 'Не удалось сохранить номер' });
  }
});
app.post('/api/auth/phone/start', async (req, res) => {
  try {
    let { phone } = req.body || {};
    phone = normalizePhone(phone);
    if (!phone) return res.status(400).json({ error: 'Укажите номер телефона' });

    const user = await findUserByPhone(phone);
    if (!user) return res.status(404).json({ error: 'Этот номер не привязан ни к одному аккаунту' });

    const [last] = await db.query(SQL.select_phone_otps, [phone]);
    if (last.length) {
      const lastTs = new Date(last[0].created_at).getTime();
      if (Date.now() - lastTs < 30 * 1000) {
        return res.status(429).json({ error: 'Слишком часто. Попробуйте через 30 секунд' });
      }
    }

    const code = random6();
    const hash = sha256(code);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await db.query(
      SQL.insert_general_05,
      [phone, hash, expiresAt]
    );

    await sendOtpSms(phone, code);
    res.json({ ok: true, phone });
  } catch (e) {
    console.error('phone/start error:', e);
    res.status(500).json({ error: e?.message || 'Не удалось отправить SMS' });
  }
});
app.post('/api/auth/phone/verify', async (req, res) => {
  try {
    let { phone, code } = req.body || {};
    phone = normalizePhone(phone);
    if (!phone || !code) return res.status(400).json({ error: 'Укажите телефон и код' });

    const [rows] = await db.query(SQL.select_phone_otps_02, [phone]);
    const row = rows?.[0];
    if (!row) return res.status(400).json({ error: 'Код не запрошен или истёк' });
    if (new Date(row.expires_at).getTime() < Date.now()) return res.status(400).json({ error: 'Код истёк, запросите новый' });
    if (sha256(code) !== row.code_hash) return res.status(400).json({ error: 'Неверный код' });

    await db.query(SQL.delete_phone_otps, [phone]);

    const user = await findUserByPhone(phone);
    if (!user) return res.status(404).json({ error: 'Аккаунт не найден' });

    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
    res.cookie('token', token, { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 });

    const fullUser = await getUserById(user.id);
    res.json({ ok: true, user: fullUser });
  } catch (e) {
    console.error('phone/verify error:', e);
    res.status(500).json({ error: 'Ошибка подтверждения кода' });
  }
});

/* ===== Profile & session ===== */
app.post('/api/me/update-profile', requireAuth, async (req, res) => {
  try {
    let { first_name, last_name, email, contact_email } = req.body || {};
    first_name = (first_name || '').trim();
    last_name = (last_name || '').trim();
    email = (email || '').trim();

    contact_email = (contact_email || '').trim();
    if (!first_name || !last_name || !email) {
      return res.status(400).json({ error: 'Имя, фамилия и email обязательны' });
    }
    const [exists] = await db.query(SQL.select_users_12, [email, req.user.id]);
    if (exists.length) return res.status(400).json({ error: 'Этот email уже используется' });

    await db.query(SQL.update_general_03, [ first_name, last_name, email, contact_email || null, req.user.id ]);

    const user = await getUserById(req.user.id);
    res.json({ ok: true, user });
  } catch (e) {
    console.error('update-profile error:', e);
    res.status(500).json({ error: 'Не удалось сохранить профиль' });
  }
});
app.get('/api/me', (req, res) => { res.json({ user: req.user || null }); });
app.post('/api/logout', (req, res) => { res.clearCookie('token'); res.json({ success: true }); });
app.post('/api/heartbeat', requireAuth, async (req, res) => {
  try { await db.query(SQL.update_general_04, [req.user.id]); res.json({ ok: true }); }
  catch { res.status(500).json({ ok: false }); }
});

/* ===== Chats ===== */
function _emitTo(req, userId, event, payload) {
  try { const fn = req.app?.locals?.emitToUser; if (typeof fn === 'function') fn(userId, event, payload); } catch (_) {}
}
app.post('/api/chats/start', requireAuth, async (req, res) => {
  try {
    const seller_id = Number(req.body?.seller_id);
    const buyer_id  = Number(req.user.id);
    if (!seller_id || seller_id === buyer_id) {
      return res.status(400).json({ error: 'Некорректный продавец' });

// === Chat list for /chats page ===
app.get('/api/chats/my', requireAuth, async (req, res) => {
  try {
    const me = req.user.id;
    const [rows] = await db.query(
      `
      SELECT
        t.id, t.seller_id, t.buyer_id, t.updated_at,
        CASE WHEN t.seller_id = ? THEN t.buyer_id ELSE t.seller_id END AS other_id,
        TRIM(CONCAT(COALESCE(uo.first_name,''), ' ', COALESCE(uo.last_name,''))) AS other_name,
        uo.username      AS other_username,
        uo.avatar_url    AS other_avatar_url,
        (SELECT m.body FROM chat_messages m WHERE m.thread_id = t.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_text,
        (SELECT MAX(m.created_at) FROM chat_messages m WHERE m.thread_id = t.id) AS last_created_at,
        (SELECT COUNT(*) FROM chat_messages m WHERE m.thread_id = t.id AND m.sender_id <> ? AND m.read_at IS NULL) AS unread
      FROM chat_threads t
      JOIN users uo ON uo.id = CASE WHEN t.seller_id = ? THEN t.buyer_id ELSE t.seller_id END
      WHERE t.seller_id = ? OR t.buyer_id = ?
      ORDER BY COALESCE((SELECT MAX(m.created_at) FROM chat_messages m WHERE m.thread_id = t.id), t.updated_at) DESC, t.id DESC
      `,
      [me, me, me, me, me]
    );
    res.json({ items: rows || [] });
  } catch (e) {
    console.error('GET /api/chats/my error', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// === Remove a chat thread completely ===
app.delete('/api/chats/:id', requireAuth, async (req, res) => {
  try {
    const threadId = Number(req.params.id);
    const me = req.user.id;
    const [[t]] = await db.query(`SELECT id, seller_id, buyer_id FROM chat_threads WHERE id = ? LIMIT 1`, [threadId]);
    if (!t) return res.status(404).json({ error: 'Диалог не найден' });
    if (t.seller_id !== me && t.buyer_id !== me) return res.status(403).json({ error: 'Нет доступа' });
    const [r] = await db.query(`DELETE FROM chat_threads WHERE id = ?`, [threadId]);
    if (!r.affectedRows) return res.status(409).json({ error: 'Не удалось удалить' });
    res.json({ ok: true, id: threadId });
  } catch (e) {
    console.error('DELETE /api/chats/:id error', e);
    res.status(500).json({ error: 'Server error' });
  }
});
    }
    const [se] = await db.query(SQL.select_users_13, [seller_id]);
    if (!se.length) return res.status(404).json({ error: 'Продавец не найден' });

    const [ex] = await db.query(
      SQL.select_chat_threads,
      [seller_id, buyer_id]
    );
    if (ex.length) return res.json({ id: ex[0].id });

    await db.query(SQL.insert_general_06, [seller_id, buyer_id]);
    const [rows] = await db.query(SQL.select_chat_threads,[seller_id, buyer_id]);
    if (!rows.length) return res.status(500).json({ error: 'Не удалось создать чат' });
    return res.json({ id: rows[0].id });
  } catch (e) {
    console.error('POST /api/chats/start', e);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Список чатов текущего пользователя
app.get('/api/chats/my', requireAuth, async (req, res) => {
  try {
    const me = req.user.id;
    const [rows] = await db.query(
      `
      SELECT
        t.id, t.seller_id, t.buyer_id, t.updated_at,
        CASE WHEN t.seller_id = ? THEN t.buyer_id ELSE t.seller_id END AS other_id,
        TRIM(CONCAT(COALESCE(uo.first_name,''), ' ', COALESCE(uo.last_name,''))) AS other_name,
        uo.username AS other_username,
        uo.avatar_url AS other_avatar_url,
        (SELECT m.body FROM chat_messages m WHERE m.thread_id = t.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_text,
        (SELECT MAX(m.created_at) FROM chat_messages m WHERE m.thread_id = t.id) AS last_created_at,
        (SELECT COUNT(*) FROM chat_messages m WHERE m.thread_id = t.id AND m.sender_id <> ? AND m.read_at IS NULL) AS unread
      FROM chat_threads t
      JOIN users uo ON uo.id = CASE WHEN t.seller_id = ? THEN t.buyer_id ELSE t.seller_id END
      WHERE t.seller_id = ? OR t.buyer_id = ?
      ORDER BY COALESCE((SELECT MAX(m.created_at) FROM chat_messages m WHERE m.thread_id = t.id), t.updated_at) DESC, t.id DESC
      `,
      [me, me, me, me, me]
    );
    res.json({ items: rows || [] });
  } catch (e) {
    console.error('GET /api/chats/my error', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Удалить чат целиком
app.delete('/api/chats/:id', requireAuth, async (req, res) => {
  try {
    const threadId = Number(req.params.id);
    const me = req.user.id;
    const [[t]] = await db.query(`SELECT id, seller_id, buyer_id FROM chat_threads WHERE id = ? LIMIT 1`, [threadId]);
    if (!t) return res.status(404).json({ error: 'Диалог не найден' });
    if (t.seller_id !== me && t.buyer_id !== me) return res.status(403).json({ error: 'Нет доступа' });
    const [r] = await db.query(`DELETE FROM chat_threads WHERE id = ?`, [threadId]);
    if (!r.affectedRows) return res.status(409).json({ error: 'Не удалось удалить' });
    res.json({ ok: true, id: threadId });
  } catch (e) {
    console.error('DELETE /api/chats/:id error', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// single handler that supports text + file attachments
app.post('/api/chats/:id/messages', requireAuth, uploadChat.array('files', 8), async (req, res) => {
  try {
    const threadId = Number(req.params.id);
    const me = req.user.id;
    const body = String(req.body?.body || '').trim();

    const [[t]] = await db.query(SQL.select_chat_threads_02, [threadId]);
    if (!t) return res.status(404).json({ error: 'Диалог не найден' });
    if (t.seller_id !== me && t.buyer_id !== me) {
      return res.status(403).json({ error: 'Нет доступа к диалогу' });
    }

    const receiver = me === t.seller_id ? t.buyer_id : t.seller_id;
    const blockedForMe =
      (receiver === t.seller_id && t.blocked_by_seller) ||
      (receiver === t.buyer_id  && t.blocked_by_buyer);
    if (blockedForMe) return res.status(403).json({ error: 'Пользователь заблокировал вас' });

    const files = Array.isArray(req.files) ? req.files : [];
    const created = [];

    if (body && !files.length) {
      const [r] = await db.query(
        SQL.insert_general_07,
        [threadId, me, body]
      );
      created.push({ id: r.insertId, body });
    }

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const attachUrl = `/uploads/chat/${f.filename}`;
      const attachType = f.mimetype;
      const attachName = f.originalname || f.filename;
      const attachSize = f.size || null;
      const thisBody = (i === 0 ? body : '');
      const [r2] = await db.query(
        SQL.insert_general_08,
        [threadId, me, thisBody, attachUrl, attachType, attachName, attachSize]
      );
      created.push({ id: r2.insertId, body: thisBody, attachment_url: attachUrl, attachment_type: attachType, attachment_name: attachName, attachment_size: attachSize });
    }

    if (!created.length) return res.status(400).json({ error: 'Пустое сообщение' });

    const receiverMuted =
      (receiver === t.seller_id && t.muted_by_seller) ||
      (receiver === t.buyer_id  && t.muted_by_buyer);

    if (receiverMuted) {
      if (receiver === t.seller_id) {
        await db.query(SQL.update_general_05, [created.length, threadId]);
      } else {
        await db.query(SQL.update_general_06, [created.length, threadId]);
      }
    } else {
      _emitTo(req, receiver, 'chat:message', { thread_id: threadId, items: created });
      _emitTo(req, receiver, 'chat:unread', { delta: created.length });
    }
    _emitTo(req, me, 'chat:message:ack', { thread_id: threadId, items: created });
    res.json({ ok: true, items: created });
  } catch (e) {
    console.error('POST /api/chats/:id/messages', e);
    res.status(500).json({ error: 'Server error' });
  }
});

function sideColumns(me, t) {
  if (me === t.seller_id) {
    return { archived: 'archived_by_seller', muted: 'muted_by_seller', blocked: 'blocked_by_seller', muted_unread: 'muted_unread_seller' };
  }
  if (me === t.buyer_id) {
    return { archived: 'archived_by_buyer', muted: 'muted_by_buyer', blocked: 'blocked_by_buyer', muted_unread: 'muted_unread_buyer' };
  }
  return null;
}
app.get('/api/chats/unread-count', requireAuth, async (req, res) => {
  try {
    const me = req.user.id;
    const [[{ c }]] = await db.query(
      SQL.select_chat_messages,
      [me, me, me]
    );
    res.json({ count: c });
  } catch (e) {
    console.error('GET /api/chats/unread-count', e);
    res.status(500).json({ error: 'Server error' });
  }
});
app.get('/api/chats/:id/messages', requireAuth, async (req, res) => {
  try {
    const threadId = Number(req.params.id);
    const me = req.user.id;
    const [[thread]] = await db.query(
      SQL.select_chat_threads_03,
      [threadId, me, me]
    );
    if (!thread) return res.status(404).json({ error: 'Диалог не найден' });
    const [items] = await db.query(
      SQL.select_chat_messages_02,
      [threadId]
    );
    res.json({ thread, items });
  } catch (e) {
    console.error('GET /api/chats/:id/messages', e);
    res.status(500).json({ error: 'Server error' });
  }
});
app.patch('/api/messages/:id', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const me = req.user.id;
    const body = String(req.body?.body || '').trim();
    const [[m]] = await db.query(
      SQL.select_chat_messages_03, [id]
    );
    if (!m) return res.status(404).json({ error: 'Сообщение не найдено' });
    if (m.sender_id !== me) return res.status(403).json({ error: 'Можно редактировать только свои сообщения' });
    if (m.deleted_at) return res.status(400).json({ error: 'Сообщение удалено' });
    await db.query(SQL.update_general_11, [body, id]);
    const [[updated]] = await db.query(
      SQL.select_chat_messages_04, [id]
    );
    _emitTo(req, m.seller_id, 'chat:message:update', { thread_id: m.thread_id, item: updated });
    _emitTo(req, m.buyer_id,  'chat:message:update', { thread_id: m.thread_id, item: updated });
    res.json({ ok: true, item: updated });
  } catch (e) {
    console.error('PATCH /api/messages/:id', e);
    res.status(500).json({ error: 'Server error' });
  }
});
app.delete('/api/messages/:id', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const me = req.user.id;
    const [[m]] = await db.query(
      SQL.select_chat_messages_03, [id]
    );
    if (!m) return res.status(404).json({ error: 'Сообщение не найдено' });
    if (m.sender_id !== me) return res.status(403).json({ error: 'Можно удалять только свои сообщения' });
    if (m.deleted_at) {
      return res.json({
        ok: true,
        item: {
          id: m.id, thread_id: m.thread_id, sender_id: m.sender_id, body: m.body,
          attachment_url: null, attachment_type: null, attachment_name: null, attachment_size: null,
          created_at: m.created_at, read_at: m.read_at, edited_at: m.edited_at, deleted_at: m.deleted_at
        }
      });
    }
    await db.query(
      SQL.update_general_12,
      [id]
    );
    const [[updated]] = await db.query(
      SQL.select_chat_messages_04, [id]
    );
    _emitTo(req, m.seller_id, 'chat:message:update', { thread_id: m.thread_id, item: updated });
    _emitTo(req, m.buyer_id,  'chat:message:update', { thread_id: m.thread_id, item: updated });
    res.json({ ok: true, item: updated });
  } catch (e) {
    console.error('DELETE /api/messages/:id', e);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ===== Categories & Products ===== */
app.get('/api/categories', async (req, res) => {
  try {
    const [rows] = await db.query(SQL.select_categories);
    res.json({ items: rows });
  } catch (e) {
    console.error('GET /api/categories error:', e);
    res.status(500).json({ message: 'Не удалось загрузить категории' });
  }
});
app.post('/admin/categories', requireAuth, requireAdmin, async (req, res) => {
  try {
    let { name } = req.body || {};
    name = (name || '').toString().trim();
    if (!name) return res.status(400).json({ message: 'Название категории обязательно' });
    if (name.length > 100) return res.status(400).json({ message: 'Слишком длинное название' });
    await db.query(SQL.insert_general_09, [name]);
    const [rows] = await db.query(SQL.select_categories_02, [name]);
    res.status(201).json({ item: rows[0] });
  } catch (e) {
    if (e?.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'Такая категория уже существует' });
    }
    console.error('POST /admin/categories error:', e);
    res.status(500).json({ message: 'Не удалось добавить категорию' });
  }
});

async function listProducts(req, res) {
  try {
    const { category } = req.query;
    const params = [];
    let where = "p.status = 'active'";
    if (category) { where += " AND p.category = ?"; params.push(category); }
    const [rows] = await db.query(
      `
      SELECT
        p.id,
        p.title,
        p.description,
        p.price,
        p.qty,
        p.status,
        p.category,
        p.created_at,
        COALESCE(NULLIF(TRIM(p.preview_image_url), ''), NULLIF(TRIM(p.image_url), '')) AS preview_image_url,
        p.image_url,
        TRIM(CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, ''))) AS seller_name
      FROM products p
      JOIN users u ON u.id = p.seller_id
      WHERE ${where}
      ORDER BY p.created_at DESC
      `,
      params
    );
    res.json({ items: rows });
  } catch (e) {
    console.error('GET /products error', e);
    res.status(500).json({ message: 'Server error' });
  }
}
app.get('/products', listProducts);
app.get('/api/products', listProducts);

async function isCategoryExists(name) {
  const cat = String(name || '').trim();
  if (!cat) return false;
  const [rows] = await db.query(SQL.select_categories_03, [cat]);
  return rows.length > 0;
}
const createProduct = async (req, res) => {
  try {
    const { title, description, price, qty, category, preview_image_url } = req.body || {};
    if (!title || price == null || !category || String(category).trim() === '') {
      return res.status(400).json({ message: 'title, price и category обязательны' });
    }
    const p = Number(price);
    if (!Number.isFinite(p) || p < 0) {
      return res.status(400).json({ message: 'price должен быть неотрицательным числом' });
    }
    const q = Number.isFinite(Number(qty)) ? Math.max(0, parseInt(qty, 10)) : 1;
    const preview = (preview_image_url && String(preview_image_url).trim()) || null;
    if (preview && !/^https?:\/\//i.test(preview)) {
      return res.status(400).json({ message: 'preview_image_url должен быть абсолютным URL' });
    }
    const cat = String(category).trim();
    if (req.user?.role !== 'admin') {
      const exists = await isCategoryExists(cat);
      if (!exists) {
        return res.status(400).json({ message: 'Категория должна существовать. Обратитесь к администратору.' });
      }
    }
    const [result] = await db.query(
      SQL.insert_general_10,
      [req.user.id, title, description || null, p, q, cat, preview]
    );
    const newId = result.insertId;
    const [rows] = await db.query(
      `SELECT
         p.id, p.title, p.description, p.price, p.qty, p.status, p.category, p.created_at,
         p.preview_image_url,
         TRIM(CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, ''))) AS seller_name
       FROM products p
       JOIN users u ON u.id = p.seller_id
       WHERE p.id = ?
       LIMIT 1`,
      [newId]
    );
    res.status(201).json({ ok: true, item: rows[0] });
  } catch (e) {
    console.error('POST /products error', e);
    res.status(500).json({ message: 'Server error' });
  }
};
app.post('/products', requireAuth, requireApprovedSeller, createProduct);
app.post('/api/products', requireAuth, requireApprovedSeller, createProduct);

app.get('/api/my/products', requireAuth, requireApprovedSeller, async (req, res) => {
  try {
    const [rows] = await db.query(
      SQL.select_products,
      [req.user.id]
    );
    res.json({ items: rows });
  } catch (e) {
    console.error('GET /api/my/products error', e);
    res.status(500).json({ message: 'Server error' });
  }
});
app.get('/my/products', requireAuth, requireApprovedSeller, async (req, res) => {
  try {
    const [rows] = await db.query(
      SQL.select_products,
      [req.user.id]
    );
    res.json({ items: rows });
  } catch (e) {
    console.error('GET /my/products error', e);
    res.status(500).json({ message: 'Server error' });
  }
});
app.put('/api/products/:id', requireAuth, requireApprovedSeller, async (req, res) => {
  const { id } = req.params;
  const { title, description, price, qty, category } = req.body || {};
  try {
    const cat = category != null ? String(category).trim() : category;
    if (cat && req.user?.role !== 'admin') {
      const exists = await isCategoryExists(cat);
      if (!exists) {
        return res.status(400).json({ message: 'Категория должна существовать. Обратитесь к администратору.' });
      }
    }
    const [result] = await db.query(
      SQL.update_general_13,
      [title, description, price, qty, cat, id, req.user.id]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Товар не найден' });
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('PUT /api/products/:id error', e);
    res.status(500).json({ message: 'Server error' });
  }
});
app.delete('/api/products/:id', requireAuth, requireApprovedSeller, async (req, res) => {
  const { id } = req.params;
  try {
    const [result] = await db.query(SQL.delete_products, [id, req.user.id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Товар не найден' });
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/products/:id error', e);
    res.status(500).json({ message: 'Server error' });
  }
});
app.delete('/admin/products/:id', requireAuth, requireAdmin, async (req, res) => {
  const productId = Number(req.params.id);
  const { reason } = req.body || {};
  if (!reason || !String(reason).trim()) {
    return res.status(400).json({ message: 'Укажите причину удаления' });
  }
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(
      SQL.select_products_02,
      [productId]
    );
    const prod = rows[0];
    if (!prod) { await conn.rollback(); return res.status(404).json({ message: 'Товар не найден' }); }
    await conn.query(
      SQL.insert_general_11,
      [prod.id, prod.seller_id, prod.title, prod.price, prod.category, req.user.id, String(reason).trim()]
    );
    const [delRes] = await conn.query(SQL.delete_products_02, [productId]);
    if (delRes.affectedRows === 0) { await conn.rollback(); return res.status(409).json({ message: 'Не удалось удалить (возможно, уже удалён)' }); }
    await conn.commit();
    res.json({ ok: true });
  } catch (e) {
    await conn.rollback();
    console.error('DELETE /admin/products/:id error:', e);
    res.status(500).json({ message: 'Server error' });
  } finally {
    conn.release();
  }
});
app.get('/admin/product-deletions', requireAuth, requireAdmin, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT
          pd.id, pd.product_id, pd.seller_id,
          u.username AS seller_username, u.first_name AS seller_first_name, u.last_name AS seller_last_name,
          pd.title, pd.price, pd.category, pd.admin_id,
          a.username AS admin_username, a.first_name AS admin_first_name, a.last_name AS admin_last_name,
          pd.reason, pd.created_at
       FROM product_deletions pd
       JOIN users a ON a.id = pd.admin_id
       JOIN users u ON u.id = pd.seller_id
       ORDER BY pd.created_at DESC
       LIMIT 500`
    );
    res.json({ items: rows });
  } catch (e) {
    console.error('GET /admin/product-deletions error:', e);
    res.status(500).json({ message: 'Server error' });
  }
});

/* ===== Recommendations (personalized placeholder) ===== */
app.get('/api/reco/personal', async (req, res) => {
  try {
    const limit = Math.min(24, Math.max(1, parseInt(req.query.limit ?? '12', 10)));
    const [rows] = await db.query(
      `
      SELECT
        p.id, p.title, p.price, p.category, p.created_at,
        COALESCE(NULLIF(TRIM(p.preview_image_url), ''), NULLIF(TRIM(p.image_url), '')) AS preview_image_url,
        p.image_url
      FROM products p
      WHERE p.status = 'active'
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT ?
      `,[limit]
    );
    res.json({ items: rows || [] });
  } catch (e) {
    console.error('GET /api/reco/personal error', e);
    res.status(500).json({ message: 'Server error' });
  }
});

/* ===== Product details & reviews ===== */
app.get('/api/products/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ message: 'Invalid id' });
  try {
    const [rows] = await db.query(
      `
      SELECT
        p.id, p.title, p.description, p.price, p.qty, p.status, p.category, p.created_at,
        p.preview_image_url, p.image_url,
        u.id AS seller_id,
        TRIM(CONCAT(COALESCE(u.first_name,''), ' ', COALESCE(u.last_name,''))) AS seller_name,
        COALESCE((SELECT ROUND(AVG(r2.rating), 1) FROM product_reviews r2 WHERE r2.product_id = p.id), 0) AS avg_rating,
        (SELECT COUNT(*) FROM product_reviews r3 WHERE r3.product_id = p.id) AS reviews_count
      FROM products p
      JOIN users u ON u.id = p.seller_id
      WHERE p.id = ?
      LIMIT 1
      `,[id]
    );
    const item = rows[0];
    if (!item) return res.status(404).json({ message: 'Товар не найден' });
    return res.json({ item });
  } catch (e) {
    console.error('GET /api/products/:id error', e);
    return res.status(500).json({ message: 'Server error' });
  }
});
app.get('/api/products/:id/reviews', async (req, res) => {
  const productId = Number(req.params.id);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit ?? '20', 10)));
  const offset = Math.max(0, parseInt(req.query.offset ?? '0', 10));
  if (!Number.isFinite(productId)) return res.status(400).json({ message: 'Invalid id' });
  try {
    const [rows] = await db.query(
      `
      SELECT r.id, r.rating, r.comment, r.created_at, r.updated_at, r.user_id,
             TRIM(CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, ''))) AS user_name, u.username
      FROM product_reviews r
      JOIN users u ON u.id = r.user_id
      WHERE r.product_id = ?
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT ? OFFSET ?`,
      [productId, limit, offset]
    );
    res.json({ items: rows || [], limit, offset });
  } catch (e) {
    console.error('GET /api/products/:id/reviews error', e);
    res.status(500).json({ message: 'Server error' });
  }
});
app.post('/api/products/:id/reviews', requireAuth, async (req, res) => {
  const productId = Number(req.params.id);
  let { rating, comment } = req.body || {};
  if (!Number.isFinite(productId)) return res.status(400).json({ message: 'Invalid id' });
  rating = parseInt(rating, 10);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ message: 'rating должен быть целым числом от 1 до 5' });
  }
  comment = (comment ?? '').toString().trim() || null;
  try {
    await db.query(
      SQL.insert_general_12,
      [productId, req.user.id, rating, comment]
    );
    const [rows] = await db.query(
      SQL.select_product_reviews_02,
      [productId, req.user.id]
    );
    return res.status(201).json({ item: rows[0] });
  } catch (e) {
    console.error('POST /api/products/:id/reviews error', e);
    res.status(500).json({ message: 'Server error' });
  }
});

/* ===== Cart & Checkout ===== */
app.get('/api/cart', requireAuth, async (req, res) => {
  try {
    const [rows] = await db.query(
      `
      SELECT ci.product_id, ci.qty, p.title, p.price, p.preview_image_url, p.image_url
      FROM cart_items ci
      JOIN products p ON p.id = ci.product_id
      WHERE ci.user_id = ?
      ORDER BY ci.updated_at DESC, ci.id DESC`,
      [req.user.id]
    );
    res.json({ items: rows || [] });
  } catch (e) {
    console.error('GET /api/cart error', e);
    res.status(500).json({ message: 'Server error' });
  }
});
app.post('/api/cart', requireAuth, async (req, res) => {
  let { product_id, qty } = req.body || {};
  const pid = Number(product_id);
  const q = Math.max(1, parseInt(qty ?? '1', 10));
  if (!Number.isFinite(pid)) return res.status(400).json({ message: 'Invalid product_id' });
  try {
    await db.query(
      SQL.insert_general_13,
      [req.user.id, pid, q]
    );
    res.status(201).json({ ok: true });
  } catch (e) {
    console.error('POST /api/cart error', e);
    res.status(500).json({ message: 'Server error' });
  }
});
app.patch('/api/cart/:productId', requireAuth, async (req, res) => {
  const pid = Number(req.params.productId);
  const q = parseInt((req.body || {}).qty, 10);
  if (!Number.isFinite(pid)) return res.status(400).json({ message: 'Invalid id' });
  try {
    if (!Number.isInteger(q) || q <= 0) {
      await db.query(SQL.delete_cart_items, [req.user.id, pid]);
      return res.json({ ok: true, removed: true });
    }
    await db.query(SQL.update_general_14, [q, req.user.id, pid]);
    res.json({ ok: true });
  } catch (e) {
    console.error('PATCH /api/cart/:productId error', e);
    res.status(500).json({ message: 'Server error' });
  }
});
app.delete('/api/cart/:productId', requireAuth, async (req, res) => {
  const pid = Number(req.params.productId);
  if (!Number.isFinite(pid)) return res.status(400).json({ message: 'Invalid id' });
  try {
    await db.query(SQL.delete_cart_items, [req.user.id, pid]);
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/cart/:productId error', e);
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/api/checkout', requireAuth, async (req, res) => {
  const { address, payment } = req.body || {};
  const country = (address?.country || '').trim();
  const city = (address?.city || '').trim();
  const street = (address?.street || '').trim();
  const postal = (address?.postal || '').trim();
  if (!country || !city || !street || !postal) {
    return res.status(400).json({ message: 'Не все поля адреса заполнены' });
  }
  try {
    const [cart] = await db.query(
      SQL.select_cart_items_02, [req.user.id]
    );
    if (!cart || cart.length === 0) {
      return res.status(400).json({ message: 'Корзина пуста' });
    }
    const total = cart.reduce((s, row) => s + Number(row.price) * Number(row.qty), 0);
    const [insOrder] = await db.query(SQL.insert_general_14,
      [req.user.id, total.toFixed(2)]
    );
    const orderId = insOrder.insertId;
    const values = cart.map(r => [orderId, r.product_id, r.qty, r.price]);
    await db.query(SQL.insert_general_15, [values]);
    await db.query(SQL.insert_general_16,
      [orderId, country, city, street, postal]
    );
    const cardNumber = (payment?.cardNumber || '').replace(/\s+/g, '');
    const exp = (payment?.exp || '').trim();
    const cvc = (payment?.cvc || '').trim();
    const luhnOk = /^[0-9]{12,19}$/.test(cardNumber) && luhn(cardNumber);
    if (!luhnOk || !/^\d{2}\/\d{2}$/.test(exp) || !/^\d{3,4}$/.test(cvc)) {
      return res.status(400).json({ message: 'Некорректные карточные данные (демо-валидация)' });
    }
    const last4 = cardNumber.slice(-4);
    const brand = detectBrand(cardNumber);
    await db.query(SQL.update_general_15, [orderId]);
    await db.query(SQL.insert_general_17,
      [orderId, brand, last4]
    );
    await db.query(SQL.delete_cart_items_02, [req.user.id]);
    res.status(201).json({ ok: true, order_id: orderId, total, brand, last4 });
  } catch (e) {
    console.error('POST /api/checkout error', e);
    res.status(500).json({ message: 'Server error' });
  }
});
function luhn(num) {
  let sum = 0, dbl = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let d = +num[i];
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d; dbl = !dbl;
  }
  return sum % 10 === 0;
}
function detectBrand(n) {
  if (/^4/.test(n)) return 'visa';
  if (/^5[1-5]/.test(n) || /^2(2[2-9]|[3-6]|7[01])/.test(n)) return 'mastercard';
  if (/^3[47]/.test(n)) return 'amex';
  if (/^6(?:011|5)/.test(n)) return 'discover';
  return 'card';
}

/* ===== Users: last_seen column ===== */
(async () => {
  try {
    const [c1] = await db.query("SHOW COLUMNS FROM users LIKE 'last_seen_at'");
    if (!c1.length) {
      await db.query(SQL.alter_general_07);
      console.log('✅ added users.last_seen_at');
    }
  } catch (e) { console.error('ensure last_seen_at error:', e.message || e); }
})();

/* ===== Chat schema (minimal ensure) ===== */
(async () => {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS chat_threads (
        id INT AUTO_INCREMENT PRIMARY KEY,
        seller_id INT NOT NULL,
        buyer_id INT NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_pair (seller_id, buyer_id),
        INDEX idx_seller (seller_id, updated_at),
        INDEX idx_buyer (buyer_id, updated_at),
        CONSTRAINT fk_chat_threads_seller FOREIGN KEY (seller_id) REFERENCES users(id) ON DELETE CASCADE,
        CONSTRAINT fk_chat_threads_buyer  FOREIGN KEY (buyer_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        thread_id INT NOT NULL,
        sender_id INT NOT NULL,
        body TEXT NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        read_at DATETIME NULL,
        INDEX idx_thread_created (thread_id, created_at),
        CONSTRAINT fk_chat_messages_thread FOREIGN KEY (thread_id) REFERENCES chat_threads(id) ON DELETE CASCADE,
        CONSTRAINT fk_chat_messages_sender FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    console.log('✅ chat tables ready');
  } catch (e) {
    console.error('ensure chat schema error:', e.message || e);
  }
})();

/* ===== Public user profile ===== */
app.get('/api/users/:id/public', async (req, res) => {
  const userId = Number(req.params.id);
  try {
    const [rows] = await db.query(
      SQL.select_users_14, [userId]
    );
    if (!rows.length) return res.status(404).json({ message: 'User not found' });
    const u = rows[0];
    const [[r1]] = await db.query(
      SQL.select_product_reviews_03,
      [userId]
    );
    const [[r2]] = await db.query(
      SQL.select_order_items,
      [userId]
    );
    const online = req.app?.locals?.isOnline ? req.app.locals.isOnline(userId) : false;
    res.json({
      id: u.id,
      firstName: u.first_name,
      lastName: u.last_name,
      contactEmail: u.contact_email,
      avatarUrl: u.avatar_url,
      rating: r1?.rating != null ? Number(r1.rating) : null,
      soldCount: Number(r2?.soldCount || 0),
      online,
      lastSeenAt: u.last_seen_at,
    });
  } catch (e) {
    console.error('GET /api/users/:id/public error:', e);
    res.status(500).json({ message: 'Server error' });
  }
});

/* ===== Image proxy (CORS bypass for product images) ===== */
const _fetch = (typeof fetch === 'function') ? fetch : ((...args) => import('node-fetch').then(({default: f}) => f(...args)));
app.get('/api/proxy-img', async (req, res) => {
  const url = req.query.u;
  if (!url || !/^https?:\/\//i.test(url)) return res.status(400).send('Bad image url');
  try {
    const r = await _fetch(url, {
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; QontoBot/1.0)',
        'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        'Referer': ''
      }
    });
    if (!r.ok) return res.status(r.status).end();
    const ct = (r.headers.get && r.headers.get('content-type')) || 'image/jpeg';
    res.setHeader('Content-Type', ct);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    if (r.body && r.body.pipe) { r.body.pipe(res); }
    else { const buf = Buffer.from(await r.arrayBuffer()); res.end(buf); }
  } catch (e) { res.status(502).send('Image fetch failed'); }
});

/* ===== Chat (OpenRouter proxy) ===== */
app.post('/api/chat', async (req, res) => {
  const userMessage = req.body.message;
  const PRIMARY_MODEL = OPENROUTER_MODEL || 'mistralai/mistral-7b-instruct:free';
  const FALLBACK_MODELS = [
    'meta-llama/llama-3.1-8b-instruct:free',
    'openrouter/auto'
  ];
  if (!OPENROUTER_API_KEY) {
    return res.status(503).json({ error: 'AI недоступен: отсутствует OPENROUTER_API_KEY на сервере.' });
  }
  let systemContext = 'Ты вежливый ИИ-помощник, консультирующий по интернет-магазину.';
  if (req.user) systemContext += ` Пользователь: ${req.user.username}, email: ${req.user.email}.`;

  async function callModel(model) {
    const { data } = await axios.post(
      `${OPENROUTER_BASE_URL}/chat/completions`,
      { model, messages: [{ role: 'system', content: systemContext }, { role: 'user', content: userMessage }], temperature: 0.7 },
      { headers: { 'Authorization': `Bearer ${OPENROUTER_API_KEY}`, 'Content-Type': 'application/json', 'HTTP-Referer': OPENROUTER_SITE_URL, 'X-Title': OPENROUTER_TITLE } }
    );
    const aiReply = data?.choices?.[0]?.message?.content || 'Пустой ответ от модели';
    return { aiReply, usedModel: model };
  }
  try {
    try { const r = await callModel(PRIMARY_MODEL); return res.json({ reply: r.aiReply, model: r.usedModel }); }
    catch (e) { const s = e.response?.status; if (![401,402,403].includes(s)) throw e; }
    for (const m of FALLBACK_MODELS) {
      try { const r = await callModel(m); return res.json({ reply: r.aiReply, model: r.usedModel }); } catch (e) {}
    }
    return res.status(503).json({ error: 'AI недоступен для текущего ключа/модели. Проверьте ключ и Allowed Sites.' });
  } catch (error) {
    const status = error.response?.status || 500;
    const detail = error.response?.data || error.message;
    console.error('Ошибка обращения к OpenRouter:', detail);
    res.status(status).json({
      error:
        status === 401 ? 'Неверный/отключённый OPENROUTER_API_KEY.' :
        status === 402 ? 'Недостаточно кредитов/лимит.' :
        status === 403 ? 'Доступ к выбранной модели ограничен (проверьте Allowed Sites/регион/политику).' :
        'Не удалось связаться с AI.'
    });
  }
});

/* ===== Launch ===== */
const PORT = process.env.PORT || 5050;
app.post('/api/me/avatar', requireAuth, upload.single('avatar'), async (req, res) => {
  try {
    const url = `/uploads/avatars/${req.file.filename}`;
    await db.query(SQL.update_general_16, [url, req.user.id]);
    res.json({ url });
  } catch (e) {
    console.error('avatar upload error:', e);
    res.status(500).json({ error: 'Failed to save avatar' });
  }
});
server.listen(PORT, () => {
  console.log(`✅ Сервер + Socket.IO на http://localhost:${PORT}`);
});
