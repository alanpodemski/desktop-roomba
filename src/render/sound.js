// sound.js — vacuum sounds only, all from filtered noise in WebAudio (no tonal oscillators, no beeps or
// melodies). Created lazily on the first click / keypress.
//   suction airflow (band-passed white noise) + fan hiss, main-brush rumble (low-passed brown noise),
//   drive gear noise tied to wheel speed, bump thud, pushing scrape, crumbs rattling up the intake,
//   bin-empty roar at the dock (noise turbine spool-up).
//   Cake: wet squelch (resonant band-passed noise bursts sweeping down) on cakeHit / cakeClimb / cakeCrush,
//   soft low-passed thud on cakeLand, sticky tyre "tack" noise loop ∝ load × wheel speed.

export function createSound() {
  let ctx = null, master = null;
  let enabled = true;
  let n = null; // node graph
  let roar = null;
  let crackleBudget = 0;
  const state = { stuck: false, charging: false, emptying: false };

  function noiseBuffer(ac, seconds = 2) {
    const buf = ac.createBuffer(1, ac.sampleRate * seconds, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }
  function brownBuffer(ac, seconds = 3) {
    const buf = ac.createBuffer(1, ac.sampleRate * seconds, ac.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < d.length; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; d[i] = last * 3.5; }
    return buf;
  }
  function loop(buffer, ...chain) {
    const src = ctx.createBufferSource(); src.buffer = buffer; src.loop = true;
    src.loopStart = Math.random(); // decorrelate the loops
    let node = src; for (const c of chain) node = node.connect(c);
    src.start(0, Math.random() * 1.5);
    return src;
  }
  const bq = (type, f, q = 0.7) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; };
  const gain = (v = 0) => { const g = ctx.createGain(); g.gain.value = v; return g; };

  function init() {
    if (ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = gain(enabled ? 0.5 : 0);
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 4;
    master.connect(comp).connect(ctx.destination);
    const noise = noiseBuffer(ctx), brown = brownBuffer(ctx);

    // suction: broad airflow + a softer high hiss from the fan outlet
    const airBP = bq('bandpass', 1100, 0.5), airG = gain();
    loop(noise, airBP, airG, master);
    const hissHP = bq('highpass', 4200, 0.5), hissG = gain();
    loop(noise, hissHP, hissG, master);
    // main brush / roller: low rumble
    const rumbleLP = bq('lowpass', 220, 0.6), rumbleG = gain();
    loop(brown, rumbleLP, rumbleG, master);
    // drive gearboxes: mid-band noise, louder with wheel speed
    const gearBP = bq('bandpass', 520, 1.6), gearG = gain();
    loop(brown, gearBP, gearG, master);
    // scrape (pushing with slip)
    const scrapeBP = bq('bandpass', 1400, 1.5), scrapeG = gain();
    loop(noise, scrapeBP, scrapeG, master);

    // sticky tyres: tacky peel noise, gated by a fast random flutter so it crackles rather than hisses
    const tackBP = bq('bandpass', 2300, 2.2), tackG = gain(), flutter = gain(0);
    loop(noise, tackBP, flutter, tackG, master);
    const tackLP = bq('lowpass', 500, 0.7), tackLowG = gain();
    loop(brown, tackLP, tackLowG, master);

    n = { noise, brown, airG, airBP, hissG, rumbleG, rumbleLP, gearG, gearBP, scrapeG, scrapeBP, tackBP, tackG, flutter, tackLowG };
  }

  function now() { return ctx.currentTime; }

  function update(r, dt) {
    if (!n) return;
    const t = now();
    const docked = r.mode === 'docked' || r.mode === 'emptying' || r.mode === 'charging' || r.mode === 'off';
    const suction = docked ? 0 : r.suction;
    const brush = docked ? 0 : r.brushRpm;
    n.airG.gain.setTargetAtTime(0.16 * suction, t, 0.25);
    n.airBP.frequency.setTargetAtTime(700 + 600 * suction, t, 0.4);
    n.hissG.gain.setTargetAtTime(0.035 * suction, t, 0.25);
    n.rumbleG.gain.setTargetAtTime(0.28 * brush, t, 0.2);
    n.rumbleLP.frequency.setTargetAtTime(140 + 120 * brush, t, 0.3);
    const ws = (Math.abs(r.wheelL) + Math.abs(r.wheelR)) / 2 / 440; // m/s
    n.gearG.gain.setTargetAtTime(docked ? 0 : Math.min(0.2, ws * 0.6), t, 0.08);
    n.gearBP.frequency.setTargetAtTime(380 + 500 * ws, t, 0.1);
    const slip = Math.max(r.slipL || 0, r.slipR || 0);
    const scr = slip > 0.5 && (r.strain || 0) > 0.2 ? Math.min(0.3, (slip - 0.5) * 0.5 + 0.08) : 0;
    n.scrapeG.gain.setTargetAtTime(scr, t, 0.06);
    n.scrapeBP.frequency.setTargetAtTime(900 + 1200 * Math.random() * (scr > 0 ? 1 : 0), t, 0.05);
    crackleBudget = Math.min(6, crackleBudget + dt * 30);
    // sticky tyres: louder with chocolate load × wheel speed; random flutter = tacky peeling
    const load = Number.isFinite(r.load) ? Math.max(0, Math.min(1, r.load)) : 0;
    const tack = docked ? 0 : Math.min(1, load * 1.5) * Math.min(1, ws / 0.25);
    n.tackG.gain.setTargetAtTime(0.22 * tack, t, 0.08);
    n.tackLowG.gain.setTargetAtTime(0.18 * tack, t, 0.1);
    n.flutter.gain.setTargetAtTime(Math.random() < 0.5 ? 0.2 : 1, t, 0.012);
    n.tackBP.frequency.setTargetAtTime(1600 + 1800 * Math.random(), t, 0.02);
    if (r.mode !== 'emptying' && roar && !state.instantRoar) roarStop();
  }

  // a crumb rattling up the intake: tiny high-passed noise click
  function crackle(count) {
    if (!n) return;
    const t0 = now();
    const k = Math.min(count, Math.floor(crackleBudget));
    crackleBudget -= k;
    for (let i = 0; i < k; i++) {
      const t = t0 + Math.random() * 0.05;
      const src = ctx.createBufferSource(); src.buffer = n.noise;
      const hp = bq('highpass', 2500 + Math.random() * 3000, 0.8);
      const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.06 + Math.random() * 0.06, t + 0.002); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.02 + Math.random() * 0.02);
      src.connect(hp).connect(g).connect(master); src.start(t, Math.random() * 1.5); src.stop(t + 0.05);
    }
  }
  function thud(force = 1) {
    if (!n) return;
    const t = now();
    const f = Math.min(1, 0.4 + force * 0.6);
    // plastic bumper knock: two short low-passed noise bursts (impact + body)
    for (const [cut, dur, g0] of [[1200, 0.06, 0.55], [260, 0.16, 0.7]]) {
      const src = ctx.createBufferSource(); src.buffer = cut > 500 ? n.noise : n.brown;
      const lp = bq('lowpass', cut, 0.9); lp.frequency.setValueAtTime(cut, t); lp.frequency.exponentialRampToValueAtTime(cut * 0.25, t + dur);
      const g = ctx.createGain(); g.gain.setValueAtTime(g0 * f, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      src.connect(lp).connect(g).connect(master); src.start(t, Math.random()); src.stop(t + dur + 0.02);
    }
  }
  // wet squelch: a few overlapping resonant noise blobs whose band sweeps down fast (the "schlp" of a
  // soft mass being compressed), over a low-passed brown-noise body
  function squelch(size = 1) {
    if (!n) return;
    const t0 = now();
    const blobs = 2 + Math.round(size * 3);
    for (let i = 0; i < blobs; i++) {
      const t = t0 + i * (0.035 + Math.random() * 0.05) * (0.6 + size * 0.6);
      const dur = 0.08 + Math.random() * 0.1 + size * 0.08;
      const src = ctx.createBufferSource(); src.buffer = n.noise;
      const f0 = 1400 + Math.random() * 1600, f1 = 260 + Math.random() * 260;
      const b = bq('bandpass', f0, 6 + Math.random() * 6);
      b.frequency.setValueAtTime(f0, t); b.frequency.exponentialRampToValueAtTime(f1, t + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime((0.5 + 0.5 * size) * (0.6 + Math.random() * 0.5), t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(b).connect(g).connect(master); src.start(t, Math.random() * 1.5); src.stop(t + dur + 0.02);
    }
    const src = ctx.createBufferSource(); src.buffer = n.brown;
    const lp = bq('lowpass', 420, 0.8); lp.frequency.setValueAtTime(600, t0); lp.frequency.exponentialRampToValueAtTime(140, t0 + 0.25 + size * 0.2);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.5 * size + 0.15, t0 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.3 + size * 0.25);
    src.connect(lp).connect(g).connect(master); src.start(t0, Math.random()); src.stop(t0 + 0.6 + size * 0.3);
  }
  // soft thud of a cake slice landing on its side: dull, low-passed brown noise, no click
  function softThud() {
    if (!n) return;
    const t = now();
    const src = ctx.createBufferSource(); src.buffer = n.brown;
    const lp = bq('lowpass', 320, 0.7); lp.frequency.setValueAtTime(320, t); lp.frequency.exponentialRampToValueAtTime(90, t + 0.22);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.75, t + 0.015); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    src.connect(lp).connect(g).connect(master); src.start(t, Math.random()); src.stop(t + 0.32);
    // a little wet slap on top
    setTimeout(() => squelch(0.15), 20);
  }

  // auto-empty station: a second, much bigger turbine spools up and pulls the bin out (noise only)
  function roarStart() {
    if (!n || roar) return; const t = now();
    const mk = (buf, type, f0, f1, q, g1) => {
      const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
      const f = bq(type, f0, q); f.frequency.setValueAtTime(f0, t); f.frequency.exponentialRampToValueAtTime(f1, t + 1.6);
      const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(g1, t + 0.7);
      src.connect(f).connect(g).connect(master); src.start(t, Math.random());
      return { src, f, g };
    };
    roar = { parts: [mk(n.noise, 'bandpass', 250, 1400, 0.8, 1.0), mk(n.brown, 'lowpass', 120, 420, 0.7, 0.9), mk(n.noise, 'highpass', 2500, 5000, 0.5, 0.12)] };
  }
  function roarStop() {
    if (!roar) return; const t = now();
    for (const p of roar.parts) {
      p.g.gain.cancelScheduledValues(t); p.g.gain.setValueAtTime(p.g.gain.value, t); p.g.gain.linearRampToValueAtTime(0, t + 0.6);
      p.f.frequency.cancelScheduledValues(t); p.f.frequency.setValueAtTime(p.f.frequency.value, t); p.f.frequency.exponentialRampToValueAtTime(Math.max(60, p.f.frequency.value * 0.3), t + 0.6);
      p.src.stop(t + 0.65);
    }
    roar = null;
  }

  function handleEvents(events) {
    if (!n) return;
    for (const e of events) {
      switch (e.type) {
        case 'bump': thud(Math.min(1, (e.force || 10) / 25)); break;
        case 'dustPicked': crackle(e.n); break;
        case 'cakeHit': squelch(Math.min(1, 0.25 + (e.force || 4) / 20)); break;
        case 'cakeLand': softThud(); break;
        case 'cakeRockBack': softThud(); break;     // the slice drops back onto its base
        case 'cakeClimb': squelch(0.6); break;
        case 'cakeCrush': squelch(1); setTimeout(() => squelch(0.7), 140); break;
        case 'emptyStart': roarStart(); state.emptying = true; break;
        case 'emptyEnd': roarStop(); state.emptying = false; break;
        case 'binEmptied':
          if (!state.emptying) { state.instantRoar = true; roarStart(); setTimeout(() => { state.instantRoar = false; if (!state.emptying) roarStop(); }, 1300); }
          break;
      }
    }
  }

  function setEnabled(v) {
    enabled = v;
    if (master) master.gain.setTargetAtTime(v ? 0.5 : 0, ctx.currentTime, 0.05);
  }
  function toggle() { setEnabled(!enabled); return enabled; }
  function resume() { init(); if (ctx && ctx.state === 'suspended') ctx.resume(); }

  return { init, resume, update, handleEvents, toggle, setEnabled, get enabled() { return enabled; }, get ready() { return !!n; } };
}
