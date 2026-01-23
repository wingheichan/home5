
(async function () {
  // ===== Shared utilities from util.js =====
  const { Timer, SFX, showPreview } = window.AppUtil;

  // ===== Data load =====
  const DATA = await (await fetch('data/catch.json')).json();

  // ===== DOM helpers =====
  const $  = s => document.querySelector(s);
  const $$ = (s, r = document) => Array.from((r || document).querySelectorAll(s));

  // ===== UI elements =====
  const selCat = $('#catchCat');
  const selSub = $('#catchSub');
  const selMode = $('#catchMode');
  const stage  = $('#catchStage');
  const player = $('#catchPlayer');

  const tOut = $('#catchTime');
  const cOut = $('#catchCorrect');
  const sOut = $('#catchScore');
  const hOut = $('#catchHigh');

  const timer = new Timer(tOut);

  // ===== State =====
  let running = false;
  let rafId = 0;
  let balloons = [];     // active falling objects
  let score = 0;
  let correct = 0;
  let combo = 0;

  // Player state
  const playerSize = { w: 56, h: 72 };
  let playerX = 0;       // left position (px)
  const speedPx = 6;     // how many pixels we move per tick for keyboard

  // Target sequence state
  let targetTokens = []; // array of strings (letters OR words) to collect
  let nextIndex = 0;     // index in targetTokens we need to catch next

  // Spawn controls
  let spawnTimer = 0;
  let spawnInterval = 1200; // ms
  let fallSpeed = 80;       // px per second base; scaled by item speed
  let lastTs = 0;

  // ===== Helpers: select fill =====
  function fill(sel, items) {
    sel.innerHTML = '';
    items.forEach(v => sel.append(new Option(v, v)));
  }

  // ===== Highscore and leaderboard keys =====
  // Keep highscore numeric separate from leaderboard entry object.
  function hsKey() {
    return `highscore:catch:${selCat.value}:${selSub.value}:${selMode.value}`;
  }
  function lbKey() {
    return `catch:${selCat.value}:${selSub.value}:${selMode.value}`;
  }

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
  }
  selCat.addEventListener('change', updateSub);
  selSub.addEventListener('change', loadHigh);
  selMode.addEventListener('change', loadHigh);
  updateSub();

  // ===== Choose an item (target) and configure speed/spawn from JSON =====
  function pickItem() {
    const list = ((DATA[selCat.value] || {})[selSub.value] || []);
    if (!list.length) return null;

    // Pick the first item matching mode, else fallback
    const mode = selMode.value;
    const item = list.find(x => x.mode === mode) || list[0];

    // Prepare the sequence we must catch, and the pool to spawn from.
    let pool = [];
    if (item.mode === 'letter') {
      const alphabet = item.alphabet || 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
      const distractor = item.distractors || '';
      pool = (alphabet + distractor).split('');
      targetTokens = item.target.split(''); // e.g., "TIGER" → ["T","I","G","E","R"]
    } else {
      pool = (item.wordBank && item.wordBank.length)
        ? item.wordBank.slice()
        : (item.targetWords || []).slice();
      targetTokens = (item.targetWords || []).slice();
    }

    fallSpeed = 80 * (item.speed || 1);
    spawnInterval = item.spawnRate || 1200;

    return { mode: item.mode, pool };
  }

  // ===== Start game =====
  function start() {
    const chosen = pickItem();
    stage.focus?.();

    // Reset state
    balloons = [];
    score = 0;
    correct = 0;
    combo = 0;
    nextIndex = 0;
    cOut.textContent = '0';
    sOut.textContent = '0';
    spawnTimer = 0;
    lastTs = performance.now();

    if (!chosen || !targetTokens.length) {
      stage.innerHTML = '<p class="center small">No items for this selection.</p>';
      return;
    }

    // Position player to stage center
    const rect = stage.getBoundingClientRect();
    playerX = (rect.width - playerSize.w) / 2;
    player.style.left = `${playerX}px`;

    // Clear leftover balloons from stage
    $$('.catch-balloon', stage).forEach(el => el.remove());

    // Start timer and loop
    timer.reset();
    timer.start();
    running = true;
    SFX.click();

    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(tick);
  }

  // ===== Spawn a balloon with a random token from pool =====
  function spawnBalloon(token) {
    const el = document.createElement('div');
    el.className = 'catch-balloon';
    el.innerHTML = `<div class="token">${token}</div>`;

    const rect = stage.getBoundingClientRect();
    const x = Math.random() * (rect.width - 56);  // 56px balloon width
    el.style.left = `${x}px`;
    el.style.top  = `-72px`; // start above

    stage.appendChild(el);

    balloons.push({
      el,
      token,
      x,
      y: -72,
      vy: fallSpeed // px/s baseline; dt applied per frame
    });
  }

  // ===== Detect AABB collision between balloon and player =====
  function collides(balloon) {
    const px = playerX;
    const py = stage.clientHeight - playerSize.h; // bottom position
    const bx = balloon.x;
    const by = balloon.y;
    const bw = 56, bh = 72;

    const intersect =
      px < bx + bw &&
      px + playerSize.w > bx &&
      py < by + bh &&
      py + playerSize.h > by;

    return intersect;
  }

  // ===== Scoring model =====
  function award(correctCatch) {
    if (correctCatch) {
      combo += 1;
      // 50 base + time/consistency bonus via combo
      const pts = 50 + Math.min(50, 10 * (combo - 1));
      score += pts;
      correct += 1;
      cOut.textContent = String(correct);
      SFX.correct();
    } else {
      combo = 0; // reset combo on mistake
      score = Math.max(0, score - 10);
      SFX.wrong();
    }
    sOut.textContent = String(score);
  }

  // ===== Main loop =====
  function tick(ts) {
    if (!running) return;

    const dt = Math.min(40, ts - lastTs); // clamp delta to avoid big jumps
    lastTs = ts;

    // Spawn balloons
    spawnTimer += dt;
    if (spawnTimer >= spawnInterval) {
      spawnTimer = 0;

      // Decide which token to spawn:
      // - Prefer the NEXT required token with some probability
      // - Otherwise distractors from pool
      const need = targetTokens[nextIndex];
      const preferNeed = Math.random() < 0.5; // 50% chance to drop the needed
      const { pool } = pickItem() || { pool: [] };

      const token = (preferNeed && need)
        ? need
        : (pool.length ? pool[Math.floor(Math.random() * pool.length)] : need || '?');

      spawnBalloon(token);
    }

    // Move balloons (falling)
    balloons.forEach(b => {
      b.y += (b.vy * dt / 1000);
      b.el.style.top = `${b.y}px`;
      b.el.style.left = `${b.x}px`;
    });

    // Check collisions & out-of-bounds
    const h = stage.clientHeight;
    balloons = balloons.filter(b => {
      // If collided with player:
      if (collides(b)) {
        const nextNeeded = targetTokens[nextIndex];
        const isCorrect = (String(b.token).toUpperCase() === String(nextNeeded).toUpperCase());
        award(isCorrect);
        b.el.remove();

        // Progress to next target token if correct
        if (isCorrect) {
          nextIndex++;
          // If we completed the target, end the game
          if (nextIndex >= targetTokens.length) {
            finish();
            return false;
          }
        }
        return false;
      }

      // Remove if fallen below stage
      if (b.y > h + 10) {
        b.el.remove();
        return false;
      }
      return true;
    });

    rafId = requestAnimationFrame(tick);
  }

  // ===== Finish round =====
  function finish() {
    running = false;
    cancelAnimationFrame(rafId);
    timer.stop();

    const totalMs = timer.elapsedMs();
    // Update Highscore (max)
    const prev = +(localStorage.getItem(hsKey()) || 0);
    const best = Math.max(prev, score);
    localStorage.setItem(hsKey(), String(best));
    hOut.textContent = String(best);

    // Write leaderboard entry object for your leaderboard.js
    localStorage.setItem(lbKey(), JSON.stringify({
      score,
      right: correct,
      ms: totalMs
    }));

    // Simple overlay UI
    const totalTime = Timer.format(totalMs);
    const overlay = document.createElement('div');
    overlay.className = 'next-row';
    overlay.innerHTML = `
      <p>Done! Collected: ${correct}/${targetTokens.length}
         — Time: ${totalTime} — Score: ${score}</p>
      <button id="catchAgain" class="btn">Play again</button>
    `;
    stage.appendChild(overlay);
    $('#catchAgain').addEventListener('click', () => {
      overlay.remove();
      start();
    });

    SFX.success();
  }

  // ===== Input: keyboard & mobile buttons =====
  function onKey(e) {
    if (!running) return;
    const rect = stage.getBoundingClientRect();
    if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') {
      playerX = Math.max(0, playerX - speedPx);
      player.style.left = `${playerX}px`;
      e.preventDefault();
    } else if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') {
      playerX = Math.min(rect.width - playerSize.w, playerX + speedPx);
      player.style.left = `${playerX}px`;
      e.preventDefault();
    }
  }
  document.addEventListener('keydown', onKey);

const btnLeft  = document.getElementById('catchLeft');
const btnRight = document.getElementById('catchRight');

if (btnLeft) {
  btnLeft.addEventListener('click', () => {
    const rect = stage.getBoundingClientRect();
    playerX = Math.max(0, playerX - 24);
    player.style.left = `${playerX}px`;
  });
}

if (btnRight) {
  btnRight.addEventListener('click', () => {
    const rect = stage.getBoundingClientRect();
    playerX = Math.min(rect.width - playerSize.w, playerX + 24);
    player.style.left = `${playerX}px`;
  });
}

  // Mobile buttons
  $('#catchLeft').addEventListener('click', () => {
    const rect = stage.getBoundingClientRect();
    playerX = Math.max(0, playerX - 24);
    player.style.left = `${playerX}px`;
  });
  $('#catchRight').addEventListener('click', () => {
    const rect = stage.getBoundingClientRect();
    playerX = Math.min(rect.width - playerSize.w, playerX + 24);
    player.style.left = `${playerX}px`;
  });

  // ===== Preview (optional) =====
  $('#catchPreview').addEventListener('click', () => {
    const list = ((DATA[selCat.value] || {})[selSub.value] || []);
    if (!list.length) {
      showPreview('Catch Preview', '<p>No items.</p>');
      return;
    }
    const mode = selMode.value;
    const html = list
      .filter(it => it.mode === mode)
      .map((it, i) => {
        const seq = (mode === 'letter') ? it.target : (it.targetWords || []).join(' ');
        return `<p>${i + 1}. ${seq}</p>`;
      }).join('');
    showPreview(`Catch Preview — ${selCat.value} / ${selSub.value} (${mode})`, html || '<p>No matching items.</p>');
  });

  // ===== Start button =====
  $('#catchStart').addEventListener('click', start);
})();
