// Fully synthesized audio (WebAudio) – no sound files, so no licensing concerns.
export class GameAudio {
  ctx: AudioContext | null = null; master!: GainNode; private noise!: AudioBuffer; private verb!: ConvolverNode; private wet!: GainNode; volume = 0.8;
  init() {
    if (this.ctx) { this.ctx.resume(); return; }
    const AC = window.AudioContext || (window as any).webkitAudioContext; if (!AC) return;
    let c: AudioContext; try { c = new AC({ latencyHint: 0 }); } catch { c = new AC(); } this.ctx = c; this.master = c.createGain(); this.master.gain.value = this.volume;
    // soft limiter without look-ahead (a DynamicsCompressor delays everything by several milliseconds)
    const lim = c.createWaveShaper(), cv = new Float32Array(1025); for (let i = 0; i < 1025; i++) { const x = (i / 512 - 1) * 2; cv[i] = Math.tanh(x * 0.9) / Math.tanh(0.9 * 2) * 0.98; } lim.curve = cv; const pre = c.createGain(); pre.gain.value = 0.5; this.master.connect(pre); pre.connect(lim); lim.connect(c.destination);
    this.noise = c.createBuffer(1, c.sampleRate, c.sampleRate); const d = this.noise.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const ir = c.createBuffer(2, c.sampleRate * 1.1, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) { const b = ir.getChannelData(ch); for (let i = 0; i < b.length; i++) b[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / b.length, 3.2); }
    this.verb = c.createConvolver(); this.verb.buffer = ir; this.wet = c.createGain(); this.wet.gain.value = 0.3; this.verb.connect(this.wet); this.wet.connect(this.master);
    // room tone
    void this.loadLines();
    const hum = c.createBufferSource(); hum.buffer = this.noise; hum.loop = true; const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 140; const hg = c.createGain(); hg.gain.value = 0.05; hum.connect(lp); lp.connect(hg); hg.connect(this.master); hum.start();
  }
  // ---- recorded voice lines (public/voice, generated with the CC0 NST Swedish Piper voice) ----
  private lines = new Map<string, AudioBuffer>(); private linesReq = false; linesReady = false;
  private async loadLines() {
    if (this.linesReq || !this.ctx) return; this.linesReq = true;
    try {
      const man = await (await fetch('./voice/manifest.json')).json();
      await Promise.all((man.voices as string[]).flatMap(v => (man.lines as string[]).map(async (text, i) => { try { const ab = await (await fetch(`./voice/${v}/${i}.mp3`)).arrayBuffer(); this.lines.set(v + '|' + text, await this.ctx!.decodeAudioData(ab)); } catch { /* falls back to browser speech */ } })));
      this.linesReady = this.lines.size > 0;
    } catch { /* no clips: browser speech is used */ }
  }
  hasLine(text: string) { return this.lines.has('m|' + text); }
  /** Output delay reported by the browser, in milliseconds (0 if unknown). */
  get latencyMs() { const c = this.ctx as any; return c ? Math.round(((c.baseLatency || 0) + (c.outputLatency || 0)) * 1000) : 0; }
  /** Plays a recorded line as a particular character. Returns its duration in ms, or 0 if there is no clip for the text.
   *  rate shifts pitch and tempo together (different people), radio = team radio filter, gruff = rough close voice. */
  line(text: string, o: { voice?: 'm' | 'f'; rate?: number; radio?: boolean; gruff?: boolean; gain?: number; pan?: number; muffle?: boolean } = {}) {
    const buf = this.lines.get((o.voice ?? 'm') + '|' + text) ?? this.lines.get('m|' + text); if (!this.ctx || !buf) return 0;
    const c = this.ctx, t = c.currentTime, rate = o.rate ?? 1, src = c.createBufferSource(); src.buffer = buf; src.playbackRate.value = rate;
    let node: AudioNode = src; const chain = (n: AudioNode) => { node.connect(n); node = n; };
    const shape = (k: number) => { const w = c.createWaveShaper(), cv = new Float32Array(257); for (let i = 0; i < 257; i++) { const x = i / 128 - 1; cv[i] = Math.tanh(x * k) / Math.tanh(k); } w.curve = cv; return w; };
    if (o.radio) {
      const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 420; hp.Q.value = 0.8; chain(hp);
      const pk = c.createBiquadFilter(); pk.type = 'peaking'; pk.frequency.value = 1900; pk.Q.value = 1; pk.gain.value = 7; chain(pk);
      const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3100; lp.Q.value = 0.9; chain(lp); chain(shape(3.2));
    } else if (o.gruff) { chain(shape(2.2)); const ls = c.createBiquadFilter(); ls.type = 'lowshelf'; ls.frequency.value = 260; ls.gain.value = 5; chain(ls); }
    if (o.muffle) { const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900; chain(lp); }
    const out = this.out(o.pan ?? 0, (o.gain ?? 1) * (o.radio ? 0.9 : 1.25), !o.radio); chain(out); src.start(t + (o.radio ? 0.06 : 0));
    const dur = buf.duration / rate;
    if (o.radio) { const g = this.out(o.pan ?? 0, 0.05, false); this.burst(g, dur + 0.1, 'bandpass', 2200, 2200, 0.7, 0.5); } // carrier hiss under the transmission
    return dur * 1000 + 120;
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
  step(vol = 0.25, pan = 0) { if (!this.ctx) return; const o = this.out(pan, vol * 1.8, false); this.burst(o, 0.07, 'lowpass', 500 + Math.random() * 200, 120, 1, 0.9); this.burst(o, 0.03, 'bandpass', 1800, 900, 1.5, 0.25); }
  door(dist: number, pan: number) { if (!this.ctx) return; const o = this.out(pan, 1.2 / (1 + dist * 0.12)); this.tone(o, 'sawtooth', 95, 150, 0.32, 0.12); this.burst(o, 0.12, 'lowpass', 600, 90, 1, 0.9, 0.3); }
  cuff() { if (!this.ctx) return; const o = this.out(0, 0.5, false); for (let i = 0; i < 6; i++) this.burst(o, 0.02, 'bandpass', 3500 + i * 250, 3000, 8, 0.6, i * 0.04); }
  bang(dist: number, pan: number, deaf: number) {
    if (!this.ctx) return; const o = this.out(pan, 1.6 / (1 + dist * 0.06)); this.burst(o, 0.5, 'lowpass', 9000, 120, 0.5, 1.5); this.tone(o, 'sine', 120, 30, 0.4, 1.2);
    if (deaf > 0.15) { const r = this.out(0, deaf * 0.25, false); this.tone(r, 'sine', 3900, 3850, 3 + deaf * 3, 1); }
  }
  hurt() { if (!this.ctx) return; const o = this.out(0, 0.7, false); this.tone(o, 'sine', 140, 50, 0.18, 1); this.burst(o, 0.08, 'lowpass', 900, 200, 1, 0.6); }
  hitmark(head: boolean) { if (!this.ctx) return; const o = this.out(0, 0.3, false); this.tone(o, 'triangle', head ? 1500 : 950, head ? 1100 : 700, 0.05, 0.7); }
  impact(dist: number, pan: number) { if (!this.ctx) return; const o = this.out(pan, 0.35 / (1 + dist * 0.2)); this.burst(o, 0.05, 'bandpass', 2600 + Math.random() * 1500, 900, 2, 0.8); }
  radio() { if (!this.ctx) return; const o = this.out(0, 0.3, false); this.tone(o, 'square', 1250, 1250, 0.045, 0.4); this.burst(o, 0.09, 'bandpass', 2200, 2000, 1.5, 0.35, 0.05); }
  /** Synthesised human-ish vocal (formant filtered saw). Works even when the browser has no speech voices. */
  vocal(kind: 'shout' | 'pain' | 'die' | 'whimper' | 'yes', pitch: number, dist: number, pan: number) {
    if (!this.ctx) return; const c = this.ctx, t = c.currentTime, g = this.out(pan, 0.9 / (1 + dist * 0.14));
    const P = { shout: [1.25, 1.0, 0.38, 800, 1250], pain: [1.5, 0.8, 0.22, 650, 1700], die: [1.1, 0.5, 0.75, 600, 1000], whimper: [1.9, 1.5, 0.45, 400, 2100], yes: [1.0, 1.15, 0.16, 500, 1500] }[kind];
    const f0 = 120 * pitch, o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.setValueAtTime(f0 * P[0], t); o.frequency.exponentialRampToValueAtTime(f0 * P[1], t + P[2]);
    const vib = c.createOscillator(), vg = c.createGain(); vib.frequency.value = kind === 'whimper' ? 9 : 5.5; vg.gain.value = f0 * (kind === 'whimper' ? 0.06 : 0.02); vib.connect(vg); vg.connect(o.frequency);
    const env = c.createGain(); env.gain.setValueAtTime(0.0001, t); env.gain.exponentialRampToValueAtTime(0.9, t + 0.03); env.gain.exponentialRampToValueAtTime(0.001, t + P[2]);
    for (const [f, q, lvl] of [[P[3], 7, 1], [P[4], 9, 0.6], [2700, 10, 0.25]]) { const b = c.createBiquadFilter(); b.type = 'bandpass'; b.frequency.value = f; b.Q.value = q; const l = c.createGain(); l.gain.value = lvl * 2.2; o.connect(b); b.connect(l); l.connect(env); }
    env.connect(g); o.start(t); vib.start(t); o.stop(t + P[2] + 0.05); vib.stop(t + P[2] + 0.05);
    this.burst(g, P[2] * 0.6, 'bandpass', 2500, 1800, 1, 0.08);
  }
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
  /** A recorded clip is playing for ms milliseconds (keeps `speaking` correct). */
  busy(ms: number) { this.until = Math.max(this.until, performance.now() + ms); }
  private keep = new Set<SpeechSynthesisUtterance>(); // Chrome drops utterances that get garbage collected
  get voiceCount() { return this.voices.length; }
  private pick() {
    if (!this.voices.length && 'speechSynthesis' in window) this.voices = speechSynthesis.getVoices();
    const pre = this.lang.slice(0, 2), V = this.voices;
    return V.find(x => x.lang.replace('_', '-') === this.lang) ?? V.find(x => x.lang.toLowerCase().startsWith(pre)) ?? null;
  }
  get hasLangVoice() { return !!this.pick(); }
  say(text: string, pitch = 1, rate = 1.15, vol = 0.9, force = false) {
    if ((!this.enabled && !force) || !('speechSynthesis' in window)) return;
    if (this.queue > 1 && !force) return;
    const clean = text.replace(/^Team ([AB]): /, '');
    const u = new SpeechSynthesisUtterance(clean), v = this.pick();
    if (v) { u.voice = v; u.lang = v.lang; } // no matching voice: let the browser use its default voice instead of staying silent
    u.pitch = pitch; u.rate = rate; u.volume = vol; this.queue++; this.keep.add(u);
    const est = 500 + clean.length * 75; this.until = Math.max(this.until, performance.now()) + est;
    let done = false; const end = () => { if (done) return; done = true; this.keep.delete(u); this.queue = Math.max(0, this.queue - 1); if (this.queue === 0) this.until = Math.min(this.until, performance.now() + 350); };
    u.onend = u.onerror = end; setTimeout(end, est + 2500);
    try { if (speechSynthesis.paused) speechSynthesis.resume(); speechSynthesis.speak(u); } catch { end(); }
  }
  stop() { if ('speechSynthesis' in window) speechSynthesis.cancel(); this.queue = 0; this.until = 0; }
}
