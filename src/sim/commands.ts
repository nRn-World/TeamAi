// Natural-language (Swedish + English) voice command parser. Pure function, unit-tested.
import type { Command, Action, Dir, Team } from './sim';

const norm = (s: string) => ' ' + s.toLowerCase().replace(/[.,!?;:"]/g, ' ').replace(/\s+/g, ' ').trim() + ' ';

const fix = (re: RegExp) => new RegExp(re.source.replace(/\\b\(/g, '(?<= )(').replace(/\)\\b/g, ')(?= )'));

const TEAM_A = fix(/\b(team|teamet|tim|teem|tem|lag|laget|grupp|gruppen|squad)\s*(a|ah|alfa|alpha|ett|1|one|röd|röda|red)\b|\b(alfa|alpha|röda laget|red team|a-laget|a laget|a-team|teama|tema)\b/);
const TEAM_B = fix(/\b(team|teamet|tim|teem|tem|lag|laget|grupp|gruppen|squad)\s*(b|be|bee|bi|bravo|två|2|two|blå|blåa|blue)\b|\b(bravo|blå laget|blåa laget|blue team|b-laget|b laget|b-team|teamb|teambe|timbe|tb)\b/);
const TEAM_ALL = fix(/\b(alla|allihop|allihopa|hela laget|hela teamet|båda|bägge|everyone|everybody|all teams|both teams|team)\b/);

// Ordered by priority: first match wins.
const RULES: [Action, RegExp, Dir?][] = ([
  ['shout', /\b(polis|police|lägg ner|släpp vapnet|släpp vapnen|händerna|ner på marken|ner på knä|hands up|drop (the|your) (gun|weapon)|get down|on the ground|ge upp|ge er)\b/],
  ['fireHold', /\b(eld upphör|skjut inte|håll elden|vapenvila|hold fire|hold your fire|cease fire|don't shoot)\b/],
  ['fireFree', /\b(fri eld|eld fritt|eld tillåten|öppna eld|weapons free|fire at will|open fire)\b/],
  ['bang', /\b(chockgranat|chock granat|distraktionsgranat|flashbang|flash bang|bang and clear|granat|grenade|blända)\b/],
  ['breach', /\b(storma|stormar|stormning|breach|breacha|spräng|slå in|sparka in|rensa|rensar|clear|gå in|in i rummet|ta rummet|inbrytning|move in|go in|enter)\b/],
  ['stack', /\b(ställ upp|ställ er|stack up|stack|stapla|vid dörren|till dörren|on the door|at the door)\b/],
  ['close', /\b(stäng|stänga|close)\b/],
  ['open', /\b(öppna|open)\b/],
  ['restrain', /\b(säkra|säkrar|handfängsel|handbojor|bojor|boja|grip|gripa|arrestera|fängsla|restrain|cuff|handcuff|arrest|secure|zip ?tie)\b/],
  ['cover', /\b(skydda|skyddar|täck|täcker|täcka|bevaka|bevakar|cover|protect|watch my|vakta|ryggen)\b/],
  ['report', /\b(rapport|rapportera|status|läget|report|sitrep)\b/],
  ['move', /\b(dit|där borta|ditåt|over there|there|den positionen|that position)\b/, 'there'],
  ['move', /\b(vänster|vänstra|left)\b/, 'left'],
  ['move', /\b(höger|högra|right)\b/, 'right'],
  ['move', /\b(bakåt|backa|tillbaka|retirera|dra er tillbaka|back|fall back|retreat)\b/, 'back'],
  ['follow', /\b(följ|följer|följa|kom hit|kom med|kom|efter mig|med mig|till mig|samling|återsamla|fall in|follow|on me|regroup|with me|come)\b/],
  ['move', /\b(framåt|fram|rakt fram|avancera|forward|advance|move up|push)\b/, 'forward'],
  ['hold', /\b(stanna|stannar|håll|håller|vänta|väntar|stopp|halt|stå kvar|hold|stop|stay|wait|freeze)\b/],
] as [Action, RegExp, Dir?][]).map(([a, re, d]) => [a, fix(re), d]);

export function parseCommand(text: string, lastTeam: Team | 'ALL' = 'ALL'): Command | null {
  let s = norm(text);
  const a = TEAM_A.exec(s), b = TEAM_B.exec(s);
  let team: Team | 'ALL' | null = null;
  if (a && b) team = 'ALL'; else if (a) team = 'A'; else if (b) team = 'B'; else if (TEAM_ALL.test(s)) team = 'ALL';
  // strip team words so e.g. "team b" is not parsed as something else
  s = s.replace(TEAM_A, ' ').replace(TEAM_B, ' ');
  for (const [action, re, dir] of RULES) {
    if (re.test(s)) {
      if (action === 'shout') { if (team && team !== 'ALL') continue; return { team: 'ALL', action }; }
      return { team: team ?? lastTeam, action, dir };
    }
  }
  return null;
}

export const ACTION_LABEL: Record<Action, string> = {
  follow: 'FÖLJ MIG', hold: 'HÅLL POSITION', move: 'FÖRFLYTTA', cover: 'SKYDDA MIG', stack: 'STÄLL UPP VID DÖRR', breach: 'STORMA RUMMET', bang: 'CHOCKGRANAT + STORMA',
  open: 'ÖPPNA DÖRR', close: 'STÄNG DÖRR', restrain: 'SÄKRA / HANDFÄNGSEL', fireFree: 'FRI ELD', fireHold: 'ELD UPPHÖR', report: 'RAPPORT', shout: 'POLIS! GE UPP!',
};
export const DIR_LABEL: Record<Dir, string> = { left: 'VÄNSTER', right: 'HÖGER', forward: 'FRAMÅT', back: 'BAKÅT', there: 'DIT' };
