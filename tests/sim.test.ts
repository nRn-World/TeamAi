import { RANKS, gearUnlockXp, isGearUnlocked, missionUnlocked, nextUncleared, campaignComplete, defaultCareer, applyMissionResult, deployRoster, normaliseCareer } from '../src/game/career';
import { Sim, yawTo, fwd } from '../src/sim/sim';
import type { Command } from '../src/sim/sim';
import { parseCommand, parseCommands, shouldUseAiBrain } from '../src/sim/commands';
import { buildLocalReport, buildTacticalContext } from '../src/sim/context';
import { findPath, nearestWalkable, walkLine } from '../src/sim/nav';
import { MISSIONS, buildLevel, groundHeightAt, roomAt, FLOOR, WALL, OUT, HIGH, WINDOW } from '../src/sim/level';
import { encodeSnap, applySnap, encodeEv, decodeEv } from '../src/sim/netstate';
import { normalizePeerEnvelopeWithSize, normalizePeerMessage, consumePeerBudget, consumePeerBytes, type PeerReceiveBudget } from '../src/game/netprotocol';
import { TacticalAi } from '../src/game/ai';

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
  // search & secure the room we are in — but "secure them" must still mean handcuffs
  ['search this room', 'ALL secure'], ['sweep the area', 'ALL secure'], ['sök området', 'ALL secure'], ['säkra rummet', 'ALL secure'],
  ['team b sök igenom rummet', 'B secure'], ['team a secure the room', 'A secure'], ['secure them', 'ALL restrain'], ['cuff them', 'ALL restrain'],
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
  ok(sim.teams.A.order.type === 'hold' && sim.teams.B.order.type === 'hold', 'the squad holds position until it is told to follow');
  sim.command({ team: 'A', action: 'follow' });
  sim.command({ team: 'A', action: 'hold', who: 0 });
  ok(!!ken.solo && ken.solo.order.type === 'hold' && !maya.solo && sim.teams.A.order.type === 'follow', 'solo order leaves the team order alone');
  const k0 = { x: ken.x, z: ken.z }, m0 = { x: maya.x, z: maya.z };
  // Follow means she moves with the player; once he stops she takes a guarding post again, which can
  // well be where she started, so the walk itself is what is measured.
  let mayaFar = 0;
  for (let i = 0, a = p.yaw; i < 240; i++) {
    (sim as any).checkT = 9; p.x += Math.sin(a) * 0.03; p.z += Math.cos(a) * 0.03;
    if (sim.solidCell(Math.floor(p.x), Math.floor(p.z))) { p.x -= Math.sin(a) * 0.03; p.z -= Math.cos(a) * 0.03; a += 1.3; }
    sim.update(1 / 30);
    mayaFar = Math.max(mayaFar, Math.hypot(maya.x - m0.x, maya.z - m0.z));
  }
  ok(Math.hypot(ken.x - k0.x, ken.z - k0.z) < 1, 'Ken holds while the others follow');
  ok(mayaFar > 0.5, `Maya keeps following (${mayaFar.toFixed(2)} m from her start)`);
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
    for (const a of sim.actors) {
      ok(Number.isFinite(a.x) && Number.isFinite(a.z), 'NaN position');
      if (Math.floor(t * 4) !== Math.floor((t - dt) * 4) && a.alive) {
        ok(sim.isActorPositionClear(a.x, a.z, a.r),
          `actor ${a.kind}#${a.id} intersects a wall, door, prop or exterior collider at ${a.x.toFixed(2)},${a.z.toFixed(2)}`);
      }
      if (a.alive && !a.down && sim.solidCell(Math.floor(a.x), Math.floor(a.z)) && sim.cell(Math.floor(a.x), Math.floor(a.z)) !== 3) { fails++; if (fails < 20) console.log('  FAIL actor inside solid', a.name, a.x.toFixed(2), a.z.toFixed(2), sim.cell(Math.floor(a.x), Math.floor(a.z))); }
      maxStuck = Math.max(maxStuck, a.stuckT);
    }
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
    const rp = host.players[1]; host.moveCircle(rp, 0, -0.02); host.pushTrail(rp); // remote player walks north through collision-safe movement
    host.update(1 / 30);
    const wire = JSON.parse(JSON.stringify({ s: encodeSnap(host), e: host.events.map(encodeEv) })); host.events.length = 0;
    ok(applySnap(mir, wire.s, me), 'valid co-op snapshot is accepted');
    for (const e of wire.e) { const d = decodeEv(mir, e); if (!d) { ok(false, 'valid event is decoded'); continue; } evs++; if ('a' in d) ok(d.a === mir.actors[(d.a as any).id], 'event actor decode'); }
  }
  ok(mir.officers.every((o, i) => Math.abs(o.x - host.officers[i].x) < 0.02 && Math.abs(o.z - host.officers[i].z) < 0.02), 'mirror positions');
  ok(mir.teams.A.order.type === host.teams.A.order.type && mir.level.doors.every((d, i) => Math.abs(d.open - host.level.doors[i].open) < 0.02), 'mirror orders/doors');
  const a1 = host.officers[0], rp = host.players[1]; ok(Math.hypot(a1.x - rp.x, a1.z - rp.z) < 5, 'team A follows the remote player: ' + Math.hypot(a1.x - rp.x, a1.z - rp.z).toFixed(1));
  ok(evs > 0, 'events forwarded');
  host.damage(host.players[0], 9999, host.suspects[0], false); ok(!host.over, 'mission continues while a player is alive');
  host.damage(host.players[1], 9999, host.suspects[0], false); host.damage(host.players[2], 9999, host.suspects[0], false); ok(!!host.over && !host.over.win, 'mission fails when all players are down');
  console.log('co-op mirror test done');
}
// ---- hostile network payload validation and bounded input budget ----
{
  const host = new Sim(0, 19, 1, 2), mirror = new Sim(0, 19, 1, 2), player = mirror.players[1];
  const valid = JSON.parse(JSON.stringify(encodeSnap(host)));
  ok(applySnap(mirror, valid, player), 'a structurally valid snapshot is accepted');
  const xBefore = player.x, badPosition = JSON.parse(JSON.stringify(valid)); badPosition.a[1][0] = 999999;
  ok(!applySnap(mirror, badPosition, player) && player.x === xBefore, 'invalid snapshots are rejected atomically before mutation');
  const badDoor = JSON.parse(JSON.stringify(valid)); badDoor.o[0][2] = host.actors.length + 50;
  ok(!applySnap(mirror, badDoor, player), 'invalid snapshot actor references are rejected');
  const unsafeMvp = JSON.parse('{"name":"x","arrests":0,"kills":0,"shots":0,"hits":0,"dmgTaken":0,"__proto__":{"polluted":true},"alive":false}');
  const badMvp = JSON.parse(JSON.stringify(valid)); badMvp.over = 1; badMvp.mvp = [unsafeMvp];
  const guarded = new Sim(0, 19, 1, 2), guardedProto = Object.getPrototypeOf(guarded.players[0]);
  ok(!applySnap(guarded, badMvp, guarded.players[0]) && Object.getPrototypeOf(guarded.players[0]) === guardedProto && guarded.players[0].alive,
    'snapshot MVP fields are allowlisted before Object.assign can mutate an actor');
  ok(decodeEv(mirror, { t: 'hurt', a: { $a: 9999 }, head: true }) === null, 'events with invalid actor ids are ignored');
  ok(decodeEv(mirror, { t: '__proto__' }) === null && decodeEv(mirror, { t: 'toString' }) === null,
    'inherited object-property names are not mistaken for valid event types');
  ok(normalizePeerMessage({ t: 'toString' }) === null, 'inherited object-property names are rejected as wire message types');
  ok(normalizePeerMessage({ t: 'ping', d: [0, 0, -1] })?.t === 'ping', 'valid peer ping passes schema validation');
  ok(normalizePeerMessage({ t: 'ping', d: [Infinity, 0, 0] }) === null, 'non-finite peer vectors are rejected');
  ok(normalizePeerMessage({ t: 'ping', d: [0, 0, -1], admin: true }) === null, 'unexpected top-level peer fields are rejected');
  ok(normalizePeerMessage({ t: 'fire', weapon: 0, dirs: [[0, 0, -1]] })?.t === 'fire', 'valid weapon-and-aim fire request passes validation');
  const validInput = { t: 'in', x: 1, z: 1, yaw: Math.PI, pitch: 0, cr: false, pr: false, ln: 0, jy: 0, mv: false, tc: true, ads: false, wp: 0, sh: false, sp: false };
  ok(normalizePeerMessage(validInput)?.t === 'in' && normalizePeerMessage({ ...validInput, yaw: Math.PI * 9 }) === null,
    'player yaw is normalized to one turn before crossing the network');
  ok(normalizePeerMessage({ t: 'fire', o: [0, 1, 0], d: [0, 0, -1], dmg: 999, nl: true, ts: true, pen: 1 }) === null, 'client-supplied shot origin, damage and flags are rejected');
  ok(normalizePeerMessage({ t: 'cmd', cmd: { team: 'A', action: 'follow', extra: true }, aim: null }) === null,
    'unexpected nested command fields are rejected too');
  const hostileGetter = Object.defineProperty({}, 't', { get() { throw new Error('untrusted getter'); } });
  ok(normalizePeerMessage(hostileGetter) === null, 'peer-message normalization catches throwing accessors before reading fields');
  const budget: PeerReceiveBudget = { messages: 1, bytes: 100, updatedAt: 1000 };
  ok(consumePeerBudget(budget, 40, 1000) && !consumePeerBudget(budget, 1, 1000), 'peer receive budget rejects excess packet bursts');
  const malformed = normalizePeerEnvelopeWithSize({ t: 'ping', d: [0, 0, -1], extra: 'x'.repeat(256) });
  const byteBudget: PeerReceiveBudget = { messages: 1, bytes: 100, updatedAt: 1000 };
  ok(malformed?.message === null && malformed.bytes > 100 && !consumePeerBytes(byteBudget, malformed.bytes, 1000) && byteBudget.bytes === 0,
    'schema-invalid payloads still consume or exhaust the serialized-byte budget');
  const expiredTimers = new Sim(0, 19, 1, 2);
  expiredTimers.actors[0].stun = -0.04; expiredTimers.players[1].bleedT = -0.04;
  const cleanExpiredTimers = encodeSnap(expiredTimers);
  const expiredMirror = new Sim(0, 19, 1, 2);
  ok(cleanExpiredTimers.a[0][6] === 0 && cleanExpiredTimers.p[1][6] === 0
    && applySnap(expiredMirror, cleanExpiredTimers, expiredMirror.players[0]),
    'expired stun and bleed timers are clamped so valid snapshots remain acceptable');
  const hp = host.player.hp; host.damage(host.player, -25, host.suspects[0], false);
  ok(host.player.hp === hp, 'negative damage cannot heal an actor');
}

// ---- training mode: no live threats while the player practises ----
{
  const train = new Sim(0, 1, 0, 1, { training: true });
  const hp = train.player.hp;
  for (let i = 0; i < 5 * 30; i++) { train.update(1 / 30); train.events.length = 0; }
  ok(train.player.hp === hp && !train.suspects.some(s => s.hostile) && !train.over,
    'training mode keeps suspects and civilians quiet and the trainee unhurt');
}
// ---- Kista Tech Center: two-storey navigation, interactions, effects and co-op teleports ----
{
  const mission = MISSIONS.findIndex(m => m.name === 'Kista Tech Center');
  ok(mission >= 0, 'Kista Tech Center is in the mission list');
  if (mission >= 0) {
    const level = buildLevel(mission, 1), stair = level.staircases[0], lift = level.elevators[0];
    const vip = level.suspects.find(s => s.hostage);
    ok(!!stair && !!lift && !!vip, 'Kista has stairs, a paired service elevator and a hostage');
    if (stair && lift && vip) {
      ok(Math.abs(stair.toY - stair.fromY - 3) < 0.01
        && Math.abs(groundHeightAt(level, stair.x0, stair.z0) - stair.fromY) < 0.05
        && Math.abs(groundHeightAt(level, stair.x1, stair.z1) - stair.toY) < 0.05,
      'stair floor height interpolates the three-metre rise from F1 to F2');
      ok(level.cells[15 * level.w + 33] === FLOOR
        && walkLine(level, { x: 32.8, z: 15.5 }, { x: 33.6, z: 15.5 }),
      'the top of the flight opens through the F2 command-floor wall');
      ok(level.cells[15 * level.w + 25] === FLOOR
        && walkLine(level, { x: 24.6, z: 15.5 }, { x: 25.8, z: 15.5 }),
      'the bottom landing opens into the F1 operations floor');
      ok(level.props.every(p => {
        const dx = p.cx + 0.5 - stair.x0, dz = p.cz + 0.5 - stair.z0;
        const t = (dx * (stair.x1 - stair.x0) + dz * (stair.z1 - stair.z0)) / Math.hypot(stair.x1 - stair.x0, stair.z1 - stair.z0) ** 2;
        const lat = Math.abs(dx * (stair.z1 - stair.z0) - dz * (stair.x1 - stair.x0)) / Math.hypot(stair.x1 - stair.x0, stair.z1 - stair.z0);
        return !(t >= -0.15 && t <= 1.15 && lat <= stair.width / 2 + 1.1);
      }), 'furniture stays clear of the stair flight');
      ok(groundHeightAt(level, vip.x, vip.z) > 2.9 && level.rooms[vip.room]?.name === 'Hostage Wing · F2',
        'hostage suspect spawns in the upper-floor hostage wing');
      const vipCivilian = new Sim(mission, 3).civs.find(c => c.vip);
      ok(!!vipCivilian && groundHeightAt(level, vipCivilian.x, vipCivilian.z) > 2.9
        && roomAt(level, vipCivilian.x, vipCivilian.z)?.name === 'Hostage Wing · F2',
      'VIP civilian objective spawns on F2 in the hostage wing');

      const route = findPath(level, level.playerSpawn, vip);
      ok(!!route?.length, 'A* finds a walkable route from the entry to the F2 VIP');
      if (route?.length) {
        let from: { x: number; z: number } = level.playerSpawn, climbed = false, smooth = true;
        for (const to of route) {
          const d = Math.hypot(to.x - from.x, to.z - from.z), n = Math.max(1, Math.ceil(d / 0.1));
          let prev = groundHeightAt(level, from.x, from.z);
          if (!walkLine(level, from, to)) smooth = false;
          for (let i = 1; i <= n; i++) {
            const x = from.x + (to.x - from.x) * i / n, z = from.z + (to.z - from.z) * i / n;
            const y = groundHeightAt(level, x, z);
            if (Math.abs(y - prev) > 0.12) smooth = false;
            if (y > 0.25 && y < 2.75) climbed = true;
            prev = y;
          }
          from = to;
        }
        ok(smooth && climbed, 'smoothed navigation climbs the graded stair route without a floor-height shortcut');
      }

      const walker = new Sim(mission, 7), player = walker.player;
      for (const a of walker.actors) if (a !== player) a.alive = false;
      player.x = stair.x0 - 0.3; player.z = stair.z0; player.yaw = Math.PI / 2;
      for (let i = 0; i < 90; i++) walker.movePlayer(0.1, 0);
      ok(groundHeightAt(walker.level, player.x, player.z) > 2.9,
        'player collision movement can walk up the rendered staircase to F2');

      // The player route also has to work with the live squad behind it: follow uses the player
      // trail and has to cross the same graded stair cells without a floor-height jump.
      const squad = new Sim(mission, 12, 0), lead = squad.player;
      lead.x = 24.2; lead.z = 15.5; lead.yaw = Math.PI / 2;
      squad.officers.forEach((o, i) => { o.x = 22.8; o.z = 14.2 + i * 0.9; o.path = null; o.goal = null; });
      squad.command({ team: 'ALL', action: 'follow' });
      for (let i = 0; i < 600; i++) {
        lead.yaw = Math.PI / 2;
        if (squad.floorY(lead.x, lead.z) < 2.95 && lead.x < stair.x1 + 0.7) squad.movePlayer(0.03, 0);
        squad.update(1 / 30);
        squad.events.length = 0;
      }
      const followersUp = squad.officers.filter(o => squad.floorY(o.x, o.z) > 2.9).length;
      ok(squad.floorY(lead.x, lead.z) > 2.9 && followersUp === squad.officers.length,
        `the live squad follows the player up the staircase (${followersUp}/${squad.officers.length} on F2)`);

      const floors = new Sim(mission, 9), lower = { x: stair.x0, z: stair.z0 }, upper = { x: stair.x1, z: stair.z1 };
      ok(!floors.sameFloor(lower, upper) && !floors.los(lower.x, lower.z, upper.x, upper.z),
        'line of sight is separated across the F1/F2 floor-height gap');
      const hostage = floors.suspects.find(a => a.hostage)!;
      for (const a of floors.actors) if (a !== hostage) a.alive = false;
      hostage.x = upper.x; hostage.z = upper.z; hostage.stun = 0; hostage.surrendered = false;
      (floors as any).detonate(lower.x, lower.z, 'bang', groundHeightAt(floors.level, lower.x, lower.z) + 0.06);
      ok(hostage.stun === 0 && !hostage.surrendered,
        'a flashbang on F1 does not stun or surrender an actor on F2');
      floors.clouds.push({ kind: 'gas', x: lower.x, y: 0, z: lower.z, r: 20, t: 10, maxT: 10 });
      (floors as any).gasTickT = 0;
      (floors as any).updateClouds(0.5);
      ok(hostage.stun === 0 && !hostage.surrendered,
        'gas cloud damage and surrender effects stay on the grenade floor');

      // Synthetic overlapping-floor checks exercise filters at short XZ distance, where a 2D-only
      // query would incorrectly alert, target, interact with, or blast the actor above.
      const floorAi = new Sim(mission, 10), lowerPlayer = floorAi.player, upperSuspect = floorAi.suspects[0], officer = floorAi.officers[0];
      for (const a of floorAi.actors) if (a !== lowerPlayer && a !== upperSuspect && a !== officer) a.alive = false;
      lowerPlayer.x = 29.5; lowerPlayer.z = 10.5;
      upperSuspect.x = 30.5; upperSuspect.z = 10.5; upperSuspect.alive = true; upperSuspect.surrendered = false; upperSuspect.armed = true; upperSuspect.alertT = 0;
      officer.x = 28.5; officer.z = 10.5;
      floorAi.level.groundY[10 * floorAi.level.w + 30] = 3;
      floorAi.level.groundY[10 * floorAi.level.w + 31] = 3;
      (floorAi as any).noise(lowerPlayer.x, lowerPlayer.z, 5);
      floorAi.playerShout(lowerPlayer);
      ok(upperSuspect.alertT === 0 && !upperSuspect.surrendered
        && (floorAi as any).pickThreat(officer) === null
        && floorAi.interactTarget(lowerPlayer)?.actor !== upperSuspect,
      'noise, shouts, AI threat selection and interactions reject a nearby actor on another floor');
      officer.x = 31.5; officer.z = 10.5;
      ok(buildTacticalContext(floorAi, lowerPlayer).includes('above you'),
        'tactical report describes an officer on another floor as above/below, not beside the player');

      const c2Floors = new Sim(mission, 21), c2Door = c2Floors.level.doors.find(d => d.cx === 8 && d.cz === 12)!, c2Target = c2Floors.suspects[0];
      for (const a of c2Floors.actors) if (a !== c2Floors.player && a !== c2Target) a.alive = false;
      c2Target.x = 9.5; c2Target.z = 11.5; c2Target.hp = 100; c2Target.alive = true;
      c2Floors.level.groundY[11 * c2Floors.level.w + 9] = 3;
      c2Floors.c2Door(c2Door, c2Floors.player);
      const c2Event = c2Floors.events.find(e => e.t === 'c2');
      ok(c2Target.hp === 100 && c2Event?.t === 'c2' && Math.abs((c2Event.y ?? -1) - (c2Door.floorY ?? 0)) < 0.01,
        'C2 blast damage and effect height are restricted to the breached floor');

      const trapFloors = new Sim(mission, 23), trapDoor = trapFloors.level.doors.find(d => d.cx === 8 && d.cz === 12)!, trapTarget = trapFloors.suspects[0];
      for (const a of trapFloors.actors) if (a !== trapFloors.player && a !== trapTarget) a.alive = false;
      trapTarget.x = 9.5; trapTarget.z = 11.5; trapTarget.hp = 100; trapTarget.alive = true;
      trapFloors.level.groundY[11 * trapFloors.level.w + 9] = 3;
      trapDoor.locked = false; trapDoor.trapped = true; trapDoor.trapKnown = false;
      trapFloors.setDoor(trapDoor, true, false, false, false, trapFloors.player);
      const trapBang = trapFloors.events.find(e => e.t === 'bang');
      ok(trapTarget.hp === 100 && trapBang?.t === 'bang' && Math.abs((trapBang.y ?? -1) - (trapDoor.floorY ?? 0)) < 0.01,
        'tripwire damage and detonation effects do not leak through to another floor');

      const liftSim = new Sim(mission, 11), lp = liftSim.player, [from, to] = lift.stops;
      for (const a of liftSim.actors) if (a !== lp) a.alive = false;
      lp.x = from.x; lp.z = from.z; lp.yaw = from.yaw;
      ok(!!liftSim.interactTarget(lp)?.elevatorTo, 'service elevator stop offers an interaction');
      liftSim.playerUse(lp);
      const car = liftSim.elevators[0];
      ok(car.phase === 'opening' && car.door < 0.1 && Math.hypot(lp.x - to.x, lp.z - to.z) > 1,
        'pressing the landing button starts an animated door cycle instead of teleporting');
      let sawOpen = false, sawClosed = false, sawMove = false;
      for (let i = 0; i < 25 * 30; i++) {
        liftSim.over = null; // the whole squad is dead: keep only the elevator running for this check
        liftSim.update(1 / 30);
        if (car.phase === 'open') sawOpen = true;
        if (car.phase === 'closing') sawClosed = true;
        if (car.phase === 'moving') sawMove = true;
        if (Math.hypot(lp.x - to.x, lp.z - to.z) < 0.02) break;
      }
      ok(sawOpen && sawClosed && sawMove, 'the landing doors open, hold, close, and the car travels before arriving');
      ok(Math.hypot(lp.x - to.x, lp.z - to.z) < 0.02 && Math.abs(groundHeightAt(liftSim.level, lp.x, lp.z) - to.floorY) < 0.1
        && lp.nx === lp.x && lp.nz === lp.z && lp.nd === 0 && lp.nt === 0,
        'the car carries the player to the other landing and resets the footstep accumulator');
      ok((car.phase === 'opening' || car.phase === 'open') && car.at === 1,
        'the lift opens its doors again on arrival at the upper floor');
      for (let i = 0; i < 10 * 30 && car.phase !== 'idle'; i++) { liftSim.over = null; liftSim.update(1 / 30); }
      ok(!!liftSim.interactTarget(lp)?.elevatorTo, 'upper elevator stop offers a return trip once the car is idle');
      liftSim.playerUse(lp);
      for (let i = 0; i < 25 * 30; i++) {
        liftSim.over = null;
        liftSim.update(1 / 30);
        if (Math.hypot(lp.x - from.x, lp.z - from.z) < 0.02) break;
      }
      ok(Math.hypot(lp.x - from.x, lp.z - from.z) < 0.02, 'service elevator works in both directions');

      for (let i = 0; i < 10 * 30 && car.phase !== 'idle'; i++) { liftSim.over = null; liftSim.update(1 / 30); }
      liftSim.over = null;
      lp.x = to.x; lp.z = to.z; lp.path = null; lp.goal = null;
      ok(!!liftSim.interactTarget(lp)?.elevatorTo, 'the upper landing can call a car parked downstairs');
      liftSim.playerUse(lp);
      ok(car.phase === 'moving' && car.pending === lp && car.at === 0,
        'a call from the far floor sends the empty car over instead of teleporting it');
      ok(!!encodeSnap(liftSim).el?.[0]?.[5], 'the empty-car call is replicated to co-op clients');
      for (let i = 0; i < 25 * 30; i++) {
        liftSim.over = null;
        liftSim.update(1 / 30);
        if (car.phase === 'open' && car.at === 1) break;
      }
      ok(car.at === 1 && car.rider === lp && car.target === 0,
        'the arriving car opens and takes the waiting officer aboard');
      ok(!encodeSnap(liftSim).el?.[0]?.[5], 'the replicated call flag clears once the officer is aboard');
      for (let i = 0; i < 25 * 30; i++) {
        liftSim.over = null;
        liftSim.update(1 / 30);
        if (Math.hypot(lp.x - from.x, lp.z - from.z) < 0.02) break;
      }
      ok(Math.hypot(lp.x - from.x, lp.z - from.z) < 0.02, 'the called car carries the officer back down');

      // Walking out of the open doors cancels the ride instead of dragging the player along.
      const away = new Sim(mission, 23), ap = away.player;
      for (const a of away.actors) if (a !== ap) { a.alive = false; }
      ap.x = from.x; ap.z = from.z; ap.yaw = from.yaw;
      away.over = null;
      away.playerUse(ap);
      const awayCar = away.elevators[0];
      for (let i = 0; i < 10 * 30 && awayCar.phase !== 'open'; i++) { away.over = null; away.update(1 / 30); }
      ap.x = from.x; ap.z = from.z + 4.2;
      for (let i = 0; i < 10 * 30 && awayCar.phase !== 'idle'; i++) { away.over = null; away.update(1 / 30); }
      ok(awayCar.phase === 'idle' && awayCar.at === 0 && Math.hypot(ap.x - to.x, ap.z - to.z) > 4,
        'walking away before the doors shut cancels the ride');

      // A call whose caller walks off must not drag them into the car when it reaches the landing.
      const wander = new Sim(mission, 29), wp = wander.player;
      for (const a of wander.actors) if (a !== wp) a.alive = false;
      const wcar = wander.elevators[0];
      wcar.at = 1; wcar.phase = 'idle'; wcar.door = 0;
      wp.x = from.x; wp.z = from.z; wp.yaw = from.yaw;
      wander.over = null;
      wander.playerUse(wp);
      ok(wcar.pending === wp, 'the empty car answers the call');
      wp.x = from.x; wp.z = from.z + 4.2;
      for (let i = 0; i < 30 * 30 && wcar.phase !== 'idle'; i++) { wander.over = null; wander.update(1 / 30); }
      ok(wcar.phase === 'idle' && wcar.at === 0 && Math.hypot(wp.x - to.x, wp.z - to.z) > 4,
        'a caller who walks away is not taken along when the empty car arrives');

      const grenades = new Sim(mission, 13), gx = vip.x, gz = vip.z, gy = groundHeightAt(grenades.level, gx, gz);
      for (const a of grenades.actors) if (a !== grenades.player) a.alive = false;
      grenades.grenades.push({ kind: 'smoke', x: gx, y: gy + 0.01, z: gz, vx: 0, vy: 0, vz: 0, t: 0.01 });
      (grenades as any).updateGrenades(0.1);
      const smoke = grenades.clouds[0], smokeEvent = grenades.events.find(e => e.t === 'smoke');
      ok(gy > 2.9 && Math.abs((smoke?.y ?? 0) - gy) < 0.05 && (smokeEvent?.t === 'smoke' && (smokeEvent.y ?? 0) > 2.9),
        'grenade bounce, smoke cloud and event stay at the local upper-floor height');

      const host = new Sim(mission, 17, 1, 2), mirror = new Sim(mission, 17, 1, 2), remote = host.players[1], local = mirror.players[1];
      mirror.player = local;
      for (const a of host.actors) if (a !== remote) a.alive = false;
      remote.x = from.x; remote.z = from.z; remote.yaw = from.yaw;
      host.playerUse(remote);
      for (let i = 0; i < 25 * 30; i++) { host.over = null; host.update(1 / 30); if (Math.hypot(remote.x - to.x, remote.z - to.z) < 0.02) break; }
      applySnap(mirror, JSON.parse(JSON.stringify(encodeSnap(host))), local);
      ok(Math.hypot(local.x - to.x, local.z - to.z) < 0.02 && groundHeightAt(mirror.level, local.x, local.z) > 2.9
        && local.nx === local.x && local.nz === local.z && local.nd === 0 && local.nt === 0,
        'co-op snapshot applies the elevator teleport and resets the local movement history');
    }
  }
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
{ // every generated entry/spawn must have full-body clearance from walls, doors, props and vehicles
  for (let m = 0; m < MISSIONS.length; m++) for (const seed of [1, 2, 14, 22, 77]) for (const entry of [0, 1]) {
    const sim = new Sim(m, seed, 1, 3, {}, { entry });
    for (const a of sim.actors) {
      ok(sim.isActorPositionClear(a.x, a.z, a.r), `spawn ${m}/${seed}/entry${entry}: ${a.kind}#${a.id} overlaps map geometry`);
      for (const b of sim.actors) {
        if (b.id <= a.id || !a.alive || !b.alive) continue;
        ok(Math.hypot(a.x - b.x, a.z - b.z) >= a.r + b.r + 0.04 - 1e-8,
          `spawn ${m}/${seed}/entry${entry}: ${a.kind}#${a.id} overlaps ${b.kind}#${b.id}`);
      }
    }
  }
  console.log('spawn clearance test done');
}
{ // walls and furniture stop the whole body, not just the actor's centre tile
  const edge = new Sim(2, 1), p = edge.player;
  p.x = 22.5; p.z = 29.0;
  for (let i = 0; i < 40; i++) {
    edge.moveCircle(p, 0, 0.1);
    ok(edge.isActorPositionClear(p.x, p.z, p.r), 'player body stays outside the hotel perimeter wall');
  }
  ok(p.z <= 31 - p.r + 1e-6, 'player stops at the hotel wall with body clearance');

  const props = new Sim(0, 1), actor = props.player, prop = props.level.props[0];
  const pw = prop.w ?? 1, pd = prop.d ?? 1;
  actor.x = prop.cx + pw + 0.5; actor.z = prop.cz + pd / 2;
  ok(props.isActorPositionClear(actor.x, actor.z, actor.r), 'test actor starts clear of a placed prop');
  for (let i = 0; i < 24; i++) {
    props.moveCircle(actor, -0.1, 0);
    ok(props.isActorPositionClear(actor.x, actor.z, actor.r), 'player body stays outside furniture collision cells');
  }
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
  ok(sc.bomb!.time === t0 && !sc.bomb!.started, 'bomb timer is held until the squad closes in or a firefight starts');
  sc.bomb!.started = true;
  sc.update(1.0);
  ok(sc.bomb!.time < t0, 'bomb timer counts down once it is armed');
  sc.bomb!.defused = true;
  ok(sc.debriefNotes().length > 0, 'debriefNotes provides tactical feedback');

  // 5. Netstate sync for new fields (locked, wedged, power, bomb, brokenWindows, brokenProps, brokenDoorGlass)
  const host = new Sim(4, 3, 1, 2), mir = new Sim(4, 3, 1, 2);
  host.powerOn = false;
  host.level.doors[0].wedged = true;
  if (host.level.windows[0]) host.brokenWindows.add(Math.floor(host.level.windows[0].z) * host.level.w + Math.floor(host.level.windows[0].x));
  host.brokenProps.add(host.level.props[0].cz * host.level.w + host.level.props[0].cx);
  host.brokenDoorGlass.add(host.level.doors[0].id);
  host.bomb!.time = 42.5; host.bomb!.started = true;
  applySnap(mir, JSON.parse(JSON.stringify(encodeSnap(host))), mir.players[1]);
  ok(!mir.powerOn && !!mir.level.doors[0].wedged && Math.abs(mir.bomb!.time - 42.5) < 0.1 && !!mir.bomb!.started && mir.brokenWindows.size === host.brokenWindows.size && mir.brokenProps.size === 1 && mir.brokenDoorGlass.size === 1, 'netstate syncs power, wedge, bomb state, broken windows, broken props & door glass');

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
  // 7d. Marauder vehicle OBB blocks player & bullets in every mission that includes the vehicle
  for (let m = 0; m < MISSIONS.length; m++) {
    const sm = new Sim(m, 1);
    const v = sm.level.vehicle;
    if (!v) continue;
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

  // 11. Bullet ray precision & no invisible mid-air hits (sealed exteriors, interior glass, broken props, trees, perimeter sky)
  const sRay = new Sim(0, 1, 1);
  // Nothing may be visible from the street: the office front at x=13.5, z=20.5 is solid wall, so a
  // bullet stops there at every height instead of passing into the lobby.
  for (const y of [0.5, 1.6, 2.5]) {
    const h = sRay.ray(13.5, y, 22.0, 0, 0, -1, 10, sRay.player);
    ok(h.kind === 'wall' && h.d < 2.0, `sealed front wall stops the bullet at y=${y} (${h.kind} at ${h.d.toFixed(2)})`);
  }
  // Interior glass partition (corridor ↔ meeting room): glass band 0.9–2.3 m passes, the sill blocks.
  const hWin = sRay.ray(14.5, 1.6, 12.2, 0, 0, -1, 4, sRay.player);
  ok(hWin.d > 1.8, `interior glass partition lets a bullet through at 1.6 m (d=${hWin.d.toFixed(2)}, ${hWin.kind})`);
  const hSill = sRay.ray(14.5, 0.5, 12.2, 0, 0, -1, 4, sRay.player);
  ok(hSill.kind === 'wall', `the sill below the partition stops a bullet at 0.5 m (got ${hSill.kind})`);
  // Every remaining window is an interior partition; none sits in an exterior wall.
  const outsideWin = sRay.level.windows.filter(w => {
    const cx = Math.floor(w.x), cz = Math.floor(w.z);
    return sRay.cell(cx, cz + 1) === OUT || sRay.cell(cx, cz - 1) === OUT || sRay.cell(cx + 1, cz) === OUT || sRay.cell(cx - 1, cz) === OUT;
  });
  ok(outsideWin.length === 0, `no window sits in an exterior wall (${outsideWin.length} found)`);
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

  // Snap sync for downed, lean, torch, ads, speaking, shield & NetTarget interpolation
  p1.torch = false; p1.ads = true; p1.shield = true; p1.speaking = true; p1.weapon = 1; p1.pitch = 0.42; p1.lean = -0.86;
  const mir2 = new Sim(0, 1, 1, 2, { blackout: true, extraHostiles: 3, pistolOnly: true });
  const tgMap = new Map<any, { x: number; z: number; yaw: number }>();
  applySnap(mir2, JSON.parse(JSON.stringify(encodeSnap(sCoop))), mir2.players[1], tgMap);
  ok(mir2.players[0].torch === false && mir2.players[0].ads === true && mir2.players[0].shield === true && mir2.players[0].speaking === true && mir2.players[0].weapon === 1 && Math.abs(mir2.players[0].pitch - 0.42) < 0.02, 'encodeSnap/applySnap syncs torch, ads, shield, speaking, weapon & pitch');
  ok(Math.abs(mir2.players[0].lean + 0.86) < 0.02, 'encodeSnap/applySnap syncs the third-person co-op lean pose');
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

  // 2) Strong Q/E lean + safe clamping at walls
  const sim = new Sim(0, 1, 1);
  const pl = sim.player;
  pl.yaw = 0;
  const start = { x: pl.x, z: pl.z };
  const lo = sim.leanOffset(pl, 1);
  ok(lo.actual > 0.98 && lo.lx > 0.60, 'full lean gives a clear 62cm right-side peek in open space');
  const left = sim.leanOffset(pl, -1);
  ok(left.actual < -0.98 && left.lx < -0.60, 'Q gives the same strong peek on the opposite side');

  // Find an interior floor cell beside an east wall and prove the camera stops before crossing it.
  let wallCase: { x: number; z: number } | null = null;
  for (let z = 2; z < sim.level.h - 2 && !wallCase; z++) for (let x = 2; x < sim.level.w - 2 && !wallCase; x++) {
    if (sim.cell(x, z) !== FLOOR || sim.cell(x + 1, z) !== WALL) continue;
    pl.x = x + 0.5; pl.z = z + 0.5;
    const clamped = sim.leanOffset(pl, 1);
    if (clamped.actual > 0.4 && clamped.actual < 0.99) wallCase = { x: pl.x, z: pl.z };
  }
  ok(!!wallCase, 'wall test found a usable cover edge');
  if (wallCase) {
    pl.x = wallCase.x; pl.z = wallCase.z;
    const clamped = sim.leanOffset(pl, 1);
    ok(clamped.actual < 1 && clamped.actual > 0.4, 'lean amount clamps smoothly at a wall instead of passing through it');
    ok(!sim.solidCell(Math.floor(pl.x + clamped.lx), Math.floor(pl.z + clamped.lz)), 'leaned camera stays on the visible side of cover');
  }
  pl.x = start.x; pl.z = start.z;

  // A leaned shot uses that same safe shoulder origin and still stops on cover.
  const shotSim = new Sim(0, 1, 1), shooter = shotSim.player;
  let shotCover: { x: number; z: number } | null = null;
  for (let z = 3; z < shotSim.level.h - 3 && !shotCover; z++) for (let x = 3; x < shotSim.level.w - 3 && !shotCover; x++) {
    if (shotSim.cell(x, z) !== FLOOR || shotSim.cell(x, z - 1) !== FLOOR || shotSim.cell(x + 1, z) !== WALL || shotSim.cell(x + 1, z - 1) !== WALL) continue;
    shooter.x = x + 0.5; shooter.z = z + 0.5; shooter.yaw = -Math.PI / 2;
    const side = shotSim.leanOffset(shooter, -1);
    if (shotSim.ray(shooter.x + side.lx, 1.46, shooter.z + side.lz, 1, 0, 0, 8, shooter, false).kind === 'wall') shotCover = { x: shooter.x, z: shooter.z };
  }
  ok(!!shotCover, 'found a cover position for a leaned-shot regression test');
  if (shotCover) {
    shooter.x = shotCover.x; shooter.z = shotCover.z; shooter.yaw = -Math.PI / 2;
    const side = shotSim.leanOffset(shooter, -1), ox = shooter.x + side.lx, oz = shooter.z + side.lz;
    shotSim.events.length = 0;
    const hit = shotSim.fire(shooter, ox, 1.46, oz, 1, 0, 0, 5, { pen: 0 });
    const shot = shotSim.events.find(e => e.t === 'shot');
    ok(hit.kind === 'wall' && shot?.t === 'shot' && Math.abs(shot.x - ox) < 0.01 && Math.abs(shot.z - oz) < 0.01,
      'leaned shot starts at the peek position and cannot pass through the covering wall');
  }

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
  // pick a wood door with nobody standing in the firing line (actors have been moving for a while)
  const clearOfActors = (d: typeof sim.level.doors[number]) =>
    !sim.actors.some(a => a !== pl && Math.hypot(a.x - (d.cx + 0.5), a.z - (d.cz + 1.7)) < 3);
  const woodDoor = sim.level.doors.find(d => d.horiz && !sim.isMetalDoor(d) && !sim.isGlassDoor(d) && clearOfActors(d))
    ?? sim.level.doors.find(d => d.horiz && !sim.isMetalDoor(d) && !sim.isGlassDoor(d))!;
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

// ---- room work: the squad searches/guards the room we are in and never leaves it ----
function roomSquad(seed: number) {
  const sim = new Sim(0, seed), p = sim.player;
  const room = sim.level.rooms.filter(r => r.spawn && r.w >= 6 && r.h >= 6).sort((a, b) => b.w * b.h - a.w * a.h)[0] ?? sim.level.rooms[0];
  p.x = room.x + room.w / 2; p.z = room.z + room.h / 2; p.moving = false;
  // A quiet building: with the real hostiles alive the squad is dead within seconds and the test
  // would pass for the wrong reason.
  // Frozen hostiles: still alive (so the mission keeps running and the squad keeps updating) but
  // unable to walk over and shoot the player mid-test.
  for (const a of sim.suspects) { a.stun = 1e9; a.armed = false; a.hostile = false; a.target = null; }
  for (const a of sim.civs) { a.stun = 1e9; a.target = null; }
  // put the squad in the room with him, the way they arrive through the door in a real run
  sim.officers.forEach((o, i) => {
    const q = nearestWalkable(sim.level, p.x + (i - 1.5) * 0.9, p.z + 1.4, 3) ?? { x: p.x, z: p.z };
    o.x = q.x; o.z = q.z; o.path = null; o.goal = null; o.moving = false;
  });
  return { sim, room, p };
}
{
  const { sim, room, p } = roomSquad(4);
  ok(sim.command({ team: 'ALL', action: 'secure' }) === true, 'secure order is accepted');
  ok(!sim.over, 'secure test scenario is live');
  ok(sim.teams.A.order.type === 'secure' && sim.teams.B.order.type === 'secure', 'both teams take the secure order');
  const offs = () => sim.officers.filter(o => o.alive);
  let outside = 0, minPair = 9;
  for (let i = 0; i < 60 * 30; i++) {
    sim.update(1 / 60);
    const list = offs();
    for (const o of list) if (roomAt(sim.level, o.x, o.z)?.id !== room.id) outside++;
    for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) minPair = Math.min(minPair, Math.hypot(list[a].x - list[b].x, list[a].z - list[b].z));
  }
  const list = offs();
  let spread = 0;
  for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) spread = Math.max(spread, Math.hypot(list[a].x - list[b].x, list[a].z - list[b].z));
  ok(outside === 0, `secure keeps the squad inside the room for the whole order (${outside} frames outside)`);
  ok(minPair > 0.5, `secure posts do not stack two operators on one spot (closest pair ${minPair.toFixed(2)} m)`);
  ok(spread > 1.2, `secure spreads the squad over the room instead of bunching up (${spread.toFixed(2)} m apart)`);
  ok(sim.teams.A.order.phase === 1, 'the search phase hands back to holding the entrances');
  // residual motion: everyone is standing on their post and only sweeping their sector
  const before = list.map(o => ({ x: o.x, z: o.z }));
  for (let i = 0; i < 60 * 4; i++) sim.update(1 / 60);
  const drift = Math.max(...list.map((o, i) => Math.hypot(o.x - before[i].x, o.z - before[i].z)));
  ok(drift < 0.6, `a secured squad holds its posts instead of pacing (${drift.toFixed(2)} m drift in 4 s)`);
  ok(p.alive, 'player untouched by the squad shuffling around him');
}
{
  // Following must not mean "glued to the player's back" — inside a room they take guarding posts.
  const { sim, room, p } = roomSquad(6);
  sim.command({ team: 'ALL', action: 'follow' });
  for (let i = 0; i < 60 * 16; i++) sim.update(1 / 60);
  const list = sim.officers.filter(o => o.alive);
  ok(!sim.over && list.length === 4, 'follow test scenario is live');
  const inside = list.filter(o => roomAt(sim.level, o.x, o.z)?.id === room.id).length;
  const minLead = Math.min(...list.map(o => Math.hypot(o.x - p.x, o.z - p.z)));
  ok(inside === list.length, `a following squad stays in the room the player is in (${inside}/${list.length})`);
  ok(minLead > 0.9, `nobody stands in the player's lap while he holds still (closest ${minLead.toFixed(2)} m)`);
  // and they still come along when he walks off (follow a real path, not through the furniture)
  const before = list.map(o => ({ x: o.x, z: o.z }));
  const target = nearestWalkable(sim.level, room.x + 1.5, room.z + 1.5, 4) ?? { x: room.x + 1.5, z: room.z + 1.5 };
  const route = findPath(sim.level, p, target) ?? [];
  // Each officer's furthest point during the walk: they come along and then settle back on post, so a
  // net displacement measured after the player stops would say nothing about whether they followed.
  const far = before.map(() => 0);
  let wi = 0;
  for (let i = 0; i < 60 * 8 && wi < route.length; i++) {
    const wp = route[wi], dx = wp.x - p.x, dz = wp.z - p.z, d = Math.hypot(dx, dz) || 1;
    if (d < 0.3) { wi++; continue; }
    sim.movePlayer((dx / d) * 2.4 / 60, (dz / d) * 2.4 / 60);
    sim.update(1 / 60);
    list.forEach((o, k) => { far[k] = Math.max(far[k], Math.hypot(o.x - before[k].x, o.z - before[k].z)); });
  }
  const moved = far.filter(d => d > 0.5).length;
  ok(moved >= list.length - 1, `the squad moves again once the player walks (${moved}/${list.length} followed)`);
}

// ---- friendly fire: one hit is a warning, the second turns the squad on the player ----
{
  const sim = new Sim(0, 4242, 1, 1, {}, {});
  const p = sim.player, o = sim.officers[0];
  const step = (n = 12) => { for (let i = 0; i < n; i++) sim.update(1 / 60); };
  sim.damage(o, 6, p, false);
  ok(!sim.squadHostile && sim.ffHits === 1, 'the first hit on a teammate only draws a warning');
  ok(sim.events.some(e => e.t === 'info' && /friendly fire/i.test(e.text)), 'the warning is announced');
  step();
  sim.damage(sim.officers[1], 6, p, false);
  ok(!sim.squadHostile, 'a stray round into a second officer inside the window is still forgiven');
  step();
  sim.damage(o, 6, p, false);
  ok(sim.squadHostile, 'the second hit on the same officer turns the squad hostile');
  ok(sim.events.some(e => e.t === 'mutiny'), 'the mutiny is broadcast as an event');

  // the squad now hunts and shoots the player instead of the suspects
  p.x = o.x + 1.1; p.z = o.z; p.hp = 100;
  const before = p.hp;
  for (let i = 0; i < 60 * 4; i++) sim.update(1 / 60);
  ok(sim.officers.some(x => x.target === p), 'hostile officers acquire the player as their target');
  ok(p.hp < before, `hostile officers shoot the player (hp ${before} -> ${Math.round(p.hp)})`);

  // and the friendly-fire guard no longer swallows those hits
  const s2 = new Sim(0, 4242, 1, 1, {}, {});
  const p2 = s2.player, o2 = s2.officers[0];
  s2.damage(p2, 20, o2, false);
  ok(p2.hp === 100, 'a loyal squadmate cannot hurt the player (friendly fire is off by default)');
}

// ---- career: ranks, campaign order, ironman, injuries ----
{
  ok(RANKS.every((r, i) => i === 0 || r.xp > RANKS[i - 1].xp), 'ranks are ordered by XP');
  ok(gearUnlockXp('carbine') === 0 && gearUnlockXp('shield') >= 1000, 'starting kit is free, the shield is late-game');
  ok(!isGearUnlocked('taser', 0) && isGearUnlocked('taser', 200), 'the taser unlocks with the rank that carries it');

  const cleared: Record<string, number> = {};
  ok(missionUnlocked(cleared, 0) && missionUnlocked(cleared, 6), 'every campaign operation is selectable from a fresh save');
  cleared[0] = 80;
  ok(missionUnlocked(cleared, 1) && missionUnlocked(cleared, 2), 'campaign completions do not gate later operations');
  ok(!missionUnlocked(cleared, -1), 'invalid negative mission indexes are rejected');
  ok(!campaignComplete(cleared, 3) && nextUncleared(cleared, 3) === 1, 'campaign tracks the next uncleared operation');

  const c = defaultCareer();
  const r1 = applyMissionResult(c, { win: true, mission: 0, score: 210, downed: [], ironman: false });
  ok(r1.xpGained === 210 && r1.xpAfter === 210, 'a completed operation pays out the score as XP');
  ok(r1.unlocked.includes('taser'), 'reaching 200 XP unlocks the taser');
  ok(c.ops === 1, 'a completed operation counts as an operation');

  const c2 = defaultCareer();
  const r2 = applyMissionResult(c2, { win: true, mission: 0, score: 100, downed: ['Ken'], ironman: false });
  ok(r2.injured.length === 1 && c2.roster[0].opsOut > 0, 'an officer who goes down sits out the coming operations');
  const squad = deployRoster(c2);
  ok(squad[0].rookie && squad[0].name.startsWith('Rookie'), 'a rookie stands in for the recovering officer');
  ok(squad[1].rookie === false, 'fit officers still deploy');
  const out = c2.roster[0].opsOut;
  for (let i = 0; i < out; i++) applyMissionResult(c2, { win: true, mission: 1, score: 50, downed: [], ironman: false });
  ok(c2.roster[0].opsOut === 0 && deployRoster(c2)[0].name === 'Ken', 'the officer comes back after the recovery countdown');

  const c3 = defaultCareer();
  c3.ironman = true;
  const r3 = applyMissionResult(c3, { win: false, mission: 0, score: 90, downed: ['Maya'], ironman: true });
  ok(r3.ironmanPenalty && r3.xpGained === 0 && c3.xp === 0, 'ironman: a failed operation earns nothing');
  ok(c3.roster[1].opsOut > 0, 'ironman: injuries still come home');

  const saved = normaliseCareer(JSON.parse(JSON.stringify({ xp: 640, ops: 3 })));
  ok(saved.roster.length === 4 && saved.roster.every(r => r.opsOut === 0), 'an older save without a roster is upgraded safely');
}

// ---- Tactical AI load retry / cancellation lifecycle ----
{
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });
    const ai = new TacticalAi();
    const [first, coalesced] = await Promise.all([ai.ensureLoaded('unsupported-test'), ai.ensureLoaded('unsupported-test')]);
    ok(!first && !coalesced && ai.state === 'unsupported' && (ai as any).loadPromise === null,
      'unsupported WebGPU result clears the shared load promise');
    ok(!(await ai.ensureLoaded('unsupported-test')) && (ai as any).loadPromise === null,
      'AI can retry after a missing WebGPU adapter');

    let resolveAdapter!: (adapter: unknown) => void;
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { gpu: { requestAdapter: () => new Promise(r => { resolveAdapter = r; }) } } });
    const cancelling = new TacticalAi();
    const pending = cancelling.ensureLoaded('cancel-test');
    await Promise.resolve(); // let ensureLoaded start waiting for requestAdapter
    const unload = cancelling.unload();
    resolveAdapter(null);
    const [loaded] = await Promise.all([pending, unload]);
    ok(!loaded && cancelling.state === 'off' && (cancelling as any).loadPromise === null,
      'unloading during adapter initialization invalidates the stale AI load');
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
    else delete (globalThis as any).navigator;
  }
}

console.log(fails ? `FAILED (${fails})` : 'ALL OK'); process.exit(fails ? 1 : 0);
