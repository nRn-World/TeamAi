import { Sim, yawTo, fwd } from '../src/sim/sim';
import { parseCommand } from '../src/sim/commands';
import { findPath } from '../src/sim/nav';
import { MISSIONS } from '../src/sim/level';

let fails = 0;
const ok = (c: boolean, msg: string) => { if (!c) { fails++; console.log('  FAIL', msg); } };

// ---- parser ----
const cases: [string, string][] = [
  ['Team A gå till vänster', 'A move left'], ['Team B du skyddar mig', 'B cover'], ['team b, följ mig', 'B follow'],
  ['alla stanna', 'ALL hold'], ['Bravo storma rummet', 'B breach'], ['alfa ställ upp vid dörren', 'A stack'],
  ['team a chockgranat och gå in', 'A bang'], ['Polis! Lägg ner vapnet!', 'ALL shout'], ['öppna dörren team a', 'A open'],
  ['team b säkra dem', 'B restrain'], ['röda laget höger', 'A move right'], ['blå laget gå dit', 'B move there'],
  ['eld upphör', 'ALL fireHold'], ['team a fri eld', 'A fireFree'], ['Team A move left', 'A move left'], ['team two cover me', 'B cover'],
  ['everyone on me', 'ALL follow'], ['tema framåt', 'A move forward'], ['team a och team b följ mig', 'ALL follow'], ['hej hur mår du', 'null'],
  ['team a backa', 'A move back'], ['stäng dörren', 'ALL close'],
];
for (const [t, exp] of cases) { const c = parseCommand(t); const got = c ? [c.team, c.action, c.dir].filter(Boolean).join(' ') : 'null'; ok(got === exp, `parse "${t}" => ${got} (expected ${exp})`); }
console.log('parser cases:', cases.length);

// ---- headless bot playthrough ----
function play(mission: number, seed: number, verbose = false) {
  const sim = new Sim(mission, seed, 1); const p = sim.player; const dt = 1 / 30;
  const doors = [...sim.level.doors]; let di = -1, state = 'next', st = 0, path: { x: number; z: number }[] | null = null;
  let maxStuck = 0; const says: string[] = [];
  const walkTo = (x: number, z: number) => {
    if (!path) path = findPath(sim.level, p, { x, z }); if (!path || !path.length) { path = null; return true; }
    const wp = path[0], dx = wp.x - p.x, dz = wp.z - p.z, d = Math.hypot(dx, dz);
    if (d < 0.25) { path.shift(); return path.length === 0; }
    p.yaw = yawTo(dx, dz);
    const f = fwd(p.yaw); const cx = Math.floor(p.x + f.x * 0.8), cz = Math.floor(p.z + f.z * 0.8); const door = sim.doorAtCell(cx, cz); if (door && door.open < 0.7) { sim.setDoor(door, true); return false; }
    sim.movePlayer((dx / d) * 3.5 * dt, (dz / d) * 3.5 * dt); return false;
  };
  let t = 0;
  for (; t < 60 * 20 && !sim.over; t += dt) {
    st += dt;
    if (state === 'next') { di++; if (di >= doors.length) { di = -1; } state = 'go'; st = 0; path = null; }
    else if (state === 'go') {
      const d = doors[Math.max(0, di)]; const side = d.horiz ? (p.z > d.cz + .5 ? 1 : -1) : (p.x > d.cx + .5 ? 1 : -1);
      const tx = d.horiz ? d.cx + .5 : d.cx + .5 + side * 2.5, tz = d.horiz ? d.cz + .5 + side * 2.5 : d.cz + .5;
      if (walkTo(tx, tz) || st > 25) { p.yaw = yawTo(d.cx + .5 - p.x, d.cz + .5 - p.z); sim.command({ team: 'ALL', action: sim.rng() < .5 ? 'bang' : 'breach' }); state = 'wait'; st = 0; }
    } else if (state === 'wait') {
      if (st > 9) { sim.command({ team: 'ALL', action: 'restrain' }); state = 'cuff'; st = 0; }
    } else if (state === 'cuff') {
      if (st > 1 && Math.floor(st * 30) % 30 === 0) { sim.playerShout(); }
      if (st > 8) { sim.command({ team: 'ALL', action: 'follow' }); state = 'regroup'; st = 0; }
    } else if (state === 'regroup') { if (st > 2.5) state = 'next'; }
    if (Math.floor(t * 30) % 40 === 0) sim.playerShout();
    const th = sim.suspects.find(x => x.alive && !x.down && x.armed && (x.hostile || x.hasFired) && Math.hypot(x.x - p.x, x.z - p.z) < 25 && sim.los(p.x, p.z, x.x, x.z));
    if (th && Math.floor(t * 30) % 6 === 0) { const dx = th.x - p.x, dz = th.z - p.z, d = Math.hypot(dx, dz), j = () => (sim.rng() - .5) * .12; p.yaw = yawTo(dx, dz); const v = [dx / d + j(), -0.15 / d + j() * .5, dz / d + j()]; sim.fire(p, p.x, 1.6, p.z, v[0], v[1], v[2], 34); }
    sim.update(dt);
    for (const e of sim.events) { if (e.t === 'say') says.push(e.text); }
    sim.events.length = 0;
    for (const a of sim.actors) { ok(Number.isFinite(a.x) && Number.isFinite(a.z), 'NaN position'); if (a.alive && !a.down && sim.solidCell(Math.floor(a.x), Math.floor(a.z)) && sim.cell(Math.floor(a.x), Math.floor(a.z)) !== 3) { fails++; if (fails < 20) console.log('  FAIL actor inside solid', a.name, a.x.toFixed(2), a.z.toFixed(2), sim.cell(Math.floor(a.x), Math.floor(a.z))); } maxStuck = Math.max(maxStuck, a.stuckT); }
  }
  const r = sim.remaining(), sc = sim.score();
  console.log(`mission ${mission} "${MISSIONS[mission].name}" seed ${seed}: ${sim.over ? (sim.over.win ? 'WIN' : 'LOSE') : 'timeout'} t=${t.toFixed(0)}s remaining=${JSON.stringify(r)} score=${sc.total} stats=${JSON.stringify(sim.stats)} playerHp=${p.hp.toFixed(0)} officers=${sim.officers.map(o => o.hp.toFixed(0)).join('/')}`);
  if (verbose) console.log([...new Set(says)].join(' | '));
  return sim;
}
let wins = 0, n = 0;
for (let m = 0; m < 3; m++) for (let s = 1; s <= 4; s++) { const sim = play(m, s, m === 0 && s === 1); n++; if (sim.over?.win) wins++; }
console.log(`wins ${wins}/${n}`);
ok(wins >= 3, 'bot should be able to win some missions');
console.log(fails ? `FAILED (${fails})` : 'ALL OK'); process.exit(fails ? 1 : 0);
