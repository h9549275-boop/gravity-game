(() => {
  "use strict";

  const ONLINE_LEVELS = [
    {
      name: "Track 01: Neon Sprint",
      spawn: { x: 64, y: 460 },
      portal: { x: 870, y: 462 },
      platforms: [
        { x: 24, y: 340, w: 260, h: 24 },
        { x: 380, y: 24, w: 24, h: 320 },
        { x: 520, y: 180, w: 260, h: 24 },
        { x: 680, y: 360, w: 256, h: 24 }
      ],
      crystals: [{ x: 165, y: 472 }, { x: 165, y: 80 }, { x: 645, y: 120 }],
      mines: [{ x: 470, y: 468, r: 16 }]
    },
    {
      name: "Track 02: Orbital Split",
      spawn: { x: 65, y: 460 },
      portal: { x: 870, y: 90 },
      platforms: [
        { x: 24, y: 260, w: 220, h: 24 },
        { x: 340, y: 140, w: 24, h: 376 },
        { x: 580, y: 24, w: 24, h: 340 },
        { x: 720, y: 150, w: 216, h: 24 }
      ],
      crystals: [{ x: 150, y: 120 }, { x: 460, y: 450 }, { x: 780, y: 340 }],
      mines: [{ x: 460, y: 250, r: 16 }, { x: 670, y: 450, r: 16 }]
    },
    {
      name: "Track 03: Void Gauntlet",
      spawn: { x: 65, y: 90 },
      portal: { x: 870, y: 460 },
      platforms: [
        { x: 24, y: 160, w: 200, h: 22 },
        { x: 300, y: 24, w: 24, h: 320 },
        { x: 540, y: 180, w: 24, h: 336 },
        { x: 740, y: 360, w: 196, h: 22 }
      ],
      crystals: [{ x: 140, y: 440 }, { x: 420, y: 100 }, { x: 660, y: 440 }],
      mines: [{ x: 420, y: 340, r: 16 }, { x: 810, y: 160, r: 16 }]
    }
  ];

  const OUTER = [
    { x: 0, y: 0, w: 960, h: 24 },
    { x: 0, y: 516, w: 960, h: 24 },
    { x: 0, y: 0, w: 24, h: 540 },
    { x: 936, y: 0, w: 24, h: 540 }
  ];
  const GRAV = { down: { x: 0, y: 1 }, up: { x: 0, y: -1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };

  let ws = null;
  let wsConnected = false;
  let myId = null;
  let currentRoom = null;
  let publicRooms = [];
  let leaderboard = [];
  let onlineActive = false;
  let modal = null;
  let raceCanvas = null, rCtx = null;
  let me = null;
  let coopCollected = new Set();
  let syncAccum = 0;
  const keys = {};
  const touchHold = { left: false, right: false };

  function wsUrl() {
    if (location.protocol === "file:") return "";
    const proto = location.protocol === "https:" ? "wss://" : "ws://";
    return proto + location.host;
  }

  function send(type, payload = {}) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type, ...payload }));
  }

  function connect(name) {
    const url = wsUrl();
    if (!url) {
      wsConnected = false;
      renderOnline();
      return;
    }
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    const savedToken = localStorage.getItem("gravity_ws_token");
    ws = new WebSocket(url);
    ws.onopen = () => {
      wsConnected = true;
      send("hello", { name: name || "Pilot", token: savedToken || undefined });
      send("list_rooms");
      send("get_leaderboard");
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "welcome") {
        myId = msg.id;
        localStorage.setItem("gravity_ws_token", msg.token);
        renderOnline();
      } else if (msg.type === "rooms_list") {
        publicRooms = msg.rooms || [];
        renderOnline();
      } else if (msg.type === "leaderboard") {
        leaderboard = msg.entries || [];
        renderOnline();
      } else if (msg.type === "room_joined" || msg.type === "room_update") {
        currentRoom = msg.room;
        renderOnline();
      } else if (msg.type === "match_start") {
        currentRoom = msg.room;
        startOnlineMatch();
      } else if (msg.type === "player_sync" && currentRoom) {
        const p = currentRoom.players.find((x) => x.id === msg.id);
        if (p) Object.assign(p, msg);
      } else if (msg.type === "coop_crystal") {
        coopCollected.add(msg.idx);
      } else if (msg.type === "player_finished" && currentRoom) {
        const p = currentRoom.players.find((x) => x.id === msg.id);
        if (p) { p.finished = true; p.finishTime = msg.time; }
        renderBanner(`🏁 ${msg.name}: ${msg.time}s`);
      } else if (msg.type === "match_end") {
        currentRoom = msg.room;
        onlineActive = false;
        touchHold.left = false;
        touchHold.right = false;
        send("get_leaderboard");
        renderOnline();
      } else if (msg.type === "error_msg") {
        alert(msg.message);
      }
    };
    ws.onclose = () => {
      wsConnected = false;
      renderOnline();
      setTimeout(() => {
        if (modal && !modal.classList.contains("hidden")) {
          connect(localStorage.getItem("gravity_nick") || "Pilot");
        }
      }, 2500);
    };
  }

  function renderBanner(txt) {
    const el = document.getElementById("onBanner");
    if (el) el.textContent = txt;
  }

  function buildModal() {
    modal = document.createElement("div");
    modal.className = "overlay hidden";
    modal.style.zIndex = "50";
    modal.style.padding = "8px";
    modal.innerHTML = `<div class="card" id="onCard" style="max-width:860px;padding:12px;"></div>`;
    document.body.appendChild(modal);

    window.addEventListener("keydown", (e) => {
      keys[e.code] = true;
      if (!onlineActive) return;
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(e.code)) e.preventDefault();
      if (e.code === "ArrowUp") setGrav("up");
      if (e.code === "ArrowDown") setGrav("down");
      if (e.code === "ArrowLeft") setGrav("left");
      if (e.code === "ArrowRight") setGrav("right");
      if (e.code === "Space") doJump();
    });
    window.addEventListener("keyup", (e) => { keys[e.code] = false; });
  }

  function setGrav(dir) {
    if (!me || me.gravDir === dir) return;
    me.gravDir = dir;
    me.grounded = false;
  }

  function doJump() {
    if (!me || !me.grounded) return;
    const g = GRAV[me.gravDir];
    if (g.x === 0) me.vy = -g.y * 430;
    else me.vx = -g.x * 430;
    me.grounded = false;
  }

  function startOnlineMatch() {
    onlineActive = true;
    touchHold.left = false;
    touchHold.right = false;
    coopCollected = new Set(currentRoom.coopCrystals || []);
    const lvl = ONLINE_LEVELS[currentRoom.levelIdx] || ONLINE_LEVELS[0];
    me = { x: lvl.spawn.x, y: lvl.spawn.y, w: 28, h: 28, vx: 0, vy: 0, gravDir: "down", facing: 1, grounded: false, finished: false };
    renderOnline();
    requestAnimationFrame(loopMatch);
  }

  function aabb(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  function drawBot(ctx, x, y, gravDir, color, label) {
    const rot = { down: 0, up: Math.PI, left: Math.PI / 2, right: -Math.PI / 2 }[gravDir] || 0;
    ctx.save();
    ctx.translate(x + 14, y + 14);
    ctx.rotate(rot);
    ctx.fillStyle = color;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    ctx.fillRect(-13, -13, 26, 26);
    ctx.strokeRect(-13, -13, 26, 26);
    ctx.fillStyle = "#090d1f";
    ctx.fillRect(-9, -6, 18, 8);
    ctx.fillStyle = "#fff";
    ctx.fillRect(-6, -4, 4, 4);
    ctx.fillRect(2, -4, 4, 4);
    ctx.restore();
    if (label) {
      ctx.fillStyle = "#e2e8f0";
      ctx.font = "bold 12px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(label, x + 14, y - 8);
    }
  }

  let lastT = performance.now();
  function loopMatch(ts) {
    if (!onlineActive || !currentRoom) return;
    const dt = Math.min(0.033, (ts - lastT) / 1000);
    lastT = ts;

    const lvl = ONLINE_LEVELS[currentRoom.levelIdx] || ONLINE_LEVELS[0];
    const g = GRAV[me.gravDir];
    const solids = [...OUTER, ...lvl.platforms];

    if (!me.finished) {
      let ax = 0;
      if (keys["KeyA"] || touchHold.left || (g.x !== 0 && keys["KeyW"])) ax -= 1;
      if (keys["KeyD"] || touchHold.right || (g.x !== 0 && keys["KeyS"])) ax += 1;
      if (ax !== 0) me.facing = ax;

      if (g.x === 0) {
        me.vx += (ax * 260 - me.vx) * Math.min(1, dt * 14);
        me.vy = Math.max(-560, Math.min(560, me.vy + g.y * 960 * dt));
      } else {
        me.vy += (ax * 260 - me.vy) * Math.min(1, dt * 14);
        me.vx = Math.max(-560, Math.min(560, me.vx + g.x * 960 * dt));
      }
      me.grounded = false;
      me.x += me.vx * dt;
      for (const s of solids) {
        if (aabb(me, s)) {
          if (me.vx > 0) { me.x = s.x - me.w; if (g.x > 0) me.grounded = true; }
          else if (me.vx < 0) { me.x = s.x + s.w; if (g.x < 0) me.grounded = true; }
          me.vx = 0;
        }
      }
      me.y += me.vy * dt;
      for (const s of solids) {
        if (aabb(me, s)) {
          if (me.vy > 0) { me.y = s.y - me.h; if (g.y > 0) me.grounded = true; }
          else if (me.vy < 0) { me.y = s.y + s.h; if (g.y < 0) me.grounded = true; }
          me.vy = 0;
        }
      }

      const cx = me.x + 14, cy = me.y + 14;
      for (const m of lvl.mines) {
        if (Math.hypot(cx - m.x, cy - m.y) < m.r + 12) {
          me.x = lvl.spawn.x; me.y = lvl.spawn.y; me.vx = 0; me.vy = 0; me.gravDir = "down";
        }
      }
      lvl.crystals.forEach((c, idx) => {
        if (!coopCollected.has(idx) && Math.hypot(cx - c.x, cy - c.y) < 26) {
          coopCollected.add(idx);
          if (currentRoom.mode === "coop") send("collect_crystal", { idx });
        }
      });
      if (Math.hypot(cx - lvl.portal.x, cy - lvl.portal.y) < 30) {
        me.finished = true;
        send("finish_run");
      }
    }

    syncAccum += dt;
    if (syncAccum >= 0.05) {
      syncAccum = 0;
      send("player_state", { x: me.x, y: me.y, gravDir: me.gravDir, facing: me.facing, color: "#00f0ff" });
    }

    if (rCtx) {
      rCtx.fillStyle = "#050816";
      rCtx.fillRect(0, 0, 960, 540);
      for (const s of solids) {
        rCtx.fillStyle = "#111c3a"; rCtx.fillRect(s.x, s.y, s.w, s.h);
        rCtx.strokeStyle = "#00f0ff"; rCtx.lineWidth = 2; rCtx.strokeRect(s.x, s.y, s.w, s.h);
      }
      rCtx.strokeStyle = "#a855f7"; rCtx.lineWidth = 4;
      rCtx.beginPath(); rCtx.arc(lvl.portal.x, lvl.portal.y, 20, 0, Math.PI * 2); rCtx.stroke();

      lvl.crystals.forEach((c, idx) => {
        if (currentRoom.mode === "coop" && coopCollected.has(idx)) return;
        rCtx.fillStyle = "#00f0ff";
        rCtx.beginPath(); rCtx.arc(c.x, c.y, 8, 0, Math.PI * 2); rCtx.fill();
      });
      for (const m of lvl.mines) {
        rCtx.fillStyle = "#ef4444";
        rCtx.beginPath(); rCtx.arc(m.x, m.y, m.r, 0, Math.PI * 2); rCtx.fill();
      }
      for (const p of currentRoom.players) {
        if (p.id === myId) continue;
        drawBot(rCtx, p.x, p.y, p.gravDir, "#a855f7", p.name);
      }
      drawBot(rCtx, me.x, me.y, me.gravDir, "#00f0ff", "");
    }

    requestAnimationFrame(loopMatch);
  }

  function bindTouchPad(container) {
    container.querySelectorAll("[data-onhold]").forEach((btn) => {
      const dir = btn.dataset.onhold;
      const on = (e) => { e.preventDefault(); touchHold[dir] = true; btn.classList.add("pressed"); };
      const off = (e) => { e.preventDefault(); touchHold[dir] = false; btn.classList.remove("pressed"); };
      btn.addEventListener("touchstart", on, { passive: false });
      btn.addEventListener("touchend", off);
      btn.addEventListener("touchcancel", off);
      btn.addEventListener("mousedown", on);
      btn.addEventListener("mouseup", off);
      btn.addEventListener("mouseleave", off);
    });
    container.querySelectorAll("[data-ongrav]").forEach((btn) => {
      const act = (e) => { e.preventDefault(); setGrav(btn.dataset.ongrav); };
      btn.addEventListener("touchstart", act, { passive: false });
      btn.addEventListener("mousedown", act);
    });
    const jBtn = container.querySelector('[data-ontap="jump"]');
    if (jBtn) {
      jBtn.addEventListener("touchstart", (e) => { e.preventDefault(); doJump(); }, { passive: false });
      jBtn.addEventListener("mousedown", () => doJump());
    }
  }

  function renderOnline() {
    const card = document.getElementById("onCard");
    if (!card) return;
    const nick = localStorage.getItem("gravity_nick") || "Pilot";

    if (onlineActive && currentRoom) {
      card.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;font-size:13px;">
          <b>🌐 ${currentRoom.code} (${currentRoom.mode.toUpperCase()})</b>
          <span id="onBanner" style="color:#34d399;font-weight:700;"></span>
          <button class="btn btn-sm" id="onLeave">خروج</button>
        </div>
        <canvas id="raceCanvas" width="960" height="540" style="width:100%;max-height:52vh;object-fit:contain;border:1px solid #00f0ff;border-radius:10px;background:#050816;"></canvas>
        <div class="controls-bar" id="onTouchBar" style="margin-top:6px;">
          <div class="touch-cluster">
            <button class="t-btn" data-onhold="left">◀</button>
            <button class="t-btn" data-onhold="right">▶</button>
            <button class="t-btn wide" data-ontap="jump">قفز</button>
          </div>
          <div class="touch-cluster">
            <div class="grav-pad">
              <div></div><button class="t-btn" data-ongrav="up">▲</button><div></div>
              <button class="t-btn" data-ongrav="left">◀</button>
              <div style="display:flex;align-items:center;justify-content:center;font-size:11px;color:#00f0ff;font-weight:700;">G</div>
              <button class="t-btn" data-ongrav="right">▶</button>
              <div></div><button class="t-btn" data-ongrav="down">▼</button><div></div>
            </div>
          </div>
        </div>
      `;
      raceCanvas = document.getElementById("raceCanvas");
      rCtx = raceCanvas.getContext("2d");
      bindTouchPad(document.getElementById("onTouchBar"));
      document.getElementById("onLeave").onclick = () => {
        onlineActive = false;
        touchHold.left = false;
        touchHold.right = false;
        send("leave_room");
        currentRoom = null;
        renderOnline();
      };
      return;
    }

    if (currentRoom) {
      const isHost = currentRoom.hostId === myId;
      const plist = currentRoom.players.map((p) => `
        <div class="item-card">${p.name} ${p.id === currentRoom.hostId ? "👑" : ""} — ${p.ready ? "✅ جاهز" : "⏳"} ${p.finishTime ? `(${p.finishTime}s)` : ""}</div>
      `).join("");
      card.innerHTML = `
        <h2 style="margin:0 0 6px;">غرفة اللعب: <span style="color:#00f0ff;">${currentRoom.code}</span></h2>
        <p style="color:#94a3b8;font-size:13px;">الطور: ${currentRoom.mode} • اللاعبين: ${currentRoom.players.length}/4</p>
        <div class="grid">${plist}</div>
        <div class="menu-actions">
          ${isHost ? `<button class="btn btn-primary" id="onStart">▶ ابدأ السباق</button>` : `<button class="btn" id="onReady">✅ جاهز</button>`}
          <button class="btn" id="onLeave">← مغادرة الغرفة</button>
        </div>
      `;
      if (isHost) document.getElementById("onStart").onclick = () => send("start_match");
      else document.getElementById("onReady").onclick = () => send("toggle_ready");
      document.getElementById("onLeave").onclick = () => { send("leave_room"); currentRoom = null; renderOnline(); };
      return;
    }

    const statusBadge = wsConnected
      ? `<span style="color:#34d399;font-size:12px;">🟢 متصل بالخادم</span>`
      : `<span style="color:#f87171;font-size:12px;">🔴 غير متصل بالخادم (افتح اللعبة من رابط Render)</span>`;

    const rHtml = publicRooms.length
      ? publicRooms.map((r) => `<div class="item-card" data-join="${r.code}"><b>${r.code}</b> — ${r.hostName} (${r.count}/4 • ${r.mode})</div>`).join("")
      : `<div style="color:#94a3b8;font-size:13px;">لا توجد غرف عامة مفتوحة حالياً</div>`;
    const lbHtml = leaderboard.slice(0, 6).map((e, i) => `<div>#${i + 1} <b>${e.name}</b> — Lvl ${e.level} — ${e.time}s</div>`).join("");

    card.innerHTML = `
      <h2 style="margin:0 0 4px;">🌐 اللعب أونلاين</h2>
      <div style="margin-bottom:8px;">${statusBadge}</div>
      <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-bottom:10px;">
        <input id="onNick" value="${nick}" maxlength="16" placeholder="اسمك" style="padding:7px 10px;border-radius:8px;border:1px solid #00f0ff;background:#090f24;color:#fff;width:130px;" />
        <select id="onMode" style="padding:7px;border-radius:8px;background:#090f24;color:#fff;border:1px solid #a855f7;">
          <option value="race">سباق (Race)</option>
          <option value="coop">تعاون (Co-op)</option>
        </select>
        <select id="onTrack" style="padding:7px;border-radius:8px;background:#090f24;color:#fff;border:1px solid #a855f7;">
          ${ONLINE_LEVELS.map((l, i) => `<option value="${i}">${l.name}</option>`).join("")}
        </select>
      </div>
      <div class="menu-actions" style="margin-top:0;margin-bottom:10px;">
        <button class="btn btn-primary" id="onCreate">+ إنشاء غرفة</button>
        <button class="btn" id="onCreatePriv">🔒 غرفة خاصة</button>
      </div>
      <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-bottom:10px;">
        <input id="onCode" maxlength="5" placeholder="كود الغرفة" style="padding:7px 10px;border-radius:8px;border:1px solid #00f0ff;background:#090f24;color:#fff;text-transform:uppercase;width:120px;" />
        <button class="btn" id="onJoinBtn">دخول بالكود</button>
        <button class="btn" id="onRefresh">↻ تحديث</button>
      </div>
      <div class="section-title">الغرف العامة</div>
      <div class="grid">${rHtml}</div>
      <div class="section-title">🏆 لوحة الترتيب العالمية</div>
      <div style="font-size:13px;text-align:start;background:rgba(255,255,255,0.03);padding:8px;border-radius:10px;">${lbHtml || "لا توجد نتائج بعد"}</div>
      <div class="menu-actions"><button class="btn" id="onClose">إغلاق</button></div>
    `;

    const saveNick = () => {
      const n = document.getElementById("onNick").value.trim() || "Pilot";
      localStorage.setItem("gravity_nick", n);
      send("set_name", { name: n });
    };
    document.getElementById("onCreate").onclick = () => {
      saveNick();
      send("create_room", { mode: document.getElementById("onMode").value, levelIdx: Number(document.getElementById("onTrack").value), isPrivate: false });
    };
    document.getElementById("onCreatePriv").onclick = () => {
      saveNick();
      send("create_room", { mode: document.getElementById("onMode").value, levelIdx: Number(document.getElementById("onTrack").value), isPrivate: true });
    };
    document.getElementById("onJoinBtn").onclick = () => {
      saveNick();
      send("join_room", { code: document.getElementById("onCode").value });
    };
    document.getElementById("onRefresh").onclick = () => { send("list_rooms"); send("get_leaderboard"); };
    document.getElementById("onClose").onclick = () => modal.classList.add("hidden");
    card.querySelectorAll("[data-join]").forEach((el) => {
      el.onclick = () => { saveNick(); send("join_room", { code: el.dataset.join }); };
    });
  }

  window.addEventListener("DOMContentLoaded", () => {
    buildModal();
    const groups = document.querySelectorAll(".hud-group");
    const btnGroup = groups[1] || groups[0];
    if (btnGroup) {
      const btn = document.createElement("button");
      btn.className = "btn btn-sm";
      btn.textContent = "🌐 أونلاين";
      btn.onclick = () => {
        modal.classList.remove("hidden");
        connect(localStorage.getItem("gravity_nick") || "Pilot");
        renderOnline();
      };
      btnGroup.prepend(btn);
    }
  });
})();