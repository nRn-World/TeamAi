export interface RemoteReloadState {
  ammo: [number, number];
  reloadUntil: [number, number];
  speedReload: [boolean, boolean];
  shellReload: [boolean, boolean];
  activeReload: number | null;
}

/** Standard magazine reloads block fire; a loaded shell can interrupt its per-shell reload. */
export function canRemoteFireDuringReload(state: RemoteReloadState, weapon: number, now: number): boolean {
  if (!Number.isInteger(weapon) || weapon < 0 || weapon > 1 || !Number.isFinite(now)) return false;
  return state.reloadUntil[weapon] <= now || (state.shellReload[weapon] && state.ammo[weapon] > 0);
}

/** Match the local shotgun behavior: firing with a loaded shell interrupts the per-shell reload. */
export function cancelRemoteShellReloadForFire(state: RemoteReloadState, weapon: number): boolean {
  if (!Number.isInteger(weapon) || weapon < 0 || weapon > 1 || !state.shellReload[weapon] || state.ammo[weapon] <= 0) return false;
  state.reloadUntil[weapon] = 0;
  state.shellReload[weapon] = false;
  state.speedReload[weapon] = false;
  if (state.activeReload === weapon) state.activeReload = null;
  return true;
}
