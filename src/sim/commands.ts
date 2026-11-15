// Natural-language (English & Swedish) voice/text command parser. Pure function, unit-tested.
import type { Command, Action, Dir, Team } from './sim';

const norm = (s: string) => ' ' + s.toLowerCase().replace(/[.,!?;:"\-–]/g, ' ').replace(/\s+/g, ' ').trim() + ' ';

const fix = (re: RegExp) => new RegExp(re.source.replace(/\\b\(/g, '(?<= )(').replace(/\)\\b/g, ')(?= )'));

const TEAM_A = fix(/\b(team|teem|tim|squad|group|element|lag|grupp|styrka)\s*(a|ay|eh|hey|alpha|alfa|one|1|red|röd|röda)\b|\b(alpha|alfa|red team|a team|a-team|teama|röda laget|röd grupp|lag a|grupp a|ettan)\b/);
const TEAM_B = fix(/\b(team|teem|tim|squad|group|element|lag|grupp|styrka)\s*(b|be|bee|bravo|two|2|blue|blå|blåa)\b|\b(bravo|blue team|b team|b-team|teamb|blåa laget|blå grupp|lag b|grupp b|tvåan)\b/);
const TEAM_ALL = fix(/\b(everyone|everybody|all teams|both teams|all of you|whole team|all|team|alla|allihop|allihopa|båda lagen|båda|hela teamet|hela gruppen|teamet|grabbar)\b/);

// One officer by name (same order as OFFICER_NAMES), with the spellings speech recognition tends to produce.
const NAMES = [
  /\b(ken|kenn|kent|kenny|kenneth|kan)\b|^ (can) /,
  /\b(maya|maia|mya|mayer|myer|maja|my a)\b/,
  /\b(jack|jak|jacques|jacks|jac)\b|^ (jock) /,
  /\b(zoe|zoey|zooey|zoë|zoie|zoé|zo e)\b|^ (joey) /,
].map(fix);

// Ordered by priority: first match wins.
const RULES: [Action, RegExp, Dir?][] = ([
  ['shout', /\b(police|polis|polisen|hands up|hands in the air|show me your hands|drop (the|your|that) (gun|weapon)|drop it|put (the|your) (gun|weapon) down|put it down|get down|on the ground|on your knees|give up|surrender|freeze|upp med händerna|händerna i luften|visa händerna|släpp vapnet|lägg ner vapnet|ner på marken|på knä|ge upp)\b/],
  ['fireHold', /\b(hold fire|hold your fire|cease fire|ceasefire|don't shoot|do not shoot|weapons tight|weapons hold|eld upphör|skjut inte|håll elden|spara skott)\b/],
  ['fireFree', /\b(weapons free|fire at will|open fire|free fire|engage|fri eld|skjut fritt|öppna eld)\b/],
  ['bang', /\b(flashbang|flash bang|flash and clear|bang and clear|bang|grenade|stun grenade|flash|flush|flesh|chockgranat|blända|kasta flash|släng flash|granat)\b/],
  ['breach', /\b(breach|breaching|storm|clear|clear the room|move in|go in|get in|enter|take the room|kick it|kick the door|bryt in|storma|rensa|rensa rummet|gå in|ta rummet|sparka in)\b/],
  ['stack', /\b(stack up|stack|line up|on the door|at the door|to the door|ställ upp|ställda|vid dörren|till dörren|redo vid dörren)\b/],
  ['close', /\b(close|shut|stäng|stänga)\b/],
  ['open', /\b(open|opens|öppna)\b/],
  ['restrain', /\b(restrain|cuff|cuffs|cuff them|handcuff|handcuffs|arrest|secure|zip ?tie|tie them|säkra|handfängsel|fängsla|grip|arrestera|boja|bind)\b/],
  ['cover', /\b(cover|cover me|protect|protect me|watch my|guard|my back|my six|täck|täck mig|skydda|skydda mig|håll ryggen|vakta ryggen|backa upp)\b/],
  ['report', /\b(report|status|sitrep|sit rep|rapport|lägesrapport|läge|läget|hur mår ni|var är ni|ser ni någon|ser ni något)\b/],
  ['move', /\b(over there|there|that position|that spot|dit|dit bort|där borta|den positionen|den platsen)\b/, 'there'],
  ['move', /\b(left|vänster|åt vänster)\b/, 'left'],
  ['move', /\b(right|höger|åt höger)\b/, 'right'],
  ['move', /\b(back|backwards|fall back|retreat|pull back|back up|bakåt|backa|dra er tillbaka)\b/, 'back'],
  ['follow', /\b(follow|follow me|on me|regroup|with me|come|come here|fall in|to me|följ|följ med|följ mig|kom hit|hit|med mig|till mig|samlas)\b/],
  ['move', /\b(forward|forwards|advance|move up|push|push up|go ahead|framåt|fram|ryck fram|gå fram)\b/, 'forward'],
  ['hold', /\b(hold|hold position|stop|stay|wait|halt|stand by|stanna|håll position|vänta|stå kvar|stanna där|håll)\b/],
  ['stack', /\b(door|dörr|dörren)\b/],
] as [Action, RegExp, Dir?][]).map(([a, re, d]) => [a, fix(re), d]);

const YOU_WORD = fix(/\b(you|du)\b/);

/** `lastWho`: the officer the previous order went to, so that «you cover us» / «du täcker oss» keeps talking to the same one. */
export function parseCommand(text: string, lastTeam: Team | 'ALL' = 'ALL', lastWho: number | null = null): Command | null {
  let s = norm(text);
  const a = TEAM_A.exec(s), b = TEAM_B.exec(s);
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
      if (who != null) return { team: who < 2 ? 'A' : 'B', action, dir, who };
      return { team: team ?? lastTeam, action, dir };
    }
  }
  return null;
}

export interface ParsedBatch {
  commands: Command[];
  relayFrom?: number; // officer index if player asked one officer to relay to another unit
}

const RELAY_PREFIX = /^\s*(?:(ken|kenn|kent|kenny|maya|maja|jack|zoe|zoey)\s*[,:]?\s*)?(?:tell|inform|ask|relay to|pass on to|say to|säg till|meddela|be|hälsa till)\s+(.+?)\s+(?:to|att|om att)\s+(.+)$/i;

/** Parses compound utterances (e.g. "Ken throw flash and Maya go in", "Lag A framåt och Lag B täck mig") or relay phrases. */
export function parseCommands(text: string, lastTeam: Team | 'ALL' = 'ALL', lastWho: number | null = null): ParsedBatch {
  const trimmed = text.trim();
  if (!trimmed) return { commands: [] };

  // Relay pattern: "Ken, tell Team B to breach" / "Säg till Team B att stanna"
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

  // Protect "flash and clear", "bang and clear", "team a and team b", "lag a och lag b" before splitting clauses.
  const safe = trimmed
    .replace(/\b(flash|bang)\s+and\s+clear\b/gi, '$1_and_clear')
    .replace(/\b(team\s*a|alpha)\s+and\s+(team\s*b|bravo)\b/gi, '$1_both_$2')
    .replace(/\b(lag\s*a|alfa)\s+och\s+(lag\s*b|bravo)\b/gi, '$1_both_$2')
    .replace(/\bblända\s+och\s+gå\s+in\b/gi, 'flash_and_clear');

  const parts = safe
    .split(/\s*(?:[,.;]+|\b(?:and then|and|then|while|och sedan|och sen|och|sedan|sen|medan)\b)\s*/i)
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
    const c = parseCommand(part, curTeam, curWho);
    if (c) {
      out.push(c);
      curTeam = c.team;
      curWho = c.who ?? null;
    } else {
      // Check if this part only named a team/officer for the following clause (unlikely, but safe)
      const ns = norm(part);
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

const CONVERSATIONAL_HINT = /\?|\b(tell|inform|relay|ask|say to|why|what|where|who|how|when|do you see|can you|are there|status|situation|säg|meddela|berätta|fråga|hälsa|varför|vad|var|vem|vilka|hur|ser ni|finns det|kan ni|tycker|plan|läget)\b/i;

/** Heuristic: returns true when an utterance is conversational, a question, a relay request, or unrecognized by the fast parser, so the AI brain should handle it. */
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
  open: 'OPEN DOOR', close: 'CLOSE DOOR', restrain: 'SECURE / HANDCUFF', fireFree: 'WEAPONS FREE', fireHold: 'HOLD FIRE', report: 'REPORT', shout: 'POLICE! GIVE UP!',
};
export const DIR_LABEL: Record<Dir, string> = { left: 'LEFT', right: 'RIGHT', forward: 'FORWARD', back: 'BACK', there: 'THERE' };
