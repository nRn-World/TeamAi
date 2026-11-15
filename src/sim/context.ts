// Tactical context & local status report helpers for SWAT AI & radio. Pure logic (no DOM).
import { roomAt } from './level';
import type { Actor, Sim, Team } from './sim';

function relDir(from: Actor, to: Actor): string {
  const dx = to.x - from.x, dz = to.z - from.z;
  const d = Math.hypot(dx, dz);
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

  const lines: string[] = [
    `Mission: ${sim.level.name}`,
    `Remaining: ${rem.suspects} active/unsecured suspects, ${rem.civs} unsecured civilians`,
    `Player: HP ${Math.ceil(player.hp)}, in ${pRoom}, flashbangs ${player.bangs}` + (door ? `, nearest/aimed door ${doorDist}m (${door.open > 0.5 ? 'open' : 'closed'})` : ', no door nearby'),
    'SWAT Officers:',
  ];

  for (const o of sim.officers) {
    if (!o.alive) {
      lines.push(`- ${o.name} (Team ${o.team}, slot ${o.slot}): DOWN`);
      continue;
    }
    const ord = (o.solo ?? sim.teams[o.team]).order.type + (o.solo ? ' (solo)' : '');
    const seenSuspects = sim.suspects.filter(s => s.alive && !s.down && sim.sees(o, s, 26, 3.2)).length;
    const seenSurr = sim.actors.filter(a => a.alive && a.surrendered && !a.restrained && sim.sees(o, a, 16, 3.2)).length;
    const room = roomAt(sim.level, o.x, o.z)?.name ?? 'corridor';
    lines.push(
      `- ${o.name} (Team ${o.team}, slot ${o.slot}): HP ${Math.ceil(o.hp)}, order=${ord}, pos=${relDir(player, o)} in ${room}, sees ${seenSuspects} armed suspects, ${seenSurr} waiting for cuffs`,
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
    one ? `${one.name} up (${Math.ceil(one.hp)} HP).` : `${members.length} up.`,
    wounded ? 'We have wounded.' : 'No injuries.',
  ];
  if (armed > 0) parts.push(`Visual on ${armed} armed suspect${armed > 1 ? 's' : ''}!`);
  if (cuffs > 0) parts.push(`${cuffs} waiting to be cuffed.`);
  if (!armed && !cuffs) parts.push(`${rem.suspects} suspects and ${rem.civs} civilians left.`);
  return parts.join(' ');
}
