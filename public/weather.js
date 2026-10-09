/* ======================================================
   Météo du plateau : pluie, neige, braises, lucioles, feuilles, pétales, brume.
   Un seul <canvas> réutilisé : après chaque rendu de la page, attach() le
   remet dans le plateau (le rendu réécrit le HTML, l'animation continue).
   ====================================================== */
(function () {
  const COUNTS = { pluie: 110, neige: 70, braises: 45, lucioles: 22, feuilles: 18, petales: 24, brume: 6 };
  const MULT = { 1: 0.5, 2: 1, 3: 1.8 };
  let canvas = null, ctx = null, kind = null, level = 2, parts = [], raf = 0, last = 0, W = 0, H = 0, dpr = 1;
  const rnd = (a, b) => a + Math.random() * (b - a);
  const reduced = () => !!(document.body && document.body.classList.contains('anim-reduced')); // réglage du jeu (Options → Animations)

  function spawn(k, initial) {
    const p = { x: rnd(0, W), y: initial ? rnd(0, H) : -20, t: rnd(0, 1000) };
    switch (k) {
      case 'pluie': p.vy = rnd(700, 1000); p.vx = -p.vy * 0.18; p.len = rnd(12, 24); p.a = rnd(0.25, 0.5); break;
      case 'neige': p.r = rnd(1.2, 3.4); p.vy = rnd(25, 60) * (p.r / 2.4); p.sway = rnd(10, 30); p.a = rnd(0.55, 0.95); break;
      case 'braises': p.y = initial ? rnd(0, H) : H + 10; p.r = rnd(1, 2.6); p.vy = -rnd(30, 80); p.sway = rnd(8, 26); p.life = rnd(3, 7); p.age = initial ? rnd(0, p.life) : 0; break;
      case 'lucioles': p.y = rnd(H * 0.2, H); p.r = rnd(1.4, 2.6); p.vx = rnd(-14, 14); p.vy = rnd(-10, 10); p.ph = rnd(0, 6.28); break;
      case 'feuilles': case 'petales': p.s = k === 'feuilles' ? rnd(5, 9) : rnd(3.5, 6); p.vy = rnd(35, 70); p.sway = rnd(20, 50); p.rot = rnd(0, 6.28); p.vr = rnd(-2, 2);
        p.c = k === 'feuilles' ? ['#c8642a', '#e09a2c', '#9b4a1d', '#b8862f'][Math.floor(rnd(0, 4))] : ['#ffc0dc', '#ffd6e8', '#f7a1c8'][Math.floor(rnd(0, 3))]; break;
      case 'brume': p.x = initial ? rnd(-0.3 * W, W) : -0.5 * W; p.y = rnd(H * 0.15, H * 0.95); p.r = rnd(0.25, 0.45) * Math.max(W, H); p.vx = rnd(8, 20); p.a = rnd(0.05, 0.11); break;
    }
    return p;
  }
  function reset() {
    const n = Math.max(2, Math.round((COUNTS[kind] || 0) * (MULT[level] || 1) * (reduced() ? 0.4 : 1) * Math.min(1.4, Math.max(0.5, (W * H) / (1200 * 800)))));
    parts = Array.from({ length: n }, () => spawn(kind, true));
  }
  function resize() {
    const host = canvas.parentNode;
    if (!host) return false;
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return false;
    if (w !== W || h !== H) {
      W = w; H = h; dpr = Math.min(1.5, window.devicePixelRatio || 1);
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      reset();
    }
    return true;
  }
  function step(now) {
    raf = 0;
    if (!canvas || !canvas.isConnected || !kind) { last = 0; return; }
    raf = requestAnimationFrame(step);
    if (document.hidden) { last = 0; return; }
    if (!resize()) return;
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016;
    last = now;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.globalCompositeOperation = kind === 'braises' || kind === 'lucioles' ? 'lighter' : 'source-over';
    for (let i = 0; i < parts.length; i++) {
      let p = parts[i];
      p.t += dt;
      switch (kind) {
        case 'pluie':
          p.x += p.vx * dt; p.y += p.vy * dt;
          ctx.strokeStyle = `rgba(190,215,255,${p.a})`; ctx.lineWidth = 1.2;
          ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.vx * p.len / p.vy, p.y - p.len); ctx.stroke();
          if (p.y > H + 30 || p.x < -40) parts[i] = Object.assign(spawn(kind), { x: rnd(0, W + 200) });
          break;
        case 'neige':
          p.y += p.vy * dt; p.x += Math.sin(p.t * 1.3) * p.sway * dt;
          ctx.fillStyle = `rgba(255,255,255,${p.a})`; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.283); ctx.fill();
          if (p.y > H + 10) parts[i] = spawn(kind);
          break;
        case 'braises': {
          p.age += dt; p.y += p.vy * dt; p.x += Math.sin(p.t * 2) * p.sway * dt;
          const life = 1 - p.age / p.life, fl = 0.6 + 0.4 * Math.sin(p.t * 18);
          if (life <= 0 || p.y < -10) { parts[i] = spawn(kind); break; }
          const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 4);
          g.addColorStop(0, `rgba(255,220,120,${0.9 * life * fl})`); g.addColorStop(0.4, `rgba(255,120,30,${0.5 * life * fl})`); g.addColorStop(1, 'rgba(255,60,0,0)');
          ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x, p.y, p.r * 4, 0, 6.283); ctx.fill();
          break;
        }
        case 'lucioles': {
          p.vx += rnd(-20, 20) * dt; p.vy += rnd(-20, 20) * dt;
          p.vx = Math.max(-18, Math.min(18, p.vx)); p.vy = Math.max(-14, Math.min(14, p.vy));
          p.x += p.vx * dt; p.y += p.vy * dt;
          if (p.x < -10) p.x = W + 10; if (p.x > W + 10) p.x = -10; if (p.y < 0) p.vy = Math.abs(p.vy); if (p.y > H) p.vy = -Math.abs(p.vy);
          const a = Math.max(0, Math.sin(p.t * 1.6 + p.ph)) ** 2;
          const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 6);
          g.addColorStop(0, `rgba(240,255,170,${0.95 * a})`); g.addColorStop(0.3, `rgba(190,255,90,${0.45 * a})`); g.addColorStop(1, 'rgba(120,255,60,0)');
          ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x, p.y, p.r * 6, 0, 6.283); ctx.fill();
          break;
        }
        case 'feuilles': case 'petales':
          p.y += p.vy * dt; p.x += Math.sin(p.t * 1.1) * p.sway * dt; p.rot += p.vr * dt;
          ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.scale(1, 0.55 + 0.45 * Math.abs(Math.sin(p.t * 2)));
          ctx.fillStyle = p.c; ctx.globalAlpha = 0.9;
          ctx.beginPath(); ctx.ellipse(0, 0, p.s, p.s * (kind === 'feuilles' ? 0.5 : 0.65), 0, 0, 6.283); ctx.fill();
          if (kind === 'feuilles') { ctx.strokeStyle = 'rgba(80,35,10,.6)'; ctx.lineWidth = 0.8; ctx.beginPath(); ctx.moveTo(-p.s, 0); ctx.lineTo(p.s, 0); ctx.stroke(); }
          ctx.restore();
          if (p.y > H + 15) parts[i] = spawn(kind);
          break;
        case 'brume': {
          p.x += p.vx * dt;
          const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r);
          g.addColorStop(0, `rgba(220,225,240,${p.a})`); g.addColorStop(1, 'rgba(220,225,240,0)');
          ctx.fillStyle = g; ctx.fillRect(p.x - p.r, p.y - p.r, p.r * 2, p.r * 2);
          if (p.x - p.r > W) parts[i] = spawn(kind);
          break;
        }
      }
    }
    ctx.globalCompositeOperation = 'source-over';
  }
  function attach(host, k, n) {
    if (!host) return;
    if (!canvas) { canvas = document.createElement('canvas'); canvas.className = 'board-weather'; canvas.setAttribute('aria-hidden', 'true'); ctx = canvas.getContext('2d'); }
    const lv = Math.max(1, Math.min(3, Number(n) || 2));
    if (canvas.parentNode !== host) host.appendChild(canvas);
    if (k !== kind || lv !== level) { kind = k; level = lv; W = 0; H = 0; }
    if (!raf) raf = requestAnimationFrame(step);
  }
  function stop() {
    kind = null;
    if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    last = 0;
  }
  window.BoardWeather = { attach, stop, kinds: Object.keys(COUNTS) };
})();
