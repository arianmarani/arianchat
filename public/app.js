'use strict';

const $ = (s) => document.querySelector(s);
const QUICK_REACTION = '👍';
const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥', '👏', '🎉'];
const AVATAR_COLORS = ['#e17076', '#f0a35e', '#9d84f2', '#5fbf7f', '#4fbcc4', '#6a9ee8', '#e979b3'];
const isTouch = matchMedia('(hover: none)').matches;
const MAX_FILE = 20 * 1024 * 1024; // ۲۰ مگابایت

// ───────────── تنظیمات ظاهر (روی همین دستگاه ذخیره می‌شود) ─────────────
const THEMES = {
  lavender: { label: 'یاسی', h: 254, s: 88, bh: 258, ch: 258 },
  classic: { label: 'کلاسیک', h: 211, s: 85, bh: 105, ch: 78 },
  ocean: { label: 'اقیانوسی', h: 199, s: 85, bh: 195, ch: 200 },
  rose: { label: 'گلبهی', h: 340, s: 80, bh: 342, ch: 345 },
  mint: { label: 'نعنایی', h: 160, s: 65, bh: 150, ch: 150 },
  sunset: { label: 'غروب', h: 22, s: 90, bh: 34, ch: 30 },
};
const FONTS = {
  vazirmatn: { label: 'وزیرمتن', css: "'Vazirmatn', Tahoma, sans-serif" },
  naskh: { label: 'نوتو نسخ', css: "'Noto Naskh Arabic', serif", url: 'https://fonts.googleapis.com/css2?family=Noto+Naskh+Arabic:wght@400;600&display=swap' },
  notosans: { label: 'نوتو سنس', css: "'Noto Sans Arabic', sans-serif", url: 'https://fonts.googleapis.com/css2?family=Noto+Sans+Arabic:wght@400;600&display=swap' },
  lalezar: { label: 'لاله‌زار', css: "'Lalezar', sans-serif", url: 'https://fonts.googleapis.com/css2?family=Lalezar&display=swap' },
  system: { label: 'فونت سیستم', css: 'Tahoma, system-ui, sans-serif' },
};
const DEFAULT_SETTINGS = { theme: 'lavender', scheme: 'auto', fontSize: 15, font: 'vazirmatn' };

function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem('settings') || '{}') };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
let settings = loadSettings();

function loadFont(key) {
  const f = FONTS[key];
  if (!f?.url || document.querySelector(`link[data-font="${key}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = f.url;
  link.dataset.font = key;
  document.head.appendChild(link);
}

function applySettings() {
  const root = document.documentElement;
  const t = THEMES[settings.theme] || THEMES.lavender;
  root.style.setProperty('--h', t.h);
  root.style.setProperty('--s', t.s + '%');
  root.style.setProperty('--bh', t.bh);
  root.style.setProperty('--ch', t.ch);
  root.style.setProperty('--msg-size', settings.fontSize + 'px');
  root.style.setProperty('--msg-font', (FONTS[settings.font] || FONTS.vazirmatn).css);
  if (settings.scheme === 'auto') delete root.dataset.scheme;
  else root.dataset.scheme = settings.scheme;
  loadFont(settings.font);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = `hsl(${t.h} ${t.s}% 64%)`;
}

function saveSettings(patch) {
  settings = { ...settings, ...patch };
  localStorage.setItem('settings', JSON.stringify(settings));
  applySettings();
  renderSettings();
}

applySettings();

const state = {
  token: localStorage.getItem('token'),
  me: null,
  socket: null,
  users: new Map(),    // id -> user
  chats: new Map(),    // peerId -> { last, unread }
  messages: new Map(), // peerId -> [message]
  hasMore: new Map(),  // peerId -> bool
  typing: new Map(),   // peerId -> timeout
  activeId: null,
  loadingOlder: false,
  replyTo: null,        // پیامی که داریم به آن پاسخ می‌دهیم
  pendingAttach: null,  // فایل یا عکسی که آماده‌ی ارسال است
};

// ───────────── ابزارها ─────────────
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fa = (n) => Number(n).toLocaleString('fa-IR');
const dayKey = (ts) => new Date(ts).toDateString();
const fmtTime = (ts) => new Date(ts).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit', hour12: false });

function fmtDay(ts) {
  const d = new Date(ts), now = new Date();
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return 'امروز';
  if (d.toDateString() === y.toDateString()) return 'دیروز';
  const opts = { day: 'numeric', month: 'long' };
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString('fa-IR', opts);
}

function fmtListTime(ts) {
  const d = new Date(ts), diff = Date.now() - ts;
  if (d.toDateString() === new Date().toDateString()) return fmtTime(ts);
  if (diff < 6 * 864e5) return d.toLocaleDateString('fa-IR', { weekday: 'short' });
  return d.toLocaleDateString('fa-IR', { day: 'numeric', month: 'short' });
}

function lastSeenText(u) {
  if (u.online) return 'آنلاین';
  if (!u.lastSeen) return 'آخرین بازدید به‌تازگی';
  const diff = Date.now() - u.lastSeen;
  if (diff < 60e3) return 'لحظاتی پیش آنلاین بود';
  if (diff < 3600e3) return `آخرین بازدید ${fa(Math.floor(diff / 60e3))} دقیقه پیش`;
  const day = fmtDay(u.lastSeen);
  return day === 'امروز' || day === 'دیروز'
    ? `آخرین بازدید ${day} ساعت ${fmtTime(u.lastSeen)}`
    : `آخرین بازدید ${day}`;
}

const initials = (name) =>
  (name || '').trim().split(/\s+/).slice(0, 2).map((w) => [...w][0] || '').join('').toUpperCase() || '?';

function avatar(u, size = '', showOnline = true) {
  const dot = showOnline && u.online && u.id !== state.me?.id ? '<span class="dot"></span>' : '';
  if (u.avatar) return `<div class="avatar ${size}"><img src="${esc(u.avatar)}" alt="" loading="lazy">${dot}</div>`;
  const color = AVATAR_COLORS[u.id % AVATAR_COLORS.length];
  return `<div class="avatar ${size}" style="background-color:${color}">${esc(initials(u.displayName))}${dot}</div>`;
}

// لینک‌ها و @یوزرنیم‌ها را قابل کلیک می‌کند (ورودی متن خام است)
function formatText(text) {
  return esc(text).replace(
    /(https?:\/\/[^\s<]+)|(^|[^\w@/.])@([a-zA-Z][a-zA-Z0-9_]{4,31})(?![\w])/g,
    (m, url, pre, un) =>
      url
        ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`
        : `${pre}<a href="#" class="mention" data-username="${un}" dir="ltr">@${un}</a>`
  );
}

function fmtSize(bytes) {
  if (bytes < 1024) return `${fa(bytes)} بایت`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toLocaleString('fa-IR', { maximumFractionDigits: 0 })} کیلوبایت`;
  return `${(bytes / 1024 / 1024).toLocaleString('fa-IR', { maximumFractionDigits: 1 })} مگابایت`;
}

// متن کوتاه یک پیام برای لیست گفتگوها و نقل‌قول پاسخ
function previewText(m) {
  const t = (m.text || '').replace(/\s+/g, ' ');
  if (m.kind === 'image') return '🖼 عکس' + (t ? ' · ' + t : '');
  if (m.kind === 'file') return '📎 ' + (m.file?.name || m.fileName || 'فایل') + (t ? ' · ' + t : '');
  return t;
}

const fileUrl = (f, download = false) =>
  `${f.url}?t=${encodeURIComponent(state.token)}${download ? '&download=1' : ''}`;
const tick = (m) => (m.readAt ? '<span class="tick read">✓✓</span>' : '<span class="tick">✓</span>');

function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 2600);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.token) logout();
  if (!res.ok) throw Object.assign(new Error(data.error || 'خطا در ارتباط با سرور'), { field: data.field });
  return data;
}

// ───────────── ورود / ثبت‌نام ─────────────
let authMode = 'login';

function setAuthMode(mode) {
  authMode = mode;
  const signup = mode === 'signup';
  $('#auth').classList.toggle('signup', signup);
  $('#authSub').textContent = signup
    ? 'نام، یوزرنیم یکتا و ایمیلتان را وارد کنید.'
    : 'ایمیل یا یوزرنیم و رمز عبورتان را وارد کنید.';
  $('#authSubmit').textContent = signup ? 'ثبت‌نام' : 'ورود';
  $('#switchText').textContent = signup ? 'حساب کاربری دارید؟' : 'حساب کاربری ندارید؟';
  $('#switchMode').textContent = signup ? 'وارد شوید' : 'ثبت‌نام کنید';
  $('#f-password').autocomplete = signup ? 'new-password' : 'current-password';
  $('#authError').textContent = '';
  document.querySelectorAll('.field.error').forEach((f) => f.classList.remove('error'));
  (signup ? $('#f-name') : $('#f-login')).focus();
}

function showAuth() {
  $('#app').classList.add('hidden');
  $('#auth').classList.remove('hidden');
  setAuthMode('login');
}

$('#switchMode').addEventListener('click', (e) => {
  e.preventDefault();
  setAuthMode(authMode === 'login' ? 'signup' : 'login');
});

// بررسی زنده‌ی یوزرنیم؛ ownUsername برای فرم ویرایش پروفایل است
function attachUsernameCheck(input, hint, defaultText, ownUsername = () => null) {
  let timer;
  const reset = () => { hint.textContent = defaultText; hint.className = 'hint'; };
  reset();
  input.addEventListener('input', () => {
    const v = input.value.trim().replace(/^@/, '');
    clearTimeout(timer);
    input.closest('.field').classList.remove('error');
    if (!v) return reset();
    if (ownUsername() && v.toLowerCase() === ownUsername().toLowerCase()) {
      hint.textContent = 'یوزرنیم فعلی شما';
      hint.className = 'hint';
      return;
    }
    if (!/^[a-zA-Z][a-zA-Z0-9_]{4,31}$/.test(v)) {
      hint.textContent = '۵ تا ۳۲ کاراکتر، شروع با حرف انگلیسی، فقط a-z و 0-9 و _';
      hint.className = 'hint bad';
      return;
    }
    hint.textContent = 'در حال بررسی…';
    hint.className = 'hint';
    timer = setTimeout(async () => {
      try {
        const r = await api('/api/username-available?u=' + encodeURIComponent(v));
        if (input.value.trim().replace(/^@/, '') !== v) return; // ورودی عوض شده
        hint.textContent = r.available ? `‎@${v} آزاد است` : `‎@${v} قبلاً گرفته شده`;
        hint.className = 'hint ' + (r.available ? 'good' : 'bad');
      } catch { /* نادیده */ }
    }, 350);
  });
  return reset;
}

attachUsernameCheck($('#f-username'), $('#unameHint'), 'دیگران با این یوزرنیم شما را پیدا می‌کنند.');

$('#authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#authError');
  const btn = $('#authSubmit');
  err.textContent = '';
  document.querySelectorAll('.field.error').forEach((f) => f.classList.remove('error'));

  const body = authMode === 'login'
    ? { login: $('#f-login').value, password: $('#f-password').value }
    : {
        displayName: $('#f-name').value,
        username: $('#f-username').value,
        email: $('#f-email').value,
        password: $('#f-password').value,
      };

  btn.disabled = true;
  try {
    const r = await api(authMode === 'login' ? '/api/login' : '/api/register', { method: 'POST', body });
    state.token = r.token;
    state.me = r.user;
    localStorage.setItem('token', r.token);
    $('#f-password').value = '';
    startApp();
  } catch (ex) {
    err.textContent = ex.message;
    const map = { name: '#f-name', username: '#f-username', email: '#f-email', password: '#f-password' };
    if (ex.field && map[ex.field]) {
      $(map[ex.field]).closest('.field').classList.add('error');
      $(map[ex.field]).focus();
    }
  } finally {
    btn.disabled = false;
  }
});

function logout() {
  localStorage.removeItem('token');
  state.socket?.disconnect();
  location.reload();
}

// ───────────── راه‌اندازی برنامه ─────────────
async function boot() {
  if (!state.token) return showAuth();
  try {
    state.me = await api('/api/me');
    startApp();
  } catch {
    showAuth();
  }
}

async function startApp() {
  $('#auth').classList.add('hidden');
  $('#app').classList.remove('hidden');
  state.users.set(state.me.id, state.me);
  renderMe();
  connectSocket();
  await loadChats();
}

function renderMe() {
  const me = state.me;
  $('#menuProfile').innerHTML = `${avatar(me, 'sm', false)}
    <div><div class="name">${esc(me.displayName)}</div>
    <div class="sub">@${esc(me.username)}</div>
    <div class="sub">${esc(me.email || '')}</div></div>`;
}

async function loadChats() {
  const list = await api('/api/chats');
  state.chats.clear();
  for (const c of list) {
    state.users.set(c.peer.id, c.peer);
    state.chats.set(c.peer.id, { last: c.last, unread: c.unread });
  }
  renderChatList();
}

// ───────────── Socket.IO ─────────────
function connectSocket() {
  const s = io({ auth: { token: state.token } });
  state.socket = s;
  let connectedBefore = false;

  s.on('connect', () => {
    if (connectedBefore) {
      // بعد از قطع و وصل شدن، داده‌ها را تازه کن
      loadChats();
      if (state.activeId) {
        state.messages.delete(state.activeId);
        openChat(state.activeId);
      }
    }
    connectedBefore = true;
  });

  s.on('connect_error', (err) => {
    if (err.message === 'unauthorized') logout();
  });

  s.on('message:new', (m) => {
    for (const u of [m.sender, m.recipient]) {
      if (u) state.users.set(u.id, { ...state.users.get(u.id), ...u });
    }
    delete m.sender;
    delete m.recipient;

    const mine = m.from === state.me.id;
    const peerId = mine ? m.to : m.from;
    const list = state.messages.get(peerId);
    if (list && !list.some((x) => x.id === m.id)) list.push(m);

    const chat = state.chats.get(peerId) || { unread: 0 };
    chat.last = m;
    state.chats.set(peerId, chat);

    const viewing = state.activeId === peerId && !document.hidden;
    if (!mine) {
      clearTyping(peerId);
      if (viewing) s.emit('chat:read', { peerId });
      else chat.unread++;
    }

    renderChatList();
    if (state.activeId === peerId && list) renderMessages(mine, m.id);
  });

  s.on('user:update', (u) => {
    state.users.set(u.id, { ...state.users.get(u.id), ...u });
    if (u.id === state.me.id) {
      state.me = { ...state.me, ...u };
      renderMe();
    }
    refreshPeer(u.id);
    if (openProfileId === u.id) renderUserModal(u.id);
  });

  s.on('reaction:update', ({ messageId, reactions }) => {
    const m = findMessage(messageId);
    if (!m) return;
    m.reactions = reactions;
    updateReactionsDom(messageId);
  });

  s.on('typing', ({ from }) => {
    clearTimeout(state.typing.get(from));
    state.typing.set(from, setTimeout(() => clearTyping(from), 3500));
    refreshPeer(from);
  });

  s.on('presence', ({ userId, online, lastSeen }) => {
    const u = state.users.get(userId);
    if (!u) return;
    u.online = online;
    if (lastSeen) u.lastSeen = lastSeen;
    refreshPeer(userId);
  });

  s.on('messages:read', ({ by }) => {
    const now = Date.now();
    (state.messages.get(by) || []).forEach((m) => {
      if (m.from === state.me.id && !m.readAt) m.readAt = now;
    });
    const c = state.chats.get(by);
    if (c && c.last.from === state.me.id) c.last.readAt = now;
    renderChatList();
    if (state.activeId === by) {
      document.querySelectorAll('#messages .msg.out .tick').forEach((t) => {
        t.classList.add('read');
        t.textContent = '✓✓';
      });
    }
  });
}

function clearTyping(id) {
  if (!state.typing.has(id)) return;
  clearTimeout(state.typing.get(id));
  state.typing.delete(id);
  refreshPeer(id);
}

function refreshPeer(id) {
  if (state.chats.has(id)) renderChatList();
  if (state.activeId === id) renderHeader();
  if (openProfileId === id) renderUserModal(id);
}

// ───────────── لیست گفتگوها ─────────────
function renderChatList() {
  const el = $('#chatList');
  const items = [...state.chats.entries()].sort((a, b) => b[1].last.id - a[1].last.id);
  const totalUnread = items.reduce((s, [, c]) => s + c.unread, 0);
  document.title = totalUnread ? `(${fa(totalUnread)}) Arian Chat` : 'Arian Chat';

  if (!items.length) {
    el.innerHTML = `<div class="list-empty">هنوز گفتگویی ندارید.<br>یوزرنیم یک نفر را در کادر بالا جستجو کنید.</div>`;
    return;
  }
  el.innerHTML = items.map(([id, c]) => {
    const u = state.users.get(id);
    const mine = c.last.from === state.me.id;
    const preview = state.typing.has(id)
      ? '<span class="typing-text">در حال نوشتن…</span>'
      : (mine ? '<span class="you">شما: </span>' : '') + esc(previewText(c.last));
    return `<div class="chat-item${id === state.activeId ? ' active' : ''}" data-id="${id}">
      ${avatar(u)}
      <div class="ci-body">
        <div class="ci-top">
          <span class="ci-name">${esc(u.displayName)}</span>
          <span class="ci-time">${mine ? tick(c.last) : ''}${fmtListTime(c.last.createdAt)}</span>
        </div>
        <div class="ci-bottom">
          <span class="ci-preview" dir="auto">${preview}</span>
          ${c.unread ? `<span class="badge">${fa(c.unread)}</span>` : ''}
        </div>
      </div>
    </div>`;
  }).join('');
}

$('#chatList').addEventListener('click', (e) => {
  const it = e.target.closest('.chat-item');
  if (it) openChat(Number(it.dataset.id));
});

// ───────────── جستجو با یوزرنیم ─────────────
let searchTimer, searchSeq = 0;

function closeSearch() {
  $('#searchInput').value = '';
  $('#searchClear').classList.add('hidden');
  $('#searchResults').classList.add('hidden');
  $('#chatList').classList.remove('hidden');
}

function highlight(username, term) {
  const n = term.length;
  return username.toLowerCase().startsWith(term.toLowerCase())
    ? `<b>${esc(username.slice(0, n))}</b>${esc(username.slice(n))}`
    : esc(username);
}

$('#searchInput').addEventListener('input', (e) => {
  const term = e.target.value.trim().replace(/^@/, '');
  clearTimeout(searchTimer);
  $('#searchClear').classList.toggle('hidden', !e.target.value);
  if (!term) {
    $('#searchResults').classList.add('hidden');
    $('#chatList').classList.remove('hidden');
    return;
  }
  $('#chatList').classList.add('hidden');
  $('#searchResults').classList.remove('hidden');

  searchTimer = setTimeout(async () => {
    const seq = ++searchSeq;
    const res = await api('/api/users/search?q=' + encodeURIComponent(term)).catch(() => []);
    if (seq !== searchSeq) return;
    res.forEach((u) => state.users.set(u.id, { ...state.users.get(u.id), ...u }));
    $('#searchResults').innerHTML =
      '<div class="section-title">نتایج جستجو</div>' +
      (res.length
        ? res.map((u) => `<div class="chat-item" data-id="${u.id}">
            ${avatar(u)}
            <div class="ci-body">
              <div class="ci-top"><span class="ci-name">${esc(u.displayName)}</span></div>
              <div class="ci-bottom"><span class="ci-preview username">@${highlight(u.username, term)}</span></div>
            </div></div>`).join('')
        : `<div class="list-empty">کاربری با یوزرنیم «${esc(term)}» پیدا نشد.</div>`);
  }, 250);
});

$('#searchInput').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSearch();
});
$('#searchClear').addEventListener('click', closeSearch);
$('#searchResults').addEventListener('click', (e) => {
  const it = e.target.closest('.chat-item');
  if (it) {
    closeSearch();
    openChat(Number(it.dataset.id));
  }
});

// ───────────── منو ─────────────
$('#menuBtn').addEventListener('click', () => $('#menu').classList.toggle('hidden'));
$('#logoutBtn').addEventListener('click', logout);
$('#menuProfile').addEventListener('click', openProfileEditor);
$('#editProfileBtn').addEventListener('click', openProfileEditor);
$('#settingsBtn').addEventListener('click', openSettings);

// ───────────── ویرایش پروفایل خودم ─────────────
const BIO_MAX = 70;
const resetPUnameHint = attachUsernameCheck(
  $('#p-username'), $('#pUnameHint'),
  'دیگران با این یوزرنیم شما را پیدا می‌کنند.',
  () => state.me?.username
);

function renderProfileAvatar() {
  $('#profileAvatar').innerHTML = avatar(state.me, 'xl', false);
  $('#removeAvatar').classList.toggle('hidden', !state.me.avatar);
}

function updateBioCounter() {
  $('#bioCounter').textContent = fa(BIO_MAX - [...$('#p-bio').value].length);
}

function openProfileEditor() {
  const me = state.me;
  $('#menu').classList.add('hidden');
  $('#p-name').value = me.displayName;
  $('#p-bio').value = me.bio || '';
  $('#p-username').value = me.username;
  $('#p-email').value = me.email || '';
  $('#profileError').textContent = '';
  document.querySelectorAll('#profileForm .field.error').forEach((f) => f.classList.remove('error'));
  resetPUnameHint();
  updateBioCounter();
  renderProfileAvatar();
  $('#profilePanel').classList.remove('hidden');
}

function closeProfileEditor() {
  $('#profilePanel').classList.add('hidden');
}

$('#profileBack').addEventListener('click', closeProfileEditor);
$('#p-bio').addEventListener('input', updateBioCounter);

$('#profileForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#profileError'), btn = $('#saveProfile');
  err.textContent = '';
  document.querySelectorAll('#profileForm .field.error').forEach((f) => f.classList.remove('error'));
  btn.disabled = true;
  try {
    const me = await api('/api/me', {
      method: 'PUT',
      body: {
        displayName: $('#p-name').value,
        bio: $('#p-bio').value,
        username: $('#p-username').value,
        email: $('#p-email').value,
      },
    });
    state.me = me;
    state.users.set(me.id, { ...state.users.get(me.id), ...me });
    renderMe();
    closeProfileEditor();
    toast('پروفایل ذخیره شد');
  } catch (ex) {
    err.textContent = ex.message;
    const map = { name: '#p-name', username: '#p-username', email: '#p-email', bio: '#p-bio' };
    if (ex.field && map[ex.field]) {
      $(map[ex.field]).closest('.field').classList.add('error');
      $(map[ex.field]).focus();
    }
  } finally {
    btn.disabled = false;
  }
});

// عکس را در مرورگر مربعی و کوچک می‌کنیم تا حجمش کم شود
function resizeImage(file, size = 320) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const s = Math.min(img.naturalWidth, img.naturalHeight);
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, size, size);
      ctx.drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, size, size);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.88));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('این فایل تصویر معتبری نیست'));
    };
    img.src = url;
  });
}

async function setAvatar(request) {
  const box = $('.avatar-edit');
  box.classList.add('busy');
  try {
    const me = await request();
    state.me = me;
    state.users.set(me.id, { ...state.users.get(me.id), ...me });
    renderMe();
    renderProfileAvatar();
  } catch (ex) {
    toast(ex.message);
  } finally {
    box.classList.remove('busy');
  }
}

$('#avatarFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (!file.type.startsWith('image/')) return toast('لطفاً یک فایل تصویری انتخاب کنید');
  setAvatar(async () => api('/api/me/avatar', { method: 'PUT', body: { image: await resizeImage(file) } }));
});

$('#removeAvatar').addEventListener('click', () => {
  setAvatar(() => api('/api/me/avatar', { method: 'DELETE' }));
});

// ───────────── پروفایل کاربر مقابل ─────────────
let openProfileId = null;
const ICONS = {
  info: '<svg viewBox="0 0 24 24" width="22" height="22"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 11v6M12 7.5v.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  at: '<svg viewBox="0 0 24 24" width="22" height="22"><circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M16 12v1.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-3.5 7.1" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
};

function renderUserModal(id) {
  const u = state.users.get(id);
  if (!u) return;
  const status = state.typing.has(id) ? 'در حال نوشتن…' : lastSeenText(u);
  $('#userModalBody').innerHTML = `
    <div class="profile-hero">
      ${avatar(u, 'xl', false)}
      <div class="p-name">${esc(u.displayName)}</div>
      <div class="p-status">${esc(status)}</div>
    </div>
    <div class="info-rows">
      ${u.bio ? `<div class="info-row">${ICONS.info}<div><div class="val" dir="auto">${formatText(u.bio)}</div><div class="lbl">بیوگرافی</div></div></div>` : ''}
      <button class="info-row" id="copyUsername">${ICONS.at}<div><div class="val" dir="ltr">@${esc(u.username)}</div><div class="lbl">یوزرنیم (برای کپی بزنید)</div></div></button>
    </div>
    ${state.activeId !== id ? `<div class="profile-actions"><button class="btn-primary" id="modalMessage">ارسال پیام</button></div>` : ''}`;
  $('#copyUsername').onclick = () => {
    navigator.clipboard?.writeText('@' + u.username).then(() => toast('یوزرنیم کپی شد'), () => {});
  };
  const msgBtn = $('#modalMessage');
  if (msgBtn) msgBtn.onclick = () => { closeUserModal(); openChat(id); };
}

function openUserModal(id) {
  openProfileId = id;
  renderUserModal(id);
  $('#userModal').classList.remove('hidden');
}

function closeUserModal() {
  openProfileId = null;
  $('#userModal').classList.add('hidden');
}

$('#chPeer').addEventListener('click', () => state.activeId && openUserModal(state.activeId));
$('#userModalClose').addEventListener('click', closeUserModal);
$('#userModal').addEventListener('click', (e) => {
  if (e.target.id === 'userModal') return closeUserModal();
  const mention = e.target.closest('.mention');
  if (mention) {
    e.preventDefault();
    openUsername(mention.dataset.username);
  }
});

// ───────────── پنل تنظیمات ظاهر ─────────────
function renderSettings() {
  if ($('#settingsPanel').classList.contains('hidden')) return;
  const meId = state.me?.id ?? 0;

  // پیش‌نمایش زنده‌ی چت
  const sampleIn = { id: -1, from: -2, text: 'سلام! فونت و تم جدید رو امتحان کن 👋', createdAt: Date.now() - 60000, reactions: [], kind: 'text' };
  const sampleOut = {
    id: -2, from: meId, text: 'عالیه، همین الان عوضش کردم', createdAt: Date.now(), readAt: Date.now(), kind: 'text',
    reactions: [{ userId: -2, emoji: '❤️' }],
    replyTo: { id: -1, from: -2, kind: 'text', text: sampleIn.text },
  };
  state.users.set(-2, { id: -2, displayName: 'سارا', username: 'sara_m' });
  $('#settingsPreview').innerHTML = messageHtml(sampleIn, true) + messageHtml(sampleOut, true);

  $('#fontSize').value = settings.fontSize;
  $('#fontSizeVal').textContent = fa(settings.fontSize);

  $('#fontList').innerHTML = Object.entries(FONTS).map(([key, f]) => {
    loadFont(key);
    return `<button type="button" class="option${key === settings.font ? ' selected' : ''}" data-font="${key}">
      <span class="radio"></span><span>${f.label}</span><span class="sample" style="font-family:${f.css}">سلام دنیا</span>
    </button>`;
  }).join('');

  $('#themeList').innerHTML = Object.entries(THEMES).map(([key, t]) =>
    `<button type="button" class="swatch${key === settings.theme ? ' selected' : ''}" data-theme="${key}"
       style="--h:${t.h};--bh:${t.bh};--ch:${t.ch}">
      <span class="sw-preview"></span><span class="sw-label">${t.label}</span>
    </button>`).join('');

  document.querySelectorAll('#schemeList button').forEach((b) =>
    b.classList.toggle('selected', b.dataset.scheme === settings.scheme));
}

function openSettings() {
  $('#menu').classList.add('hidden');
  $('#settingsPanel').classList.remove('hidden');
  renderSettings();
}

$('#settingsBack').addEventListener('click', () => $('#settingsPanel').classList.add('hidden'));
$('#fontSize').addEventListener('input', (e) => saveSettings({ fontSize: Number(e.target.value) }));
$('#fontList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-font]');
  if (b) saveSettings({ font: b.dataset.font });
});
$('#themeList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-theme]');
  if (b) saveSettings({ theme: b.dataset.theme });
});
$('#schemeList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-scheme]');
  if (b) saveSettings({ scheme: b.dataset.scheme });
});

// ───────────── باز کردن پیوی با یوزرنیم ─────────────
async function openUsername(username) {
  const un = username.toLowerCase();
  if (state.me && state.me.username.toLowerCase() === un) {
    closeUserModal();
    return openProfileEditor();
  }
  let user = [...state.users.values()].find((u) => u.id > 0 && u.username?.toLowerCase() === un);
  if (!user) {
    try {
      user = await api('/api/users/by-username/' + encodeURIComponent(username));
      state.users.set(user.id, { ...state.users.get(user.id), ...user });
    } catch (ex) {
      return toast(ex.message);
    }
  }
  closeUserModal();
  closeSearch();
  openChat(user.id);
}

// ───────────── صفحه گفتگو ─────────────
async function openChat(id) {
  if (state.activeId !== id) {
    clearReply();
    clearAttach();
  }
  state.activeId = id;
  closeCtxMenu();
  $('#app').classList.add('chat-open');
  $('#emptyState').classList.add('hidden');
  $('#chatView').classList.remove('hidden');
  renderHeader();
  renderChatList();

  if (!state.messages.has(id)) {
    $('#messages').innerHTML = '';
    try {
      const r = await api(`/api/messages/${id}`);
      state.messages.set(id, r.messages);
      state.hasMore.set(id, r.hasMore);
    } catch (e) {
      return toast(e.message);
    }
    if (state.activeId !== id) return;
  }
  renderMessages(true);
  markRead(id);
  if (!isTouch) msgInput.focus();
}

function markRead(id) {
  const c = state.chats.get(id);
  if (c && c.unread) {
    c.unread = 0;
    renderChatList();
  }
  state.socket?.emit('chat:read', { peerId: id });
}

function renderHeader() {
  const u = state.users.get(state.activeId);
  if (!u) return;
  $('#chatHeaderAvatar').innerHTML = avatar(u, 'sm', false);
  $('#chatHeaderName').textContent = u.displayName;
  const st = $('#chatHeaderStatus');
  const typing = state.typing.has(u.id);
  st.textContent = typing ? 'در حال نوشتن…' : lastSeenText(u);
  st.className = 'status' + (typing || u.online ? ' online' : '');
}
setInterval(() => state.activeId && renderHeader(), 60e3);

$('#backBtn').addEventListener('click', () => {
  state.activeId = null;
  closeCtxMenu();
  clearReply();
  clearAttach();
  $('#app').classList.remove('chat-open');
  $('#chatView').classList.add('hidden');
  $('#emptyState').classList.remove('hidden');
  renderChatList();
});

// ───────────── ساختن HTML پیام‌ها ─────────────
const ICON_REPLY = '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M10 7 4 12l6 5M4 12h10a6 6 0 0 1 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_DOWNLOAD = '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M12 4v11M7 10l5 5 5-5M5 20h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_FILE = '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z M14 3v5h5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';

const nameOf = (userId) => (userId === state.me?.id ? 'شما' : state.users.get(userId)?.displayName || 'کاربر');

function reactionsHtml(m) {
  const groups = new Map();
  for (const r of m.reactions || []) {
    const g = groups.get(r.emoji) || { count: 0, mine: false };
    g.count++;
    if (r.userId === state.me?.id) g.mine = true;
    groups.set(r.emoji, g);
  }
  return [...groups].map(([emoji, g]) =>
    `<button class="pill${g.mine ? ' mine' : ''}" data-emoji="${emoji}"><span class="pe">${emoji}</span><span>${fa(g.count)}</span></button>`
  ).join('');
}

function replyQuoteHtml(r) {
  if (!r) return '';
  return `<div class="reply-quote" data-reply-id="${r.id}">
    <div class="rq-name">${esc(nameOf(r.from))}</div>
    <div class="rq-text" dir="auto">${esc(previewText(r))}</div>
  </div>`;
}

// اندازه‌ی نمایش عکس را از قبل حساب می‌کنیم تا صفحه موقع لود شدن نپرد
function mediaWidth(f) {
  if (!f.width || !f.height) return 300;
  return Math.round(Math.max(160, Math.min(340, f.width, (420 * f.width) / f.height)));
}

function messageHtml(m, isTail, animate = false) {
  const out = m.from === state.me?.id;
  const time = `<span>${fmtTime(m.createdAt)}</span>${out ? tick(m) : ''}`;
  const caption = m.text ? `<div class="text" dir="auto">${formatText(m.text)}</div>` : '';
  let body = '', bubbleClass = 'bubble', bubbleStyle = '', metaInside = false;

  if (m.kind === 'image' && m.file) {
    const f = m.file;
    const ratio = f.width && f.height ? `aspect-ratio:${f.width}/${f.height};` : '';
    metaInside = !m.text;
    bubbleClass += ' has-media';
    bubbleStyle = ` style="width:${mediaWidth(f) + 8}px"`;
    body = `<a class="media" href="${fileUrl(f)}" data-lightbox="${m.id}">
      <img src="${fileUrl(f)}" alt="" loading="lazy" style="${ratio}">
      ${metaInside ? `<div class="meta on-media">${time}</div>` : ''}
    </a>`;
  } else if (m.kind === 'file' && m.file) {
    body = `<a class="file" href="${fileUrl(m.file, true)}" download="${esc(m.file.name)}">
      <span class="file-icon">${ICON_DOWNLOAD}</span>
      <span class="file-info">
        <span class="file-name" dir="auto" title="${esc(m.file.name)}">${esc(m.file.name)}</span>
        <span class="file-size">${fmtSize(m.file.size)}</span>
      </span>
    </a>`;
  }

  return `<div class="msg ${out ? 'out' : 'in'}${isTail ? ' tail' : ''}${animate ? ' appear' : ''}" data-id="${m.id}">
    <div class="${bubbleClass}"${bubbleStyle}>
      ${replyQuoteHtml(m.replyTo)}${body}${caption}
      <div class="reactions">${reactionsHtml(m)}</div>
      ${metaInside ? '' : `<div class="meta">${time}</div>`}
    </div>
    <div class="msg-actions">
      <button class="act-btn reply-btn" aria-label="پاسخ" title="پاسخ">${ICON_REPLY}</button>
      <button class="act-btn react-btn" aria-label="واکنش" title="واکنش">☺</button>
    </div>
  </div>`;
}

function renderMessages(toBottom = false, animateId = null) {
  const box = $('#messages');
  const list = state.messages.get(state.activeId) || [];
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 150;

  if (!list.length) {
    box.innerHTML = '<div class="no-messages">هنوز پیامی رد و بدل نشده.<br>اولین پیام را بفرستید.</div>';
    return;
  }
  let html = '', lastDay = null;
  list.forEach((m, i) => {
    const day = dayKey(m.createdAt);
    if (day !== lastDay) {
      html += `<div class="date-sep">${fmtDay(m.createdAt)}</div>`;
      lastDay = day;
    }
    const next = list[i + 1];
    const isTail = !next || next.from !== m.from || dayKey(next.createdAt) !== day;
    html += messageHtml(m, isTail, m.id === animateId);
  });
  box.innerHTML = html;
  if (toBottom || nearBottom) box.scrollTop = box.scrollHeight;
  // وقتی عکس‌ها لود شدند، اگر پایین صفحه بودیم پایین بمانیم
  if (toBottom || nearBottom) {
    box.querySelectorAll('img').forEach((img) => {
      if (!img.complete) img.addEventListener('load', () => { box.scrollTop = box.scrollHeight; }, { once: true });
    });
  }
}

async function loadOlder() {
  const box = $('#messages'), id = state.activeId;
  if (!state.hasMore.get(id) || state.loadingOlder) return false;
  state.loadingOlder = true;
  try {
    const list = state.messages.get(id);
    const r = await api(`/api/messages/${id}?before=${list[0].id}`);
    if (state.activeId !== id) return false;
    const prevHeight = box.scrollHeight, prevTop = box.scrollTop;
    list.unshift(...r.messages);
    state.hasMore.set(id, r.hasMore);
    renderMessages();
    box.scrollTop = box.scrollHeight - prevHeight + prevTop;
    return true;
  } catch {
    return false;
  } finally {
    state.loadingOlder = false;
  }
}

$('#messages').addEventListener('scroll', (e) => {
  closeCtxMenu();
  if (e.target.scrollTop < 80) loadOlder();
});

// پرش به پیام اصلی با کلیک روی نقل‌قول
async function scrollToMessage(id) {
  let el = document.querySelector(`#messages .msg[data-id="${id}"]`);
  for (let i = 0; !el && i < 20; i++) {
    if (!(await loadOlder())) break;
    el = document.querySelector(`#messages .msg[data-id="${id}"]`);
  }
  if (!el) return toast('پیام اصلی پیدا نشد');
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

// ───────────── پاسخ (ریپلای) ─────────────
const msgInput = $('#msgInput');

function startReply(m) {
  state.replyTo = m;
  $('#replyTitle').textContent = 'پاسخ به ' + (m.from === state.me.id ? 'خودتان' : nameOf(m.from));
  $('#replyText').textContent = previewText(m);
  $('#replyBar').classList.remove('hidden');
  msgInput.focus();
}

function clearReply() {
  state.replyTo = null;
  $('#replyBar').classList.add('hidden');
}

$('#replyCancel').addEventListener('click', clearReply);

// ───────────── پیوست عکس و فایل ─────────────
function uploadFile(blob, { name, photo, w, h }, onProgress) {
  let xhr;
  const promise = new Promise((resolve, reject) => {
    xhr = new XMLHttpRequest();
    const qs = new URLSearchParams({ name, photo: photo ? '1' : '0', w: w || '', h: h || '' });
    xhr.open('POST', '/api/upload?' + qs);
    xhr.setRequestHeader('Authorization', 'Bearer ' + state.token);
    xhr.setRequestHeader('Content-Type', blob.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* نادیده */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data.error || 'آپلود ناموفق بود'));
    };
    xhr.onerror = () => reject(new Error('خطا در اتصال هنگام آپلود'));
    xhr.onabort = () => reject(new Error('آپلود لغو شد'));
    xhr.send(blob);
  });
  promise.catch(() => {}); // جلوگیری از خطای «rejection بدون مدیریت»
  return { promise, abort: () => xhr.abort() };
}

// عکس‌های خیلی بزرگ را کوچک می‌کنیم (مثل تلگرام)؛ گیف دست‌نخورده می‌ماند
function processPhoto(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth, h = img.naturalHeight, MAX = 2560;
      if (file.type === 'image/gif' || (file.size < 1.5 * 1024 * 1024 && Math.max(w, h) <= MAX)) {
        URL.revokeObjectURL(url);
        return resolve({ blob: file, w, h });
      }
      const scale = Math.min(1, MAX / Math.max(w, h));
      const c = document.createElement('canvas');
      c.width = Math.round(w * scale);
      c.height = Math.round(h * scale);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      c.toBlob((blob) => (blob ? resolve({ blob, w: c.width, h: c.height }) : reject(new Error('خطا در پردازش عکس'))), 'image/jpeg', 0.88);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('این فایل تصویر معتبری نیست'));
    };
    img.src = url;
  });
}

async function attachFile(file, asPhoto) {
  if (!state.activeId || !file) return;
  if (file.size > MAX_FILE) return toast(`حجم فایل نباید بیشتر از ${fa(20)} مگابایت باشد`);
  clearAttach();
  if (asPhoto && !/^image\/(jpeg|png|gif|webp)$/.test(file.type)) asPhoto = false;

  const att = { name: file.name || 'file', size: file.size, asPhoto, progress: 0, preview: null };
  state.pendingAttach = att;
  let blob = file, w = null, h = null;
  if (asPhoto) {
    try {
      ({ blob, w, h } = await processPhoto(file));
      att.preview = URL.createObjectURL(blob);
      att.size = blob.size;
      if (blob !== file) att.name = (file.name || 'photo').replace(/\.\w+$/, '') + '.jpg';
    } catch {
      att.asPhoto = false;
    }
  }
  if (state.pendingAttach !== att) return; // در این فاصله لغو شده

  const up = uploadFile(blob, { name: att.name, photo: att.asPhoto, w, h }, (p) => {
    att.progress = p;
    updateAttachProgress();
  });
  att.promise = up.promise;
  att.abort = up.abort;
  up.promise.then(
    () => { att.done = true; updateAttachProgress(); },
    (err) => {
      if (state.pendingAttach === att && !att.cancelled) {
        att.error = err.message;
        renderAttachBar();
      }
    }
  );
  renderAttachBar();
  msgInput.focus();
}

function renderAttachBar() {
  const att = state.pendingAttach, bar = $('#attachBar');
  if (!att) return bar.classList.add('hidden');
  const thumb = att.preview
    ? `<img class="cb-thumb" src="${att.preview}" alt="">`
    : `<span class="cb-thumb">${ICON_FILE}</span>`;
  bar.innerHTML = `${thumb}
    <div class="cb-body" style="border:none;padding:0">
      <div class="cb-title" dir="auto">${esc(att.asPhoto ? 'عکس' : att.name)}</div>
      <div class="cb-text${att.error ? ' error' : ''}" id="attachStatus"></div>
      <div class="progress"><span id="attachProgress"></span></div>
    </div>
    <button type="button" class="icon-btn cb-close" id="attachCancel" aria-label="حذف پیوست">×</button>`;
  bar.classList.remove('hidden');
  $('#attachCancel').onclick = clearAttach;
  updateAttachProgress();
}

function updateAttachProgress() {
  const att = state.pendingAttach;
  const status = $('#attachStatus'), bar = $('#attachProgress');
  if (!att || !status) return;
  status.textContent = att.error
    ? att.error
    : att.done
      ? fmtSize(att.size) + ' · آماده‌ی ارسال'
      : `${fmtSize(att.size)} · در حال آپلود ${fa(Math.round(att.progress * 100))}٪`;
  bar.style.width = (att.error ? 0 : att.done ? 100 : att.progress * 100) + '%';
}

function clearAttach() {
  const att = state.pendingAttach;
  if (att) {
    att.cancelled = true;
    if (!att.done && !att.sending) att.abort?.();
    if (att.preview) setTimeout(() => URL.revokeObjectURL(att.preview), 2000);
  }
  state.pendingAttach = null;
  $('#attachBar').classList.add('hidden');
  $('#attachBar').innerHTML = '';
}

$('#attachBtn').addEventListener('click', () => $('#attachMenu').classList.toggle('hidden'));
$('#pickPhoto').addEventListener('click', () => { $('#attachMenu').classList.add('hidden'); $('#photoInput').click(); });
$('#pickFile').addEventListener('click', () => { $('#attachMenu').classList.add('hidden'); $('#fileInput').click(); });
$('#photoInput').addEventListener('change', (e) => { attachFile(e.target.files[0], true); e.target.value = ''; });
$('#fileInput').addEventListener('change', (e) => { attachFile(e.target.files[0], false); e.target.value = ''; });

// چسباندن عکس با Ctrl+V
msgInput.addEventListener('paste', (e) => {
  const file = [...(e.clipboardData?.files || [])][0];
  if (file) {
    e.preventDefault();
    attachFile(file, file.type.startsWith('image/'));
  }
});

// کشیدن و رها کردن فایل روی صفحه‌ی چت
const chatView = $('#chatView');
let dragDepth = 0;
chatView.addEventListener('dragenter', (e) => {
  if (![...e.dataTransfer.types].includes('Files')) return;
  e.preventDefault();
  dragDepth++;
  $('#dropOverlay').classList.remove('hidden');
});
chatView.addEventListener('dragover', (e) => {
  if ([...e.dataTransfer.types].includes('Files')) e.preventDefault();
});
chatView.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    $('#dropOverlay').classList.add('hidden');
  }
});
chatView.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('#dropOverlay').classList.add('hidden');
  const file = e.dataTransfer.files[0];
  if (file) attachFile(file, file.type.startsWith('image/'));
});

// ───────────── ارسال پیام ─────────────
let lastTypingSent = 0;

function autoGrow() {
  msgInput.style.height = 'auto';
  msgInput.style.height = Math.min(msgInput.scrollHeight, 160) + 'px';
}

async function sendMessage() {
  const text = msgInput.value.trim();
  const att = state.pendingAttach;
  const to = state.activeId;
  if ((!text && !att) || !to) return;

  let fileId = null;
  if (att) {
    if (att.sending) return;
    if (att.error) return toast(att.error);
    if (!att.promise) return toast('در حال آماده‌سازی فایل…');
    att.sending = true;
    $('.send-btn').disabled = true;
    try {
      fileId = (await att.promise).id;
    } catch (ex) {
      att.sending = false;
      $('.send-btn').disabled = false;
      return toast(ex.message);
    }
    $('.send-btn').disabled = false;
    if (state.pendingAttach !== att || state.activeId !== to) return; // در این فاصله لغو شد
  }

  state.socket.emit('message:send', { to, text, fileId, replyTo: state.replyTo?.id || null }, (res) => {
    if (res?.error) toast(res.error);
  });
  msgInput.value = '';
  autoGrow();
  clearReply();
  if (att) {
    att.done = true;
    clearAttach();
  }
  msgInput.focus();
}

$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  sendMessage();
});

msgInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !isTouch) {
    e.preventDefault();
    sendMessage();
  }
});

msgInput.addEventListener('input', () => {
  autoGrow();
  if (state.activeId && Date.now() - lastTypingSent > 2000) {
    lastTypingSent = Date.now();
    state.socket.emit('typing', { to: state.activeId });
  }
});

// ───────────── ری‌اکشن‌ها ─────────────
function findMessage(id) {
  for (const list of state.messages.values()) {
    const m = list.find((x) => x.id === id);
    if (m) return m;
  }
  return null;
}

function updateReactionsDom(id) {
  const el = document.querySelector(`#messages .msg[data-id="${id}"] .reactions`);
  const m = findMessage(id);
  if (el && m) el.innerHTML = reactionsHtml(m);
}

function toggleReaction(id, emoji) {
  const m = findMessage(id);
  if (!m) return;
  const meId = state.me.id;
  const current = m.reactions.find((r) => r.userId === meId);
  // به‌روزرسانی خوش‌بینانه؛ سرور بعداً نسخه نهایی را می‌فرستد
  m.reactions = m.reactions.filter((r) => r.userId !== meId);
  if (!current || current.emoji !== emoji) m.reactions.push({ userId: meId, emoji });
  updateReactionsDom(id);
  state.socket.emit('reaction:toggle', { messageId: id, emoji });
}

// ───────────── منوی پیام: ری‌اکشن، پاسخ، کپی، دانلود ─────────────
const ctx = $('#ctxMenu');

function openCtxMenu(msgId, x, y) {
  const m = findMessage(msgId);
  if (!m) return;
  const chosen = m.reactions.find((r) => r.userId === state.me.id)?.emoji;
  ctx.dataset.id = msgId;
  $('#ctxReactions').innerHTML = REACTIONS.map((e) =>
    `<button data-emoji="${e}"${e === chosen ? ' class="chosen"' : ''}>${e}</button>`).join('');
  const items = [`<button class="menu-item" data-action="reply">${ICON_REPLY} پاسخ</button>`];
  if (m.text) items.push(`<button class="menu-item" data-action="copy"><svg viewBox="0 0 24 24" width="18" height="18"><rect x="8" y="8" width="12" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" fill="none" stroke="currentColor" stroke-width="1.8"/></svg> کپی متن</button>`);
  if (m.file) items.push(`<a class="menu-item" data-action="download" href="${fileUrl(m.file, true)}" download="${esc(m.file.name)}">${ICON_DOWNLOAD.replace(/22/g, '18')} دانلود</a>`);
  $('#ctxItems').innerHTML = items.join('');

  ctx.classList.remove('hidden');
  const r = ctx.getBoundingClientRect();
  const left = Math.max(8, Math.min(x - r.width / 2, innerWidth - r.width - 8));
  let top = y - r.height - 10;
  if (top < 8) top = Math.min(y + 14, innerHeight - r.height - 8);
  ctx.style.left = left + 'px';
  ctx.style.top = top + 'px';
}

function closeCtxMenu() {
  ctx.classList.add('hidden');
}

ctx.addEventListener('click', (e) => {
  const id = Number(ctx.dataset.id);
  const m = findMessage(id);
  const emojiBtn = e.target.closest('[data-emoji]');
  const actionBtn = e.target.closest('[data-action]');
  if (emojiBtn) toggleReaction(id, emojiBtn.dataset.emoji);
  else if (actionBtn?.dataset.action === 'reply' && m) startReply(m);
  else if (actionBtn?.dataset.action === 'copy' && m) {
    navigator.clipboard?.writeText(m.text).then(() => toast('متن کپی شد'), () => {});
  }
  if (emojiBtn || actionBtn) closeCtxMenu();
});

// ───────────── نمایش عکس بزرگ ─────────────
function openLightbox(m) {
  $('#lbImg').src = fileUrl(m.file);
  $('#lbDownload').href = fileUrl(m.file, true);
  $('#lbDownload').setAttribute('download', m.file.name);
  $('#lightbox').classList.remove('hidden');
}
function closeLightbox() {
  $('#lightbox').classList.add('hidden');
  $('#lbImg').removeAttribute('src');
}
$('#lbClose').addEventListener('click', closeLightbox);
$('#lightbox').addEventListener('click', (e) => {
  if (e.target.id === 'lightbox' || e.target.id === 'lbImg') closeLightbox();
});

// ───────────── رویدادهای داخل لیست پیام‌ها ─────────────
const box = $('#messages');
const msgIdOf = (el) => Number(el.closest('.msg').dataset.id);
const isInteractive = (t) => t.closest('.pill, a, .reply-quote, button');
let lastPointer = 'mouse';
let pressTimer = null;
let lastTap = { id: null, t: 0 };

box.addEventListener('pointerdown', (e) => { lastPointer = e.pointerType; });

box.addEventListener('click', (e) => {
  const mention = e.target.closest('.mention');
  if (mention) {
    e.preventDefault();
    return openUsername(mention.dataset.username);
  }
  const quote = e.target.closest('.reply-quote');
  if (quote) return scrollToMessage(Number(quote.dataset.replyId));
  const media = e.target.closest('.media');
  if (media) {
    e.preventDefault();
    const m = findMessage(msgIdOf(media));
    if (m) openLightbox(m);
    return;
  }
  const pill = e.target.closest('.pill');
  if (pill) return toggleReaction(msgIdOf(pill), pill.dataset.emoji);
  const replyBtn = e.target.closest('.reply-btn');
  if (replyBtn) {
    const m = findMessage(msgIdOf(replyBtn));
    if (m) startReply(m);
    return;
  }
  const reactBtn = e.target.closest('.react-btn');
  if (reactBtn) {
    const r = reactBtn.getBoundingClientRect();
    openCtxMenu(msgIdOf(reactBtn), r.left + r.width / 2, r.top);
  }
});

// دابل‌کلیک = ری‌اکشن سریع (مثل تلگرام)
box.addEventListener('dblclick', (e) => {
  if (lastPointer === 'touch') return;
  const b = e.target.closest('.bubble');
  if (!b || isInteractive(e.target)) return;
  window.getSelection()?.removeAllRanges();
  toggleReaction(msgIdOf(b), QUICK_REACTION);
});

// کلیک راست = منوی پیام
box.addEventListener('contextmenu', (e) => {
  const b = e.target.closest('.bubble');
  if (!b) return;
  e.preventDefault();
  openCtxMenu(msgIdOf(b), e.clientX, e.clientY);
});

// موبایل: لمس طولانی = منوی پیام، دو بار ضربه = ری‌اکشن سریع
box.addEventListener('touchstart', (e) => {
  const b = e.target.closest('.bubble');
  if (!b || e.target.closest('.pill, .mention')) return;
  const id = msgIdOf(b), t = e.touches[0];
  pressTimer = setTimeout(() => {
    pressTimer = null;
    navigator.vibrate?.(12);
    openCtxMenu(id, t.clientX, t.clientY);
  }, 450);
}, { passive: true });

['touchmove', 'touchcancel'].forEach((ev) =>
  box.addEventListener(ev, () => { clearTimeout(pressTimer); pressTimer = null; }, { passive: true }));

box.addEventListener('touchend', (e) => {
  if (!pressTimer) {
    // لمس طولانی بوده؛ جلوی باز شدن لینک/عکس را بگیر
    if (!ctx.classList.contains('hidden')) e.preventDefault();
    return;
  }
  clearTimeout(pressTimer);
  pressTimer = null;
  const b = e.target.closest('.bubble');
  if (!b || isInteractive(e.target)) return;
  const id = msgIdOf(b), now = Date.now();
  if (lastTap.id === id && now - lastTap.t < 320) {
    toggleReaction(id, QUICK_REACTION);
    lastTap = { id: null, t: 0 };
  } else {
    lastTap = { id, t: now };
  }
});

// ───────────── رویدادهای سراسری ─────────────
document.addEventListener('pointerdown', (e) => {
  if (!ctx.contains(e.target) && !e.target.closest('.react-btn')) closeCtxMenu();
  if (!$('#menu').contains(e.target) && !$('#menuBtn').contains(e.target)) $('#menu').classList.add('hidden');
  if (!$('#attachMenu').contains(e.target) && !$('#attachBtn').contains(e.target)) $('#attachMenu').classList.add('hidden');
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('#lightbox').classList.contains('hidden')) return closeLightbox();
  if (!ctx.classList.contains('hidden')) return closeCtxMenu();
  if (openProfileId) return closeUserModal();
  if (state.replyTo) return clearReply();
  $('#menu').classList.add('hidden');
  $('#attachMenu').classList.add('hidden');
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.activeId) markRead(state.activeId);
});

boot();
