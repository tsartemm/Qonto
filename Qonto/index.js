// index.js — минимально-рабочий сервер для продакшена (Express + Socket.IO)
// слушает process.env.PORT и 0.0.0.0, готов к Railway/Render/Heroku

import http from "http";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import compression from "compression";
import cookieParser from "cookie-parser";
import bodyParser from "body-parser";
import multer from "multer";
import { Server as SocketIOServer } from "socket.io";

import "dotenv/config";

// ВАЖНО: путь к пулу у тебя: Qonto/db_query/pool.js
import { pool, ping } from "./Qonto/db_query/pool.js";

// ───────────────────────────────────────────────────────────────────────────────
// базовая настройка путей
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ───────────────────────────────────────────────────────────────────────────────
// Express-приложение и middlewares
const app = express();
const allowedOrigins = (process.env.CLIENT_ORIGIN || "http://localhost:3000")
  .split(",")
  .map(s => s.trim());

app.use(helmet());
app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(morgan("dev"));
app.use(compression());
app.use(cookieParser());
app.use(bodyParser.json({ limit: "5mb" }));
app.use(bodyParser.urlencoded({ extended: true }));

// ───────────────────────────────────────────────────────────────────────────────
// Статика для загрузок (аватары/вложения чатов и т.д.)
const uploadsRoot = path.resolve(__dirname, "uploads");
fs.mkdirSync(uploadsRoot, { recursive: true });
app.use("/uploads", express.static(uploadsRoot));

// Пример хранилища для аватаров
const avatarDir = path.join(uploadsRoot, "avatars");
fs.mkdirSync(avatarDir, { recursive: true });
const avatarStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, avatarDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || ".jpg");
    const uid = req?.user?.id || "anon";
    cb(null, `${uid}_${Date.now()}${ext}`);
  }
});
const uploadAvatar = multer({ storage: avatarStorage });

// Пример хранилища для файлов чата
const chatDir = path.join(uploadsRoot, "chat");
fs.mkdirSync(chatDir, { recursive: true });
const chatStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, chatDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "");
    cb(null, `${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
  }
});
const uploadChat = multer({
  storage: chatStorage,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

// ───────────────────────────────────────────────────────────────────────────────
// Примитивная авторизация (если нужна — расширишь)
import jwt from "jsonwebtoken";
const JWT_SECRET = process.env.JWT_SECRET || "dev_secret";
function extractToken(req) {
  const h = req.headers.authorization || "";
  const bearer = h.startsWith("Bearer ") ? h.slice(7) : null;
  return bearer || req.cookies.token || null;
}
app.use(async (req, _res, next) => {
  const token = extractToken(req);
  if (!token) return next();
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    // если есть функция получения пользователя из БД — подставь её:
    req.user = { id: payload.id };
  } catch {
    req.user = null;
  }
  next();
});

// ───────────────────────────────────────────────────────────────────────────────
// Health-checks и базовые API-эндпоинты
app.get("/health", (_req, res) => res.status(200).send("ok"));

app.get("/api/db-ping", async (_req, res) => {
  try {
    const ok = await ping();
    res.json({ ok });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "db error" });
  }
});

// пример загрузки аватара: POST /api/me/avatar  form-data: avatar=<file>
app.post("/api/me/avatar", uploadAvatar.single("avatar"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "file is required" });
  res.json({ url: `/uploads/avatars/${req.file.filename}` });
});

// пример отправки сообщения с вложениями: POST /api/chats/:id  form-data: files[]
app.post("/api/chats/:id", uploadChat.array("files", 8), (req, res) => {
  const files = (req.files || []).map(f => ({
    url: `/uploads/chat/${f.filename}`,
    type: f.mimetype,
    name: f.originalname || f.filename,
    size: f.size
  }));
  res.json({ ok: true, threadId: Number(req.params.id), files });
});

// ТУТ подключай свои роутеры при необходимости:
// import apiRouter from "./routes/api.js";
// app.use("/api", apiRouter);

// ───────────────────────────────────────────────────────────────────────────────
// HTTP-сервер + Socket.IO (без отдельного файла)
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: allowedOrigins, credentials: true }
});

// простая логика присутствия
io.on("connection", (socket) => {
  console.log("socket connected:", socket.id);

  socket.on("auth", (userId) => {
    const uid = Number(userId);
    if (!uid) return;
    socket.join(`user:${uid}`);
    io.emit("presence:update", { userId: uid, online: true });
  });

  socket.on("thread:join", (threadId) => {
    const tid = Number(threadId);
    if (!tid) return;
    socket.join(`thread:${tid}`);
  });

  socket.on("thread:typing", ({ threadId, from }) => {
    const tid = Number(threadId);
    if (!tid) return;
    socket.to(`thread:${tid}`).emit("thread:typing", { threadId: tid, from });
  });

  socket.on("disconnect", () => {
    console.log("socket disconnected:", socket.id);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// Старт
const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", async () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`);
  try {
    const [rows] = await pool.query("SELECT 1 AS ok");
    console.log("DB ping:", rows?.[0]);
  } catch (e) {
    console.error("DB connection error:", e?.message || e);
  }
});
