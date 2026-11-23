import type { Actor, Sim } from '../sim/sim';

/** Reuse a disconnected callsign's slot when possible, otherwise take the first free remote slot. */
export function findReconnectSlot(players: readonly Pick<Actor, 'name'>[], activeSlots: Iterable<number>, callsign: string): number {
  const active = new Set(activeSlots);
  const wanted = callsign.trim().toLowerCase();
  let slot = players.findIndex((player, index) => index > 0 && !active.has(index) && player.name.toLowerCase() === wanted);
  if (slot < 0) slot = players.findIndex((_, index) => index > 0 && !active.has(index));
  return slot;
}

/** Mark a departed remote operator unavailable without touching any other player's state. */
export function disconnectRemotePlayer(player: Actor): boolean {
  if (!player.alive) return false;
  player.alive = false;
  player.downed = false;
  player.hp = 0;
  return true;
}

/** Restore the host-owned fields that a reconnecting client's fresh local Sim starts with. */
export function reconnectRemotePlayer(player: Actor, callsign: string, shield: boolean): void {
  player.name = callsign;
  player.alive = true;
  player.downed = false;
  player.hp = Math.max(50, player.hp || 75);
  player.weapon = 0;
  player.shield = shield;
}

export interface RemoteMovementBudget {
  lastInputAt: number;
  timeCredit: number;
}

/**
 * Sweep a remote player's submitted position through host collision geometry. A small bounded time
 * credit absorbs packet jitter without granting extra movement for every packet in a burst.
 */
export function moveRemotePlayer(
  sim: Pick<Sim, 'moveCircle' | 'pushTrail'>,
  player: Actor,
  targetX: number,
  targetZ: number,
  crouched: boolean,
  prone: boolean,
  nowMs: number,
  budget: RemoteMovementBudget,
): number {
  const elapsed = Math.min(0.25, Math.max(0, (nowMs - budget.lastInputAt) / 1000));
  budget.lastInputAt = nowMs;
  budget.timeCredit = Math.min(0.12, budget.timeCredit + elapsed);

  const dx = targetX - player.x, dz = targetZ - player.z, distance = Math.hypot(dx, dz);
  if (distance <= 1e-5) { player.moving = false; return 0; }
  const maxSpeed = prone ? 0.9 : crouched ? 1.9 : 5.3;
  const step = Math.min(distance, maxSpeed * budget.timeCredit);
  if (step <= 0) { player.moving = false; return 0; }

  const scale = step / distance, beforeX = player.x, beforeZ = player.z;
  sim.moveCircle(player, dx * scale, dz * scale);
  const moved = Math.hypot(player.x - beforeX, player.z - beforeZ);
  budget.timeCredit = Math.max(0, budget.timeCredit - moved / maxSpeed);
  player.walk += moved * 2.4;
  sim.pushTrail(player);
  player.moving = moved > 0.01;
  return moved;
}
