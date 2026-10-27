const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { DatabaseSync } = require('node:sqlite'); // SQLite داخلی Node.js — نیازی به کامپایل ندارد
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const next = require('next');

// حالت اجرا: «node server.js» برای توسعه، «node server.js --prod» برای سرور اصلی
const dev = !process.argv.includes('--prod') && process.env.NODE_ENV !== 'production';

let QRCode = null;
try { QRCode = require('qrcode'); } catch { /* اگر نصب نباشد، کد QR غیرفعال می‌شود */ }

const APP_NAME = 'Pingo Chat';
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-production';
if (!process.env.JWT_SECRET) console.warn('⚠ JWT_SECRET تنظیم نشده؛ قبل از انتشار عمومی حتماً تنظیمش کنید.');

// یوزرنیم مدیر(ها)؛ با کاما جدا کنید. مدیر تیک آبی دارد و پنل مدیریت را می‌بیند.
const ADMINS = String(process.env.ADMIN_USERNAME || '').toLowerCase().split(',').map((s) => s.trim().replace(/^@/, '')).filter(Boolean);
const SESSION_DAYS = 180;
const ALLOWED_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥', '👏', '🎉'];
const TYPING_ACTIONS = ['typing', 'photo', 'file', 'voice', 'video', 'videonote'];
const BADGES = ['blue', 'black', 'white']; // تیک‌های رسمی
const USERNAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{4,31}$/; // مثل تلگرام: ۵ تا ۳۲ کاراکتر
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BIO_MAX = 70;
const GROUP_TITLE_MAX = 64;
const GROUP_DESC_MAX = 255;
const MAX_GROUP_MEMBERS = 1000; // سقف اعضای هر گروه
const AVATAR_MAX_BYTES = 512 * 1024;
const MAX_FILE_BYTES = 50 * 1024 * 1024; // حداکثر حجم عکس/ویدیو/فایل/ویس: ۵۰ مگابایت
const PHOTO_MIMES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const VIDEO_MIMES = ['video/mp4', 'video/webm', 'video/quicktime'];
const AUDIO_MIMES = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/aac', 'audio/wav', 'audio/x-m4a'];
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
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  email            TEXT UNIQUE COLLATE NOCASE,
  username         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name     TEXT NOT NULL,
  password_hash    TEXT NOT NULL,
  bio              TEXT NOT NULL DEFAULT '',
  avatar           BLOB,
  avatar_mime      TEXT,
  avatar_updated   INTEGER,
  verified         INTEGER NOT NULL DEFAULT 0,
  banned           INTEGER NOT NULL DEFAULT 0,
  lastseen_privacy TEXT NOT NULL DEFAULT 'everyone',
  badge            TEXT,
  panel_role       TEXT,
  last_seen        INTEGER,
  created_at       INTEGER NOT NULL
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
CREATE TABLE IF NOT EXISTS groups (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  title          TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  owner_id       INTEGER NOT NULL REFERENCES users(id),
  invite_code    TEXT NOT NULL UNIQUE,
  avatar         BLOB,
  avatar_mime    TEXT,
  avatar_updated INTEGER,
  perm_send      INTEGER NOT NULL DEFAULT 1,
  perm_media     INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS group_members (
  group_id     INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  role         TEXT NOT NULL DEFAULT 'member',
  joined_at    INTEGER NOT NULL,
  last_read_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_members_user ON group_members(user_id);
CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id   INTEGER NOT NULL REFERENCES users(id),
  receiver_id INTEGER REFERENCES users(id),
  group_id    INTEGER,
  text        TEXT NOT NULL,
  file_id     TEXT,
  reply_to    INTEGER,
  service     TEXT,
  fwd_from    INTEGER,
  edited_at   INTEGER,
  created_at  INTEGER NOT NULL,
  read_at     INTEGER
);
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
  duration   INTEGER,
  waveform   TEXT,
  message_id INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS contacts (
  owner_id   INTEGER NOT NULL REFERENCES users(id),
  contact_id INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, contact_id)
);
CREATE TABLE IF NOT EXISTS announcements (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  text        TEXT NOT NULL,
  image       BLOB,
  image_mime  TEXT,
  dismissible INTEGER NOT NULL DEFAULT 0,
  created_by  INTEGER NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  ends_at     INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS blocks (
  blocker_id INTEGER NOT NULL REFERENCES users(id),
  blocked_id INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id)
);
`);

// ───────────── مهاجرت دیتابیس نسخه‌های قبلی (هیچ داده‌ای پاک نمی‌شود) ─────────────
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
  lastseen_privacy: "TEXT NOT NULL DEFAULT 'everyone'",
});
// تیک آبی قدیمی به سیستم جدید تیک‌ها منتقل می‌شود
if (!db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'badge')) {
  db.exec('ALTER TABLE users ADD COLUMN badge TEXT');
  db.exec("UPDATE users SET badge = 'blue' WHERE verified = 1");
}
addMissingColumns('users', { panel_role: 'TEXT' });
addMissingColumns('messages', { file_id: 'TEXT', reply_to: 'INTEGER', group_id: 'INTEGER', service: 'TEXT', fwd_from: 'INTEGER', edited_at: 'INTEGER' });
addMissingColumns('uploads', { duration: 'INTEGER', waveform: 'TEXT' });

// بازسازی جدول با تعریف جدید و انتقال کامل داده‌ها
function rebuildTable(table, createSql, cols) {
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(`BEGIN;
    ${createSql.replace(`CREATE TABLE ${table}`, `CREATE TABLE ${table}_new`)};
    INSERT INTO ${table}_new (${cols}) SELECT ${cols} FROM ${table};
    DROP TABLE ${table};
    ALTER TABLE ${table}_new RENAME TO ${table};
    COMMIT;`);
  db.exec('PRAGMA foreign_keys = ON');
}
const colInfo = (table, name) => db.prepare(`PRAGMA table_info(${table})`).all().find((c) => c.name === name);

// نسخه‌های قبلی ایمیل را اجباری داشتند
if (colInfo('users', 'email')?.notnull) {
  rebuildTable('users', `CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE COLLATE NOCASE,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE, display_name TEXT NOT NULL, password_hash TEXT NOT NULL,
      bio TEXT NOT NULL DEFAULT '', avatar BLOB, avatar_mime TEXT, avatar_updated INTEGER,
      verified INTEGER NOT NULL DEFAULT 0, banned INTEGER NOT NULL DEFAULT 0,
      lastseen_privacy TEXT NOT NULL DEFAULT 'everyone', badge TEXT, panel_role TEXT, last_seen INTEGER, created_at INTEGER NOT NULL)`,
  'id, email, username, display_name, password_hash, bio, avatar, avatar_mime, avatar_updated, verified, banned, lastseen_privacy, badge, panel_role, last_seen, created_at');
}
// پیام‌های گروه گیرنده‌ی مشخص ندارند؛ در نسخه‌های قبلی گیرنده اجباری بود
if (colInfo('messages', 'receiver_id')?.notnull) {
  rebuildTable('messages', `CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, sender_id INTEGER NOT NULL REFERENCES users(id),
      receiver_id INTEGER REFERENCES users(id), group_id INTEGER, text TEXT NOT NULL, file_id TEXT,
      reply_to INTEGER, service TEXT, fwd_from INTEGER, edited_at INTEGER, created_at INTEGER NOT NULL, read_at INTEGER)`,
  'id, sender_id, receiver_id, group_id, text, file_id, reply_to, service, fwd_from, edited_at, created_at, read_at');
}
db.exec(`
CREATE INDEX IF NOT EXISTS idx_msg_pair ON messages(sender_id, receiver_id, id);
CREATE INDEX IF NOT EXISTS idx_msg_recv ON messages(receiver_id, read_at);
CREATE INDEX IF NOT EXISTS idx_msg_group ON messages(group_id, id);
CREATE INDEX IF NOT EXISTS idx_msg_file ON messages(file_id);
`);
db.prepare('DELETE FROM sessions WHERE last_active < ?').run(Date.now() - SESSION_DAYS * 864e5);

// ستون‌های عکس (BLOB) را در کوئری‌های معمولی نمی‌خوانیم تا سبک بمانند
const USER_COLS = 'id, email, username, display_name, password_hash, bio, avatar_updated, verified, banned, lastseen_privacy, badge, panel_role, last_seen, created_at';
const GROUP_COLS = 'id, title, description, owner_id, invite_code, avatar_updated, perm_send, perm_media, created_at';
// پیام به همراه اطلاعات فایل پیوست‌شده
const MSG_SELECT = `SELECT m.*, f.name AS f_name, f.size AS f_size, f.mime AS f_mime, f.kind AS f_kind,
                           f.width AS f_w, f.height AS f_h, f.duration AS f_dur, f.waveform AS f_wave
                    FROM messages m LEFT JOIN uploads f ON f.id = m.file_id`;

const q = {
  userById: db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`),
  userByEmail: db.prepare(`SELECT ${USER_COLS} FROM users WHERE email = ?`),
  userByUsername: db.prepare(`SELECT ${USER_COLS} FROM users WHERE username = ?`),
  insertUser: db.prepare('INSERT INTO users (username, display_name, password_hash, created_at) VALUES (?, ?, ?, ?)'),
  updateProfile: db.prepare('UPDATE users SET display_name = ?, username = ?, bio = ? WHERE id = ?'),
  setPassword: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
  setBadge: db.prepare('UPDATE users SET badge = ? WHERE id = ?'),
  setPanelRole: db.prepare('UPDATE users SET panel_role = ? WHERE id = ?'),
  editMessage: db.prepare('UPDATE messages SET text = ?, edited_at = ? WHERE id = ?'),
  deleteMessage: db.prepare('DELETE FROM messages WHERE id = ?'),
  deleteReactionsOf: db.prepare('DELETE FROM reactions WHERE message_id = ?'),
  fileRefs: db.prepare('SELECT COUNT(*) AS c FROM messages WHERE file_id = ?'),
  deleteUpload: db.prepare('DELETE FROM uploads WHERE id = ?'),
  insertAnn: db.prepare(`INSERT INTO announcements (text, image, image_mime, dismissible, created_by, created_at, ends_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?)`),
  activeAnns: db.prepare(`SELECT id, text, image_mime, dismissible, created_at, ends_at FROM announcements
                          WHERE ends_at > ? ORDER BY created_at DESC LIMIT 10`),
  recentAnns: db.prepare(`SELECT id, text, image_mime, dismissible, created_by, created_at, ends_at FROM announcements
                          ORDER BY created_at DESC LIMIT 50`),
  annImage: db.prepare('SELECT image, image_mime FROM announcements WHERE id = ?'),
  endAnn: db.prepare('UPDATE announcements SET ends_at = ? WHERE id = ?'),
  deleteAnn: db.prepare('DELETE FROM announcements WHERE id = ?'),
  setBanned: db.prepare('UPDATE users SET banned = ? WHERE id = ?'),
  setPrivacy: db.prepare('UPDATE users SET lastseen_privacy = ? WHERE id = ?'),
  setAvatar: db.prepare('UPDATE users SET avatar = ?, avatar_mime = ?, avatar_updated = ? WHERE id = ?'),
  avatarById: db.prepare('SELECT avatar, avatar_mime FROM users WHERE id = ?'),
  searchUsers: db.prepare(`SELECT ${USER_COLS} FROM users WHERE username LIKE ? ESCAPE '\\' AND id != ? AND banned = 0
                           ORDER BY length(username), username LIMIT 20`),
  setLastSeen: db.prepare('UPDATE users SET last_seen = ? WHERE id = ?'),

  insertSession: db.prepare('INSERT INTO sessions (id, user_id, device, ip, created_at, last_active) VALUES (?, ?, ?, ?, ?, ?)'),
  sessionById: db.prepare('SELECT * FROM sessions WHERE id = ?'),
  sessionsOf: db.prepare('SELECT * FROM sessions WHERE user_id = ? ORDER BY last_active DESC'),
  touchSession: db.prepare('UPDATE sessions SET last_active = ? WHERE id = ?'),
  deleteSession: db.prepare('DELETE FROM sessions WHERE id = ?'),

  insertMessage: db.prepare(`INSERT INTO messages (sender_id, receiver_id, group_id, text, file_id, reply_to, service, created_at)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
  messageById: db.prepare(`${MSG_SELECT} WHERE m.id = ?`),
  // ذخیره/بازارسال: همان فایل دوباره استفاده می‌شود (فایل کپی نمی‌شود)
  insertForward: db.prepare(`INSERT INTO messages (sender_id, receiver_id, group_id, text, file_id, fwd_from, created_at)
                             VALUES (?, ?, ?, ?, ?, ?, ?)`),
  dmHistory: db.prepare(`${MSG_SELECT}
                         WHERE m.group_id IS NULL
                           AND ((m.sender_id = @me AND m.receiver_id = @peer) OR (m.sender_id = @peer AND m.receiver_id = @me))
                           AND m.id < @before
                         ORDER BY m.id DESC LIMIT @lim`),
  groupHistory: db.prepare(`${MSG_SELECT} WHERE m.group_id = @g AND m.id < @before ORDER BY m.id DESC LIMIT @lim`),
  dmLastMessages: db.prepare(`${MSG_SELECT} WHERE m.id IN (
                                SELECT MAX(id) FROM messages
                                WHERE group_id IS NULL AND (sender_id = @me OR receiver_id = @me)
                                GROUP BY CASE WHEN sender_id = @me THEN receiver_id ELSE sender_id END)
                              ORDER BY m.id DESC`),
  dmUnread: db.prepare(`SELECT sender_id, COUNT(*) AS c FROM messages
                        WHERE group_id IS NULL AND receiver_id = ? AND sender_id != receiver_id AND read_at IS NULL
                        GROUP BY sender_id`),
  markDmRead: db.prepare(`UPDATE messages SET read_at = ?
                          WHERE group_id IS NULL AND sender_id = ? AND receiver_id = ? AND read_at IS NULL`),
  groupLast: db.prepare(`${MSG_SELECT} WHERE m.id = (SELECT MAX(id) FROM messages WHERE group_id = ?)`),
  groupUnread: db.prepare(`SELECT COUNT(*) AS c FROM messages
                           WHERE group_id = ? AND id > ? AND sender_id != ? AND service IS NULL`),
  groupMaxId: db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM messages WHERE group_id = ?'),

  getReaction: db.prepare('SELECT emoji FROM reactions WHERE message_id = ? AND user_id = ?'),
  deleteReaction: db.prepare('DELETE FROM reactions WHERE message_id = ? AND user_id = ?'),
  upsertReaction: db.prepare(`INSERT INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)
                              ON CONFLICT(message_id, user_id) DO UPDATE SET emoji = excluded.emoji`),

  insertUpload: db.prepare(`INSERT INTO uploads (id, owner_id, name, size, mime, kind, width, height, duration, waveform, created_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  uploadById: db.prepare('SELECT * FROM uploads WHERE id = ?'),
  attachUpload: db.prepare('UPDATE uploads SET message_id = ? WHERE id = ?'),
  dmFileAccess: db.prepare('SELECT 1 FROM messages WHERE file_id = ? AND group_id IS NULL AND (sender_id = ? OR receiver_id = ?) LIMIT 1'),
  groupFileAccess: db.prepare(`SELECT 1 FROM messages m JOIN group_members gm ON gm.group_id = m.group_id
                               WHERE m.file_id = ? AND gm.user_id = ? LIMIT 1`),

  groupById: db.prepare(`SELECT ${GROUP_COLS} FROM groups WHERE id = ?`),
  groupByCode: db.prepare(`SELECT ${GROUP_COLS} FROM groups WHERE invite_code = ?`),
  insertGroup: db.prepare('INSERT INTO groups (title, description, owner_id, invite_code, created_at) VALUES (?, ?, ?, ?, ?)'),
  updateGroup: db.prepare('UPDATE groups SET title = ?, description = ?, perm_send = ?, perm_media = ? WHERE id = ?'),
  setGroupCode: db.prepare('UPDATE groups SET invite_code = ? WHERE id = ?'),
  setGroupAvatar: db.prepare('UPDATE groups SET avatar = ?, avatar_mime = ?, avatar_updated = ? WHERE id = ?'),
  groupAvatar: db.prepare('SELECT avatar, avatar_mime FROM groups WHERE id = ?'),
  deleteGroup: db.prepare('DELETE FROM groups WHERE id = ?'),
  deleteGroupMessages: db.prepare('DELETE FROM messages WHERE group_id = ?'),
  member: db.prepare('SELECT * FROM group_members WHERE group_id = ? AND user_id = ?'),
  members: db.prepare(`SELECT gm.role, gm.joined_at, u.id, u.username, u.display_name, u.bio, u.avatar_updated, u.verified,
                              u.banned, u.lastseen_privacy, u.last_seen, u.created_at
                       FROM group_members gm JOIN users u ON u.id = gm.user_id WHERE gm.group_id = ?
                       ORDER BY CASE gm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, gm.joined_at`),
  memberCount: db.prepare('SELECT COUNT(*) AS c FROM group_members WHERE group_id = ?'),
  myGroups: db.prepare('SELECT group_id, role, last_read_id FROM group_members WHERE user_id = ?'),
  addMember: db.prepare('INSERT INTO group_members (group_id, user_id, role, joined_at, last_read_id) VALUES (?, ?, ?, ?, ?)'),
  removeMember: db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?'),
  setRole: db.prepare('UPDATE group_members SET role = ? WHERE group_id = ? AND user_id = ?'),
  setLastRead: db.prepare('UPDATE group_members SET last_read_id = MAX(last_read_id, ?) WHERE group_id = ? AND user_id = ?'),
  othersReadUpTo: db.prepare('SELECT COALESCE(MAX(last_read_id), 0) AS id FROM group_members WHERE group_id = ? AND user_id != ?'),
  deleteMembers: db.prepare('DELETE FROM group_members WHERE group_id = ?'),

  contactsOf: db.prepare(`SELECT ${USER_COLS} FROM users WHERE id IN (SELECT contact_id FROM contacts WHERE owner_id = ?)`),
  isContact: db.prepare('SELECT 1 FROM contacts WHERE owner_id = ? AND contact_id = ?'),
  addContact: db.prepare('INSERT OR IGNORE INTO contacts (owner_id, contact_id, created_at) VALUES (?, ?, ?)'),
  removeContact: db.prepare('DELETE FROM contacts WHERE owner_id = ? AND contact_id = ?'),
  blocksOf: db.prepare(`SELECT ${USER_COLS} FROM users WHERE id IN (SELECT blocked_id FROM blocks WHERE blocker_id = ?)`),
  isBlocked: db.prepare('SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?'),
  addBlock: db.prepare('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)'),
  removeBlock: db.prepare('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?'),
};

// ───────────── کمکی‌ها ─────────────
const onlineCounts = new Map(); // userId -> تعداد تب‌های باز
// مالک (Owner) = اولین یوزرنیم در ADMIN_USERNAME؛ فقط یک نفر
const isOwner = (u) => !!u && !!ADMINS[0] && ADMINS[0] === String(u.username).toLowerCase();
// مدیر پنل: مالک، یوزرنیم‌های ADMIN_USERNAME، یا کسی که مالک از داخل پنل مدیر کرده
const isAdmin = (u) => !!u && (ADMINS.includes(String(u.username).toLowerCase()) || u.panel_role === 'admin');
const badgeOf = (u) => (BADGES.includes(u.badge) ? u.badge : isOwner(u) ? 'blue' : null);
const lastSeenHidden = (u) => u.lastseen_privacy === 'nobody';

const userInfo = (u) => ({
  id: u.id,
  username: u.username,
  displayName: u.display_name,
  badge: badgeOf(u),
  owner: isOwner(u),
  verified: !!badgeOf(u),
  bio: u.bio || '',
  avatar: u.avatar_updated ? `/api/avatar/${u.id}?v=${u.avatar_updated}` : null,
  // اگر کاربر «آخرین بازدید» را مخفی کرده باشد، فقط «اخیراً» نشان داده می‌شود
  online: lastSeenHidden(u) ? false : onlineCounts.has(u.id),
  lastSeen: lastSeenHidden(u) ? null : u.last_seen || null,
  recently: lastSeenHidden(u),
});
const meInfo = (u) => ({
  ...userInfo(u),
  online: true,
  recently: false,
  isAdmin: isAdmin(u),
  isOwner: isOwner(u),
  privacy: { lastSeen: u.lastseen_privacy || 'everyone' },
  createdAt: u.created_at,
});

const groupInfo = (g, member = null) => ({
  id: g.id,
  title: g.title,
  description: g.description || '',
  avatar: g.avatar_updated ? `/api/group-avatar/${g.id}?v=${g.avatar_updated}` : null,
  memberCount: q.memberCount.get(g.id).c,
  permSend: !!g.perm_send,
  permMedia: !!g.perm_media,
  createdAt: g.created_at,
  role: member ? member.role : null,
  // لینک دعوت فقط برای مدیران گروه
  inviteCode: member && member.role !== 'member' ? g.invite_code : null,
});

const parseJSON = (s, fallback = null) => {
  try { return s ? JSON.parse(s) : fallback; } catch { return fallback; }
};

const replyPreview = (r) => ({
  id: r.id,
  from: r.sender_id,
  kind: r.service ? 'service' : r.file_id ? r.f_kind : 'text',
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
  groupId: m.group_id || null,
  text: m.text,
  createdAt: m.created_at,
  readAt: m.read_at,
  reactions,
  kind: m.service ? 'service' : m.file_id ? m.f_kind : 'text',
  service: parseJSON(m.service),
  file: m.file_id
    ? {
        id: m.file_id, name: m.f_name, size: m.f_size, mime: m.f_mime, width: m.f_w, height: m.f_h,
        duration: m.f_dur, waveform: parseJSON(m.f_wave, []), url: `/api/files/${m.file_id}`,
      }
    : null,
  replyTo: m.reply_to ? replies[m.reply_to] || null : null,
  fwd: m.fwd_from ? fwdInfo(m.fwd_from) : null,
  editedAt: m.edited_at || null,
});

function fwdInfo(userId) {
  const u = q.userById.get(userId);
  return u ? { id: u.id, name: u.display_name, username: u.username } : { id: userId, name: 'کاربر حذف‌شده', username: null };
}

function reactionsFor(ids) {
  if (!ids.length) return {};
  const rows = db
    .prepare(`SELECT message_id, user_id, emoji FROM reactions WHERE message_id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids);
  const map = {};
  for (const r of rows) (map[r.message_id] ||= []).push({ userId: r.user_id, emoji: r.emoji });
  return map;
}

// شناسه‌ی گفتگو: u12 = پیوی با کاربر ۱۲ (u خودم = پیام‌های ذخیره‌شده)، g5 = گروه ۵
function parseChat(key) {
  const m = /^([ug])(\d+)$/.exec(String(key || ''));
  return m ? { type: m[1] === 'g' ? 'group' : 'user', id: Number(m[2]) } : null;
}

// آیا کاربر به این پیام دسترسی دارد؟
function canSeeMessage(m, userId) {
  if (m.group_id) return !!q.member.get(m.group_id, userId);
  return m.sender_id === userId || m.receiver_id === userId;
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
    if (!sid) return null;
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

// تصویر به‌صورت data URL که در مرورگر کوچک و مربعی شده
function parseAvatar(dataUrl) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) return { error: 'فرمت تصویر پشتیبانی نمی‌شود' };
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > AVATAR_MAX_BYTES) return { error: 'حجم تصویر بیش از حد مجاز است' };
  return { buf, mime: m[1] };
}

// ───────────── سرور ─────────────
const app = express();
const server = http.createServer(app);
// destroyUpgrade: false تا اتصال‌های WebSocket خود Next.js (در حالت توسعه) قطع نشوند
const io = new Server(server, { maxHttpBufferSize: 1e6, destroyUpgrade: false });
const nextApp = next({ dev, hostname: 'localhost', port: Number(PORT) });
const handleNext = nextApp.getRequestHandler();

app.set('trust proxy', 'loopback'); // پشت Caddy آی‌پی واقعی کاربر را بخوان

// آپلود عکس، فایل یا ویس (قبل از express.json تعریف می‌شود تا بدنه‌ی خام دریافت شود)
app.post('/api/upload', auth, express.raw({ type: () => true, limit: MAX_FILE_BYTES }), (req, res) => {
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ error: 'فایل خالی است' });

  const name = String(req.query.name || 'file').replace(/[\u0000-\u001f\u007f/\\]/g, '').trim().slice(0, 180) || 'file';
  const mime = (String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() || 'application/octet-stream').slice(0, 100);
  const int = (v, max) => {
    const n = parseInt(v, 10);
    return n > 0 && n <= max ? n : null;
  };
  let kind = 'file', width = null, height = null, duration = null, waveform = null;
  if (req.query.photo === '1' && PHOTO_MIMES.includes(mime)) {
    kind = 'image';
    width = int(req.query.w, 30000);
    height = int(req.query.h, 30000);
  } else if (req.query.video === '1' && VIDEO_MIMES.includes(mime)) {
    // ویدیو یا پیام ویدیویی دایره‌ای
    kind = req.query.note === '1' ? 'videonote' : 'video';
    width = int(req.query.w, 30000);
    height = int(req.query.h, 30000);
    duration = int(req.query.d, 36000);
  } else if (req.query.voice === '1' && AUDIO_MIMES.includes(mime)) {
    kind = 'voice';
    duration = int(req.query.d, 3600) || 1;
    const wave = String(req.query.wave || '').split(',').slice(0, 64).map((x) => Math.max(0, Math.min(31, parseInt(x, 10) || 0)));
    waveform = JSON.stringify(wave);
  }

  const id = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(UPLOAD_DIR, id), buf);
  q.insertUpload.run(id, req.user.id, name, buf.length, mime, kind, width, height, duration, waveform, Date.now());
  res.json({ id, name, size: buf.length, mime, kind });
});

app.use('/api', express.json({ limit: '3mb' }));

// دریافت فایل؛ فقط کسانی که پیام را دیده‌اند اجازه دارند
app.get('/api/files/:id', (req, res) => {
  const h = req.headers.authorization || '';
  const user = userFromToken(h.startsWith('Bearer ') ? h.slice(7) : String(req.query.t || ''));
  if (!user) return res.status(401).end();

  const id = String(req.params.id);
  if (!/^[a-f0-9]{32}$/.test(id)) return res.status(404).end();
  const f = q.uploadById.get(id);
  if (!f) return res.status(404).end();
  if (f.owner_id !== user.id && !q.dmFileAccess.get(id, user.id, user.id) && !q.groupFileAccess.get(id, user.id))
    return res.status(403).end();

  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': 'sandbox',
    'Cache-Control': 'private, max-age=31536000, immutable',
  });
  // فقط عکس و صدای امن داخل صفحه پخش می‌شوند؛ بقیه همیشه دانلود می‌شوند
  const inline = req.query.download !== '1' && ['image', 'voice', 'video', 'videonote'].includes(f.kind);
  if (inline) {
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

// ───────────── ثبت‌نام و ورود ─────────────
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

// ───────────── پروفایل من ─────────────
app.get('/api/me', auth, (req, res) => res.json(meInfo(req.user)));

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

  const same = q.userByUsername.get(data.username);
  if (same && same.id !== me.id) return res.status(409).json({ error: 'این یوزرنیم قبلاً گرفته شده', field: 'username' });
  try {
    q.updateProfile.run(data.displayName, data.username, data.bio, me.id);
  } catch {
    return res.status(409).json({ error: 'این یوزرنیم قبلاً گرفته شده', field: 'username' });
  }
  const updated = q.userById.get(me.id);
  io.emit('user:update', userInfo(updated));
  res.json(meInfo(updated));
});

app.put('/api/me/privacy', auth, (req, res) => {
  const v = req.body?.lastSeen === 'nobody' ? 'nobody' : 'everyone';
  q.setPrivacy.run(v, req.user.id);
  const updated = q.userById.get(req.user.id);
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

app.put('/api/me/avatar', auth, (req, res) => {
  const a = parseAvatar(req.body?.image);
  if (a.error) return res.status(400).json(a);
  q.setAvatar.run(a.buf, a.mime, Date.now(), req.user.id);
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

// کد QR لینک پروفایل یا گروه (SVG)
app.get('/api/qr', async (req, res) => {
  if (!QRCode) return res.status(501).json({ error: 'کد QR روی سرور فعال نیست' });
  const text = String(req.query.text || '').slice(0, 300);
  if (!text) return res.status(400).end();
  try {
    const svg = await QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    res.set('Cache-Control', 'public, max-age=86400').type('image/svg+xml').send(svg);
  } catch {
    res.status(500).end();
  }
});

// ───────────── کاربران، مخاطبین و مسدودی‌ها ─────────────
app.get('/api/users/search', auth, (req, res) => {
  const term = String(req.query.q || '').trim().replace(/^@/, '');
  if (!term) return res.json([]);
  const like = term.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
  res.json(q.searchUsers.all(like, req.user.id).map(userInfo));
});

const userForViewer = (u, viewerId) => ({
  ...userInfo(u),
  isContact: !!q.isContact.get(viewerId, u.id),
  blockedByMe: !!q.isBlocked.get(viewerId, u.id),
});

app.get('/api/users/by-username/:username', auth, (req, res) => {
  const u = q.userByUsername.get(String(req.params.username).replace(/^@/, ''));
  if (!u || u.banned) return res.status(404).json({ error: 'کاربری با این یوزرنیم پیدا نشد' });
  res.json(userForViewer(u, req.user.id));
});

app.get('/api/users/:id', auth, (req, res) => {
  const u = q.userById.get(Number(req.params.id));
  if (!u) return res.status(404).json({ error: 'کاربر پیدا نشد' });
  res.json(userForViewer(u, req.user.id));
});

app.get('/api/contacts', auth, (req, res) => res.json(q.contactsOf.all(req.user.id).map(userInfo)));

app.post('/api/contacts', auth, (req, res) => {
  const u = q.userById.get(Number(req.body?.userId));
  if (!u || u.id === req.user.id) return res.status(400).json({ error: 'کاربر نامعتبر است' });
  q.addContact.run(req.user.id, u.id, Date.now());
  res.json(userInfo(u));
});

app.delete('/api/contacts/:id', auth, (req, res) => {
  q.removeContact.run(req.user.id, Number(req.params.id));
  res.json({ ok: true });
});

app.get('/api/blocks', auth, (req, res) => res.json(q.blocksOf.all(req.user.id).map(userInfo)));

app.post('/api/blocks', auth, (req, res) => {
  const u = q.userById.get(Number(req.body?.userId));
  if (!u || u.id === req.user.id) return res.status(400).json({ error: 'کاربر نامعتبر است' });
  q.addBlock.run(req.user.id, u.id, Date.now());
  res.json({ ok: true });
});

app.delete('/api/blocks/:id', auth, (req, res) => {
  q.removeBlock.run(req.user.id, Number(req.params.id));
  res.json({ ok: true });
});

// ───────────── گفتگوها و پیام‌ها ─────────────
app.get('/api/chats', auth, (req, res) => {
  const me = req.user.id;
  const unread = Object.fromEntries(q.dmUnread.all(me).map((r) => [r.sender_id, r.c]));
  const chats = q.dmLastMessages.all({ me }).map((m) => {
    const peerId = m.sender_id === me ? m.receiver_id : m.sender_id;
    const peer = q.userById.get(peerId);
    return {
      key: 'u' + peerId,
      peer: peerId === me ? meInfo(peer) : userInfo(peer),
      last: formatMessage(m),
      unread: unread[peerId] || 0,
    };
  });
  for (const gm of q.myGroups.all(me)) {
    const g = q.groupById.get(gm.group_id);
    if (!g) continue;
    const last = q.groupLast.get(g.id);
    chats.push({
      key: 'g' + g.id,
      group: groupInfo(g, gm),
      last: last ? formatMessage(last) : null,
      unread: q.groupUnread.get(g.id, gm.last_read_id, me).c,
      readUpTo: q.othersReadUpTo.get(g.id, me).id,
    });
  }
  res.json(chats);
});

app.get('/api/history', auth, (req, res) => {
  const chat = parseChat(req.query.chat);
  if (!chat) return res.status(400).json({ error: 'گفتگو نامعتبر است' });
  const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
  let rows, extra = {};
  if (chat.type === 'user') {
    rows = q.dmHistory.all({ me: req.user.id, peer: chat.id, before, lim: PAGE_SIZE + 1 });
  } else {
    if (!q.member.get(chat.id, req.user.id)) return res.status(403).json({ error: 'عضو این گروه نیستید' });
    rows = q.groupHistory.all({ g: chat.id, before, lim: PAGE_SIZE + 1 });
    extra.readUpTo = q.othersReadUpTo.get(chat.id, req.user.id).id;
  }
  const hasMore = rows.length > PAGE_SIZE;
  const page = rows.slice(0, PAGE_SIZE).reverse();
  const rx = reactionsFor(page.map((m) => m.id));
  const replies = repliesFor(page);
  // اطلاعات فرستنده‌ها (برای نمایش نام در گروه)
  const senders = {};
  if (chat.type === 'group')
    for (const id of new Set(page.map((m) => m.sender_id))) {
      const u = q.userById.get(id);
      if (u) senders[id] = userInfo(u);
    }
  res.json({ messages: page.map((m) => formatMessage(m, rx[m.id] || [], replies)), hasMore, senders, ...extra });
});

// ───────────── گروه‌ها ─────────────
const newInviteCode = () => crypto.randomBytes(9).toString('base64url');

function requireMember(req, res, roles = null) {
  const g = q.groupById.get(Number(req.params.id));
  if (!g) { res.status(404).json({ error: 'گروه پیدا نشد' }); return {}; }
  const member = q.member.get(g.id, req.user.id);
  if (!member) { res.status(403).json({ error: 'عضو این گروه نیستید' }); return {}; }
  if (roles && !roles.includes(member.role)) { res.status(403).json({ error: 'فقط مدیران گروه این دسترسی را دارند' }); return {}; }
  return { g, member };
}

// پیام سیستمی مثل «X به گروه پیوست»
function postService(groupId, actorId, action, extra = {}) {
  const info = q.insertMessage.run(actorId, null, groupId, '', null, null, JSON.stringify({ action, ...extra }), Date.now());
  const row = q.messageById.get(Number(info.lastInsertRowid));
  io.to('g:' + groupId).emit('message:new', { ...formatMessage(row), sender: userInfo(q.userById.get(actorId)) });
}

const groupChanged = (groupId) => io.to('g:' + groupId).emit('group:update', { groupId });

function joinRoom(userId, groupId) {
  io.in('u:' + userId).socketsJoin('g:' + groupId);
}
function leaveRoom(userId, groupId, reason) {
  io.in('u:' + userId).socketsLeave('g:' + groupId);
  io.to('u:' + userId).emit('group:removed', { groupId, reason });
}

function addToGroup(g, userId, role = 'member') {
  q.addMember.run(g.id, userId, role, Date.now(), q.groupMaxId.get(g.id).id);
  joinRoom(userId, g.id);
}

app.post('/api/groups', auth, (req, res) => {
  const title = String(req.body?.title || '').trim();
  const description = String(req.body?.description || '').trim();
  if (!title || [...title].length > GROUP_TITLE_MAX) return res.status(400).json({ error: 'نام گروه باید بین ۱ تا ۶۴ کاراکتر باشد' });
  if ([...description].length > GROUP_DESC_MAX) return res.status(400).json({ error: 'توضیحات گروه بیش از حد طولانی است' });
  const usernames = Array.isArray(req.body?.members) ? req.body.members.slice(0, MAX_GROUP_MEMBERS - 1) : [];

  const info = q.insertGroup.run(title, description, req.user.id, newInviteCode(), Date.now());
  const g = q.groupById.get(Number(info.lastInsertRowid));
  addToGroup(g, req.user.id, 'owner');
  postService(g.id, req.user.id, 'create', { title });
  for (const un of usernames) {
    const u = q.userByUsername.get(String(un).replace(/^@/, ''));
    if (!u || u.banned || u.id === req.user.id || q.member.get(g.id, u.id)) continue;
    if (q.isBlocked.get(u.id, req.user.id)) continue; // کسی که شما را مسدود کرده اضافه نمی‌شود
    addToGroup(g, u.id);
    postService(g.id, req.user.id, 'add', { target: u.id, targetName: u.display_name });
  }
  res.json(groupInfo(g, q.member.get(g.id, req.user.id)));
});

app.get('/api/groups/:id', auth, (req, res) => {
  const { g, member } = requireMember(req, res);
  if (!g) return;
  const members = q.members.all(g.id).map((m) => ({ ...userInfo(m), role: m.role, joinedAt: m.joined_at }));
  res.json({ ...groupInfo(g, member), members });
});

app.put('/api/groups/:id', auth, (req, res) => {
  const { g } = requireMember(req, res, ['owner', 'admin']);
  if (!g) return;
  const b = req.body || {};
  const title = b.title !== undefined ? String(b.title).trim() : g.title;
  const description = b.description !== undefined ? String(b.description).trim() : g.description;
  if (!title || [...title].length > GROUP_TITLE_MAX) return res.status(400).json({ error: 'نام گروه باید بین ۱ تا ۶۴ کاراکتر باشد' });
  if ([...description].length > GROUP_DESC_MAX) return res.status(400).json({ error: 'توضیحات گروه بیش از حد طولانی است' });
  const permSend = b.permSend !== undefined ? (b.permSend ? 1 : 0) : g.perm_send;
  const permMedia = b.permMedia !== undefined ? (b.permMedia ? 1 : 0) : g.perm_media;
  q.updateGroup.run(title, description, permSend, permMedia, g.id);
  if (title !== g.title) postService(g.id, req.user.id, 'title', { title });
  groupChanged(g.id);
  res.json({ ok: true });
});

app.put('/api/groups/:id/avatar', auth, (req, res) => {
  const { g } = requireMember(req, res, ['owner', 'admin']);
  if (!g) return;
  const a = parseAvatar(req.body?.image);
  if (a.error) return res.status(400).json(a);
  q.setGroupAvatar.run(a.buf, a.mime, Date.now(), g.id);
  postService(g.id, req.user.id, 'photo');
  groupChanged(g.id);
  res.json({ ok: true });
});

app.delete('/api/groups/:id/avatar', auth, (req, res) => {
  const { g } = requireMember(req, res, ['owner', 'admin']);
  if (!g) return;
  q.setGroupAvatar.run(null, null, null, g.id);
  groupChanged(g.id);
  res.json({ ok: true });
});

app.get('/api/group-avatar/:id', (req, res) => {
  const row = q.groupAvatar.get(Number(req.params.id));
  if (!row || !row.avatar) return res.status(404).end();
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.type(row.avatar_mime || 'image/jpeg').send(Buffer.from(row.avatar));
});

// ساخت لینک دعوت جدید (لینک قبلی باطل می‌شود)
app.post('/api/groups/:id/invite/reset', auth, (req, res) => {
  const { g } = requireMember(req, res, ['owner', 'admin']);
  if (!g) return;
  const code = newInviteCode();
  q.setGroupCode.run(code, g.id);
  groupChanged(g.id);
  res.json({ inviteCode: code });
});

// افزودن عضو با یوزرنیم (فقط مدیران)
app.post('/api/groups/:id/members', auth, (req, res) => {
  const { g } = requireMember(req, res, ['owner', 'admin']);
  if (!g) return;
  const u = q.userByUsername.get(String(req.body?.username || '').trim().replace(/^@/, ''));
  if (!u || u.banned) return res.status(404).json({ error: 'کاربری با این یوزرنیم پیدا نشد' });
  if (q.member.get(g.id, u.id)) return res.status(409).json({ error: 'این کاربر از قبل عضو گروه است' });
  if (q.memberCount.get(g.id).c >= MAX_GROUP_MEMBERS) return res.status(400).json({ error: `ظرفیت گروه (${MAX_GROUP_MEMBERS.toLocaleString('fa-IR')} نفر) تکمیل است` });
  if (q.isBlocked.get(u.id, req.user.id)) return res.status(403).json({ error: 'امکان افزودن این کاربر وجود ندارد' });
  addToGroup(g, u.id);
  postService(g.id, req.user.id, 'add', { target: u.id, targetName: u.display_name });
  groupChanged(g.id);
  res.json({ ok: true });
});

// حذف عضو (مدیران) یا ترک گروه (خود کاربر)
app.delete('/api/groups/:id/members/:userId', auth, (req, res) => {
  const { g, member } = requireMember(req, res);
  if (!g) return;
  const targetId = Number(req.params.userId);
  const target = q.member.get(g.id, targetId);
  if (!target) return res.status(404).json({ error: 'این کاربر عضو گروه نیست' });

  if (targetId === req.user.id) {
    if (member.role === 'owner') return res.status(400).json({ error: 'سازنده‌ی گروه نمی‌تواند گروه را ترک کند؛ گروه را حذف کنید یا مالکیت را منتقل کنید' });
    q.removeMember.run(g.id, targetId);
    leaveRoom(targetId, g.id, 'left');
    postService(g.id, targetId, 'leave');
  } else {
    if (member.role === 'member') return res.status(403).json({ error: 'فقط مدیران گروه می‌توانند عضو حذف کنند' });
    if (target.role === 'owner' || (target.role === 'admin' && member.role !== 'owner'))
      return res.status(403).json({ error: 'این عضو را نمی‌توانید حذف کنید' });
    const u = q.userById.get(targetId);
    q.removeMember.run(g.id, targetId);
    leaveRoom(targetId, g.id, 'kicked');
    postService(g.id, req.user.id, 'kick', { target: targetId, targetName: u?.display_name || '' });
  }
  groupChanged(g.id);
  res.json({ ok: true });
});

// تغییر نقش: مدیران می‌توانند عضو عادی را مدیر کنند؛ برداشتن مدیریت و انتقال مالکیت فقط با سازنده
app.post('/api/groups/:id/members/:userId/role', auth, (req, res) => {
  const { g, member } = requireMember(req, res, ['owner', 'admin']);
  if (!g) return;
  const targetId = Number(req.params.userId);
  const target = q.member.get(g.id, targetId);
  if (!target || targetId === req.user.id) return res.status(400).json({ error: 'عضو نامعتبر است' });
  const role = req.body?.role;
  const ownerOnly = (role !== 'admin' || target.role !== 'member');
  if (ownerOnly && member.role !== 'owner') return res.status(403).json({ error: 'فقط سازنده‌ی گروه این دسترسی را دارد' });
  if (role === 'owner') {
    q.setRole.run('owner', g.id, targetId);
    q.setRole.run('admin', g.id, req.user.id);
    db.prepare('UPDATE groups SET owner_id = ? WHERE id = ?').run(targetId, g.id);
  } else if (role === 'admin' || role === 'member') {
    if (target.role === 'owner') return res.status(403).json({ error: 'نقش سازنده را نمی‌شود تغییر داد' });
    q.setRole.run(role, g.id, targetId);
    if (role === 'admin') {
      const u = q.userById.get(targetId);
      postService(g.id, req.user.id, 'promote', { target: targetId, targetName: u?.display_name || '' });
    }
  } else return res.status(400).json({ error: 'نقش نامعتبر است' });
  groupChanged(g.id);
  res.json({ ok: true });
});

app.delete('/api/groups/:id', auth, (req, res) => {
  const { g } = requireMember(req, res, ['owner']);
  if (!g) return;
  const memberIds = q.members.all(g.id).map((m) => m.id);
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM reactions WHERE message_id IN (SELECT id FROM messages WHERE group_id = ?)').run(g.id);
    q.deleteGroupMessages.run(g.id);
    q.deleteMembers.run(g.id);
    q.deleteGroup.run(g.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  for (const uid of memberIds) leaveRoom(uid, g.id, 'deleted');
  res.json({ ok: true });
});

// پیش‌نمایش و پیوستن با لینک دعوت
app.get('/api/join/:code', auth, (req, res) => {
  const g = q.groupByCode.get(String(req.params.code));
  if (!g) return res.status(404).json({ error: 'این لینک دعوت معتبر نیست یا باطل شده' });
  res.json({ ...groupInfo(g), isMember: !!q.member.get(g.id, req.user.id) });
});

app.post('/api/join/:code', auth, (req, res) => {
  const g = q.groupByCode.get(String(req.params.code));
  if (!g) return res.status(404).json({ error: 'این لینک دعوت معتبر نیست یا باطل شده' });
  if (!q.member.get(g.id, req.user.id)) {
    if (q.memberCount.get(g.id).c >= MAX_GROUP_MEMBERS) return res.status(400).json({ error: 'ظرفیت این گروه تکمیل است' });
    addToGroup(g, req.user.id);
    postService(g.id, req.user.id, 'join');
    groupChanged(g.id);
  }
  res.json(groupInfo(g, q.member.get(g.id, req.user.id)));
});

// ───────────── پنل مدیریت ─────────────
// مدیر آمار، کاربران، دستگاه‌ها و ورودها را می‌بیند؛ متن پیام‌های خصوصی نمایش داده نمی‌شود.
const adminQ = {
  count: (sql, ...a) => db.prepare(sql).get(...a).c,
  users: db.prepare(`SELECT ${USER_COLS},
      (SELECT COUNT(*) FROM messages m WHERE m.sender_id = u.id AND m.service IS NULL) AS msg_count,
      (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id) AS dev_count
    FROM users u WHERE username LIKE @q ESCAPE '\\' OR display_name LIKE @q ESCAPE '\\'
    ORDER BY created_at DESC LIMIT 300`),
  recentLogins: db.prepare('SELECT created_at, device, ip, user_id FROM sessions ORDER BY created_at DESC LIMIT 25'),
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
    messagesToday: adminQ.count('SELECT COUNT(*) AS c FROM messages WHERE created_at >= ? AND service IS NULL', t),
    totalMessages: adminQ.count('SELECT COUNT(*) AS c FROM messages WHERE service IS NULL'),
    totalGroups: adminQ.count('SELECT COUNT(*) AS c FROM groups'),
    activeAnnouncements: adminQ.count('SELECT COUNT(*) AS c FROM announcements WHERE ends_at > ?', Date.now()),
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
    online: onlineCounts.has(u.id),
    lastSeen: u.last_seen || null,
    recently: false,
    isAdmin: isAdmin(u),
    isOwner: isOwner(u),
    panelAdmin: u.panel_role === 'admin',
    banned: !!u.banned,
    createdAt: u.created_at,
    messages: u.msg_count,
    devices: u.dev_count,
  })));
});

// مدیرها نمی‌توانند روی مالک یا مدیرهای دیگر کار کنند؛ فقط مالک این اجازه را دارد
function adminTarget(req, res) {
  const u = q.userById.get(Number(req.params.id));
  if (!u) { res.status(404).json({ error: 'کاربر پیدا نشد' }); return null; }
  if (isOwner(u) && !isOwner(req.user)) { res.status(403).json({ error: 'روی حساب مالک نمی‌شود این کار را کرد' }); return null; }
  if (isAdmin(u) && u.id !== req.user.id && !isOwner(req.user)) { res.status(403).json({ error: 'فقط مالک می‌تواند مدیرهای دیگر را مدیریت کند' }); return null; }
  return u;
}

// تیک رسمی: آبی، مشکی، سفید یا بدون تیک
app.post('/api/admin/users/:id/badge', auth, adminOnly, (req, res) => {
  const u = adminTarget(req, res);
  if (!u) return;
  const badge = BADGES.includes(req.body?.badge) ? req.body.badge : null;
  q.setBadge.run(badge, u.id);
  io.emit('user:update', userInfo(q.userById.get(u.id)));
  res.json({ ok: true });
});

// دسترسی پنل مدیریت (فقط مالک)
app.post('/api/admin/users/:id/panel', auth, adminOnly, (req, res) => {
  if (!isOwner(req.user)) return res.status(403).json({ error: 'فقط مالک می‌تواند مدیر پنل تعیین کند' });
  const u = q.userById.get(Number(req.params.id));
  if (!u || isOwner(u)) return res.status(400).json({ error: 'کاربر نامعتبر است' });
  q.setPanelRole.run(req.body?.admin ? 'admin' : null, u.id);
  io.to('u:' + u.id).emit('me:refresh');
  res.json({ ok: true });
});

// ───── اطلاعیه‌ها و تبلیغات سنجاق‌شده ─────
const annInfo = (a) => ({
  id: a.id, text: a.text, dismissible: !!a.dismissible, createdAt: a.created_at, endsAt: a.ends_at,
  image: a.image_mime ? `/api/ann-image/${a.id}?v=${a.created_at}` : null,
});

app.get('/api/announcements', auth, (req, res) => res.json(q.activeAnns.all(Date.now()).map(annInfo)));

app.get('/api/ann-image/:id', (req, res) => {
  const row = q.annImage.get(Number(req.params.id));
  if (!row || !row.image) return res.status(404).end();
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.type(row.image_mime).send(Buffer.from(row.image));
});

app.get('/api/admin/announcements', auth, adminOnly, (req, res) => {
  res.json(q.recentAnns.all().map((a) => ({ ...annInfo(a), by: userInfo(q.userById.get(a.created_by) || { id: 0, username: '', display_name: '' }) })));
});

app.post('/api/admin/announcements', auth, adminOnly, (req, res) => {
  const text = String(req.body?.text || '').trim();
  const hours = Math.max(1, Math.min(24 * 90, Number(req.body?.hours) || 24));
  if (!text && !req.body?.image) return res.status(400).json({ error: 'متن یا عکس اطلاعیه را وارد کنید' });
  if (text.length > 2000) return res.status(400).json({ error: 'متن اطلاعیه حداکثر ۲۰۰۰ کاراکتر است' });
  let buf = null, mime = null;
  if (req.body?.image) {
    const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body.image));
    if (!m) return res.status(400).json({ error: 'فرمت تصویر پشتیبانی نمی‌شود' });
    buf = Buffer.from(m[2], 'base64');
    mime = m[1];
    if (buf.length > 2 * 1024 * 1024) return res.status(400).json({ error: 'حجم تصویر اطلاعیه زیاد است' });
  }
  const now = Date.now();
  q.insertAnn.run(text, buf, mime, req.body?.dismissible ? 1 : 0, req.user.id, now, now + hours * 3600e3);
  io.emit('announce:update');
  res.json({ ok: true });
});

app.post('/api/admin/announcements/:id/end', auth, adminOnly, (req, res) => {
  q.endAnn.run(Date.now(), Number(req.params.id));
  io.emit('announce:update');
  res.json({ ok: true });
});

app.delete('/api/admin/announcements/:id', auth, adminOnly, (req, res) => {
  q.deleteAnn.run(Number(req.params.id));
  io.emit('announce:update');
  res.json({ ok: true });
});

app.post('/api/admin/users/:id/ban', auth, adminOnly, (req, res) => {
  const u = adminTarget(req, res);
  if (!u) return;
  if (isOwner(u) || u.id === req.user.id) return res.status(400).json({ error: 'این حساب را نمی‌شود مسدود کرد' });
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

// API ناشناخته
app.all('/api/*', (req, res) => res.status(404).json({ error: 'مسیر پیدا نشد' }));

// خطای حجم زیاد و بدنه‌ی نامعتبر را به‌صورت JSON برگردان
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'حجم فایل بیشتر از ۵۰ مگابایت است' });
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

const inDm = (m, a, b) => !m.group_id && ((m.sender_id === a && m.receiver_id === b) || (m.sender_id === b && m.receiver_id === a));

io.on('connection', (socket) => {
  const myId = socket.userId;
  socket.join('u:' + myId);
  socket.join('s:' + socket.sid);
  for (const gm of q.myGroups.all(myId)) socket.join('g:' + gm.group_id);

  const count = (onlineCounts.get(myId) || 0) + 1;
  onlineCounts.set(myId, count);
  const meRow = q.userById.get(myId);
  if (count === 1 && !lastSeenHidden(meRow)) io.emit('presence', { userId: myId, online: true });

  socket.on('message:send', (payload = {}, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const chat = parseChat(payload.chat);
    const text = String(payload.text || '').trim();
    const fileId = payload.fileId ? String(payload.fileId) : null;
    const replyTo = payload.replyTo ? Number(payload.replyTo) : null;
    if (!chat) return reply({ error: 'گفتگو نامعتبر است' });
    if (!text && !fileId) return reply({ error: 'پیام خالی است' });
    if (text.length > 4000) return reply({ error: 'پیام نباید بیشتر از ۴۰۰۰ کاراکتر باشد' });

    let receiverId = null, groupId = null, member = null;
    if (chat.type === 'user') {
      const peer = q.userById.get(chat.id);
      if (!peer) return reply({ error: 'کاربر پیدا نشد' });
      if (chat.id !== myId) {
        if (q.isBlocked.get(myId, chat.id)) return reply({ error: 'این کاربر را مسدود کرده‌اید؛ اول از مسدودی خارجش کنید' });
        if (q.isBlocked.get(chat.id, myId)) return reply({ error: 'امکان ارسال پیام به این کاربر وجود ندارد' });
      }
      receiverId = chat.id;
    } else {
      const g = q.groupById.get(chat.id);
      member = g && q.member.get(g.id, myId);
      if (!member) return reply({ error: 'عضو این گروه نیستید' });
      if (member.role === 'member' && !g.perm_send) return reply({ error: 'در این گروه فقط مدیران می‌توانند پیام بفرستند' });
      if (member.role === 'member' && fileId && !g.perm_media) return reply({ error: 'ارسال رسانه در این گروه بسته است' });
      groupId = g.id;
    }

    if (fileId) {
      const up = q.uploadById.get(fileId);
      if (!up || up.owner_id !== myId || up.message_id) return reply({ error: 'فایل پیدا نشد یا قبلاً ارسال شده' });
    }
    if (replyTo) {
      const target = q.messageById.get(replyTo);
      const ok = target && (groupId ? target.group_id === groupId : inDm(target, myId, receiverId));
      if (!ok) return reply({ error: 'پیامی که به آن پاسخ می‌دهید پیدا نشد' });
    }

    const info = q.insertMessage.run(myId, receiverId, groupId, text, fileId, replyTo, null, Date.now());
    const id = Number(info.lastInsertRowid);
    if (fileId) q.attachUpload.run(id, fileId);
    if (groupId) q.setLastRead.run(id, groupId, myId);

    const row = q.messageById.get(id);
    const msg = { ...formatMessage(row, [], repliesFor([row])), sender: userInfo(q.userById.get(myId)) };
    if (groupId) io.to('g:' + groupId).emit('message:new', msg);
    else io.to('u:' + myId).to('u:' + receiverId).emit('message:new', { ...msg, recipient: userInfo(q.userById.get(receiverId)) });
    reply({ ok: true, id });
  });

  // بررسی اجازه‌ی ارسال در یک گفتگو (پیوی، پیام‌های ذخیره‌شده یا گروه)
  function sendTarget(chat, withFile) {
    if (!chat) return { error: 'گفتگو نامعتبر است' };
    if (chat.type === 'user') {
      if (!q.userById.get(chat.id)) return { error: 'کاربر پیدا نشد' };
      if (chat.id !== myId) {
        if (q.isBlocked.get(myId, chat.id)) return { error: 'این کاربر را مسدود کرده‌اید؛ اول از مسدودی خارجش کنید' };
        if (q.isBlocked.get(chat.id, myId)) return { error: 'امکان ارسال پیام به این کاربر وجود ندارد' };
      }
      return { receiverId: chat.id, groupId: null };
    }
    const g = q.groupById.get(chat.id);
    const member = g && q.member.get(g.id, myId);
    if (!member) return { error: 'عضو این گروه نیستید' };
    if (member.role === 'member' && !g.perm_send) return { error: 'در این گروه فقط مدیران می‌توانند پیام بفرستند' };
    if (member.role === 'member' && withFile && !g.perm_media) return { error: 'ارسال رسانه در این گروه بسته است' };
    return { receiverId: null, groupId: g.id };
  }

  // پخش پیام جدید برای همه‌ی کسانی که باید ببینند
  function broadcastNew(row) {
    const msg = { ...formatMessage(row, [], repliesFor([row])), sender: userInfo(q.userById.get(row.sender_id)) };
    if (row.group_id) io.to('g:' + row.group_id).emit('message:new', msg);
    else io.to('u:' + row.sender_id).to('u:' + row.receiver_id).emit('message:new', { ...msg, recipient: userInfo(q.userById.get(row.receiver_id)) });
  }

  // مخاطبان یک پیام موجود (برای ویرایش و حذف)
  const audience = (m) => (m.group_id ? io.to('g:' + m.group_id) : io.to('u:' + m.sender_id).to('u:' + m.receiver_id));

  // فوروارد هر نوع پیام به پیوی، گروه یا پیام‌های ذخیره‌شده
  function forward(messageId, chatKey, reply) {
    const m = q.messageById.get(Number(messageId));
    if (!m || m.service || !canSeeMessage(m, myId)) return reply({ error: 'این پیام پیدا نشد' });
    const chat = parseChat(chatKey);
    const t = sendTarget(chat, !!m.file_id);
    if (t.error) return reply(t);
    const toSelf = chat.type === 'user' && chat.id === myId;
    const origin = m.fwd_from || (m.sender_id !== myId ? m.sender_id : toSelf ? null : myId);
    const info = q.insertForward.run(myId, t.receiverId, t.groupId, m.text, m.file_id, origin, Date.now());
    const row = q.messageById.get(Number(info.lastInsertRowid));
    if (t.groupId) q.setLastRead.run(row.id, t.groupId, myId);
    broadcastNew(row);
    reply({ ok: true, id: row.id });
  }

  socket.on('message:forward', ({ messageId, chat } = {}, ack) => forward(messageId, chat, typeof ack === 'function' ? ack : () => {}));
  socket.on('message:save', ({ messageId } = {}, ack) => forward(messageId, 'u' + myId, typeof ack === 'function' ? ack : () => {}));

  // ویرایش پیام (فقط فرستنده)
  socket.on('message:edit', ({ messageId, text } = {}, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const m = q.messageById.get(Number(messageId));
    if (!m || m.service || m.sender_id !== myId) return reply({ error: 'این پیام را نمی‌توانید ویرایش کنید' });
    if (m.fwd_from && !(m.receiver_id === myId && !m.group_id)) return reply({ error: 'پیام بازارسال‌شده قابل ویرایش نیست' });
    const t = String(text || '').trim();
    if (!t && !m.file_id) return reply({ error: 'متن پیام نمی‌تواند خالی باشد' });
    if (t.length > 4000) return reply({ error: 'پیام نباید بیشتر از ۴۰۰۰ کاراکتر باشد' });
    const now = Date.now();
    q.editMessage.run(t, now, m.id);
    audience(m).emit('message:edited', { messageId: m.id, text: t, editedAt: now });
    reply({ ok: true });
  });

  // حذف پیام برای همه: فرستنده؛ در پیوی هر دو طرف؛ در گروه مدیران هم
  socket.on('message:delete', ({ messageId } = {}, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const m = q.messageById.get(Number(messageId));
    if (!m || !canSeeMessage(m, myId)) return reply({ error: 'این پیام پیدا نشد' });
    let allowed = m.sender_id === myId;
    if (!m.group_id) allowed = true; // پیوی و پیام‌های ذخیره‌شده
    else if (!allowed) allowed = ['owner', 'admin'].includes(q.member.get(m.group_id, myId)?.role);
    if (!allowed) return reply({ error: 'فقط مدیران گروه می‌توانند پیام دیگران را حذف کنند' });
    q.deleteReactionsOf.run(m.id);
    q.deleteMessage.run(m.id);
    // اگر فایل در هیچ پیام دیگری استفاده نشده، از سرور هم پاک می‌شود
    if (m.file_id && !q.fileRefs.get(m.file_id).c) {
      q.deleteUpload.run(m.file_id);
      fs.rm(path.join(UPLOAD_DIR, m.file_id), () => {});
    }
    audience(m).emit('message:deleted', { messageId: m.id });
    reply({ ok: true });
  });

  socket.on('reaction:toggle', ({ messageId, emoji } = {}) => {
    if (!ALLOWED_REACTIONS.includes(emoji)) return;
    const m = q.messageById.get(Number(messageId));
    if (!m || m.service || !canSeeMessage(m, myId)) return;

    const existing = q.getReaction.get(m.id, myId);
    if (existing && existing.emoji === emoji) q.deleteReaction.run(m.id, myId);
    else q.upsertReaction.run(m.id, myId, emoji);

    const reactions = reactionsFor([m.id])[m.id] || [];
    const target = m.group_id ? io.to('g:' + m.group_id) : io.to('u:' + m.sender_id).to('u:' + m.receiver_id);
    target.emit('reaction:update', { messageId: m.id, reactions });
  });

  // وضعیت فعالیت: در حال نوشتن / ارسال عکس / ارسال فایل / ضبط صدا
  socket.on('typing', ({ chat, action } = {}) => {
    const c = parseChat(chat);
    if (!c || !TYPING_ACTIONS.includes(action || 'typing')) return;
    const data = { from: myId, action: action || 'typing' };
    if (c.type === 'user') {
      if (c.id !== myId) socket.to('u:' + c.id).emit('typing', { ...data, chat: 'u' + myId });
    } else if (q.member.get(c.id, myId)) {
      socket.to('g:' + c.id).emit('typing', { ...data, chat: 'g' + c.id });
    }
  });

  socket.on('chat:read', ({ chat } = {}) => {
    const c = parseChat(chat);
    if (!c) return;
    if (c.type === 'user') {
      if (c.id === myId) return;
      const r = q.markDmRead.run(Date.now(), c.id, myId);
      if (r.changes) io.to('u:' + c.id).emit('messages:read', { chat: 'u' + myId });
    } else {
      if (!q.member.get(c.id, myId)) return;
      const upTo = q.groupMaxId.get(c.id).id;
      q.setLastRead.run(upTo, c.id, myId);
      socket.to('g:' + c.id).emit('group:read', { groupId: c.id, userId: myId, upTo });
    }
  });

  socket.on('disconnect', () => {
    const n = (onlineCounts.get(myId) || 1) - 1;
    if (n > 0) return onlineCounts.set(myId, n);
    onlineCounts.delete(myId);
    const ts = Date.now();
    q.setLastSeen.run(ts, myId);
    const u = q.userById.get(myId);
    if (u && !lastSeenHidden(u)) io.emit('presence', { userId: myId, online: false, lastSeen: ts });
  });
});

// بقیه‌ی درخواست‌ها (صفحه‌ها، فایل‌های استاتیک، manifest و service worker) را Next.js پاسخ می‌دهد
app.all('*', (req, res) => handleNext(req, res));

// ارتقای WebSocket: مسیر /socket.io برای چت، بقیه برای Next.js (بارگذاری مجدد زنده در حالت توسعه)
server.on('upgrade', (req, socket, head) => {
  if (req.url.startsWith('/socket.io')) return;
  nextApp.getUpgradeHandler?.()(req, socket, head);
});

nextApp.prepare().then(() => server.listen(PORT, () => {
  console.log(`${APP_NAME} روی http://localhost:${PORT} اجرا شد`);
  console.log(ADMINS.length ? `مدیر: @${ADMINS.join(', @')}` : 'ⓘ برای فعال شدن پنل مدیریت، ADMIN_USERNAME را تنظیم کنید.');
  if (!QRCode) console.log('ⓘ بسته‌ی qrcode نصب نیست؛ کد QR غیرفعال است (npm install).');
  console.log(dev ? 'حالت توسعه (development)' : 'حالت اجرا (production)');
}));
