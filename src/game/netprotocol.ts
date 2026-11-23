import type { Msg } from './net';

export const MAX_PEER_MESSAGE_BYTES = 16 * 1024 * 1024;
const PRIMARY = new Set(['carbine', 'shotgun', 'beanbag', 'shield']);
const SECONDARY = new Set(['pistol', 'taser']);
const ACTIONS = new Set(['follow', 'hold', 'move', 'cover', 'stack', 'breach', 'bang', 'open', 'close', 'restrain', 'fireFree', 'fireHold', 'report', 'shout', 'joinTeam', 'peek', 'c2', 'wedge', 'defuse', 'secure']);
const DIRS = new Set(['left', 'right', 'forward', 'back', 'there']);
const MESSAGE_FIELDS: Record<string, Set<string>> = Object.fromEntries(Object.entries({
  hello: ['t', 'name', 'ready', 'prim', 'sec'], lobbyMeta: ['t', 'ready', 'prim', 'sec'], debReady: ['t', 'ready'],
  in: ['t', 'x', 'z', 'yaw', 'pitch', 'cr', 'pr', 'ln', 'jy', 'mv', 'tc', 'ads', 'wp', 'sh', 'sp'],
  fire: ['t', 'weapon', 'dirs'], reload: ['t', 'weapon', 'speed'], ping: ['t', 'd'], bang: ['t', 'd', 'kind'],
  cmd: ['t', 'cmd', 'aim'], use: ['t'], crack: ['t'], sensor: ['t'], c2: ['t'], wedge: ['t'], peek: ['t'], shout: ['t'], breachSync: ['t'], share: ['t'],
  lobby: ['t', 'names', 'ids', 'mission', 'list', 'mods', 'preplan'],
  start: ['t', 'mission', 'seed', 'diff', 'n', 'you', 'names', 'mods', 'daily', 'shields', 'preplan'],
  snap: ['t', 's'], ev: ['t', 'e'],
}).map(([type, fields]) => [type, new Set(fields)]));

export function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
const onlyKeys = (value: Record<string, any>, allowed: readonly string[]) => Object.keys(value).every(k => allowed.includes(k));
const finite = (v: unknown, min = -10000, max = 10000): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const integer = (v: unknown, min: number, max: number): v is number => finite(v, min, max) && Number.isInteger(v);
const shortString = (v: unknown, max: number) => typeof v === 'string' && v.length <= max;
const vec3 = (v: unknown) => Array.isArray(v) && v.length === 3 && v.every(n => finite(n, -1.1, 1.1)) && Math.hypot(v[0], v[1], v[2]) >= 0.5 && Math.hypot(v[0], v[1], v[2]) <= 1.5;
const coords3 = (v: unknown) => Array.isArray(v) && v.length === 3 && v.every(n => finite(n, -256, 256));
const validLoadout = (primary: unknown, secondary: unknown) => PRIMARY.has(String(primary)) && SECONDARY.has(String(secondary));

function validMods(v: unknown) {
  return isRecord(v) && onlyKeys(v, ['blackout', 'extraHostiles', 'pistolOnly', 'friendlyFire', 'daily', 'roster'])
    && (v.blackout === undefined || typeof v.blackout === 'boolean')
    && (v.extraHostiles === undefined || integer(v.extraHostiles, 0, 8))
    && (v.pistolOnly === undefined || typeof v.pistolOnly === 'boolean')
    && (v.friendlyFire === undefined || typeof v.friendlyFire === 'boolean')
    && (v.daily === undefined || typeof v.daily === 'boolean')
    && (v.roster === undefined || (Array.isArray(v.roster) && v.roster.length <= 4 && v.roster.every((r: unknown) => isRecord(r)
      && onlyKeys(r, ['name', 'role', 'speed', 'hp']) && shortString(r.name, 24) && shortString(r.role, 24) && finite(r.speed, 0, 10) && finite(r.hp, 0, 200))));
}
function validPreplan(v: unknown) {
  if (v === undefined) return true;
  if (!isRecord(v) || !onlyKeys(v, ['entry', 'teamA', 'teamB', 'pins'])) return false;
  const pts = (p: unknown) => p === undefined || (Array.isArray(p) && p.length <= 128 && p.every((q: unknown) => isRecord(q)
    && onlyKeys(q, ['x', 'z']) && finite(q.x, -256, 256) && finite(q.z, -256, 256)));
  const pins = v.pins === undefined || (Array.isArray(v.pins) && v.pins.length <= 64 && v.pins.every((q: unknown) => isRecord(q)
    && onlyKeys(q, ['x', 'z', 'kind']) && finite(q.x, -256, 256) && finite(q.z, -256, 256) && (q.kind === 'c2' || q.kind === 'flash')));
  return (v.entry === undefined || integer(v.entry, 0, 64)) && pts(v.teamA) && pts(v.teamB) && pins;
}
function validLobbyList(v: unknown) {
  return v === undefined || (Array.isArray(v) && v.length <= 4 && v.every((p: unknown) => isRecord(p)
    && onlyKeys(p, ['name', 'peerId', 'ready', 'prim', 'sec', 'speaking', 'debReady'])
    && shortString(p.name, 32) && shortString(p.peerId, 120)
    && typeof p.ready === 'boolean' && PRIMARY.has(p.prim) && SECONDARY.has(p.sec)
    && (p.speaking === undefined || typeof p.speaking === 'boolean')
    && (p.debReady === undefined || typeof p.debReady === 'boolean')));
}
function validCommand(v: unknown) {
  return isRecord(v) && onlyKeys(v, ['team', 'action', 'dir', 'who']) && (v.team === 'A' || v.team === 'B' || v.team === 'ALL')
    && typeof v.action === 'string' && ACTIONS.has(v.action)
    && (v.dir === undefined || (typeof v.dir === 'string' && DIRS.has(v.dir)))
    && (v.who === undefined || integer(v.who, 0, 3));
}

/** Accept only the small, known wire protocol; peer payloads are always untrusted. */
function validMessage(m: Record<string, any>): boolean {
  if (!Object.prototype.hasOwnProperty.call(MESSAGE_FIELDS, m.t)) return false;
  const fields = MESSAGE_FIELDS[m.t];
  if (!fields || Object.keys(m).some(key => !fields.has(key))) return false;
  switch (m.t) {
    case 'hello': return shortString(m.name, 32) && typeof m.ready === 'boolean' && validLoadout(m.prim, m.sec);
    case 'lobbyMeta': return typeof m.ready === 'boolean' && validLoadout(m.prim, m.sec);
    case 'debReady': return typeof m.ready === 'boolean';
    case 'in': return finite(m.x, -256, 256) && finite(m.z, -256, 256)
      && finite(m.yaw, -Math.PI, Math.PI) && finite(m.pitch, -1.55, 1.55)
      && typeof m.cr === 'boolean' && typeof m.pr === 'boolean' && finite(m.ln, -1, 1)
      && finite(m.jy, 0, 1) && typeof m.mv === 'boolean' && typeof m.tc === 'boolean'
      && typeof m.ads === 'boolean' && integer(m.wp, 0, 1) && typeof m.sh === 'boolean'
      && typeof m.sp === 'boolean';
    case 'fire': return integer(m.weapon, 0, 1) && Array.isArray(m.dirs) && m.dirs.length >= 1 && m.dirs.length <= 8 && m.dirs.every(vec3);
    case 'reload': return integer(m.weapon, 0, 1) && typeof m.speed === 'boolean';
    case 'ping': return vec3(m.d);
    case 'bang': return vec3(m.d) && (m.kind === 'bang' || m.kind === 'smoke' || m.kind === 'gas');
    case 'cmd': return validCommand(m.cmd) && (m.aim === null || (isRecord(m.aim) && onlyKeys(m.aim, ['x', 'z']) && finite(m.aim.x, -256, 256) && finite(m.aim.z, -256, 256)));
    case 'use': case 'crack': case 'sensor': case 'c2': case 'wedge': case 'peek': case 'shout': case 'breachSync': case 'share':
      return Object.keys(m).length === 1;
    case 'lobby': return Array.isArray(m.names) && m.names.length >= 1 && m.names.length <= 4 && m.names.every((n: unknown) => shortString(n, 32))
      && Array.isArray(m.ids) && m.ids.length === m.names.length && m.ids.every((id: unknown) => shortString(id, 120))
      && integer(m.mission, 0, 64) && validLobbyList(m.list) && validMods(m.mods) && validPreplan(m.preplan);
    case 'start': return integer(m.mission, 0, 64) && integer(m.seed, -2147483648, 2147483647)
      && integer(m.diff, 0, 2) && integer(m.n, 1, 4) && integer(m.you, 0, 3)
      && Array.isArray(m.names) && m.names.length === m.n && m.names.every((n: unknown) => shortString(n, 32))
      && validMods(m.mods) && (m.daily === undefined || typeof m.daily === 'boolean')
      && Array.isArray(m.shields) && m.shields.length === m.n && m.shields.every((x: unknown) => typeof x === 'boolean')
      && validPreplan(m.preplan);
    case 'snap': return isRecord(m.s);
    case 'ev': return Array.isArray(m.e) && m.e.length <= 800 && m.e.every(isRecord);
    default: return false;
  }
}

/** Normalize peer data through JSON so prototypes/getters never reach game handlers. */
export function normalizePeerEnvelopeWithSize(value: unknown): { message: Msg | null; bytes: number } | null {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return null;
    // Oversize packets are rejected, but still debit the capped byte budget so invalid traffic
    // cannot spend unlimited CPU by repeatedly forcing JSON normalization.
    if (serialized.length > MAX_PEER_MESSAGE_BYTES) return { message: null, bytes: MAX_PEER_MESSAGE_BYTES };
    const bytes = new TextEncoder().encode(serialized).byteLength;
    if (bytes > MAX_PEER_MESSAGE_BYTES) return { message: null, bytes: MAX_PEER_MESSAGE_BYTES };
    const parsed: unknown = JSON.parse(serialized);
    const message = isRecord(parsed) && typeof parsed.t === 'string' && parsed.t.length <= 32 && validMessage(parsed)
      ? parsed as Msg
      : null;
    return { message, bytes };
  } catch {
    return null;
  }
}

export function normalizePeerMessageWithSize(value: unknown): { message: Msg; bytes: number } | null {
  const envelope = normalizePeerEnvelopeWithSize(value);
  return envelope?.message ? { message: envelope.message, bytes: envelope.bytes } : null;
}

export function normalizePeerMessage(value: unknown): Msg | null {
  return normalizePeerMessageWithSize(value)?.message ?? null;
}

export interface PeerReceiveBudget {
  messages: number;
  bytes: number;
  updatedAt: number;
}

function refillPeerBudget(budget: PeerReceiveBudget, now: number) {
  const elapsed = Math.max(0, (now - budget.updatedAt) / 1000);
  budget.updatedAt = now;
  budget.messages = Math.min(120, budget.messages + elapsed * 80);
  budget.bytes = Math.min(32 * 1024 * 1024, budget.bytes + elapsed * 4 * 1024 * 1024);
}

/** Cheap first-stage rate limit, checked before serializing untrusted message contents. */
export function consumePeerMessageToken(budget: PeerReceiveBudget, now = performance.now()): boolean {
  refillPeerBudget(budget, now);
  if (budget.messages < 1) return false;
  budget.messages -= 1;
  return true;
}

/** Account for serialized bytes after schema normalization has produced a bounded payload. */
export function consumePeerBytes(budget: PeerReceiveBudget, bytes: number, now = performance.now()): boolean {
  refillPeerBudget(budget, now);
  if (!Number.isFinite(bytes) || bytes < 0) return false;
  if (budget.bytes < bytes) { budget.bytes = 0; return false; }
  budget.bytes -= bytes;
  return true;
}

/** Bound both packet rate and aggregate input size per connection. */
export function consumePeerBudget(budget: PeerReceiveBudget, bytes: number, now = performance.now()): boolean {
  return consumePeerMessageToken(budget, now) && consumePeerBytes(budget, bytes, now);
}

