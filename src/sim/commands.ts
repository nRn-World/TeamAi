// Natural-language (English) voice & text command parser. Pure function, unit-tested.
import type { Command, Action, Dir, Team } from './sim';

const norm = (s: string) => ' ' + s.toLowerCase().replace(/[.,!?;:"\-–]/g, ' ').replace(/\s+/g, ' ').trim() + ' ';

const fix = (re: RegExp) => new RegExp(re.source.replace(/\\b\(/g, '(?<= )(').replace(/\)\\b/g, ')(?= )'));

const TEAM_A = fix(/\b(team|teem|tim|squad|group|element)\s*(a|ay|eh|hey|alpha|alfa|one|1|red)\b|\b(alpha|alfa|red team|a team|a-team|teama)\b/);
const TEAM_B = fix(/\b(team|teem|tim|squad|group|element)\s*(b|be|bee|bravo|two|2|blue)\b|\b(bravo|blue team|b team|b-team|teamb)\b/);
const TEAM_ALL = fix(/\b(everyone|everybody|all teams|both teams|all of you|whole team|all|team|guys|squad)\b/);

// One officer by name (same order as OFFICER_NAMES), with spellings speech recognition tends to produce.
const NAMES = [
  /\b(ken|kenn|kent|kenny|kenneth|kan)\b|^ (can) /,
  /\b(maya|maia|mya|mayer|myer|maja|my a)\b/,
  /\b(jack|jak|jacques|jacks|jac)\b|^ (jock) /,
  /\b(zoe|zoey|zooey|zoë|zoie|zoé|zo e)\b|^ (joey) /,
].map(fix);

// Reassigning an officer to Team A or Team B (e.g. "Maya join Team B", "put Ken on Alpha").
const JOIN_TEAM = fix(/\b(join|switch to|move to|go to|transfer to|assign to|put .+ (?:on|in|to)|you are (?:on|in)|you're (?:on|in))\b/);

// Ordered by priority: first match wins.
const RULES: [Action, RegExp, Dir?][] = ([
  ['shout', /\b(police|hands up|hands in the air|show me your hands|drop (the|your|that) (gun|weapon)|drop it|put (the|your) (gun|weapon) down|put it down|get down|on the ground|on your knees|give up|surrender|freeze)\b/],
  ['fireHold', /\b(hold fire|hold your fire|cease fire|ceasefire|don't shoot|do not shoot|weapons tight|weapons hold)\b/],
  ['fireFree', /\b(weapons free|fire at will|open fire|free fire|engage)\b/],
  ['defuse', /\b(defuse|disarm|deactivate|stop the bomb|cut the wire)\b/],
  ['c2', /\b(c2|c 2|breach charge|blow (the|that)? ?door|explosive breach|charge (the|that) door|detonate)\b/],
  ['wedge', /\b(wedge|block (the|that) door|jam (the|that) door|seal (the|that) door)\b/],
  ['peek', /\b(peek|fibercam|fiber cam|optiwand|mirror|check under|look under|scout (the|that) door|check (the|that) door)\b/],
  ['bang', /\b(flashbang|flash bang|flash and clear|bang and clear|bang|grenade|stun grenade|flash|flush|flesh)\b/],
  ['breach', /\b(breach|breaching|storm|clear|clear the room|move in|go in|get in|enter|take the room|kick it|kick the door)\b/],
  ['stack', /\b(stack up|stack|line up|on the door|at the door|to the door)\b/],
  ['close', /\b(close|shut)\b/],
  ['open', /\b(open|opens)\b/],
  ['restrain', /\b(restrain|cuff|cuffs|cuff them|cuff him|cuff her|handcuff|handcuffs|arrest|secure|zip ?tie|tie them)\b/],
  ['cover', /\b(cover|cover me|cover us|protect|protect me|protect us|watch my|guard|my back|my six)\b/],
  ['report', /\b(report|status|sitrep|sit rep)\b/],
  ['move', /\b(over there|there|that position|that spot)\b/, 'there'],
  ['move', /\b(left)\b/, 'left'],
  ['move', /\b(right)\b/, 'right'],
  ['follow', /\b(follow|follow me|on me|regroup|with me|come back(?: to me)?|back to me|come|come here|come with me|fall in|to me)\b/],
  ['move', /\b(back|backwards|fall back|retreat|pull back|back up)\b/, 'back'],
  ['move', /\b(forward|forwards|advance|move up|push|push up|go ahead)\b/, 'forward'],
  ['hold', /\b(hold|hold position|hold here|stop|stay|stay here|wait|halt|stand by)\b/],
  ['stack', /\b(door)\b/],
] as [Action, RegExp, Dir?][]).map(([a, re, d]) => [a, fix(re), d]);

const YOU_WORD = fix(/\b(you)\b/);

/** `lastWho`: the officer the previous order went to, so that «you cover us» keeps talking to the same one. */
export function parseCommand(text: string, lastTeam: Team | 'ALL' = 'ALL', lastWho: number | null = null): Command | null {
  let s = norm(text);

  // Check for officer + destination team reassignment first (e.g. "Maya join Team B", "put Ken on Team A").
  const a = TEAM_A.exec(s), b = TEAM_B.exec(s);
  const namedAll = NAMES.map((re, i) => (re.test(s) ? i : -1)).filter(i => i >= 0);
  if ((a || b) && !(a && b) && JOIN_TEAM.test(s)) {
    const destTeam: Team = a ? 'A' : 'B';
    if (namedAll.length === 1) return { team: destTeam, action: 'joinTeam', who: namedAll[0] };
    if (lastWho != null && YOU_WORD.test(s)) return { team: destTeam, action: 'joinTeam', who: lastWho };
    if (TEAM_ALL.test(s)) return { team: destTeam, action: 'joinTeam' };
  }

  let team: Team | 'ALL' | null = null, who: number | undefined;
  if (a && b) team = 'ALL'; else if (a) team = 'A'; else if (b) team = 'B';
  // strip team words so e.g. "team b" is not parsed as something else
  s = s.replace(TEAM_A, ' ').replace(TEAM_B, ' ');
  if (!team) {
    const named = NAMES.map((re, i) => (re.test(s) ? i : -1)).filter(i => i >= 0);
    if (named.length === 1) { who = named[0]; s = s.replace(NAMES[who], ' '); }
    else if (TEAM_ALL.test(s)) team = 'ALL';
    else if (lastWho != null && YOU_WORD.test(s)) who = lastWho;
  }
  for (const [action, re, dir] of RULES) {
    if (re.test(s)) {
      if (action === 'shout') { if ((team && team !== 'ALL') || who != null) continue; return { team: 'ALL', action }; }
      if (who != null) return { team: team ?? (who < 2 ? 'A' : 'B'), action, dir, who };
      return { team: team ?? lastTeam, action, dir };
    }
  }
  return null;
}

export interface ParsedBatch {
  commands: Command[];
  relayFrom?: number; // officer index if player asked one officer to relay to another unit
}

const RELAY_PREFIX = /^\s*(?:(ken|kenn|kent|kenny|maya|maia|maja|jack|zoe|zoey)\s*[,:]?\s*)?(?:tell|inform|ask|relay to|pass on to|say to)\s+(.+?)\s+(?:to|that)\s+(.+)$/i;

/** Parses compound utterances (e.g. "Ken follow me, Maya join Team B, Team B cover me") or relay phrases. */
export function parseCommands(text: string, lastTeam: Team | 'ALL' = 'ALL', lastWho: number | null = null): ParsedBatch {
  const trimmed = text.trim();
  if (!trimmed) return { commands: [] };

  // Relay pattern: "Ken, tell Team B to breach"
  const rel = RELAY_PREFIX.exec(trimmed);
  if (rel) {
    let relayFrom: number | undefined;
    if (rel[1]) {
      const ns = norm(rel[1]);
      const idx = NAMES.findIndex(re => re.test(ns));
      if (idx >= 0) relayFrom = idx;
    }
    const targetAndOrder = `${rel[2]} ${rel[3]}`;
    const sub = parseCommands(targetAndOrder, lastTeam, lastWho);
    if (sub.commands.length) return { commands: sub.commands, relayFrom };
  }

  // Protect "flash and clear", "bang and clear", "team a and team b" before splitting clauses.
  const safe = trimmed
    .replace(/\b(flash|bang)\s+and\s+clear\b/gi, '$1_and_clear')
    .replace(/\b(team\s*a|alpha)\s+and\s+(team\s*b|bravo)\b/gi, '$1_both_$2');

  const parts = safe
    .split(/\s*(?:[,.;]+|\b(?:and then|and|then|while)\b)\s*/i)
    .map(p => p.replace(/_and_clear/g, ' and clear').replace(/_both_/g, ' and ').trim())
    .filter(Boolean);

  if (parts.length <= 1) {
    const c = parseCommand(trimmed, lastTeam, lastWho);
    return { commands: c ? [c] : [] };
  }

  const out: Command[] = [];
  let curTeam: Team | 'ALL' = lastTeam;
  let curWho: number | null = lastWho;
  for (const part of parts) {
    const ns = norm(part);
    const hasExplicitTarget = TEAM_A.test(ns) || TEAM_B.test(ns) || TEAM_ALL.test(ns) || NAMES.some(re => re.test(ns));
    const c = parseCommand(part, curTeam, curWho);
    if (c) {
      // Carry forward the active single officer across chained clauses like "Maya open the door and go in"
      if (!hasExplicitTarget && curWho != null && c.who == null && c.action !== 'shout') {
        c.who = curWho;
        c.team = curTeam === 'ALL' ? (curWho < 2 ? 'A' : 'B') : curTeam;
      }
      out.push(c);
      curTeam = c.team;
      curWho = c.who ?? null;
    } else {
      if (TEAM_A.test(ns)) { curTeam = 'A'; curWho = null; }
      else if (TEAM_B.test(ns)) { curTeam = 'B'; curWho = null; }
      else if (TEAM_ALL.test(ns)) { curTeam = 'ALL'; curWho = null; }
      else {
        const who = NAMES.findIndex(re => re.test(ns));
        if (who >= 0) { curWho = who; curTeam = who < 2 ? 'A' : 'B'; }
      }
    }
  }
  if (!out.length) {
    const c = parseCommand(trimmed, lastTeam, lastWho);
    return { commands: c ? [c] : [] };
  }
  return { commands: out };
}

/** Compatibility helper used by tools/check-ai.mts. */
export function splitOrders(text: string, lastTeam: Team | 'ALL' = 'ALL', lastWho: number | null = null): { text: string; cmd: Command | null }[] {
  const { commands } = parseCommands(text, lastTeam, lastWho);
  return commands.length ? commands.map(cmd => ({ text, cmd })) : [{ text, cmd: null }];
}

const CONVERSATIONAL_HINT = /\?|\b(tell|inform|relay|ask|say to|why|what|where|who|how|when|do you see|can you|could you|are there|status|situation|please|make sure|want you to|need you to|check)\b/i;

/** Returns true when an utterance is conversational, a question, a relay request, or nuanced natural English for the AI brain. */
export function shouldUseAiBrain(text: string, batch: ParsedBatch): boolean {
  if (!batch.commands.length) return true;
  if (batch.relayFrom !== undefined) return true;
  if (CONVERSATIONAL_HINT.test(text)) return true;
  const words = text.trim().split(/\s+/).length;
  if (words > 7 && batch.commands.length === 1) return true;
  return false;
}

export const ACTION_LABEL: Record<Action, string> = {
  follow: 'FOLLOW ME', hold: 'HOLD POSITION', move: 'MOVE', cover: 'COVER ME', stack: 'STACK UP ON DOOR', breach: 'BREACH THE ROOM', bang: 'BANG AND CLEAR',
  open: 'OPEN DOOR', close: 'CLOSE DOOR', restrain: 'SECURE / HANDCUFF', fireFree: 'WEAPONS FREE', fireHold: 'HOLD FIRE', report: 'REPORT', shout: 'POLICE! GIVE UP!', joinTeam: 'JOIN TEAM',
  peek: 'PEEK / FIBERCAM', c2: 'BREACH CHARGE', wedge: 'WEDGE DOOR', defuse: 'DEFUSE BOMB',
};
export const DIR_LABEL: Record<Dir, string> = { left: 'LEFT', right: 'RIGHT', forward: 'FORWARD', back: 'BACK', there: 'THERE' };
