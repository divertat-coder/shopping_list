'use strict';
const APP_VERSION = '3 (количество)';
/*
  Список покупок. Данные общие для всех телефонов: хранятся в Google Таблице (через скрипт Google).
  Телефон держит копию (работает без интернета) и очередь неотправленных действий.
*/

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const pad = n => String(n).padStart(2, '0');
const nowStamp = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const newId = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

/* ---------- хранилище ---------- */
const K = {cfg: 'shop_cfg_v1', snap: 'shop_snap_v1', ops: 'shop_ops_v1', ui: 'shop_ui_v1'};
function lsGet(k, def) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch (e) { return def; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

let cfg = Object.assign({url: '', token: ''}, lsGet(K.cfg, {}));
let snap = lsGet(K.snap, {catalog: [], list: []});   // последнее состояние с сервера
let ops = lsGet(K.ops, []);                           // действия, ещё не отправленные на сервер
let ui = Object.assign({tab: 'pick', closed: {}, edit: false}, lsGet(K.ui, {}));
let view = {catalog: [], list: []};                   // что показываем: snap + ops
let netState = 'ok', netMsg = '';
let search = '';

/* Те же правила, что на сервере (Code.gs, applyOps_) */
function applyOps(st, list) {
  const s = JSON.parse(JSON.stringify(st));
  for (const o of list) {
    if (o.t === 'add') {
      if (s.catalog.some(p => p.id === o.pid) && !s.list.some(i => i.pid === o.pid)) s.list.push({pid: o.pid, checked: false, qty: String(o.q || '').slice(0, 20)});
    } else if (o.t === 'qty') { const i = s.list.find(i => i.pid === o.pid); if (i) i.qty = String(o.q || '').slice(0, 20); }
    else if (o.t === 'rm') s.list = s.list.filter(i => i.pid !== o.pid);
    else if (o.t === 'chk') { const i = s.list.find(i => i.pid === o.pid); if (i) i.checked = !!o.v; }
    else if (o.t === 'prod_add') { if (!s.catalog.some(p => p.id === o.id)) s.catalog.push({id: o.id, cat: o.cat, name: o.name}); }
    else if (o.t === 'prod_ren') { const p = s.catalog.find(p => p.id === o.id); if (p) { if (o.name) p.name = o.name; if (o.cat) p.cat = o.cat; } }
    else if (o.t === 'prod_del') { s.catalog = s.catalog.filter(p => p.id !== o.id); s.list = s.list.filter(i => i.pid !== o.id); }
    else if (o.t === 'done') s.list = s.list.filter(i => !i.checked);
  }
  return s;
}
const recompute = () => { view = applyOps(snap, ops); };

/* ---------- мелочи ---------- */
let toastTimer = null;
function toast(msg, ms = 3000) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}
function categories() {
  const out = [];
  for (const p of view.catalog) if (!out.includes(p.cat)) out.push(p.cat);
  return out;
}
const byId = () => new Map(view.catalog.map(p => [p.id, p]));

/* ---------- синхронизация ---------- */
let syncing = false, syncTimer = null;
async function api(method, params, body) {
  if (!cfg.url) throw new Error('не указан адрес скрипта');
  let r;
  if (method === 'GET') {
    const u = new URL(cfg.url);
    u.searchParams.set('token', cfg.token);
    for (const k in params) u.searchParams.set(k, params[k]);
    r = await fetch(u.toString());
  } else {
    r = await fetch(cfg.url, {method: 'POST', body: JSON.stringify(Object.assign({token: cfg.token}, body))});
  }
  const j = await r.json();
  if (!j.ok) throw new Error(j.error === 'bad token' ? 'неверный пароль' : (j.error || 'ошибка сервера'));
  return j;
}
function scheduleSync(ms = 300) { clearTimeout(syncTimer); syncTimer = setTimeout(sync, ms); }
async function sync() {
  if (syncing || !cfg.url) { updateNet(); return; }
  syncing = true;
  try {
    const sent = ops.slice();
    const j = sent.length ? await api('POST', {}, {ops: sent}) : await api('GET', {});
    ops = ops.slice(sent.length); lsSet(K.ops, ops);
    const next = {catalog: j.catalog, list: j.list};
    const changed = JSON.stringify(next) !== JSON.stringify(snap);
    snap = next; lsSet(K.snap, snap);
    netState = 'ok'; netMsg = '';
    if (changed || sent.length) { recompute(); render(); }
  } catch (e) {
    netState = 'err'; netMsg = e.message;
  } finally { syncing = false; updateNet(); }
  if (ops.length && netState === 'ok') scheduleSync(100);
}
function updateNet() {
  const dot = $('#dot');
  if (!cfg.url) { dot.className = 'dot err'; $('#syncTxt').textContent = 'не настроено'; return; }
  if (netState === 'err') { dot.className = 'dot err'; $('#syncTxt').textContent = ops.length ? `не отправлено: ${ops.length}` : 'нет связи'; return; }
  dot.className = 'dot' + (ops.length ? ' wait' : '');
  $('#syncTxt').textContent = ops.length ? 'отправка…' : 'синхронизировано';
}
function act(o) {
  ops.push(o); lsSet(K.ops, ops);
  recompute(); render(); updateNet(); scheduleSync();
}

/* ---------- вкладки ---------- */
function showTab(name) {
  ui.tab = name; lsSet(K.ui, ui);
  for (const t of $$('.tab')) t.classList.toggle('active', t.dataset.tab === name);
  for (const v of ['pick', 'list', 'hist']) $('#v-' + v).classList.toggle('hidden', v !== name);
  $('#doneBar').classList.toggle('hidden', name !== 'list' || !view.list.length);
  if (name === 'hist') loadHistory();
  if (name === 'list') keepAwake();
  render();
}
$$('.tab').forEach(b => b.onclick = () => showTab(b.dataset.tab));

/* ---------- вкладка «Продукты» ---------- */
function renderPick() {
  const q = search.trim().toLowerCase();
  const inList = new Set(view.list.map(i => i.pid));
  let html = '';
  for (const cat of categories()) {
    const items = view.catalog.filter(p => p.cat === cat);
    const shown = q ? items.filter(p => p.name.toLowerCase().includes(q)) : items;
    if (q && !shown.length) continue;
    const sel = items.filter(p => inList.has(p.id)).length;
    const closed = !q && ui.closed[cat];
    html += `<div class="cat${closed ? ' closed' : ''}"><h3 data-cat="${esc(cat)}"><span class="nm">${esc(cat)}</span>` +
      (sel ? `<span class="cnt">выбрано ${sel}</span>` : '') + `<span class="arr">▾</span></h3><div class="chips">`;
    for (const p of shown) {
      html += `<button class="chip${inList.has(p.id) ? ' sel' : ''}${ui.edit ? ' edit' : ''}" data-pid="${esc(p.id)}">${esc(p.name)}</button>`;
    }
    if (ui.edit && !q) html += `<button class="chip add" data-addcat="${esc(cat)}">＋ добавить</button>`;
    html += '</div></div>';
  }
  if (!html) html = `<div class="empty">${view.catalog.length ? 'Ничего не найдено' : (cfg.url ? 'Загрузка списка продуктов…' : 'Откройте ⚙ и укажите адрес скрипта и пароль')}</div>`;
  $('#pickBody').innerHTML = html;
  $('#btnEdit').classList.toggle('on', ui.edit);
  $('#btnEdit').textContent = ui.edit ? 'Готово' : 'Правка';
  $('#newCatBar').classList.toggle('hidden', !ui.edit);
}
$('#search').oninput = e => { search = e.target.value; renderPick(); };
$('#btnEdit').onclick = () => { ui.edit = !ui.edit; lsSet(K.ui, ui); renderPick(); };
$('#pickBody').onclick = e => {
  const add = e.target.closest('[data-addcat]');
  if (add) return addProduct(add.dataset.addcat);
  const chip = e.target.closest('[data-pid]');
  if (chip) {
    const pid = chip.dataset.pid;
    if (ui.edit) return editProduct(pid);
    const inList = view.list.some(i => i.pid === pid);
    return act(inList ? {t: 'rm', pid} : {t: 'add', pid});
  }
  const h = e.target.closest('[data-cat]');
  if (h && !search.trim()) { ui.closed[h.dataset.cat] = !ui.closed[h.dataset.cat]; lsSet(K.ui, ui); renderPick(); }
};
function addProduct(cat) {
  const name = (prompt('Название продукта (категория: ' + cat + ')') || '').trim();
  if (!name) return;
  if (view.catalog.some(p => p.cat === cat && p.name.toLowerCase() === name.toLowerCase())) { toast('Такой продукт уже есть'); return; }
  act({t: 'prod_add', id: newId(), cat, name});
}
$('#btnNewCat').onclick = () => {
  const cat = (prompt('Название новой категории') || '').trim();
  if (!cat) return;
  const name = (prompt('Первый продукт в категории «' + cat + '»') || '').trim();
  if (!name) return;
  act({t: 'prod_add', id: newId(), cat, name});
};
function editProduct(pid) {
  const p = view.catalog.find(p => p.id === pid); if (!p) return;
  const n = prompt('Новое название продукта.\nПустое поле — удалить продукт из общего списка.', p.name);
  if (n === null) return;
  const name = n.trim();
  if (!name) { if (confirm('Удалить «' + p.name + '» из общего списка продуктов?')) act({t: 'prod_del', id: pid}); return; }
  if (name !== p.name) act({t: 'prod_ren', id: pid, name});
}

/* ---------- вкладка «Список» ---------- */
function renderList() {
  const map = byId();
  const items = view.list.map(i => Object.assign({}, i, {p: map.get(i.pid)})).filter(i => i.p);
  const open = items.filter(i => !i.checked), done = items.filter(i => i.checked);
  const cats = categories();
  let html = '';
  if (!items.length) html = '<div class="empty">Список пуст.<br>Выберите продукты на вкладке «Продукты».</div>';
  for (const cat of cats) {
    const g = open.filter(i => i.p.cat === cat);
    if (!g.length) continue;
    html += `<div class="grp">${esc(cat)}</div>`;
    for (const i of g) html += rowHtml(i, false);
  }
  if (done.length) {
    html += '<div class="grp">В корзине</div>';
    for (const i of done) html += rowHtml(i, true);
  }
  $('#listBody').innerHTML = html;
  const left = open.length;
  $('#leftCnt').textContent = left;
  $('#leftTxt').textContent = left ? 'осталось собрать' : (done.length ? 'всё собрано' : '');
  $('#doneBar').classList.toggle('hidden', ui.tab !== 'list' || !items.length);
  const b = $('#badge'); b.textContent = left; b.classList.toggle('hidden', !left);
}
function rowHtml(i, done) {
  const q = i.qty ? esc(i.qty) : '';
  return `<div class="row-item${done ? ' done' : ''}" data-pid="${esc(i.pid)}"><span class="box"></span><span class="nm">${esc(i.p.name)}</span>` +
    (done ? (q ? `<span class="qty">${q}</span>` : '') : `<button class="qty${q ? '' : ' empty'}" data-qty aria-label="Количество">${q || '＋ кол-во'}</button><button class="x" data-rm aria-label="Убрать">×</button>`) + '</div>';
}
$('#listBody').onclick = e => {
  const row = e.target.closest('[data-pid]'); if (!row) return;
  const pid = row.dataset.pid;
  if (e.target.closest('[data-rm]')) return act({t: 'rm', pid});
  if (e.target.closest('[data-qty]')) return askQty(pid);
  const it = view.list.find(i => i.pid === pid);
  if (it) act({t: 'chk', pid, v: !it.checked});
};
function askQty(pid) {
  const it = view.list.find(i => i.pid === pid), p = byId().get(pid); if (!it || !p) return;
  const v = prompt('Количество для «' + p.name + '»\nНапример: 2, 1 л, 500 г. Пусто — убрать.', it.qty || '');
  if (v === null) return;
  act({t: 'qty', pid, q: v.trim().slice(0, 20)});
}
$('#btnDone').onclick = () => {
  const checked = view.list.filter(i => i.checked).length;
  const open = view.list.length - checked;
  if (!checked) { toast('Ничего не отмечено — нечего переносить в историю'); return; }
  let msg = `Перенести в историю: ${checked}.`;
  if (open) msg += `\nНе собрано: ${open}. Они останутся в списке.`;
  if (!confirm(msg)) return;
  act({t: 'done', trip: 't' + Date.now().toString(36), ts: nowStamp()});
  toast('Готово! Покупки сохранены в истории');
};

/* ---------- вкладка «История» ---------- */
let trips = lsGet('shop_hist_v1', []);
async function loadHistory() {
  renderHistory();
  try {
    if (ops.length) await sync();
    const j = await api('GET', {action: 'history', limit: 30});
    trips = j.trips; lsSet('shop_hist_v1', trips);
    renderHistory();
  } catch (e) { if (!trips.length) $('#histBody').innerHTML = `<div class="empty">Не удалось загрузить историю: ${esc(e.message)}</div>`; }
}
function renderHistory() {
  if (!trips.length) { $('#histBody').innerHTML = '<div class="empty">История пока пуста.<br>Она появится после кнопки «Готово» в списке.</div>'; return; }
  $('#histBody').innerHTML = trips.map((t, n) => {
    const groups = [];
    for (const it of t.items) {
      let g = groups.find(g => g.cat === it.cat);
      if (!g) groups.push(g = {cat: it.cat, names: []});
      g.names.push(it.name + (it.qty ? ' (' + it.qty + ')' : ''));
    }
    return `<div class="trip"><div class="th">${esc(t.date)} ${esc(t.time)} · ${t.items.length} шт.</div>` +
      groups.map(g => `<div class="tc"><b>${esc(g.cat)}:</b> ${esc(g.names.join(', '))}</div>`).join('') +
      `<button class="btn" data-readd="${n}">Добавить всё в список</button></div>`;
  }).join('');
}
$('#histBody').onclick = e => {
  const b = e.target.closest('[data-readd]'); if (!b) return;
  const t = trips[+b.dataset.readd]; if (!t) return;
  let added = 0, missing = 0;
  for (const it of t.items) {
    const p = view.catalog.find(p => p.cat === it.cat && p.name === it.name);
    if (!p) { missing++; continue; }
    if (!view.list.some(i => i.pid === p.id)) { act({t: 'add', pid: p.id, q: it.qty || ''}); added++; }
  }
  toast(`Добавлено в список: ${added}` + (missing ? `; нет в каталоге: ${missing}` : ''));
};

/* ---------- общий вывод ---------- */
function render() { renderPick(); renderList(); }

/* ---------- настройки ---------- */
function openSettings() {
  $('#sUrl').value = cfg.url; $('#sToken').value = cfg.token;
  $('#ver').textContent = 'Версия приложения: ' + APP_VERSION;
  $('#sLinkOut').classList.add('hidden');
  $('#settings').classList.remove('hidden');
}
$('#btnSettings').onclick = openSettings;
$('#sClose').onclick = () => $('#settings').classList.add('hidden');
$('#sSave').onclick = () => {
  cfg = {url: $('#sUrl').value.trim(), token: $('#sToken').value.trim()};
  lsSet(K.cfg, cfg);
  $('#settings').classList.add('hidden');
  toast('Настройки сохранены'); sync();
};
$('#sLink').onclick = async () => {
  const link = location.origin + location.pathname + '#u=' + encodeURIComponent($('#sUrl').value.trim()) + '&t=' + encodeURIComponent($('#sToken').value.trim());
  const out = $('#sLinkOut'); out.value = link; out.classList.remove('hidden');
  try { await navigator.clipboard.writeText(link); toast('Ссылка скопирована'); } catch (e) { out.select(); toast('Скопируйте ссылку вручную'); }
};
/* Настройка по ссылке вида  …/index.html#u=<адрес>&t=<пароль> */
function readHashConfig() {
  if (!location.hash || location.hash.length < 3) return;
  const p = new URLSearchParams(location.hash.slice(1));
  if (p.get('u') && p.get('t')) {
    cfg = {url: p.get('u'), token: p.get('t')}; lsSet(K.cfg, cfg);
    history.replaceState(null, '', location.pathname + location.search);
    toast('Приложение настроено');
  }
}

/* ---------- экран не гаснет в магазине ---------- */
let wakeLock = null;
async function keepAwake() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible' && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch (e) { wakeLock = null; }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { if (ui.tab === 'list') keepAwake(); sync(); }
});
window.addEventListener('online', () => sync());
window.addEventListener('offline', () => { netState = 'err'; updateNet(); });

/* ---------- старт ---------- */
(function init() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  readHashConfig();
  recompute(); render(); updateNet();
  showTab(ui.tab || 'pick');
  if (!cfg.url) openSettings();
  sync();
  setInterval(() => { if (document.visibilityState === 'visible') sync(); }, 7000);
})();
