// Optional in-browser AI tactical coordinator using WebLLM (WebGPU).
// Lazy-loaded only when the player enables the AI Brain in Settings (Solo mode only, zero backend/API keys).
import type { InitProgressReport, MLCEngineInterface } from '@mlc-ai/web-llm';
import type { Action, Command, Dir, Sim, Team } from '../sim/sim';
import { OFFICER_NAMES } from '../sim/sim';
import { parseCommands } from '../sim/commands';
import { buildLocalReport, buildTacticalContext, isSwedishText } from '../sim/context';

export const AI_MODELS = [
  { id: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC', label: 'Qwen 2.5 0.5B (~450 MB · Fast · EN/SV)' },
  { id: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', label: 'Qwen 2.5 1.5B (~950 MB · Smarter · EN/SV)' },
  { id: 'SmolLM2-360M-Instruct-q4f16_1-MLC', label: 'SmolLM2 360M (~280 MB · Lightest · EN)' },
  { id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC', label: 'Llama 3.2 1B (~600 MB · Balanced · EN)' },
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
  'follow', 'hold', 'move', 'cover', 'stack', 'breach', 'bang', 'open', 'close', 'restrain', 'fireFree', 'fireHold', 'report', 'shout',
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
  if (s === 'all' || s.includes('both') || s.includes('alla') || s.includes('everyone')) return 'ALL';
  if (s === 'a' || s.includes('team a') || s.includes('lag a') || s.includes('alpha')) return 'A';
  if (s === 'b' || s.includes('team b') || s.includes('lag b') || s.includes('bravo')) return 'B';
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

const SYSTEM_PROMPT = `You are the tactical SWAT radio coordinator AI for a 3D tactical shooter.
Your squad:
- Team A: Ken (0), Maya (1)
- Team B: Jack (2), Zoe (3)

The player talks via microphone or text chat in English or Swedish.
Understand what the player wants, use the LIVE TACTICAL STATE, issue valid squad commands, and respond concisely in-character over radio (in the same language as the player: Swedish or English).
If the player asks one officer/team to inform or relay something to another SWAT officer/team, set "relayTo" and "relayMsg" AND include the commands for the target team/officer.

Output ONLY a single valid JSON object with this exact schema:
{
  "speaker": "Ken|Maya|Jack|Zoe",
  "reply": "short radio reply (max 22 words)",
  "relayTo": "Ken|Maya|Jack|Zoe|Team A|Team B|ALL|null",
  "relayMsg": "short relayed order/info to other SWAT or null",
  "commands": [
    { "team": "A|B|ALL", "who": 0|1|2|3|null, "action": "follow|hold|move|cover|stack|breach|bang|open|close|restrain|fireFree|fireHold|report|shout", "dir": "left|right|forward|back|there|null" }
  ]
}

Rules:
- "action" MUST be one of the exact allowed values. Use "move" only with "dir".
- Use "who" (0=Ken, 1=Maya, 2=Jack, 3=Zoe) when addressing one officer; otherwise null.
- Keep "commands": [] if the player is only asking a question ("status?", "do you see enemies?", "var är ni?").
- Never invent enemies or hostages that are not in LIVE TACTICAL STATE.

Examples:
Player: "Ken, säg till Team B att bryta in medan du täcker mig"
{"speaker":"Ken","reply":"Uppfattat, jag täcker dig och meddelar Team B!","relayTo":"Team B","relayMsg":"Team B, order från chefen: bryt in nu!","commands":[{"team":"A","who":0,"action":"cover","dir":null},{"team":"B","who":null,"action":"breach","dir":null}]}

Player: "Do you see any suspects right now?"
{"speaker":"Ken","reply":"Negative on armed suspects from here, Team A is holding behind you.","relayTo":null,"relayMsg":null,"commands":[]}

Player: "Team A stack up and Team B follow me"
{"speaker":"Ken","reply":"Team A stacking on the door. Team B, fall in on lead.","relayTo":"Team B","relayMsg":"Team B, follow lead.","commands":[{"team":"A","who":null,"action":"stack","dir":null},{"team":"B","who":null,"action":"follow","dir":null}]}`;

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
        this.setState('unsupported', 'WebGPU saknas i den här webbläsaren/enheten. Använd Chrome eller Edge med WebGPU påslaget.');
        return false;
      }
      try {
        const adapter = await (navigator as any).gpu.requestAdapter();
        if (!adapter) {
          this.setState('unsupported', 'Ingen WebGPU-grafikadapter hittades.');
          return false;
        }
      } catch {
        this.setState('unsupported', 'WebGPU kunde inte startas.');
        return false;
      }

      this.setState('loading', 'Förbereder AI-motorn…');
      try {
        const webllm = await import('@mlc-ai/web-llm');
        if (this.engine) {
          try { await this.engine.unload(); } catch { /* ignore */ }
          this.engine = null;
        }
        this.engine = await webllm.CreateMLCEngine(this.modelId, {
          initProgressCallback: (rep: InitProgressReport) => {
            const pct = rep.progress ? ` (${Math.round(rep.progress * 100)}%)` : '';
            this.setState('loading', `${rep.text || 'Laddar modell'}${pct}`);
          },
        });
        this.loadedModel = this.modelId;
        this.setState('ready', `Klar: ${this.modelId}`);
        return true;
      } catch (e: any) {
        this.engine = null;
        this.loadedModel = '';
        this.setState('error', String(e?.message || e || 'Kunde inte ladda AI-modellen.'));
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
    preferSwedish: boolean,
  ): Promise<AiResult> {
    const swedish = preferSwedish || isSwedishText(userText);
    const localBatch = parseCommands(userText, lastTeam, lastWho);

    if (!this.engine || this.state !== 'ready') {
      return this.fallbackResult(sim, localBatch, lastTeam, lastWho, swedish);
    }

    this.busy = true;
    try {
      const ctx = buildTacticalContext(sim, sim.player);
      const langNote = swedish ? 'Respond in Swedish.' : 'Respond in English.';
      const userPrompt = `LIVE TACTICAL STATE:\n${ctx}\n\n${langNote}\nPlayer says: "${userText}"`;

      const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...this.history.slice(-4),
        { role: 'user', content: userPrompt },
      ];

      const resp = await this.engine.chat.completions.create({
        messages,
        temperature: 0.2,
        max_tokens: 220,
        response_format: { type: 'json_object' },
      });

      const raw = resp.choices?.[0]?.message?.content ?? '';
      const parsed = extractJson(raw);
      if (!parsed || typeof parsed !== 'object') {
        return this.fallbackResult(sim, localBatch, lastTeam, lastWho, swedish);
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
          let team: Team | 'ALL' = tRaw === 'A' || tRaw === 'B' || tRaw === 'ALL' ? tRaw : (who != null ? (who < 2 ? 'A' : 'B') : lastTeam);
          const dirRaw = typeof item.dir === 'string' ? item.dir.trim().toLowerCase() as Dir : undefined;
          const dir = dirRaw && VALID_DIRS.has(dirRaw) ? dirRaw : (action === 'move' ? 'forward' : undefined);
          commands.push(who != null ? { team: who < 2 ? 'A' : 'B', action, dir, who } : { team, action, dir });
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
        : (swedish ? 'Uppfattat.' : 'Copy.');
      const relayTo = resolveTarget(parsed.relayTo);
      const relayMsg = typeof parsed.relayMsg === 'string' && parsed.relayMsg.trim() ? parsed.relayMsg.trim() : null;

      this.history.push({ role: 'user', content: `Player says: "${userText}"` });
      this.history.push({ role: 'assistant', content: JSON.stringify({ speaker: OFFICER_NAMES[speaker], reply, relayTo, relayMsg, commands }) });
      if (this.history.length > 6) this.history = this.history.slice(-6);

      return { speaker, reply, relayTo, relayMsg, commands };
    } catch {
      return this.fallbackResult(sim, localBatch, lastTeam, lastWho, swedish);
    } finally {
      this.busy = false;
    }
  }

  private fallbackResult(
    sim: Sim,
    localBatch: ReturnType<typeof parseCommands>,
    lastTeam: Team | 'ALL',
    lastWho: number | null,
    swedish: boolean,
  ): AiResult {
    if (localBatch.commands.length) {
      const first = localBatch.commands[0];
      const speaker = localBatch.relayFrom ?? first.who ?? (first.team === 'B' ? 2 : 0);
      const reply = swedish ? 'Uppfattat.' : 'Copy.';
      return { speaker, reply, commands: localBatch.commands, fromFallback: true };
    }
    const team: Team = lastTeam === 'B' ? 'B' : 'A';
    const speaker = lastWho ?? (team === 'B' ? 2 : 0);
    return {
      speaker,
      reply: buildLocalReport(sim, team, lastWho ?? undefined, swedish),
      commands: [],
      fromFallback: true,
    };
  }
}
