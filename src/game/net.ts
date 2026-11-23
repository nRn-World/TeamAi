// Online co-op over WebRTC (PeerJS, MIT). No game server needed: one player hosts, the others join with a room code.
// Signalling uses the free public PeerJS broker; voice chat is a direct WebRTC audio mesh with spatial proximity + tactical radio filtering.
import Peer, { DataConnection, MediaConnection } from 'peerjs';
import { consumePeerBytes, consumePeerMessageToken, normalizePeerEnvelopeWithSize, type PeerReceiveBudget } from './netprotocol';

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
  stream: MediaStream | null = null; micOk = false; muted = false; onVoice: () => void = () => { }; private voiceP: Promise<void> | null = null; private voiceTimer: ReturnType<typeof setTimeout> | null = null; private voiceCancel: (() => void) | null = null; private calls = new Map<string, MediaConnection>();
  private audios = new Map<string, PeerAudioNode>();
  private audioCtx: AudioContext | null = null;
  private localSource: MediaStreamAudioSourceNode | null = null;
  private localAnalyser: AnalyserNode | null = null;
  private localData: Uint8Array | null = null;
  private localSpeaking = false;
  private lifecycle = 0;
  private opening = new Map<Peer, () => void>();
  private pendingHostConns = new Set<DataConnection>();
  private joinCancel: (() => void) | null = null;
  private receiveBudgets = new WeakMap<DataConnection, PeerReceiveBudget>();

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
    const generation = this.lifecycle;
    return new Promise<Peer>((res, rej) => {
      const p = id ? new Peer(id, this.opts()) : new Peer(this.opts()); let done = false, opened = false;
      const cleanup = () => { clearTimeout(to); this.opening.delete(p); };
      const fail = (e: unknown) => {
        if (done) return;
        done = true; cleanup(); p.destroy(); rej(e);
      };
      const cancel = () => {
        if (done) return;
        done = true; cleanup(); p.destroy(); rej(new Error('closed'));
      };
      const to = setTimeout(() => fail(new Error('timeout')), 15000);
      this.opening.set(p, cancel);
      p.on('open', () => {
        if (done) return;
        done = true; opened = true; cleanup();
        if (generation !== this.lifecycle) { p.destroy(); rej(new Error('closed')); return; }
        res(p);
      });
      p.on('error', (e: any) => {
        if (!done) fail(e);
        else if (opened && generation === this.lifecycle && (e?.type === 'network' || e?.type === 'server-error')) this.onClosed('Lost the connection to the matchmaking server.');
      });
    });
  }
  private receive(c: DataConnection, data: unknown) {
    const live = this.role === 'host'
      ? this.conns.includes(c) || this.pendingHostConns.has(c)
      : this.role === 'client' && this.hostConn === c;
    if (!live) return; // queued events from a closed/replaced channel must not reach the current game
    let budget = this.receiveBudgets.get(c);
    if (!budget) {
      budget = { messages: 120, bytes: 32 * 1024 * 1024, updatedAt: performance.now() };
      this.receiveBudgets.set(c, budget);
    }
    const now = performance.now();
    if (!consumePeerMessageToken(budget, now)) return;
    const envelope = normalizePeerEnvelopeWithSize(data);
    if (!envelope || !consumePeerBytes(budget, envelope.bytes, now)) return;
    if (envelope.message) this.onMsg(c, envelope.message);
  }
  private listenData(c: DataConnection) { c.on('data', d => this.receive(c, d)); }
  /** Microphone for voice chat. Never blocks room creation: runs in the background, and falls back to a
   *  silent stream (listen-only) if the microphone is denied or the permission prompt is left unanswered. */
  private voice(): Promise<void> {
    if (this.voiceP) return this.voiceP;
    const generation = this.lifecycle;
    return this.voiceP = new Promise<void>(res => {
      let settled = false;
      let cancelVoice: (() => void) | null = null;
      const silent = (): MediaStream | null => {
        try {
          const destination = this.ensureAudioCtx()?.createMediaStreamDestination();
          if (destination) return destination.stream;
        } catch { /* fall through to an empty stream when Web Audio is unavailable */ }
        try { return typeof MediaStream === 'undefined' ? null : new MediaStream(); }
        catch { return null; }
      };
      const finish = (stream: MediaStream | null, ok: boolean) => {
        if (settled) { stream?.getTracks().forEach(t => t.stop()); return; }
        settled = true;
        if (this.voiceTimer) clearTimeout(this.voiceTimer);
        this.voiceTimer = null;
        if (this.voiceCancel === cancelVoice) this.voiceCancel = null;
        if (generation !== this.lifecycle) { stream?.getTracks().forEach(t => t.stop()); res(); return; }
        const st = stream ?? silent();
        this.stream = st; this.micOk = ok; this.setMuted(this.muted);
        if (ok && st) {
          try {
            const ctx = this.ensureAudioCtx();
            if (ctx) {
              const src = this.localSource = ctx.createMediaStreamSource(st);
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
      cancelVoice = () => finish(null, false);
      this.voiceCancel = cancelVoice;
      this.voiceTimer = setTimeout(() => finish(null, false), 20000);
      if (!navigator.mediaDevices?.getUserMedia) { finish(null, false); return; }
      navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
        .then(st => finish(st, true)).catch(() => finish(null, false));
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
    const generation = this.lifecycle;
    this.peer!.on('call', call => {
      void this.voice().then(() => {
        if (generation !== this.lifecycle || !this.peer || !this.stream) { call.close(); return; }
        call.answer(this.stream); this.track(call);
      });
    });
  }
  private track(call: MediaConnection) {
    const generation = this.lifecycle;
    this.calls.set(call.peer, call);
    call.on('stream', s => { if (generation === this.lifecycle && this.calls.get(call.peer) === call) this.setupPeerAudio(call.peer, s); });
    const drop = () => {
      if (this.calls.get(call.peer) !== call) return;
      this.calls.delete(call.peer);
      const a = this.audios.get(call.peer);
      if (a) {
        a.audio.srcObject = null; a.audio.pause();
        try { a.src?.disconnect(); a.analyser?.disconnect(); a.hp?.disconnect(); a.lp?.disconnect(); a.panner?.disconnect(); a.gain?.disconnect(); } catch { /* ignore */ }
        this.audios.delete(call.peer);
      }
    };
    call.on('close', drop); call.on('error', drop);
  }
  /** Everyone gets the full id list; the peer with the smaller id places the call, so each pair connects exactly once. */
  callPeers(ids: string[]) {
    const generation = this.lifecycle;
    void this.voice().then(() => {
      if (generation !== this.lifecycle || !this.peer || !this.stream) return;
      for (const id of ids) if (id !== this.id && !this.calls.has(id) && this.id < id) this.track(this.peer.call(id, this.stream));
    });
  }
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
    this.close(); const generation = this.lifecycle; void this.voice();
    try {
      for (let attempt = 0; ; attempt++) {
        const code = Array.from({ length: 5 }, () => ALPHA[Math.floor(Math.random() * ALPHA.length)]).join('');
        try {
          const peer = await this.open(PREFIX + code);
          if (generation !== this.lifecycle) { peer.destroy(); throw new Error('closed'); }
          this.peer = peer; this.code = code; break;
        } catch (e: any) {
          if (generation !== this.lifecycle) throw e;
          if (attempt >= 2) throw e;
          if (e?.type !== 'unavailable-id') await new Promise(r => setTimeout(r, 1200));
          if (generation !== this.lifecycle) throw new Error('closed');
        }
      }
      this.role = 'host'; this.hookCalls();
      this.peer!.on('connection', c => {
        if (this.conns.length + this.pendingHostConns.size >= 3) { c.close(); return; }
        const connectionGeneration = this.lifecycle;
        let retired = false;
        this.pendingHostConns.add(c);
        this.listenData(c);
        c.on('open', () => {
          this.pendingHostConns.delete(c);
          if (retired || connectionGeneration !== this.lifecycle || this.role !== 'host') { c.close(); return; }
          this.conns.push(c); this.onPeers();
        });
        const gone = () => {
          if (retired) return;
          retired = true;
          this.pendingHostConns.delete(c);
          const i = this.conns.indexOf(c);
          if (i >= 0) { this.conns.splice(i, 1); this.onPeers(); }
        };
        c.on('close', gone); c.on('error', () => { gone(); c.close(); });
      });
    } catch (e) {
      if (generation === this.lifecycle) this.close();
      throw e;
    }
  }
  async join(code: string) {
    const roomCode = String(code).toUpperCase().trim();
    if (roomCode.length !== 5 || [...roomCode].some(ch => !ALPHA.includes(ch))) throw new Error('Enter a valid 5-character room code.');
    this.close(); const generation = this.lifecycle; void this.voice();
    try {
      try { this.peer = await this.open(); }
      catch (first) {
        if (generation !== this.lifecycle) throw first;
        await new Promise(r => setTimeout(r, 1200));
        if (generation !== this.lifecycle) throw new Error('closed');
        this.peer = await this.open();
      }
      if (generation !== this.lifecycle || !this.peer) throw new Error('closed');
      this.hookCalls(); this.code = roomCode;
      const peer = this.peer, c = peer.connect(PREFIX + roomCode, { reliable: true });
      try {
        await new Promise<void>((res, rej) => {
          let settled = false;
          let to: ReturnType<typeof setTimeout>;
          const finish = (err?: Error) => {
            if (settled) return;
            settled = true; clearTimeout(to);
            if (this.joinCancel === cancelJoin) this.joinCancel = null;
            if (err) rej(err); else res();
          };
          const cancelJoin = () => finish(new Error('closed'));
          this.joinCancel = cancelJoin;
          to = setTimeout(() => finish(new Error('No room found with that code.')), 12000);
          c.on('open', () => finish()); c.on('error', e => finish(e)); c.on('close', () => finish(new Error('The host left the game.')));
          peer.on('error', (e: any) => { if (e?.type === 'peer-unavailable') finish(new Error('No room found with that code.')); });
        });
      } catch (e) {
        if (generation === this.lifecycle) this.close();
        throw e;
      }
      if (generation !== this.lifecycle || this.peer !== peer) { c.close(); throw new Error('closed'); }
      if (!c.open) { c.close(); throw new Error('The host left the game.'); }
      this.hostConn = c; this.role = 'client';
      this.listenData(c);
      let disconnectNotified = false;
      const disconnected = (why: string) => {
        if (disconnectNotified || this.role !== 'client' || this.hostConn !== c) return;
        disconnectNotified = true; this.onClosed(why);
      };
      c.on('close', () => disconnected('The host left the game.'));
      c.on('error', () => disconnected('The connection to the host failed.'));
    } catch (e) {
      if (generation === this.lifecycle) this.close();
      throw e;
    }
  }
  send(m: Msg) { if (this.hostConn?.open) this.hostConn.send(m); }
  broadcast(m: Msg) { for (const c of this.conns) if (c.open) c.send(m); }
  close() {
    this.lifecycle++;
    this.role = 'solo';
    this.joinCancel?.(); this.joinCancel = null;
    this.voiceCancel?.(); this.voiceCancel = null;
    if (this.voiceTimer) clearTimeout(this.voiceTimer);
    this.voiceTimer = null; this.voiceP = null;
    for (const cancel of [...this.opening.values()]) cancel();
    for (const c of this.calls.values()) c.close(); this.calls.clear();
    for (const a of this.audios.values()) {
      a.audio.srcObject = null; a.audio.pause();
      try { a.src?.disconnect(); a.analyser?.disconnect(); a.hp?.disconnect(); a.lp?.disconnect(); a.panner?.disconnect(); a.gain?.disconnect(); } catch { /* ignore */ }
    }
    this.audios.clear();
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null; this.micOk = false; this.localSpeaking = false;
    try { this.localSource?.disconnect(); this.localAnalyser?.disconnect(); } catch { /* ignore */ }
    this.localSource = null; this.localAnalyser = null; this.localData = null;
    const ctx = this.audioCtx; this.audioCtx = null;
    if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => { });
    this.conns = []; this.pendingHostConns.clear(); this.hostConn = null; this.code = ''; this.receiveBudgets = new WeakMap();
    try { this.peer?.destroy(); } catch { /* ignore */ } this.peer = null;
  }
}
