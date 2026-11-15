// Glue between a local language model and the game's orders: the prompt it gets and how its JSON answer becomes Commands.
// Pure functions, unit-tested; the model itself lives in src/ai/brain.ts.
import type { Command, Action, Dir, Team } from './sim';
import { OFFICER_NAMES } from './sim';

const ACTIONS: Action[] = ['follow', 'hold', 'move', 'cover', 'stack', 'breach', 'bang', 'open', 'close', 'restrain', 'fireFree', 'fireHold', 'report', 'shout'];
const DIRS: Dir[] = ['left', 'right', 'forward', 'back', 'there'];
export const MAX_ORDERS = 4;

/** JSON schema the model's answer is constrained to. */
export const ORDER_SCHEMA = JSON.stringify({
  type: 'object', required: ['orders'],
  properties: { orders: { type: 'array', items: { type: 'object', required: ['to', 'action'], properties: {
    to: { type: 'string', enum: ['A', 'B', 'ALL', ...OFFICER_NAMES] }, action: { type: 'string', enum: [...ACTIONS, 'none'] }, dir: { type: 'string', enum: [...DIRS, ''] },
  } } } },
});

const SYSTEM = `You turn what a police squad leader says into orders for his squad. He may speak English or Swedish, and the text may contain speech-recognition mistakes.
Squad: Team A = ${OFFICER_NAMES[0]} and ${OFFICER_NAMES[1]}. Team B = ${OFFICER_NAMES[2]} and ${OFFICER_NAMES[3]}.
"to" says who the order is for: "A", "B", "ALL" or one name.
"action" is one of:
follow = come with the leader, regroup
hold = stay, stop, wait
move = go somewhere, with "dir": left, right, forward, back, or there (the spot the leader points at)
cover = protect or guard the leader, watch his back
stack = line up at the door
breach = go in, storm or clear the room
bang = throw a flashbang
open, close = the door
restrain = handcuff, arrest or secure people
fireHold = stop shooting. fireFree = allowed to shoot
report = status report
shout = the leader yells at a suspect (police, drop the weapon, hands up)
none = not an order
Answer with JSON only: {"orders":[{"to":"...","action":"...","dir":"..."}]}. One entry per order, at most ${MAX_ORDERS}, in the order they were said.`;

const SHOTS: [string, string, string][] = [
  ['ALL', 'Ken cover the door while team B goes in with a flash', '{"orders":[{"to":"Ken","action":"cover","dir":""},{"to":"B","action":"bang","dir":""}]}'],
  ['A', 'ni tar höger', '{"orders":[{"to":"A","action":"move","dir":"right"}]}'],
  ['ALL', 'Maya stanna här och Jack du följer med mig', '{"orders":[{"to":"Maya","action":"hold","dir":""},{"to":"Jack","action":"follow","dir":""}]}'],
  ['B', 'nice weather today', '{"orders":[{"to":"B","action":"none","dir":""}]}'],
  ['ALL', 'everybody get those people in cuffs then team a kick that door in', '{"orders":[{"to":"ALL","action":"restrain","dir":""},{"to":"A","action":"breach","dir":""}]}'],
];
const ask = (last: string, text: string) => `Last spoken to: ${last}\nLeader: ${text}`;

/** Chat messages for one spoken sentence. `last` = who the previous order went to ("A", "B", "ALL" or a name). */
export function orderMessages(text: string, last: string) {
  const m: { role: 'system' | 'user' | 'assistant'; content: string }[] = [{ role: 'system', content: SYSTEM }];
  for (const [l, q, a] of SHOTS) m.push({ role: 'user', content: ask(l, q) }, { role: 'assistant', content: a });
  m.push({ role: 'user', content: ask(last, text.slice(0, 300)) });
  return m;
}
export const lastLabel = (team: Team | 'ALL', who: number | null) => (who != null ? OFFICER_NAMES[who] ?? team : team);

/** The model's answer → orders the sim understands. Anything unknown is dropped; returns [] when nothing usable is left. */
export function toCommands(answer: string, lastTeam: Team | 'ALL' = 'ALL', lastWho: number | null = null): Command[] {
  let o: any; const i = answer.indexOf('{'), j = answer.lastIndexOf('}');
  try { o = JSON.parse(i >= 0 && j > i ? answer.slice(i, j + 1) : answer); } catch { return []; }
  const list: any[] = Array.isArray(o) ? o : Array.isArray(o?.orders) ? o.orders : o?.action ? [o] : [];
  const out: Command[] = [], seen = new Set<string>();
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    const action = ACTIONS.find(a => a.toLowerCase() === String(e.action ?? '').trim().toLowerCase()); if (!action) continue;
    const dirS = String(e.dir ?? '').trim().toLowerCase(), dir = DIRS.find(d => d === dirS);
    if (action === 'move' && !dir) continue;
    const to = String(e.to ?? '').trim().toLowerCase().replace(/^team\s*/, ''), who = OFFICER_NAMES.findIndex(n => n.toLowerCase() === to);
    let cmd: Command;
    if (action === 'shout') cmd = { team: 'ALL', action };
    else if (who >= 0) cmd = { team: who < 2 ? 'A' : 'B', action, who };
    else if (to === 'a' || to === 'b') cmd = { team: to.toUpperCase() as Team, action };
    else if (to === 'all' || to === 'everyone' || to === 'both') cmd = { team: 'ALL', action };
    else if (lastWho != null) cmd = { team: lastWho < 2 ? 'A' : 'B', action, who: lastWho };
    else cmd = { team: lastTeam, action };
    if (action === 'move') cmd.dir = dir;
    const key = `${cmd.who ?? cmd.team}`; if (seen.has(key)) continue; // one order per addressee: a second one would only overwrite the first
    seen.add(key); out.push(cmd); if (out.length >= MAX_ORDERS) break;
  }
  return out;
}
/** Sentences worth sending to the model even though the fixed rules found an order: more than one order or addressee in them. */
export const looksCompound = (text: string) => / (and|then|while|after that|och|medan|sedan|sen) /.test(' ' + text.toLowerCase().replace(/[.,!?;:]/g, ' ').replace(/\s+/g, ' ') + ' ');
