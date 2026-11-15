// Microphone orders recognised on the player's own computer (Whisper in src/ai/asr.worker.ts) instead of the browser's
// cloud speech service. Same surface as game/voice.ts so the game can use either one.
import type { VoiceState } from '../game/voice';

const RATE = 16000, PRE = 0.35, TAIL = 250, MIN = 0.3, MAX = 14;
/** What Whisper tends to write when it was given silence or noise. */
const NOISE = /^(you|thank you|thanks|thanks for watching|bye|okay|ok|so|the|uh|um|hmm|tack|tack för att ni tittade)?$/;

export class LocalVoice {
  state: VoiceState = 'off'; lang = 'en'; ptt = false; held = false; lastHeard = ''; lastError = '';
  onFinal: (text: string) => void = () => { }; onInterim: (text: string) => void = () => { }; onIgnored: (text: string) => void = () => { }; onState: (s: VoiceState, detail?: string) => void = () => { };
  /** Something the player should know that is not an order: «heard nothing», the model failed, … */
  onNote: (text: string) => void = () => { }; /** Model could not be loaded at all – the game may fall back to the browser service. */ onFail: (msg: string) => void = () => { };
  progress = 0; sizeMb = 0; device = ''; modelReady = false; lastMs = 0; failed = false;
  private worker: Worker | null = null; private want = false; private stream: MediaStream | null = null; private ctx: AudioContext | null = null; private node: ScriptProcessorNode | null = null; private micBusy = false;
  private pre: Float32Array[] = []; private preLen = 0; private rec: Float32Array[] | null = null; private recLen = 0; private tail = 0; private id = 0; private pending = 0;
  private floor = 0.01; private quiet = 0; private vad = false;
  static get supported() { return !!navigator.mediaDevices?.getUserMedia && typeof Worker !== 'undefined' && !!(window.AudioContext || (window as any).webkitAudioContext); }
  private set(s: VoiceState, d?: string) { this.state = s; this.onState(s, d); }
  private sync() { if (!this.want) return; if (this.failed) this.set('error', 'modelfail'); else if (!this.stream) { if (this.state !== 'denied' && this.state !== 'error') this.set('starting'); } else this.set(this.modelReady ? 'listening' : 'starting', this.modelReady ? undefined : 'model'); }

  /** Starts downloading/compiling the model without touching the microphone. */
  preload() {
    if (this.worker || this.failed) return;
    const w = this.worker = new Worker(new URL('./asr.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = e => {
      const m = e.data;
      if (m.t === 'progress') { this.progress = m.p; this.sizeMb = m.mb; if (this.want && !this.modelReady) this.sync(); }
      else if (m.t === 'ready') { this.modelReady = true; this.device = m.device; this.progress = 1; this.sync(); }
      else if (m.t === 'text') { this.pending = Math.max(0, this.pending - 1); this.lastMs = m.ms; this.result(String(m.text)); }
      else if (m.t === 'error') {
        this.pending = 0; this.lastError = m.msg;
        if (!this.modelReady) { this.failed = true; w.terminate(); this.worker = null; this.sync(); this.onFail(m.msg); } else this.onNote('Speech model error – say it again');
      }
    };
    w.onerror = e => { this.lastError = e.message || 'worker failed'; if (!this.modelReady) { this.failed = true; this.worker = null; this.sync(); this.onFail(this.lastError); } };
    w.postMessage({ t: 'load' });
  }
  start() {
    this.want = true; this.preload();
    if (this.stream || this.micBusy) { this.sync(); return; }
    const fp = (document as any).featurePolicy ?? (document as any).permissionsPolicy;
    if (window.top !== window.self && fp?.allowsFeature && !fp.allowsFeature('microphone')) { this.want = false; this.set('denied', 'iframe'); return; }
    this.micBusy = true; this.set('starting', this.modelReady ? undefined : 'model');
    navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } }).then(st => {
      this.micBusy = false; if (!this.want) { st.getTracks().forEach(t => t.stop()); return; }
      this.stream = st; const AC = window.AudioContext || (window as any).webkitAudioContext, ctx = this.ctx = new AC() as AudioContext; void ctx.resume();
      const src = ctx.createMediaStreamSource(st), node = this.node = ctx.createScriptProcessor(2048, 1, 1), mute = ctx.createGain(); mute.gain.value = 0;
      node.onaudioprocess = ev => this.chunk(new Float32Array(ev.inputBuffer.getChannelData(0)));
      src.connect(node); node.connect(mute); mute.connect(ctx.destination); // a processor only runs while it leads to the output
      st.getAudioTracks()[0]?.addEventListener('ended', () => { if (this.stream === st) { this.close(); if (this.want) this.set('error', 'busy'); } });
      this.sync();
    }).catch((e: any) => {
      this.micBusy = false; this.want = false;
      if (e?.name === 'NotFoundError' || e?.name === 'OverconstrainedError') this.set('error', 'nomic');
      else if (e?.name === 'NotReadableError') this.set('error', 'busy');
      else this.set('denied', window.top !== window.self ? 'iframe' : 'mic');
    });
  }
  private close() { this.stream?.getTracks().forEach(t => t.stop()); this.stream = null; try { this.node?.disconnect(); } catch { /* already gone */ } this.node = null; void this.ctx?.close().catch(() => { }); this.ctx = null; this.rec = null; this.pre = []; this.preLen = 0; this.vad = false; clearTimeout(this.tail); }
  stop() { this.want = false; this.held = false; this.close(); this.set('off'); }
  setLang(l: string) { this.lang = l; }

  press() { if (this.held) return; this.held = true; clearTimeout(this.tail); if (!this.rec) { this.rec = this.pre.slice(); this.recLen = this.preLen; } this.vad = false; this.onState(this.state); }
  release() { if (!this.held) return; this.held = false; this.onState(this.state); clearTimeout(this.tail); this.tail = window.setTimeout(() => this.finish(), TAIL); } // the last syllable is often still on its way

  private chunk(c: Float32Array) {
    const sr = this.ctx?.sampleRate ?? 48000;
    this.pre.push(c); this.preLen += c.length; while (this.preLen - this.pre[0].length > PRE * sr) this.preLen -= this.pre.shift()!.length;
    if (this.rec) { this.rec.push(c); this.recLen += c.length; if (this.recLen > MAX * sr) { this.held = false; this.finish(); return; } }
    if (this.ptt || this.held) return;
    // always-on mode: cut the stream into utterances by loudness
    let s = 0; for (let i = 0; i < c.length; i++) s += c[i] * c[i]; const rms = Math.sqrt(s / c.length), loud = rms > Math.max(0.012, this.floor * 3.2);
    if (!this.vad) { this.floor += (rms - this.floor) * (rms < this.floor ? 0.3 : 0.02); if (loud) { this.vad = true; this.quiet = 0; this.rec = this.pre.slice(); this.recLen = this.preLen; } }
    else { this.quiet = loud ? 0 : this.quiet + c.length / sr; if (this.quiet > 0.75) { this.vad = false; this.finish(); } }
  }
  private finish() {
    const rec = this.rec, n = this.recLen, sr = this.ctx?.sampleRate ?? 48000; this.rec = null; this.recLen = 0; this.vad = false;
    if (!rec || n < MIN * sr) { if (this.ptt && rec) this.onNote('Too short – hold V while you speak'); return; }
    const all = new Float32Array(n); let o = 0, peak = 0; for (const c of rec) { all.set(c, o); o += c.length; }
    // down to 16 kHz by averaging each window (a crude low-pass, plenty for speech)
    const step = sr / RATE, out = new Float32Array(Math.floor(n / step));
    for (let i = 0; i < out.length; i++) { const a = Math.floor(i * step), b = Math.max(a + 1, Math.floor((i + 1) * step)); let s = 0; for (let k = a; k < b; k++) s += all[k]; out[i] = s / (b - a); if (Math.abs(out[i]) > peak) peak = Math.abs(out[i]); }
    if (peak < 0.006) { if (this.ptt) this.onNote('The microphone was silent – check that the right microphone is selected'); return; }
    if (peak < 0.5) { const g = Math.min(8, 0.5 / peak); for (let i = 0; i < out.length; i++) out[i] *= g; }
    if (!this.worker || !this.modelReady) { this.onNote(this.failed ? 'The speech model could not be loaded' : `Speech model still loading (${Math.round(this.progress * 100)} %) – say it again in a moment`); return; }
    if (this.pending > 1) return; // do not queue up behind a slow computer
    this.pending++; this.onInterim('…'); this.worker.postMessage({ t: 'run', id: ++this.id, pcm: out, lang: this.lang }, [out.buffer]);
  }
  private result(raw: string) {
    const text = raw.replace(/\[[^\]]*\]|\([^)]*\)|♪/g, ' ').replace(/\s+/g, ' ').trim();
    if (NOISE.test(text.toLowerCase().replace(/[^\p{L} ]/gu, '').trim())) { if (this.ptt) this.onNote('No words heard'); return; }
    this.lastHeard = text; this.onFinal(text);
  }
}
