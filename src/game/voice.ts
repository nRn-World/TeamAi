// Microphone command recognition using the browser's Web Speech API.
// Two modes: always-on, or push-to-talk (recogniser stays warm, results only accepted while the key is held).
export type VoiceState = 'off' | 'starting' | 'listening' | 'denied' | 'unsupported' | 'error';
export class Voice {
  state: VoiceState = 'off'; lang = 'en-US'; onFinal: (text: string) => void = () => { }; onInterim: (text: string) => void = () => { }; /** Speech recognised while the push-to-talk key was NOT held. */ onIgnored: (text: string) => void = () => { }; lastHeard = ''; lastError = ''; onState: (s: VoiceState, detail?: string) => void = () => { };
  private rec: any = null; private want = false; private restarts = 0;
  ptt = false; held = false; private base = 0; private finals = 0; private grace = 0;
  /** Push-to-talk key pressed: accept what is said from now on. */
  press() { if (this.held) return; this.held = true; this.base = this.finals; this.onState(this.state); }
  /** Key released: flush the recogniser so the final text arrives quickly. */
  release() { if (!this.held) return; this.held = false; this.grace = performance.now() + 2000; this.onState(this.state); if (this.ptt) { try { this.rec?.stop(); } catch { /* restarts via onend */ } } }
  static get supported() { return !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition); }
  private set(s: VoiceState, d?: string) { this.state = s; this.onState(s, d); }
  private checking = false;
  /** Asks for the microphone first (clear permission prompt + precise error), then starts recognition. */
  start() {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) { this.set('unsupported'); return; }
    this.want = true; if (this.rec || this.checking) return;
    const fp = (document as any).featurePolicy ?? (document as any).permissionsPolicy;
    if (window.top !== window.self && fp?.allowsFeature && !fp.allowsFeature('microphone')) { this.want = false; this.set('denied', 'iframe'); return; }
    if (!navigator.mediaDevices?.getUserMedia) { this.begin(SR); return; }
    this.checking = true; this.set('starting');
    navigator.mediaDevices.getUserMedia({ audio: true }).then(st => {
      st.getTracks().forEach(t => t.stop()); this.checking = false; if (this.want) this.begin(SR);
    }).catch((e: any) => {
      this.checking = false; this.want = false;
      if (e?.name === 'NotFoundError' || e?.name === 'OverconstrainedError') this.set('error', 'nomic');
      else if (e?.name === 'NotReadableError') this.set('error', 'busy');
      else this.set('denied', window.top !== window.self ? 'iframe' : 'mic');
    });
  }
  private begin(SR: any) {
    if (this.rec) return;
    const r = this.rec = new SR(); r.lang = this.lang; r.continuous = true; r.interimResults = true; r.maxAlternatives = 3;
    r.onstart = () => { this.restarts = 0; this.finals = 0; if (!this.held) this.base = 0; else this.base = 0; this.set('listening'); };
    r.onresult = (e: any) => {
      let n = 0; for (let i = 0; i < e.results.length; i++) if (e.results[i].isFinal) n++;
      const open = !this.ptt || this.held || performance.now() < this.grace;
      let interim = '';
      for (let i = open ? Math.max(e.resultIndex, this.ptt ? this.base : 0) : e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (!open) { if (res.isFinal && i >= e.resultIndex) { this.lastHeard = res[0].transcript.trim(); this.onIgnored(this.lastHeard); } continue; }
        if (res.isFinal) { const alts: string[] = []; for (let k = 0; k < res.length; k++) alts.push(res[k].transcript.trim()); this.lastHeard = alts[0]; this.onFinal(alts.join(' | ')); }
        else interim += res[0].transcript;
      }
      this.finals = n; if (this.ptt && !this.held) this.base = n;
      if (interim) this.onInterim(interim.trim());
    };
    r.onerror = (e: any) => {
      if (e.error !== 'no-speech' && e.error !== 'aborted') this.lastError = e.error;
      if (e.error === 'service-not-allowed') { this.want = false; this.set('denied', 'service'); }
      else if (e.error === 'not-allowed') { this.want = false; this.set('denied', window.top !== window.self ? 'iframe' : 'mic'); }
      else if (e.error === 'audio-capture') { this.want = false; this.set('error', 'nomic'); }
      else if (e.error === 'network') this.set('error', 'network');
      else if (e.error === 'language-not-supported') { this.want = false; this.set('error', 'lang'); }
      else if (e.error !== 'no-speech' && e.error !== 'aborted') this.set('error', e.error);
    };
    r.onend = () => { this.rec = null; if (this.want && this.restarts++ < 50) setTimeout(() => this.want && this.begin(SR), 120); else if (this.state !== 'denied' && this.state !== 'error') this.set('off'); };
    this.set('starting');
    try { r.start(); } catch (err) { this.rec = null; this.set('error', String(err)); }
  }
  stop() { this.want = false; try { this.rec?.stop(); } catch { /* ignore */ } this.rec = null; this.set('off'); }
  setLang(l: string) { this.lang = l; if (this.want) { try { this.rec?.stop(); } catch { /* restart via onend */ } } }
}
