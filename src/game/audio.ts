// Weapon and door sounds are real recordings (public/sfx, CC0 – see public/sfx/LICENSE.txt); everything else is synthesized with WebAudio.
export type Gun = 'rifle' | 'pistol' | 'smg' | 'shotgun';
const SFX = ['shot-m4a1-1', 'shot-m4a1-2', 'shot-m9a1-1', 'shot-m9a1-2', 'shot-m9a1-3', 'shot-mp5-1', 'shot-mp5-2', 'shot-mp5-3', 'shot-m1014-1', 'shot-m1014-2', 'shot-m1014-3', 'far-rifle', 'far-pistol', 'far-smg', 'far-shotgun', 'far-sniper',
  'foley-mag-out', 'foley-mag-in', 'foley-charge', 'foley-pistol-out', 'foley-pistol-in', 'foley-slide', 'foley-click', 'foley-bolt', 'foley-rack', 'foley-shell', 'foley-clack', 'foley-latch',
  'door-open-1', 'door-open-2', 'door-close-1', 'door-close-2', 'door-close-3', 'door-slam', 'door-creak-1', 'door-creak-2', 'door-latch'];
const NEAR: Record<Gun, string[]> = { rifle: ['shot-m4a1-1', 'shot-m4a1-2'], pistol: ['shot-m9a1-1', 'shot-m9a1-2', 'shot-m9a1-3'], smg: ['shot-mp5-1', 'shot-mp5-2', 'shot-mp5-3'], shotgun: ['shot-m1014-1', 'shot-m1014-2', 'shot-m1014-3'] };
// Voice levels. Every clip is measured when it is loaded and scaled to LINE_LEVEL (RMS of its voiced parts, dBFS), so a shouted
// line is not louder than a spoken one – it only sounds shouted. CH_* even out what the radio / rough-voice filters add.
const LINE_LEVEL = -20, CH_RADIO = 0.89, CH_GRUFF = 0.8, CH_PLAIN = 2.14, CH_SHOUT = 1.25, CH_GRUFF_SHOUT = 0.95;
/** Gain that brings a clip's voiced parts to the target level. */
function level(buf: AudioBuffer, target: number) {
  const d = buf.getChannelData(0), n = Math.max(1, Math.round(buf.sampleRate * 0.05)), fr: number[] = [];
  for (let i = 0; i + n <= d.length; i += n) { let e = 0; for (let k = i; k < i + n; k++) e += d[k] * d[k]; fr.push(e / n); }
  if (!fr.length) return 1; const top = Math.max(...fr), act = fr.filter(e => e > top * 0.03); const rms = Math.sqrt(act.reduce((x, y) => x + y, 0) / act.length);
  return rms > 1e-5 ? Math.min(4, Math.max(0.1, Math.pow(10, target / 20) / rms)) : 1;
}
export class GameAudio {
  ctx: AudioContext | null = null; master!: GainNode; private masterFilter!: BiquadFilterNode;
  private noise!: AudioBuffer; private verb!: ConvolverNode; private wet!: GainNode;
  private verbBuffers: Partial<Record<'tight' | 'hall' | 'exterior', AudioBuffer>> = {};
  private roomKind: 'tight' | 'hall' | 'exterior' = 'tight';
  volume = 0.8;
  private makeImpulse(c: AudioContext, sec: number, decay: number, damp: number) {
    const len = Math.max(1024, Math.floor(c.sampleRate * sec));
    const ir = c.createBuffer(2, len, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const b = ir.getChannelData(ch);
      let prev = 0;
      for (let i = 0; i < len; i++) {
        const w = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
        prev = prev * damp + w * (1 - damp);
        b[i] = prev;
      }
    }
    return ir;
  }
  init() {
    if (this.ctx) { this.ctx.resume(); return; }
    const AC = window.AudioContext || (window as any).webkitAudioContext; if (!AC) return;
    let c: AudioContext; try { c = new AC({ latencyHint: 0 }); } catch { c = new AC(); } this.ctx = c; this.master = c.createGain(); this.master.gain.value = this.volume;
    this.masterFilter = c.createBiquadFilter(); this.masterFilter.type = 'lowpass'; this.masterFilter.frequency.value = 22000; this.masterFilter.Q.value = 0.7;
    // soft limiter without look-ahead (a DynamicsCompressor delays everything by several milliseconds)
    const lim = c.createWaveShaper(), cv = new Float32Array(1025); for (let i = 0; i < 1025; i++) { const x = (i / 512 - 1) * 2; cv[i] = Math.tanh(x * 0.9) / Math.tanh(0.9 * 2) * 0.98; } lim.curve = cv; const pre = c.createGain(); pre.gain.value = 0.5;
    this.master.connect(this.masterFilter); this.masterFilter.connect(pre); pre.connect(lim); lim.connect(c.destination);
    this.noise = c.createBuffer(1, c.sampleRate, c.sampleRate); const d = this.noise.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.verbBuffers = {
      tight: this.makeImpulse(c, 0.55, 4.4, 0.45),
      hall: this.makeImpulse(c, 1.45, 2.5, 0.25),
      exterior: this.makeImpulse(c, 0.85, 3.8, 0.65),
    };
    this.verb = c.createConvolver(); this.verb.buffer = this.verbBuffers.tight!; this.wet = c.createGain(); this.wet.gain.value = 0.26; this.verb.connect(this.wet); this.wet.connect(this.master);
    // room tone
    void this.loadLines(); void this.loadSfx();
    const hum = c.createBufferSource(); hum.buffer = this.noise; hum.loop = true; const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 140; const hg = c.createGain(); hg.gain.value = 0.05; hum.connect(lp); lp.connect(hg); hg.connect(this.master); hum.start();
  }
  setRoomAcoustic(kind: 'tight' | 'hall' | 'exterior') {
    if (!this.ctx || !this.verb || this.roomKind === kind) return;
    this.roomKind = kind;
    const buf = this.verbBuffers[kind];
    if (buf) this.verb.buffer = buf;
    this.wet.gain.setTargetAtTime(kind === 'hall' ? 0.38 : kind === 'tight' ? 0.24 : 0.14, this.ctx.currentTime, 0.15);
  }
  setDeafness(k: number) {
    if (!this.ctx || !this.masterFilter) return;
    const clamped = Math.max(0, Math.min(1, k));
    const cutoff = clamped > 0.04 ? 580 + Math.pow(1 - clamped, 2.4) * 20000 : 22000;
    this.masterFilter.frequency.setTargetAtTime(cutoff, this.ctx.currentTime, 0.08);
  }
  // ---- menu music & outdoor rain ambience (public/music) ----
  private menuBufs: { music?: AudioBuffer; rain?: AudioBuffer } = {};
  private menuLoading: Promise<void> | null = null;
  private menuNodes: { src: AudioBufferSourceNode; gain: GainNode; target: number }[] = [];
  private menuWant = false;
  private menuPlaying = false;
  private menuSeq = 0;
  private loadMenuAudio() {
    if (this.menuLoading || !this.ctx) return this.menuLoading;
    const c = this.ctx;
    const grab = async (url: string) => {
      try {
        const res = await fetch(url);
        if (!res.ok) return undefined;
        return await c.decodeAudioData(await res.arrayBuffer());
      } catch { return undefined; }
    };
    this.menuLoading = Promise.all([grab('./music/menu_theme.ogg'), grab('./music/rain_soft.ogg')]).then(([music, rain]) => {
      this.menuBufs.music = music;
      this.menuBufs.rain = rain;
    });
    return this.menuLoading;
  }
  /** Fades custom menu music & soft outdoor rain ambience in on the title screen and out during missions. */
  async setMenuMusic(active: boolean) {
    this.menuWant = active;
    const seq = ++this.menuSeq;
    if (!this.ctx) return;
    if (!active) {
      if (!this.menuPlaying && !this.menuNodes.length) return;
      this.menuPlaying = false;
      const c = this.ctx, t = c.currentTime;
      const nodes = this.menuNodes.splice(0);
      for (const n of nodes) {
        try {
          n.gain.gain.cancelScheduledValues(t);
          n.gain.gain.setValueAtTime(n.gain.gain.value, t);
          n.gain.gain.linearRampToValueAtTime(0, t + 0.65);
          n.src.stop(t + 0.72);
        } catch { /* already stopped */ }
      }
      return;
    }
    if (this.menuPlaying) return;
    await this.loadMenuAudio();
    if (!this.menuWant || seq !== this.menuSeq || !this.ctx || this.menuPlaying) return;
    const c = this.ctx;
    if (c.state === 'suspended') { try { await c.resume(); } catch { /* ignore */ } }
    if (!this.menuWant || seq !== this.menuSeq) return;
    this.menuPlaying = true;
    const t = c.currentTime;
    const spawn = (buf: AudioBuffer | undefined, target: number) => {
      if (!buf) return;
      const src = c.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const gain = c.createGain();
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.linearRampToValueAtTime(target, t + 1.4);
      src.connect(gain);
      gain.connect(this.master);
      src.start(t);
      this.menuNodes.push({ src, gain, target });
    };
    spawn(this.menuBufs.music, 0.34);
    spawn(this.menuBufs.rain, 0.12);
  }
  // ---- recorded voice lines (public/voice, generated with the Apache-2.0 Kokoro speech model; one set of voices per role) ----
  private lines = new Map<string, AudioBuffer>(); private linesReq: Promise<void> | null = null; linesReady = false;
  /** Loads the recorded voice clips. Every spoken line is a clip – there is no synthesised fallback voice. */
  private loadLines(): Promise<void> {
    if (!this.linesReq) this.linesReq = (async () => {
      if (!this.ctx) return;
      try {
        const man = await (await fetch('./voice/manifest.json')).json();
        const L = man.lines as { t: string; r: string; s?: number }[]; for (const l of L) { this.known.add(l.t); if (l.s) this.loud.add(l.t); }
        await Promise.all((man.voices as string[]).flatMap(v => L.map(async (l, i) => { if (!l.r.includes(v[0])) return; try { const ab = await (await fetch(`./voice/${v}/${i}.mp3`)).arrayBuffer(); const buf = await this.ctx!.decodeAudioData(ab); this.lineGain.set(buf, level(buf, LINE_LEVEL)); this.lines.set(v + '|' + l.t, buf); } catch { /* no clip for this line: it stays silent */ } })));
        this.linesReady = this.lines.size > 0;
      } catch { /* no clips: nothing is spoken */ }
    })();
    return this.linesReq;
  }
  private lineGain = new WeakMap<AudioBuffer, number>();
  private known = new Set<string>(); private loud = new Set<string>();
  hasLine(text: string) { return this.linesReady && this.known.has(text); }
  /** True for lines that were recorded as a shout. */
  isShout(text: string) { return this.loud.has(text); }
  /** Output delay reported by the browser, in milliseconds (0 if unknown). */
  get latencyMs() { const c = this.ctx as any; return c ? Math.round(((c.baseLatency || 0) + (c.outputLatency || 0)) * 1000) : 0; }
  /** Plays a recorded line as a particular character. Returns its duration in ms, or 0 if there is no clip for the text.
   *  rate shifts pitch and tempo together (different people), radio = team radio filter, gruff = rough close voice. */
  line(text: string, o: { voice?: string; rate?: number; radio?: boolean; gruff?: boolean; shout?: boolean; gain?: number; pan?: number; muffle?: boolean; onSrc?: (src: AudioBufferSourceNode) => void } = {}) {
    const v = o.voice ?? 'o1'; let buf = this.lines.get(v + '|' + text); if (!buf) for (let i = 1; i < 6 && !buf; i++) buf = this.lines.get(v[0] + i + '|' + text); if (!this.ctx || !buf) return 0;
    const c = this.ctx, t = c.currentTime, rate = o.rate ?? 1, src = c.createBufferSource(); src.buffer = buf; src.playbackRate.value = rate; o.onSrc?.(src);
    let node: AudioNode = src; const chain = (n: AudioNode) => { node.connect(n); node = n; };
    { const lv = c.createGain(); lv.gain.value = this.lineGain.get(buf) ?? 1; chain(lv); } // every clip enters at the same loudness, shouted or not
    const shape = (k: number) => { const w = c.createWaveShaper(), cv = new Float32Array(257); for (let i = 0; i < 257; i++) { const x = i / 128 - 1; cv[i] = Math.tanh(x * k) / Math.tanh(k); } w.curve = cv; return w; };
    if (o.radio) {
      const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 420; hp.Q.value = 0.8; chain(hp);
      const pk = c.createBiquadFilter(); pk.type = 'peaking'; pk.frequency.value = 1900; pk.Q.value = 1; pk.gain.value = 7; chain(pk);
      const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3100; lp.Q.value = 0.9; chain(lp); chain(shape(3.2));
    } else if (o.gruff) { chain(shape(2.2)); const ls = c.createBiquadFilter(); ls.type = 'lowshelf'; ls.frequency.value = 260; ls.gain.value = 5; chain(ls); }
    if (o.muffle) { const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900; chain(lp); }
    if (o.shout && !o.radio && !o.gruff) chain(shape(1.7)); // a strained, pushed voice
    const out = this.out(o.pan ?? 0, (o.gain ?? 1) * (o.radio ? CH_RADIO : o.gruff ? (o.shout ? CH_GRUFF_SHOUT : CH_GRUFF) : o.shout ? CH_SHOUT : CH_PLAIN), !o.radio);
    // a yell rings in the room; the level stays the same
    if (o.shout) { const send = c.createGain(); send.gain.value = 0.9; out.connect(send); send.connect(this.verb); }
    chain(out); src.start(t + (o.radio ? 0.06 : 0));
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
  // ---- recorded weapon sounds ----
  private sfx = new Map<string, AudioBuffer>(); private sfxReq = false; private lastTake = '';
  private async loadSfx() {
    if (this.sfxReq || !this.ctx) return; this.sfxReq = true; const c = this.ctx;
    await Promise.all(SFX.map(async n => { try { this.sfx.set(n, await c.decodeAudioData(await (await fetch(`./sfx/${n}.mp3`)).arrayBuffer())); } catch { /* the synthesized fallback is used */ } }));
  }
  /** Plays a recording into dst. Returns false if it is not loaded. */
  private sample(name: string, dst: AudioNode, vol = 1, rate = 1, delay = 0, lowpass = 0) {
    const b = this.sfx.get(name); if (!b) return false; const c = this.ctx!, s = c.createBufferSource(); s.buffer = b; s.playbackRate.value = rate;
    const g = c.createGain(); g.gain.value = vol; let last: AudioNode = s;
    if (lowpass) { const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lowpass; f.Q.value = 0.4; last.connect(f); last = f; }
    last.connect(g); g.connect(dst); s.start(c.currentTime + delay); return true;
  }
  shot(dist: number, pan: number, own: boolean, gun: Gun = 'rifle', muffled = false) {
    if (!this.ctx) return;
    const takes = NEAR[gun].filter(n => this.sfx.has(n));
    const wallCut = muffled ? Math.max(520, 1250 - dist * 35) : 0;
    if (takes.length) {
      // never the same take twice in a row, and a slight pitch drift, so automatic fire does not sound like a loop
      let take = takes[(Math.random() * takes.length) | 0]; if (take === this.lastTake && takes.length > 1) take = takes[(takes.indexOf(take) + 1) % takes.length]; this.lastTake = take;
      const rate = (gun === 'shotgun' ? 0.94 : 0.97) + Math.random() * 0.06;
      const far = Math.max(0, Math.min(1, (dist - 6) / 16));
      const gain = own ? (gun === 'shotgun' ? 1.25 : 1.15) : (muffled ? 0.85 : 1.5) / (1 + dist * 0.1);
      const o = this.out(pan, gain, !muffled);
      const lp = own ? 0 : wallCut || Math.max(1400, 16000 - dist * 800);
      // close: the dry report; further away (or behind walls) it is duller and gives way to the distant recording
      if (far < 1) this.sample(take, o, 1 - far * 0.8, rate, 0, lp);
      if (far > 0 && !own) this.sample('far-' + gun, o, far * (muffled ? 0.75 : 1.3), gun === 'shotgun' ? rate * 0.92 : rate, 0, wallCut);
      if (own) {
        this.tone(o, 'sine', gun === 'shotgun' ? 68 : gun === 'rifle' ? 95 : 120, 36, gun === 'shotgun' ? 0.14 : 0.09, gun === 'shotgun' ? 0.7 : 0.5); // chest thump
        if (gun === 'shotgun') this.sample('foley-rack', this.out(0.14, 0.42, false), 1, 1.05, 0.24);
        this.shell(gun);
      }
      return;
    }
    const heavy = gun !== 'pistol', att = own ? 0.9 : (muffled ? 0.55 : 1) / (1 + dist * 0.12), o = this.out(pan, att, !muffled);
    const top = wallCut || Math.max(900, 7000 - dist * 220);
    this.burst(o, heavy ? 0.16 : 0.11, 'lowpass', top, 300, 0.7, 1.1);
    if (!muffled) this.burst(o, 0.035, 'highpass', 2500, 1500, 0.5, own ? 0.7 : 0.3);
    this.tone(o, 'sine', heavy ? 170 : 240, 45, 0.11, 0.9);
    if (own) { this.burst(o, 0.05, 'bandpass', 5200, 4200, 6, 0.2, 0.09); this.shell(gun); }
  }
  /** Subtle brass casing / shotgun hull clink hitting the floor. */
  shell(gun: Gun = 'rifle') {
    if (!this.ctx) return;
    const o = this.out(0.28, gun === 'shotgun' ? 0.14 : 0.11, true);
    const d1 = gun === 'shotgun' ? 0.38 : 0.26 + Math.random() * 0.08;
    const fBase = gun === 'shotgun' ? 1400 : 4200 + Math.random() * 900;
    this.tone(o, 'sine', fBase, fBase * 0.92, 0.025, 0.5, d1);
    this.tone(o, 'sine', fBase * 1.18, fBase * 1.05, 0.02, 0.35, d1 + 0.065);
  }
  fireMode() {
    if (!this.ctx) return;
    const o = this.out(0.08, 0.45, false);
    this.tone(o, 'triangle', 2200, 1300, 0.022, 0.7);
    this.burst(o, 0.02, 'bandpass', 3600, 2600, 4, 0.35);
  }
  dry() { if (!this.ctx) return; const o = this.out(0, 0.9, false); if (!this.sample('foley-click', o)) this.tone(o, 'square', 1800, 900, 0.03, 0.14); }
  /** Magazine out, magazine in, charging handle / slide – spread over the reload time (seconds). */
  reload(gun: Gun = 'rifle', dur = 2, speed = false) {
    if (!this.ctx) return; const o = this.out(0.15, speed ? 1.05 : 0.9, false), r = gun === 'rifle';
    if (gun === 'shotgun') {
      this.shotgunShell(0);
      this.sample('foley-rack', o, 1.0, 1, Math.max(0.15, dur * 0.72));
      return;
    }
    const ok = this.sample(r ? 'foley-mag-out' : 'foley-pistol-out', o, 1, speed ? 1.2 : 1, dur * 0.05);
    if (speed) this.sample('foley-clack', o, 0.55, 1.05, dur * 0.28);
    this.sample(r ? 'foley-mag-in' : 'foley-pistol-in', o, 1, speed ? 1.15 : 1, dur * 0.5);
    this.sample(r ? 'foley-charge' : 'foley-slide', o, 1, speed ? 1.15 : 1, dur * 0.8);
    if (!ok) { this.burst(o, 0.05, 'bandpass', 2400, 1800, 4, 0.4); this.burst(o, 0.06, 'bandpass', 1500, 1100, 4, 0.45, 0.55); this.burst(o, 0.05, 'bandpass', 3000, 2000, 3, 0.5, 1.12); }
  }
  shotgunShell(delay = 0) {
    if (!this.ctx) return;
    const o = this.out(0.18, 0.92, false);
    if (!this.sample('foley-shell', o, 0.95, 0.96 + Math.random() * 0.08, delay)) {
      this.tone(o, 'triangle', 1250, 720, 0.05, 0.5, delay);
    }
  }
  shieldClang(dist = 0, pan = 0) {
    if (!this.ctx) return;
    const o = this.out(pan, Math.max(0.2, 1.15 / (1 + dist * 0.12)), true);
    this.tone(o, 'triangle', 1650 + Math.random() * 250, 780, 0.14, 0.9);
    this.tone(o, 'sine', 2900, 1800, 0.19, 0.45);
    this.burst(o, 0.04, 'highpass', 3600, 2000, 1.5, 0.65);
  }
  breath(intensity = 0.5) {
    if (!this.ctx) return;
    const o = this.out(0, Math.min(0.32, 0.1 + intensity * 0.22), false);
    this.burst(o, 0.28, 'bandpass', 950, 650, 1.4, 0.75, 0);
    this.burst(o, 0.34, 'bandpass', 720, 420, 1.2, 0.6, 0.36);
  }
  sensor(ping = false) {
    if (!this.ctx) return;
    const o = this.out(0, ping ? 0.26 : 0.42, false);
    if (ping) { this.tone(o, 'sine', 1920, 1480, 0.08, 0.55); }
    else { this.sample('foley-latch', o, 0.75, 1.1); this.tone(o, 'sine', 960, 1340, 0.1, 0.4, 0.06); }
  }
  trapDisarm() {
    if (!this.ctx) return;
    const o = this.out(0, 0.55, false);
    this.sample('foley-clack', o, 0.85, 1.15);
    this.tone(o, 'triangle', 1180, 1620, 0.07, 0.4, 0.08);
  }
  bagEvidence() {
    if (!this.ctx) return;
    const o = this.out(0.1, 0.6, false);
    this.sample('foley-latch', o, 0.85, 1.05);
    this.burst(o, 0.08, 'bandpass', 2800, 1900, 2, 0.35, 0.05);
  }
  smokeHiss(dist: number, pan: number) {
    if (!this.ctx) return;
    const o = this.out(pan, Math.max(0.08, 0.75 / (1 + dist * 0.14)));
    this.tone(o, 'triangle', 920, 420, 0.08, 0.35);
    this.burst(o, 1.6, 'bandpass', 3800, 1700, 1.2, 0.55, 0.04);
  }
  /** Playable 911 Dispatch radio briefing with radio squelch, distant siren bed & tactical callout. */
  private dispatchTimer = 0;
  private dispatchSrc?: AudioBufferSourceNode;
  private dispatchOnEnd?: () => void;
  private dispatchSeq = 0;
  playDispatch(mission: number, onEnd?: () => void) {
    this.init();
    this.stopDispatch();
    this.dispatchOnEnd = onEnd;
    const seq = ++this.dispatchSeq;
    const lines = [
      'Dispatch to Team 1: Multiple 911 calls from The Office Complex, Kista Sector. Three to five armed intruders barricaded on the main floor, civilians pinned in cubicles. Proceed with caution.',
      'Dispatch to Team 1: Harbor patrol reports an armed weapons exchange inside The Warehouse. Dock workers trapped near shipping crates. Expect crossfire and locked storage doors.',
      'Dispatch to Team 1: Panic call from Hotel North Star front desk. Armed suspects holding guests across corridor rooms 101 through 108. FiberCam doors before breaching.',
      'Dispatch to Team 1: Silent alarm triggered at Nordia Bank. Armed crew has taken the Bank Director hostage near the vault. Prioritize VIP extraction and non-lethal compliance.',
      'Dispatch to Team 1: Urgent! Anonymous tip confirms an improvised explosive device inside Club Eclipse backstage. Low visibility, panicked civilians on the dancefloor. Move fast.',
      'Dispatch to Team 1: Tactical warrant active for an unmapped compound. Intel indicates armed lookouts and civilians inside. Watch your corners and clear room by room.',
    ];
    const msg = lines[mission % lines.length];
    this.squelch(true);
    if (this.ctx) {
      const o = this.out(0, 0.14, false);
      this.burst(o, 5.5, 'bandpass', 2100, 1900, 1.2, 0.16, 0.05);
      // Distant faint siren wail in dispatch center background
      this.tone(o, 'sine', 640, 880, 1.4, 0.05, 0.4);
      this.tone(o, 'sine', 880, 620, 1.4, 0.05, 1.8);
    }
    // the dispatcher is a recorded voice like every other line (never the browser's robotic speech synthesis)
    const play = () => {
      if (seq !== this.dispatchSeq || !this.dispatchOnEnd) return;
      const ms = this.line(msg, { voice: 'd1', radio: true, onSrc: s => { this.dispatchSrc = s; } });
      this.dispatchTimer = window.setTimeout(() => {
        this.squelch(false);
        this.dispatchTimer = 0;
        this.dispatchSrc = undefined;
        const cb = this.dispatchOnEnd;
        this.dispatchOnEnd = undefined;
        cb?.();
      }, ms || Math.max(4800, msg.length * 64));
    };
    if (this.linesReady) play(); else void this.loadLines().then(play);
  }
  stopDispatch() {
    this.dispatchSeq++;
    if (this.dispatchTimer) {
      clearTimeout(this.dispatchTimer);
      this.dispatchTimer = 0;
    }
    try { this.dispatchSrc?.stop(); } catch { /* already stopped */ }
    this.dispatchSrc = undefined;
    const cb = this.dispatchOnEnd;
    this.dispatchOnEnd = undefined;
    cb?.();
  }
  /** Weapon raised after switching. */
  draw() { if (!this.ctx) return; this.sample('foley-bolt', this.out(0.1, 0.7, false)); }
  step(vol = 0.25, pan = 0) { if (!this.ctx) return; const o = this.out(pan, vol * 4, false); this.burst(o, 0.07, 'lowpass', 500 + Math.random() * 200, 120, 1, 0.9); this.burst(o, 0.03, 'bandpass', 1800, 900, 1.5, 0.25); }
  /** Recorded door: handle and latch, the leaf swinging (sometimes a dry hinge), or the leaf meeting the frame. `kick` = forced open on a breach. */
  door(dist: number, pan: number, open = true, kick = false) {
    if (!this.ctx) return; const near = 1 / (1 + dist * 0.12), o = this.out(pan, (kick ? 1.5 : 1.9) * near), lp = Math.max(1100, 12000 - dist * 650), rate = 0.9 + Math.random() * 0.1, pick = (n: number) => 1 + Math.floor(Math.random() * n);
    if (!this.sfx.has('door-open-1')) { this.tone(o, 'sawtooth', 95, 150, 0.32, 0.06); this.burst(o, 0.12, 'lowpass', 600, 90, 1, 0.45, 0.3); return; }
    if (kick) { this.sample('door-slam', o, 1, 0.72, 0, lp); this.sample('door-close-' + pick(3), o, 0.7, 0.6, 0.015, lp); this.tone(o, 'sine', 82, 34, 0.22, 0.5); this.burst(o, 0.09, 'bandpass', 2200, 700, 0.8, 0.22); this.sample('door-creak-' + pick(2), o, 0.35, 0.9, 0.16, lp); }
    else if (open) { this.sample('door-latch', o, 0.55, rate, 0, lp); this.sample('door-open-' + pick(2), o, 1, rate, 0.07, lp); if (Math.random() < 0.4) this.sample('door-creak-' + pick(2), o, 0.4, 0.72 + Math.random() * 0.15, 0.3, lp); }
    else { if (Math.random() < 0.3) this.sample('door-creak-' + pick(2), o, 0.3, 0.8, 0, lp); this.sample('door-close-' + pick(3), o, 1, rate, 0.22, lp); }
  }
  /** Service-elevator landing chime, sliding doors and the motor between floors. */
  elevator(kind: 'ding' | 'open' | 'close' | 'move' | 'arrive', dist = 2, pan = 0) {
    if (!this.ctx) return;
    const near = 1 / (1 + dist * 0.12), o = this.out(pan, 1.15 * near, false);
    if (kind === 'ding') {
      this.tone(o, 'sine', 1318, 1318, 0.55, 0.3);
      this.tone(o, 'sine', 1046, 1046, 0.7, 0.26, 0.18);
      this.burst(o, 0.05, 'highpass', 5200, 3600, 2, 0.12);
    } else if (kind === 'arrive') {
      // Mechanical stop under the chime: the car settles, then the landing bell rings.
      this.burst(o, 0.3, 'lowpass', 320, 90, 1.2, 0.3);
      this.tone(o, 'sine', 76, 46, 0.3, 0.18);
      this.burst(o, 0.04, 'bandpass', 2600, 1800, 1.6, 0.16, 0.04);
    } else if (kind === 'open') {
      this.burst(o, 0.55, 'lowpass', 1400, 260, 0.8, 0.32);
      this.tone(o, 'triangle', 118, 96, 0.4, 0.08);
    } else if (kind === 'close') {
      this.burst(o, 0.48, 'lowpass', 1100, 180, 0.8, 0.3);
      this.tone(o, 'sine', 82, 58, 0.22, 0.16, 0.32);
      this.burst(o, 0.06, 'bandpass', 2200, 1400, 1.5, 0.16, 0.34);
    } else {
      this.tone(o, 'sawtooth', 54, 47, 3.3, 0.045, 0.05);
      this.tone(o, 'sine', 108, 96, 3.0, 0.03, 0.1);
      this.burst(o, 1.4, 'lowpass', 220, 110, 1.4, 0.05);
    }
  }
  cuff() { if (!this.ctx) return; const o = this.out(0, 2.5, false); for (let i = 0; i < 6; i++) this.burst(o, 0.02, 'bandpass', 3500 + i * 250, 3000, 8, 0.6, i * 0.04); }
  bang(dist: number, pan: number, deaf: number) {
    if (!this.ctx) return; const o = this.out(pan, 1.0 / (1 + dist * 0.06));
    // built from real reports: a shotgun blast slowed down for the body and a distant rifle for the tail
    if (this.sample('shot-m1014-1', o, 1.5, 0.55)) { this.sample('far-sniper', o, 1.2, 0.7, 0.02); this.tone(o, 'sine', 90, 28, 0.35, 0.9); }
    else { this.burst(o, 0.5, 'lowpass', 9000, 120, 0.5, 1.5); this.tone(o, 'sine', 120, 30, 0.4, 1.2); }
    if (deaf > 0.15) { const r = this.out(0, deaf * 0.08, false); this.tone(r, 'sine', 3900, 3850, 3 + deaf * 3, 1); } // ringing ears: audible, never painful
  }
  hurt() { if (!this.ctx) return; const o = this.out(0, 0.7, false); this.tone(o, 'sine', 140, 50, 0.18, 1); this.burst(o, 0.08, 'lowpass', 900, 200, 1, 0.6); }
  hitmark(head: boolean, kill = false) {
    if (!this.ctx) return;
    const o = this.out(0, head ? 0.38 : 0.28, false);
    this.tone(o, 'triangle', head ? 1850 : 980, head ? 1250 : 680, 0.045, 0.85);
    if (head) {
      this.tone(o, 'sine', 2600, 1950, 0.06, 0.55, 0.015);
      this.burst(o, 0.025, 'highpass', 3200, 2200, 2, 0.4);
    }
    if (kill) this.tone(o, 'sine', 190, 65, 0.085, 0.65, 0.02);
  }
  impact(dist: number, pan: number) { if (!this.ctx) return; const o = this.out(pan, 1.2 / (1 + dist * 0.2)); this.burst(o, 0.05, 'bandpass', 2600 + Math.random() * 1500, 900, 2, 0.8); }
  radio() { if (!this.ctx) return; const o = this.out(0, 0.3, false); this.tone(o, 'square', 1250, 1250, 0.045, 0.4); this.burst(o, 0.09, 'bandpass', 2200, 2000, 1.5, 0.35, 0.05); }
  radioSquelch(delay = 0.45) { if (!this.ctx) return; const o = this.out(0, 0.22, false); this.burst(o, 0.06, 'bandpass', 2500, 1900, 1.8, 0.45, delay); this.tone(o, 'sine', 1680, 1180, 0.04, 0.35, delay + 0.03); }
  phoneRing(dist: number, pan: number) {
    if (!this.ctx) return;
    const att = Math.max(0.08, 0.65 / (1 + dist * 0.22));
    const o = this.out(pan, att, true);
    for (const off of [0, 0.18]) {
      this.tone(o, 'sine', 1220, 1220, 0.14, 0.35, off);
      this.tone(o, 'sine', 1540, 1540, 0.14, 0.28, off);
    }
  }
  clubPulse(dist: number, pan: number, muffled = true) {
    if (!this.ctx) return;
    const att = Math.max(0.04, (muffled ? 0.36 : 0.72) / (1 + dist * 0.1));
    const o = this.out(pan, att, !muffled);
    this.tone(o, 'sine', 96, 44, 0.19, 0.85);
    if (!muffled) this.burst(o, 0.04, 'bandpass', 1400, 900, 2, 0.16, 0.12);
  }
  heartbeat(intensity = 0.5) {
    if (!this.ctx) return;
    const o = this.out(0, Math.min(0.65, 0.22 + intensity * 0.4), false);
    this.tone(o, 'sine', 62, 36, 0.12, 0.8, 0);
    this.tone(o, 'sine', 56, 32, 0.14, 0.6, 0.18);
  }
  ui() { if (!this.ctx) return; const o = this.out(0, 0.25, false); this.tone(o, 'triangle', 700, 900, 0.05, 0.5); }
  ok() { if (!this.ctx) return; const o = this.out(0, 0.25, false); this.tone(o, 'triangle', 660, 660, 0.07, 0.5); this.tone(o, 'triangle', 990, 990, 0.1, 0.5, 0.08); }
  fail() { if (!this.ctx) return; const o = this.out(0, 0.25, false); this.tone(o, 'sawtooth', 220, 150, 0.2, 0.4); }
  glass(dist: number, pan: number) { if (!this.ctx) return; const o = this.out(pan, 1.4 / (1 + dist * 0.15)); this.burst(o, 0.18, 'highpass', 3200, 1800, 1.5, 0.9); this.tone(o, 'sine', 2400, 1600, 0.09, 0.3); }
  taser(dist: number, pan: number) { if (!this.ctx) return; const o = this.out(pan, 1.2 / (1 + dist * 0.15)); this.tone(o, 'sawtooth', 180, 95, 0.24, 0.55); this.burst(o, 0.22, 'bandpass', 4200, 2600, 3, 0.5); }
  nvg(on: boolean) { if (!this.ctx) return; const o = this.out(0, 0.28, false); this.tone(o, 'sine', on ? 420 : 1200, on ? 1800 : 380, 0.14, 0.6); }
  wedge() { if (!this.ctx) return; const o = this.out(0, 0.35, false); this.tone(o, 'triangle', 260, 140, 0.08, 0.6); }
  c2(dist: number, pan: number) { if (!this.ctx) return; const o = this.out(pan, 2.2 / (1 + dist * 0.1)); this.burst(o, 0.45, 'lowpass', 2400, 90, 0.6, 1.6); this.tone(o, 'sine', 110, 28, 0.42, 1.3); }
  defuse() { if (!this.ctx) return; const o = this.out(0, 0.35, false); this.tone(o, 'sine', 520, 520, 0.08, 0.6); this.tone(o, 'sine', 880, 1040, 0.14, 0.6, 0.1); }
  ping(hostile = false) {
    if (!this.ctx) return;
    const o = this.out(0, 0.25, false);
    this.tone(o, 'sine', hostile ? 980 : 1240, hostile ? 760 : 1560, 0.09, 0.55);
  }
  squelch(start: boolean) {
    if (!this.ctx) return;
    const o = this.out(0, 0.14, false);
    this.burst(o, 0.035, 'bandpass', start ? 2600 : 1900, 1600, 1.8, 0.5);
    this.tone(o, 'sine', start ? 1420 : 1080, start ? 1580 : 860, 0.025, 0.3);
  }
}

/** Timing for the recorded radio voice lines. Every spoken line is a recorded human-like clip, so nothing here ever uses the browser's robotic speech synthesis. */
export class Speech {
  private until = 0;
  /** True while the team is (estimated to be) talking. Uses our own timer, so a stuck browser voice cannot block voice commands. */
  get speaking() { return performance.now() < this.until; }
  /** A recorded clip is playing for ms milliseconds (keeps `speaking` correct). */
  busy(ms: number) { this.until = Math.max(this.until, performance.now() + ms); }
  stop() { this.until = 0; }
}
