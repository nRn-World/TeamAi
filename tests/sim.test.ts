import { Sim, yawTo, fwd } from '../src/sim/sim';
import type { Command } from '../src/sim/sim';
import { parseCommand, parseCommands, shouldUseAiBrain } from '../src/sim/commands';
import { buildLocalReport, buildTacticalContext } from '../src/sim/context';
import { findPath } from '../src/sim/nav';
import { MISSIONS, buildLevel, FLOOR, OUT, HIGH, WINDOW } from '../src/sim/level';
import { encodeSnap, applySnap, encodeEv, decodeEv } from '../src/sim/netstate';

let fails = 0;
const ok = (c: boolean, msg: string) => { if (!c) { fails++; console.log('  FAIL', msg); } };

// ---- parser ----
const cases: [string, string][] = [
  ['Team A go left', 'A move left'], ['Team B you cover me', 'B cover'], ['team b, follow me', 'B follow'],
  ['everyone hold', 'ALL hold'], ['Bravo breach the room', 'B breach'], ['alpha stack up on the door', 'A stack'],
  ['team a flashbang and go in', 'A bang'], ['Police! Drop the weapon!', 'ALL shout'], ['open the door team a', 'A open'],
  ['team b cuff them', 'B restrain'], ['red team right', 'A move right'], ['blue team go over there', 'B move there'],
  ['hold fire', 'ALL fireHold'], ['team a weapons free', 'A fireFree'], ['Team A move left', 'A move left'], ['team two cover me', 'B cover'],
  ['everyone on me', 'ALL follow'], ['team one move up', 'A move forward'], ['team a and team b follow me', 'ALL follow'], ['hello how are you', 'null'],
  ['team a fall back', 'A move back'], ['Team A opens the door', 'A open'], ['team-a close the door', 'A close'], ['bravo door', 'B stack'], ['team b breaching', 'B breach'], ['shut the door', 'ALL close'],
  ['Police! Get on the ground!', 'ALL shout'], ['show me your hands', 'ALL shout'], ['team b wait', 'B hold'], ['alpha sitrep', 'A report'], ['bravo bang and clear', 'B bang'], ['team a secure them', 'A restrain'],
  ['peek the door', 'ALL peek'], ['team b c2 that door', 'B c2'], ['wedge the door', 'ALL wedge'], ['defuse the bomb', 'ALL defuse'],
];
for (const [t, exp] of cases) { const c = parseCommand(t); const got = c ? [c.team, c.action, c.dir].filter(Boolean).join(' ') : 'null'; ok(got === exp, `parse "${t}" => ${got} (expected ${exp})`); }
const named: [string, string, number?][] = [
  ['Ken, you cover us', 'A cover 0'], ['Ken throw flash', 'A bang 0'], ['Maya go in', 'A breach 1'], ['Jack you protect me', 'B cover 2'], ['zoey hold here', 'B hold 3'],
  ['you go in', 'A breach 0', 0], ['you protect us', 'B cover 3', 3], ['you cover me', 'ALL cover'], ['Kenny follow me', 'A follow 0'], ['team b follow me', 'B follow', 0], ['Jack, flashbang', 'B bang 2'], ['Zoe cuff him', 'B restrain 3'],
  ['Maya peek that door', 'A peek 1'],
];
for (const [t, exp, last] of named) { const c = parseCommand(t, 'ALL', last ?? null); const got = c ? [c.team, c.action, c.dir, c.who].filter(v => v != null).join(' ') : 'null'; ok(got === exp, `parse "${t}" => ${got} (expected ${exp})`); }

// ---- compound, relay & dynamic team reassignment ----
{
  const j1 = parseCommand('Maya join Team B');
  ok(!!j1 && j1.action === 'joinTeam' && j1.who === 1 && j1.team === 'B', 'Maya join Team B');
  const j2 = parseCommand('put Jack on Team A');
  ok(!!j2 && j2.action === 'joinTeam' && j2.who === 2 && j2.team === 'A', 'put Jack on Team A');
  const j3 = parseCommand('you switch to Team B', 'A', 0);
  ok(!!j3 && j3.action === 'joinTeam' && j3.who === 0 && j3.team === 'B', 'you switch to Team B');

  const b0 = parseCommands('Ken follow me, Maya join Team B, team be cover me');
  ok(
    b0.commands.length === 3
      && b0.commands[0].who === 0 && b0.commands[0].action === 'follow'
      && b0.commands[1].who === 1 && b0.commands[1].action === 'joinTeam' && b0.commands[1].team === 'B'
      && b0.commands[2].who == null && b0.commands[2].team === 'B' && b0.commands[2].action === 'cover',
    'compound: Ken follow me, Maya join Team B, team be cover me',
  );

  const b1 = parseCommands('Ken throw flash and Maya go in');
  ok(b1.commands.length === 2 && b1.commands[0].who === 0 && b1.commands[0].action === 'bang' && b1.commands[1].who === 1 && b1.commands[1].action === 'breach', 'compound English named');
  const b2 = parseCommands('Team A stack up on the door and Team B cover me');
  ok(b2.commands.length === 2 && b2.commands[0].team === 'A' && b2.commands[0].action === 'stack' && b2.commands[1].team === 'B' && b2.commands[1].action === 'cover', 'compound teams');
  const b3 = parseCommands('Ken, tell Team B to breach');
  ok(b3.relayFrom === 0 && b3.commands.length === 1 && b3.commands[0].team === 'B' && b3.commands[0].action === 'breach', 'English relay');

  ok(shouldUseAiBrain('Do you see any suspects in the next room?', parseCommands('Do you see any suspects in the next room?')), 'question triggers AI brain');
  ok(!shouldUseAiBrain('Team A follow me', parseCommands('Team A follow me')), 'short direct command stays fast');

  const sim = new Sim(0, 5);
  for (const cmd of b0.commands) sim.command(cmd);
  ok(sim.officers[1].team === 'B' && sim.members('B').length === 3 && sim.members('A').length === 0, 'Maya moved to Team B while Ken stayed solo follow on A');
  sim.command({ team: 'B', action: 'breach' });
  sim.command({ team: 'A', action: 'follow' });
  ok(sim.members('A').length === 1 && sim.members('A')[0].name === 'Ken', 'Team A now has only Ken');

  const ctx = buildTacticalContext(sim);
  ok(ctx.includes('Ken (Team A') && ctx.includes('Maya (Team B'), 'tactical context reflects Maya on Team B');
  const repEn = buildLocalReport(sim, 'B');
  ok(repEn.includes('3 up.'), 'English local report reflects 3 officers on Team B');
}
{ // one officer on an order of their own, then back into the team
  const sim = new Sim(0, 5), [ken, maya] = sim.officers, p = sim.player;
  ok(ken.name === 'Ken' && sim.officers[3].name === 'Zoe', 'officers have names');
  sim.command({ team: 'A', action: 'hold', who: 0 });
  ok(!!ken.solo && ken.solo.order.type === 'hold' && !maya.solo && sim.teams.A.order.type === 'follow', 'solo order leaves the team order alone');
  const k0 = { x: ken.x, z: ken.z }, m0 = { x: maya.x, z: maya.z };
  for (let i = 0, a = p.yaw; i < 240; i++) { (sim as any).checkT = 9; p.x += Math.sin(a) * 0.03; p.z += Math.cos(a) * 0.03; if (sim.solidCell(Math.floor(p.x), Math.floor(p.z))) { p.x -= Math.sin(a) * 0.03; p.z -= Math.cos(a) * 0.03; a += 1.3; } sim.update(1 / 30); }
  ok(Math.hypot(ken.x - k0.x, ken.z - k0.z) < 1, 'Ken holds while the others follow');
  ok(Math.hypot(maya.x - m0.x, maya.z - m0.z) > 0.5, 'Maya keeps following');
  sim.command({ team: 'A', action: 'cover', who: 1 }); ok(maya.solo?.order.type === 'cover', 'Maya covers alone');
  sim.command({ team: 'A', action: 'follow' }); ok(!ken.solo && !maya.solo, 'a team order brings them back');
  const g0 = sim.grenades.length; sim.command({ team: 'B', action: 'bang', who: 2 }, { x: sim.officers[2].x + 3, z: sim.officers[2].z });
  console.log('solo flash without a door: grenades', sim.grenades.length - g0, 'order', sim.officers[2].solo?.order.type);
  ken.alive = false; ok(!sim.command({ team: 'A', action: 'follow', who: 0 }), 'a dead officer cannot take orders');
}
{ // English compound orders tested via splitOrders compatibility wrapper
  const j = (c: (Command | null)[]) => c.map(x => x ? [x.who ?? x.team, x.action, x.dir].filter(v => v != null).join(' ') : '?').join(', ');
  const multi: [string, string, ('A' | 'B' | 'ALL')?, number?][] = [
    ['Ken cover the door while team B goes in with a flash', '0 cover, B bang'], ['team a bang and clear', 'A bang'], ['Maya open the door and go in', '1 open, 1 breach'],
    ['team a go left and team b go right', 'A move left, B move right'], ['Maya watch my back and Zoe open that door', '1 cover, 3 open'], ['everybody come back to me', 'ALL follow'],
    ['Zoe hold your fire', '3 fireHold'],
  ];
  for (const [t, exp, lt, lw] of multi) { const got = j(parseCommands(t, lt ?? 'ALL', lw ?? null).commands); ok(got === exp, `orders "${t}" => ${got} (expected ${exp})`); }
}
console.log('parser cases:', cases.length + named.length);

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
    if (sim.bomb && !sim.bomb.defused && sim.remaining().suspects === 0) {
      if (walkTo(sim.bomb.x, sim.bomb.z)) {
        sim.bomb.defuseT += dt;
        if (sim.bomb.defuseT >= 2.2) { sim.bomb.defused = true; sim.events.push({ t: 'bomb', kind: 'defused', x: sim.bomb.x, z: sim.bomb.z }); }
      }
    } else if (state === 'next') { di++; if (di >= doors.length) { di = -1; } state = 'go'; st = 0; path = null; }
    else if (state === 'go') {
    const d = doors[Math.max(0, di)];
    const side = d.horiz ? (p.z > d.cz + .5 ? 1 : -1) : (p.x > d.cx + .5 ? 1 : -1);
    const tx = d.horiz ? d.cx + .5 : d.cx + .5 + side * 2.5, tz = d.horiz ? d.cz + .5 + side * 2.5 : d.cz + .5;
    if (d.locked) d.locked = false;
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
// ---- co-op: host sim + mirrored client sim ----
{
  const host = new Sim(0, 7, 1, 3), mir = new Sim(0, 7, 1, 3); const me = mir.players[1]; mir.player = me;
  ok(host.actors.length === mir.actors.length && host.players.length === 3, 'coop actor count');
  const solo = new Sim(0, 7, 1, 1); ok(solo.suspects.every((x, i) => x.x === host.suspects[i].x && x.id === host.suspects[i].id), 'extra players must not change the level');
  host.command({ team: 'A', action: 'follow' }, null, host.players[1]); host.command({ team: 'B', action: 'breach' }, null, host.players[0]);
  let evs = 0;
  for (let i = 0; i < 400; i++) {
    const rp = host.players[1]; rp.z -= 0.02; host.pushTrail(rp); // remote player walks north
    host.update(1 / 30);
    const wire = JSON.parse(JSON.stringify({ s: encodeSnap(host), e: host.events.map(encodeEv) })); host.events.length = 0;
    applySnap(mir, wire.s, me); for (const e of wire.e) { const d = decodeEv(mir, e); evs++; if ('a' in d) ok(d.a === mir.actors[(d.a as any).id], 'event actor decode'); }
  }
  ok(mir.officers.every((o, i) => Math.abs(o.x - host.officers[i].x) < 0.02 && Math.abs(o.z - host.officers[i].z) < 0.02), 'mirror positions');
  ok(mir.teams.A.order.type === host.teams.A.order.type && mir.level.doors.every((d, i) => Math.abs(d.open - host.level.doors[i].open) < 0.02), 'mirror orders/doors');
  const a1 = host.officers[0], rp = host.players[1]; ok(Math.hypot(a1.x - rp.x, a1.z - rp.z) < 5, 'team A follows the remote player: ' + Math.hypot(a1.x - rp.x, a1.z - rp.z).toFixed(1));
  ok(evs > 0, 'events forwarded');
  host.damage(host.players[0], 9999, host.suspects[0], false); ok(!host.over, 'mission continues while a player is alive');
  host.damage(host.players[1], 9999, host.suspects[0], false); host.damage(host.players[2], 9999, host.suspects[0], false); ok(!!host.over && !host.over.win, 'mission fails when all players are down');
  console.log('co-op mirror test done');
}
{ // a kneeling or cuffed person in a doorway must give way instead of blocking it
  let stuck = 0, cases = 0;
  for (const m of [0, 1, 2]) {
    const sim = new Sim(m, 3, 1) as any; const p = sim.player, c = sim.civs[0];
    for (const o of sim.officers) { o.x = -50 - o.slot * 3; o.z = -50; }
    for (const s of sim.suspects) s.alive = false; for (const x of sim.civs) if (x !== c) x.alive = false;
    for (const d of sim.level.doors) for (const sign of [-1, 1]) for (const off of [0, 0.15, -0.25]) {
      d.open = 1; d.target = 1; const ax = sim.solidCell(d.cx - 1, d.cz) ? [0, 1] : [1, 0];
      c.x = d.cx + 0.5 + ax[1] * off; c.z = d.cz + 0.5 + ax[0] * off; c.surrendered = true; c.restrained = true;
      p.x = d.cx + 0.5 - ax[0] * 1.2 * sign; p.z = d.cz + 0.5 - ax[1] * 1.2 * sign; const x0 = p.x, z0 = p.z;
      for (let i = 0; i < 90; i++) { sim.movePlayer(ax[0] * sign * 0.07, ax[1] * sign * 0.07); sim.checkT = 9; sim.update(1 / 30); d.open = 1; d.target = 1; }
      cases++; if ((p.x - x0) * ax[0] * sign + (p.z - z0) * ax[1] * sign < 2.4 || sim.solidCell(Math.floor(c.x), Math.floor(c.z))) stuck++;
    }
  }
  ok(stuck === 0, `player blocked by a kneeling person in ${stuck}/${cases} doorway cases`);
  console.log('doorway test done');
}
let wins = 0, n = 0;
for (let m = 0; m < MISSIONS.length; m++) for (let s = 1; s <= 2; s++) { const sim = play(m, s, m === 0 && s === 1); n++; if (sim.over?.win) wins++; }
console.log(`wins ${wins}/${n}`);
ok(wins >= 4, 'bot should be able to win across missions');

// ---- tactical expansions: doors, windows, power, bomb, non-lethal, debrief, netstate ----
{
  // 1. Locked door + C2 breach + wedge + optiwand peek
  const s = new Sim(3, 1); // Nordia Bank (has locked doors, windows, breaker)
  const locked = s.level.doors.find(d => d.locked);
  ok(!!locked, 'Nordia Bank has at least one locked door');
  if (locked) {
    s.player.x = locked.cx + 0.5; s.player.z = locked.cz + (locked.horiz ? 1.3 : 0.5);
    if (!locked.horiz) s.player.x = locked.cx + 1.3;
    s.player.yaw = yawTo(locked.cx + 0.5 - s.player.x, locked.cz + 0.5 - s.player.z);
    ok(!s.setDoor(locked, true), 'locked door cannot be opened directly');
    const report = s.peekDoor(locked, s.player);
    ok(!!report && report.includes('FiberCam'), 'fibercam peek returns room report');
    const c2Before = s.player.c2;
    ok(s.c2Door(locked, s.player) && !locked.locked && locked.target === 1 && s.player.c2 === c2Before - 1, 'C2 blows open locked door and consumes charge');
    s.setDoor(locked, false); locked.open = 0;
    ok(s.wedgeDoor(locked, s.player) && !!locked.wedged, 'wedgeDoor wedges closed door');
    ok(!s.setDoor(locked, true), 'wedged door blocks opening');
    ok(s.wedgeDoor(locked, s.player) && !locked.wedged, 'second wedgeDoor removes wedge');
  }

  // 2. Breakable windows
  const w = s.level.windows[0];
  ok(!!w, 'Nordia Bank has breakable windows');
  if (w) {
    s.player.x = w.x; s.player.z = w.z + 2;
    s.fire(s.player, w.x, 1.5, w.z + 2, 0, 0, -1, 34);
    ok(s.brokenWindows.size > 0, 'firing at glass window shatters it');
  }

  // 3. Power breaker
  ok(!!s.level.breaker && s.powerOn, 'breaker starts powered on');
  s.togglePower();
  ok(!s.powerOn && s.events.some(e => e.t === 'power' && !e.on), 'togglePower shuts off power');

  // 4. Non-lethal taser / beanbag & bomb defusal (Club Eclipse)
  const sc = new Sim(4, 2);
  ok(!!sc.bomb && !sc.bomb.defused, 'Club Eclipse has an active bomb');
  const sus = sc.suspects[0];
  sus.x = sc.player.x; sus.z = sc.player.z - 2.0;
  sc.fire(sc.player, sc.player.x, 1.5, sc.player.z, 0, 0, -1, 4, { nonLethal: true, taser: true });
  ok(sus.alive && sus.stun > 1.5, 'taser stuns suspect without killing');
  const t0 = sc.bomb!.time;
  sc.update(1.0);
  ok(sc.bomb!.time < t0, 'bomb timer counts down');
  sc.bomb!.defused = true;
  ok(sc.debriefNotes().length > 0, 'debriefNotes provides tactical feedback');

  // 5. Netstate sync for new fields (locked, wedged, power, bomb, brokenWindows, brokenProps, brokenDoorGlass)
  const host = new Sim(4, 3, 1, 2), mir = new Sim(4, 3, 1, 2);
  host.powerOn = false;
  host.level.doors[0].wedged = true;
  if (host.level.windows[0]) host.brokenWindows.add(Math.floor(host.level.windows[0].z) * host.level.w + Math.floor(host.level.windows[0].x));
  host.brokenProps.add(host.level.props[0].cz * host.level.w + host.level.props[0].cx);
  host.brokenDoorGlass.add(host.level.doors[0].id);
  host.bomb!.time = 42.5;
  applySnap(mir, JSON.parse(JSON.stringify(encodeSnap(host))), mir.players[1]);
  ok(!mir.powerOn && !!mir.level.doors[0].wedged && Math.abs(mir.bomb!.time - 42.5) < 0.1 && mir.brokenWindows.size === host.brokenWindows.size && mir.brokenProps.size === 1 && mir.brokenDoorGlass.size === 1, 'netstate syncs power, wedge, bomb, broken windows, broken props & door glass');

  // 6. Locked door touched by AI suspects/civs must not spam player 'info' events
  const sLock = new Sim(0, 1);
  const ld = sLock.level.doors.find(d => d.locked)!;
  const civ = sLock.civs[0];
  civ.x = ld.cx + 0.5; civ.z = ld.cz + (ld.horiz ? 1.2 : 0.5); if (!ld.horiz) civ.x = ld.cx + 1.2;
  civ.panicT = 5; civ.lastSeen = { x: ld.cx + 0.5 - (ld.horiz ? 0 : 2), z: ld.cz + 0.5 - (ld.horiz ? 2 : 0) };
  sLock.events.length = 0;
  for (let i = 0; i < 30; i++) sLock.update(1 / 30);
  ok(!sLock.events.some(e => e.t === 'info' && e.text.includes('Door is locked')), 'AI walking near locked door does not spam info events');

  // 7. Realistic solid surfaces: door leaf collision, swing push/block, vehicle & actor separation
  const sCol = new Sim(0, 1);
  for (const s0 of sCol.suspects) s0.alive = false;
  for (const c0 of sCol.civs) c0.alive = false;
  for (const o0 of sCol.officers) o0.alive = false;
  const dr = sCol.level.doors.find(d => d.horiz && !d.locked)!;
  dr.open = 0; dr.target = 0;
  // 7a. Closed door blocks player walking through
  sCol.player.x = dr.cx + 0.5; sCol.player.z = dr.cz + 0.9;
  for (let i = 0; i < 30; i++) sCol.movePlayer(0, -0.1);
  ok(sCol.player.z >= dr.cz + 0.5 + sCol.player.r, 'closed door leaf blocks player from crossing');
  // 7b. Opening door in front of standing player pushes player out of swing arc instead of clipping through
  sCol.player.x = dr.cx + 0.5; sCol.player.z = dr.cz + 0.16;
  sCol.setDoor(dr, true);
  for (let i = 0; i < 30; i++) sCol.update(1 / 30);
  ok(dr.open > 0.9 && sCol.player.z < dr.cz - 0.1, 'opening door pushes standing player out of swing arc');
  // 7c. Open door leaf itself stays solid (player walking into the rotated leaf at cx+0.03 is blocked)
  sCol.player.x = dr.cx + 0.45; sCol.player.z = dr.cz + 0.05;
  for (let i = 0; i < 20; i++) sCol.movePlayer(-0.08, 0);
  ok(sCol.player.x >= dr.cx + 0.03, 'open door leaf panel remains solid');
  // 7d. Marauder vehicle OBB blocks player & bullets across all 6 missions
  for (let m = 0; m < MISSIONS.length; m++) {
    const sm = new Sim(m, 1);
    const v = sm.level.vehicle!;
    ok(!!v, `mission ${m} has Marauder vehicle collider`);
    // verify zero overlap with building cells
    const cv = Math.cos(v.yaw), sn = Math.sin(v.yaw);
    let hitWall = false;
    for (let lx = -v.hx; lx <= v.hx; lx += 0.3) for (let lz = -v.hz; lz <= v.hz; lz += 0.3) {
      const wx = v.x + lx * cv + lz * sn, wz = v.z - lx * sn + lz * cv;
      if (sm.cell(Math.floor(wx), Math.floor(wz)) !== 0) hitWall = true;
    }
    ok(!hitWall, `mission ${m} Marauder sits completely outside building/walls`);
  }
  const v0 = sCol.level.vehicle!;
  sCol.player.x = v0.x; sCol.player.z = v0.z + 3.2;
  for (let i = 0; i < 30; i++) sCol.movePlayer(0, -0.15);
  ok(sCol.player.z >= v0.z + 1.2, 'Marauder vehicle blocks player');
  const shotV = sCol.ray(v0.x, 1.2, v0.z + 4.0, 0, 0, -1, 10, sCol.player);
  ok(shotV.kind === 'wall' && shotV.z > v0.z, 'Marauder vehicle stops gunfire');
  // 7e. Standing actor backed against wall blocks player instead of overlapping
  const susCol = sCol.suspects[0];
  susCol.alive = true; susCol.surrendered = false; susCol.restrained = false;
  susCol.x = 5.35; susCol.z = 5.35;
  sCol.player.x = 6.2; sCol.player.z = 5.35;
  for (let i = 0; i < 20; i++) { sCol.movePlayer(-0.1, 0); sCol.update(1 / 30); }
  ok(Math.hypot(sCol.player.x - susCol.x, sCol.player.z - susCol.z) >= sCol.player.r + susCol.r - 0.05, 'player cannot walk through standing actor');

  // 8. Shootable / breakable objects: PCs/monitors, servers, plants, and glass entrance doors
  const sBrk = new Sim(0, 1);
  for (const s0 of sBrk.suspects) s0.alive = false;
  const pcProp = sBrk.level.props.find(pr => pr.kind === 'pc' || pr.kind === 'desk');
  ok(!!pcProp, 'Mission 0 has office desk/PC props');
  if (pcProp) {
    const px = pcProp.cx + (pcProp.w ?? 1) / 2, pz = pcProp.cz + (pcProp.d ?? 1) / 2;
    sBrk.events.length = 0;
    sBrk.fire(sBrk.player, px, 1.05, pz + 1.5, 0, 0, -1, 34);
    const pk = pcProp.cz * sBrk.level.w + pcProp.cx;
    ok(sBrk.brokenProps.has(pk) && sBrk.events.some(e => e.t === 'break' && e.kind === 'pc'), 'shooting PC/desk monitor breaks it');
  }
  const srvProp = sBrk.level.props.find(pr => pr.kind === 'server');
  if (srvProp) {
    sBrk.events.length = 0;
    sBrk.fire(sBrk.player, srvProp.cx + 0.5, 1.4, srvProp.cz + 1.2, 0, 0, -1, 34);
    ok(sBrk.events.some(e => e.t === 'break' && e.kind === 'server'), 'shooting server rack breaks it');
  }
  const glassDoor = sBrk.level.doors.find(d => sBrk.isGlassDoor(d));
  ok(!!glassDoor, 'Mission 0 has front glass entrance door');
  if (glassDoor) {
    sBrk.events.length = 0;
    sBrk.fire(sBrk.player, glassDoor.cx + 0.5, 1.3, glassDoor.cz + 1.5, 0, 0, -1, 34);
    ok(sBrk.brokenDoorGlass.has(glassDoor.id) && sBrk.events.some(e => e.t === 'glass'), 'shooting glass door shatters its glass pane');
  }

  // 9. Smart furniture & exterior placement invariants across all 6 missions x 10 seeds
  let placeFails = 0;
  for (let m = 0; m < MISSIONS.length; m++) {
    for (let sd = 1; sd <= 10; sd++) {
      const lv = buildLevel(m, sd);
      const cell = (x: number, z: number) => (x < 0 || z < 0 || x >= lv.w || z >= lv.h) ? 2 : lv.cells[z * lv.w + x];
      for (const p of lv.props) {
        const pw = p.w ?? 1, pd = p.d ?? 1;
        if (pw !== pd && ((p.rot % 2 === 0) !== (pw > pd))) placeFails++;
        for (let iz = p.cz; iz < p.cz + pd; iz++) for (let ix = p.cx; ix < p.cx + pw; ix++) {
          const isHigh = cell(ix, iz) === HIGH;
          if (isHigh || p.kind === 'sofa' || p.kind === 'bed' || p.kind === 'desk' || p.kind === 'bar' || p.kind === 'pc') {
            if (cell(ix + 1, iz) === WINDOW || cell(ix - 1, iz) === WINDOW || cell(ix, iz + 1) === WINDOW || cell(ix, iz - 1) === WINDOW) placeFails++;
          }
        }
      }
      if (lv.breaker && cell(Math.floor(lv.breaker.x), Math.floor(lv.breaker.z)) !== FLOOR) placeFails++;
      if (lv.bomb && cell(Math.floor(lv.bomb.x), Math.floor(lv.bomb.z)) !== FLOOR) placeFails++;
      for (const d of lv.doors) {
        const a = d.horiz ? cell(d.cx, d.cz - 1) : cell(d.cx - 1, d.cz);
        const b = d.horiz ? cell(d.cx, d.cz + 1) : cell(d.cx + 1, d.cz);
        if ((a !== FLOOR && a !== OUT) || (b !== FLOOR && b !== OUT)) placeFails++;
      }
      for (const eb of lv.extBoxes) {
        for (let iz = Math.floor(eb.z - eb.hz + 0.01); iz <= Math.floor(eb.z + eb.hz - 0.01); iz++) {
          for (let ix = Math.floor(eb.x - eb.hx + 0.01); ix <= Math.floor(eb.x + eb.hx - 0.01); ix++) {
            if (cell(ix, iz) !== OUT) placeFails++;
          }
        }
      }
      for (const ec of lv.extCircles) {
        for (let iz = Math.floor(ec.z - ec.r + 0.01); iz <= Math.floor(ec.z + ec.r - 0.01); iz++) {
          for (let ix = Math.floor(ec.x - ec.r + 0.01); ix <= Math.floor(ec.x + ec.r - 0.01); ix++) {
            if (cell(ix, iz) !== OUT) placeFails++;
          }
        }
      }
    }
  }
  ok(placeFails === 0, `zero furniture/window/breaker/door/exterior placement defects across 60 builds (got ${placeFails})`);

  // 10. Stream-quality features: Dispatch Director, Awards, S+ rank, Replay recording
  const sDisp = new Sim(0, 1, 1);
  sDisp.update(0.35);
  ok(sDisp.replayFrames.length >= 1, 'replayFrames records initial tactical positions');
  ok(sDisp.dispatchAction('blackout').includes('Power'), 'dispatch blackout executes cleanly');
  ok(!sDisp.powerOn, 'dispatch blackout cuts building power');
  ok(sDisp.dispatchAction('vip_name', 'StreamVIP').includes('StreamVIP'), 'dispatch vip_name renames an active subject');
  ok(sDisp.actors.some(a => a.name === 'StreamVIP'), 'renamed actor visible in sim.actors');
  ok(sDisp.dispatchAction('false_alarm').includes('pinged'), 'dispatch false_alarm triggers ambient phone event');
  ok(sDisp.events.some(e => e.t === 'phone'), 'false_alarm emits phone event');
  sDisp.over = { win: true, reason: 'Area secure' };
  const aw = sDisp.awards();
  ok(Array.isArray(aw) && aw.length >= 1 && !!aw[0].title, 'awards() generates tactical badges on win');

  // 11. Bullet ray precision & no invisible mid-air hits (curtain-wall windows, broken props, trees, perimeter sky)
  const sRay = new Sim(0, 1, 1);
  // Curtain-wall window at x=13.5, z=20.5 on Office should pass through at low (y=0.5) and high (y=2.5)
  const hLowWin = sRay.ray(13.5, 0.5, 22.0, 0, 0, -1, 10, sRay.player);
  ok(hLowWin.d > 2.0, `curtain-wall window passes bullet at y=0.5 (d=${hLowWin.d.toFixed(2)})`);
  const hHighWin = sRay.ray(13.5, 2.5, 22.0, 0, 0, -1, 10, sRay.player);
  ok(hHighWin.d > 2.0, `curtain-wall window passes bullet at y=2.5 (d=${hHighWin.d.toFixed(2)})`);
  // Shooting over exterior perimeter curb (z = h - 1) towards sky should not hit invisible wall/ceiling
  const hSky = sRay.ray(14.5, 1.6, 24.4, 0, 0.05, 1, 30, sRay.player);
  ok(hSky.kind === 'none', `shooting over perimeter curb goes to open sky (got ${hSky.kind} at d=${hSky.d.toFixed(2)})`);
  // Courtyard tree at (8.5, 22.0): bullet 0.25m from center passes trunk cleanly
  const hTree = sRay.ray(8.75, 1.2, 24.0, 0, 0, -1, 3.0, sRay.player);
  ok(hTree.kind === 'none', `bullet 0.25m beside tree trunk passes through air (got ${hTree.kind})`);
  // Broken PC prop no longer blocks mid-air above desk
  const pcProp2 = sRay.level.props.find(pr => pr.kind === 'pc');
  if (pcProp2) {
    const px = pcProp2.cx + (pcProp2.w ?? 1) / 2, pz = pcProp2.cz + (pcProp2.d ?? 1) / 2;
    sRay.fire(sRay.player, px, 1.05, pz + 1.2, 0, 0, -1, 34);
    const hAfterBreak = sRay.ray(px, 1.05, pz + 1.2, 0, 0, -1, 2.4, sRay.player);
    ok(hAfterBreak.d > 1.8, `broken PC monitor does not leave invisible midair blocker (d=${hAfterBreak.d.toFixed(2)})`);
  }
  // Sub-2mm wall surface accuracy (e.g. solid wall at z=20 in column x=15.5)
  const hWall = sRay.ray(15.5, 1.6, 22.0, 0, 0, -1, 5, sRay.player);
  ok(hWall.kind === 'wall' && Math.abs(hWall.z - 21.0) < 0.002, `wall hit lands on exact surface (<2mm, z=${hWall.z.toFixed(4)})`);

  // 12. Co-op features: tactical ping, downed/revive, breach sync, share gear, modifiers, MVP & snap interpolation
  const sCoop = new Sim(0, 1, 1, 2, { blackout: true, extraHostiles: 3, pistolOnly: true });
  ok(!sCoop.powerOn, 'blackout modifier starts power off');
  ok(sCoop.mods.pistolOnly === true, 'pistolOnly modifier preserved');
  const p1 = sCoop.players[0], p2 = sCoop.players[1];
  const sBase = new Sim(0, 1, 1, 2);
  ok(sCoop.suspects.length === sBase.suspects.length + 3, 'extraHostiles modifier adds extra suspects');

  // Ping
  const pg = sCoop.playerPing(p1, p1.x, 1.6, p1.z, 0, 0, -1);
  ok(!!pg && sCoop.events.some(e => e.t === 'ping' && e.by === p1), 'playerPing emits ping event');

  // Share gear
  p2.x = p1.x + 1.0; p2.z = p1.z;
  const b1 = p1.bangs, b2 = p2.bangs;
  ok(sCoop.shareGear(p1) && p1.bangs === b1 - 1 && p2.bangs === b2 + 1, 'shareGear transfers flashbang to nearby teammate');

  // Downed + Revive
  const attacker = sCoop.suspects[0];
  p2.hp = 10;
  sCoop.damage(p2, 400, attacker, false);
  ok(p2.alive && p2.downed && p2.bleedT > 30 && !sCoop.over, 'fatal damage in co-op puts player into downed bleedout state while ally is alive');
  p1.x = p2.x + 0.7; p1.z = p2.z;
  p1.yaw = yawTo(p2.x - p1.x, p2.z - p1.z);
  sCoop.playerUse(p1);
  ok(p1.reviving === p2, 'playerUse targets downed teammate for revive');
  for (let k = 0; k < 30; k++) sCoop.update(0.1);
  ok(p2.alive && !p2.downed && p2.hp >= 35, 'completing revive restores downed teammate');

  // Breach sync countdown
  const door = sCoop.level.doors.find(d => !d.locked)!;
  p1.x = door.cx + 0.5; p1.z = door.cz + 1.2; p2.x = door.cx + 0.5; p2.z = door.cz + 1.4;
  sCoop.toggleBreachSync(p1); sCoop.toggleBreachSync(p2);
  ok(sCoop.breachSyncT > 2.5, 'breach sync starts countdown when 2 players ready up');
  for (let k = 0; k < 33; k++) sCoop.update(0.1);
  ok(door.target === 1, 'breach sync opens door at 0');

  // Snap sync for downed, torch, ads, speaking, shield & NetTarget interpolation
  p1.torch = false; p1.ads = true; p1.shield = true; p1.speaking = true; p1.weapon = 1; p1.pitch = 0.42;
  const mir2 = new Sim(0, 1, 1, 2);
  const tgMap = new Map<any, { x: number; z: number; yaw: number }>();
  applySnap(mir2, JSON.parse(JSON.stringify(encodeSnap(sCoop))), mir2.players[1], tgMap);
  ok(mir2.players[0].torch === false && mir2.players[0].ads === true && mir2.players[0].shield === true && mir2.players[0].speaking === true && mir2.players[0].weapon === 1 && Math.abs(mir2.players[0].pitch - 0.42) < 0.02, 'encodeSnap/applySnap syncs torch, ads, shield, speaking, weapon & pitch');
  ok(tgMap.has(mir2.players[0]), 'applySnap populates NetTarget map for smooth client interpolation');
  ok(sCoop.squadMvp().length === 2 && sCoop.squadMvp()[0].badge === 'SQUAD MVP', 'squadMvp ranks co-op players');
}

// ---- Phase 1-2 new tactical systems verification ----
{
  // 1) Multiple tactical entry points + PrePlan route execution
  for (let m = 0; m < MISSIONS.length; m++) {
    const l = buildLevel(m, 1);
    ok(l.entries.length >= 2, `mission ${m} defines >=2 tactical entries`);
  }
  const simPlan = new Sim(0, 1, 1, 1, {}, {
    entry: 1,
    teamB: [{ x: 10, z: 10 }, { x: 12, z: 12 }],
    teamA: [{ x: 14, z: 10 }, { x: 16, z: 12 }],
  });
  const e1 = simPlan.level.entries[1];
  ok(Math.hypot(simPlan.player.x - e1.x, simPlan.player.z - e1.z) < 0.05, 'preplan entry selects alternate insertion point');
  simPlan.executePreplan();
  ok(simPlan.teams.B.order.type === 'move' && simPlan.teams.A.order.type === 'move', 'executePreplan dispatches drawn routes to Team A and Team B');

  // 2) Lean offset + wall-safe clamping
  const sim = new Sim(0, 1, 1);
  const pl = sim.player;
  pl.yaw = 0;
  const lo = sim.leanOffset(pl, 1);
  ok(lo.actual > 0.5 && lo.lx > 0.15, 'leanOffset shifts camera laterally in open space');

  // 3) Smoke occlusion & CS gas stun/surrender
  const sus = sim.suspects[0];
  pl.x = sus.x + 4; pl.z = sus.z;
  const openLos = sim.los(pl.x, pl.z, sus.x, sus.z);
  sim.clouds.push({ kind: 'smoke', x: sus.x + 2, z: sus.z, r: 2.2, t: 10, maxT: 10 });
  ok(!openLos || !sim.los(pl.x, pl.z, sus.x, sus.z), 'smoke cloud blocks line of sight');
  sim.clouds.length = 0;
  sim.clouds.push({ kind: 'gas', x: sus.x, z: sus.z, r: 3.0, t: 10, maxT: 10 });
  for (let i = 0; i < 12; i++) sim.update(0.25);
  ok(sus.stun > 0 || sus.down, 'CS gas cloud stuns/forces surrender on exposed suspect');

  // 4) Optiwand emits live camera event for player
  const door = sim.level.doors[0];
  pl.x = door.cx + 0.5; pl.z = door.cz + (door.horiz ? 1.1 : 0.5);
  if (!door.horiz) pl.x += 0.6;
  sim.events.length = 0;
  sim.peekDoor(door, pl);
  ok(sim.events.some(e => e.t === 'optiwand'), 'peekDoor emits optiwand event for player PiP camera');

  // 5) Wallbang penetration through solid wood door (exclude glass doors)
  const woodDoor = sim.level.doors.find(d => d.horiz && !sim.isMetalDoor(d) && !sim.isGlassDoor(d))!;
  woodDoor.open = 0; woodDoor.target = 0;
  const wx = woodDoor.cx + 0.5, wz = woodDoor.cz + 0.5;
  sim.events.length = 0;
  sim.fire(pl, wx, 1.2, wz + 1.2, 0, 0, -1, 34, { pen: 1 });
  ok(sim.events.some(e => e.t === 'pen'), 'pen>=1 fire through closed wood door emits penetration event');

  // 6) Door tripwire trap: crackDoor discovers trap, disarmTrap neutralizes, otherwise opening detonates
  const trapDoor = sim.level.doors.find(d => !sim.isGlassDoor(d) && !d.locked && d !== woodDoor)!;
  trapDoor.open = 0; trapDoor.target = 0; trapDoor.trapped = true; trapDoor.trapKnown = false;
  sim.events.length = 0;
  ok(sim.crackDoor(trapDoor, pl) && !!trapDoor.trapKnown && sim.events.some(e => e.t === 'trap' && e.kind === 'found'), 'crackDoor exposes tripwire without detonating');
  ok(sim.disarmTrap(trapDoor, pl) && !trapDoor.trapped && sim.events.some(e => e.t === 'trap' && e.kind === 'disarmed'), 'disarmTrap safely removes tripwire');

  // 7) Ballistic shield blocks frontal rounds & emits shield event
  const sSh = new Sim(0, 2, 1);
  const shPl = sSh.player, shSus = sSh.suspects[0];
  shPl.shield = true; shPl.yaw = 0; // facing -Z (north)
  const hpBefore = shPl.hp;
  shSus.x = shPl.x; shSus.z = shPl.z - 2.5;
  sSh.events.length = 0;
  sSh.fire(shSus, shSus.x, 1.3, shSus.z, 0, 0, 1, 25);
  ok(shPl.hp === hpBefore && sSh.events.some(e => e.t === 'shield'), 'ballistic shield blocks frontal gunfire and emits shield event');

  // 8) Dropped evidence spawns on surrender & securing prevents fake-reclaim
  const sEv = new Sim(0, 3, 1);
  const evSus = sEv.suspects[0];
  evSus.armed = true; evSus.surrendered = false; evSus.morale = 0.2;
  sEv.player.x = evSus.x; sEv.player.z = evSus.z + 1.2;
  sEv.player.yaw = 0;
  // Force surrender via non-lethal hit, then restrain suspect before bagging evidence
  sEv.damage(evSus, 5, sEv.player, false, true);
  evSus.restrained = true;
  ok(sEv.evidence.length >= 1, 'surrendering armed suspect drops EvidenceItem');
  const evItem = sEv.evidence[0];
  sEv.player.x = evItem.x; sEv.player.z = evItem.z + 0.6; sEv.player.yaw = 0;
  sEv.playerUse(sEv.player);
  ok(evItem.secured && (sEv.stats.evidenceSecured ?? 0) >= 1, 'playerUse bags dropped weapon as secured evidence');

  // 9) Acoustic wall sensor deploys on wall and detects movement through wall
  const sSn = new Sim(0, 4, 1);
  const snDoor = sSn.level.doors.find(d => d.horiz && !sSn.isGlassDoor(d))!;
  snDoor.open = 0; snDoor.target = 0;
  sSn.player.x = snDoor.cx + 0.5; sSn.player.z = snDoor.cz + 1.4; sSn.player.yaw = 0;
  const snCountBefore = sSn.player.sensors;
  ok(sSn.deploySensor(sSn.player) && sSn.player.sensors === snCountBefore - 1 && sSn.sensors.length === 1, 'deploySensor plants acoustic sensor on wall/door surface');
  sSn.suspects[0].x = snDoor.cx + 0.5; sSn.suspects[0].z = snDoor.cz - 2.0; sSn.suspects[0].moving = true;
  sSn.update(0.8);
  ok(sSn.sensorPings.length >= 1, 'acoustic sensor pings moving suspect through walls');
}

// ---- operators never share the same spot (they used to clip into each other and shudder) ----
{
  const sSp = new Sim(0, 7, 1);
  // Keep the scene calm: nobody to fight, so we only measure squad movement.
  for (const a of sSp.actors) if (a.kind !== 'player' && a.kind !== 'officer') { a.surrendered = true; a.armed = false; a.restrained = true; }
  sSp.command({ team: 'A', action: 'move', dir: 'forward' }, null, sSp.player, { quiet: true });
  sSp.command({ team: 'B', action: 'move', dir: 'forward' }, null, sSp.player, { quiet: true });
  const offs = () => sSp.officers.filter(o => o.alive);
  let minDist = 9, maxFrameStep = 0;
  const prev = new Map<number, { x: number; z: number }>();
  for (let i = 0; i < 60 * 14; i++) {
    sSp.update(1 / 60);
    const list = offs();
    for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) {
      minDist = Math.min(minDist, Math.hypot(list[a].x - list[b].x, list[a].z - list[b].z));
    }
    if (i > 60 * 9) { // once the order has settled
      for (const o of list) {
        const p = prev.get(o.id);
        if (p) maxFrameStep = Math.max(maxFrameStep, Math.hypot(o.x - p.x, o.z - p.z));
        prev.set(o.id, { x: o.x, z: o.z });
      }
    }
  }
  ok(minDist > 0.5, `operators keep shoulder distance instead of merging (closest pair ${minDist.toFixed(2)} m)`);
  ok(maxFrameStep < 0.02, `settled operators stand still instead of shaking (${(maxFrameStep * 60).toFixed(2)} m/s residual)`);
}

console.log(fails ? `FAILED (${fails})` : 'ALL OK'); process.exit(fails ? 1 : 0);
