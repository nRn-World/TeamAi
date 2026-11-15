// Optional local language model that reads free-form orders («Ken cover the door while Team B goes in with a flash»)
// and answers with the game's own orders. Runs with WebGPU on the player's computer – no server, no API.
import type { Command, Team } from '../sim/sim';
import { orderMessages, toCommands, lastLabel, ORDER_SCHEMA } from '../sim/aiorders';

export type BrainState = 'off' | 'loading' | 'ready' | 'error' | 'unsupported';
/** Setting value → model. Both are Apache-2.0 (Alibaba Cloud, Qwen2.5). */
export const BRAIN_MODELS: Record<number, { id: string; label: string }> = {
  1: { id: 'Qwen2.5-0.5B-Instruct', label: 'Qwen2.5 0.5B' },
  2: { id: 'Qwen2.5-1.5B-Instruct', label: 'Qwen2.5 1.5B' },
};
export class Brain {
  state: BrainState = 'off'; progress = 0; note = ''; size = 0; lastMs = 0; onState: () => void = () => { };
  private engine: any = null; private worker: Worker | null = null; private gen = 0; private busy = false;
  static get supported() { return !!(navigator as any).gpu && typeof Worker !== 'undefined'; }
  private set(s: BrainState, note = '') { this.state = s; this.note = note; this.onState(); }
  get ready() { return this.state === 'ready'; }
  /** Downloads (first time) and starts the model. Safe to call again; switching size reloads. */
  async load(size: number) {
    if (!BRAIN_MODELS[size]) { this.unload(); return; }
    if (size === this.size && (this.state === 'ready' || this.state === 'loading')) return;
    this.unload(); this.size = size; const gen = ++this.gen;
    if (!Brain.supported) { this.set('unsupported', 'This browser has no WebGPU. Use a current Chrome or Edge on a computer with a graphics card.'); return; }
    this.progress = 0; this.set('loading', 'Starting…');
    try {
      const adapter = await (navigator as any).gpu.requestAdapter(); if (!adapter) throw new Error('No WebGPU graphics adapter available');
      const id = `${BRAIN_MODELS[size].id}-${adapter.features?.has?.('shader-f16') ? 'q4f16_1' : 'q4f32_1'}-MLC`;
      const { CreateWebWorkerMLCEngine } = await import('@mlc-ai/web-llm');
      const worker = new Worker(new URL('./llm.worker.ts', import.meta.url), { type: 'module' });
      const engine = await CreateWebWorkerMLCEngine(worker, id, { initProgressCallback: (r: { progress: number; text: string }) => { if (gen !== this.gen) return; this.progress = r.progress; this.set('loading', r.text); } });
      if (gen !== this.gen) { worker.terminate(); return; }
      this.engine = engine; this.worker = worker; this.set('ready', BRAIN_MODELS[size].label);
      void this.interpret('team a follow me', 'ALL', null); // warm-up, so the first real order is not the slow one
    } catch (e) { if (gen === this.gen) this.set('error', String((e as any)?.message ?? e).slice(0, 240)); }
  }
  unload() { this.gen++; this.worker?.terminate(); this.worker = null; this.engine = null; this.size = 0; this.busy = false; if (this.state !== 'off') this.set('off'); }
  /** Orders found in the sentence, [] if the model says there are none, null if it could not answer in time. */
  async interpret(text: string, lastTeam: Team | 'ALL', lastWho: number | null, timeoutMs = 7000): Promise<Command[] | null> {
    const engine = this.engine; if (!engine || this.busy) return null; this.busy = true; const t0 = performance.now();
    let timer = 0; const timeout = new Promise<null>(res => { timer = window.setTimeout(() => { try { engine.interruptGenerate(); } catch { /* worker gone */ } res(null); }, timeoutMs); });
    try {
      const run = engine.chat.completions.create({ messages: orderMessages(text, lastLabel(lastTeam, lastWho)), temperature: 0, max_tokens: 140, response_format: { type: 'json_object', schema: ORDER_SCHEMA } });
      const r = await Promise.race([run, timeout]); if (!r) return null;
      this.lastMs = Math.round(performance.now() - t0);
      return toCommands(String(r.choices?.[0]?.message?.content ?? ''), lastTeam, lastWho);
    } catch { return null; } finally { clearTimeout(timer); this.busy = false; }
  }
}
