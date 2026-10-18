(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const shell = $('gameShell');
  const canvas = $('gameCanvas');
  const ctx = canvas.getContext('2d');
  const startOverlay = $('startOverlay');
  const pauseOverlay = $('pauseOverlay');
  const resultOverlay = $('resultOverlay');
  const countdownEl = $('countdown');
  const audioStatusEl = $('audioStatus');
  const audioStatusHintEl = $('audioStatusHint');
  const params = new URLSearchParams(location.search);
  const requestedId = params.get('chart') || 'first-light';
  const chart = window.ANGELOX_CHART_BY_ID[requestedId] || window.ANGELOX_CHARTS[0];
  const STORAGE_KEY = 'angelox.progress.v1';

  $('trackTitle').textContent = chart.title;
  $('trackMeta').textContent = `BPM ${chart.bpm} / STAGE ${String(chart.level).padStart(2, '0')} / ${chart.difficulty}`;
  $('startDescription').textContent = `${chart.description}　${chart.bpm} BPM · ${chart.duration} 秒`;
  document.title = `${chart.title} — Angelox`;
  if (chart.audio) setAudioStatus(`原曲路径：${chart.audio}（缺失时不会播放）`, 'info');
  else setAudioStatus('本关没有背景音乐，仅保留判定音效。', 'silent');

  const beatSec = 60 / chart.bpm;
  const stepSec = beatSec / 2;
  const APPROACH = 1.85;
  const PERFECT_W = 0.055;
  const GREAT_W = 0.110;
  const GOOD_W = 0.170;
  const LANE = [
    { main: '#39e6ff', deep: '#0d6f8a', glow: 'rgba(57,230,255,0.6)' },
    { main: '#ff4fd8', deep: '#8a1272', glow: 'rgba(255,79,216,0.6)' }
  ];

  let W = 0, H = 0, dpr = 1;
  let laneW = 0, gapW = 0, fieldW = 0, fieldX = 0, hitY = 0, laneX = [0, 0];
  let actx = null, master = null;
  let trackBuffer = null, trackSource = null, trackLoadPromise = null;
  let startTime = 0;
  let state = 'menu'; // menu | playing | paused | result
  let notes = [];
  let songTime = 0;
  let score = 0, combo = 0, maxCombo = 0, comboScale = 1;
  let judgeCounts = { perfect: 0, great: 0, good: 0, miss: 0 };
  let laneDown = [false, false];
  let holdNote = [null, null];
  let particles = [], pops = [];
  let lastNoteTime = 0;
  const touchMap = new Map();

  function resize() {
    const r = shell.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = r.width; H = r.height;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    gapW = Math.max(8, Math.min(W * 0.03, 16));
    laneW = Math.min(W * 0.42, 180);
    fieldW = laneW * 2 + gapW;
    fieldX = (W - fieldW) / 2;
    hitY = H * 0.80;
    laneX = [fieldX, fieldX + laneW + gapW];
  }

  function initAudio() {
    if (actx) return;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      alert('当前浏览器不支持 Web Audio，建议使用新版 Chrome、Edge 或 Safari。');
      return;
    }
    actx = new AudioContextClass();
    master = actx.createGain();
    master.gain.value = 0.5;
    const comp = actx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 6;
    master.connect(comp);
    comp.connect(actx.destination);
  }

  function setAudioStatus(message, kind) {
    if (audioStatusEl) {
      audioStatusEl.textContent = message;
      audioStatusEl.dataset.kind = kind || 'info';
    }
    if (audioStatusHintEl) audioStatusHintEl.textContent = message;
  }

  // Only play a user-provided original track. Never substitute a generated backing track.
  async function loadChartAudio() {
    if (!chart.audio) {
      setAudioStatus('本关没有背景音乐，仅保留判定音效。', 'silent');
      return false;
    }
    if (trackBuffer) {
      setAudioStatus('原曲音频已加载。', 'ready');
      return true;
    }
    if (!trackLoadPromise) {
      setAudioStatus(`正在加载原曲：${chart.audio}`, 'loading');
      trackLoadPromise = fetch(chart.audio)
        .then((response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.arrayBuffer();
        })
        .then((bytes) => actx.decodeAudioData(bytes))
        .then((buffer) => {
          trackBuffer = buffer;
          setAudioStatus('原曲音频已加载。', 'ready');
          return true;
        })
        .catch((error) => {
          console.warn(`未能加载原曲 ${chart.audio}。请确认文件存在并通过本地服务器运行。`, error);
          setAudioStatus(`未找到或无法读取 ${chart.audio}；已静音运行，请放入原曲文件。`, 'missing');
          return false;
        });
    }
    return await trackLoadPromise;
  }

  function hitSound(grade) {
    if (!actx || actx.state !== 'running') return;
    const t = actx.currentTime, o = actx.createOscillator(), g = actx.createGain();
    o.type = 'triangle';
    const f = grade === 'perfect' ? 1050 : grade === 'great' ? 880 : 700;
    o.frequency.setValueAtTime(f, t); o.frequency.exponentialRampToValueAtTime(f * 0.7, t + 0.08);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.09, t + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.10);
    o.connect(g); g.connect(master); o.start(t); o.stop(t + 0.12);
  }

  function makeNotes() {
    return chart.notes.map((entry) => ({
      lane: entry[1],
      time: entry[0] * beatSec + (Number(chart.offset) || 0),
      dur: entry[2] * beatSec,
      hit: false,
      holding: false,
      done: false
    })).sort((a, b) => a.time - b.time);
  }

  async function startGame() {
    initAudio();
    if (!actx) return;
    try { if (actx.state !== 'running') await actx.resume(); }
    catch (_) { /* 浏览器可能阻止音频启动；后续仍尝试绘制与判定 */ }
    const useOriginalAudio = await loadChartAudio();
    if (trackSource) {
      try { trackSource.stop(); } catch (_) {}
      trackSource.disconnect();
      trackSource = null;
    }
    notes = makeNotes();
    score = 0; combo = 0; maxCombo = 0; comboScale = 1;
    judgeCounts = { perfect: 0, great: 0, good: 0, miss: 0 };
    laneDown = [false, false]; holdNote = [null, null]; particles = []; pops = []; touchMap.clear();
    lastNoteTime = notes.reduce((latest, n) => Math.max(latest, n.time + n.dur), 0);
    startTime = actx.currentTime + 1.25;
    if (useOriginalAudio && trackBuffer) {
      trackSource = actx.createBufferSource();
      trackSource.buffer = trackBuffer;
      trackSource.connect(master);
      trackSource.start(startTime);
    }
    songTime = -1.25;
    state = 'playing';
    startOverlay.classList.add('hidden');
    pauseOverlay.classList.add('hidden');
    resultOverlay.classList.add('hidden');
    $('pauseButton').textContent = 'Ⅱ';
    countdownEl.classList.add('hidden');
    if (!chart.audio) setAudioStatus('本关没有背景音乐，仅保留判定音效。', 'silent');
    else if (!useOriginalAudio) setAudioStatus(`未找到或无法读取 ${chart.audio}；已静音运行，请放入原曲文件。`, 'missing');
  }

  function readProgress() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || { cleared: {}, best: {} }; }
    catch (_) { return { cleared: {}, best: {} }; }
  }
  function writeProgress(acc, grade) {
    const progress = readProgress();
    if (!progress.cleared) progress.cleared = {};
    if (!progress.best) progress.best = {};
    const passed = acc >= 0.60;
    if (passed) progress.cleared[chart.id] = true;
    const previous = progress.best[chart.id];
    if (!previous || score > Number(previous.score || 0)) {
      progress.best[chart.id] = { score, grade, accuracy: Number((acc * 100).toFixed(2)) };
    }
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(progress)); } catch (_) { /* 禁用本地存储时仍允许正常结算 */ }
    return passed;
  }

  function calculateGrade(acc) {
    if (acc >= 0.97) return 'SS';
    if (acc >= 0.92) return 'S';
    if (acc >= 0.85) return 'A';
    if (acc >= 0.75) return 'B';
    if (acc >= 0.60) return 'C';
    return 'D';
  }

  function endGame() {
    if (state !== 'playing') return;
    state = 'result';
    const total = judgeCounts.perfect + judgeCounts.great + judgeCounts.good + judgeCounts.miss;
    const acc = total ? (judgeCounts.perfect + judgeCounts.great * 0.65 + judgeCounts.good * 0.3) / total : 0;
    const grade = calculateGrade(acc);
    const passed = writeProgress(acc, grade);
    $('resultGrade').textContent = grade;
    $('resultScore').textContent = score.toLocaleString();
    $('resultDetails').innerHTML = [
      ['PERFECT', judgeCounts.perfect], ['GREAT', judgeCounts.great], ['GOOD', judgeCounts.good],
      ['MISS', judgeCounts.miss], ['MAX COMBO', maxCombo], ['ACCURACY', `${(acc * 100).toFixed(2)}%`]
    ].map(([label, value]) => `<div class="result-stat"><span>${label}</span><b>${value}</b></div>`).join('');

    const allCharts = window.ANGELOX_CHARTS || [];
    const index = allCharts.findIndex((item) => item.id === chart.id);
    const nextChart = index >= 0 ? allCharts[index + 1] : null;
    const nextButton = $('nextButton');
    if (passed && nextChart) {
      nextButton.classList.remove('hidden');
      nextButton.textContent = `下一关：${nextChart.title} →`;
      nextButton.onclick = () => { location.href = `game.html?chart=${encodeURIComponent(nextChart.id)}`; };
    } else {
      nextButton.classList.add('hidden');
      nextButton.onclick = null;
    }
    $('resultHint').textContent = passed
      ? (nextChart ? `通关成功！已记录进度，下一关「${nextChart.title}」已解锁。` : '通关成功！你已完成目前所有关卡。')
      : '还差一点点。达到 C 级（60% 加权准确率）即可通关，试着跟随底鼓稳定按拍。';
    resultOverlay.classList.remove('hidden');
    pauseOverlay.classList.add('hidden');
    $('pauseButton').textContent = '↻';
  }

  async function pauseGame() {
    if (state !== 'playing') return;
    state = 'paused';
    try { if (actx && actx.state === 'running') await actx.suspend(); } catch (_) {}
    pauseOverlay.classList.remove('hidden');
    $('pauseButton').textContent = '▶';
  }

  async function resumeGame() {
    if (state !== 'paused') return;
    try { if (actx && actx.state !== 'running') await actx.resume(); } catch (_) {}
    state = 'playing';
    pauseOverlay.classList.add('hidden');
    $('pauseButton').textContent = 'Ⅱ';
  }

  function keyToLane(event) {
    switch (event.key.toLowerCase()) {
      case 'd': case 'f': case 'arrowleft': return 0;
      case 'j': case 'k': case 'arrowright': return 1;
      default: return -1;
    }
  }

  function pressLane(lane) {
    if (laneDown[lane] || state !== 'playing') return;
    laneDown[lane] = true;
    let best = null, bestDiff = Infinity;
    for (const note of notes) {
      if (note.lane !== lane || note.done || note.hit) continue;
      const diff = songTime - note.time;
      if (diff < -GOOD_W || diff > GOOD_W) continue;
      if (Math.abs(diff) < bestDiff) { bestDiff = Math.abs(diff); best = note; }
    }
    if (!best) return;
    const absDiff = Math.abs(songTime - best.time);
    let grade;
    if (absDiff <= PERFECT_W) grade = 'perfect';
    else if (absDiff <= GREAT_W) grade = 'great';
    else grade = 'good';
    const base = grade === 'perfect' ? 300 : grade === 'great' ? 200 : 100;
    best.hit = true;
    score += base;
    combo++;
    maxCombo = Math.max(maxCombo, combo);
    comboScale = 1.35;
    judgeCounts[grade]++;
    addPop(lane, grade.toUpperCase(), gradeColor(grade));
    spawnParticles(lane, grade === 'perfect' ? 16 : 10, gradeColor(grade));
    hitSound(grade);
    if (best.dur > 0) { best.holding = true; holdNote[lane] = best; }
    else best.done = true;
  }

  function releaseLane(lane) {
    laneDown[lane] = false;
    const note = holdNote[lane];
    if (!note) return;
    holdNote[lane] = null;
    if (!note.holding) return;
    note.holding = false;
    note.done = true;
    if (songTime >= note.time + note.dur - GOOD_W) {
      score += 160;
      addPop(lane, 'HOLD', '#ffe066');
      spawnParticles(lane, 18, '#ffe066');
    } else {
      addPop(lane, 'BREAK', '#ff6b6b');
    }
  }

  function registerMiss() {
    combo = 0;
    judgeCounts.miss++;
    addPop(-1, 'MISS', '#7c8199');
  }
  function gradeColor(grade) {
    if (grade === 'perfect') return '#ffe066';
    if (grade === 'great') return '#5ef2b4';
    if (grade === 'good') return '#6bb8ff';
    return '#7c8199';
  }
  function addPop(lane, text, color) { pops.push({ lane, text, color, t: 0, max: 0.62 }); }
  function spawnParticles(lane, count, color) {
    const cx = lane >= 0 ? laneX[lane] + laneW / 2 : W / 2;
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2, speed = 70 + Math.random() * 240;
      particles.push({ x: cx + (Math.random() - 0.5) * laneW * 0.7, y: hitY + (Math.random() - 0.5) * 8,
        vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - 130, life: 0,
        max: 0.32 + Math.random() * 0.38, color, size: 1.6 + Math.random() * 3.2 });
    }
  }

  function updateFX(dt) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i]; p.life += dt;
      if (p.life >= p.max) { particles.splice(i, 1); continue; }
      p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 950 * dt; p.vx *= 0.975;
    }
    for (let i = pops.length - 1; i >= 0; i--) {
      pops[i].t += dt;
      if (pops[i].t >= pops[i].max) pops.splice(i, 1);
    }
    if (comboScale > 1) comboScale += (1 - comboScale) * Math.min(1, dt * 12);
  }

  function update(dt) {
    for (const note of notes) {
      if (note.done || note.holding) continue;
      if (!note.hit && songTime > note.time + GOOD_W) { note.done = true; registerMiss(); }
    }
    for (const note of notes) {
      if (!note.holding) continue;
      if (songTime >= note.time + note.dur) {
        note.holding = false; note.done = true; holdNote[note.lane] = null;
        score += 160; addPop(note.lane, 'HOLD', '#ffe066'); spawnParticles(note.lane, 18, '#ffe066');
      }
    }
    for (let i = notes.length - 1; i >= 0; i--) {
      const note = notes[i];
      if (note.done && songTime > note.time + note.dur + 0.35) notes.splice(i, 1);
    }
    updateFX(dt);
    if (songTime > Math.max(chart.duration, lastNoteTime + 1) + 0.9) endGame();
  }

  function roundRect(x, y, w, h, r) {
    const rad = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2));
    ctx.beginPath(); ctx.moveTo(x + rad, y); ctx.lineTo(x + w - rad, y); ctx.arcTo(x + w, y, x + w, y + rad, rad);
    ctx.lineTo(x + w, y + h - rad); ctx.arcTo(x + w, y + h, x + w - rad, y + h, rad);
    ctx.lineTo(x + rad, y + h); ctx.arcTo(x, y + h, x, y + h - rad, rad);
    ctx.lineTo(x, y + rad); ctx.arcTo(x, y, x + rad, y, rad); ctx.closePath();
  }

  function drawBg() {
    ctx.fillStyle = '#07070d'; ctx.fillRect(0, 0, W, H);
    const t = (state === 'playing' || state === 'paused' || state === 'result') ? songTime : 0;
    const pulse = 0.5 + 0.5 * Math.sin((t / beatSec) * Math.PI * 2);
    let g = ctx.createRadialGradient(W * 0.12, H * 0.12, 0, W * 0.12, H * 0.12, W);
    g.addColorStop(0, `rgba(57,230,255,${0.055 + pulse * 0.025})`); g.addColorStop(1, 'rgba(57,230,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    g = ctx.createRadialGradient(W * 0.88, H * 0.88, 0, W * 0.88, H * 0.88, W);
    g.addColorStop(0, `rgba(255,79,216,${0.055 + pulse * 0.025})`); g.addColorStop(1, 'rgba(255,79,216,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }

  function drawField() {
    for (let i = 0; i < 2; i++) {
      const x = laneX[i];
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.60, 'rgba(255,255,255,0.018)'); g.addColorStop(1, 'rgba(255,255,255,0.055)');
      ctx.fillStyle = g; ctx.fillRect(x, 0, laneW, H);
      ctx.strokeStyle = 'rgba(255,255,255,0.055)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, H); ctx.moveTo(x + laneW - 0.5, 0); ctx.lineTo(x + laneW - 0.5, H); ctx.stroke();
      if (laneDown[i]) {
        const gg = ctx.createLinearGradient(0, hitY, 0, H); gg.addColorStop(0, 'rgba(255,255,255,0.10)'); gg.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = gg; ctx.fillRect(x, hitY, laneW, H - hitY);
      }
    }
  }

  function drawJudgeLine() {
    for (let i = 0; i < 2; i++) {
      const x = laneX[i], c = LANE[i], down = laneDown[i];
      ctx.save(); ctx.shadowColor = c.glow; ctx.shadowBlur = down ? 28 : 12;
      ctx.strokeStyle = down ? c.main : 'rgba(255,255,255,0.30)'; ctx.lineWidth = down ? 4 : 2; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(x + 2, hitY); ctx.lineTo(x + laneW - 2, hitY); ctx.stroke(); ctx.restore();
      ctx.fillStyle = down ? c.main : 'rgba(255,255,255,0.22)'; ctx.beginPath(); ctx.arc(x + 2, hitY, 2.5, 0, Math.PI * 2); ctx.arc(x + laneW - 2, hitY, 2.5, 0, Math.PI * 2); ctx.fill();
    }
  }

  function drawNotes() {
    const padX = laneW * 0.13, nw = laneW - padX * 2, nh = Math.min(26, laneW * 0.24);
    for (const note of notes) {
      if (note.done) continue;
      const color = LANE[note.lane], x = laneX[note.lane];
      const headRaw = ((songTime - (note.time - APPROACH)) / APPROACH) * hitY;
      // 普通音符可以按原始下落位置剔除；长条按住后，头部固定在判定线，
      // 不能再用持续下落的 headRaw 做屏幕外判断，否则长条会在尾部到达前提前消失。
      if (!note.holding && (headRaw < -nh * 3 || headRaw > H + nh * 2)) continue;
      const headY = note.holding ? hitY : headRaw;
      const tailRaw = note.dur > 0 ? ((songTime - (note.time + note.dur - APPROACH)) / APPROACH) * hitY : headRaw;
      const tailY = Math.min(tailRaw, hitY);
      if (note.dur > 0) {
        const top = Math.min(headY, tailY), bottom = Math.max(headY, tailY), height = Math.max(bottom - top, 6);
        ctx.save(); const g = ctx.createLinearGradient(0, top, 0, bottom); g.addColorStop(0, color.deep); g.addColorStop(1, color.main);
        ctx.globalAlpha = 0.75; ctx.fillStyle = g; roundRect(x + padX, top, nw, height, Math.min(9, nw / 3)); ctx.fill();
        ctx.globalAlpha = 0.5; ctx.strokeStyle = color.main; ctx.lineWidth = 1.5; ctx.stroke(); ctx.restore();
      }
      const hy = headY - nh / 2;
      ctx.save(); ctx.shadowColor = color.glow; ctx.shadowBlur = 18;
      const hg = ctx.createLinearGradient(0, hy, 0, hy + nh); hg.addColorStop(0, '#fff'); hg.addColorStop(0.35, color.main); hg.addColorStop(1, color.deep);
      ctx.fillStyle = hg; roundRect(x + padX, hy, nw, nh, nh / 2); ctx.fill(); ctx.restore();
      ctx.save(); ctx.globalAlpha = 0.55; ctx.fillStyle = 'rgba(255,255,255,0.9)'; roundRect(x + padX + nw * 0.16, hy + nh * 0.20, nw * 0.68, nh * 0.18, nh * 0.09); ctx.fill(); ctx.restore();
    }
  }

  function drawParticles() {
    ctx.save();
    for (const p of particles) {
      const k = 1 - p.life / p.max; ctx.globalAlpha = k * k; ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.size * k + 0.5, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  function drawPops() {
    ctx.save(); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const pop of pops) {
      const k = pop.t / pop.max, alpha = k < 0.15 ? k / 0.15 : 1 - (k - 0.15) / 0.85;
      const x = pop.lane >= 0 ? laneX[pop.lane] + laneW / 2 : W / 2;
      const y = hitY - 58 - pop.t * 55, size = pop.lane >= 0 ? 17 : 26;
      ctx.globalAlpha = Math.max(0, alpha); ctx.font = `800 ${size}px -apple-system, "PingFang SC", system-ui, sans-serif`;
      ctx.fillStyle = pop.color; ctx.shadowColor = pop.color; ctx.shadowBlur = 14; ctx.fillText(pop.text, x, y);
    }
    ctx.restore();
  }

  function drawHUD() {
    if (!['playing', 'paused', 'result'].includes(state)) return;
    ctx.save(); ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.font = '800 11px Orbitron, system-ui, sans-serif'; ctx.fillStyle = 'rgba(255,255,255,0.38)'; ctx.fillText('SCORE', W / 2, 64);
    ctx.font = '800 24px Orbitron, system-ui, sans-serif'; ctx.fillStyle = 'rgba(255,255,255,0.93)'; ctx.fillText(String(score), W / 2, 80); ctx.restore();
    if (combo >= 2) {
      ctx.save(); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const cy = hitY * 0.42, fs = Math.round(Math.min(W * 0.11, 46) * comboScale);
      ctx.font = `900 ${fs}px Orbitron, system-ui, sans-serif`; ctx.fillStyle = 'rgba(255,255,255,0.95)'; ctx.shadowColor = 'rgba(160,140,255,0.75)'; ctx.shadowBlur = 22; ctx.fillText(String(combo), W / 2, cy);
      ctx.shadowBlur = 0; ctx.font = '700 10px Orbitron, system-ui, sans-serif'; ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.fillText('C O M B O', W / 2, cy + fs * 0.72); ctx.restore();
    }
    if (state === 'playing' && songTime < 0) {
      ctx.save(); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = '800 20px Orbitron, system-ui, sans-serif';
      ctx.fillStyle = `rgba(255,255,255,${0.35 + 0.35 * Math.sin(songTime * 14)})`; ctx.fillText('READY', W / 2, hitY * 0.62); ctx.restore();
    }
  }

  function render() {
    ctx.clearRect(0, 0, W, H); drawBg(); drawField(); drawJudgeLine();
    if (state !== 'menu') drawNotes();
    drawParticles(); drawPops(); drawHUD();
  }

  let lastFrame = performance.now();
  function loop() {
    requestAnimationFrame(loop);
    const now = performance.now(); let dt = (now - lastFrame) / 1000; lastFrame = now;
    if (dt > 0.1) dt = 0.1;
    if (state === 'playing' && actx) { songTime = actx.currentTime - startTime; update(dt); }
    else if (state === 'result') updateFX(dt);
    render();
  }

  window.addEventListener('keydown', (event) => {
    const lane = keyToLane(event);
    if (lane >= 0) {
      event.preventDefault();
      if (state === 'playing' && !event.repeat) pressLane(lane);
      return;
    }
    if (event.key === 'Escape') {
      if (state === 'playing') pauseGame();
      else if (state === 'paused') resumeGame();
    }
  }, { passive: false });
  window.addEventListener('keyup', (event) => {
    const lane = keyToLane(event);
    if (lane < 0) return;
    event.preventDefault();
    if (state === 'playing' || state === 'paused') releaseLane(lane);
  }, { passive: false });
  window.addEventListener('blur', () => { for (let i = 0; i < 2; i++) if (laneDown[i]) releaseLane(i); });

  canvas.addEventListener('pointerdown', (event) => {
    if (state !== 'playing') return;
    const rect = canvas.getBoundingClientRect();
    const lane = (event.clientX - rect.left) < rect.width / 2 ? 0 : 1;
    touchMap.set(event.pointerId, lane);
    try { canvas.setPointerCapture(event.pointerId); } catch (_) {}
    pressLane(lane); event.preventDefault();
  }, { passive: false });
  function pointerEnd(event) {
    const lane = touchMap.get(event.pointerId);
    if (lane === undefined) return;
    touchMap.delete(event.pointerId);
    if (state === 'playing' || state === 'paused') releaseLane(lane);
  }
  canvas.addEventListener('pointerup', pointerEnd);
  canvas.addEventListener('pointercancel', pointerEnd);

  $('startButton').addEventListener('click', startGame);
  $('retryButton').addEventListener('click', startGame);
  $('pauseButton').addEventListener('click', () => {
    if (state === 'playing') pauseGame();
    else if (state === 'paused') resumeGame();
    else if (state === 'result') location.href = 'levels.html';
  });
  $('resumeButton').addEventListener('click', resumeGame);
  $('restartFromPause').addEventListener('click', startGame);

  resize(); window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', () => setTimeout(resize, 180));
  requestAnimationFrame(loop);
})();
