import { Net, type Msg } from '../src/game/net';
import type Peer from 'peerjs';
import { Sim } from '../src/sim/sim';
import { disconnectRemotePlayer, findReconnectSlot, moveRemotePlayer, reconnectRemotePlayer } from '../src/game/netplayers';
import { canRemoteFireDuringReload, cancelRemoteShellReloadForFire } from '../src/game/netcombat';

let failures = 0;
const check = (condition: boolean, message: string) => {
  if (!condition) { failures++; console.error('FAIL', message); }
};

type Listener = (...args: any[]) => void;
class FakeEmitter {
  private listeners = new Map<string, Listener[]>();
  on(event: string, listener: Listener) {
    const list = this.listeners.get(event) ?? [];
    list.push(listener); this.listeners.set(event, list); return this;
  }
  emit(event: string, ...args: any[]) {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
  }
}
class FakeConnection extends FakeEmitter {
  open = false;
  closed = false;
  sent: Msg[] = [];
  constructor(public peer: string) { super(); }
  send(message: Msg) { this.sent.push(message); }
  openNow() { if (this.closed) return; this.open = true; this.emit('open'); }
  close() {
    if (this.closed) return;
    this.closed = true; this.open = false; this.emit('close');
  }
}
class FakePeer extends FakeEmitter {
  destroyed = false;
  connections = new Set<FakeConnection>();
  requestedRoom = '';
  constructor(public id: string, private outgoing?: FakeConnection) { super(); }
  connect(id: string) {
    this.requestedRoom = id;
    const connection = this.outgoing ?? new FakeConnection(id);
    this.connections.add(connection);
    return connection;
  }
  destroy() {
    this.destroyed = true;
    for (const connection of this.connections) connection.close();
  }
  accept(connection: FakeConnection) {
    this.connections.add(connection); this.emit('connection', connection);
  }
}
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const mockNet = (peer: FakePeer) => {
  const net = new Net();
  // Keep these tests independent of browser permission prompts and the public PeerJS broker.
  (net as any).voice = () => Promise.resolve();
  (net as any).open = async () => peer as unknown as Peer;
  return net;
};

// Exercise the actual Net listener and host connection-cap path with deterministic PeerJS doubles.
{
  const peer = new FakePeer('host-peer');
  const net = mockNet(peer);
  let peerChanges = 0;
  const received: Msg[] = [];
  net.onPeers = () => { peerChanges++; };
  net.onMsg = (_connection, message) => { received.push(message); };
  await net.host();

  const pending = [1, 2, 3].map(i => new FakeConnection(`client-${i}`));
  for (const connection of pending) peer.accept(connection);
  const excess = new FakeConnection('client-4'); peer.accept(excess);
  check(pending.every(connection => !connection.closed) && excess.closed,
    'host bounds the combined pending and open connection count at three');
  for (const connection of pending) connection.openNow();
  check(net.conns.length === 3 && peerChanges === 3, 'pending clients enter the host list only after opening');

  pending[0].emit('data', { t: 'hello', name: 'Alice', prim: 'carbine', sec: 'pistol', ready: true });
  pending[0].emit('data', { t: 'fire', weapon: 0, dirs: [] });
  check(received.length === 1 && received[0].t === 'hello',
    'host dispatches normalized messages and drops malformed packets before the game handler');
  const beforeBurst = received.length;
  for (let i = 0; i < 1000; i++) pending[1].emit('data', { t: 'ping', d: [0, 0, -1] });
  const acceptedBurst = received.length - beforeBurst;
  check(acceptedBurst > 0 && acceptedBurst < 300,
    'Net applies its per-connection packet budget to a burst before forwarding messages');
  net.close();
  const afterClose = received.length;
  pending[1].emit('data', { t: 'ping', d: [0, 0, -1] });
  check(net.role === 'solo' && net.conns.length === 0 && peer.destroyed && received.length === afterClose,
    'closing a host clears active connections and ignores queued packets from stale channels');
}
{
  const peer = new FakePeer('host-peer');
  const net = mockNet(peer);
  await net.host();
  const failedBeforeOpen = new FakeConnection('late-client');
  peer.accept(failedBeforeOpen);
  failedBeforeOpen.emit('error', new Error('channel failed'));
  failedBeforeOpen.emit('open'); // simulate an out-of-order event after a terminal error
  check(failedBeforeOpen.closed && net.conns.length === 0 && (net as any).pendingHostConns.size === 0,
    'a failed pending channel cannot be resurrected by a later open event');
  net.close();
}

// Exercise client join, application-message delivery, remote close, broker failure, and user cancellation.
{
  const connection = new FakeConnection('host-peer');
  const peer = new FakePeer('client-peer', connection);
  const net = mockNet(peer);
  const received: Msg[] = [];
  let closedReason = '';
  net.onMsg = (_from, message) => { received.push(message); };
  net.onClosed = reason => { closedReason = reason; };

  const joining = net.join('abcde');
  await tick();
  connection.openNow();
  await joining;
  check(net.role === 'client' && net.code === 'ABCDE' && peer.requestedRoom === 'teamai-room-ABCDE',
    'client join normalizes the room code and enters client role only after the data channel opens');
  net.send({ t: 'ping', d: [0, 0, -1] });
  connection.emit('data', { t: 'ping', d: [0, 0, -1] });
  connection.emit('data', { t: 'ping', d: [Infinity, 0, 0] });
  check(connection.sent.length === 1 && received.length === 1,
    'joined clients send through the open channel and receive only valid host messages');
  connection.close();
  check(closedReason === 'The host left the game.', 'a dropped host data channel reports the host departure reason');
  net.close();
  connection.emit('data', { t: 'lobby', names: ['Late Host'], ids: ['host-peer'], mission: 0 });
  check(received.length === 1, 'late host packets are ignored after the client closes its session');
}
{
  const connection = new FakeConnection('host-peer');
  const peer = new FakePeer('client-peer', connection);
  const net = mockNet(peer);
  const reasons: string[] = [];
  net.onClosed = reason => { reasons.push(reason); };
  const joining = net.join('ABCDE');
  await tick(); connection.openNow(); await joining;
  connection.emit('error', new Error('channel failed'));
  connection.close();
  check(reasons.length === 1 && reasons[0] === 'The connection to the host failed.',
    'an established data-channel error notifies once even if close follows');
  net.close();
}
{
  const connection = new FakeConnection('host-peer');
  const peer = new FakePeer('client-peer', connection);
  const net = mockNet(peer);
  const joining = net.join('ABCDE');
  await tick();
  peer.emit('error', { type: 'peer-unavailable' });
  let rejected = false;
  try { await joining; } catch { rejected = true; }
  check(rejected && net.role === 'solo' && net.peer === null && net.hostConn === null && peer.destroyed,
    'a missing room rejects the join and cleans up the partially opened peer');
}
{
  const connection = new FakeConnection('host-peer');
  const peer = new FakePeer('client-peer', connection);
  const net = mockNet(peer);
  const joining = net.join('ABCDE');
  await tick();
  net.close();
  let rejected = false;
  try { await joining; } catch { rejected = true; }
  check(rejected && net.role === 'solo' && net.peer === null && peer.destroyed,
    'leaving while the data channel is pending cancels the join without resurrecting stale state');
}
{
  const peer = new FakePeer('client-peer');
  const net = mockNet(peer);
  let rejectOpen!: (error: Error) => void;
  (net as any).open = () => new Promise<Peer>((_resolve, reject) => { rejectOpen = reject; });
  const joining = net.join('ABCDE');
  await tick(); net.close(); rejectOpen(new Error('closed'));
  let rejected = false;
  try { await joining; } catch { rejected = true; }
  check(rejected && net.role === 'solo',
    'cancellation while the signaling peer is still opening rejects instead of resolving into a stale lobby');
}

// Cover the reconnect slot policy and the actor state transition used by the live host handler.
{
  const sim = new Sim(0, 51, 1, 4);
  sim.players[1].name = 'Alice'; sim.players[2].name = 'Bob'; sim.players[3].name = 'Charlie';
  check(findReconnectSlot(sim.players, [2], 'aLiCe') === 1,
    'reconnect reclaims the matching disconnected callsign before taking a generic free slot');
  check(findReconnectSlot(sim.players, [1], 'Alice') === 2,
    'a connected slot is never assigned twice and the first free slot is used as fallback');
  check(findReconnectSlot(sim.players, [1, 2, 3], 'Unknown') === -1,
    'a full host reports no reconnect slot instead of overwriting an active player');

  const player = sim.players[1];
  player.hp = 0; player.alive = true; player.downed = true; player.weapon = 1; player.shield = false;
  check(disconnectRemotePlayer(player) && !player.alive && !player.downed && player.hp === 0,
    'disconnect marks only the abandoned player slot unavailable');
  check(!disconnectRemotePlayer(player), 'duplicate disconnect notifications are idempotent');
  reconnectRemotePlayer(player, 'Alice', true);
  check(player.name === 'Alice' && player.alive && !player.downed && player.hp === 75 && player.weapon === 0 && player.shield,
    'reconnect restores the local fresh-sim defaults that the host owns');
}
{
  const reload = { ammo: [2, 0] as [number, number], reloadUntil: [3, 2] as [number, number],
    speedReload: [false, false] as [boolean, boolean], shellReload: [true, true] as [boolean, boolean], activeReload: 0 };
  check(canRemoteFireDuringReload(reload, 0, 1) && !canRemoteFireDuringReload(reload, 1, 1),
    'only a loaded shotgun shell may interrupt an active reload');
  check(cancelRemoteShellReloadForFire(reload, 0) && reload.ammo[0] === 2 && reload.reloadUntil[0] === 0
    && !reload.shellReload[0] && reload.activeReload === null,
    'remote fire interrupts a loaded shotgun shell reload, matching the local client');
  check(!cancelRemoteShellReloadForFire(reload, 1) && reload.shellReload[1] && reload.reloadUntil[1] === 2,
    'an empty shotgun cannot interrupt its shell reload to fire');
}
{
  const sim = new Sim(0, 52, 1, 2);
  const player = sim.players[1]; player.x = 10; player.z = 10;
  const freeMove = {
    moveCircle(actor: typeof player, dx: number, dz: number) { actor.x += dx; actor.z += dz; },
    pushTrail() {},
  } as unknown as Sim;
  const budget = { lastInputAt: 1000, timeCredit: 0 };
  const first = moveRemotePlayer(freeMove, player, 100, 10, false, false, 1050, budget);
  const xAfterFirst = player.x;
  for (let i = 0; i < 100; i++) moveRemotePlayer(freeMove, player, 100, 10, false, false, 1050, budget);
  check(first <= 5.3 * 0.05 + 1e-6 && Math.abs(player.x - xAfterFirst) < 1e-6,
    'movement is limited by elapsed time and a same-timestamp packet burst grants no extra distance');
  const delayed = moveRemotePlayer(freeMove, player, 100, 10, false, false, 5000, budget);
  check(delayed <= 5.3 * 0.12 + 1e-6,
    'delayed packets receive only a capped jitter allowance rather than unbounded catch-up movement');
}

console.log(failures ? `NETWORK TESTS FAILED (${failures})` : 'NETWORK TESTS ALL OK');
process.exit(failures ? 1 : 0);
