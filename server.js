const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const LB_FILE = path.join(__dirname, "leaderboard.json");

// Load / Save persistent leaderboard
let leaderboard = [];
try {
  if (fs.existsSync(LB_FILE)) {
    leaderboard = JSON.parse(fs.readFileSync(LB_FILE, "utf8")) || [];
  }
} catch (_) {
  leaderboard = [];
}
function saveLeaderboard() {
  try {
    fs.writeFileSync(LB_FILE, JSON.stringify(leaderboard.slice(0, 30), null, 2));
  } catch (_) {}
}

// Static HTTP server for public/
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};
const server = http.createServer((req, res) => {
  const cleanUrl = (req.url || "/").split("?")[0];
  let filePath = path.join(PUBLIC_DIR, cleanUrl === "/" ? "index.html" : cleanUrl);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end("Not Found");
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
});

// WebSocket Server
const wss = new WebSocketServer({ server });
const rooms = new Map(); // code -> Room
const sessions = new Map(); // token -> { id, name, roomCode, ws, disconnectTimer }

function genCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return rooms.has(code) ? genCode() : code;
}

function safeName(raw) {
  const s = String(raw || "Player").replace(/[<>]/g, "").trim().slice(0, 16);
  return s || "Player";
}

function send(ws, type, payload = {}) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type, ...payload }));
  }
}

function broadcastRoom(room, type, payload = {}, excludeId = null) {
  for (const p of room.players) {
    if (p.id !== excludeId && p.ws && p.ws.readyState === 1) {
      send(p.ws, type, payload);
    }
  }
}

function serializeRoom(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    mode: room.mode,
    isPrivate: room.isPrivate,
    levelIdx: room.levelIdx,
    state: room.state,
    startTs: room.startTs,
    coopCrystals: Array.from(room.coopCrystals),
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      ready: p.ready,
      disconnected: p.disconnected,
      finished: p.finished,
      finishTime: p.finishTime,
      x: p.x,
      y: p.y,
      gravDir: p.gravDir,
      facing: p.facing,
      color: p.color
    }))
  };
}

function getPublicRooms() {
  const list = [];
  for (const r of rooms.values()) {
    if (!r.isPrivate && r.players.length < 4) {
      const host = r.players.find((p) => p.id === r.hostId);
      list.push({
        code: r.code,
        hostName: host ? host.name : "Host",
        count: r.players.length,
        mode: r.mode,
        levelIdx: r.levelIdx,
        state: r.state
      });
    }
  }
  return list;
}

function removePlayerFromRoom(playerId, roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  room.players = room.players.filter((p) => p.id !== playerId);
  if (room.players.length === 0) {
    rooms.delete(roomCode);
    return;
  }
  if (room.hostId === playerId) {
    room.hostId = room.players[0].id;
  }
  broadcastRoom(room, "room_update", { room: serializeRoom(room) });
}

wss.on("connection", (ws) => {
  let session = null;

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (_) {
      return;
    }

    if (msg.type === "hello") {
      if (msg.token && sessions.has(msg.token)) {
        session = sessions.get(msg.token);
        if (session.disconnectTimer) {
          clearTimeout(session.disconnectTimer);
          session.disconnectTimer = null;
        }
        session.ws = ws;
        if (msg.name) session.name = safeName(msg.name);
        send(ws, "welcome", { id: session.id, token: session.token, name: session.name });
        if (session.roomCode && rooms.has(session.roomCode)) {
          const room = rooms.get(session.roomCode);
          const p = room.players.find((x) => x.id === session.id);
          if (p) {
            p.ws = ws;
            p.disconnected = false;
            send(ws, "room_joined", { room: serializeRoom(room) });
            broadcastRoom(room, "room_update", { room: serializeRoom(room) }, session.id);
          }
        }
        return;
      }

      const id = crypto.randomUUID().slice(0, 8);
      const token = crypto.randomUUID();
      session = { id, token, name: safeName(msg.name), roomCode: null, ws, disconnectTimer: null };
      sessions.set(token, session);
      send(ws, "welcome", { id, token, name: session.name });
      return;
    }

    if (!session) return;

    if (msg.type === "set_name") {
      session.name = safeName(msg.name);
      return;
    }

    if (msg.type === "list_rooms") {
      send(ws, "rooms_list", { rooms: getPublicRooms() });
      return;
    }

    if (msg.type === "get_leaderboard") {
      send(ws, "leaderboard", { entries: leaderboard.slice(0, 15) });
      return;
    }

    if (msg.type === "create_room") {
      if (session.roomCode) removePlayerFromRoom(session.id, session.roomCode);
      const code = genCode();
      const levelIdx = Math.max(0, Math.min(2, Number(msg.levelIdx) || 0));
      const mode = msg.mode === "coop" ? "coop" : "race";
      const room = {
        code,
        hostId: session.id,
        mode,
        isPrivate: Boolean(msg.isPrivate),
        levelIdx,
        state: "lobby",
        startTs: 0,
        coopCrystals: new Set(),
        players: [{
          id: session.id,
          name: session.name,
          ws,
          ready: true,
          disconnected: false,
          finished: false,
          finishTime: null,
          x: 64,
          y: 460,
          gravDir: "down",
          facing: 1,
          color: "#00f0ff"
        }]
      };
      rooms.set(code, room);
      session.roomCode = code;
      send(ws, "room_joined", { room: serializeRoom(room) });
      return;
    }

    if (msg.type === "join_room") {
      const code = String(msg.code || "").toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) return send(ws, "error_msg", { message: "Room not found" });
      if (room.players.length >= 4) return send(ws, "error_msg", { message: "Room is full (max 4)" });
      if (session.roomCode && session.roomCode !== code) {
        removePlayerFromRoom(session.id, session.roomCode);
      }
      if (!room.players.some((p) => p.id === session.id)) {
        room.players.push({
          id: session.id,
          name: session.name,
          ws,
          ready: false,
          disconnected: false,
          finished: false,
          finishTime: null,
          x: 64,
          y: 460,
          gravDir: "down",
          facing: 1,
          color: "#a855f7"
        });
      }
      session.roomCode = code;
      send(ws, "room_joined", { room: serializeRoom(room) });
      broadcastRoom(room, "room_update", { room: serializeRoom(room) }, session.id);
      return;
    }

    if (msg.type === "leave_room") {
      if (session.roomCode) {
        removePlayerFromRoom(session.id, session.roomCode);
        session.roomCode = null;
      }
      return;
    }

    const room = session.roomCode ? rooms.get(session.roomCode) : null;
    if (!room) return;
    const me = room.players.find((p) => p.id === session.id);
    if (!me) return;

    if (msg.type === "toggle_ready") {
      me.ready = !me.ready;
      broadcastRoom(room, "room_update", { room: serializeRoom(room) });
      return;
    }

    if (msg.type === "start_match") {
      if (room.hostId !== session.id) return;
      room.state = "playing";
      room.startTs = Date.now();
      room.coopCrystals = new Set();
      for (const p of room.players) {
        p.finished = false;
        p.finishTime = null;
        p.x = 64;
        p.y = 460;
        p.gravDir = "down";
      }
      broadcastRoom(room, "match_start", { room: serializeRoom(room) });
      return;
    }

    if (msg.type === "player_state" && room.state === "playing") {
      // Server-side bounds clamping (Anti-Cheat)
      me.x = Math.max(24, Math.min(936, Number(msg.x) || 64));
      me.y = Math.max(24, Math.min(516, Number(msg.y) || 460));
      me.gravDir = ["down", "up", "left", "right"].includes(msg.gravDir) ? msg.gravDir : "down";
      me.facing = msg.facing === -1 ? -1 : 1;
      me.color = typeof msg.color === "string" && /^#[0-9a-fA-F]{6}$/.test(msg.color) ? msg.color : "#00f0ff";
      broadcastRoom(room, "player_sync", {
        id: me.id,
        x: me.x,
        y: me.y,
        gravDir: me.gravDir,
        facing: me.facing,
        color: me.color
      }, me.id);
      return;
    }

    if (msg.type === "collect_crystal" && room.state === "playing" && room.mode === "coop") {
      const idx = Number(msg.idx);
      if (Number.isInteger(idx) && idx >= 0 && idx < 10 && !room.coopCrystals.has(idx)) {
        room.coopCrystals.add(idx);
        broadcastRoom(room, "coop_crystal", { idx, by: me.name });
      }
      return;
    }

    if (msg.type === "finish_run" && room.state === "playing" && !me.finished) {
      // Server-authoritative elapsed time + sanity anti-cheat check (>= 2.0s)
      const elapsed = Number(((Date.now() - room.startTs) / 1000).toFixed(2));
      if (elapsed < 2.0) {
        return send(ws, "error_msg", { message: "Invalid run time rejected by server" });
      }
      me.finished = true;
      me.finishTime = elapsed;

      leaderboard.push({
        name: me.name,
        level: room.levelIdx + 1,
        mode: room.mode,
        time: elapsed,
        date: new Date().toISOString().slice(0, 10)
      });
      leaderboard.sort((a, b) => a.time - b.time);
      leaderboard = leaderboard.slice(0, 30);
      saveLeaderboard();

      broadcastRoom(room, "player_finished", { id: me.id, name: me.name, time: elapsed });
      const allDone = room.players.every((p) => p.finished || p.disconnected);
      if (allDone) {
        room.state = "lobby";
        broadcastRoom(room, "match_end", { room: serializeRoom(room) });
      }
    }
  });

  ws.on("close", () => {
    if (!session) return;
    if (session.roomCode && rooms.has(session.roomCode)) {
      const room = rooms.get(session.roomCode);
      const p = room.players.find((x) => x.id === session.id);
      if (p) {
        p.disconnected = true;
        p.ws = null;
        broadcastRoom(room, "room_update", { room: serializeRoom(room) });
      }
      // Keep slot for 25s for reconnection
      const code = session.roomCode;
      session.disconnectTimer = setTimeout(() => {
        removePlayerFromRoom(session.id, code);
        session.roomCode = null;
      }, 25000);
    }
  });
});

server.listen(PORT, () => {
  console.log(`GRAVITY Online Server running on http://localhost:${PORT}`);
});