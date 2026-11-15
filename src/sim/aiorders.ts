// Glue between a local language model and the game's orders. The fixed rules (commands.ts) decide who an order is for
// and read everything they can; the model is only asked «which action is this?» for wording the rules do not know.
// Pure functions, unit-tested; the model itself lives in src/ai/brain.ts.
import type { Action, Dir } from './sim';

const ACTIONS: Action[] = ['follow', 'hold', 'move', 'cover', 'stack', 'breach', 'bang', 'open', 'close', 'restrain', 'fireFree', 'fireHold', 'report'];
const DIRS: Dir[] = ['left', 'right', 'forward', 'back', 'there'];

/** JSON schema the model's answer is constrained to. */
export const ORDER_SCHEMA = JSON.stringify({ type: 'object', required: ['action', 'dir'], properties: { action: { type: 'string', enum: [...ACTIONS, 'none'] }, dir: { type: 'string', enum: [...DIRS, ''] } } });

const SYSTEM = `A police squad leader says something to his officers, in English or Swedish. Decide which order it is.
Actions:
follow = come with me, come back to me, regroup
hold = stay where you are, stop, wait, do not move
move = go left, right, forward, back, or there (to the spot he points at). Put the direction in "dir".
cover = cover, protect or guard the leader, watch his back
stack = line up at the door and wait
breach = go in, get in there, enter, storm or clear the room, kick the door in
bang = throw a flashbang or stun grenade
open = open the door. close = close the door
restrain = handcuff, cuff, arrest, tie up or secure people
fireHold = do not shoot. fireFree = you may shoot
report = tell me your status
none = a question, small talk, or anything that is not an order
Answer with JSON only: {"action":"...","dir":"..."}. "dir" is "" unless the action is move.`;

const SHOTS: [string, string][] = [
  ['get yourselves through that door now', '{"action":"breach","dir":""}'],
  ['flytta er åt höger', '{"action":"move","dir":"right"}'],
  ['what was that noise', '{"action":"none","dir":""}'],
  ['nobody moves a muscle', '{"action":"hold","dir":""}'],
  ['sätt handklovar på dem', '{"action":"restrain","dir":""}'],
  ['I am hungry', '{"action":"none","dir":""}'],
  ['keep an eye on me while I work', '{"action":"cover","dir":""}'],
];
/** Chat messages asking the model for the action in one order. */
export function orderMessages(text: string) {
  const m: { role: 'system' | 'user' | 'assistant'; content: string }[] = [{ role: 'system', content: SYSTEM }];
  for (const [q, a] of SHOTS) m.push({ role: 'user', content: q }, { role: 'assistant', content: a });
  m.push({ role: 'user', content: text.slice(0, 200) });
  return m;
}
/** The model's answer → action and direction, or null when it is not a usable order. */
export function toAction(answer: string): { action: Action; dir?: Dir } | null {
  let o: any; const i = answer.indexOf('{'), j = answer.indexOf('}', i);
  try { o = JSON.parse(i >= 0 && j > i ? answer.slice(i, j + 1) : answer); } catch { return null; }
  const action = ACTIONS.find(a => a.toLowerCase() === String(o?.action ?? '').trim().toLowerCase()); if (!action) return null;
  const dirS = String(o?.dir ?? '').trim().toLowerCase(), dir = DIRS.find(d => d === dirS);
  if (action === 'move') return dir ? { action, dir } : null;
  return { action };
}
