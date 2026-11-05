'use strict';
// ---------- helpers ----------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const COLORS = ['#f25f5c', '#12a39a', '#3b6fe0', '#8e5ce6', '#f2a20c', '#e0479e', '#5baa2e', '#1ba6c9', '#a0673a', '#5b6478'];
const DIFF = { easy: 'ง่าย', medium: 'กลาง', hard: 'ยาก', extreme: 'โหด' };
const MODE = { original: 'คลาสสิก', hardcore: 'ฮาร์ดคอร์' };
const initial = (n) => (n || '?').trim().charAt(0).toUpperCase();

function makeId() {
  if (window.crypto && crypto.getRandomValues) {
    const a = new Uint8Array(16); crypto.getRandomValues(a);
    return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ---------- state ----------
const S = {
  pid: LS.get('pid', null) || (() => { const id = makeId(); LS.set('pid', id); return id; })(),
  name: LS.get('name', ''),
  opts: Object.assign({ colors: true, same: true, autonotes: true, vibrate: true, dark: null }, LS.get('opts', {})),
  ws: null, open: false, retry: 0,
  code: null, room: null, me: null, offset: 0,
  sel: -1, notesMode: false, notes: new Array(81).fill(0),
  chatSeen: 0, lobby: null, resultDismissed: false, pendingClear: [],
};

// ---------- theme ----------
function applyTheme() {
  const dark = S.opts.dark == null ? matchMedia('(prefers-color-scheme: dark)').matches : S.opts.dark;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('meta[name=theme-color]').content = dark ? '#15141c' : '#f6f1e7';
  $('#opt-dark').checked = dark;
}
function saveOpts() { LS.set('opts', S.opts); }

// ---------- socket ----------
function connect() {
  const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  S.ws = ws;
  ws.onopen = () => {
    S.open = true; S.retry = 0;
    send({ type: 'hello', pid: S.pid });
    if (S.code && S.name) send({ type: 'join', code: S.code, name: S.name });
    if (current() === 'lobby') send({ type: 'lobby' });
  };
  ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } on[m.type] && on[m.type](m); };
  ws.onclose = () => {
    S.open = false;
    if (S.code) toast('การเชื่อมต่อหลุด กำลังต่อใหม่…', 1500);
    setTimeout(connect, Math.min(5000, 400 * 2 ** S.retry++));
  };
}
function send(m) { if (S.open) S.ws.send(JSON.stringify(m)); }
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.ws && S.ws.readyState > 1) { S.retry = 0; connect(); }
});

const on = {
  state(m) {
    S.offset = m.serverNow - Date.now();
    const prev = S.room;
    S.room = m.room; S.me = m.me;
    if (!prev || prev.code !== m.room.code) { loadNotes(); S.resultDismissed = false; S.pendingClear = []; }
    for (const c of S.pendingClear.splice(0)) if (m.me && m.me.board && m.me.board[c]) clearPeerNotes(c, m.me.board[c]);
    renderRoom(prev);
  },
  fx(m) { fx(m); },
  lobby(m) { S.offset = m.serverNow - Date.now(); S.lobby = m.rooms; renderLobby(); },
  created(m) { location.hash = '#/g/' + m.code; },
  error(m) {
    if (m.code === 'finished' && m.next) { toast('เกมนี้จบแล้ว พาไปห้องถัดไป'); location.hash = '#/g/' + m.next; return; }
    toast(m.message || 'เกิดข้อผิดพลาด');
    if (['notfound', 'full'].includes(m.code)) { S.code = null; location.hash = '#/'; }
  },
};

// ---------- routing ----------
function current() { return $('.view.active')?.id.slice(2); }
function show(v) { $$('.view').forEach((el) => el.classList.toggle('active', el.id === 'v-' + v)); window.scrollTo(0, 0); }
function route() {
  const [p, q] = (location.hash.slice(1) || '/').split('?');
  const parts = p.split('/').filter(Boolean);
  closeSheets();
  $('#result-modal').classList.remove('show');
  if (parts[0] === 'g' && parts[1]) return enterRoom(parts[1].toUpperCase());
  if (S.code) { send({ type: 'leave' }); S.code = null; S.room = null; }
  if (parts[0] === 'lobby') { show('lobby'); S.lobby = null; renderLobby(); send({ type: 'lobby' }); }
  else if (parts[0] === 'create') {
    show('create');
    setChoice('visibility', new URLSearchParams(q).get('public') ? 'public' : 'private');
  } else show('home');
}
window.addEventListener('hashchange', route);

function enterRoom(code) {
  show('room');
  if (S.code !== code) { S.room = null; S.me = null; S.sel = -1; S.chatSeen = 0; }
  S.code = code;
  $('#room-code').textContent = code;
  $('#big-code').textContent = code;
  $('#v-room').className = 'view room active waitingroom';
  $('#players').innerHTML = '';
  $('#wait-list').innerHTML = '';
  if (!S.name) return askName(() => send({ type: 'join', code, name: S.name }));
  send({ type: 'join', code, name: S.name });
}

// ---------- name ----------
let nameCb = null;
function askName(cb) {
  nameCb = cb;
  $('#name-input').value = S.name;
  $('#name-modal').classList.add('show');
  setTimeout(() => $('#name-input').focus(), 50);
}
$('#name-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const n = $('#name-input').value.trim().slice(0, 16);
  if (!n) return $('#name-input').focus();
  S.name = n; LS.set('name', n);
  $('#name-modal').classList.remove('show');
  const cb = nameCb; nameCb = null; cb && cb();
});

// ---------- home ----------
$('#join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const c = $('#join-code').value.trim().toUpperCase().replace(/[^A-Z]/g, '');
  if (c.length !== 4) return toast('รหัสห้องมี 4 ตัวอักษร');
  location.hash = '#/g/' + c;
});
$('#join-code').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, ''); });
$$('.js-theme').forEach((b) => b.addEventListener('click', () => {
  S.opts.dark = document.documentElement.dataset.theme !== 'dark'; saveOpts(); applyTheme();
}));

// ---------- lobby ----------
function ago(t) {
  const m = Math.max(0, Math.round((Date.now() + S.offset - t) / 60000));
  return m < 1 ? 'เมื่อสักครู่' : m < 60 ? `${m} นาทีที่แล้ว` : `${Math.floor(m / 60)} ชม.ที่แล้ว`;
}
function renderLobby() {
  if (current() !== 'lobby') return;
  const list = S.lobby;
  if (!list) { $('#lobby-count').textContent = 'กำลังโหลด…'; $('#lobby-list').innerHTML = ''; return; }
  $('#lobby-count').textContent = list.length ? `มี ${list.length} ห้องเปิดอยู่ตอนนี้` : 'ยังไม่มีห้องสาธารณะเปิดอยู่';
  $('#lobby-list').innerHTML = Object.keys(DIFF).map((d) => {
    const rs = list.filter((r) => r.difficulty === d);
    if (!rs.length) return '';
    return `<div class="lobby-group"><h4>${DIFF[d]} <span>${rs.length}</span></h4>${rs.map((r) => `
      <a class="lobby-item" href="#/g/${r.code}">
        <span class="lcode">${r.code}</span>
        <span class="lmeta"><b>${MODE[r.mode]}</b><br>${r.status === 'waiting' ? 'รอเริ่ม · สร้าง' : 'เริ่มแล้ว'} ${ago(r.since)}</span>
        <span class="lcount">${r.count}/${r.max}</span>
      </a>`).join('')}</div>`;
  }).join('');
}
$('#lobby-refresh').addEventListener('click', () => { S.lobby = null; renderLobby(); send({ type: 'lobby' }); });
setInterval(() => { if (current() === 'lobby') send({ type: 'lobby' }); }, 8000);

// ---------- create ----------
function setChoice(name, v) {
  $$(`[data-name=${name}] button`).forEach((b) => b.classList.toggle('on', b.dataset.v === v));
}
$$('.seg, .choices').forEach((g) => g.addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (b) setChoice(g.dataset.name, b.dataset.v);
}));
const choice = (name) => $(`[data-name=${name}] button.on`).dataset.v;
$('#create-btn').addEventListener('click', () => {
  const go = () => send({ type: 'create', difficulty: choice('difficulty'), mode: choice('mode'), isPublic: choice('visibility') === 'public' });
  if (!S.open) return toast('ยังเชื่อมต่อเซิร์ฟเวอร์ไม่ได้');
  S.name ? go() : askName(go);
});

// ---------- board setup ----------
const board = $('#board');
const cells = [];
for (let i = 0; i < 81; i++) {
  const r = Math.floor(i / 9), c = i % 9;
  const el = document.createElement('div');
  el.className = 'cell';
  el.dataset.base = 'cell' + (c % 3 === 2 ? (c === 8 ? ' c9' : ' c3') : '') + (r % 3 === 2 ? (r === 8 ? ' r9' : ' r3') : '');
  el.innerHTML = '<span class="d"></span><div class="notes">' + '<span></span>'.repeat(9) + '</div>';
  el.addEventListener('pointerdown', (e) => { e.preventDefault(); select(i); });
  board.appendChild(el);
  cells.push(el);
}
const pad = $('#pad');
for (let d = 1; d <= 9; d++) {
  const b = document.createElement('button');
  b.innerHTML = `${d}<small></small>`;
  b.addEventListener('click', () => input(d));
  pad.appendChild(b);
}
const peers = (a, b) => Math.floor(a / 9) === Math.floor(b / 9) || a % 9 === b % 9 ||
  (Math.floor(a / 27) === Math.floor(b / 27) && Math.floor((a % 9) / 3) === Math.floor((b % 9) / 3));

function select(i) {
  if (!S.room || S.room.status === 'waiting') return;
  S.sel = i;
  renderBoard();
}

// ---------- notes ----------
function loadNotes() {
  const saved = S.room && LS.get('notes:' + S.room.code, null);
  S.notes = Array.isArray(saved) && saved.length === 81 ? saved : new Array(81).fill(0);
}
function saveNotes() { if (S.room) LS.set('notes:' + S.room.code, S.notes); }
function clearPeerNotes(cell, d) {
  for (let j = 0; j < 81; j++) if (peers(cell, j)) S.notes[j] &= ~(1 << d);
  S.notes[cell] = 0;
  saveNotes();
}

// ---------- input ----------
function valueAt(i) {
  const R = S.room, me = S.me;
  if (!R || !R.puzzle) return 0;
  return R.puzzle[i] || (me && me.board ? me.board[i] : 0) || 0;
}
function playing() { return S.room && S.room.status === 'playing' && S.me && S.me.board; }
function input(d) {
  const i = S.sel, R = S.room, me = S.me;
  if (i < 0 || !playing() || R.puzzle[i]) return;
  const resolved = me.board[i] || me.locked.includes(i);
  if (S.notesMode) {
    if (R.mode === 'original' ? resolved : me.board[i]) return;
    S.notes[i] ^= 1 << d; saveNotes(); renderBoard(); return;
  }
  if (R.mode === 'original' && resolved) return;
  if (R.mode === 'hardcore' && me.board[i] === d) return;
  send({ type: 'move', cell: i, value: d });
}
function erase() {
  const i = S.sel, R = S.room, me = S.me;
  if (i < 0 || !playing() || R.puzzle[i]) return;
  if (R.mode === 'hardcore' && me.board[i]) return send({ type: 'move', cell: i, value: 0 });
  if (S.notes[i]) { S.notes[i] = 0; saveNotes(); renderBoard(); }
}
$('#t-erase').addEventListener('click', erase);
$('#t-notes').addEventListener('click', () => { S.notesMode = !S.notesMode; renderTools(); });
document.addEventListener('keydown', (e) => {
  if (current() !== 'room' || e.target.tagName === 'INPUT') return;
  const k = e.key;
  if (/^[1-9]$/.test(k)) input(+k);
  else if (k === 'Backspace' || k === 'Delete' || k === '0') erase();
  else if (k === 'n' || k === 'N') { S.notesMode = !S.notesMode; renderTools(); }
  else if (k.startsWith('Arrow')) {
    let i = S.sel < 0 ? 40 : S.sel;
    if (k === 'ArrowUp') i = (i + 72) % 81; if (k === 'ArrowDown') i = (i + 9) % 81;
    if (k === 'ArrowLeft') i = i % 9 ? i - 1 : i + 8; if (k === 'ArrowRight') i = i % 9 === 8 ? i - 8 : i + 1;
    select(i); e.preventDefault();
  }
});

// ---------- rendering ----------
function playerById(id) { return S.room && S.room.players.find((p) => p.id === id); }

function renderRoom(prev) {
  const R = S.room;
  if (!R || current() !== 'room') return;
  const view = $('#v-room');
  view.className = 'view room active ' + (R.status === 'waiting' ? 'waitingroom' : 'playing');
  $('#room-code').textContent = R.code;
  $('#big-code').textContent = R.code;
  $('#room-info').textContent = `${DIFF[R.difficulty]} · ${MODE[R.mode]}${R.isPublic ? ' · สาธารณะ' : ''}`;
  renderPlayers();
  if (R.status === 'waiting') renderWaiting();
  else { renderBoard(); renderTools(); }
  renderChat();
  if (R.status === 'finished' && (!prev || prev.status !== 'finished' || prev.code !== R.code) && !S.resultDismissed) { closeSheets(); showResults(); }
  if (R.status === 'finished' && $('#result-modal').classList.contains('show')) showResults();
  tick();
}

function sortedPlayers() {
  const R = S.room;
  const ps = R.players.filter((p) => !p.left || R.status !== 'waiting');
  return R.mode === 'original'
    ? ps.sort((a, b) => b.score - a.score)
    : ps.sort((a, b) => (b.id === R.winnerId) - (a.id === R.winnerId) || b.progress - a.progress);
}

function renderPlayers() {
  const R = S.room;
  $('#players').innerHTML = sortedPlayers().map((p) => `
    <div class="chip${p.id === S.pid ? ' me' : ''}${p.connected ? '' : ' off'}" data-pid="${p.id}">
      <span class="av" style="background:${COLORS[p.color]}">${esc(initial(p.name))}</span>
      <span class="nm">${esc(p.name)}</span>
      ${R.status === 'waiting' ? '' : `<span class="sc">${R.mode === 'original' ? p.score : p.progress + '%'}</span>`}
    </div>`).join('');
}

function renderWaiting() {
  const R = S.room;
  const isHost = R.hostId === S.pid;
  $('#wait-list').innerHTML = R.players.filter((p) => !p.left).map((p) => `
    <div class="wait-item">
      <span class="av" style="background:${COLORS[p.color]}">${esc(initial(p.name))}</span>
      <span>${esc(p.name)}${p.id === S.pid ? ' (คุณ)' : ''}</span>
      ${p.id === R.hostId ? '<span class="host">หัวห้อง</span>' : p.connected ? '' : '<span class="host">หลุด</span>'}
    </div>`).join('');
  $('#start-btn').style.display = isHost ? '' : 'none';
  const n = R.players.filter((p) => !p.left).length;
  $('#wait-msg').textContent = isHost
    ? (n < 2 ? 'กดเริ่มได้เลยถ้าจะเล่นคนเดียว หรือรอเพื่อนเข้ามาก่อน' : `มี ${n} คนในห้อง พร้อมแล้วกดเริ่มได้เลย`)
    : 'รอหัวห้องกดเริ่ม…';
}

function renderBoard() {
  const R = S.room, me = S.me;
  if (!R || !R.puzzle || !me || !me.board) return;
  const selV = S.sel >= 0 ? valueAt(S.sel) : 0;
  const locked = new Set(me.locked);
  for (let i = 0; i < 81; i++) {
    const el = cells[i];
    let cls = el.dataset.base;
    let v = 0;
    if (R.puzzle[i]) { v = R.puzzle[i]; cls += ' given'; }
    else if (locked.has(i)) { v = me.board[i]; cls += ' locked'; }
    else if (me.board[i]) { v = me.board[i]; cls += ' mine'; }
    const own = R.owner ? R.owner[i] : -1;
    if (own >= 0 && S.opts.colors && !R.puzzle[i] && !locked.has(i)) {
      cls += v ? ' owned' : ' owned-other';
      el.style.setProperty('--own', COLORS[own]);
    }
    if (S.sel >= 0) {
      if (i === S.sel) cls += ' sel';
      else if (S.opts.same && selV && v === selV) cls += ' same';
      else if (peers(i, S.sel)) cls += ' peer';
    }
    if (el.className.replace(/ (flash|shake)/g, '') !== cls) el.className = cls + (el.className.match(/ (flash|shake)/g) || []).join('');
    el.firstChild.textContent = v || '';
    const notes = v ? 0 : S.notes[i];
    const spans = el.lastChild.children;
    for (let d = 1; d <= 9; d++) {
      const on = notes & (1 << d);
      spans[d - 1].textContent = on ? d : '';
      spans[d - 1].className = on && S.opts.same && d === selV ? 'hl' : '';
    }
  }
  // pad counts
  const counts = new Array(10).fill(0);
  for (let i = 0; i < 81; i++) counts[valueAt(i)]++;
  [...pad.children].forEach((b, k) => {
    const d = k + 1, left = 9 - counts[d];
    b.lastChild.textContent = left > 0 ? left : '';
    b.classList.toggle('done', left <= 0 && R.mode === 'original');
  });
}

function renderTools() {
  $('#t-notes').classList.toggle('on', S.notesMode);
  $('#notes-state').textContent = S.notesMode ? 'เปิด' : 'ปิด';
  pad.classList.toggle('notemode', S.notesMode);
}

function tick() {
  const R = S.room;
  if (!R || !R.startedAt) return;
  const end = R.endedAt || Date.now() + S.offset;
  const s = Math.max(0, Math.floor((end - R.startedAt) / 1000));
  $('#timer').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
setInterval(tick, 1000);

// ---------- effects ----------
function floatAt(cell, text, color) {
  const wrap = $('#fx');
  const el = document.createElement('div');
  el.className = 'float';
  el.textContent = text;
  el.style.background = color;
  el.style.left = ((cell % 9) + 0.5) / 9 * 100 + '%';
  el.style.top = (Math.floor(cell / 9) + 0.5) / 9 * 100 + '%';
  wrap.appendChild(el);
  setTimeout(() => el.remove(), 1000);
}
function pulse(cell, cls) {
  const el = cells[cell];
  el.classList.remove('flash', 'shake'); void el.offsetWidth; el.classList.add(cls);
  setTimeout(() => el.classList.remove(cls), 500);
}
function fx(m) {
  const p = m.pid && playerById(m.pid);
  if (m.kind === 'start') { toast('เริ่ม! 🏁'); S.sel = -1; return; }
  if (m.kind === 'notyet') return toast('กระดานเต็มแล้ว แต่ยังมีช่องที่ผิดอยู่');
  if (m.kind === 'end') return;
  if (m.kind === 'solve') {
    if (m.pid === S.pid) {
      floatAt(m.cell, '+' + m.points, p ? COLORS[p.color] : '#12a39a');
      setTimeout(() => pulse(m.cell, 'flash'), 0);
      if (S.opts.autonotes) S.pendingClear.push(m.cell); // digit arrives in the next state
    } else if (m.rank === 0 && p) {
      bumpChip(m.pid);
    }
  }
  if (m.kind === 'wrong' && m.pid === S.pid) {
    floatAt(m.cell, String(m.points), '#d6324a');
    setTimeout(() => pulse(m.cell, 'shake'), 0);
    if (S.opts.vibrate && navigator.vibrate) navigator.vibrate(120);
    S.notes[m.cell] = 0; saveNotes();
  }
}
function bumpChip(pid) {
  const el = $(`.chip[data-pid="${pid}"]`);
  if (!el) return;
  el.classList.add('bump'); setTimeout(() => el.classList.remove('bump'), 250);
}

// ---------- chat ----------
function renderChat() {
  const R = S.room;
  const chat = R ? R.chat : [];
  const list = $('#chat-list');
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  list.innerHTML = chat.length ? chat.map((c) => `
    <div class="msg"><span class="av" style="background:${COLORS[c.color]}">${esc(initial(c.name))}</span>
    <div class="bub"><b>${esc(c.name)}</b>${esc(c.text)}</div></div>`).join('')
    : '<p class="chat-empty">ยังไม่มีข้อความ ทักทายเพื่อนสิ</p>';
  if (atBottom || chatOpen()) list.scrollTop = list.scrollHeight;
  const last = chat.length ? chat[chat.length - 1].t : 0;
  if (chatOpen()) S.chatSeen = last;
  $('#chat-dot').classList.toggle('show', last > S.chatSeen && chat[chat.length - 1].pid !== S.pid);
}
const chatOpen = () => $('#chat-sheet').classList.contains('show');
function openSheet(id) {
  closeSheets();
  $(id).classList.add('show'); $('#scrim').classList.add('show');
}
function closeSheets() { $$('.sheet').forEach((s) => s.classList.remove('show')); $('#scrim').classList.remove('show'); }
$('#scrim').addEventListener('click', closeSheets);
$$('.js-close').forEach((b) => b.addEventListener('click', closeSheets));
$('#t-chat').addEventListener('click', () => { openSheet('#chat-sheet'); renderChat(); });
$('#chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const t = $('#chat-input').value.trim();
  if (!t) return;
  send({ type: 'chat', text: t });
  $('#chat-input').value = '';
});
$('#quick').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) send({ type: 'chat', text: b.textContent }); });

// chat also reachable from waiting room via players bar long list — add a button there
const waitChat = document.createElement('button');
waitChat.className = 'btn ghost wide';
waitChat.style.marginTop = '12px';
waitChat.textContent = '💬 แชตกับเพื่อนในห้อง';
waitChat.addEventListener('click', () => { openSheet('#chat-sheet'); renderChat(); });
$('#waiting').appendChild(waitChat);

// ---------- settings ----------
const optMap = { colors: '#opt-colors', same: '#opt-same', autonotes: '#opt-autonotes', vibrate: '#opt-vibrate' };
for (const [k, sel] of Object.entries(optMap)) {
  $(sel).checked = !!S.opts[k];
  $(sel).addEventListener('change', (e) => { S.opts[k] = e.target.checked; saveOpts(); renderBoard(); });
}
$('#opt-dark').addEventListener('change', (e) => { S.opts.dark = e.target.checked; saveOpts(); applyTheme(); });
$('#open-settings').addEventListener('click', () => openSheet('#settings-sheet'));
$('#rename-btn').addEventListener('click', () => {
  closeSheets();
  askName(() => { if (S.code) send({ type: 'join', code: S.code, name: S.name }); });
});
$('#leave-btn').addEventListener('click', () => { closeSheets(); location.hash = '#/'; });
$('#room-back').addEventListener('click', () => {
  if (playing() && !confirm('ออกจากเกมนี้?')) return;
  location.hash = '#/';
});

// ---------- waiting room ----------
$('#start-btn').addEventListener('click', () => send({ type: 'start' }));
function shareLink() { return location.origin + location.pathname + '#/g/' + S.code; }
$('#share-btn').addEventListener('click', async () => {
  const url = shareLink();
  if (navigator.share) {
    try { await navigator.share({ title: 'Sudoku Gang', text: `มาเล่นซูโดกุกัน! รหัสห้อง ${S.code}`, url }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  copy(url, 'คัดลอกลิงก์แล้ว');
});
$('#copy-btn').addEventListener('click', () => copy(S.code, 'คัดลอกรหัสแล้ว'));
function copy(text, msg) {
  const done = () => toast(msg);
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, fallback);
  else fallback();
  function fallback() {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); done(); } catch { toast(text); }
    ta.remove();
  }
}

// ---------- results ----------
function showResults() {
  const R = S.room;
  const w = playerById(R.winnerId);
  $('#result-title').textContent = w ? (w.id === S.pid ? 'คุณชนะ! 🎉' : `${w.name} ชนะ!`) : 'จบเกม!';
  $('#ranking').innerHTML = sortedPlayers().map((p, k) => `
    <li class="${p.id === R.winnerId ? 'win' : ''}">
      <span class="pos">${k + 1}</span>
      <span class="av" style="background:${COLORS[p.color]}">${esc(initial(p.name))}</span>
      <span class="nm">${esc(p.name)}${p.id === S.pid ? ' (คุณ)' : ''}</span>
      <span class="sc">${R.mode === 'original' ? p.score + ' แต้ม' : p.progress + '%'}</span>
    </li>`).join('');
  $('#next-btn').style.display = R.nextCode ? '' : 'none';
  $('#result-modal').classList.add('show');
}
$('#next-btn').addEventListener('click', () => {
  const n = S.room && S.room.nextCode;
  $('#result-modal').classList.remove('show');
  if (n) location.hash = '#/g/' + n;
});
$('#view-board-btn').addEventListener('click', () => { S.resultDismissed = true; $('#result-modal').classList.remove('show'); });

// ---------- toast ----------
let toastT;
function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms);
}

// ---------- boot ----------
applyTheme();
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyTheme);
connect();
route();
