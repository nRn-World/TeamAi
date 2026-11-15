// Optional in-browser AI tactical coordinator using WebLLM (WebGPU).
// Lazy-loaded only when the player enables the AI Brain in Settings (Solo mode only, zero backend/API keys).
import type { InitProgressReport, MLCEngineInterface } from '@mlc-ai/web-llm';
import type { Action, Command, Dir, Sim, Team } from '../sim/sim';
import { OFFICER_NAMES } from '../sim/sim';
import { parseCommands } from '../sim/commands';
import { buildLocalReport, buildTacticalContext } from '../sim/context';

export const AI_MODELS = [
  { id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC', label: 'Llama 3.2 1B (~880 MB · Fast & Sharp EN)' },
  { id: 'gemma3-1b-it-q4f16_1-MLC', label: 'Gemma 3 1B (~710 MB · Fast EN)' },
  { id: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', label: 'Qwen 2.5 1.5B (~1.6 GB · High Accuracy)' },
  { id: 'Llama-3.2-3B-Instruct-q4f16_1-MLC', label: 'Llama 3.2 3B (~2.2 GB · Smartest EN)' },
  { id: 'SmolLM2-360M-Instruct-q4f16_1-MLC', label: 'SmolLM2 360M (~380 MB · Lightest EN)' },
] as const;

export type AiState = 'off' | 'loading' | 'ready' | 'unsupported' | 'error';

export interface AiResult {
  speaker: number;
  reply: string;
  relayTo?: number | Team | 'ALL' | null;
  relayMsg?: string | null;
  commands: Command[];
  fromFallback?: boolean;
}

const VALID_ACTIONS = new Set<Action>([
  'follow', 'hold', 'move', 'cover', 'stack', 'breach', 'bang', 'open', 'close', 'restrain', 'fireFree', 'fireHold', 'report', 'shout', 'joinTeam',
]);
const VALID_DIRS = new Set<Dir>(['left', 'right', 'forward', 'back', 'there']);

function resolveSpeaker(raw: unknown, fallback = 0): number {
  if (typeof raw === 'number' && raw >= 0 && raw < 4) return raw | 0;
  if (typeof raw === 'string') {
    const s = raw.trim().toLowerCase();
    const idx = OFFICER_NAMES.findIndex(n => s.includes(n.toLowerCase()));
    if (idx >= 0) return idx;
    if (s.includes('b')) return 2;
  }
  return fallback;
}

function resolveTarget(raw: unknown): number | Team | 'ALL' | null {
  if (typeof raw === 'number' && raw >= 0 && raw < 4) return raw | 0;
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  if (!s || s === 'null' || s === 'none') return null;
  const idx = OFFICER_NAMES.findIndex(n => s.includes(n.toLowerCase()));
  if (idx >= 0) return idx;
  if (s === 'all' || s.includes('both') || s.includes('everyone')) return 'ALL';
  if (s === 'a' || s.includes('team a') || s.includes('alpha')) return 'A';
  if (s === 'b' || s.includes('team b') || s.includes('bravo')) return 'B';
  return null;
}

function extractJson(text: string): any {
  const cleaned = text.replace(/```json|```/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

const SYSTEM_PROMPT = `You are the tactical SWAT radio coordinator AI for a 3D tactical shooter (English only).
Your four SWAT officers:
- Ken (slot 0), Maya (slot 1), Jack (slot 2), Zoe (slot 3).
Check LIVE TACTICAL STATE to see which team (Team A or Team B) each officer is currently on.

Understand everything the player says (via voice or text), translate tactical instructions into squad commands in order, answer questions accurately using LIVE TACTICAL STATE, and respond concisely in-character over radio in English.
If the player asks an officer to join/switch to Team A or Team B, use action "joinTeam" with "team": "A" or "B" and "who": officer slot (0..3).
If the player asks one officer/team to inform or relay something to another SWAT officer/team, set "relayTo" and "relayMsg" AND include the commands for the target team/officer.

Output ONLY a single valid JSON object with this exact schema:
{
  "speaker": "Ken|Maya|Jack|Zoe",
  "reply": "short in-character English radio reply (max 22 words)",
  "relayTo": "Ken|Maya|Jack|Zoe|Team A|Team B|ALL|null",
  "relayMsg": "short relayed message to other SWAT or null",
  "commands": [
    { "team": "A|B|ALL", "who": 0|1|2|3|null, "action": "follow|hold|move|cover|stack|breach|bang|open|close|restrain|fireFree|fireHold|report|shout|joinTeam", "dir": "left|right|forward|back|there|null" }
  ]
}

Rules:
- "action" MUST be one of the exact allowed values. Use "move" only with "dir".
- For "joinTeam", set "team" to the destination team ("A" or "B") and "who" to the officer slot (0=Ken, 1=Maya, 2=Jack, 3=Zoe).
- Use "who" (0..3) when addressing one specific officer; otherwise null to command the whole team.
- Keep "commands": [] if the player is only asking a question ("status?", "do you see any suspects?").
- Never invent suspects or civilians that are not in LIVE TACTICAL STATE.

Examples:
Player: "Ken follow me, Maya join Team B, Team B cover me"
{"speaker":"Ken","reply":"Copy, on you. Maya switching to Team B, Team B covering your six.","relayTo":"Team B","relayMsg":"Maya is with you now. Team B, cover lead!","commands":[{"team":"A","who":0,"action":"follow","dir":null},{"team":"B","who":1,"action":"joinTeam","dir":null},{"team":"B","who":null,"action":"cover","dir":null}]}

Player: "Ken, tell Team B to flash and breach that door while you watch my back"
{"speaker":"Ken","reply":"Copy, watching your back and relaying breach order to Team B.","relayTo":"Team B","relayMsg":"Team B, lead says bang and clear that door now!","commands":[{"team":"A","who":0,"action":"cover","dir":null},{"team":"B","who":null,"action":"bang","dir":null}]}

Player: "Do you see any suspects right now?"
{"speaker":"Ken","reply":"Negative on armed suspects from our angle, holding position.","relayTo":null,"relayMsg":null,"commands":[]}`;

export class TacticalAi {
  state: AiState = 'off';
  modelId: string = AI_MODELS[0].id;
  progress = '';
  error = '';
  busy = false;
  onState: (s: AiState, detail?: string) => void = () => { };

  private engine: MLCEngineInterface | null = null;
  private loadedModel = '';
  private loadPromise: Promise<boolean> | null = null;
  private history: { role: 'user' | 'assistant'; content: string }[] = [];

  static get hasWebGpu(): boolean {
    return typeof navigator !== 'undefined' && !!(navigator as any).gpu;
  }

  resetHistory() {
    this.history = [];
  }

  private setState(s: AiState, detail = '') {
    this.state = s;
    if (s === 'loading') this.progress = detail;
    if (s === 'error' || s === 'unsupported') this.error = detail;
    this.onState(s, detail);
  }

  async ensureLoaded(modelId: string): Promise<boolean> {
    this.modelId = modelId || AI_MODELS[0].id;
    if (this.engine && this.loadedModel === this.modelId && this.state === 'ready') return true;
    if (this.loadPromise) return this.loadPromise;

    this.loadPromise = (async () => {
      if (!TacticalAi.hasWebGpu) {
        this.setState('unsupported', 'WebGPU is not supported in this browser/device. Use Chrome or Edge with WebGPU enabled.');
        return false;
      }
      try {
        const adapter = await (navigator as any).gpu.requestAdapter();
        if (!adapter) {
          this.setState('unsupported', 'No WebGPU graphics adapter was found.');
          return false;
        }
      } catch {
        this.setState('unsupported', 'WebGPU could not be initialized.');
        return false;
      }

      this.setState('loading', 'Preparing AI engine…');
      try {
        const webllm = await import('@mlc-ai/web-llm');
        if (this.engine) {
          try { await this.engine.unload(); } catch { /* ignore */ }
          this.engine = null;
        }
        this.engine = await webllm.CreateMLCEngine(this.modelId, {
          initProgressCallback: (rep: InitProgressReport) => {
            const pct = rep.progress ? ` (${Math.round(rep.progress * 100)}%)` : '';
            this.setState('loading', `${rep.text || 'Loading model'}${pct}`);
          },
        });
        this.loadedModel = this.modelId;
        this.setState('ready', `Ready: ${this.modelId}`);
        return true;
      } catch (e: any) {
        this.engine = null;
        this.loadedModel = '';
        this.setState('error', String(e?.message || e || 'Failed to load AI model.'));
        return false;
      } finally {
        this.loadPromise = null;
      }
    })();

    return this.loadPromise;
  }

  async unload() {
    this.history = [];
    if (this.engine) {
      try { await this.engine.unload(); } catch { /* ignore */ }
      this.engine = null;
      this.loadedModel = '';
    }
    this.setState('off', '');
  }

  /** Interprets a player utterance (text or mic) with live Sim context, returning squad commands and radio relay text. */
  async interpret(
    userText: string,
    sim: Sim,
    lastTeam: Team | 'ALL',
    lastWho: number | null,
  ): Promise<AiResult> {
    const localBatch = parseCommands(userText, lastTeam, lastWho);

    if (!this.engine || this.state !== 'ready') {
      return this.fallbackResult(sim, localBatch, lastTeam, lastWho);
    }

    this.busy = true;
    try {
      const ctx = buildTacticalContext(sim, sim.player);
      const userPrompt = `LIVE TACTICAL STATE:\n${ctx}\n\nPlayer says: "${userText}"`;

      const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...this.history.slice(-4),
        { role: 'user', content: userPrompt },
      ];

      const resp = await this.engine.chat.completions.create({
        messages,
        temperature: 0.2,
        max_tokens: 240,
        response_format: { type: 'json_object' },
      });

      const raw = resp.choices?.[0]?.message?.content ?? '';
      const parsed = extractJson(raw);
      if (!parsed || typeof parsed !== 'object') {
        return this.fallbackResult(sim, localBatch, lastTeam, lastWho);
      }

      const commands: Command[] = [];
      if (Array.isArray(parsed.commands)) {
        for (const item of parsed.commands) {
          if (!item || typeof item !== 'object') continue;
          const action = String(item.action || '').trim() as Action;
          if (!VALID_ACTIONS.has(action)) continue;
          let who: number | undefined;
          if (item.who !== null && item.who !== undefined) {
            const w = resolveTarget(item.who);
            if (typeof w === 'number') who = w;
          }
          const tRaw = resolveTarget(item.team);
          const offTeam = who != null ? (sim.officers[who]?.team ?? (who < 2 ? 'A' : 'B')) : lastTeam;
          const team: Team | 'ALL' = action === 'joinTeam'
            ? (tRaw === 'B' ? 'B' : 'A')
            : (tRaw === 'A' || tRaw === 'B' || tRaw === 'ALL' ? tRaw : offTeam);
          const dirRaw = typeof item.dir === 'string' ? item.dir.trim().toLowerCase() as Dir : undefined;
          const dir = dirRaw && VALID_DIRS.has(dirRaw) ? dirRaw : (action === 'move' ? 'forward' : undefined);
          commands.push(who != null ? { team, action, dir, who } : { team, action, dir });
        }
      }

      // If the LLM missed obvious direct commands from the user's text, preserve local parser hits
      if (!commands.length && localBatch.commands.length && !/\?/.test(userText)) {
        commands.push(...localBatch.commands);
      }

      const defaultSpeaker = commands[0]?.who ?? (commands[0]?.team === 'B' ? 2 : 0);
      const speaker = resolveSpeaker(parsed.speaker, defaultSpeaker);
      const reply = typeof parsed.reply === 'string' && parsed.reply.trim()
        ? parsed.reply.trim()
        : 'Copy.';
      const relayTo = resolveTarget(parsed.relayTo);
      const relayMsg = typeof parsed.relayMsg === 'string' && parsed.relayMsg.trim() ? parsed.relayMsg.trim() : null;

      this.history.push({ role: 'user', content: `Player says: "${userText}"` });
      this.history.push({ role: 'assistant', content: JSON.stringify({ speaker: OFFICER_NAMES[speaker], reply, relayTo, relayMsg, commands }) });
      if (this.history.length > 6) this.history = this.history.slice(-6);

      return { speaker, reply, relayTo, relayMsg, commands };
    } catch {
      return this.fallbackResult(sim, localBatch, lastTeam, lastWho);
    } finally {
      this.busy = false;
    }
  }

  private fallbackResult(
    sim: Sim,
    localBatch: ReturnType<typeof parseCommands>,
    lastTeam: Team | 'ALL',
    lastWho: number | null,
  ): AiResult {
    if (localBatch.commands.length) {
      const first = localBatch.commands[0];
      const speaker = localBatch.relayFrom ?? first.who ?? (first.team === 'B' ? 2 : 0);
      return { speaker, reply: 'Copy.', commands: localBatch.commands, fromFallback: true };
    }
    const team: Team = lastTeam === 'B' ? 'B' : 'A';
    const speaker = lastWho ?? (team === 'B' ? 2 : 0);
    return {
      speaker,
      reply: buildLocalReport(sim, team, lastWho ?? undefined),
      commands: [],
      fromFallback: true,
    };
  }
}
