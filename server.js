'use strict';
// Панель управления Moto G60: метрики, сервисы runit, логи.
// Ноль внешних зависимостей — только стандартная библиотека Node.

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const os = require('node:os');
const net = require('node:net');

const PREFIX = process.env.TERMUX_PREFIX || '/data/data/com.termux/files/usr';
const BIN = path.join(PREFIX, 'bin');
const HOME = os.homedir();
const PANEL_DIR = process.env.PANEL_DIR
  ? path.resolve(process.env.PANEL_DIR)
  : path.join(HOME, 'panel');
const PUBLIC_DIR = path.join(PANEL_DIR, 'public');
const AUTH_FILE = path.join(PANEL_DIR, 'auth.json');
const LOGS_DIR = path.join(HOME, 'logs');
const PROJECTS_DIR = path.join(PANEL_DIR, 'projects');
if (!fs.existsSync(PROJECTS_DIR)) fs.mkdirSync(PROJECTS_DIR, { recursive: true });
const SVDIR = path.join(PREFIX, 'var', 'service');

const HOST = process.env.PANEL_HOST || '0.0.0.0';
const PORT = Number(process.env.PANEL_PORT || 8081);

const CONTROLLED_SERVICES = new Set(['postgres', 'redis', 'nginx', 'sshd', 'panel', 'gordaya']);
const ACTIONS = new Set(['start', 'stop', 'restart']);

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_FAILED = 5;
const LOCKOUT_MS = 5 * 60 * 1000;
const METRICS_TTL_MS = 2000;

const sessions = new Map();      // sid -> { csrf, exp }
const failed = new Map();        // ip -> { count, until }
let metricsCache = { at: 0, data: null };

// ---------- вспомогательное ----------

function run(cmd, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, {
      timeout,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, PATH: `${BIN}:/system/bin` },
    }, (err, stdout) => resolve(err ? null : stdout));
  });
}

const bin = (name) => path.join(BIN, name);

function clientIp(req) {
  return req.socket.remoteAddress || 'unknown';
}

function isLocked(ip) {
  const rec = failed.get(ip);
  if (!rec) return false;
  if (rec.until && Date.now() < rec.until) return true;
  if (rec.until && Date.now() >= rec.until) failed.delete(ip);
  return false;
}

function noteFailure(ip) {
  const rec = failed.get(ip) || { count: 0, until: 0 };
  rec.count += 1;
  if (rec.count >= MAX_FAILED) {
    rec.until = Date.now() + LOCKOUT_MS;
    rec.count = 0;
  }
  failed.set(ip, rec);
}

function clearFailures(ip) {
  failed.delete(ip);
}

// ---------- аутентификация ----------

function loadAuth() {
  try {
    const raw = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    if (raw && raw.salt && raw.hash) return raw;
  } catch (e) { /* файла ещё нет */ }
  return null;
}

function savePassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  const record = { salt, hash, updated: Date.now() };
  fs.writeFileSync(AUTH_FILE, JSON.stringify(record, null, 2), { mode: 0o600 });
  fs.chmodSync(AUTH_FILE, 0o600);
  return record;
}

function verifyPassword(password, record) {
  if (!record) return false;
  const candidate = crypto.scryptSync(password, record.salt, 64);
  const stored = Buffer.from(record.hash, 'hex');
  if (candidate.length !== stored.length) return false;
  return crypto.timingSafeEqual(candidate, stored);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function currentSession(req) {
  const sid = parseCookies(req.headers.cookie).sid;
  if (!sid) return null;
  const s = sessions.get(sid);
  if (!s) return null;
  if (Date.now() > s.exp) { sessions.delete(sid); return null; }
  return { sid, ...s };
}

function send(res, code, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': typeof body === 'object' && !Buffer.isBuffer(body)
      ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function sendJson(res, code, obj, headers = {}) {
  send(res, code, obj, {
    'Content-Type': 'application/json; charset=utf-8',
    ...headers,
  });
}

async function readBody(req, limit = 4096) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('payload too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch (e) { throw new Error('invalid json'); }
}

// ---------- сбор метрик ----------

async function readThermal() {
  const out = [];
  let names;
  try { names = await fsp.readdir('/sys/class/thermal'); } catch (e) { return out; }
  for (const name of names) {
    if (!name.startsWith('thermal_zone')) continue;
    const dir = path.join('/sys/class/thermal', name);
    let type = name, temp = null;
    try { type = (await fsp.readFile(path.join(dir, 'type'), 'utf8')).trim(); } catch (e) {}
    try {
      const raw = (await fsp.readFile(path.join(dir, 'temp'), 'utf8')).trim();
      const milli = Number(raw);
      if (Number.isFinite(milli)) temp = milli / 1000;
    } catch (e) {}
    if (temp !== null) out.push({ zone: name, type, celsius: temp });
  }
  return out;
}

async function readCpuFreq() {
  const out = [];
  for (let i = 0; i < 16; i++) {
    const base = `/sys/devices/system/cpu/cpu${i}/cpufreq`;
    let khz = null;
    try {
      const v = Number((await fsp.readFile(`${base}/scaling_cur_freq`, 'utf8')).trim());
      if (Number.isFinite(v)) khz = v;
    } catch (e) { break; }
    if (khz === null) break;
    // Максимум берём у каждого ядра свой: у больших ядер он выше, чем у малых.
    let maxKhz = null;
    try {
      const v = Number((await fsp.readFile(`${base}/cpuinfo_max_freq`, 'utf8')).trim());
      if (Number.isFinite(v) && v > 0) maxKhz = v;
    } catch (e) { /* необязательно */ }
    out.push({
      cpu: i,
      mhz: +(khz / 1000).toFixed(0),
      max_mhz: maxKhz ? +(maxKhz / 1000).toFixed(0) : null,
    });
  }
  return out;
}

async function readNetwork() {
  const raw = await run(bin('ip'), ['-s', 'link', 'show', 'wlan0']);
  if (!raw) return null;
  const rx = /RX:\s+bytes packets[\s\S]*?^\s*(\d+)/m.exec(raw);
  const tx = /TX:\s+bytes packets[\s\S]*?^\s*(\d+)/m.exec(raw);
  const rxLine = /RX:\s+bytes packets errors dropped missed mcast\s*\n\s*(\d+)\s+(\d+)/.exec(raw);
  const txLine = /TX:\s+bytes packets errors dropped carrier collsns\s*\n\s*(\d+)\s+(\d+)/.exec(raw);
  return {
    rx_bytes: rxLine ? Number(rxLine[1]) : (rx ? Number(rx[1]) : null),
    rx_packets: rxLine ? Number(rxLine[2]) : null,
    tx_bytes: txLine ? Number(txLine[1]) : (tx ? Number(tx[1]) : null),
    tx_packets: txLine ? Number(txLine[2]) : null,
  };
}

async function readMemory() {
  const raw = await fsp.readFile('/proc/meminfo', 'utf8').catch(() => '');
  if (!raw) return null;
  const get = (key) => {
    const m = new RegExp(`^${key}:\\s+(\\d+) kB`, 'm').exec(raw);
    return m ? Number(m[1]) * 1024 : 0;
  };
  const total = get('MemTotal');
  const available = get('MemAvailable');
  const free = get('MemFree');
  const cached = get('Cached') + get('Buffers');
  return {
    total, available, free, cached,
    used: total - available,
    swap_total: get('SwapTotal'),
    swap_free: get('SwapFree'),
    swap_used: get('SwapTotal') - get('SwapFree'),
  };
}

async function readDisk() {
  const raw = await run(bin('df'), ['-k', PREFIX]);
  if (!raw) return null;
  const lines = raw.trim().split('\n');
  const last = lines[lines.length - 1].trim().split(/\s+/);
  if (last.length < 6) return null;
  return {
    // df -k отдаёт килобайты, а наружу metrics всегда отдаёт байты —
    // так же, как память и сеть. Не называем поля *_kb, чтобы не путать.
    total_bytes: Number(last[1]) * 1024,
    used_bytes: Number(last[2]) * 1024,
    avail_bytes: Number(last[3]) * 1024,
    used_percent: parseInt(last[4], 10),
  };
}

// Android 12 по SELinux не даёт приложению читать /proc/stat, /proc/loadavg
// и /proc/<pid>/stat, поэтому настоящий процент загрузки CPU недоступен:
// `top -bn1` в этой ситуации рисует нули. Из достоверных источников остаются
// load average (через syscall sysinfo, поэтому `uptime` работает) и частоты
// ядер из sysfs. Показываем именно их, а не выдуманный процент.
async function readCpu() {
  const upRaw = await run(bin('uptime'), []);
  let uptime = null, loadavg = null;
  if (upRaw) {
    const u = /up\s+(.+?),\s+\d+\s+user/.exec(upRaw);
    const l = /load average:\s+([0-9.]+)[,\s]+([0-9.]+)[,\s]+([0-9.]+)/.exec(upRaw);
    if (u) uptime = u[1].trim();
    if (l) loadavg = [Number(l[1]), Number(l[2]), Number(l[3])];
  }

  let maxKhz = null;
  try {
    const raw = await fsp.readFile('/sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq', 'utf8');
    const v = Number(raw.trim());
    if (Number.isFinite(v) && v > 0) maxKhz = v;
  } catch (e) { /* необязательно */ }

  const freq = await readCpuFreq();
  // Нормируем каждое ядро по его собственному максимуму, иначе большие ядра
  // дают больше 1.0 — у них потолок выше, чем у малых.
  const ratios = freq
    .filter((f) => f.max_mhz && f.mhz > 0)
    .map((f) => Math.min(1.2, f.mhz / f.max_mhz));
  const activity = ratios.length
    ? +(ratios.reduce((a, b) => a + b, 0) / ratios.length).toFixed(3)
    : null;

  // load average считается по всем ядрам системы, поэтому и нормируем по ним.
  const cores = Array.isArray(os.cpus()) && os.cpus().length ? os.cpus().length : 8;

  return { loadavg, uptime, freq, activity, cores };
}

async function readBattery() {
  const raw = await run(bin('termux-battery-status'), [], 10000);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

async function collectMetrics() {
  if (Date.now() - metricsCache.at < METRICS_TTL_MS && metricsCache.data) {
    return metricsCache.data;
  }
  const [cpu, memory, disk, network, thermal, battery] = await Promise.all([
    readCpu(), readMemory(), readDisk(), readNetwork(), readThermal(), readBattery(),
  ]);
  const hostname = os.hostname();
  const data = {
    at: Date.now(),
    host: (!hostname || hostname === 'localhost') ? 'moto-g60' : hostname,
    cpu, memory, disk, network, thermal, battery,
    reboot_supported: fs.existsSync(bin('termux-reboot')),
  };
  metricsCache = { at: Date.now(), data };
  return data;
}

// ---------- сервисы runit ----------

const SV_ACTIONS = { start: 'up', stop: 'down', restart: 'restart' };

function parseSvStatus(text) {
  const first = text.split(';')[0].trim();
  const state = first.startsWith('run:') ? 'run' : 'down';
  const pid = /\(pid (\d+)\)/.exec(first);
  // runit печатает возраст процесса так: run: nginx: (pid 123) 2hours
  const since = /\)\s+(\d+)\s*(s|sec|min|hour|hours|day|days)\b/.exec(first);
  const UNITS = { s: 1, sec: 1, min: 60, hour: 3600, hours: 3600, day: 86400, days: 86400 };
  const sinceSeconds = since ? Number(since[1]) * (UNITS[since[2]] || 1) : null;
  return {
    state,
    pid: pid ? Number(pid[1]) : null,
    since_seconds: sinceSeconds,
    raw: first,
  };
}

const SERVICE_PATTERNS = {
  gordaya: [/next-server/, 3000],
  nginx: [/nginx: master/, 8080],
  panel: [/panel\/server\.js/, 8081],
  redis: [/redis-server/, 6379],
  postgres: [/postgres(?:\s+-D|$)/, 5432],
  sshd: [/sshd\s+-D/, 8022],
  'ssh-agent': [/ssh-agent/, null],
  cloudflared: [/cloudflared.*tunnel/, null],
};

async function listServices() {
  let names = [];
  try {
    names = (await fsp.readdir(SVDIR, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && d.name !== 'log').map((d) => d.name);
  } catch (e) { return []; }

  // Добавляем cloudflared если его нет в names
  if (!names.includes('cloudflared')) names.push('cloudflared');

  // Получаем список запущенных процессов один раз для всех сервисов
  const psOutput = await run('/system/bin/ps', ['-ef'], 4000) || await run('/data/data/com.termux/files/usr/bin/ps', ['-ef'], 4000) || '';
  const psLines = psOutput.split('\n');

  const services = await Promise.all(names.map(async (name) => {
    let parsed = { state: 'down', pid: null, since_seconds: null, raw: '' };

    // 1. Попытка через sv status
    const raw = await run(bin('sv'), ['status', name], 2000);
    if (raw && raw.trim().startsWith('run:')) {
      parsed = parseSvStatus(raw);
    } else {
      // 2. Фоллбек: поиск в списке процессов
      const patternEntry = SERVICE_PATTERNS[name];
      const regex = patternEntry ? patternEntry[0] : new RegExp(name, 'i');
      const port = patternEntry ? patternEntry[1] : null;

      let foundPid = null;
      for (const line of psLines) {
        if (regex.test(line) && !line.includes('grep') && !line.includes(' sv ')) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 2 && !isNaN(parts[1])) {
            foundPid = Number(parts[1]);
            break;
          }
        }
      }

      if (foundPid) {
        parsed = { state: 'run', pid: foundPid, since_seconds: null, raw: `process ${foundPid}` };
      } else if (port) {
        const isPortLive = await checkPort(port);
        if (isPortLive) {
          parsed = { state: 'run', pid: null, since_seconds: null, raw: `port ${port} open` };
        }
      }
    }

    return {
      name,
      state: parsed.state,
      pid: parsed.pid,
      since_seconds: parsed.since_seconds,
      controlled: CONTROLLED_SERVICES.has(name),
      raw: parsed.raw,
    };
  }));

  return services.sort((a, b) => a.name.localeCompare(b.name));
}

async function readLog(name, lines = 200) {
  const file = path.join(LOGS_DIR, `${name}.txt`);
  const raw = await fsp.readFile(file, 'utf8').catch(() => null);
  if (raw === null) return { name, available: false, lines: [] };
  const all = raw.split('\n');
  return { name, available: true, lines: all.slice(-lines) };
}


function checkPort(port, host = '127.0.0.1', timeout = 800) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let status = false;
    socket.setTimeout(timeout);
    socket.once('connect', () => { status = true; socket.destroy(); });
    socket.once('timeout', () => { socket.destroy(); });
    socket.once('error', () => { socket.destroy(); });
    socket.once('close', () => resolve(status));
    socket.connect(port, host);
  });
}

async function listProjects() {
  if (!fs.existsSync(PROJECTS_DIR)) return [];
  const files = await fsp.readdir(PROJECTS_DIR).catch(() => []);
  const projects = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const raw = await fsp.readFile(path.join(PROJECTS_DIR, file), 'utf8');
      const p = JSON.parse(raw);
      if (p && p.port) {
        p.live = await checkPort(p.port);
      } else {
        p.live = false;
      }
      projects.push(p);
    } catch (e) {}
  }
  return projects;
}

// ---------- HTTP ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

async function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, 'forbidden');
  const data = await fsp.readFile(file).catch(() => null);
  if (!data) return send(res, 404, 'not found');
  send(res, 200, data, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); }
  catch (e) { return send(res, 400, 'bad request'); }
  const p = url.pathname;
  const method = req.method;

  try {
    // --- вход ---
    if (p === '/api/login' && method === 'POST') {
      const ip = clientIp(req);
      if (isLocked(ip)) return sendJson(res, 429, { error: 'слишком много попыток, подожди 5 минут' });
      const body = await readBody(req);
      const record = loadAuth();
      if (!record) return sendJson(res, 503, { error: 'пароль не задан' });
      if (!verifyPassword(String(body.password || ''), record)) {
        noteFailure(ip);
        return sendJson(res, 401, { error: 'неверный пароль' });
      }
      clearFailures(ip);
      const sid = crypto.randomBytes(32).toString('hex');
      const csrf = crypto.randomBytes(24).toString('hex');
      sessions.set(sid, { csrf, exp: Date.now() + SESSION_TTL_MS });
      return sendJson(res, 200, { ok: true }, {
        'Set-Cookie': `sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`,
      });
    }

    // --- всё остальное требует сессии ---
    const session = currentSession(req);
    if (!session) {
      if (p.startsWith('/api/')) return sendJson(res, 401, { error: 'требуется вход' });
      return serveStatic(res, p === '/' || p === '/login' ? '/' : p);
    }

    if (p === '/api/session' && method === 'GET') {
      return sendJson(res, 200, { authenticated: true, csrf: session.csrf });
    }

    if (p === '/api/logout' && method === 'POST') {
      if (session.csrf !== url.searchParams.get('csrf')) return sendJson(res, 403, { error: 'bad csrf' });
      sessions.delete(session.sid);
      return sendJson(res, 200, { ok: true }, {
        'Set-Cookie': 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
      });
    }

    if (p === '/api/password' && method === 'POST') {
      const body = await readBody(req);
      if (body.csrf !== session.csrf) return sendJson(res, 403, { error: 'bad csrf' });
      const record = loadAuth();
      if (!verifyPassword(String(body.current || ''), record)) {
        return sendJson(res, 401, { error: 'текущий пароль неверен' });
      }
      const next = String(body.next || '');
      if (next.length < 8) return sendJson(res, 400, { error: 'новый пароль короче 8 символов' });
      savePassword(next);
      // После смены пароля все прочие сессии обрываем.
      for (const [sid, s] of sessions) if (sid !== session.sid) sessions.delete(sid);
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/metrics' && method === 'GET') {
      return sendJson(res, 200, await collectMetrics());
    }

    if (p === '/api/services' && method === 'GET') {
      return sendJson(res, 200, { services: await listServices() });
    }

    if (p === '/api/service' || p.startsWith('/api/service/')) {
      if (method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
      const body = await readBody(req);
      if (body.csrf !== session.csrf) return sendJson(res, 403, { error: 'bad csrf' });
      const name = String(body.name || '');
      const action = String(body.action || '');
      if (!CONTROLLED_SERVICES.has(name)) {
        return sendJson(res, 403, { error: `сервис ${name} не в белом списке` });
      }
      if (!ACTIONS.has(action)) return sendJson(res, 400, { error: 'неизвестное действие' });
      const out = await run(bin('sv'), [SV_ACTIONS[action], name], 15000);
      return sendJson(res, 200, { ok: true, name, action, output: out || '', error: out ? null : 'sv вернул ошибку' });
    }

    if (p.startsWith('/api/logs/')) {
      if (method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
      const name = path.basename(decodeURIComponent(p.slice('/api/logs/'.length)));
      const limit = Math.min(Number(url.searchParams.get('lines') || 200), 1000);
      return sendJson(res, 200, await readLog(name, limit));
    }

    if (p === '/api/reboot' && method === 'POST') {
      const body = await readBody(req);
      if (body.csrf !== session.csrf) return sendJson(res, 403, { error: 'bad csrf' });
      if (String(body.confirm || '') !== 'REBOOT') {
        return sendJson(res, 400, { error: 'введите слово REBOOT для подтверждения' });
      }
      if (!fs.existsSync(bin('termux-reboot'))) {
        return sendJson(res, 501, {
          error: 'перезагрузка недоступна: в этой сборке Termux нет команды termux-reboot, '
               + 'а sys.powerctl требует root. Перезагрузи телефон вручную.',
        });
      }
      await run(bin('termux-reboot'), [], 5000);
      return sendJson(res, 200, { ok: true });
    }

    
    if (p === '/api/projects' && method === 'GET') {
      const projects = await listProjects();
      return sendJson(res, 200, { projects });
    }

    if (p === '/api/projects' && method === 'POST') {
      const body = await readBody(req);
      if (body.csrf !== session.csrf) return sendJson(res, 403, { error: 'bad csrf' });
      const id = String(body.id || '').trim().replace(/[^a-z0-9_-]/gi, '');
      if (!id) return sendJson(res, 400, { error: 'invalid id' });
      const record = {
        id,
        name: String(body.name || id),
        description: String(body.description || ''),
        port: Number(body.port || 0),
        domain: String(body.domain || ''),
        type: String(body.type || 'node'),
        runit_service: String(body.runit_service || ''),
        tags: Array.isArray(body.tags) ? body.tags : [],
        updated_at: Date.now()
      };
      if (record.runit_service && !CONTROLLED_SERVICES.has(record.runit_service)) {
        CONTROLLED_SERVICES.add(record.runit_service);
      }
      await fsp.writeFile(path.join(PROJECTS_DIR, id + '.json'), JSON.stringify(record, null, 2), 'utf8');
      return sendJson(res, 200, { ok: true, project: record });
    }

    if (p.startsWith('/api/projects/') && method === 'DELETE') {
      const body = await readBody(req);
      if (body.csrf !== session.csrf) return sendJson(res, 403, { error: 'bad csrf' });
      const id = path.basename(decodeURIComponent(p.slice('/api/projects/'.length)));
      const file = path.join(PROJECTS_DIR, id + '.json');
      if (fs.existsSync(file)) {
        await fsp.unlink(file);
      }
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/all' && method === 'GET') {
      const [metrics, svc] = await Promise.all([collectMetrics(), listServices()]);
      return sendJson(res, 200, { metrics, services: svc, csrf: session.csrf });
    }

    return serveStatic(res, p);
  } catch (err) {
    return sendJson(res, 500, { error: String(err && err.message || err) });
  }
});

// Режим смены пароля: `node server.js --set-password` читает новый пароль со stdin.
// Нужен, если пароль забыт — панель при этом не запускается.
if (process.argv[2] === '--set-password') {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    const password = input.replace(/\r?\n$/, '');
    if (password.length < 8) {
      console.error('пароль короче 8 символов');
      process.exit(1);
    }
    savePassword(password);
    console.log('пароль сохранён в', AUTH_FILE);
    process.exit(0);
  });
  return;
}

server.listen(PORT, HOST, () => {
  console.log(`панель слушает ${HOST}:${PORT}`);
  if (!loadAuth()) {
    console.log('ВНИМАНИЕ: пароль не задан, выполни ./panel/passwd.sh <пароль>');
  }
});