// Sudoku Gang — live multiplayer sudoku server (static files + WebSocket).
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { generate } = require('./sudoku');

const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, 'public');
const MAX_PLAYERS = 10;
const POINTS = [10, 6, 3]; // 1st, 2nd, 3rd solver of a cell; everyone after gets 1
const PENALTY = 5;
const DIFFS = ['easy', 'medium', 'hard', 'extreme'];
const MODES = ['original', 'hardcore'];
const COLORS = 10;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon',
};

// ---------- static files ----------
const server = http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { p = '/'; }
  if (p === '/healthz') { res.writeHead(200); return res.end('ok'); }
  if (p.endsWith('/')) p += 'index.html';
  const fp = path.normalize(path.join(PUB, p));
  if (!fp.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(fp, (err, data) => {
    if (err) {
      return fs.readFile(path.join(PUB, 'index.html'), (e2, html) => {
        res.writeHead(e2 ? 404 : 200, { 'Content-Type': MIME['.html'] });
        res.end(e2 ? 'Not found' : html);
      });
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

// ---------- rooms ----------
const rooms = new Map();

function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let c;
  do { c = Array.from({ length: 4 }, () => A[Math.floor(Math.random() * A.length)]).join(''); }
  while (rooms.has(c));
  return c;
}

function createRoom({ difficulty, mode, isPublic }) {
  const { puzzle, solution } = generate(difficulty);
  const room = {
    code: newCode(), difficulty, mode, isPublic: !!isPublic,
    status: 'waiting', hostId: null, puzzle, solution,
    empties: puzzle.filter((v) => !v).length,
    players: new Map(), solvers: Array.from({ length: 81 }, () => []),
    chat: [], createdAt: Date.now(), startedAt: null, endedAt: null,
    winnerId: null, nextCode: null, lastActive: Date.now(),
  };
  rooms.set(room.code, room);
  return room;
}

function freeColor(room) {
  const used = new Set([...room.players.values()].map((p) => p.color));
  for (let i = 0; i < COLORS; i++) if (!used.has(i)) return i;
  return 0;
}

function progress(room, p) {
  let done = 0;
  for (let i = 0; i < 81; i++) if (!room.puzzle[i] && (p.board[i] || p.locked.has(i))) done++;
  return room.empties ? done / room.empties : 1;
}

function publicPlayers(room) {
  return [...room.players.values()].map((p) => ({
    id: p.id, name: p.name, color: p.color, score: p.score,
    progress: Math.round(progress(room, p) * 100), connected: !!p.ws, left: p.left,
  }));
}

function snapshot(room, p) {
  const show = room.status !== 'waiting';
  return {
    type: 'state', serverNow: Date.now(),
    room: {
      code: room.code, difficulty: room.difficulty, mode: room.mode, isPublic: room.isPublic,
      status: room.status, hostId: room.hostId, startedAt: room.startedAt, endedAt: room.endedAt,
      winnerId: room.winnerId, nextCode: room.nextCode,
      puzzle: show ? room.puzzle : null,
      owner: show && room.mode === 'original'
        ? room.solvers.map((s) => (s.length ? room.players.get(s[0])?.color ?? -1 : -1)) : null,
      players: publicPlayers(room), chat: room.chat.slice(-60),
    },
    me: p ? { id: p.id, board: show ? p.board : null, locked: [...p.locked] } : null,
  };
}

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcast(room, extra) {
  room.lastActive = Date.now();
  for (const p of room.players.values()) {
    if (!p.ws) continue;
    if (extra) send(p.ws, extra);
    send(p.ws, snapshot(room, p));
  }
}

function lobbyList() {
  const list = [];
  for (const r of rooms.values()) {
    if (!r.isPublic || r.status === 'finished') continue;
    const active = [...r.players.values()].filter((p) => !p.left);
    if (!active.some((p) => p.ws) || active.length >= MAX_PLAYERS) continue;
    list.push({
      code: r.code, difficulty: r.difficulty, mode: r.mode, status: r.status,
      count: active.length, max: MAX_PLAYERS, since: r.startedAt || r.createdAt,
    });
  }
  list.sort((a, b) => b.since - a.since);
  return { type: 'lobby', serverNow: Date.now(), rooms: list };
}

function pickHost(room) {
  const cur = room.players.get(room.hostId);
  if (cur && cur.ws && !cur.left) return;
  const next = [...room.players.values()].find((p) => p.ws && !p.left);
  if (next) room.hostId = next.id;
}

function endGame(room, winnerId) {
  if (room.status !== 'playing') return;
  room.status = 'finished';
  room.endedAt = Date.now();
  if (winnerId) room.winnerId = winnerId;
  else {
    const best = [...room.players.values()].sort((a, b) => b.score - a.score)[0];
    room.winnerId = best ? best.id : null;
  }
  const next = createRoom(room);
  room.nextCode = next.code;
  broadcast(room, { type: 'fx', kind: 'end', pid: room.winnerId });
}

function cleanName(s) {
  return String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16) || 'ผู้เล่น';
}

// ---------- message handlers ----------
const handlers = {
  hello(ws, m) {
    if (typeof m.pid === 'string' && m.pid.length <= 64) ws.pid = m.pid;
  },

  lobby(ws) { send(ws, lobbyList()); },

  create(ws, m) {
    if (!ws.pid) return;
    const room = createRoom({
      difficulty: DIFFS.includes(m.difficulty) ? m.difficulty : 'medium',
      mode: MODES.includes(m.mode) ? m.mode : 'original',
      isPublic: !!m.isPublic,
    });
    send(ws, { type: 'created', code: room.code });
  },

  join(ws, m) {
    if (!ws.pid) return;
    const code = String(m.code || '').toUpperCase();
    const room = rooms.get(code);
    if (!room) return send(ws, { type: 'error', code: 'notfound', message: 'ไม่พบห้องนี้' });
    leaveCurrent(ws, code);
    let p = room.players.get(ws.pid);
    if (!p) {
      if (room.status === 'finished') {
        return send(ws, { type: 'error', code: 'finished', next: room.nextCode, message: 'เกมนี้จบแล้ว' });
      }
      const active = [...room.players.values()].filter((x) => !x.left).length;
      if (active >= MAX_PLAYERS) return send(ws, { type: 'error', code: 'full', message: 'ห้องเต็มแล้ว (10 คน)' });
      p = {
        id: ws.pid, name: cleanName(m.name), color: freeColor(room), score: 0,
        board: room.puzzle.slice(), locked: new Set(), ws: null, left: false,
      };
      room.players.set(p.id, p);
    }
    if (p.ws && p.ws !== ws) { p.ws.code = null; }
    p.ws = ws; p.left = false; p.name = cleanName(m.name || p.name);
    ws.code = code;
    pickHost(room);
    broadcast(room);
  },

  leave(ws) { leaveCurrent(ws); },

  start(ws) {
    const room = rooms.get(ws.code);
    if (!room || room.status !== 'waiting' || room.hostId !== ws.pid) return;
    room.status = 'playing';
    room.startedAt = Date.now();
    broadcast(room, { type: 'fx', kind: 'start' });
  },

  move(ws, m) {
    const room = rooms.get(ws.code);
    if (!room || room.status !== 'playing') return;
    const p = room.players.get(ws.pid);
    const cell = m.cell | 0, value = m.value | 0;
    if (!p || cell < 0 || cell > 80 || value < 0 || value > 9 || room.puzzle[cell]) return;

    if (room.mode === 'original') {
      if (!value || p.board[cell] || p.locked.has(cell)) return;
      if (value === room.solution[cell]) {
        p.board[cell] = value;
        const rank = room.solvers[cell].length;
        const pts = rank < POINTS.length ? POINTS[rank] : 1;
        room.solvers[cell].push(p.id);
        p.score += pts;
        broadcast(room, { type: 'fx', kind: 'solve', pid: p.id, cell, points: pts, rank });
      } else {
        p.locked.add(cell);
        p.board[cell] = room.solution[cell];
        p.score -= PENALTY;
        broadcast(room, { type: 'fx', kind: 'wrong', pid: p.id, cell, points: -PENALTY });
      }
      if (progress(room, p) >= 1) endGame(room, null);
    } else {
      p.board[cell] = value;
      const full = p.board.every((v) => v);
      const correct = full && p.board.every((v, i) => v === room.solution[i]);
      if (correct) return endGame(room, p.id);
      broadcast(room);
      if (full) send(ws, { type: 'fx', kind: 'notyet' });
    }
  },

  chat(ws, m) {
    const room = rooms.get(ws.code);
    const p = room && room.players.get(ws.pid);
    if (!p) return;
    const now = Date.now();
    if (ws.lastChat && now - ws.lastChat < 400) return;
    ws.lastChat = now;
    const text = String(m.text || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 200);
    if (!text) return;
    room.chat.push({ pid: p.id, name: p.name, color: p.color, text, t: now });
    if (room.chat.length > 100) room.chat.shift();
    broadcast(room);
  },
};

function leaveCurrent(ws, exceptCode) {
  const code = ws.code;
  if (!code || code === exceptCode) return;
  ws.code = null;
  const room = rooms.get(code);
  const p = room && room.players.get(ws.pid);
  if (!p) return;
  if (room.status === 'waiting') room.players.delete(p.id);
  else { p.left = true; p.ws = null; }
  pickHost(room);
  broadcast(room);
}

// ---------- websocket ----------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });
wss.on('connection', (ws) => {
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    const h = m && handlers[m.type];
    if (h) {
      try { h(ws, m); } catch (e) { console.error('handler error', m.type, e); }
    }
  });
  ws.on('close', () => {
    const room = rooms.get(ws.code);
    const p = room && room.players.get(ws.pid);
    if (p && p.ws === ws) {
      p.ws = null;
      pickHost(room);
      broadcast(room);
    }
  });
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false;
    ws.ping();
  }
}, 25000);

// Drop idle rooms.
setInterval(() => {
  const now = Date.now();
  for (const [code, r] of rooms) {
    const anyone = [...r.players.values()].some((p) => p.ws);
    const idle = now - r.lastActive;
    if ((!anyone && idle > 15 * 60e3) || (r.status === 'finished' && idle > 60 * 60e3)) rooms.delete(code);
  }
}, 60e3);

server.listen(PORT, () => console.log(`Sudoku Gang running on http://localhost:${PORT}`));
