// Career progression: ranks and the gear they unlock, campaign order, the officer
// roster (who is recovering after an operation) and the ironman rule.
// Everything here is plain logic so it can be unit-tested outside the browser;
// loadCareer/saveCareer are the only functions that touch localStorage.

export type GearKey = 'carbine' | 'shotgun' | 'beanbag' | 'shield' | 'pistol' | 'taser';

export const GEAR_NAMES: Record<GearKey, string> = {
  carbine: 'TX-4 Carbine',
  shotgun: 'S-87 Breacher Shotgun',
  beanbag: 'LL-12 Kinetic Launcher',
  shield: 'Ballistic Shield',
  pistol: 'P-17 Service Pistol',
  taser: 'ARC-2 Stunner',
};

export interface RankDef { xp: number; name: string; gear?: GearKey; note: string }

/** Ranks are the progression spine: every step opens one piece of kit. */
export const RANKS: RankDef[] = [
  { xp: 0, name: 'Rookie Officer', note: 'TX-4 carbine and P-17 pistol' },
  { xp: 200, name: 'Tactical Officer', gear: 'taser', note: 'ARC-2 stunner unlocked' },
  { xp: 500, name: 'Senior Breacher', gear: 'shotgun', note: 'S-87 breacher shotgun unlocked' },
  { xp: 950, name: 'Entry Team Lead', gear: 'beanbag', note: 'LL-12 kinetic launcher unlocked' },
  { xp: 1500, name: 'Tactical Commander', gear: 'shield', note: 'Ballistic shield unlocked' },
  { xp: 2400, name: 'Master Operator', note: '+20 % XP on every operation' },
];

export const rankIndex = (xp: number) => RANKS.reduce((best, r, i) => (xp >= r.xp ? i : best), 0);
export const rankOf = (xp: number) => RANKS[rankIndex(xp)];
export const nextRank = (xp: number) => RANKS.find(r => r.xp > xp);
export const isMaster = (xp: number) => xp >= RANKS[RANKS.length - 1].xp;

/** XP needed before a piece of kit may be taken on an operation. */
export function gearUnlockXp(key: GearKey): number {
  const r = RANKS.find(r => r.gear === key);
  return r ? r.xp : 0;
}
export function isGearUnlocked(key: GearKey, xp: number): boolean {
  return xp >= gearUnlockXp(key);
}
/** Rank name shown next to a locked item. */
export function gearLockLabel(key: GearKey): string {
  const r = RANKS.find(r => r.gear === key);
  return r ? `${r.name} (${r.xp} XP)` : '';
}

export interface SquadMember { name: string; role: string; perk: string }
export const SQUAD: SquadMember[] = [
  { name: 'Ken', role: 'Pointman', perk: 'faster movement' },
  { name: 'Maya', role: 'Breacher', perk: 'extra flashbang & breach charge' },
  { name: 'Jack', role: 'Marksman', perk: 'sharper rifle aim' },
  { name: 'Zoe', role: 'Negotiator', perk: 'better surrender & cuffing' },
];
const ROOKIE_NAMES = ['Vasquez', 'Okafor', 'Lind', 'Haddad', 'Moreau', 'Tanaka', 'Novak', 'Reyes'];

export interface OfficerRecord { opsOut: number }

export interface CareerState {
  xp: number;
  ops: number;
  arrests: number;
  /** One entry per SQUAD slot: how many operations the officer still sits out. */
  roster: OfficerRecord[];
  ironman: boolean;
  tutorialDone: boolean;
}

export function defaultCareer(): CareerState {
  return { xp: 0, ops: 0, arrests: 0, roster: SQUAD.map(() => ({ opsOut: 0 })), ironman: false, tutorialDone: false };
}

/** Merges whatever was stored in an older save into a complete career record. */
export function normaliseCareer(raw: unknown): CareerState {
  const base = defaultCareer();
  const src = (raw && typeof raw === 'object' ? raw : {}) as Partial<CareerState>;
  const out: CareerState = {
    xp: Math.max(0, Number(src.xp) || 0),
    ops: Math.max(0, Number(src.ops) || 0),
    arrests: Math.max(0, Number(src.arrests) || 0),
    roster: base.roster.map((r, i) => {
      const stored = Array.isArray(src.roster) ? src.roster[i] : undefined;
      return { opsOut: Math.max(0, Math.min(9, Math.floor(Number(stored?.opsOut) || 0))) };
    }),
    ironman: !!src.ironman,
    tutorialDone: !!src.tutorialDone,
  };
  return out;
}

const KEY = 'teamai.career';
const store = () => (typeof localStorage === 'undefined' ? null : localStorage);

export function loadCareer(): CareerState {
  const s = store();
  if (!s) return defaultCareer();
  try { return normaliseCareer(JSON.parse(s.getItem(KEY) || '{}')); } catch { return defaultCareer(); }
}
export function saveCareer(c: CareerState) {
  const s = store();
  if (!s) return;
  try { s.setItem(KEY, JSON.stringify(c)); } catch { /* private mode */ }
}

/** Campaign order: an operation opens when the one before it has been completed. */
export function missionUnlocked(cleared: Record<string, number>, index: number): boolean {
  if (index <= 0) return true;
  return cleared[index - 1] != null;
}
export function clearedCount(cleared: Record<string, number>): number {
  return Object.keys(cleared).filter(k => cleared[k] != null).length;
}
export function nextUncleared(cleared: Record<string, number>, total: number): number | null {
  for (let i = 0; i < total; i++) if (cleared[i] == null) return i;
  return null;
}
export function campaignComplete(cleared: Record<string, number>, total: number): boolean {
  for (let i = 0; i < total; i++) if (cleared[i] == null) return false;
  return true;
}

/** Who actually walks in the door tonight: recovering officers are replaced by rookies. */
export interface DeployedOfficer { name: string; role: string; speed: number; hp: number; rookie: boolean; recovering: number }

export function deployRoster(career: CareerState): DeployedOfficer[] {
  return SQUAD.map((m, i) => {
    const out = career.roster[i]?.opsOut ?? 0;
    if (out > 0) {
      return {
        name: `Rookie ${ROOKIE_NAMES[(i + career.ops) % ROOKIE_NAMES.length]}`,
        role: 'Rookie', speed: 3.65, hp: 82, rookie: true, recovering: out,
      };
    }
    return {
      name: m.name, role: m.role,
      speed: i === 0 ? 4.25 : 3.9, hp: 100, rookie: false, recovering: 0,
    };
  });
}

export interface MissionResult {
  win: boolean;
  mission: number;
  score: number;
  /** Names of officers that ended the operation down. */
  downed: string[];
  ironman: boolean;
}

export interface AppliedResult {
  xpBefore: number;
  xpGained: number;
  xpAfter: number;
  rankUp: RankDef | null;
  unlocked: GearKey[];
  injured: { name: string; ops: number }[];
  healed: string[];
  ironmanPenalty: boolean;
}

/**
 * Books the outcome: XP, unlocks, injuries for the next operations and the
 * recovery countdown. Ironman failures earn nothing.
 */
export function applyMissionResult(career: CareerState, res: MissionResult): AppliedResult {
  const xpBefore = career.xp;
  const rankBefore = rankIndex(career.xp);
  const penalty = res.ironman && !res.win;
  const xpGained = res.win && !penalty
    ? Math.round(Math.max(25, res.score) * (isMaster(career.xp) ? 1.2 : 1))
    : 0;
  career.xp = xpBefore + xpGained;
  const rankAfter = rankIndex(career.xp);
  const unlocked = RANKS.slice(rankBefore + 1, rankAfter + 1)
    .map(r => r.gear)
    .filter((g): g is GearKey => !!g);

  // recovery countdown, then new injuries from this operation
  const healed: string[] = [];
  career.roster.forEach((r, i) => {
    if (r.opsOut > 0) { r.opsOut--; if (r.opsOut === 0) healed.push(SQUAD[i].name); }
  });
  const injured: { name: string; ops: number }[] = [];
  // injuries only come home when the operation is seen through — or always, in ironman
  if ((res.win || res.ironman) && res.downed.length) {
    for (const name of res.downed) {
      const slot = SQUAD.findIndex(m => m.name === name);
      if (slot < 0) continue;
      const ops = 1 + ((career.ops + slot) % 3);
      career.roster[slot].opsOut = Math.max(career.roster[slot].opsOut, ops);
      injured.push({ name: SQUAD[slot].name, ops });
    }
  }
  if (res.win) { career.ops++; }
  return {
    xpBefore,
    xpGained,
    xpAfter: career.xp,
    rankUp: rankAfter > rankBefore ? RANKS[rankAfter] : null,
    unlocked,
    injured,
    healed,
    ironmanPenalty: penalty,
  };
}

/** A one-line summary of where the campaign stands. */
export function campaignLine(cleared: Record<string, number>, total: number): string {
  const done = clearedCount(cleared);
  if (done >= total) return 'CAMPAIGN COMPLETE — every sector secured';
  const next = nextUncleared(cleared, total);
  return `OPERATION ${Math.min(done + 1, total)} OF ${total}${next == null ? '' : ''}`;
}
