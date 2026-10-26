'use strict';
// Фронтенд панели Moto G60 — дизайн KokonutUI / Bklit.

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

let csrf = null;
let timer = null;
let currentService = null;
let prevNet = null;
let activeTab = 'tab-monitor';

const history = { cpu: [], ram: [], netRx: [], netTx: [] };
const MAX_POINTS = 120;

const fmtBytes = (b) => {
  if (b === null || b === undefined) return '—';
  const u = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let i = 0, v = b;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
};

const fmtUptime = (s) => {
  if (s === null || s === undefined) return '—';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600),
        m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (d) return `${d}д ${h}ч`;
  if (h) return `${h}ч ${m}м`;
  if (m) return `${m}м ${sec}с`;
  return `${sec}с`;
};

function toast(msg, kind = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast ${kind}`;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 4000);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  if (res.status === 401) { showLogin(); throw new Error('unauthorized'); }
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data;
}

// ── ВКЛАДКИ ──
$$('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('.tab-btn').forEach((b) => b.classList.remove('active'));
    $$('.tab-pane').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    activeTab = btn.dataset.tab;
    $(`#${activeTab}`).classList.add('active');
    if (activeTab === 'tab-projects') loadProjects();
  });
});

// ── ВХОД ──
function showLogin() {
  clearInterval(timer);
  timer = null;
  $('#app').classList.add('hidden');
  $('#login').classList.remove('hidden');
  setTimeout(() => $('#login-password').focus(), 50);
}

async function boot() {
  try {
    const s = await api('/api/session');
    csrf = s.csrf;
    $('#login').classList.add('hidden');
    $('#app').classList.remove('hidden');
    await refresh();
    loadProjects();
    clearInterval(timer);
    timer = setInterval(refresh, 2500);
  } catch (e) {
    showLogin();
  }
}

$('#login-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const err = $('#login-error');
  err.textContent = '';
  try {
    await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ password: $('#login-password').value }),
    });
    $('#login-password').value = '';
    boot();
  } catch (e) {
    err.textContent = e.message;
  }
});

// ── МОДАЛЬНЫЕ ОКНА ──
let modalResolve = null;

function modal(title, bodyHtml, okLabel = 'Подтвердить') {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = bodyHtml;
  $('#modal-ok').textContent = okLabel;
  $('#modal').classList.remove('hidden');
  const first = $('#modal-body input');
  if (first) setTimeout(() => first.focus(), 60);
  return new Promise((resolve) => { modalResolve = resolve; });
}

function closeModal(confirmed) {
  $('#modal').classList.add('hidden');
  if (!modalResolve) return;
  let result = null;
  if (confirmed) {
    result = {};
    for (const input of document.querySelectorAll('#modal-body input')) {
      result[input.id] = input.value;
    }
    if (!Object.keys(result).length) result = true;
  }
  modalResolve(result);
  modalResolve = null;
}

$('#modal-cancel').addEventListener('click', () => closeModal(false));
$('#modal-ok').addEventListener('click', () => closeModal(true));

// ── ОБНОВЛЕНИЕ МЕТРИК ──
async function refresh() {
  try {
    const data = await api('/api/all');
    $('#conn-dot').classList.remove('off');
    renderMetrics(data.metrics);
    renderServices(data.services);
    if ($('#log-auto').checked && currentService) loadLog(currentService);
  } catch (e) {
    if (e.message !== 'unauthorized') {
      $('#conn-dot').classList.add('off');
    }
  }
}

function setBar(id, percent) {
  const el = $(id);
  if (!el) return;
  const bar = el.querySelector('.bar i');
  const value = el.querySelector('.g-value');
  if (percent === null || percent === undefined || Number.isNaN(percent)) {
    if (value) value.textContent = '—';
    if (bar) { bar.style.width = '0%'; bar.className = ''; }
    return;
  }
  if (value) value.textContent = `${percent.toFixed(percent < 10 ? 1 : 0)}%`;
  if (bar) {
    bar.style.width = `${Math.min(100, Math.max(0, percent))}%`;
    bar.className = percent >= 90 ? 'bad' : percent >= 75 ? 'warn' : '';
  }
}

function push(arr, value) {
  arr.push(value);
  if (arr.length > MAX_POINTS) arr.shift();
}

function renderMetrics(m) {
  if (!m) return;
  $('#host-name').textContent = m.host || 'moto-g60';
  $('#host-uptime').textContent = m.cpu && m.cpu.uptime ? `аптайм ${m.cpu.uptime}` : 'аптайм —';

  const load1 = m.cpu && m.cpu.loadavg ? m.cpu.loadavg[0] : null;
  const cores = (m.cpu && m.cpu.cores) || 8;
  if (load1 === null) {
    setBar('#g-cpu', null);
  } else {
    setBar('#g-cpu', (load1 / cores) * 100);
    const gVal = $('#g-cpu .g-value');
    if (gVal) gVal.textContent = load1.toFixed(2);
  }
  // Пишем среднюю частоту, а не activity: отношение частоты к максимуму
  // легко принять за загрузку CPU, хотя даже на простое ядра стоят на
  // нижней ступени (~31% от максимума).
  const freqsNow = (m.cpu && m.cpu.freq) || [];
  const avgMhz = freqsNow.length
    ? Math.round(freqsNow.reduce((a, f) => a + f.mhz, 0) / freqsNow.length)
    : null;
  $('#cpu-sub').textContent = load1 === null ? '—'
    : `1м ${m.cpu.loadavg[0].toFixed(2)} · 5м ${m.cpu.loadavg[1].toFixed(2)} · 15м ${m.cpu.loadavg[2].toFixed(2)}`
      + (avgMhz !== null ? ` · ${avgMhz} МГц` : '');

  const mem = m.memory;
  if (mem && mem.total) {
    const memPct = (mem.used / mem.total) * 100;
    setBar('#g-ram', memPct);
    const ramUsedEl = $('#g-ram .g-ram-used');
    if (ramUsedEl) ramUsedEl.textContent = `${fmtBytes(mem.used)} / ${fmtBytes(mem.total)}`;

    const swapPct = mem.swap_total ? (mem.swap_used / mem.swap_total) * 100 : 0;
    setBar('#g-swap', swapPct);
    const swapUsedEl = $('#g-swap .g-swap-used');
    if (swapUsedEl) swapUsedEl.textContent = `${fmtBytes(mem.swap_used)} / ${fmtBytes(mem.swap_total)}`;
  }

  if (m.disk) {
    setBar('#g-disk', m.disk.used_percent);
    const diskUsedEl = $('#g-disk .g-disk-used');
    if (diskUsedEl) diskUsedEl.textContent = `${fmtBytes(m.disk.used_bytes)} / ${fmtBytes(m.disk.total_bytes)}`;
  }

  if (m.battery) {
    setBar('#g-bat', m.battery.percentage);
    const batStatusEl = $('#g-bat .g-bat-status');
    if (batStatusEl) batStatusEl.textContent = `${m.battery.percentage}% ${m.battery.status}`;
    const cur = m.battery.current;
    const amps = cur ? (Math.abs(cur) / 1000000).toFixed(2) : '—';
    $('#bat-sub').textContent = `${m.battery.temperature} °C · ${amps} A · ${m.battery.plugged || 'АКБ'}`;
  }

  // Сеть
  let rxSpeed = 0, txSpeed = 0;
  if (m.network && prevNet && m.network.rx_bytes !== null) {
    const dt = Math.max(1, (m.at - prevNet.at) / 1000);
    rxSpeed = Math.max(0, (m.network.rx_bytes - prevNet.rx) / dt);
    txSpeed = Math.max(0, (m.network.tx_bytes - prevNet.tx) / dt);
  }
  if (m.network && m.network.rx_bytes !== null) {
    prevNet = { at: m.at, rx: m.network.rx_bytes, tx: m.network.tx_bytes };
  }

  const cpuPct = load1 === null || load1 === undefined ? null : (load1 / cores) * 100;
  push(history.cpu, cpuPct);
  push(history.ram, mem && mem.total ? (mem.used / mem.total) * 100 : null);
  push(history.netRx, rxSpeed / 1024);
  push(history.netTx, txSpeed / 1024);

  drawChart($('#chart-cpu'), history.cpu, { color: '#6366f1', fill: 'rgba(99,102,241,.12)', fixedMax: 100, unit: '%' });
  drawChart($('#chart-ram'), history.ram, { color: '#22c55e', fill: 'rgba(34,197,94,.12)', fixedMax: 100, unit: '%' });
  drawChart($('#chart-net'), history.netRx, { color: '#38bdf8', fill: 'rgba(56,189,248,.12)' }, history.netTx);

  renderThermals(m.thermal || []);

  const load = m.cpu && m.cpu.loadavg ? `${m.cpu.cores || 8} ядер: ` : '';
  $('#freqs').textContent = `${load}${(m.cpu?.freq || []).map((f) => `CPU${f.cpu} ${f.mhz}MHz`).join(' · ')}`;
}

// ── ТЕМПЕРАТУРЫ ──
const TEMP_NOISE = /step|lowf|adc|dcvs|vph|bcl|vbat|ibat|^soc$/i;

function renderThermals(thermal) {
  const zones = thermal.filter((t) => !TEMP_NOISE.test(t.type) && t.celsius > 5 && t.celsius < 130);
  const byHot = (a, b) => b.celsius - a.celsius;

  const socZone = zones.find((t) => /pm6150.*-tz$/i.test(t.type));
  const coreZones = zones.filter((t) => /^cpu-\d+-\d+-usr$/i.test(t.type));
  const hottestCore = coreZones.slice().sort(byHot)[0];
  const batteryZone = zones.find((t) => /battery|bms/i.test(t.type));

  const summary = $('#temp-summary');
  if (summary) {
    summary.innerHTML = `
      <span>SoC: <b>${socZone ? socZone.celsius.toFixed(1) + '°C' : '—'}</b></span>
      <span>Макс. ядро: <b>${hottestCore ? hottestCore.celsius.toFixed(1) + '°C' : '—'}</b></span>
      <span>Батарея: <b>${batteryZone ? batteryZone.celsius.toFixed(1) + '°C' : '—'}</b></span>
      <span class="muted">(${zones.length} датчиков)</span>
    `;
  }

  if (socZone) {
    setBar('#g-soc', socZone.celsius);
    const socVal = $('#g-soc .g-value');
    if (socVal) socVal.textContent = `${socZone.celsius.toFixed(1)}°C`;
  }

  const chips = $('#temps');
  if (chips) {
    chips.innerHTML = '';
    for (const t of zones.slice().sort(byHot)) {
      const el = document.createElement('span');
      el.className = 'chip' + (t.celsius >= 85 ? ' crit' : t.celsius >= 70 ? ' hot' : '');
      el.textContent = `${t.type} ${t.celsius.toFixed(1)}°C`;
      chips.appendChild(el);
    }
  }
}

// Кнопка свернуть/развернуть подробные датчики
$('#btn-temps').addEventListener('click', (e) => {
  const chips = $('#temps');
  const isHidden = chips.classList.toggle('hidden');
  e.target.textContent = isHidden ? 'Показать все датчики' : 'Свернуть датчики';
});

// ── ГРАФИКИ ──
function drawChart(svg, series, style, series2) {
  if (!svg) return;
  const W = 1000, H = 180;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const all = series2 ? series.concat(series2) : series;
  const valid = all.filter((v) => v !== null && !Number.isNaN(v));
  // Фиксированная шкала (0–100% для CPU/RAM) не зависит от наблюдённых
  // значений — иначе линия всегда прилипает к верхней границе.
  const max = style.fixedMax !== undefined ? style.fixedMax : Math.max(1, ...valid);
  const unit = style.unit ? ` ${style.unit}` : '';
  const step = W / Math.max(1, MAX_POINTS - 1);

  const pathFor = (arr) => {
    let d = '', started = false;
    arr.forEach((v, i) => {
      if (v === null || Number.isNaN(v)) return;
      const x = i * step;
      const clamped = Math.min(max, Math.max(0, v));
      const y = H - (clamped / max) * (H - 12) - 6;
      d += `${started ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)} `;
      started = true;
    });
    return d;
  };

  const d1 = pathFor(series);
  const fillPath = d1 ? `${d1}L${(series.length - 1) * step},${H}L0,${H}Z` : '';
  const d2 = series2 ? pathFor(series2) : '';

  svg.innerHTML = `
    <line x1="0" y1="${H - 6}" x2="${W}" y2="${H - 6}" stroke="#1f1f28" stroke-width="1"/>
    <path d="${fillPath}" fill="${style.fill}"/>
    ${d2 ? `<path d="${d2}" fill="none" stroke="#22c55e" stroke-width="1.5" opacity=".85"/>` : ''}
    <path d="${d1}" fill="none" stroke="${style.color}" stroke-width="2" stroke-linejoin="round"/>
    <text x="4" y="14" fill="#71717a" font-size="12" font-family="monospace">max ${max.toFixed(max < 10 ? 1 : 0)}${unit}</text>
  `;
}

// ── СЕРВИСЫ ──
function renderServices(services) {
  const body = $('#services-body');
  if (!body) return;
  body.innerHTML = '';
  const select = $('#log-select');
  const known = Array.from(select.options).map((o) => o.value);

  for (const s of services) {
    const tr = document.createElement('tr');

    const name = document.createElement('td');
    name.innerHTML = `<strong>${s.name}</strong>`;
    name.className = 'mono';
    tr.appendChild(name);

    const state = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = `badge ${s.state}`;
    badge.textContent = s.state === 'run' ? 'работает' : s.state === 'down' ? 'остановлен' : 'неизвестно';
    state.appendChild(badge);
    tr.appendChild(state);

    const pid = document.createElement('td');
    pid.className = 'mono';
    pid.textContent = s.pid || '—';
    tr.appendChild(pid);

    const since = document.createElement('td');
    since.className = 'mono';
    since.textContent = fmtUptime(s.since_seconds);
    tr.appendChild(since);

    const actions = document.createElement('td');
    actions.className = 'actions';
    if (s.controlled) {
      for (const [act, label] of [['start', 'старт'], ['stop', 'стоп'], ['restart', 'рестарт']]) {
        const btn = document.createElement('button');
        btn.className = act === 'restart' ? 'danger' : '';
        btn.textContent = label;
        btn.addEventListener('click', () => serviceAction(s.name, act));
        actions.appendChild(btn);
      }
    } else {
      actions.innerHTML = '<span class="muted" style="font-size:11px">только чтение</span>';
    }
    tr.appendChild(actions);
    body.appendChild(tr);

    if (!known.includes(s.name) && s.controlled) {
      const opt = document.createElement('option');
      opt.value = s.name;
      opt.textContent = s.name;
      select.appendChild(opt);
    }
  }

  if (!currentService && select.options.length) {
    currentService = select.options[0].value;
    select.value = currentService;
    loadLog(currentService);
  }
}

async function serviceAction(name, action) {
  if (action !== 'start') {
    const ok = await modal(
      'Действие с сервисом',
      `<p class="muted">${action === 'stop' ? 'Остановить' : 'Перезапустить'} демон <strong>${name}</strong>?</p>`,
      'Выполнить'
    );
    if (!ok) return;
  }
  try {
    await api('/api/service', { method: 'POST', body: JSON.stringify({ csrf, name, action }) });
    toast(`${name}: ${action} выполнено`, 'ok');
    setTimeout(refresh, 600);
  } catch (e) {
    toast(`Ошибка: ${e.message}`, 'err');
  }
}

// ── ЛОГИ ──
async function loadLog(name) {
  try {
    const data = await api(`/api/logs/${encodeURIComponent(name)}?lines=150`);
    const view = $('#log-view');
    view.textContent = data.available
      ? (data.lines.join('\n') || '— лог пуст —')
      : `Лог для ${name} пока не создан`;
    view.scrollTop = view.scrollHeight;
  } catch (e) {}
}

$('#log-select').addEventListener('change', (e) => {
  currentService = e.target.value;
  loadLog(currentService);
});
$('#btn-log-refresh').addEventListener('click', () => currentService && loadLog(currentService));

// ── ПАРОЛЬ И РЕБУТ ──
$('#btn-password').addEventListener('click', async () => {
  const value = await modal(
    'Смена пароля',
    '<p class="muted" style="margin-bottom:8px">После смены пароля остальные сессии будут закрыты.</p>' +
    '<input id="cur" type="password" placeholder="Текущий пароль" class="input-wrap" style="margin-bottom:8px">' +
    '<input id="new" type="password" placeholder="Новый пароль (мин. 8 символов)" class="input-wrap">',
    'Сменить пароль'
  );
  if (!value || typeof value !== 'object') return;
  try {
    await api('/api/password', {
      method: 'POST',
      body: JSON.stringify({ csrf, current: value.cur || '', next: value.new || '' }),
    });
    toast('Пароль изменён', 'ok');
  } catch (e) {
    toast(`Ошибка: ${e.message}`, 'err');
  }
});

$('#btn-reboot').addEventListener('click', async () => {
  const value = await modal(
    'Перезагрузка телефона',
    '<p class="muted" style="margin-bottom:8px">Введите <b>REBOOT</b> для подтверждения перезагрузки.</p>' +
    '<input id="confirm" placeholder="REBOOT" style="text-transform:uppercase" class="input-wrap">',
    'Перезагрузить'
  );
  if (!value || value.confirm !== 'REBOOT') { toast('Отменено'); return; }
  try {
    await api('/api/reboot', { method: 'POST', body: JSON.stringify({ csrf, confirm: 'REBOOT' }) });
    toast('Команда отправлена', 'ok');
  } catch (e) {
    toast(`Ошибка: ${e.message}`, 'err');
  }
});

$('#btn-refresh').addEventListener('click', () => { refresh(); toast('Данные обновлены', 'ok'); });
$('#btn-logout').addEventListener('click', async () => {
  try { await api(`/api/logout?csrf=${csrf}`, { method: 'POST' }); } catch (e) {}
  showLogin();
});

// ═════════════════════════════════════════════════════════════════════
// ВКЛАДКА: ПРОЕКТЫ
// ═════════════════════════════════════════════════════════════════════

async function loadProjects() {
  try {
    const data = await api('/api/projects');
    const grid = $('#projects-grid');
    if (!grid) return;
    grid.innerHTML = '';
    const projects = data.projects || [];
    $('#projects-count').textContent = projects.length;

    if (!projects.length) {
      grid.innerHTML = '<div class="muted" style="padding:2rem;text-align:center;grid-column:1/-1;">Проектов пока нет. Добавьте первый проект!</div>';
      return;
    }

    for (const p of projects) {
      const card = document.createElement('div');
      card.className = 'project-card';
      const isOnline = p.live;
      const host = window.location.hostname;
      const localUrl = `http://${host}:${p.port}`;
      const domainUrl = p.domain ? `https://${p.domain}` : null;

      card.innerHTML = `
        <div class="p-card-top">
          <div class="p-title-wrap">
            <span class="p-name">${p.name}</span>
            <span class="p-desc">${p.description || 'Без описания'}</span>
          </div>
          <span class="p-status-pill ${isOnline ? 'online' : 'offline'}">
            <i></i> ${isOnline ? 'Online' : 'Offline'}
          </span>
        </div>

        <div class="p-meta-grid">
          <div class="p-meta-item">
            <span>Порт</span>
            <span>:${p.port}</span>
          </div>
          <div class="p-meta-item">
            <span>Стек</span>
            <span>${p.type || 'node'}</span>
          </div>
          <div class="p-meta-item" style="grid-column:1/-1">
            <span>Домен</span>
            <span>${p.domain ? p.domain : 'локально'}</span>
          </div>
        </div>

        <div class="p-tags">
          ${(p.tags || []).map((t) => `<span class="p-tag">${t}</span>`).join('')}
        </div>

        <div class="p-actions">
          <a href="${domainUrl || localUrl}" target="_blank" class="btn-p-open">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:13px;height:13px"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            Открыть сайт
          </a>
          ${p.runit_service ? `
            <button class="btn-p-icon" title="Перезапуск демона" data-action="restart" data-srv="${p.runit_service}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:13px;height:13px"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"/><path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14"/></svg>
            </button>
          ` : ''}
          <button class="btn-p-icon danger" title="Удалить проект" data-action="delete" data-id="${p.id}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:13px;height:13px"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
      `;

      // Обработчики кнопок карточки
      const restartBtn = card.querySelector('[data-action="restart"]');
      if (restartBtn) {
        restartBtn.addEventListener('click', () => serviceAction(restartBtn.dataset.srv, 'restart'));
      }
      const deleteBtn = card.querySelector('[data-action="delete"]');
      if (deleteBtn) {
        deleteBtn.addEventListener('click', async () => {
          const ok = await modal('Удаление проекта', `<p class="muted">Удалить карточку проекта <strong>${p.name}</strong> из панели?</p>`, 'Удалить');
          if (!ok) return;
          try {
            await api(`/api/projects/${p.id}`, { method: 'DELETE', body: JSON.stringify({ csrf }) });
            toast(`Проект ${p.name} удален`, 'ok');
            loadProjects();
          } catch (e) {
            toast(`Ошибка: ${e.message}`, 'err');
          }
        });
      }

      grid.appendChild(card);
    }
  } catch (e) {
    console.error('Ошибка загрузки проектов:', e);
  }
}

// Открытие модалки добавления проекта
$('#btn-add-project').addEventListener('click', () => {
  $('#project-modal').classList.remove('hidden');
});
$('#btn-cancel-project').addEventListener('click', () => {
  $('#project-modal').classList.add('hidden');
});

$('#project-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('#p-id').value.trim();
  const name = $('#p-name').value.trim();
  const desc = $('#p-desc').value.trim();
  const port = Number($('#p-port').value);
  const type = $('#p-type').value;
  const domain = $('#p-domain').value.trim();
  const service = $('#p-service').value.trim();
  const tags = $('#p-tags').value.split(',').map((s) => s.trim()).filter(Boolean);

  try {
    await api('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ csrf, id, name, description: desc, port, type, domain, runit_service: service, tags }),
    });
    $('#project-modal').classList.add('hidden');
    $('#project-form').reset();
    toast(`Проект ${name} добавлен!`, 'ok');
    loadProjects();
  } catch (err) {
    toast(`Ошибка: ${err.message}`, 'err');
  }
});

boot();
