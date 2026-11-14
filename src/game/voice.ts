// Always-on microphone command recognition using the browser's Web Speech API.
export type VoiceState = 'off' | 'starting' | 'listening' | 'denied' | 'unsupported' | 'error';
export class Voice {
  state: VoiceState = 'off'; lang = 'sv-SE'; onFinal: (text: string) => void = () => { }; onInterim: (text: string) => void = () => { }; onState: (s: VoiceState, detail?: string) => void = () => { };
  private rec: any = null; private want = false; private restarts = 0;
  static get supported() { return !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition); }
  private set(s: VoiceState, d?: string) { this.state = s; this.onState(s, d); }
  start() {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) { this.set('unsupported'); return; }
    this.want = true; if (this.rec) return;
    const r = this.rec = new SR(); r.lang = this.lang; r.continuous = true; r.interimResults = true; r.maxAlternatives = 3;
    r.onstart = () => { this.restarts = 0; this.set('listening'); };
    r.onresult = (e: any) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) { const alts: string[] = []; for (let k = 0; k < res.length; k++) alts.push(res[k].transcript.trim()); this.onFinal(alts.join(' | ')); }
        else interim += res[0].transcript;
      }
      if (interim) this.onInterim(interim.trim());
    };
    r.onerror = (e: any) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { this.want = false; this.set('denied', e.error); }
      else if (e.error !== 'no-speech' && e.error !== 'aborted') this.set('error', e.error);
    };
    r.onend = () => { this.rec = null; if (this.want && this.restarts++ < 50) setTimeout(() => this.want && this.start(), 250); else if (this.state !== 'denied') this.set('off'); };
    this.set('starting');
    try { r.start(); } catch (err) { this.rec = null; this.set('error', String(err)); }
  }
  stop() { this.want = false; try { this.rec?.stop(); } catch { /* ignore */ } this.rec = null; this.set('off'); }
  setLang(l: string) { this.lang = l; if (this.want) { try { this.rec?.stop(); } catch { /* restart via onend */ } } }
}
