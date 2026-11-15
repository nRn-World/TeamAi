// Online co-op over WebRTC (PeerJS, MIT). No game server needed: one player hosts, the others join with a room code.
// Signalling uses the free public PeerJS broker; voice chat is a direct WebRTC audio mesh with spatial proximity + tactical radio filtering.
import Peer, { DataConnection, MediaConnection } from 'peerjs';

const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789', PREFIX = 'teamai-room-';
export type Msg = { t: string;[k: string]: any };

interface PeerAudioNode {
  audio: HTMLAudioElement;
  ctx?: AudioContext;
  src?: MediaStreamAudioSourceNode;
  analyser?: AnalyserNode;
  hp?: BiquadFilterNode;
  lp?: BiquadFilterNode;
  panner?: StereoPannerNode;
  gain?: GainNode;
  data?: Uint8Array;
  speaking: boolean;
  radio: boolean;
}

export class Net {
  role: 'solo' | 'host' | 'client' = 'solo'; code = ''; peer: Peer | null = null; conns: DataConnection[] = []; hostConn: DataConnection | null = null;
  onMsg: (from: DataConnection, m: Msg) => void = () => { }; onPeers: () => void = () => { }; onClosed: (why: string) => void = () => { };
  onRadioSquelch: (start: boolean) => void = () => { };
  stream: MediaStream | null = null; micOk = false; muted = false; onVoice: () => void = () => { }; private voiceP: Promise<void> | null = null; private calls = new Map<string, MediaConnection>();
  private audios = new Map<string, PeerAudioNode>();
  private audioCtx: AudioContext | null = null;
  private localAnalyser: AnalyserNode | null = null;
  private localData: Uint8Array | null = null;
  private localSpeaking = false;

  get id() { return this.peer?.id ?? ''; }
  get online() { return this.role !== 'solo'; }
  private ensureAudioCtx() {
    if (!this.audioCtx) {
      const AC = window.AudioContext || (window as any).webkitAudioContext;
      if (AC) this.audioCtx = new AC();
    }
    if (this.audioCtx?.state === 'suspended') this.audioCtx.resume().catch(() => { });
    return this.audioCtx;
  }
  private opts() {
    const q = new URLSearchParams(location.search), h = q.get('peerhost');
    return h ? { host: h, port: +(q.get('peerport') || 9000), path: '/', secure: false, debug: 1 } : { debug: 1 };
  }
  private open(id?: string) {
    return new Promise<Peer>((res, rej) => {
      const p = id ? new Peer(id, this.opts()) : new Peer(this.opts()); let done = false;
      const to = setTimeout(() => { if (!done) { done = true; p.destroy(); rej(new Error('timeout')); } }, 15000);
      p.on('open', () => { if (done) return; done = true; clearTimeout(to); res(p); });
      p.on('error', (e: any) => { if (!done) { done = true; clearTimeout(to); p.destroy(); rej(e); } else if (e?.type === 'network' || e?.type === 'server-error') this.onClosed('Lost the connection to the matchmaking server.'); });
    });
  }
  /** Microphone for voice chat. Never blocks room creation: runs in the background, and falls back to a
   *  silent stream (listen-only) if the microphone is denied or the permission prompt is left unanswered. */
  private voice(): Promise<void> {
    if (this.voiceP) return this.voiceP;
    const silent = () => { const AC = window.AudioContext || (window as any).webkitAudioContext; return new AC().createMediaStreamDestination().stream as MediaStream; };
    return this.voiceP = new Promise<void>(res => {
      let settled = false;
      const finish = (st: MediaStream, ok: boolean) => {
        if (settled) { if (ok) st.getTracks().forEach(t => t.stop()); return; }
        settled = true; this.stream = st; this.micOk = ok; this.setMuted(this.muted);
        if (ok) {
          try {
            const ctx = this.ensureAudioCtx();
            if (ctx) {
              const src = ctx.createMediaStreamSource(st);
              const an = ctx.createAnalyser();
              an.fftSize = 256;
              src.connect(an);
              this.localAnalyser = an;
              this.localData = new Uint8Array(an.frequencyBinCount);
            }
          } catch { /* ignore */ }
        }
        this.onVoice(); res();
      };
      const to = setTimeout(() => finish(silent(), false), 20000);
      if (!navigator.mediaDevices?.getUserMedia) { clearTimeout(to); finish(silent(), false); return; }
      navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
        .then(st => { clearTimeout(to); finish(st, true); }).catch(() => { clearTimeout(to); finish(silent(), false); });
    });
  }
  private setupPeerAudio(peerId: string, s: MediaStream) {
    let node = this.audios.get(peerId);
    if (!node) {
      const a = new Audio(); a.autoplay = true;
      node = { audio: a, speaking: false, radio: false };
      this.audios.set(peerId, node);
    }
    node.audio.srcObject = s;
    try {
      const ctx = this.ensureAudioCtx();
      if (ctx && !node.src) {
        const src = ctx.createMediaStreamSource(s);
        const an = ctx.createAnalyser(); an.fftSize = 256;
        const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 40;
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 18000;
        const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : undefined;
        const gain = ctx.createGain(); gain.gain.value = 1;
        src.connect(an);
        an.connect(hp);
        hp.connect(lp);
        if (panner) { lp.connect(panner); panner.connect(gain); }
        else lp.connect(gain);
        gain.connect(ctx.destination);
        node.ctx = ctx; node.src = src; node.analyser = an; node.hp = hp; node.lp = lp; node.panner = panner; node.gain = gain;
        node.data = new Uint8Array(an.frequencyBinCount);
        node.audio.muted = true; // Output handled by spatial WebAudio graph
      }
    } catch {
      node.audio.muted = false;
    }
    node.audio.play().catch(() => { });
  }
  private hookCalls() {
    this.peer!.on('call', call => { this.voice().then(() => { call.answer(this.stream!); this.track(call); }); });
  }
  private track(call: MediaConnection) {
    this.calls.set(call.peer, call);
    call.on('stream', s => this.setupPeerAudio(call.peer, s));
    const drop = () => {
      this.calls.delete(call.peer);
      const a = this.audios.get(call.peer);
      if (a) {
        a.audio.srcObject = null;
        try { a.src?.disconnect(); a.gain?.disconnect(); } catch { /* ignore */ }
        this.audios.delete(call.peer);
      }
    };
    call.on('close', drop); call.on('error', drop);
  }
  /** Everyone gets the full id list; the peer with the smaller id places the call, so each pair connects exactly once. */
  callPeers(ids: string[]) { this.voice().then(() => { if (!this.peer || !this.stream) return; for (const id of ids) if (id !== this.id && !this.calls.has(id) && this.id < id) this.track(this.peer.call(id, this.stream)); }); }
  get voiceCount() { return this.audios.size; }
  setMuted(m: boolean) { this.muted = m; this.stream?.getAudioTracks().forEach(t => { t.enabled = !m; }); if (m) this.localSpeaking = false; }

  /** Update spatial proximity & tactical radio bandpass filter for a peer. */
  updatePeerSpatial(peerId: string, distance: number, pan: number, sameRoom: boolean) {
    const node = this.audios.get(peerId);
    if (!node || !node.gain || !node.hp || !node.lp) return;
    const radioMode = distance > 8.5 || !sameRoom;
    node.radio = radioMode;
    const now = node.ctx ? node.ctx.currentTime : 0;
    if (radioMode) {
      node.hp.frequency.setTargetAtTime(380, now, 0.04);
      node.lp.frequency.setTargetAtTime(2500, now, 0.04);
      node.gain.gain.setTargetAtTime(0.72, now, 0.05);
      if (node.panner) node.panner.pan.setTargetAtTime(Math.max(-0.3, Math.min(0.3, pan * 0.25)), now, 0.05);
    } else {
      node.hp.frequency.setTargetAtTime(45, now, 0.04);
      node.lp.frequency.setTargetAtTime(17500, now, 0.04);
      const att = Math.max(0.28, 1 - distance / 12);
      node.gain.gain.setTargetAtTime(att, now, 0.05);
      if (node.panner) node.panner.pan.setTargetAtTime(Math.max(-0.95, Math.min(0.95, pan)), now, 0.05);
    }
  }

  /** Sample microphone/peer audio levels to detect live speaking state. */
  sampleSpeaking(): { local: boolean; peers: Record<string, boolean> } {
    let local = false;
    if (!this.muted && this.micOk && this.localAnalyser && this.localData) {
      this.localAnalyser.getByteTimeDomainData(this.localData as Uint8Array<ArrayBuffer>);
      let sum = 0;
      for (let i = 0; i < this.localData.length; i++) { const d = (this.localData[i] - 128) / 128; sum += d * d; }
      local = Math.sqrt(sum / this.localData.length) > 0.024;
    }
    this.localSpeaking = local;
    const peers: Record<string, boolean> = {};
    for (const [id, node] of this.audios) {
      let sp = false;
      if (node.analyser && node.data) {
        node.analyser.getByteTimeDomainData(node.data as Uint8Array<ArrayBuffer>);
        let sum = 0;
        for (let i = 0; i < node.data.length; i++) { const d = (node.data[i] - 128) / 128; sum += d * d; }
        sp = Math.sqrt(sum / node.data.length) > 0.022;
      }
      if (sp !== node.speaking && node.radio) this.onRadioSquelch(sp);
      node.speaking = sp;
      peers[id] = sp;
    }
    return { local, peers };
  }
  isLocalSpeaking() { return this.localSpeaking; }
  isPeerSpeaking(id: string) { return !!this.audios.get(id)?.speaking; }

  async host() {
    this.close(); void this.voice();
    for (let attempt = 0; ; attempt++) {
      const code = Array.from({ length: 5 }, () => ALPHA[Math.floor(Math.random() * ALPHA.length)]).join('');
      try { this.peer = await this.open(PREFIX + code); this.code = code; break; }
      catch (e: any) { if (attempt >= 2) throw e; if (e?.type !== 'unavailable-id') await new Promise(r => setTimeout(r, 1200)); }
    }
    this.role = 'host'; this.hookCalls();
    this.peer!.on('connection', c => {
      c.on('open', () => { this.conns.push(c); this.onPeers(); });
      c.on('data', d => this.onMsg(c, d as Msg));
      const gone = () => { const i = this.conns.indexOf(c); if (i >= 0) { this.conns.splice(i, 1); this.onPeers(); } };
      c.on('close', gone); c.on('error', gone);
    });
  }
  async join(code: string) {
    this.close(); void this.voice();
    try { this.peer = await this.open(); } catch { await new Promise(r => setTimeout(r, 1200)); this.peer = await this.open(); }
    this.hookCalls(); this.code = code.toUpperCase().trim();
    const c = this.peer.connect(PREFIX + this.code, { reliable: true });
    await new Promise<void>((res, rej) => {
      const to = setTimeout(() => rej(new Error('No room found with that code.')), 12000);
      c.on('open', () => { clearTimeout(to); res(); }); c.on('error', e => { clearTimeout(to); rej(e); });
      this.peer!.on('error', (e: any) => { if (e?.type === 'peer-unavailable') { clearTimeout(to); rej(new Error('No room found with that code.')); } });
    });
    this.hostConn = c; this.role = 'client';
    c.on('data', d => this.onMsg(c, d as Msg)); c.on('close', () => { if (this.role === 'client') this.onClosed('The host left the game.'); });
  }
  send(m: Msg) { if (this.hostConn?.open) this.hostConn.send(m); }
  broadcast(m: Msg) { for (const c of this.conns) if (c.open) c.send(m); }
  close() {
    this.role = 'solo'; for (const c of this.calls.values()) c.close(); this.calls.clear();
    for (const a of this.audios.values()) {
      a.audio.srcObject = null;
      try { a.src?.disconnect(); a.gain?.disconnect(); } catch { /* ignore */ }
    }
    this.audios.clear();
    this.conns = []; this.hostConn = null; this.code = ''; try { this.peer?.destroy(); } catch { /* ignore */ } this.peer = null;
  }
}
