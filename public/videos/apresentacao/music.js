/**
 * music.js — trilha procedural 45s pro video demo do System Clow.
 * Tema: synthwave tech/ambient em Am (A-F-C-G, 120 BPM, 2s por bar).
 *
 * Estrutura:
 *   0-4s   Intro        pad sozinho fade-in
 *   4-12s  Build        entra bass + hi-hat
 *   12-24s Main         + arpeggio 16ths
 *   24-32s Peak         + lead melody + snare nos tempos 2 e 4
 *   32-40s Drop         tudo junto
 *   40-45s Outro        fade out pra pad final com reverb tail
 *
 * Autoplay policy: tenta iniciar imediatamente. Se suspenso,
 * inicia no primeiro click/touch/visibilidade.
 *
 * Loop: ao fim de 45s, re-agenda sem gaps.
 */
(function() {
  if (window.__clowMusicLoaded) return;
  window.__clowMusicLoaded = true;

  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return; // browser sem Web Audio — segue sem musica

  const ctx = new AC({ latencyHint: 'interactive' });
  let master, reverbSend, started = false, nextCycleTimer = null;

  function hzFromMidi(m) { return 440 * Math.pow(2, (m - 69) / 12); }

  // ────────────────────────────── Reverb (delay feedback = simple reverb)
  function buildReverbBus() {
    const input = ctx.createGain();
    const pre = ctx.createBiquadFilter();
    pre.type = 'lowpass'; pre.frequency.value = 2800;
    const d1 = ctx.createDelay(2); d1.delayTime.value = 0.21;
    const d2 = ctx.createDelay(2); d2.delayTime.value = 0.37;
    const fb1 = ctx.createGain(); fb1.gain.value = 0.42;
    const fb2 = ctx.createGain(); fb2.gain.value = 0.32;
    const wet = ctx.createGain(); wet.gain.value = 0.7;

    input.connect(pre);
    pre.connect(d1); pre.connect(d2);
    d1.connect(fb1); fb1.connect(d1);
    d2.connect(fb2); fb2.connect(d2);
    d1.connect(wet); d2.connect(wet);
    wet.connect(master);
    return input;
  }

  // ────────────────────────────── Synth note (osc + biquad + ADSR gain)
  function playNote({ freq, start, duration, wave = 'sine', gain = 0.12, filter = 2000, detune = 0, reverb = 0 }) {
    const osc = ctx.createOscillator();
    osc.type = wave;
    osc.frequency.value = freq;
    osc.detune.value = detune;

    const flt = ctx.createBiquadFilter();
    flt.type = 'lowpass';
    flt.frequency.value = filter;
    flt.Q.value = 0.8;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, start);
    env.gain.linearRampToValueAtTime(gain, start + 0.012);       // attack 12ms
    env.gain.linearRampToValueAtTime(gain * 0.7, start + 0.12);  // decay 100ms
    env.gain.setValueAtTime(gain * 0.7, start + duration - 0.15);
    env.gain.exponentialRampToValueAtTime(0.0008, start + duration); // release

    osc.connect(flt); flt.connect(env);
    env.connect(master);
    if (reverb > 0 && reverbSend) {
      const r = ctx.createGain(); r.gain.value = reverb;
      env.connect(r); r.connect(reverbSend);
    }

    osc.start(start);
    osc.stop(start + duration + 0.05);
  }

  // ────────────────────────────── Noise burst (hi-hat, snare)
  function playNoise({ start, duration, gain = 0.06, filter = 8000, type = 'highpass', q = 1, reverb = 0 }) {
    const bufSize = Math.max(1, Math.floor(ctx.sampleRate * duration));
    const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufSize; i++) data[i] = Math.random() * 2 - 1;

    const src = ctx.createBufferSource();
    src.buffer = buf;

    const flt = ctx.createBiquadFilter();
    flt.type = type; flt.frequency.value = filter; flt.Q.value = q;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, start);
    env.gain.linearRampToValueAtTime(gain, start + 0.004);
    env.gain.exponentialRampToValueAtTime(0.0008, start + duration);

    src.connect(flt); flt.connect(env); env.connect(master);
    if (reverb > 0 && reverbSend) {
      const r = ctx.createGain(); r.gain.value = reverb;
      env.connect(r); r.connect(reverbSend);
    }
    src.start(start);
  }

  // ────────────────────────────── 45s cycle scheduler
  const CHORDS = [
    [57, 60, 64, 67], // Am7
    [53, 57, 60, 64], // Fmaj7
    [48, 52, 55, 59], // Cmaj7
    [55, 59, 62, 65], // G7 (fifth in G)
  ];
  const BAR = 2.0;            // 2 segundos por compasso
  const BARS = 22;            // 44s + 1s de outro final = 45s
  const CYCLE_SEC = BARS * BAR + 1;

  function scheduleCycle(t0) {
    // PAD (todo o cycle) — fade in 2 bars, fade out bars 19-21
    for (let bar = 0; bar < BARS; bar++) {
      const chord = CHORDS[bar % 4];
      const start = t0 + bar * BAR;
      let padGain = 0.055;
      if (bar < 2) padGain *= (bar + 0.5) / 2;           // fade-in
      else if (bar >= 19) padGain *= Math.max(0, (BARS - bar) / 3); // fade-out
      chord.forEach((m, idx) => {
        playNote({
          freq: hzFromMidi(m),
          start, duration: BAR * 1.08,
          wave: 'sine', gain: padGain, filter: 1800,
          detune: (idx - 1.5) * 6, reverb: 0.25,
        });
      });
    }

    // BASS (bars 2-19) — root + octave every bar on beat 1
    for (let bar = 2; bar < 20; bar++) {
      const chord = CHORDS[bar % 4];
      const start = t0 + bar * BAR;
      playNote({
        freq: hzFromMidi(chord[0] - 24), start, duration: BAR * 0.92,
        wave: 'triangle', gain: 0.18, filter: 240,
      });
      // soft fifth on beat 3
      playNote({
        freq: hzFromMidi(chord[0] - 24),
        start: start + BAR / 2, duration: BAR * 0.42,
        wave: 'triangle', gain: 0.1, filter: 300,
      });
    }

    // HI-HAT (bars 3-19) — 8th notes, offbeat louder
    for (let bar = 3; bar < 20; bar++) {
      for (let eighth = 0; eighth < 4; eighth++) {
        const start = t0 + bar * BAR + eighth * 0.5;
        playNoise({
          start, duration: 0.07,
          gain: eighth % 2 === 1 ? 0.04 : 0.022,
          filter: 9000, type: 'highpass', q: 0.7,
        });
      }
    }

    // ARPEGGIO (bars 6-19) — 16th notes, ascending chord tones
    for (let bar = 6; bar < 20; bar++) {
      const chord = CHORDS[bar % 4];
      for (let i = 0; i < 8; i++) {
        const step = [0, 1, 2, 3, 2, 1, 0, 1][i];
        const note = chord[step % chord.length] + 12;
        const start = t0 + bar * BAR + i * 0.25;
        playNote({
          freq: hzFromMidi(note), start, duration: 0.22,
          wave: 'triangle', gain: 0.048, filter: 3400, reverb: 0.2,
        });
      }
    }

    // SNARE (bars 8-17) — backbeat on 2 e 4
    for (let bar = 8; bar < 18; bar++) {
      for (const beat of [1, 3]) {
        const start = t0 + bar * BAR + beat * 0.5;
        playNoise({
          start, duration: 0.09, gain: 0.06,
          filter: 1800, type: 'bandpass', q: 0.9, reverb: 0.15,
        });
      }
    }

    // LEAD MELODY (bars 12-17, peak) — C5 → E5 → G5 → F5 → D5 → C5 → E5 → A5
    const melody = [
      { m: 72, d: 0.5 }, { m: 76, d: 0.5 }, { m: 79, d: 1.0 },
      { m: 77, d: 0.5 }, { m: 74, d: 0.5 }, { m: 72, d: 1.0 },
      { m: 76, d: 1.0 }, { m: 81, d: 2.0 }, { m: 79, d: 2.0 },
      { m: 76, d: 2.0 },
    ];
    let cursor = t0 + 12 * BAR;
    for (const n of melody) {
      playNote({
        freq: hzFromMidi(n.m), start: cursor, duration: n.d * 0.96,
        wave: 'sawtooth', gain: 0.062, filter: 4200, reverb: 0.3,
      });
      cursor += n.d;
    }

    // FINAL CHORD (bars 20-21 = outro) — F major resolução + reverb tail
    const finalChord = [53, 57, 60, 65]; // F major add9
    finalChord.forEach((m, idx) => {
      playNote({
        freq: hzFromMidi(m), start: t0 + 20 * BAR, duration: 5,
        wave: 'sine', gain: 0.045, filter: 1400,
        detune: (idx - 1.5) * 4, reverb: 0.5,
      });
    });
    // Reverse cymbal-ish sweep at peak (bar 11)
    for (let i = 0; i < 16; i++) {
      const start = t0 + 11 * BAR + i * (BAR / 16);
      playNoise({
        start, duration: BAR / 16,
        gain: 0.015 * (i / 16), filter: 2000 + i * 300, type: 'highpass', q: 0.5,
      });
    }
  }

  function scheduleNextCycle() {
    const t0 = ctx.currentTime + 0.05;
    scheduleCycle(t0);
    if (nextCycleTimer) clearTimeout(nextCycleTimer);
    // Próximo cycle um pouco antes do fim pra não ter gap
    nextCycleTimer = setTimeout(scheduleNextCycle, (CYCLE_SEC - 0.5) * 1000);
  }

  function start() {
    if (started) return;
    started = true;
    master = ctx.createGain();
    master.gain.value = 0.35;    // volume discreto por default
    master.connect(ctx.destination);
    reverbSend = buildReverbBus();
    scheduleNextCycle();
  }

  function tryResume() {
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
    start();
  }

  // Tenta imediatamente
  tryResume();

  // Fallback: primeiro click/tap/teclado dentro do iframe
  const gesture = () => {
    tryResume();
    ['click', 'touchstart', 'keydown'].forEach(ev =>
      document.removeEventListener(ev, gesture, true)
    );
  };
  ['click', 'touchstart', 'keydown'].forEach(ev =>
    document.addEventListener(ev, gesture, true)
  );

  // Pausa quando iframe fica invisivel (poupa CPU/bateria)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (master) master.gain.value = 0;
    } else {
      if (master) master.gain.value = 0.35;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    }
  });
})();
