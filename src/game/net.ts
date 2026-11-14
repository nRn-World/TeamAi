// Online co-op over WebRTC (PeerJS, MIT). No game server needed: one player hosts, the others join with a room code.
// Signalling uses the free public PeerJS broker; voice chat is a direct WebRTC audio mesh between all players.
import Peer, { DataConnection, MediaConnection } from 'peerjs';

const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789', PREFIX = 'teamai-room-';
export type Msg = { t: string;[k: string]: any };

export class Net {
  role: 'solo' | 'host' | 'client' = 'solo'; code = ''; peer: Peer | null = null; conns: DataConnection[] = []; hostConn: DataConnection | null = null;
  onMsg: (from: DataConnection, m: Msg) => void = () => { }; onPeers: () => void = () => { }; onClosed: (why: string) => void = () => { };
  stream: MediaStream | null = null; micOk = false; muted = false; onVoice: () => void = () => { }; private voiceP: Promise<void> | null = null; private calls = new Map<string, MediaConnection>(); private audios = new Map<string, HTMLAudioElement>();
  get id() { return this.peer?.id ?? ''; }
  get online() { return this.role !== 'solo'; }
  private opts() {
    const q = new URLSearchParams(location.search), h = q.get('peerhost');
    return h ? { host: h, port: +(q.get('peerport') || 9000), path: '/', secure: false, debug: 1 } : { debug: 1 };
  }
  private open(id?: string) {
    return new Promise<Peer>((res, rej) => {
      const p = id ? new Peer(id, this.opts()) : new Peer(this.opts()); let done = false;
      const to = setTimeout(() => { if (!done) { done = true; p.destroy(); rej(new Error('timeout')); } }, 15000);
      p.on('open', () => { if (done) return; done = true; clearTimeout(to); res(p); });
      p.on('error', (e: any) => { if (!done) { done = true; clearTimeout(to); p.destroy(); rej(e); } else if (e?.type === 'network' || e?.type === 'server-error') this.onClosed('Tappade kontakten med förmedlingsservern.'); });
    });
  }
  /** Microphone for voice chat. Never blocks room creation: runs in the background, and falls back to a
   *  silent stream (listen-only) if the microphone is denied or the permission prompt is left unanswered. */
  private voice(): Promise<void> {
    if (this.voiceP) return this.voiceP;
    const silent = () => { const AC = window.AudioContext || (window as any).webkitAudioContext; return new AC().createMediaStreamDestination().stream as MediaStream; };
    return this.voiceP = new Promise<void>(res => {
      let settled = false;
      const finish = (st: MediaStream, ok: boolean) => { if (settled) { if (ok) st.getTracks().forEach(t => t.stop()); return; } settled = true; this.stream = st; this.micOk = ok; this.setMuted(this.muted); this.onVoice(); res(); };
      const to = setTimeout(() => finish(silent(), false), 20000);
      if (!navigator.mediaDevices?.getUserMedia) { clearTimeout(to); finish(silent(), false); return; }
      navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
        .then(st => { clearTimeout(to); finish(st, true); }).catch(() => { clearTimeout(to); finish(silent(), false); });
    });
  }
  private hookCalls() {
    this.peer!.on('call', call => { this.voice().then(() => { call.answer(this.stream!); this.track(call); }); });
  }
  private track(call: MediaConnection) {
    this.calls.set(call.peer, call);
    call.on('stream', s => { let a = this.audios.get(call.peer); if (!a) { a = new Audio(); a.autoplay = true; this.audios.set(call.peer, a); } a.srcObject = s; a.play().catch(() => { }); });
    const drop = () => { this.calls.delete(call.peer); const a = this.audios.get(call.peer); if (a) { a.srcObject = null; this.audios.delete(call.peer); } };
    call.on('close', drop); call.on('error', drop);
  }
  /** Everyone gets the full id list; the peer with the smaller id places the call, so each pair connects exactly once. */
  callPeers(ids: string[]) { this.voice().then(() => { if (!this.peer || !this.stream) return; for (const id of ids) if (id !== this.id && !this.calls.has(id) && this.id < id) this.track(this.peer.call(id, this.stream)); }); }
  get voiceCount() { return this.audios.size; }
  setMuted(m: boolean) { this.muted = m; this.stream?.getAudioTracks().forEach(t => { t.enabled = !m; }); }

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
      const to = setTimeout(() => rej(new Error('Hittade inget rum med den koden.')), 12000);
      c.on('open', () => { clearTimeout(to); res(); }); c.on('error', e => { clearTimeout(to); rej(e); });
      this.peer!.on('error', (e: any) => { if (e?.type === 'peer-unavailable') { clearTimeout(to); rej(new Error('Hittade inget rum med den koden.')); } });
    });
    this.hostConn = c; this.role = 'client';
    c.on('data', d => this.onMsg(c, d as Msg)); c.on('close', () => { if (this.role === 'client') this.onClosed('Värden lämnade spelet.'); });
  }
  send(m: Msg) { if (this.hostConn?.open) this.hostConn.send(m); }
  broadcast(m: Msg) { for (const c of this.conns) if (c.open) c.send(m); }
  close() {
    this.role = 'solo'; for (const c of this.calls.values()) c.close(); this.calls.clear(); for (const a of this.audios.values()) a.srcObject = null; this.audios.clear();
    this.conns = []; this.hostConn = null; this.code = ''; try { this.peer?.destroy(); } catch { /* ignore */ } this.peer = null;
  }
}
