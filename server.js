const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { DatabaseSync } = require('node:sqlite'); // SQLite داخلی Node.js — نیازی به کامپایل ندارد
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const APP_NAME = 'Arian Chat';
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-production';
if (!process.env.JWT_SECRET) console.warn('⚠ JWT_SECRET تنظیم نشده؛ قبل از انتشار عمومی حتماً تنظیمش کنید.');

// یوزرنیم مدیر(ها)؛ با کاما جدا کنید. مدیر تیک آبی دارد و پنل مدیریت را می‌بیند.
const ADMINS = String(process.env.ADMIN_USERNAME || '').toLowerCase().split(',').map((s) => s.trim().replace(/^@/, '')).filter(Boolean);
const SESSION_DAYS = 180;
const ALLOWED_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥', '👏', '🎉'];
const USERNAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{4,31}$/; // مثل تلگرام: ۵ تا ۳۲ کاراکتر
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BIO_MAX = 70;
const AVATAR_MAX_BYTES = 512 * 1024;
const MAX_FILE_BYTES = 20 * 1024 * 1024; // حداکثر حجم عکس/فایل: ۲۰ مگابایت
const PHOTO_MIMES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const PAGE_SIZE = 50;

// ───────────── پایگاه داده و پوشه‌ی فایل‌ها ─────────────
// روی سرور، DB_PATH را به مسیری روی دیسک ماندگار (مثلاً /data/messenger.db) تنظیم کنید.
// فایل‌های ارسالی کنار دیتابیس در پوشه‌ی uploads ذخیره می‌شوند.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'messenger.db');
const UPLOAD_DIR = path.join(path.dirname(DB_PATH), 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  email          TEXT UNIQUE COLLATE NOCASE,
  username       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name   TEXT NOT NULL,
  password_hash  TEXT NOT NULL,
  bio            TEXT NOT NULL DEFAULT '',
  avatar         BLOB,
  avatar_mime    TEXT,
  avatar_updated INTEGER,
  verified       INTEGER NOT NULL DEFAULT 0,
  banned         INTEGER NOT NULL DEFAULT 0,
  last_seen      INTEGER,
  created_at     INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  device      TEXT NOT NULL,
  ip          TEXT,
  created_at  INTEGER NOT NULL,
  last_active INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id   INTEGER NOT NULL REFERENCES users(id),
  receiver_id INTEGER NOT NULL REFERENCES users(id),
  text        TEXT NOT NULL,
  file_id     TEXT,
  reply_to    INTEGER,
  created_at  INTEGER NOT NULL,
  read_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_msg_pair ON messages(sender_id, receiver_id, id);
CREATE INDEX IF NOT EXISTS idx_msg_recv ON messages(receiver_id, read_at);
CREATE TABLE IF NOT EXISTS reactions (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  emoji      TEXT NOT NULL,
  PRIMARY KEY (message_id, user_id)
);
CREATE TABLE IF NOT EXISTS uploads (
  id         TEXT PRIMARY KEY,
  owner_id   INTEGER NOT NULL REFERENCES users(id),
  name       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  mime       TEXT NOT NULL,
  kind       TEXT NOT NULL,
  width      INTEGER,
  height     INTEGER,
  message_id INTEGER,
  created_at INTEGER NOT NULL
);
`);

// مهاجرت دیتابیس نسخه‌های قبلی (اضافه کردن ستون‌های جدید در صورت نبودن)
function addMissingColumns(table, columns) {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  for (const [col, def] of Object.entries(columns))
    if (!existing.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
addMissingColumns('users', {
  bio: "TEXT NOT NULL DEFAULT ''",
  avatar: 'BLOB',
  avatar_mime: 'TEXT',
  avatar_updated: 'INTEGER',
  verified: 'INTEGER NOT NULL DEFAULT 0',
  banned: 'INTEGER NOT NULL DEFAULT 0',
});

// نسخه‌های قبلی ایمیل را اجباری داشتند؛ جدول کاربران را بدون این اجبار بازسازی می‌کنیم
const emailCol = db.prepare('PRAGMA table_info(users)').all().find((c) => c.name === 'email');
if (emailCol && emailCol.notnull) {
  const cols = 'id, email, username, display_name, password_hash, bio, avatar, avatar_mime, avatar_updated, verified, banned, last_seen, created_at';
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(`BEGIN;
    CREATE TABLE users_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE COLLATE NOCASE,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      bio TEXT NOT NULL DEFAULT '',
      avatar BLOB, avatar_mime TEXT, avatar_updated INTEGER,
      verified INTEGER NOT NULL DEFAULT 0,
      banned INTEGER NOT NULL DEFAULT 0,
      last_seen INTEGER,
      created_at INTEGER NOT NULL
    );
    INSERT INTO users_new (${cols}) SELECT ${cols} FROM users;
    DROP TABLE users;
    ALTER TABLE users_new RENAME TO users;
    COMMIT;`);
  db.exec('PRAGMA foreign_keys = ON');
}
db.prepare('DELETE FROM sessions WHERE last_active < ?').run(Date.now() - SESSION_DAYS * 864e5);
addMissingColumns('messages', { file_id: 'TEXT', reply_to: 'INTEGER' });
db.exec('CREATE INDEX IF NOT EXISTS idx_msg_file ON messages(file_id)');

// ستون عکس پروفایل (BLOB) را در کوئری‌های معمولی نمی‌خوانیم تا سبک بمانند
const USER_COLS = 'id, email, username, display_name, password_hash, bio, avatar_updated, verified, banned, last_seen, created_at';
// پیام به همراه اطلاعات فایل پیوست‌شده
const MSG_SELECT = `SELECT m.*, f.name AS f_name, f.size AS f_size, f.mime AS f_mime, f.kind AS f_kind,
                           f.width AS f_w, f.height AS f_h
                    FROM messages m LEFT JOIN uploads f ON f.id = m.file_id`;

const q = {
  userById: db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`),
  userByEmail: db.prepare(`SELECT ${USER_COLS} FROM users WHERE email = ?`),
  userByUsername: db.prepare(`SELECT ${USER_COLS} FROM users WHERE username = ?`),
  insertUser: db.prepare(`INSERT INTO users (username, display_name, password_hash, created_at)
                          VALUES (?, ?, ?, ?)`),
  updateProfile: db.prepare('UPDATE users SET display_name = ?, username = ?, bio = ? WHERE id = ?'),
  setPassword: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
  setVerified: db.prepare('UPDATE users SET verified = ? WHERE id = ?'),
  setBanned: db.prepare('UPDATE users SET banned = ? WHERE id = ?'),
  insertSession: db.prepare('INSERT INTO sessions (id, user_id, device, ip, created_at, last_active) VALUES (?, ?, ?, ?, ?, ?)'),
  sessionById: db.prepare('SELECT * FROM sessions WHERE id = ?'),
  sessionsOf: db.prepare('SELECT * FROM sessions WHERE user_id = ? ORDER BY last_active DESC'),
  touchSession: db.prepare('UPDATE sessions SET last_active = ? WHERE id = ?'),
  deleteSession: db.prepare('DELETE FROM sessions WHERE id = ?'),
  setAvatar: db.prepare('UPDATE users SET avatar = ?, avatar_mime = ?, avatar_updated = ? WHERE id = ?'),
  avatarById: db.prepare('SELECT avatar, avatar_mime FROM users WHERE id = ?'),
  searchUsers: db.prepare(`SELECT ${USER_COLS} FROM users WHERE username LIKE ? ESCAPE '\\' AND id != ?
                           ORDER BY length(username), username LIMIT 20`),
  insertMessage: db.prepare(`INSERT INTO messages (sender_id, receiver_id, text, created_at, file_id, reply_to)
                             VALUES (?, ?, ?, ?, ?, ?)`),
  messageById: db.prepare(`${MSG_SELECT} WHERE m.id = ?`),
  history: db.prepare(`${MSG_SELECT}
                       WHERE ((m.sender_id = @me AND m.receiver_id = @peer) OR (m.sender_id = @peer AND m.receiver_id = @me))
                         AND m.id < @before
                       ORDER BY m.id DESC LIMIT @lim`),
  lastMessages: db.prepare(`${MSG_SELECT} WHERE m.id IN (
                              SELECT MAX(id) FROM messages
                              WHERE sender_id = @me OR receiver_id = @me
                              GROUP BY CASE WHEN sender_id = @me THEN receiver_id ELSE sender_id END)
                            ORDER BY m.id DESC`),
  unreadCounts: db.prepare(`SELECT sender_id, COUNT(*) AS c FROM messages
                            WHERE receiver_id = ? AND read_at IS NULL GROUP BY sender_id`),
  markRead: db.prepare('UPDATE messages SET read_at = ? WHERE sender_id = ? AND receiver_id = ? AND read_at IS NULL'),
  getReaction: db.prepare('SELECT emoji FROM reactions WHERE message_id = ? AND user_id = ?'),
  deleteReaction: db.prepare('DELETE FROM reactions WHERE message_id = ? AND user_id = ?'),
  upsertReaction: db.prepare(`INSERT INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)
                              ON CONFLICT(message_id, user_id) DO UPDATE SET emoji = excluded.emoji`),
  setLastSeen: db.prepare('UPDATE users SET last_seen = ? WHERE id = ?'),
  insertUpload: db.prepare(`INSERT INTO uploads (id, owner_id, name, size, mime, kind, width, height, created_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  uploadById: db.prepare('SELECT * FROM uploads WHERE id = ?'),
  attachUpload: db.prepare('UPDATE uploads SET message_id = ? WHERE id = ?'),
  fileAccess: db.prepare('SELECT 1 FROM messages WHERE file_id = ? AND (sender_id = ? OR receiver_id = ?) LIMIT 1'),
};

// ───────────── کمکی‌ها ─────────────
const onlineCounts = new Map(); // userId -> تعداد تب‌های باز

const isAdmin = (u) => !!u && ADMINS.includes(String(u.username).toLowerCase());

const userInfo = (u) => ({
  id: u.id,
  username: u.username,
  displayName: u.display_name,
  verified: !!u.verified || isAdmin(u),
  bio: u.bio || '',
  avatar: u.avatar_updated ? `/api/avatar/${u.id}?v=${u.avatar_updated}` : null,
  online: onlineCounts.has(u.id),
  lastSeen: u.last_seen || null,
});
const meInfo = (u) => ({ ...userInfo(u), isAdmin: isAdmin(u) });

const replyPreview = (r) => ({
  id: r.id,
  from: r.sender_id,
  kind: r.file_id ? r.f_kind : 'text',
  text: r.text.slice(0, 120),
  fileName: r.f_name || null,
});

function repliesFor(rows) {
  const ids = [...new Set(rows.map((r) => r.reply_to).filter(Boolean))];
  if (!ids.length) return {};
  const list = db.prepare(`${MSG_SELECT} WHERE m.id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  return Object.fromEntries(list.map((r) => [r.id, replyPreview(r)]));
}

const formatMessage = (m, reactions = [], replies = {}) => ({
  id: m.id,
  from: m.sender_id,
  to: m.receiver_id,
  text: m.text,
  createdAt: m.created_at,
  readAt: m.read_at,
  reactions,
  kind: m.file_id ? m.f_kind : 'text',
  file: m.file_id
    ? { id: m.file_id, name: m.f_name, size: m.f_size, mime: m.f_mime, width: m.f_w, height: m.f_h, url: `/api/files/${m.file_id}` }
    : null,
  replyTo: m.reply_to ? replies[m.reply_to] || null : null,
});

function reactionsFor(ids) {
  if (!ids.length) return {};
  const rows = db
    .prepare(`SELECT message_id, user_id, emoji FROM reactions WHERE message_id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids);
  const map = {};
  for (const r of rows) (map[r.message_id] ||= []).push({ userId: r.user_id, emoji: r.emoji });
  return map;
}

// ───────────── نشست‌ها (دستگاه‌های فعال) ─────────────
function deviceName(ua = '') {
  const os = /Android/.test(ua) ? 'Android'
    : /iPhone|iPad|iPod/.test(ua) ? 'iPhone/iPad'
    : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X|Macintosh/.test(ua) ? 'Mac'
    : /Linux/.test(ua) ? 'Linux' : 'سیستم نامشخص';
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /OPR\/|Opera/.test(ua) ? 'Opera'
    : /SamsungBrowser/.test(ua) ? 'Samsung Internet'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari' : 'مرورگر';
  return `${browser} روی ${os}`;
}

// برای هر ورود یک نشست جدا می‌سازیم تا بشود از هر دستگاه جداگانه خارج شد
function createSession(user, req) {
  const sid = crypto.randomBytes(16).toString('hex');
  const now = Date.now();
  q.insertSession.run(sid, user.id, deviceName(req.headers['user-agent']), req.ip || null, now, now);
  io.to('u:' + user.id).emit('sessions:changed');
  return jwt.sign({ id: user.id, sid }, JWT_SECRET, { expiresIn: `${SESSION_DAYS}d` });
}

function revokeSession(sid, userId) {
  q.deleteSession.run(sid);
  io.to('s:' + sid).emit('session:revoked');
  setTimeout(() => io.in('s:' + sid).disconnectSockets(true), 300);
  io.to('u:' + userId).emit('sessions:changed');
}

function revokeAllSessions(userId, exceptSid = null) {
  for (const s of q.sessionsOf.all(userId)) if (s.id !== exceptSid) revokeSession(s.id, userId);
}

function userFromToken(token) {
  try {
    const { id, sid } = jwt.verify(token, JWT_SECRET);
    if (!sid) return null; // توکن‌های نسخه‌ی قبلی معتبر نیستند
    const session = q.sessionById.get(sid);
    if (!session || session.user_id !== id) return null;
    const user = q.userById.get(id);
    if (!user || user.banned) return null;
    const now = Date.now();
    if (now - session.last_active > 60e3) q.touchSession.run(now, sid);
    return { ...user, sid };
  } catch {
    return null;
  }
}

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const user = userFromToken(h.startsWith('Bearer ') ? h.slice(7) : '');
  if (!user) return res.status(401).json({ error: 'نشست شما منقضی شده؛ دوباره وارد شوید' });
  req.user = user;
  next();
}

function adminOnly(req, res, next) {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'دسترسی ندارید' });
  next();
}

// رمز قوی: حداقل ۹ کاراکتر، شامل حرف و عدد
function passwordError(p) {
  if (p.length < 9) return 'رمز عبور باید حداقل ۹ کاراکتر باشد';
  if (!/[A-Za-z\u0600-\u06FF]/.test(p) || !/[0-9\u06F0-\u06F9]/.test(p)) return 'رمز عبور باید هم حرف داشته باشد و هم عدد';
  return null;
}

// اعتبارسنجی مشترک ثبت‌نام و ویرایش پروفایل
function validateProfile({ displayName, username, bio }) {
  if (!displayName || [...displayName].length > 64)
    return { error: 'نام پروفایل باید بین ۱ تا ۶۴ کاراکتر باشد', field: 'name' };
  if (!USERNAME_RE.test(username))
    return {
      error: 'یوزرنیم باید ۵ تا ۳۲ کاراکتر باشد، با حرف انگلیسی شروع شود و فقط حروف انگلیسی، عدد و _ داشته باشد',
      field: 'username',
    };
  if (bio !== undefined && [...bio].length > BIO_MAX)
    return { error: `بیوگرافی حداکثر ${BIO_MAX.toLocaleString('fa-IR')} کاراکتر است`, field: 'bio' };
  return null;
}

// ───────────── سرور ─────────────
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.set('trust proxy', 'loopback'); // پشت Caddy آی‌پی واقعی کاربر را بخوان
app.use(express.static(path.join(__dirname, 'public')));

// آپلود عکس یا فایل (قبل از express.json تعریف می‌شود تا بدنه‌ی خام دریافت شود)
app.post('/api/upload', auth, express.raw({ type: () => true, limit: MAX_FILE_BYTES }), (req, res) => {
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ error: 'فایل خالی است' });

  const name = String(req.query.name || 'file').replace(/[\u0000-\u001f\u007f/\\]/g, '').trim().slice(0, 180) || 'file';
  const mime = (String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() || 'application/octet-stream').slice(0, 100);
  const kind = req.query.photo === '1' && PHOTO_MIMES.includes(mime) ? 'image' : 'file';
  const dim = (v) => {
    const n = parseInt(v, 10);
    return n > 0 && n < 30000 ? n : null;
  };

  const id = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(UPLOAD_DIR, id), buf);
  q.insertUpload.run(
    id, req.user.id, name, buf.length, mime, kind,
    kind === 'image' ? dim(req.query.w) : null,
    kind === 'image' ? dim(req.query.h) : null,
    Date.now()
  );
  res.json({ id, name, size: buf.length, mime, kind });
});

app.use(express.json({ limit: '1mb' }));

// دریافت فایل؛ فقط فرستنده و گیرنده‌ی پیام اجازه دارند
app.get('/api/files/:id', (req, res) => {
  const h = req.headers.authorization || '';
  const user = userFromToken(h.startsWith('Bearer ') ? h.slice(7) : String(req.query.t || ''));
  if (!user) return res.status(401).end();

  const id = String(req.params.id);
  if (!/^[a-f0-9]{32}$/.test(id)) return res.status(404).end();
  const f = q.uploadById.get(id);
  if (!f) return res.status(404).end();
  if (f.owner_id !== user.id && !q.fileAccess.get(id, user.id, user.id)) return res.status(403).end();

  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': 'sandbox',
    'Cache-Control': 'private, max-age=31536000, immutable',
  });
  // فقط عکس‌های امن داخل صفحه نمایش داده می‌شوند؛ بقیه همیشه دانلود می‌شوند
  if (f.kind === 'image' && req.query.download !== '1') {
    res.type(f.mime);
  } else {
    res.attachment(f.name);
    res.type('application/octet-stream');
  }
  res.sendFile(path.join(UPLOAD_DIR, id), (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

app.get('/api/username-available', (req, res) => {
  const u = String(req.query.u || '').trim().replace(/^@/, '');
  if (!USERNAME_RE.test(u)) return res.json({ available: false, valid: false });
  res.json({ available: !q.userByUsername.get(u), valid: true });
});

app.post('/api/register', (req, res) => {
  const b = req.body || {};
  const username = String(b.username || '').trim().replace(/^@/, '');
  const password = String(b.password || '');
  const data = { username, displayName: String(b.displayName || '').trim() || username };

  const invalid = validateProfile(data);
  if (invalid) return res.status(400).json(invalid);
  const weak = passwordError(password);
  if (weak) return res.status(400).json({ error: weak, field: 'password' });
  if (q.userByUsername.get(username)) return res.status(409).json({ error: 'این یوزرنیم قبلاً گرفته شده', field: 'username' });

  try {
    const info = q.insertUser.run(username, data.displayName, bcrypt.hashSync(password, 10), Date.now());
    const user = q.userById.get(Number(info.lastInsertRowid));
    res.json({ token: createSession(user, req), user: meInfo(user) });
  } catch {
    res.status(409).json({ error: 'این یوزرنیم قبلاً گرفته شده', field: 'username' });
  }
});

app.post('/api/login', (req, res) => {
  const login = String(req.body?.login || '').trim().replace(/^@/, '');
  const password = String(req.body?.password || '');
  // ورود با ایمیل فقط برای حساب‌های قدیمی که ایمیل دارند باقی مانده
  const user = EMAIL_RE.test(login) ? q.userByEmail.get(login.toLowerCase()) : q.userByUsername.get(login);
  if (!user || !bcrypt.compareSync(password, user.password_hash))
    return res.status(400).json({ error: 'یوزرنیم یا رمز عبور اشتباه است' });
  if (user.banned) return res.status(403).json({ error: 'این حساب توسط مدیر مسدود شده است' });
  res.json({ token: createSession(user, req), user: meInfo(user) });
});

app.post('/api/logout', auth, (req, res) => {
  revokeSession(req.user.sid, req.user.id);
  res.json({ ok: true });
});

// ───────────── دستگاه‌های فعال ─────────────
const sessionInfo = (s, currentSid) => ({
  id: s.id, device: s.device, ip: s.ip, createdAt: s.created_at, lastActive: s.last_active, current: s.id === currentSid,
});

app.get('/api/sessions', auth, (req, res) => {
  res.json(q.sessionsOf.all(req.user.id).map((s) => sessionInfo(s, req.user.sid)));
});

app.delete('/api/sessions/:id', auth, (req, res) => {
  const s = q.sessionById.get(String(req.params.id));
  if (!s || s.user_id !== req.user.id) return res.status(404).json({ error: 'این دستگاه پیدا نشد' });
  revokeSession(s.id, req.user.id);
  res.json({ ok: true });
});

app.delete('/api/sessions', auth, (req, res) => {
  revokeAllSessions(req.user.id, req.user.sid);
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => res.json(meInfo(req.user)));

// ویرایش نام، یوزرنیم، بیوگرافی و ایمیل
app.put('/api/me', auth, (req, res) => {
  const b = req.body || {};
  const me = req.user;
  const data = {
    displayName: b.displayName !== undefined ? String(b.displayName).trim() : me.display_name,
    username: b.username !== undefined ? String(b.username).trim().replace(/^@/, '') : me.username,
    bio: b.bio !== undefined ? String(b.bio).replace(/\s+/g, ' ').trim() : me.bio || '',
  };
  const invalid = validateProfile(data);
  if (invalid) return res.status(400).json(invalid);

  const sameUsername = q.userByUsername.get(data.username);
  if (sameUsername && sameUsername.id !== me.id)
    return res.status(409).json({ error: 'این یوزرنیم قبلاً گرفته شده', field: 'username' });

  try {
    q.updateProfile.run(data.displayName, data.username, data.bio, me.id);
  } catch {
    return res.status(409).json({ error: 'این یوزرنیم قبلاً گرفته شده', field: 'username' });
  }
  const updated = q.userById.get(me.id);
  io.emit('user:update', userInfo(updated));
  res.json(meInfo(updated));
});

// تغییر رمز عبور (بقیه‌ی دستگاه‌ها خارج می‌شوند)
app.put('/api/me/password', auth, (req, res) => {
  const current = String(req.body?.current || '');
  const next = String(req.body?.password || '');
  if (!bcrypt.compareSync(current, req.user.password_hash))
    return res.status(400).json({ error: 'رمز فعلی اشتباه است', field: 'current' });
  const weak = passwordError(next);
  if (weak) return res.status(400).json({ error: weak, field: 'password' });
  q.setPassword.run(bcrypt.hashSync(next, 10), req.user.id);
  revokeAllSessions(req.user.id, req.user.sid);
  res.json({ ok: true });
});

// آپلود عکس پروفایل (تصویر به‌صورت data URL که در مرورگر کوچک و مربعی شده)
app.put('/api/me/avatar', auth, (req, res) => {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body?.image || ''));
  if (!m) return res.status(400).json({ error: 'فرمت تصویر پشتیبانی نمی‌شود' });
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > AVATAR_MAX_BYTES) return res.status(400).json({ error: 'حجم تصویر بیش از حد مجاز است' });
  q.setAvatar.run(buf, m[1], Date.now(), req.user.id);
  const updated = q.userById.get(req.user.id);
  io.emit('user:update', userInfo(updated));
  res.json(meInfo(updated));
});

app.delete('/api/me/avatar', auth, (req, res) => {
  q.setAvatar.run(null, null, null, req.user.id);
  const updated = q.userById.get(req.user.id);
  io.emit('user:update', userInfo(updated));
  res.json(meInfo(updated));
});

app.get('/api/avatar/:id', (req, res) => {
  const row = q.avatarById.get(Number(req.params.id));
  if (!row || !row.avatar) return res.status(404).end();
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.type(row.avatar_mime || 'image/jpeg').send(Buffer.from(row.avatar));
});

app.get('/api/users/search', auth, (req, res) => {
  const term = String(req.query.q || '').trim().replace(/^@/, '');
  if (!term) return res.json([]);
  const like = term.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
  res.json(q.searchUsers.all(like, req.user.id).map(userInfo));
});

// پیدا کردن کاربر با یوزرنیم دقیق (برای کلیک روی @یوزرنیم داخل پیام‌ها)
app.get('/api/users/by-username/:username', auth, (req, res) => {
  const u = q.userByUsername.get(String(req.params.username).replace(/^@/, ''));
  if (!u) return res.status(404).json({ error: 'کاربری با این یوزرنیم پیدا نشد' });
  res.json(userInfo(u));
});

app.get('/api/users/:id', auth, (req, res) => {
  const u = q.userById.get(Number(req.params.id));
  if (!u) return res.status(404).json({ error: 'کاربر پیدا نشد' });
  res.json(userInfo(u));
});

app.get('/api/chats', auth, (req, res) => {
  const me = req.user.id;
  const unread = Object.fromEntries(q.unreadCounts.all(me).map((r) => [r.sender_id, r.c]));
  const chats = q.lastMessages.all({ me }).map((m) => {
    const peerId = m.sender_id === me ? m.receiver_id : m.sender_id;
    return { peer: userInfo(q.userById.get(peerId)), last: formatMessage(m), unread: unread[peerId] || 0 };
  });
  res.json(chats);
});

app.get('/api/messages/:peerId', auth, (req, res) => {
  const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
  const rows = q.history.all({ me: req.user.id, peer: Number(req.params.peerId), before, lim: PAGE_SIZE + 1 });
  const hasMore = rows.length > PAGE_SIZE;
  const page = rows.slice(0, PAGE_SIZE).reverse();
  const rx = reactionsFor(page.map((m) => m.id));
  const replies = repliesFor(page);
  res.json({ messages: page.map((m) => formatMessage(m, rx[m.id] || [], replies)), hasMore });
});

// ───────────── پنل مدیریت ─────────────
// مدیر آمار، کاربران، دستگاه‌ها و ورودها را می‌بیند؛ متن پیام‌های خصوصی نمایش داده نمی‌شود.
const adminQ = {
  count: (sql, ...a) => db.prepare(sql).get(...a).c,
  users: db.prepare(`SELECT ${USER_COLS},
      (SELECT COUNT(*) FROM messages m WHERE m.sender_id = u.id) AS msg_count,
      (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id) AS dev_count
    FROM users u WHERE username LIKE @q ESCAPE '\\' OR display_name LIKE @q ESCAPE '\\'
    ORDER BY created_at DESC LIMIT 300`),
  recentLogins: db.prepare(`SELECT s.created_at, s.device, s.ip, s.user_id FROM sessions s
    ORDER BY s.created_at DESC LIMIT 25`),
  recentSignups: db.prepare('SELECT id, created_at FROM users ORDER BY created_at DESC LIMIT 25'),
};

app.get('/api/admin/stats', auth, adminOnly, (req, res) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const t = today.getTime();
  const files = db.prepare('SELECT COUNT(*) AS c, COALESCE(SUM(size), 0) AS s FROM uploads WHERE message_id IS NOT NULL').get();
  const events = [
    ...adminQ.recentLogins.all().map((r) => ({ type: 'login', at: r.created_at, device: r.device, ip: r.ip, user: r.user_id })),
    ...adminQ.recentSignups.all().map((r) => ({ type: 'signup', at: r.created_at, user: r.id })),
  ].sort((a, b) => b.at - a.at).slice(0, 30);
  const users = {};
  for (const e of events) {
    if (users[e.user]) continue;
    const u = q.userById.get(e.user);
    if (u) users[e.user] = userInfo(u);
  }
  res.json({
    totalUsers: adminQ.count('SELECT COUNT(*) AS c FROM users'),
    onlineNow: onlineCounts.size,
    newToday: adminQ.count('SELECT COUNT(*) AS c FROM users WHERE created_at >= ?', t),
    activeToday: adminQ.count('SELECT COUNT(DISTINCT user_id) AS c FROM sessions WHERE last_active >= ?', t),
    messagesToday: adminQ.count('SELECT COUNT(*) AS c FROM messages WHERE created_at >= ?', t),
    totalMessages: adminQ.count('SELECT COUNT(*) AS c FROM messages'),
    files: files.c,
    filesSize: files.s,
    sessions: adminQ.count('SELECT COUNT(*) AS c FROM sessions'),
    events,
    users,
  });
});

app.get('/api/admin/users', auth, adminOnly, (req, res) => {
  const term = String(req.query.q || '').trim().replace(/^@/, '');
  const like = '%' + term.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
  res.json(adminQ.users.all({ q: like }).map((u) => ({
    ...userInfo(u),
    isAdmin: isAdmin(u),
    banned: !!u.banned,
    createdAt: u.created_at,
    messages: u.msg_count,
    devices: u.dev_count,
  })));
});

app.get('/api/admin/users/:id/sessions', auth, adminOnly, (req, res) => {
  res.json(q.sessionsOf.all(Number(req.params.id)).map((s) => sessionInfo(s, req.user.sid)));
});

function adminTarget(req, res) {
  const u = q.userById.get(Number(req.params.id));
  if (!u) res.status(404).json({ error: 'کاربر پیدا نشد' });
  return u || null;
}

app.post('/api/admin/users/:id/verify', auth, adminOnly, (req, res) => {
  const u = adminTarget(req, res);
  if (!u) return;
  q.setVerified.run(req.body?.verified ? 1 : 0, u.id);
  io.emit('user:update', userInfo(q.userById.get(u.id)));
  res.json({ ok: true });
});

app.post('/api/admin/users/:id/ban', auth, adminOnly, (req, res) => {
  const u = adminTarget(req, res);
  if (!u) return;
  if (isAdmin(u)) return res.status(400).json({ error: 'حساب مدیر را نمی‌شود مسدود کرد' });
  q.setBanned.run(req.body?.banned ? 1 : 0, u.id);
  if (req.body?.banned) revokeAllSessions(u.id);
  res.json({ ok: true });
});

app.post('/api/admin/users/:id/logout', auth, adminOnly, (req, res) => {
  const u = adminTarget(req, res);
  if (!u) return;
  revokeAllSessions(u.id, u.id === req.user.id ? req.user.sid : null);
  res.json({ ok: true });
});

app.post('/api/admin/users/:id/password', auth, adminOnly, (req, res) => {
  const u = adminTarget(req, res);
  if (!u) return;
  const p = String(req.body?.password || '');
  const weak = passwordError(p);
  if (weak) return res.status(400).json({ error: weak });
  q.setPassword.run(bcrypt.hashSync(p, 10), u.id);
  revokeAllSessions(u.id, u.id === req.user.id ? req.user.sid : null);
  res.json({ ok: true });
});

// خطای حجم زیاد و بدنه‌ی نامعتبر را به‌صورت JSON برگردان
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large')
    return res.status(413).json({ error: 'حجم فایل بیشتر از ۲۰ مگابایت است' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'درخواست نامعتبر است' });
  next(err);
});

// ───────────── Socket.IO (بلادرنگ) ─────────────
io.use((socket, next) => {
  const user = userFromToken(socket.handshake.auth?.token);
  if (!user) return next(new Error('unauthorized'));
  socket.userId = user.id;
  socket.sid = user.sid;
  next();
});

const inConversation = (m, a, b) =>
  (m.sender_id === a && m.receiver_id === b) || (m.sender_id === b && m.receiver_id === a);

io.on('connection', (socket) => {
  const myId = socket.userId;
  socket.join('u:' + myId);
  socket.join('s:' + socket.sid);

  const count = (onlineCounts.get(myId) || 0) + 1;
  onlineCounts.set(myId, count);
  if (count === 1) io.emit('presence', { userId: myId, online: true });

  socket.on('message:send', (payload = {}, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const to = Number(payload.to);
    const text = String(payload.text || '').trim();
    const fileId = payload.fileId ? String(payload.fileId) : null;
    const replyTo = payload.replyTo ? Number(payload.replyTo) : null;

    if (!text && !fileId) return reply({ error: 'پیام خالی است' });
    if (text.length > 4000) return reply({ error: 'پیام نباید بیشتر از ۴۰۰۰ کاراکتر باشد' });
    if (to === myId) return reply({ error: 'نمی‌توانید به خودتان پیام بدهید' });
    const peer = q.userById.get(to);
    if (!peer) return reply({ error: 'کاربر پیدا نشد' });

    if (fileId) {
      const up = q.uploadById.get(fileId);
      if (!up || up.owner_id !== myId || up.message_id) return reply({ error: 'فایل پیدا نشد یا قبلاً ارسال شده' });
    }
    if (replyTo) {
      const target = q.messageById.get(replyTo);
      if (!target || !inConversation(target, myId, to)) return reply({ error: 'پیامی که به آن پاسخ می‌دهید پیدا نشد' });
    }

    const info = q.insertMessage.run(myId, to, text, Date.now(), fileId, replyTo);
    const id = Number(info.lastInsertRowid);
    if (fileId) q.attachUpload.run(id, fileId);

    const row = q.messageById.get(id);
    const msg = {
      ...formatMessage(row, [], repliesFor([row])),
      sender: userInfo(q.userById.get(myId)),
      recipient: userInfo(peer),
    };
    io.to('u:' + myId).to('u:' + to).emit('message:new', msg);
    reply({ ok: true, id });
  });

  socket.on('reaction:toggle', ({ messageId, emoji } = {}) => {
    if (!ALLOWED_REACTIONS.includes(emoji)) return;
    const m = q.messageById.get(Number(messageId));
    if (!m || (m.sender_id !== myId && m.receiver_id !== myId)) return;

    const existing = q.getReaction.get(m.id, myId);
    if (existing && existing.emoji === emoji) q.deleteReaction.run(m.id, myId);
    else q.upsertReaction.run(m.id, myId, emoji);

    const reactions = reactionsFor([m.id])[m.id] || [];
    io.to('u:' + m.sender_id).to('u:' + m.receiver_id).emit('reaction:update', { messageId: m.id, reactions });
  });

  socket.on('typing', ({ to } = {}) => {
    to = Number(to);
    if (to && to !== myId) socket.to('u:' + to).emit('typing', { from: myId });
  });

  socket.on('chat:read', ({ peerId } = {}) => {
    peerId = Number(peerId);
    if (!peerId) return;
    const r = q.markRead.run(Date.now(), peerId, myId);
    if (r.changes) io.to('u:' + peerId).emit('messages:read', { by: myId });
  });

  socket.on('disconnect', () => {
    const n = (onlineCounts.get(myId) || 1) - 1;
    if (n > 0) return onlineCounts.set(myId, n);
    onlineCounts.delete(myId);
    const ts = Date.now();
    q.setLastSeen.run(ts, myId);
    io.emit('presence', { userId: myId, online: false, lastSeen: ts });
  });
});

server.listen(PORT, () => {
  console.log(`${APP_NAME} روی http://localhost:${PORT} اجرا شد`);
  console.log(ADMINS.length ? `مدیر: @${ADMINS.join(', @')}` : 'ⓘ برای فعال شدن پنل مدیریت، ADMIN_USERNAME را تنظیم کنید.');
});
