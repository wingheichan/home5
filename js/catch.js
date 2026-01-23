
(async function () {
  // ===== Shared utilities from util.js =====
  const { Timer, SFX, showPreview } = window.AppUtil;

  // ===== Data load =====
  const DATA = await (await fetch('data/catch.json')).json();

  // ===== DOM helpers =====
  const $  = s => document.querySelector(s);
  const $$ = (s, r = document) => Array.from((r || document).querySelectorAll(s));

  // ===== UI elements =====
  const selCat   = $('#catchCat');
  const selSub   = $('#catchSub');
  const selMode  = $('#catchMode');
  const stage    = $('#catchStage');
  const player   = $('#catchPlayer');

  const tOut     = $('#catchTime');
  const cOut     = $('#catchCorrect');
  const sOut     = $('#catchScore');
  const hOut     = $('#catchHigh');
  const targetEl = $('#catchTarget'); // shows progress pills (HTML you added)

  const timer = new Timer(tOut);

  // ======= Tunables (easy size & speed edits) =======
  // Balloon visual size (px)
  const BALLOON_W = 44;
  const BALLOON_H = 56;

  // Player (boy) visual size (px)
  const PLAYER_W = 44;
  const PLAYER_H = 62;

  // Token font size inside balloons (px)
  const TOKEN_FONT_PX = 14;

  // Keyboard move speed (px per keydown step)
  const KEY_MOVE_PX = 6;

  // Mobile button move speed (px per tap)
  const TAP_MOVE_PX = 24;

  // Base falling speed (px/s) multiplied by per-item "speed"
  const BASE_FALL_SPEED = 80;

  // ===== State =====
  let running = false;
  let rafId   = 0;

  let balloons   = [];  // active falling objects
  let spawnPool  = [];  // cached pool for spawns based on chosen item
  let score      = 0;
  let correct    = 0;
  let combo      = 0;

  // Player state
  let playerX = 0;

  // Target sequence state
  let targetTokens = []; // array of strings (letters OR words) to collect
  let nextIndex    = 0;  // index in targetTokens we need to catch next

  // Spawn controls
  let spawnTimer    = 0;
  let spawnInterval = 1200; // ms
  let fallSpeed     = BASE_FALL_SPEED;
  let lastTs        = 0;

  // ===== Helpers: select fill =====
  function fill(sel, items) {
    sel.innerHTML = '';
    items.forEach(v => sel.append(new Option(v, v)));
  }

  // ===== Highscore / Leaderboard keys =====
  function hsKey() { return `highscore:catch:${selCat.value}:${selSub.value}:${selMode.value}`; }
  function lbKey() { return `catch:${selCat.value}:${selSub.value}:${selMode.value}`; }

  function loadHigh() {
    const raw = localStorage.getItem(hsKey());
    const v = raw ? JSON.parse(raw) : 0;
    hOut.textContent = String(v);
  }

  // ===== Build selects =====
  fill(selCat, Object.keys(DATA));
  function updateSub() {
    fill(selSub, Object.keys(DATA[selCat.value] || {}));
    loadHigh();
    updateModeOptions(); // optional helper to disable unavailable modes
  }
  selCat?.addEventListener('change', updateSub);
  selSub?.addEventListener('change', loadHigh);
  selMode?.addEventListener('change', loadHigh);
  updateSub();

  // ===== Optional: disable modes that don't exist for current Cat/Sub =====
  function updateModeOptions() {
    if (!selMode) return;
    const list = ((DATA[selCat.value] || {})[selSub.value] || []);
    const hasLetter = list.some(x => x.mode === 'letter');
    const hasWord   = list.some(x => x.mode === 'word');

    [...selMode.options].forEach(opt => {
      if (opt.value === 'letter') opt.disabled = !hasLetter;
      if (opt.value === 'word')   opt.disabled = !hasWord;
    });

    // If currently selected mode is disabled, switch to a valid one if any
    const curr = selMode.value;
    if ((curr === 'letter' && !hasLetter) || (curr === 'word' && !hasWord)) {
      selMode.value = hasLetter ? 'letter' : (hasWord ? 'word' : curr);
    }
  }

  // ===== Build tokens for display =====
  function buildTokensForDisplay(item) {
    if (!item) return [];
    if (item.mode === 'letter') {
      return (item.target || '').split('');
    }
    return (item.targetWords || []).slice();
  }

  
// Renders ONLY the caught tokens into #catchTarget.
// Nothing about "next" or "pending" is shown.
function renderProgress() {
  const cont = document.getElementById('catchTarget');
  if (!cont) return;

  // Nothing caught yet
  if (!targetTokens || nextIndex <= 0) {
    cont.textContent = '';
    return;
  }

  // Build array of caught tokens (indexes 0..nextIndex-1)
  const caught = targetTokens.slice(0, nextIndex);

  // Escape HTML-sensitive chars and join with a space for readability
  const html = caught.map(tok => {
    const safe = String(tok)
      .replace(/&/g,'&amp;')
      .replace(/</g,'&lt;')
      .replace(/>/g,'&gt;');
    return `<span class="target-token caught">${safe}</span>`;
  }).join(' ');

  cont.innerHTML = html;
}

  // ===== Choose an item and configure speeds/pool =====
  function pickItem() {
    const list = ((DATA[selCat.value] || {})[selSub.value] || []);
    if (!list.length) return null;

    const mode = selMode?.value || 'letter';
    const item = list.find(x => x.mode === mode) || list[0];

    // Prepare spawn pool and target tokens
    let pool = [];
    if (item.mode === 'letter') {
      const alphabet   = item.alphabet   || 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
      const distractor = item.distractors|| '';
      pool = (alphabet + distractor).split('');
      targetTokens = (item.target || '').split('');
    } else {
      pool         = (item.wordBank && item.wordBank.length) ? item.wordBank.slice()
                   : (item.targetWords || []).slice();
      targetTokens = (item.targetWords || []).slice();
    }

    fallSpeed     = BASE_FALL_SPEED * (item.speed || 1);
    spawnInterval = item.spawnRate || 1200;

    return { mode: item.mode, pool, item };
  }

  // ===== Start game =====
  function start() {
    const chosen = pickItem();

    // Reset state
    balloons     = [];
    score        = 0;
    correct      = 0;
    combo        = 0;
    nextIndex    = 0;
    cOut.textContent = '0';
    sOut.textContent = '0';
    spawnTimer   = 0;
    lastTs       = performance.now();

    if (!chosen || !targetTokens.length) {
      stage.innerHTML = '<p class="center small">No items for this selection.</p>';
      return;
    }

    // Cache pool once (saves work during tick)
    spawnPool = chosen.pool || [];

    // Prepare player position at stage center
    const rect = stage.getBoundingClientRect();
    playerX = (rect.width - PLAYER_W) / 2;
    player.style.left = `${playerX}px`;
    player.style.width = `${PLAYER_W}px`;
    player.style.height = `${PLAYER_H}px`;

    // Clear leftover balloons
    $$('.catch-balloon', stage).forEach(el => el.remove());

    // Update token progress UI
    renderProgress();

    // Start timer and loop
    timer.reset();
    timer.start();
    running = true;
    SFX.click();

    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(tick);
  }

  // ===== Spawn a balloon =====
  function spawnBalloon(token) {
    const el = document.createElement('div');
    el.className = 'catch-balloon';
    el.innerHTML = `<div class="token" style="font-size:${TOKEN_FONT_PX}px">${token}</div>`;

    const rect = stage.getBoundingClientRect();
    const x = Math.random() * (rect.width - BALLOON_W);
    el.style.left = `${x}px`;
    el.style.top  = `${-BALLOON_H}px`;
    el.style.width  = `${BALLOON_W}px`;
    el.style.height = `${BALLOON_H}px`;

    stage.appendChild(el);

    balloons.push({
      el,
      token,
      x,
      y: -BALLOON_H,
      vy: fallSpeed // px/s baseline; dt applied per frame
    });
  }

  // ===== Collision (AABB) =====
  function collides(b) {
    const px = playerX;
    const py = stage.clientHeight - PLAYER_H; // bottom position
    const bx = b.x;
    const by = b.y;
    const bw = BALLOON_W;
    const bh = BALLOON_H;

    return (
      px < bx + bw &&
      px + PLAYER_W > bx &&
      py < by + bh &&
      py + PLAYER_H > by
    );
  }

  // ===== Scoring =====
  function award(correctCatch) {
    if (correctCatch) {
      combo += 1;
      const pts = 50 + Math.min(50, 10 * (combo - 1)); // base + combo
      score += pts;
      correct += 1;
      cOut.textContent = String(correct);
      SFX.correct();
    } else {
      combo = 0;
      score = Math.max(0, score - 10);
      SFX.wrong();
    }
    sOut.textContent = String(score);
  }

  // ===== Main loop =====
  function tick(ts) {
    if (!running) return;

    const dt = Math.min(40, ts - lastTs); // clamp delta
    lastTs = ts;

    // Spawn balloons
    spawnTimer += dt;
    if (spawnTimer >= spawnInterval) {
      spawnTimer = 0;

      const need = targetTokens[nextIndex];
      const preferNeed = Math.random() < 0.6; // slightly favor the needed token

      const token = (preferNeed && need)
        ? need
        : (spawnPool.length ? spawnPool[Math.floor(Math.random() * spawnPool.length)] : (need || '?'));

      spawnBalloon(token);
    }

    // Move balloons
    balloons.forEach(b => {
      b.y += (b.vy * dt / 1000);
      b.el.style.top  = `${b.y}px`;
      b.el.style.left = `${b.x}px`;
    });

    // Collisions & cleanup
    const h = stage.clientHeight;
    balloons = balloons.filter(b => {
      if (collides(b)) {
        const nextNeeded = targetTokens[nextIndex];
        const isCorrect  = (String(b.token).toUpperCase() === String(nextNeeded).toUpperCase());
        award(isCorrect);
        b.el.remove();

        if (isCorrect) {
          nextIndex++;
          renderProgress();
          if (nextIndex >= targetTokens.length) {
            finish();
            return false;
          }
        }
        return false;
      }

      if (b.y > h + 10) { b.el.remove(); return false; }
      return true;
    });

    rafId = requestAnimationFrame(tick);
  }

  // ===== Finish =====
  
function finish() {
  running = false;
  cancelAnimationFrame(rafId);
  timer.stop();

  const totalMs = timer.elapsedMs();

  // (Optional) keep highscores/leaderboard saving;
  // remove these lines too if you don't want any saving at finish.
  const prev = +(localStorage.getItem(hsKey()) || 0);
  const best = Math.max(prev, score);
  localStorage.setItem(hsKey(), String(best));
  hOut.textContent = String(best);

  localStorage.setItem(lbKey(), JSON.stringify({
    score,
    right: correct,
    ms: totalMs
  }));

  // ❌ No overlay, no “Done!” message.
  // If you want to auto-restart or show a subtle toast, we can add that later.
  SFX.success();
}


  // ===== Input: keyboard =====
  function onKey(e) {
    if (!running) return;
    const rect = stage.getBoundingClientRect();
    if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') {
      playerX = Math.max(0, playerX - KEY_MOVE_PX);
      player.style.left = `${playerX}px`;
      e.preventDefault();
    } else if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') {
      playerX = Math.min(rect.width - PLAYER_W, playerX + KEY_MOVE_PX);
      player.style.left = `${playerX}px`;
      e.preventDefault();
    }
  }
  document.addEventListener('keydown', onKey);

  // ===== Input: mobile buttons (null-safe) =====
  const btnLeft  = document.getElementById('catchLeft');
  const btnRight = document.getElementById('catchRight');

  if (btnLeft) {
    btnLeft.addEventListener('click', () => {
      const rect = stage.getBoundingClientRect();
      playerX = Math.max(0, playerX - TAP_MOVE_PX);
      player.style.left = `${playerX}px`;
    });
  }
  if (btnRight) {
    btnRight.addEventListener('click', () => {
      const rect = stage.getBoundingClientRect();
      playerX = Math.min(rect.width - PLAYER_W, playerX + TAP_MOVE_PX);
      player.style.left = `${playerX}px`;
    });
  }

  // ===== Preview =====
  const previewBtn = $('#catchPreview');
  if (previewBtn) {
    previewBtn.addEventListener('click', () => {
      const list = ((DATA[selCat.value] || {})[selSub.value] || []);
      if (!list.length) {
        showPreview('Catch Preview', '<p>No items.</p>');
        return;
      }
      const mode = selMode?.value || 'letter';
      const html = list
        .filter(it => it.mode === mode)
        .map((it, i) => {
          const seq = (mode === 'letter') ? it.target : (it.targetWords || []).join(' ');
          return `<p>${i + 1}. ${seq}</p>`;
        }).join('');
      showPreview(`Catch Preview — ${selCat.value} / ${selSub.value} (${mode})`, html || '<p>No matching items.</p>');
    });
  }

  // ===== Start =====
  const startBtn = $('#catchStart');
  startBtn?.addEventListener('click', start);
})();
