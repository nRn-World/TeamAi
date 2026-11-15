// Natural-language voice command parser (English, plus the Swedish words for the same orders). Pure function, unit-tested.
import type { Command, Action, Dir, Team } from './sim';

const norm = (s: string) => ' ' + s.toLowerCase().replace(/[.,!?;:"\-–]/g, ' ').replace(/\s+/g, ' ').trim() + ' ';

const fix = (re: RegExp) => new RegExp(re.source.replace(/\\b\(/g, '(?<= )(').replace(/\)\\b/g, ')(?= )'));

const TEAM_A = fix(/\b(team|teem|tim|squad|group|element)\s*(a|ay|eh|hey|alpha|alfa|one|1|red)\b|\b(alpha|alfa|red team|a team|a-team|teama|röda laget)\b|\b(lag|laget|grupp)\s*(a|ett|1|alfa|röd)\b/);
const TEAM_B = fix(/\b(team|teem|tim|squad|group|element)\s*(b|be|bee|bravo|two|2|blue)\b|\b(bravo|blue team|b team|b-team|teamb|blå laget)\b|\b(lag|laget|grupp)\s*(b|be|två|2|bravo|blå)\b/);
const TEAM_ALL = fix(/\b(everyone|everybody|all teams|both teams|all of you|whole team|all|team|alla|allihop|båda lagen|båda|hela laget)\b/);
/** Words that clearly start an order to everybody (unlike a bare «all» or «team»). */
const EVERYONE = fix(/\b(everyone|everybody|all teams|both teams|all of you|whole team|alla|allihop|båda lagen|hela laget)\b/);

// One officer by name (same order as OFFICER_NAMES), with the spellings speech recognition tends to produce.
const NAMES = [/\b(ken|kenn|kent|kenny|kenneth|kan)\b|^ (can) /, /\b(maya|maia|mya|mayer|myer|maja|my a)\b/, /\b(jack|jak|jacques|jacks|jac)\b|^ (jock) /, /\b(zoe|zoey|zooey|zoë|zoie|zoé|zo e)\b|^ (joey) /].map(fix);

// Ordered by priority: first match wins.
const RULES: [Action, RegExp, Dir?][] = ([
  ['shout', /\b(police|hands up|hands in the air|show me your hands|drop (the|your|that) (gun|weapon)|drop it|put (the|your) (gun|weapon) down|put it down|get down|on the ground|on your knees|give up|surrender|freeze|polis|upp med händerna|släpp vapnet|släpp pistolen|ner på marken|ner på knä|ge upp|stå still)\b/],
  ['fireHold', /\b(hold fire|hold your fire|cease fire|ceasefire|don't shoot|do not shoot|weapons tight|weapons hold|eld upphör|skjut inte|sluta skjuta|sluta skjut)\b/],
  ['fireFree', /\b(weapons free|fire at will|open fire|free fire|engage|fri eld|eld fritt|öppna eld|skjut fritt)\b/],
  ['bang', /\b(flashbang|flash bang|flash and clear|bang and clear|bang|grenade|stun grenade|flash|flush|flesh|chockgranat|granat|fläsh)\b/],
  ['breach', /\b(breach|breaching|storm|clear|clear the room|move in|go in|get in|enter|take the room|kick it|kick the door|storma|stormar|gå in|går in|gå in i|rensa|rensar|sparka in)\b/],
  ['stack', /\b(stack up|stack|line up|on the door|at the door|to the door|ställ upp|ställer upp|vid dörren|till dörren)\b/],
  ['close', /\b(close|shut|stäng|stänger)\b/],
  ['open', /\b(open|opens|öppna|öppnar)\b/],
  ['restrain', /\b(restrain|cuff|cuffs|cuff them|handcuff|handcuffs|arrest|secure|zip ?tie|tie them|handbojor|handboja|boja|bojor|grip|gripa|griper|säkra|säkrar|fängsla)\b/],
  ['cover', /\b(cover|cover me|protect|protect me|watch my|guard|my back|my six|täck|täcker|täcka|skydda|skyddar|bevaka|bevakar|min rygg)\b/],
  ['report', /\b(report|status|sitrep|sit rep|rapportera|rapport|läget)\b/],
  ['move', /\b(over there|there|that position|that spot|dit|ditåt|där borta|den positionen)\b/, 'there'],
  ['follow', /\b(come back|back to me|back on me|back here|kom tillbaka|tillbaka till mig|tillbaka hit)\b/],
  ['move', /\b(left|vänster)\b/, 'left'],
  ['move', /\b(right|höger)\b/, 'right'],
  ['move', /\b(back|backwards|fall back|retreat|pull back|back up|bakåt|tillbaka|backa|backar|reträtt)\b/, 'back'],
  ['follow', /\b(follow|follow me|on me|regroup|with me|come|come here|fall in|to me|följ|följer|följa|följ mig|kom|kommer|kom hit|med mig|till mig)\b/],
  ['move', /\b(forward|forwards|advance|move up|push|push up|go ahead|framåt|fram|avancera)\b/, 'forward'],
  ['hold', /\b(hold|hold position|stop|stay|wait|halt|stand by|stanna|stannar|vänta|väntar|håll|håller|stopp|stå kvar|stannar kvar)\b/],
  ['stack', /\b(door|dörr|dörren)\b/],
] as [Action, RegExp, Dir?][]).map(([a, re, d]) => [a, fix(re), d]);

/** Who a sentence is addressed to, and the sentence with those words taken out. */
export interface Addressee { team: Team | 'ALL' | null; who?: number; explicit: boolean; rest: string }
export function addressee(text: string, lastWho: number | null = null): Addressee {
  let s = norm(text);
  const a = TEAM_A.test(s), b = TEAM_B.test(s);
  let team: Team | 'ALL' | null = a && b ? 'ALL' : a ? 'A' : b ? 'B' : null, who: number | undefined, explicit = !!team;
  // strip team words so e.g. "team b" is not parsed as something else
  s = s.replace(TEAM_A, ' ').replace(TEAM_B, ' ');
  if (!team) {
    const named = NAMES.map((re, i) => (re.test(s) ? i : -1)).filter(i => i >= 0);
    if (named.length === 1) { who = named[0]; s = s.replace(NAMES[who], ' '); explicit = true; }
    else if (TEAM_ALL.test(s)) { team = 'ALL'; explicit = EVERYONE.test(s) || named.length > 1; }
    else if (lastWho != null && / (you|du) /.test(s)) who = lastWho;
  }
  return { team, who, explicit, rest: s };
}
const build = (ad: Addressee, action: Action, dir: Dir | undefined, lastTeam: Team | 'ALL'): Command | null => {
  if (action === 'shout') return (ad.team && ad.team !== 'ALL') || ad.who != null ? null : { team: 'ALL', action };
  if (ad.who != null) return { team: ad.who < 2 ? 'A' : 'B', action, dir, who: ad.who };
  return { team: ad.team ?? lastTeam, action, dir };
};
/** `lastWho`: the officer the previous order went to, so that «you cover us» keeps talking to the same one. */
export function parseCommand(text: string, lastTeam: Team | 'ALL' = 'ALL', lastWho: number | null = null): Command | null {
  const ad = addressee(text, lastWho);
  for (const [action, re, dir] of RULES) if (re.test(ad.rest)) { const c = build(ad, action, dir, lastTeam); if (c) return c; }
  return null;
}

/** One order inside a longer sentence: the words, who they are for, and the order if the fixed rules could read it. */
export interface Part { text: string; ad: Addressee; cmd: Command | null }
const JOIN = / (?:and then|and|then|while|after that|och sedan|och sen|och|medan|sedan|sen|samtidigt som) /;
/**
 * «Ken cover the door while Team B goes in with a flash» → two parts. A joining word only starts a new part when the
 * words after it name somebody else, so «bang and clear» or «open the door and go in» stay one order.
 */
export function splitOrders(text: string, lastTeam: Team | 'ALL' = 'ALL', lastWho: number | null = null): Part[] {
  const bits = norm(text).split(JOIN).map(b => b.trim()).filter(Boolean), groups: string[] = [];
  for (const b of bits) { if (!groups.length || addressee(b).explicit) groups.push(b); else groups[groups.length - 1] += ' and ' + b; }
  const parts: Part[] = []; let lt = lastTeam, lw = lastWho;
  for (const g of groups) {
    const ad = addressee(g, lw), cmd = parseCommand(g, lt, lw); parts.push({ text: g, ad, cmd });
    if (cmd && cmd.action !== 'shout') { lt = cmd.team; lw = cmd.who ?? null; } else if (ad.explicit) { lw = ad.who ?? null; if (ad.team) lt = ad.team; else if (ad.who != null) lt = ad.who < 2 ? 'A' : 'B'; }
  }
  return parts;
}
/** An order for a part the rules could not read, from an action found some other way (the language model). */
export function commandFor(part: Part, action: Action, dir: Dir | undefined, lastTeam: Team | 'ALL', lastWho: number | null): Command | null {
  const ad = part.ad.team || part.ad.who != null || lastWho == null ? part.ad : { ...part.ad, who: lastWho };
  return build(ad, action, dir, lastTeam);
}

export const ACTION_LABEL: Record<Action, string> = {
  follow: 'FOLLOW ME', hold: 'HOLD POSITION', move: 'MOVE', cover: 'COVER ME', stack: 'STACK UP ON DOOR', breach: 'BREACH THE ROOM', bang: 'BANG AND CLEAR',
  open: 'OPEN DOOR', close: 'CLOSE DOOR', restrain: 'SECURE / HANDCUFF', fireFree: 'WEAPONS FREE', fireHold: 'HOLD FIRE', report: 'REPORT', shout: 'POLICE! GIVE UP!',
};
export const DIR_LABEL: Record<Dir, string> = { left: 'LEFT', right: 'RIGHT', forward: 'FORWARD', back: 'BACK', there: 'THERE' };
