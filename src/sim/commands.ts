// Natural-language (English) voice command parser. Pure function, unit-tested.
import type { Command, Action, Dir, Team } from './sim';

const norm = (s: string) => ' ' + s.toLowerCase().replace(/[.,!?;:"\-–]/g, ' ').replace(/\s+/g, ' ').trim() + ' ';

const fix = (re: RegExp) => new RegExp(re.source.replace(/\\b\(/g, '(?<= )(').replace(/\)\\b/g, ')(?= )'));

const TEAM_A = fix(/\b(team|teem|tim|squad|group|element)\s*(a|ay|eh|hey|alpha|alfa|one|1|red)\b|\b(alpha|alfa|red team|a team|a-team|teama)\b/);
const TEAM_B = fix(/\b(team|teem|tim|squad|group|element)\s*(b|be|bee|bravo|two|2|blue)\b|\b(bravo|blue team|b team|b-team|teamb)\b/);
const TEAM_ALL = fix(/\b(everyone|everybody|all teams|both teams|all of you|whole team|all|team)\b/);

// Ordered by priority: first match wins.
const RULES: [Action, RegExp, Dir?][] = ([
  ['shout', /\b(police|hands up|hands in the air|show me your hands|drop (the|your|that) (gun|weapon)|drop it|put (the|your) (gun|weapon) down|put it down|get down|on the ground|on your knees|give up|surrender|freeze)\b/],
  ['fireHold', /\b(hold fire|hold your fire|cease fire|ceasefire|don't shoot|do not shoot|weapons tight|weapons hold)\b/],
  ['fireFree', /\b(weapons free|fire at will|open fire|free fire|engage)\b/],
  ['bang', /\b(flashbang|flash bang|flash and clear|bang and clear|bang|grenade|stun grenade|flash)\b/],
  ['breach', /\b(breach|breaching|storm|clear|clear the room|move in|go in|get in|enter|take the room|kick it|kick the door)\b/],
  ['stack', /\b(stack up|stack|line up|on the door|at the door|to the door)\b/],
  ['close', /\b(close|shut)\b/],
  ['open', /\b(open|opens)\b/],
  ['restrain', /\b(restrain|cuff|cuffs|cuff them|handcuff|handcuffs|arrest|secure|zip ?tie|tie them)\b/],
  ['cover', /\b(cover|cover me|protect|protect me|watch my|guard|my back|my six)\b/],
  ['report', /\b(report|status|sitrep|sit rep)\b/],
  ['move', /\b(over there|there|that position|that spot)\b/, 'there'],
  ['move', /\b(left)\b/, 'left'],
  ['move', /\b(right)\b/, 'right'],
  ['move', /\b(back|backwards|fall back|retreat|pull back|back up)\b/, 'back'],
  ['follow', /\b(follow|follow me|on me|regroup|with me|come|come here|fall in|to me)\b/],
  ['move', /\b(forward|forwards|advance|move up|push|push up|go ahead)\b/, 'forward'],
  ['hold', /\b(hold|hold position|stop|stay|wait|halt|stand by)\b/],
  ['stack', /\b(door)\b/],
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
  follow: 'FOLLOW ME', hold: 'HOLD POSITION', move: 'MOVE', cover: 'COVER ME', stack: 'STACK UP ON DOOR', breach: 'BREACH THE ROOM', bang: 'BANG AND CLEAR',
  open: 'OPEN DOOR', close: 'CLOSE DOOR', restrain: 'SECURE / HANDCUFF', fireFree: 'WEAPONS FREE', fireHold: 'HOLD FIRE', report: 'REPORT', shout: 'POLICE! GIVE UP!',
};
export const DIR_LABEL: Record<Dir, string> = { left: 'LEFT', right: 'RIGHT', forward: 'FORWARD', back: 'BACK', there: 'THERE' };
