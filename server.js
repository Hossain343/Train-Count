'use strict';

/**
 * Train Count — attendance server.
 * Zero external dependencies: built-in http + JSON file store + signed cookies.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Jalali = require('./lib/jalali');

/* ------------------------------------------------------------------ config */

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const WEB_DIR = path.join(ROOT, 'web');
const LIB_DIR = path.join(ROOT, 'lib');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SECRET_FILE = path.join(DATA_DIR, 'secret.key');

// decoy credentials so that unknown usernames take as long as wrong passwords
const DECOY_SALT = crypto.randomBytes(16).toString('hex');

const SESSION_COOKIE = 'tc_session';
const SESSION_TTL_MS = 60 * 24 * 60 * 60 * 1000; // 60 days — "login once, stay logged in"
const MAX_BODY_BYTES = 256 * 1024;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_FAILS = 8;

/**
 * Accounts are created once, on the very first run — and this repository ships
 * **no hard-coded credentials**.
 *
 *  1) Recommended: define them with the SEED_ACCOUNTS environment variable:
 *
 *       SEED_ACCOUNTS='[
 *         {"username":"admin","name":"Admin","password":"a-strong-password"},
 *         {"username":"teacher","name":"Teacher","password":"another-password"}
 *       ]' npm start
 *
 *  2) If SEED_ACCOUNTS is not set, a single account is created from
 *     ADMIN_USERNAME / ADMIN_PASSWORD (defaults: "admin"), and when no password
 *     is given a random one is generated and printed to the console exactly
 *     once — so nothing secret ever lives in the repository.
 */
function resolveSeedUsers() {
  const raw = process.env.SEED_ACCOUNTS;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const clean = parsed
          .filter((u) => u && typeof u.username === 'string' && typeof u.password === 'string' && u.password.length >= 4)
          .map((u) => ({
            username: String(u.username).trim().toLowerCase(),
            name: String(u.name || u.username),
            password: String(u.password),
          }));
        if (clean.length) return clean;
      }
      console.warn('[train-count] SEED_ACCOUNTS was ignored: expected a non-empty JSON array of accounts.');
    } catch (err) {
      console.warn('[train-count] SEED_ACCOUNTS was ignored: not valid JSON.');
    }
  }

  const given = process.env.ADMIN_PASSWORD;
  return [
    {
      username: String(process.env.ADMIN_USERNAME || 'admin').trim().toLowerCase(),
      name: String(process.env.ADMIN_NAME || 'Administrator'),
      password: given || crypto.randomBytes(12).toString('base64url'),
      generated: !given,
    },
  ];
}

const SEED_USERS = resolveSeedUsers();
let freshDb = false;

/* ----------------------------------------------------------------- helpers */

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || 'error';
  }
}

const nowIso = () => new Date().toISOString();
const newId = (prefix) => prefix + crypto.randomBytes(8).toString('hex');

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/* --------------------------------------------------------------- data store */

let db = null;
let SECRET = '';

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function createEmptyDb() {
  return {
    version: 1,
    createdAt: nowIso(),
    users: SEED_USERS.map((u) => {
      const salt = crypto.randomBytes(16).toString('hex');
      return { username: u.username, name: u.name, salt, passwordHash: hashPassword(u.password, salt) };
    }),
    students: [],
    attendance: {},
    sessions: {},
  };
}

function saveDb() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, DB_FILE);
}

function normalizeDb() {
  if (!db || typeof db !== 'object') db = createEmptyDb();
  if (!Array.isArray(db.users) || db.users.length === 0) db.users = createEmptyDb().users;
  if (!Array.isArray(db.students)) db.students = [];
  if (!db.attendance || typeof db.attendance !== 'object') db.attendance = {};
  if (!db.sessions || typeof db.sessions !== 'object') db.sessions = {};
  const now = Date.now();
  for (const sid of Object.keys(db.sessions)) {
    const s = db.sessions[sid];
    if (!s || typeof s.exp !== 'number' || s.exp < now) delete db.sessions[sid];
  }
  db.students = db.students.filter((s) => s && typeof s.id === 'string');
  for (const s of db.students) {
    s.weekdays = Array.isArray(s.weekdays)
      ? [...new Set(s.weekdays.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b)
      : [];
    s.cls = typeof s.cls === 'string' ? s.cls : '';
    s.active = s.active !== false;
  }
}

function loadDb() {
  ensureDirs();
  if (fs.existsSync(DB_FILE)) {
    try {
      db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (err) {
      const backup = DB_FILE + '.corrupt-' + Date.now();
      fs.copyFileSync(DB_FILE, backup);
      console.error('[train-count] db.json was corrupt; a backup was written to:', backup);
      db = createEmptyDb();
    }
  } else {
    db = createEmptyDb();
    freshDb = true;
  }
  normalizeDb();
  saveDb();
}

function loadSecret() {
  ensureDirs();
  if (fs.existsSync(SECRET_FILE)) {
    const s = fs.readFileSync(SECRET_FILE, 'utf8').trim();
    if (s.length >= 32) return s;
  }
  const s = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(SECRET_FILE, s, { mode: 0o600 });
  return s;
}

/* ------------------------------------------------------------------ session */

function signPayload(payload) {
  return crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}

function createSessionToken(username) {
  const sid = crypto.randomBytes(18).toString('base64url');
  const exp = Date.now() + SESSION_TTL_MS;
  // sessions live in the store, so "logout" really revokes the cookie
  db.sessions[sid] = { u: username, exp, createdAt: nowIso() };
  const payload = Buffer.from(JSON.stringify({ sid, exp }), 'utf8').toString('base64url');
  return payload + '.' + signPayload(payload);
}

function readSessionPayload(req) {
  const raw = parseCookies(req)[SESSION_COOKIE];
  if (!raw) return null;
  const idx = raw.lastIndexOf('.');
  if (idx <= 0) return null;
  const payload = raw.slice(0, idx);
  const sig = raw.slice(idx + 1);
  if (!safeEqual(sig, signPayload(payload))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data || typeof data.sid !== 'string' || typeof data.exp !== 'number') return null;
    if (data.exp < Date.now()) return null;
    return data;
  } catch (err) {
    return null;
  }
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  }
  return out;
}

function currentUser(req) {
  const data = readSessionPayload(req);
  if (!data) return null;
  const session = db.sessions[data.sid];
  if (!session || session.exp < Date.now()) return null;
  const user = db.users.find((u) => u.username === session.u);
  if (!user) return null;
  return { username: user.username, name: user.name || user.username };
}

/* ----------------------------------------------------------- rate limiting */

const loginAttempts = new Map(); // key -> { fails, firstAt }

function loginBlockedKey(req, username) {
  const ip = req.socket.remoteAddress || 'unknown';
  return ip + '|' + username;
}

function checkLoginRate(req, username) {
  const key = loginBlockedKey(req, username);
  const entry = loginAttempts.get(key);
  if (!entry) return;
  if (Date.now() - entry.firstAt > LOGIN_WINDOW_MS) {
    loginAttempts.delete(key);
    return;
  }
  if (entry.fails >= LOGIN_MAX_FAILS) {
    throw new HttpError(429, 'تلاش‌های ناموفق زیاد بود. چند دقیقه بعد دوباره امتحان کنید.');
  }
}

function noteLoginFail(req, username) {
  const key = loginBlockedKey(req, username);
  const entry = loginAttempts.get(key);
  if (!entry || Date.now() - entry.firstAt > LOGIN_WINDOW_MS) {
    loginAttempts.set(key, { fails: 1, firstAt: Date.now() });
  } else {
    entry.fails += 1;
  }
}

function clearLoginFails(req, username) {
  loginAttempts.delete(loginBlockedKey(req, username));
}

/* -------------------------------------------------------------- validation */

function parseStudentInput(body, partial) {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);

  if (!partial || has('name')) {
    const name = String(body.name ?? '').trim().replace(/\s+/g, ' ');
    if (name.length < 2) throw new HttpError(400, 'نام شاگرد را وارد کنید (حداقل ۲ حرف).');
    if (name.length > 60) throw new HttpError(400, 'نام شاگرد حداکثر می‌تواند ۶۰ حرف باشد.');
    out.name = name;
  }

  if (!partial || has('cls')) {
    const cls = String(body.cls ?? '').trim().replace(/\s+/g, ' ');
    if (cls.length > 40) throw new HttpError(400, 'نام کلاس حداکثر ۴۰ حرف است.');
    out.cls = cls;
  }

  if (!partial || has('weekdays')) {
    const raw = body.weekdays ?? [];
    if (!Array.isArray(raw)) throw new HttpError(400, 'روزهای هفته نامعتبر است.');
    const set = new Set();
    for (const item of raw) {
      const n = Number(item);
      if (!Number.isInteger(n) || n < 0 || n > 6) throw new HttpError(400, 'شماره روز هفته نامعتبر است.');
      set.add(n);
    }
    out.weekdays = [...set].sort((a, b) => a - b);
  }

  if (!partial || has('active')) {
    out.active = body.active === undefined ? true : Boolean(body.active);
  }

  return out;
}

function parseDateParam(value) {
  const parsed = Jalali.parse(value);
  if (!parsed) throw new HttpError(400, 'تاریخ نامعتبر است. قالب درست: YYYY-MM-DD (شمسی)');
  return Jalali.format(parsed.jy, parsed.jm, parsed.jd);
}

function findStudent(id) {
  const student = db.students.find((s) => s.id === id);
  if (!student) throw new HttpError(404, 'شاگرد پیدا نشد.');
  return student;
}

/* ------------------------------------------------------------ computations */

function dayRecord(date) {
  return db.attendance[date] || null;
}

function ensureDayRecord(date, username) {
  if (!db.attendance[date]) {
    db.attendance[date] = { records: {}, extras: [], createdAt: nowIso(), updatedAt: nowIso(), updatedBy: username };
  }
  const rec = db.attendance[date];
  if (!rec.records || typeof rec.records !== 'object') rec.records = {};
  if (!Array.isArray(rec.extras)) rec.extras = [];
  return rec;
}

function pruneDayRecord(date) {
  const rec = db.attendance[date];
  if (!rec) return;
  const hasRecords = Object.keys(rec.records || {}).length > 0;
  const hasExtras = (rec.extras || []).length > 0;
  if (!hasRecords && !hasExtras) delete db.attendance[date];
}

function computeDay(date) {
  const { jy, jm, jd } = Jalali.parse(date);
  const weekday = Jalali.weekday(jy, jm, jd);
  const rec = dayRecord(date);
  const records = (rec && rec.records) || {};
  const extras = new Set((rec && rec.extras) || []);

  const rows = [];
  for (const s of db.students) {
    const scheduled = s.active && s.weekdays.includes(weekday);
    const isExtra = extras.has(s.id);
    const marked = records[s.id];
    if (!scheduled && !isExtra && !marked) continue;
    rows.push({
      id: s.id,
      name: s.name,
      cls: s.cls || '',
      weekdays: s.weekdays,
      active: s.active,
      scheduled,
      extra: isExtra && !scheduled,
      status: marked ? marked.status : 'none',
      markedAt: marked ? marked.at : null,
      source: isExtra ? 'extra' : scheduled ? 'schedule' : 'manual',
    });
  }

  rows.sort((a, b) => a.name.localeCompare(b.name, 'fa'));

  const summary = { total: rows.length, present: 0, absent: 0, unmarked: 0, extra: 0 };
  for (const r of rows) {
    if (r.status === 'present') summary.present += 1;
    else if (r.status === 'absent') summary.absent += 1;
    else summary.unmarked += 1;
    if (r.extra) summary.extra += 1;
  }

  return {
    date,
    jy,
    jm,
    jd,
    weekday,
    weekdayName: Jalali.WEEKDAY_NAMES[weekday],
    monthName: Jalali.MONTH_NAMES[jm - 1],
    label: Jalali.longLabel(jy, jm, jd),
    students: rows,
    summary,
    updatedAt: rec ? rec.updatedAt : null,
    updatedBy: rec ? rec.updatedBy : null,
    recorded: Boolean(rec),
  };
}

function computeMonth(jy, jm) {
  if (!Number.isInteger(jy) || jy < 1200 || jy > 1600) throw new HttpError(400, 'سال نامعتبرد است.');
  if (!Number.isInteger(jm) || jm < 1 || jm > 12) throw new HttpError(400, 'ماه نامعتبر است.');
  const length = Jalali.monthLength(jy, jm);
  const days = [];
  const totals = { present: 0, absent: 0, expected: 0, recordedDays: 0, extras: 0 };

  for (let d = 1; d <= length; d += 1) {
    const date = Jalali.format(jy, jm, d);
    const weekday = Jalali.weekday(jy, jm, d);
    const rec = dayRecord(date);
    const records = (rec && rec.records) || {};
    const extras = (rec && rec.extras) || [];
    const extrasCount = extras.filter((id) => {
      const s = db.students.find((x) => x.id === id);
      return s && !(s.active && s.weekdays.includes(weekday));
    }).length;

    const expected = db.students.filter((s) => s.active && s.weekdays.includes(weekday)).length + extrasCount;

    let present = 0;
    let absent = 0;
    for (const s of db.students) {
      const marked = records[s.id];
      if (!marked) continue;
      if (marked.status === 'present') present += 1;
      else if (marked.status === 'absent') absent += 1;
    }

    totals.present += present;
    totals.absent += absent;
    totals.expected += expected;
    totals.extras += extrasCount;
    if (present || absent || extrasCount) totals.recordedDays += 1;

    days.push({ date, jd: d, weekday, expected, present, absent, extras: extrasCount, recorded: Boolean(present || absent || extrasCount) });
  }

  return {
    jy,
    jm,
    monthName: Jalali.MONTH_NAMES[jm - 1],
    length,
    days,
    totals,
  };
}

/* ------------------------------------------------------------- http helpers */

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendError(res, err) {
  const status = err instanceof HttpError ? err.status : 500;
  if (status >= 500) console.error('[train-count]', err);
  sendJson(res, status, { error: err.message || 'خطای غیرمنتظره', code: err.code || 'error' });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'حجم درخواست بیش از حد مجاز است.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        const parsed = JSON.parse(text);
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch (err) {
        reject(new HttpError(400, 'بدنه درخواست JSON معتبر نیست.'));
      }
    });
    req.on('error', () => reject(new HttpError(400, 'خطا در دریافت درخواست.')));
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function serveFile(res, filePath, { immutable = false } = {}) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    throw new HttpError(404, 'فایل پیدا نشد.');
  }
  if (!stat.isFile()) throw new HttpError(404, 'فایل پیدا نشد.');
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': immutable ? 'public, max-age=3600' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  fs.createReadStream(filePath).pipe(res);
}

function serveStatic(res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;

  // shared Jalali helper is required by both server and browser
  if (rel === '/lib/jalali.js') return serveFile(res, path.join(LIB_DIR, 'jalali.js'));

  const filePath = path.resolve(WEB_DIR, '.' + rel);
  if (filePath !== WEB_DIR && !filePath.startsWith(WEB_DIR + path.sep)) {
    throw new HttpError(404, 'فایل پیدا نشد.');
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    // SPA fallback
    return serveFile(res, path.join(WEB_DIR, 'index.html'));
  }
  return serveFile(res, filePath);
}

/* -------------------------------------------------------------------- API */

const routes = [
  ['POST', /^\/api\/login$/, handleLogin],
  ['POST', /^\/api\/logout$/, handleLogout],
  ['GET', /^\/api\/me$/, handleMe],

  ['GET', /^\/api\/students$/, handleListStudents],
  ['POST', /^\/api\/students$/, handleCreateStudent],
  ['PATCH', /^\/api\/students\/([\w-]+)$/, handleUpdateStudent],
  ['DELETE', /^\/api\/students\/([\w-]+)$/, handleDeleteStudent],

  ['GET', /^\/api\/day$/, handleGetDay],
  ['POST', /^\/api\/day\/marks$/, handleSaveMarks],
  ['POST', /^\/api\/day\/extra$/, handleExtra],

  ['GET', /^\/api\/calendar$/, handleCalendar],
  ['GET', /^\/api\/students\/([\w-]+)$/, handleGetStudent],
];

const PUBLIC_ROUTES = new Set(['POST /api/login', 'GET /api/me']);

async function handleApi(req, res, url, pathname) {
  const method = req.method.toUpperCase();
  const clean = pathname.replace(/\/+$/, '') || '/';

  let matched = null;
  let params = [];
  for (const [verb, pattern, handler] of routes) {
    if (verb !== method) continue;
    const m = pattern.exec(clean);
    if (m) {
      matched = handler;
      params = m.slice(1);
      break;
    }
  }
  if (!matched) throw new HttpError(404, 'مسیر API پیدا نشد.');

  const user = currentUser(req);
  if (!user && !PUBLIC_ROUTES.has(method + ' ' + clean)) {
    throw new HttpError(401, 'ابتدا وارد حساب خود شوید.');
  }

  await matched(req, res, { url, params, user });
}

/* ----------------------------------------------------------------- auth */

async function handleLogin(req, res) {
  const body = await readJsonBody(req);
  const username = String(body.username ?? '').trim().toLowerCase();
  const password = String(body.password ?? '');
  if (!username || !password) throw new HttpError(400, 'نام کاربری و رمز عبور را وارد کنید.');

  checkLoginRate(req, username);

  const user = db.users.find((u) => u.username.toLowerCase() === username);
  // always hash, so "unknown user" and "wrong password" cost the same time
  const candidate = hashPassword(password, user ? user.salt : DECOY_SALT);
  const stored = user ? user.passwordHash : hashPassword('decoy-' + DECOY_SALT, DECOY_SALT);
  const ok = safeEqual(candidate, stored);
  if (!ok) {
    noteLoginFail(req, username);
    throw new HttpError(401, 'نام کاربری یا رمز عبور اشتباه است.');
  }
  clearLoginFails(req, username);

  const token = createSessionToken(user.username);
  saveDb();
  res.setHeader('Set-Cookie', [
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ]);
  sendJson(res, 200, { user: { username: user.username, name: user.name || user.username } });
}

async function handleLogout(req, res) {
  const data = readSessionPayload(req);
  if (data && db.sessions[data.sid]) {
    delete db.sessions[data.sid];
    saveDb();
  }
  res.setHeader('Set-Cookie', [`${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`]);
  sendJson(res, 200, { ok: true });
}

async function handleMe(req, res, ctx) {
  if (!ctx.user) throw new HttpError(401, 'ابتدا وارد حساب خود شوید.');
  const t = Jalali.today();
  sendJson(res, 200, { user: ctx.user, today: Jalali.format(t.jy, t.jm, t.jd), weekday: Jalali.weekday(t.jy, t.jm, t.jd) });
}

/* ------------------------------------------------------------- students */

async function handleListStudents(req, res) {
  const students = [...db.students].sort((a, b) => a.name.localeCompare(b.name, 'fa'));
  sendJson(res, 200, { students, count: students.length });
}

async function handleGetStudent(req, res, ctx) {
  sendJson(res, 200, { student: findStudent(ctx.params[0]) });
}

async function handleCreateStudent(req, res, ctx) {
  const body = await readJsonBody(req);
  const input = parseStudentInput(body, false);
  const student = {
    id: newId('st_'),
    name: input.name,
    cls: input.cls || '',
    weekdays: input.weekdays || [],
    active: input.active,
    createdAt: nowIso(),
    createdBy: ctx.user.username,
  };
  db.students.push(student);
  saveDb();
  sendJson(res, 201, { student });
}

async function handleUpdateStudent(req, res, ctx) {
  const student = findStudent(ctx.params[0]);
  const body = await readJsonBody(req);
  const input = parseStudentInput(body, true);
  if (input.name !== undefined) student.name = input.name;
  if (input.cls !== undefined) student.cls = input.cls;
  if (input.weekdays !== undefined) student.weekdays = input.weekdays;
  if (input.active !== undefined) student.active = input.active;
  student.updatedAt = nowIso();
  student.updatedBy = ctx.user.username;
  saveDb();
  sendJson(res, 200, { student });
}

async function handleDeleteStudent(req, res, ctx) {
  const id = ctx.params[0];
  findStudent(id);
  db.students = db.students.filter((s) => s.id !== id);

  for (const date of Object.keys(db.attendance)) {
    const rec = db.attendance[date];
    if (rec && rec.records && rec.records[id]) delete rec.records[id];
    if (rec && Array.isArray(rec.extras)) rec.extras = rec.extras.filter((x) => x !== id);
    pruneDayRecord(date);
  }

  saveDb();
  sendJson(res, 200, { ok: true, id });
}

/* ----------------------------------------------------------- attendance */

async function handleGetDay(req, res, ctx) {
  const date = parseDateParam(ctx.url.searchParams.get('date'));
  sendJson(res, 200, computeDay(date));
}

async function handleSaveMarks(req, res, ctx) {
  const body = await readJsonBody(req);
  const date = parseDateParam(body.date);
  const marks = body.marks;
  if (!marks || typeof marks !== 'object' || Array.isArray(marks)) {
    throw new HttpError(400, 'ساختار تغییرات حضور نامعتبر است.');
  }
  const entries = Object.entries(marks);
  if (entries.length === 0) return sendJson(res, 200, computeDay(date));
  if (entries.length > 500) throw new HttpError(400, 'تعداد تغییرات بیش از حد مجاز است.');

  const rec = ensureDayRecord(date, ctx.user.username);
  for (const [id, status] of entries) {
    findStudent(id);
    if (status === 'clear' || status === null) {
      delete rec.records[id];
      continue;
    }
    if (status !== 'present' && status !== 'absent') {
      throw new HttpError(400, 'وضعیت حضور نامعتبر است.');
    }
    rec.records[id] = { status, at: nowIso(), by: ctx.user.username };
  }
  rec.updatedAt = nowIso();
  rec.updatedBy = ctx.user.username;
  pruneDayRecord(date);
  saveDb();
  sendJson(res, 200, computeDay(date));
}

async function handleExtra(req, res, ctx) {
  const body = await readJsonBody(req);
  const date = parseDateParam(body.date);
  const studentId = String(body.studentId || '');
  const action = String(body.action || 'add');
  findStudent(studentId);

  const rec = ensureDayRecord(date, ctx.user.username);
  if (action === 'add') {
    if (!rec.extras.includes(studentId)) rec.extras.push(studentId);
  } else if (action === 'remove') {
    rec.extras = rec.extras.filter((id) => id !== studentId);
    // a guest who is no longer part of this day keeps no mark behind
    const student = findStudent(studentId);
    const { jy, jm, jd } = Jalali.parse(date);
    const scheduled = student.active && student.weekdays.includes(Jalali.weekday(jy, jm, jd));
    if (!scheduled) delete rec.records[studentId];
  } else {
    throw new HttpError(400, 'عملیات نامعتبر است.');
  }
  rec.updatedAt = nowIso();
  rec.updatedBy = ctx.user.username;
  pruneDayRecord(date);
  saveDb();
  sendJson(res, 200, computeDay(date));
}

async function handleCalendar(req, res, ctx) {
  const t = Jalali.today();
  const jy = Number(ctx.url.searchParams.get('year') || t.jy);
  const jm = Number(ctx.url.searchParams.get('month') || t.jm);
  sendJson(res, 200, computeMonth(jy, jm));
}

/* ----------------------------------------------------------------- server */

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  } catch (err) {
    return sendJson(res, 400, { error: 'درخواست نامعتبر است.' });
  }

  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch (err) {
    return sendJson(res, 400, { error: 'آدرس نامعتبر است.' });
  }

  if (pathname.startsWith('/api/')) {
    Promise.resolve()
      .then(() => handleApi(req, res, url, pathname))
      .catch((err) => {
        if (!res.headersSent) sendError(res, err);
        else res.end();
      });
    return;
  }

  try {
    serveStatic(res, pathname);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 — پیدا نشد');
    }
    console.error(err);
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('500 — خطای سرور');
  }
});

function start() {
  SECRET = loadSecret();
  loadDb();
  if (freshDb) {
    const generated = SEED_USERS.filter((u) => u.generated);
    if (generated.length) {
      console.log('');
      console.log('  ⚠  A fresh database was created. Save these credentials now:');
      for (const u of generated) {
        console.log('       username: ' + u.username);
        console.log('       password: ' + u.password);
      }
      console.log('     (choose your own next time with SEED_ACCOUNTS or ADMIN_PASSWORD)');
      console.log('');
    } else if (SEED_USERS.length) {
      console.log('[train-count] database created with ' + SEED_USERS.length + ' account(s) from SEED_ACCOUNTS.');
    }
  }
  server.listen(PORT, HOST, () => {
    const addr = server.address();
    console.log(`[train-count] listening on http://${HOST}:${addr.port}`);
    console.log(`[train-count] data dir: ${DATA_DIR}`);
  });
}

if (require.main === module) start();

module.exports = { server, start, Jalali };
