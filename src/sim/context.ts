// Tactical context & local status report helpers for SWAT AI & radio. Pure logic (no DOM).
import { roomAt } from './level';
import type { Actor, Sim, Team } from './sim';

function relDir(from: Actor, to: Actor, dy = 0): string {
  const dx = to.x - from.x, dz = to.z - from.z;
  const d = Math.hypot(dx, dy, dz);
  if (Math.abs(dy) > 1.35) return `${Math.round(d)}m ${dy > 0 ? 'above' : 'below'} you`;
  if (d < 2.2) return 'right beside you';
  const fx = -Math.sin(from.yaw), fz = -Math.cos(from.yaw);
  const rx = Math.cos(from.yaw), rz = -Math.sin(from.yaw);
  const fwdDot = (dx * fx + dz * fz) / d;
  const rightDot = (dx * rx + dz * rz) / d;
  const dir = Math.abs(fwdDot) >= Math.abs(rightDot)
    ? (fwdDot >= 0 ? 'ahead' : 'behind')
    : (rightDot >= 0 ? 'right' : 'left');
  return `${Math.round(d)}m ${dir}`;
}

export function buildTacticalContext(sim: Sim, player: Actor = sim.player): string {
  const rem = sim.remaining();
  const pRoom = roomAt(sim.level, player.x, player.z)?.name ?? 'corridor/outside';
  const door = sim.aimedDoor(player);
  const doorDist = door ? Math.round(Math.hypot(door.cx + 0.5 - player.x, door.cz + 0.5 - player.z)) : null;
  const doorState = door ? `${door.open > 0.5 ? 'open' : 'closed'}${door.locked ? ', LOCKED' : ''}${door.wedged ? ', WEDGED' : ''}` : '';

  const lines: string[] = [
    `Mission: ${sim.level.name} (${sim.level.objective.toUpperCase()})`,
    `Power: ${sim.powerOn ? 'ON' : 'OFF (dark)'}`,
    `Remaining: ${rem.suspects} active/unsecured suspects, ${rem.civs} unsecured civilians` + (sim.bomb && !sim.bomb.defused ? (sim.bomb.started ? `, BOMB active (${Math.ceil(sim.bomb.time)}s left)` : `, BOMB located but its timer has not started (${Math.ceil(sim.bomb.time)}s on the clock)`) : ''),
    `Player: HP ${Math.ceil(player.hp)}, in ${pRoom}, flashbangs ${player.bangs}, C2 ${player.c2}, wedges ${player.wedges}` + (door ? `, nearest/aimed door ${doorDist}m (${doorState})` : ', no door nearby'),
    'SWAT Officers:',
  ];

  for (const o of sim.officers) {
    if (!o.alive) {
      lines.push(`- ${o.name} (Team ${o.team}, role ${o.role}, slot ${o.slot}): DOWN`);
      continue;
    }
    const ord = (o.solo ?? sim.teams[o.team]).order.type + (o.solo ? ' (solo)' : '');
    const seenSuspects = sim.suspects.filter(s => s.alive && !s.down && sim.sees(o, s, 26, 3.2)).length;
    const seenSurr = sim.actors.filter(a => a.alive && a.surrendered && !a.restrained && sim.sees(o, a, 16, 3.2)).length;
    const room = roomAt(sim.level, o.x, o.z)?.name ?? 'corridor';
    lines.push(
      `- ${o.name} (Team ${o.team}, role ${o.role}, slot ${o.slot}): HP ${Math.ceil(o.hp)}, order=${ord}, pos=${relDir(player, o, sim.floorY(o.x, o.z) - sim.floorY(player.x, player.z))} in ${room}, sees ${seenSuspects} armed suspects, ${seenSurr} waiting for cuffs`,
    );
  }
  return lines.join('\n');
}

export function buildLocalReport(sim: Sim, team: Team, who?: number): string {
  const one = who != null ? sim.officers[who] : null;
  const members = one ? (one.alive ? [one] : []) : sim.officers.filter(o => o.alive && o.team === team);
  if (!members.length) return 'No response, team down.';

  const wounded = members.some(o => o.hp < 60);
  const armed = members.reduce((n, o) => n + sim.suspects.filter(s => s.alive && !s.down && sim.sees(o, s, 26, 3.2)).length, 0);
  const cuffs = members.reduce((n, o) => n + sim.actors.filter(a => a.alive && a.surrendered && !a.restrained && sim.sees(o, a, 16, 3.2)).length, 0);
  const rem = sim.remaining();

  const parts = [
    one ? `${one.name} (${one.role}) up (${Math.ceil(one.hp)} HP).` : `${members.length} up.`,
    wounded ? 'We have wounded.' : 'No injuries.',
  ];
  if (armed > 0) parts.push(`Visual on ${armed} armed suspect${armed > 1 ? 's' : ''}!`);
  if (cuffs > 0) parts.push(`${cuffs} waiting to be cuffed.`);
  if (sim.bomb && !sim.bomb.defused) parts.push(sim.bomb.started ? `Bomb ticking: ${Math.ceil(sim.bomb.time)}s remaining!` : 'Bomb found, but the timer has not started yet.');
  if (!armed && !cuffs) parts.push(`${rem.suspects} suspects and ${rem.civs} civilians left.`);
  return parts.join(' ');
}
