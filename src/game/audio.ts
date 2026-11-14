// Fully synthesized audio (WebAudio) – no sound files, so no licensing concerns.
export class GameAudio {
  ctx: AudioContext | null = null; master!: GainNode; private noise!: AudioBuffer; private verb!: ConvolverNode; private wet!: GainNode; volume = 0.8;
  init() {
    if (this.ctx) { this.ctx.resume(); return; }
    const AC = window.AudioContext || (window as any).webkitAudioContext; if (!AC) return;
    const c = this.ctx = new AC(); this.master = c.createGain(); this.master.gain.value = this.volume;
    const comp = c.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 6; this.master.connect(comp); comp.connect(c.destination);
    this.noise = c.createBuffer(1, c.sampleRate, c.sampleRate); const d = this.noise.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const ir = c.createBuffer(2, c.sampleRate * 1.1, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) { const b = ir.getChannelData(ch); for (let i = 0; i < b.length; i++) b[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / b.length, 3.2); }
    this.verb = c.createConvolver(); this.verb.buffer = ir; this.wet = c.createGain(); this.wet.gain.value = 0.3; this.verb.connect(this.wet); this.wet.connect(this.master);
    // room tone
    const hum = c.createBufferSource(); hum.buffer = this.noise; hum.loop = true; const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 140; const hg = c.createGain(); hg.gain.value = 0.05; hum.connect(lp); lp.connect(hg); hg.connect(this.master); hum.start();
  }
  setVolume(v: number) { this.volume = v; if (this.ctx) this.master.gain.value = v; }
  private out(pan: number, gain: number, wet = true) {
    const c = this.ctx!, g = c.createGain(); g.gain.value = gain; const p = c.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, pan)); g.connect(p); p.connect(this.master); if (wet) p.connect(this.verb); return g;
  }
  private burst(dst: AudioNode, dur: number, type: BiquadFilterType, f0: number, f1: number, q = 1, vol = 1, delay = 0) {
    const c = this.ctx!, t = c.currentTime + delay, s = c.createBufferSource(); s.buffer = this.noise; s.playbackRate.value = 0.6 + Math.random() * 0.8;
    const f = c.createBiquadFilter(); f.type = type; f.Q.value = q; f.frequency.setValueAtTime(f0, t); f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = c.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur); s.connect(f); f.connect(g); g.connect(dst); s.start(t, Math.random() * 0.5, dur + 0.05);
  }
  private tone(dst: AudioNode, type: OscillatorType, f0: number, f1: number, dur: number, vol = 1, delay = 0) {
    const c = this.ctx!, t = c.currentTime + delay, o = c.createOscillator(); o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    const g = c.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur); o.connect(g); g.connect(dst); o.start(t); o.stop(t + dur + 0.02);
  }
  shot(dist: number, pan: number, own: boolean, heavy = true) {
    if (!this.ctx) return; const att = own ? 0.9 : 1 / (1 + dist * 0.12), o = this.out(pan, att);
    const top = Math.max(900, 7000 - dist * 220);
    this.burst(o, heavy ? 0.16 : 0.11, 'lowpass', top, 300, 0.7, 1.1); this.burst(o, 0.035, 'highpass', 2500, 1500, 0.5, own ? 0.7 : 0.3);
    this.tone(o, 'sine', heavy ? 170 : 240, 45, 0.11, 0.9); if (own) this.burst(o, 0.05, 'bandpass', 5200, 4200, 6, 0.2, 0.09);
  }
  dry() { if (!this.ctx) return; const o = this.out(0, 0.5, false); this.tone(o, 'square', 1800, 900, 0.03, 0.25); }
  reload() { if (!this.ctx) return; const o = this.out(0.2, 0.5, false); this.burst(o, 0.05, 'bandpass', 2400, 1800, 4, 0.7); this.burst(o, 0.06, 'bandpass', 1500, 1100, 4, 0.8, 0.55); this.tone(o, 'square', 500, 200, 0.04, 0.15, 1.1); this.burst(o, 0.05, 'bandpass', 3000, 2000, 3, 0.9, 1.12); }
  step(vol = 0.25, pan = 0) { if (!this.ctx) return; const o = this.out(pan, vol, false); this.burst(o, 0.07, 'lowpass', 500 + Math.random() * 200, 120, 1, 0.9); }
  door(dist: number, pan: number) { if (!this.ctx) return; const o = this.out(pan, 0.7 / (1 + dist * 0.15)); this.tone(o, 'sawtooth', 95, 150, 0.32, 0.12); this.burst(o, 0.12, 'lowpass', 600, 90, 1, 0.9, 0.3); }
  cuff() { if (!this.ctx) return; const o = this.out(0, 0.5, false); for (let i = 0; i < 6; i++) this.burst(o, 0.02, 'bandpass', 3500 + i * 250, 3000, 8, 0.6, i * 0.04); }
  bang(dist: number, pan: number, deaf: number) {
    if (!this.ctx) return; const o = this.out(pan, 1.6 / (1 + dist * 0.06)); this.burst(o, 0.5, 'lowpass', 9000, 120, 0.5, 1.5); this.tone(o, 'sine', 120, 30, 0.4, 1.2);
    if (deaf > 0.15) { const r = this.out(0, deaf * 0.25, false); this.tone(r, 'sine', 3900, 3850, 3 + deaf * 3, 1); }
  }
  hurt() { if (!this.ctx) return; const o = this.out(0, 0.7, false); this.tone(o, 'sine', 140, 50, 0.18, 1); this.burst(o, 0.08, 'lowpass', 900, 200, 1, 0.6); }
  hitmark(head: boolean) { if (!this.ctx) return; const o = this.out(0, 0.3, false); this.tone(o, 'triangle', head ? 1500 : 950, head ? 1100 : 700, 0.05, 0.7); }
  impact(dist: number, pan: number) { if (!this.ctx) return; const o = this.out(pan, 0.35 / (1 + dist * 0.2)); this.burst(o, 0.05, 'bandpass', 2600 + Math.random() * 1500, 900, 2, 0.8); }
  radio() { if (!this.ctx) return; const o = this.out(0, 0.18, false); this.tone(o, 'square', 1250, 1250, 0.045, 0.4); this.burst(o, 0.09, 'bandpass', 2200, 2000, 1.5, 0.35, 0.05); }
  ui() { if (!this.ctx) return; const o = this.out(0, 0.25, false); this.tone(o, 'triangle', 700, 900, 0.05, 0.5); }
  ok() { if (!this.ctx) return; const o = this.out(0, 0.25, false); this.tone(o, 'triangle', 660, 660, 0.07, 0.5); this.tone(o, 'triangle', 990, 990, 0.1, 0.5, 0.08); }
  fail() { if (!this.ctx) return; const o = this.out(0, 0.25, false); this.tone(o, 'sawtooth', 220, 150, 0.2, 0.4); }
}

/** Radio chatter through the browser's built-in speech synthesis (free, offline on most systems). */
export class Speech {
  enabled = true; lang = 'sv-SE'; private voices: SpeechSynthesisVoice[] = []; private until = 0; private queue = 0;
  constructor() { if ('speechSynthesis' in window) { const load = () => { this.voices = speechSynthesis.getVoices(); }; load(); speechSynthesis.onvoiceschanged = load; } }
  /** True while the team is (estimated to be) talking. Uses our own timer – speechSynthesis.speaking can get stuck in some browsers. */
  get speaking() { return performance.now() < this.until; }
  say(text: string, pitch = 1, rate = 1.15, vol = 0.9) {
    if (!this.enabled || !('speechSynthesis' in window)) return;
    if (this.queue > 1) return;
    const clean = text.replace(/^Team ([AB]): /, '');
    const u = new SpeechSynthesisUtterance(clean); const pre = this.lang.slice(0, 2);
    const v = this.voices.find(x => x.lang === this.lang) ?? this.voices.find(x => x.lang.startsWith(pre)); if (v) u.voice = v; u.lang = this.lang;
    u.pitch = pitch; u.rate = rate; u.volume = vol; this.queue++;
    const est = 500 + clean.length * 75; this.until = Math.max(this.until, performance.now()) + est;
    let done = false; const end = () => { if (done) return; done = true; this.queue = Math.max(0, this.queue - 1); if (this.queue === 0) this.until = Math.min(this.until, performance.now() + 350); };
    u.onend = u.onerror = end; setTimeout(end, est + 2500);
    try { speechSynthesis.resume(); speechSynthesis.speak(u); } catch { end(); }
  }
  stop() { if ('speechSynthesis' in window) speechSynthesis.cancel(); this.queue = 0; this.until = 0; }
}
