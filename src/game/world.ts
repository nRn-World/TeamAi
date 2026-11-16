// three.js presentation of the simulation: level geometry, characters, effects. All geometry is procedural.
import * as THREE from 'three';
import { Sim, Actor, Team } from '../sim/sim';
import { WALL, OUT, WINDOW, Door, Prop } from '../sim/level';
import * as T from './textures';
import { modelsReady, Rig, droppedPistol } from './models';
import { weaponModel, buildBallisticShield } from './weapons';
import { OperatorBody, operatorReady } from './operator';
import { propsReady, onPropsReady, propModel, exteriorPlanterModel, exteriorTreeModel } from './props';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

const BOX = new THREE.BoxGeometry(1, 1, 1);
const std = (o: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0, ...o });
function box(w: number, h: number, d: number, m: THREE.Material, x = 0, y = 0, z = 0) { const b = new THREE.Mesh(BOX, m); b.scale.set(w, h, d); b.position.set(x, y, z); return b; }

const CITY_CACHE = new Map<string, Promise<THREE.Group | null>>();
function loadCityAsset(name: string): Promise<THREE.Group | null> {
  let p = CITY_CACHE.get(name);
  if (!p) {
    p = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(`./models/city/${name}.glb`).then(gltf => {
      const sc = gltf.scene;
      sc.updateMatrixWorld(true);
      sc.traverse((o: any) => {
        if (!o.isMesh) return;
        o.receiveShadow = true;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          if (!m) continue;
          if ('envMapIntensity' in m) m.envMapIntensity = /glass|window|cteclo/i.test(m.name || '') ? 1.35 : 0.85;
          if (/lamp.*glass|glow/i.test(m.name || '')) {
            m.emissive = new THREE.Color(0xffe4b5);
            m.emissiveIntensity = 3.2;
          }
        }
      });
      return sc;
    }).catch(() => null);
    CITY_CACHE.set(name, p);
  }
  return p;
}

const MARAUDER_PAINT: Record<string, [number, number, number]> = { Body_2: [0x3d485e, 0.45, 0.58], Metal_UP_5: [0x4b5363, 0.5, 0.62] };

const THEME = {
  office: { wall: '#c9c3b6', trim: '#4a443c', brickA: '#3a3e46', brickB: '#2f333b', fog: 0x0b0e12 },
  warehouse: { wall: '#8b9095', trim: '#33373b', brickA: '#5f6469', brickB: '#4e5358', fog: 0x090b0d },
  hotel: { wall: '#bfa58e', trim: '#4d2e24', brickA: '#695c52', brickB: '#584c43', fog: 0x0d0b0a },
  bank: { wall: '#d6d4ce', trim: '#2d3b4e', brickA: '#6d737c', brickB: '#5d636b', fog: 0x0a0d12 },
  club: { wall: '#282633', trim: '#6a1b6a', brickA: '#28202c', brickB: '#1f1823', fog: 0x05030a },
  raid: { wall: '#b8b4aa', trim: '#3b3c40', brickA: '#635c54', brickB: '#524b44', fog: 0x090b0e },
};

export class LevelView {
  group = new THREE.Group();
  doors: { door: Door; pivot: THREE.Group; base: number; wedge: THREE.Mesh; lock: THREE.Mesh; tripwire: THREE.Mesh; glass?: THREE.Mesh }[] = [];
  windows = new Map<number, THREE.Mesh>();
  private evidenceViews = new Map<number, THREE.Group>();
  private sensorViews = new Set<object>();
  private sensorGroup = new THREE.Group();
  private pingRings: { mesh: THREE.Mesh; t: number }[] = [];
  private propViews = new Map<number, { group: THREE.Group; prop: Prop; serverLeds?: THREE.Mesh[] }>();
  private appliedBrokenProps = new Set<number>();
  private lightSources: { x: number; y: number; z: number; color: number; intensity: number; distance: number; decay: number; isRoom?: boolean }[] = [];
  private lightPool: THREE.PointLight[] = [];
  private lastPoolX = 1e9;
  private lastPoolZ = 1e9;
  private poolT = 0;
  private lampMeshes: THREE.Mesh[] = [];
  private lampOnMat: THREE.MeshBasicMaterial;
  private lampOffMat: THREE.MeshStandardMaterial;
  private bombLed?: THREE.Mesh;
  private bombBox?: THREE.Group;
  private lastPower = true;
  private strobeBlue?: THREE.PointLight;
  private strobeRed?: THREE.PointLight;
  private strobeLens: THREE.MeshStandardMaterial[] = [];
  private discoBall?: THREE.Group;
  private lasers: THREE.Mesh[] = [];
  private propSlots: (() => void)[] = [];
  private disposed = false;
  private readyPromise: Promise<void> = Promise.resolve();
  whenReady() { return this.readyPromise; }
  dispose() { this.disposed = true; this.propSlots.length = 0; }
  constructor(public sim: Sim, quality: number) {
    const l = sim.level, th = THEME[l.theme], g = this.group;
    // exterior ground: wet stone plaza for architectural themes, dark wet asphalt elsewhere
    const plazaGround = l.theme === 'office' || l.theme === 'hotel' || l.theme === 'bank';
    const groundMap = plazaGround ? T.plazaTex(l.theme) : T.floorTex('asphalt');
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(l.w + 72, l.h + 72),
      std({ map: groundMap, roughness: plazaGround ? 0.24 : 0.34, metalness: plazaGround ? 0.36 : 0.25 }),
    );
    scaleUV(ground.geometry, (l.w + 72) / 3, (l.h + 72) / 3); ground.rotation.x = -Math.PI / 2; ground.position.set(l.w / 2, -0.012, l.h / 2); g.add(ground);
    // rooms: floor + ceiling + lamps
    const ceilMat = std({ map: T.floorTex('ceiling') });
    const lampOn = this.lampOnMat = new THREE.MeshBasicMaterial({ color: l.theme === 'club' ? 0xc864ff : 0xfff4dc });
    const lampOff = this.lampOffMat = std({ color: 0x3a3a38 });
    const poolCount = quality >= 3 ? 16 : quality === 2 ? 11 : quality === 1 ? 7 : 0;
    for (let i = 0; i < poolCount; i++) {
      const pl = new THREE.PointLight(0xffffff, 0, 12, 1.6);
      g.add(pl);
      this.lightPool.push(pl);
    }
    for (const r of l.rooms) {
      const fl = new THREE.Mesh(new THREE.PlaneGeometry(r.w, r.h), std({ map: T.floorTex(r.floor), roughness: r.floor === 'tile' ? 0.35 : 0.95 }));
      scaleUV(fl.geometry, r.w / 2, r.h / 2); fl.rotation.x = -Math.PI / 2; fl.position.set(r.x + r.w / 2, r.id * 0.0006, r.z + r.h / 2); g.add(fl);
      const ce = new THREE.Mesh(new THREE.PlaneGeometry(r.w, r.h), ceilMat.clone()); (ce.material as THREE.MeshStandardMaterial).map = T.floorTex('ceiling');
      scaleUV(ce.geometry, r.w / 2, r.h / 2); ce.rotation.x = Math.PI / 2; ce.position.set(r.x + r.w / 2, 3 - r.id * 0.0006, r.z + r.h / 2); g.add(ce);
      const dark = l.theme === 'club' ? (r.kind === 'club') : (r.kind !== 'corridor' && r.kind !== 'lobby' && ((r.id * 7 + sim.mission * 3 + Math.floor(l.suspects[0]?.x ?? 0)) % 4 === 0));
      const nx = Math.max(1, Math.round((r.w - 2) / 6)), nz = Math.max(1, Math.round((r.h - 2) / 6));
      for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
        const x = r.x + 1 + ((i + 0.5) * (r.w - 2)) / nx, z = r.z + 1 + ((j + 0.5) * (r.h - 2)) / nz;
        const lm = box(r.kind === 'warehouse' ? 0.4 : 1.1, 0.05, r.kind === 'corridor' ? 0.3 : 0.5, dark ? lampOff : lampOn, x, 2.97, z);
        g.add(lm);
        if (!dark) this.lampMeshes.push(lm);
        if ((!dark || l.theme === 'club') && poolCount > 0) {
          const col = l.theme === 'club' ? (i % 2 ? 0xff3ea5 : 0x3ea8ff) : r.kind === 'warehouse' ? 0xdfe8ff : 0xffe9c8;
          const baseInt = l.theme === 'club' ? 12 : r.kind === 'warehouse' ? 26 : 15;
          this.lightSources.push({ x, y: 2.55, z, color: col, intensity: baseInt, distance: 11, decay: 1.7, isRoom: true });
        }
      }
    }
    // walls
    const inner: [number, number][] = [], outer: [number, number][] = [];
    for (let z = 0; z < l.h; z++) for (let x = 0; x < l.w; x++) {
      if (l.cells[z * l.w + x] !== WALL) continue;
      let hasOut = x === 0 || z === 0 || x === l.w - 1 || z === l.h - 1, hasAny = false;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) { const c = sim.cell(x + dx, z + dz); if (c !== WALL) hasAny = true; if (c === OUT && !(x + dx < 0 || z + dz < 0 || x + dx >= l.w || z + dz >= l.h)) hasOut = true; }
      if (!hasAny) continue; (hasOut ? outer : inner).push([x, z]);
    }
    const wallGeo = new THREE.BoxGeometry(1, 3, 1);
    const mk = (cells: [number, number][], mat: THREE.Material, h = 3) => {
      const im = new THREE.InstancedMesh(wallGeo, mat, cells.length); const m = new THREE.Matrix4();
      if (quality >= 2) { im.castShadow = true; im.receiveShadow = true; }
      cells.forEach(([x, z], i) => { m.makeScale(1, h / 3, 1); m.setPosition(x + 0.5, h / 2, z + 0.5); im.setMatrixAt(i, m); }); g.add(im);
    };
    const wallMat = std({ map: T.wallTex(th.wall, th.trim, l.theme) });
    const brickMat = l.theme === 'office'
      ? std({ color: 0x20252d, roughness: 0.35, metalness: 0.45 })
      : std({ map: T.brickTex(l.theme === 'bank' || l.theme === 'club' || l.theme === 'raid' ? 'office' : l.theme, th.brickA, th.brickB) });
    const curbMat = std({ color: 0x262a31, roughness: 0.72, metalness: 0.25 });
    const perimH = l.theme === 'club' ? 2.6 : 0.85;
    mk(inner, wallMat); mk(outer.filter(([x, z]) => !(x === 0 || z === 0 || x === l.w - 1 || z === l.h - 1)), brickMat, 3.2); mk(outer.filter(([x, z]) => x === 0 || z === 0 || x === l.w - 1 || z === l.h - 1), l.theme === 'club' ? brickMat : curbMat, perimH);
    // breakable glass windows (floor-to-ceiling curtain-wall glass on office/hotel/club ground exterior)
    const glassMat = quality > 0
      ? new THREE.MeshPhysicalMaterial({ color: 0xaad8ee, transparent: true, opacity: 0.3, roughness: 0.08, metalness: 0.15 })
      : std({ color: 0xaad8ee, transparent: true, opacity: 0.34, roughness: 0.15 });
    const frameAlum = std({ color: 0x161a20, roughness: 0.35, metalness: 0.65 });
    const curtainWall = l.theme === 'office' || l.theme === 'hotel' || l.theme === 'club';
    for (const w of l.windows) {
      const cx = Math.floor(w.x), cz = Math.floor(w.z);
      const horiz = sim.cell(cx - 1, cz) === WALL || sim.cell(cx - 1, cz) === WINDOW || sim.cell(cx + 1, cz) === WALL || sim.cell(cx + 1, cz) === WINDOW;
      const isFront = sim.cell(cx, cz + 1) === OUT || sim.cell(cx, cz - 1) === OUT || sim.cell(cx + 1, cz) === OUT || sim.cell(cx - 1, cz) === OUT;
      if (curtainWall && isFront) {
        g.add(box(1, 0.12, 1, frameAlum, w.x, 0.06, w.z), box(1, 0.25, 1, frameAlum, w.x, 2.875, w.z));
        g.add(box(horiz ? 0.08 : 0.14, 2.7, horiz ? 0.14 : 0.08, frameAlum, w.x + (horiz ? 0.46 : 0), 1.45, w.z + (horiz ? 0 : 0.46)));
        const pane = box(horiz ? 0.96 : 0.06, 2.65, horiz ? 0.06 : 0.96, glassMat, w.x, 1.44, w.z);
        g.add(pane);
        this.windows.set(cz * l.w + cx, pane);
      } else {
        g.add(box(1, 0.9, 1, wallMat, w.x, 0.45, w.z), box(1, 0.7, 1, wallMat, w.x, 2.65, w.z));
        const pane = box(horiz ? 0.98 : 0.06, 1.4, horiz ? 0.06 : 0.98, glassMat, w.x, 1.6, w.z);
        g.add(pane);
        this.windows.set(cz * l.w + cx, pane);
      }
    }
    // doors (+ lock & wedge indicators; glass entrance doors on office/hotel/bank)
    const doorMat = std({ map: T.doorTex(), roughness: 0.6 }), frameMat = std({ color: 0x202328, roughness: 0.4, metalness: 0.4 });
    const glassDoorMat = quality > 0
      ? new THREE.MeshPhysicalMaterial({ color: 0x99d0e8, transparent: true, opacity: 0.36, roughness: 0.08, metalness: 0.2 })
      : std({ color: 0x99d0e8, transparent: true, opacity: 0.38, roughness: 0.15 });
    const wedgeMat = std({ color: 0xf2a82e, roughness: 0.4 }), lockMat = std({ color: 0xe04848, emissive: 0x801010, emissiveIntensity: 0.6 });
    for (const d of l.doors) {
      const frontGlassDoor = (l.theme === 'office' || l.theme === 'hotel' || l.theme === 'bank') && (sim.cell(d.cx, d.cz + 1) === OUT || sim.cell(d.cx, d.cz - 1) === OUT);
      const lintel = box(1, 0.8, 1, frontGlassDoor ? frameAlum : wallMat, d.cx + 0.5, 2.6, d.cz + 0.5); g.add(lintel);
      const pivot = new THREE.Group();
      let glass: THREE.Mesh | undefined;
      if (frontGlassDoor) {
        glass = box(0.94, 2.18, 0.05, glassDoorMat, 0.47, 1.09, 0);
        pivot.add(glass);
        pivot.add(box(0.96, 0.08, 0.07, frameMat, 0.47, 0.04, 0), box(0.96, 0.08, 0.07, frameMat, 0.47, 2.15, 0));
        pivot.add(box(0.06, 2.18, 0.07, frameMat, 0.03, 1.09, 0), box(0.06, 2.18, 0.07, frameMat, 0.91, 1.09, 0));
        pivot.add(box(0.03, 0.55, 0.14, std({ color: 0xd0d6de, metalness: 0.85, roughness: 0.2 }), 0.82, 1.05, 0));
      } else {
        const panel = box(0.94, 2.18, 0.06, doorMat, 0.47, 1.09, 0); pivot.add(panel);
        pivot.add(box(0.05, 0.05, 0.16, std({ color: 0xc9b46a, metalness: 0.7, roughness: 0.3 }), 0.84, 1.05, 0));
      }
      const lock = box(0.08, 0.06, 0.18, lockMat, 0.84, 1.15, 0); lock.visible = !!d.locked; pivot.add(lock);
      const wedge = box(0.22, 0.08, 0.2, wedgeMat, 0.72, 0.04, 0); wedge.visible = !!d.wedged; pivot.add(wedge);
      const tripMat = new THREE.MeshBasicMaterial({ color: 0xff3c28 });
      const tripwire = box(0.92, 0.012, 0.012, tripMat, 0.47, 0.24, 0);
      tripwire.visible = !!(d.trapped && d.trapKnown);
      if (d.horiz) {
        pivot.position.set(d.cx + 0.03, 0, d.cz + 0.5);
        tripwire.position.set(d.cx + 0.5, 0.24, d.cz + 0.5);
        g.add(box(0.06, 2.2, 1.02, frameMat, d.cx + 0.0, 1.1, d.cz + 0.5), box(0.06, 2.2, 1.02, frameMat, d.cx + 1.0, 1.1, d.cz + 0.5), tripwire);
      } else {
        pivot.position.set(d.cx + 0.5, 0, d.cz + 0.03);
        tripwire.rotation.y = Math.PI / 2;
        tripwire.position.set(d.cx + 0.5, 0.24, d.cz + 0.5);
        g.add(box(1.02, 2.2, 0.06, frameMat, d.cx + 0.5, 1.1, d.cz + 0.0), box(1.02, 2.2, 0.06, frameMat, d.cx + 0.5, 1.1, d.cz + 1.0), tripwire);
      }
      if (quality >= 2) pivot.traverse((o: any) => { if (o.isMesh && o !== glass) { o.castShadow = true; o.receiveShadow = true; } });
      const base = d.horiz ? 0 : -Math.PI / 2; pivot.rotation.y = base; g.add(pivot); this.doors.push({ door: d, pivot, base, wedge, lock, tripwire, glass });
    }
    g.add(this.sensorGroup);
    // breaker box (wall-mounted flush to an adjacent solid wall if available)
    if (l.breaker) {
      const bm = std({ color: 0x3b444d, metalness: 0.5, roughness: 0.4 });
      const bx = Math.floor(l.breaker.x), bz = Math.floor(l.breaker.z);
      const bg = new THREE.Group();
      let ox = 0, oz = 0, ry = 0;
      if (sim.cell(bx, bz - 1) === WALL) { oz = -0.38; ry = 0; }
      else if (sim.cell(bx, bz + 1) === WALL) { oz = 0.38; ry = Math.PI; }
      else if (sim.cell(bx - 1, bz) === WALL) { ox = -0.38; ry = Math.PI / 2; }
      else if (sim.cell(bx + 1, bz) === WALL) { ox = 0.38; ry = -Math.PI / 2; }
      bg.position.set(l.breaker.x + ox, 0, l.breaker.z + oz);
      bg.rotation.y = ry;
      bg.add(box(0.32, 1.4, 0.22, bm, 0, 0.7, 0), box(0.16, 0.12, 0.25, new THREE.MeshBasicMaterial({ color: 0x4fd07a }), 0, 1.15, 0));
      g.add(bg);
    }
    // bomb device
    if (l.bomb) {
      const bm = std({ color: 0x1e2228, metalness: 0.4, roughness: 0.5 });
      const bg = new THREE.Group(); bg.position.set(l.bomb.x, 0, l.bomb.z);
      bg.add(box(0.55, 0.28, 0.38, bm, 0, 0.14, 0), box(0.42, 0.16, 0.28, std({ color: 0x5c2222 }), 0, 0.3, 0));
      this.bombLed = box(0.12, 0.04, 0.08, new THREE.MeshBasicMaterial({ color: 0xff2a2a }), 0, 0.4, 0);
      bg.add(this.bombLed);
      g.add(bg); this.bombBox = bg;
    }
    // props
    const crate = std({ map: T.crateTex() }), wood = std({ map: T.woodTex(), roughness: 0.6 }), shelf = std({ map: T.shelfTex() }), dark = std({ color: 0x1a1c20, roughness: 0.5 });
    const locker = std({ map: T.metalTex('locker', '#5d6b78'), metalness: 0.4, roughness: 0.55 }), white = std({ map: T.fabricTex('w', '#d8d6d0') }), pot = std({ color: 0x8a5a3c }), leaf = std({ color: 0x2f6b35 });
    const sofaCols = ['#7a2f2f', '#2f4a6a', '#4a4a4a', '#6a5a2f'];
    for (const p of l.props) {
      const o = new THREE.Group();
      const pw = p.w ?? 1, pd = p.d ?? 1;
      o.position.set(p.cx + pw / 2, 0, p.cz + pd / 2);
      const rj = ((p.cx * 13 + p.cz * 7) % 10) / 10;
      const seed = p.cx * 31 + p.cz * 17 + p.rot;
      const high = sim.cell(p.cx, p.cz) === 5;
      const pk = p.cz * l.w + p.cx;
      if (p.kind === 'server') {
        const rackFrame = std({ color: 0x16191f, metalness: 0.55, roughness: 0.42 });
        const grille = std({ color: 0x222832, metalness: 0.65, roughness: 0.38 });
        const led1 = box(0.66, 0.05, 0.77, new THREE.MeshBasicMaterial({ color: 0x2de080 }), 0, 1.72, 0);
        const led2 = box(0.66, 0.05, 0.77, new THREE.MeshBasicMaterial({ color: 0x3ea8ff }), 0, 1.38, 0);
        const led3 = box(0.66, 0.05, 0.77, new THREE.MeshBasicMaterial({ color: 0x2de080 }), 0, 1.04, 0);
        o.add(box(0.86, 2.15, 0.74, rackFrame, 0, 1.075, 0), box(0.76, 1.98, 0.76, grille, 0, 1.075, 0), led1, led2, led3);
        o.rotation.y = (p.rot * Math.PI) / 2;
        this.propViews.set(pk, { group: o, prop: p, serverLeds: [led1, led2, led3] });
      } else {
        const buildFallback = () => {
          switch (p.kind) {
            case 'crate': { const a = box(0.94, 0.94, 0.94, crate, 0, 0.47, 0); a.rotation.y = (rj - 0.5) * 0.2; o.add(a); if (high) { const b = box(0.86, 0.86, 0.86, crate, (rj - 0.5) * 0.08, 0.94 + 0.43, 0); b.rotation.y = (rj - 0.5) * 0.5; o.add(b); if (rj > 0.5) o.add(box(0.7, 0.5, 0.7, crate, 0, 2.05, 0)); } break; }
            case 'pc':
            case 'desk': {
              const dw = pw > 1 ? 1.82 : 0.98, dd = pd > 1 ? 0.92 : 0.86;
              o.add(box(dw, 0.05, dd, wood, 0, 0.75, 0), box(0.05, 0.74, dd * 0.92, wood, -dw * 0.45, 0.37, 0), box(0.05, 0.74, dd * 0.92, wood, dw * 0.45, 0.37, 0), box(dw * 0.88, 0.4, 0.03, wood, 0, 0.5, -dd * 0.44));
              const mon = new THREE.Group(); mon.position.set(0, 0.77, -0.15);
              const scrMat = new THREE.MeshBasicMaterial({ color: 0x2a4f7a });
              const scr = new THREE.Mesh(new THREE.PlaneGeometry(0.56, 0.32), scrMat); scr.position.set(0, 0.28, 0.017);
              mon.add(box(0.6, 0.36, 0.03, dark, 0, 0.28, 0), box(0.08, 0.14, 0.06, dark, 0, 0.08, 0), scr);
              o.add(mon); o.userData.deskMonitor = { group: mon, scrMat };
              break;
            }
            case 'bar': o.add(box(1.88, 1.02, 0.65, dark, 0, 0.51, 0), box(1.92, 0.08, 0.72, std({ color: 0x722f8a, emissive: 0x3b124d, emissiveIntensity: 0.4 }), 0, 1.03, 0)); break;
            case 'shelf': o.add(box(0.96, 2.05, 0.5, shelf, 0, 1.025, 0)); break;
            case 'locker': o.add(box(1.44, 1.94, 0.5, locker, 0, 0.97, 0)); break;
            case 'bed': o.add(box(1.24, 0.34, 1.92, wood, 0, 0.17, 0), box(1.18, 0.24, 1.84, white, 0, 0.44, 0), box(0.8, 0.12, 0.36, white, 0, 0.6, -0.68)); break;
            case 'chair': { const fm = std({ map: T.fabricTex('s' + (p.rot % 4), sofaCols[p.rot % 4]) }); o.add(box(0.76, 0.44, 0.74, fm, 0, 0.22, 0), box(0.76, 0.56, 0.18, fm, 0, 0.72, -0.28)); break; }
            case 'sofa': { const fm = std({ map: T.fabricTex('s' + (p.rot % 4), sofaCols[p.rot % 4]) }); o.add(box(1.82, 0.44, 0.84, fm, 0, 0.22, 0), box(1.82, 0.4, 0.2, fm, 0, 0.64, -0.32), box(0.16, 0.26, 0.84, fm, -0.83, 0.56, 0), box(0.16, 0.26, 0.84, fm, 0.83, 0.56, 0)); break; }
            case 'plant': { const c = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.18, 0.48, 10), pot); c.position.y = 0.24; o.add(c); for (let i = 0; i < 3; i++) { const s = new THREE.Mesh(new THREE.IcosahedronGeometry(0.32 - i * 0.05, 0), leaf); s.position.set((i - 1) * 0.09, 0.72 + i * 0.24, (rj - 0.5) * 0.1); s.rotation.set(i, rj * 6, i * 2); o.add(s); } break; }
          }
        };
        const fill = () => {
          const real = propModel(p.kind, seed, high);
          if (!real) return false;
          o.clear();
          o.add(real);
          o.userData = { ...real.userData };
          return true;
        };
        if (p.kind !== 'crate' && p.kind !== 'plant') o.rotation.y = (p.rot * Math.PI) / 2;
        else if (p.kind === 'plant') o.rotation.y = rj * Math.PI * 2;
        if (!fill()) {
          buildFallback();
          this.propSlots.push(() => { fill(); });
        }
        if (p.kind === 'pc' || p.kind === 'desk' || p.kind === 'plant') {
          this.propViews.set(pk, { group: o, prop: p });
        }
      }
      g.add(o);
    }
    this.buildExterior(quality);
    if (!propsReady && this.propSlots.length) {
      onPropsReady(() => {
        if (this.disposed) return;
        for (const populate of this.propSlots) populate();
        this.propSlots.length = 0;
      });
    }
  }
  private buildExterior(quality: number) {
    const l = this.sim.level, g = this.group;
    const darkSteel = std({ color: 0x181c22, roughness: 0.35, metalness: 0.72 });
    const concrete = std({ color: 0x565b63, roughness: 0.85 });
    const soffitMat = new THREE.MeshBasicMaterial({ color: 0xffe4b8 });
    const potMat = std({ color: 0x26292e, roughness: 0.85 });
    const shrubMat = std({ color: 0x264b2b, roughness: 0.9 });
    const extPromises: Promise<unknown>[] = [];

    const placeCityModel = (
      name: string,
      opts: { x: number; y: number; z: number; ry?: number; w?: number; h?: number; d?: number; scale?: number },
    ) => {
      extPromises.push(loadCityAsset(name).then(tpl => {
        if (!tpl || this.disposed) return;
        const obj = tpl.clone(true);
        const box3 = new THREE.Box3().setFromObject(obj);
        const sz = box3.getSize(new THREE.Vector3());
        const ctr = box3.getCenter(new THREE.Vector3());
        const sx = opts.w ? opts.w / Math.max(sz.x, 0.001) : (opts.scale ?? 1);
        const sy = opts.h ? opts.h / Math.max(sz.y, 0.001) : (opts.scale ?? sx);
        const szScale = opts.d ? opts.d / Math.max(sz.z, 0.001) : (opts.scale ?? sx);
        const wrap = new THREE.Group();
        obj.scale.set(sx, sy, szScale);
        obj.position.set(-ctr.x * sx, -box3.min.y * sy, -ctr.z * szScale);
        wrap.add(obj);
        wrap.position.set(opts.x, opts.y, opts.z);
        if (opts.ry) wrap.rotation.y = opts.ry;
        g.add(wrap);
      }));
    };

    const addBollard = (x: number, z: number) => {
      const b = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.15, 0.84, 12), std({ color: 0x6e737b, roughness: 0.72, metalness: 0.2 }));
      b.position.set(x, 0.42, z); g.add(b);
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.142, 0.142, 0.04, 12), new THREE.MeshBasicMaterial({ color: 0xd0d6de }));
      cap.position.set(x, 0.75, z); g.add(cap);
    };
    const addShrub = (x: number, z: number, ry = 0) => {
      const grp = new THREE.Group(); grp.position.set(x, 0, z); grp.rotation.y = ry; g.add(grp);
      const seed = Math.abs(Math.round(x * 7 + z * 13));
      const fill = () => {
        const real = exteriorPlanterModel(seed);
        if (!real) return false;
        grp.clear(); grp.add(real); return true;
      };
      if (!fill()) {
        grp.add(box(0.75, 0.48, 0.75, potMat, 0, 0.24, 0));
        for (let i = 0; i < 3; i++) {
          const s = new THREE.Mesh(new THREE.IcosahedronGeometry(0.28 - i * 0.04, 1), shrubMat);
          s.position.set((i - 1) * 0.11, 0.62 + i * 0.12, ((i % 2) - 0.5) * 0.1);
          grp.add(s);
        }
        this.propSlots.push(() => { fill(); });
      }
    };
    const addTree = (x: number, z: number, scale = 1.55) => {
      const grp = new THREE.Group(); grp.position.set(x, 0, z); g.add(grp);
      const seed = Math.abs(Math.round(x * 11 + z * 19));
      const fill = () => {
        const real = exteriorTreeModel(seed, scale);
        if (!real) return false;
        grp.clear(); grp.add(real); return true;
      };
      if (!fill()) {
        grp.add(box(0.72, 0.34, 0.72, potMat, 0, 0.17, 0));
        const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.12, 1.3, 8), std({ color: 0x4d3a2c }));
        trunk.position.y = 0.9; grp.add(trunk);
        const crown = new THREE.Mesh(new THREE.IcosahedronGeometry(0.55, 1), shrubMat);
        crown.position.y = 1.75; grp.add(crown);
        this.propSlots.push(() => { fill(); });
      }
    };
    const addSign = (text: string, bg: string, fg: string, glow: string, w: number, h: number, x: number, y: number, z: number, ry = 0) => {
      const sp = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: T.signTex(text, bg, fg, glow) }));
      sp.position.set(x, y, z); sp.rotation.y = ry; g.add(sp);
    };
    const addLight = (x: number, y: number, z: number, color: number, intensity: number, distance: number, decay = 1.5) => {
      if (this.lightPool.length > 0) this.lightSources.push({ x, y, z, color, intensity, distance, decay });
    };
    const addStreetLamp = (x: number, z: number, col = 0xffe0b2, ry = 0) => {
      placeCityModel('street_lamp_01', { x, y: 0, z, ry, scale: 1.18 });
      addLight(x, 4.35, z, col, 14, 15, 1.55);
    };

    if (l.theme === 'office') {
      // Cylindrical portico pillars flanking glass entrance (x=14.5, z=20.5)
      for (const px of [12.5, 16.5]) {
        const col = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 3.1, 18), concrete);
        col.position.set(px, 1.55, 21.45); g.add(col);
      }
      // Portico flat canopy overhang + soffit downlights + EXIT sign + Kista Tech Center & SL Metro totem
      g.add(box(10.6, 0.24, 2.4, darkSteel, 15.0, 3.18, 21.1));
      for (const lx of [11.2, 13.0, 14.5, 16.0, 17.8, 19.3]) {
        const d = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.03, 12), soffitMat);
        d.position.set(lx, 3.05, 21.3); g.add(d);
      }
      for (const lx of [12.4, 14.5, 16.6]) addLight(lx, 2.95, 21.35, 0xffdfb0, 16, 11, 1.5);
      addSign('EXIT · NÖDUTGÅNG', '#093818', '#52ff88', '#34e86a', 1.35, 0.3, 14.5, 2.52, 21.03);
      addSign('KISTA TECH CENTER', '#0c1624', '#dbeafe', '#3b82f6', 3.4, 0.48, 15.0, 3.55, 22.32);
      g.add(box(0.14, 2.9, 0.14, darkSteel, 7.2, 1.45, 25.1));
      addSign('T  KISTA', '#0a3a8a', '#ffffff', '#60a5fa', 1.7, 0.46, 7.2, 2.95, 25.18);
      addSign('T  KISTA', '#0a3a8a', '#ffffff', '#60a5fa', 1.7, 0.46, 7.2, 2.95, 25.02, Math.PI);
      for (const bx of [10.4, 11.7, 12.8, 16.2]) addBollard(bx, 22.85);
      addShrub(10.5, 21.45); addShrub(17.4, 21.45);
      addTree(8.5, 22.0, 1.55); addTree(27.0, 22.2, 1.55);

      // Photorealistic 3D office upper stories on y=3.12 + distinct corporate tower & neighboring complex
      g.add(box(24.4, 0.25, 18.2, darkSteel, 16.0, 3.22, 11.9));
      placeCityModel('office_main', { x: 16.0, y: 3.18, z: 11.9, w: 24.4, h: 15.8, d: 18.2 });
      placeCityModel('office_tower', { x: 39.5, y: 0, z: 10.5, w: 13.5, h: 28.0, d: 11.0, ry: -0.14 });
      placeCityModel('office_neighbor', { x: -13.5, y: 0, z: 11.5, w: 26.0, h: 12.5, d: 14.0, ry: Math.PI / 2 });
      placeCityModel('city_clinic', { x: 18.0, y: 0, z: -12.0, w: 24.0, h: 11.5, d: 12.0 });
      placeCityModel('metal_trash_can', { x: 9.2, y: 0, z: 24.2 });
      placeCityModel('fire_hydrant', { x: 4.9, y: 0, z: 25.4 });
      placeCityModel('concrete_road_barrier_02', { x: 26.2, y: 0, z: 26.2, ry: 0.18 });
      addStreetLamp(6.5, 25.4, 0xd8e8ff);
      addStreetLamp(27.5, 25.4, 0xd8e8ff, Math.PI);
    } else if (l.theme === 'warehouse') {
      const haz = std({ color: 0xc2921e, roughness: 0.6 });
      g.add(box(35.4, 0.24, 20.2, darkSteel, 21.5, 3.22, 13.9));
      // Sawtooth industrial warehouse building perched cleanly above playable floor + loading shutter doors
      placeCityModel('warehouse_main', { x: 21.5, y: 3.16, z: 13.9, w: 35.4, h: 7.4, d: 20.2 });
      placeCityModel('rollershutter_door', { x: 11.6, y: 0, z: 24.06 });
      placeCityModel('rollershutter_door', { x: 25.4, y: 0, z: 24.06 });
      placeCityModel('exterior_aircon_unit', { x: 28.4, y: 2.3, z: 24.15 });
      placeCityModel('warehouse_depot', { x: -11.5, y: 0, z: 14.0, w: 24.0, h: 8.5, d: 10.5, ry: Math.PI / 2 });
      placeCityModel('warehouse_depot', { x: 52.0, y: 0, z: 14.0, w: 24.0, h: 8.5, d: 10.5, ry: -Math.PI / 2 });
      placeCityModel('warehouse_depot', { x: 21.0, y: 0, z: -10.0, w: 28.0, h: 8.5, d: 10.0 });
      g.add(box(5.6, 0.25, 1.6, darkSteel, 16.5, 3.18, 23.8), box(5.6, 0.1, 0.12, haz, 16.5, 3.05, 24.55));
      addSign('WAREHOUSE 04', '#161a1e', '#f0c050', '#c89020', 2.6, 0.48, 16.5, 3.18, 24.62);
      addLight(16.5, 2.95, 24.1, 0xffb454, 18, 13, 1.5);
      const cont = (x: number, y: number, z: number, col: number, ry = 0) => {
        const c = box(5.8, 2.5, 2.4, std({ color: col, roughness: 0.62, metalness: 0.45 }), x, y, z);
        c.rotation.y = ry; g.add(c);
      };
      cont(7.2, 1.25, 27.6, 0x6b2e26, 0.08); cont(7.2, 3.75, 27.6, 0x2b4554, -0.04);
      cont(31.2, 1.25, 28.0, 0x2b4554, -0.14);
      for (const cx of [-2.5, 37.5]) {
        g.add(box(1.1, 16, 1.1, darkSteel, cx, 8, -2), box(1.1, 16, 1.1, darkSteel, cx + 3.2, 8, -2));
        g.add(box(14, 0.9, 1.2, haz, cx + 4, 15.5, -2));
        addLight(cx + 4, 14.5, -1, 0xffa64d, 24, 24, 1.4);
      }
      placeCityModel('concrete_road_barrier', { x: 11.4, y: 0, z: 29.8, ry: 0.1 });
      placeCityModel('concrete_road_barrier', { x: 35.8, y: 0, z: 29.4, ry: -0.2 });
      addStreetLamp(4.8, 25.0, 0xffc888);
      addStreetLamp(36.0, 25.0, 0xffc888, Math.PI);
    } else if (l.theme === 'hotel') {
      const stone = std({ color: 0x3b3530, roughness: 0.65 });
      const brass = std({ color: 0xc29848, roughness: 0.3, metalness: 0.8 });
      g.add(box(7.2, 0.08, 3.2, std({ color: 0x9b948a, roughness: 0.32, metalness: 0.15 }), 22.5, 0.03, 25.5));
      for (const px of [20.4, 24.6]) {
        const c = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.36, 3.3, 16), brass);
        c.position.set(px, 1.65, 25.4); g.add(c);
      }
      g.add(box(11.4, 0.35, 3.0, darkSteel, 22.5, 3.4, 25.3));
      addSign('HOTEL NORTH STAR', '#1c1510', '#ffd480', '#e0a238', 3.8, 0.54, 22.5, 3.42, 26.82);
      for (const lx of [20.5, 22.5, 24.5]) addLight(lx, 3.1, 25.6, 0xffcf88, 18, 12, 1.5);
      addShrub(18.6, 25.5); addShrub(26.4, 25.5);
      addTree(16.2, 25.8, 1.65); addTree(36.6, 26.2, 1.65);
      // Roof deck + towering Marina-style hotel skyscraper above the lobby & neighboring residential blocks
      g.add(box(38.4, 0.28, 21.4, stone, 23.0, 3.24, 14.4));
      placeCityModel('hotel_main', { x: 23.0, y: 3.26, z: 14.4, w: 38.4, h: 24.0, d: 21.4 });
      placeCityModel('hotel_neighbor', { x: -5.5, y: 0, z: 15.5, w: 12.0, h: 15.5, d: 13.0, ry: Math.PI / 2 });
      placeCityModel('hotel_neighbor', { x: 50.5, y: 0, z: 15.5, w: 12.0, h: 15.5, d: 13.0, ry: -Math.PI / 2 });
      placeCityModel('office_neighbor', { x: 23.0, y: 0, z: -12.0, w: 30.0, h: 12.5, d: 14.0 });
      placeCityModel('fire_hydrant', { x: 14.4, y: 0, z: 26.8 });
      placeCityModel('metal_trash_can', { x: 28.4, y: 0, z: 25.8 });
      addStreetLamp(13.5, 26.4, 0xffd59e);
      addStreetLamp(38.5, 26.4, 0xffd59e, Math.PI);
    } else if (l.theme === 'bank') {
      const limestone = std({ color: 0x767a82, roughness: 0.62 });
      g.add(box(14.0, 0.12, 3.6, limestone, 15.5, 0.05, 25.8));
      for (const cx of [11.2, 13.4, 17.6, 19.8]) {
        const col = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.46, 6.4, 16), limestone);
        col.position.set(cx, 3.2, 25.6); g.add(col);
      }
      g.add(box(12.2, 1.1, 2.8, limestone, 15.5, 6.95, 25.1));
      addSign('NORDIA BANK', '#141a22', '#e8edf2', '#8eb6e0', 4.0, 0.56, 15.5, 6.95, 26.52);
      const ped = new THREE.Mesh(new THREE.ConeGeometry(6.4, 2.2, 3), limestone);
      ped.rotation.y = Math.PI / 6; ped.scale.set(1.0, 1.0, 0.35); ped.position.set(15.5, 8.6, 25.1); g.add(ped);
      // Stone upper bank building on y=3.24 + classical historic annex buildings flanking the street
      g.add(box(36.2, 0.28, 21.2, limestone, 22.0, 3.24, 14.4));
      placeCityModel('bank_main', { x: 22.0, y: 3.26, z: 14.4, w: 36.2, h: 14.5, d: 21.2 });
      placeCityModel('bank_annex', { x: -6.5, y: 0, z: 17.0, w: 18.5, h: 12.5, d: 12.0, ry: Math.PI / 2 });
      placeCityModel('bank_annex', { x: 50.5, y: 0, z: 17.0, w: 18.5, h: 12.5, d: 12.0, ry: -Math.PI / 2 });
      placeCityModel('office_main', { x: 22.0, y: 0, z: -13.0, w: 26.0, h: 16.0, d: 15.0 });
      for (const bx of [9.6, 11.2, 12.8, 18.2, 19.8]) addBollard(bx, 27.1);
      addShrub(12.3, 25.7); addShrub(18.7, 25.7);
      addTree(7.8, 26.2, 1.6); addTree(30.8, 26.2, 1.6);
      for (const lx of [12.5, 15.5, 18.5]) addLight(lx, 5.8, 25.8, 0xffdfb8, 18, 12, 1.5);
      placeCityModel('concrete_road_barrier_02', { x: 21.8, y: 0, z: 28.4 });
      placeCityModel('fire_hydrant', { x: 6.4, y: 0, z: 27.4 });
      addStreetLamp(6.2, 26.8, 0xffe4b8);
      addStreetLamp(32.5, 26.8, 0xffe4b8, Math.PI);
    } else if (l.theme === 'club') {
      const brick = std({ map: T.brickTex('club_ext', '#261e2a', '#1b1520') });
      g.add(box(32.2, 0.26, 21.2, brick, 20.0, 3.22, 13.4));
      placeCityModel('club_main', { x: 20.0, y: 3.24, z: 13.4, w: 32.2, h: 13.5, d: 21.2 });
      placeCityModel('club_alley', { x: -4.2, y: 0, z: 22.0, w: 14.0, h: 12.0, d: 14.0, ry: Math.PI / 2 });
      placeCityModel('club_alley', { x: 34.5, y: 0, z: 24.5, w: 14.0, h: 12.0, d: 14.0, ry: -Math.PI / 2 });
      placeCityModel('city_clinic', { x: 48.0, y: 0, z: 12.0, w: 18.0, h: 11.0, d: 11.0, ry: -Math.PI / 2 });
      placeCityModel('modular_fire_escape', { x: 4.8, y: 2.6, z: 27.0, ry: Math.PI / 2, scale: 0.72 });
      placeCityModel('metal_trash_can', { x: 6.8, y: 0, z: 28.4, ry: Math.PI / 2 });
      placeCityModel('street_lamp_02', { x: 6.2, y: 3.4, z: 26.6, ry: Math.PI / 2 });
      g.add(box(1.2, 6.5, 6.0, brick, 5.5, 3.25, 27.0), box(1.2, 6.5, 6.0, brick, 24.0, 3.25, 27.0));
      addSign('ECLIPSE', '#12061c', '#ff52e0', '#d438ff', 3.4, 0.72, 13.5, 3.25, 24.06);
      addShrub(7.6, 24.6); addShrub(15.2, 24.6);
      for (const [sx, sz, col] of [[6.15, 25.5, 0xd438ff], [6.15, 28.0, 0x38c8ff], [23.35, 25.5, 0x38c8ff], [23.35, 28.0, 0xd438ff]] as const) {
        g.add(box(0.14, 0.45, 0.2, new THREE.MeshBasicMaterial({ color: col }), sx, 2.3, sz));
        addLight(sx + (sx < 13 ? 0.5 : -0.5), 2.3, sz, col, 14, 10, 1.6);
      }
      const ballGrp = new THREE.Group(); ballGrp.position.set(14.0, 2.62, 16.5);
      const ball = new THREE.Mesh(new THREE.IcosahedronGeometry(0.34, 1), std({ color: 0xe6eeff, metalness: 0.95, roughness: 0.08, emissive: 0x384460 }));
      ballGrp.add(ball); g.add(ballGrp); this.discoBall = ballGrp;
      for (let i = 0; i < 6; i++) {
        const beam = new THREE.Mesh(
          new THREE.CylinderGeometry(0.015, 0.06, 3.2, 6),
          new THREE.MeshBasicMaterial({ color: i % 2 ? 0xff38c8 : 0x38d8ff, transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending, depthWrite: false }),
        );
        beam.position.set(14.0 + (i - 2.5) * 1.4, 1.65, 17.5);
        beam.rotation.set(0.55, 0, (i - 2.5) * 0.25);
        g.add(beam); this.lasers.push(beam);
      }
    } else if (l.theme === 'raid') {
      const sx = l.playerSpawn.x, sz = l.playerSpawn.z;
      const conc = std({ color: 0x4b4e54, roughness: 0.85 });
      g.add(box(32.2, 0.26, 20.4, conc, 20.0, 3.22, 13.0));
      placeCityModel('raid_outpost', { x: 20.0, y: 3.24, z: 13.0, w: 32.2, h: 14.5, d: 20.4 });
      placeCityModel('raid_compound', { x: -4.5, y: 0, z: 13.0, w: 12.0, h: 14.0, d: 9.0, ry: Math.PI / 2 });
      placeCityModel('raid_graffiti', { x: 47.0, y: 0, z: 13.5, w: 14.0, h: 7.5, d: 18.0, ry: -Math.PI / 2 });
      placeCityModel('city_clinic', { x: 20.0, y: 0, z: -11.0, w: 24.0, h: 11.0, d: 11.0 });

      const fz = sz - 1.5;
      // Real Poly Haven CC0 modular chainlink fence panels + posts flanking the open entry gate
      extPromises.push(loadCityAsset('modular_chainlink_fence').then(kit => {
        if (!kit || this.disposed) return;
        const panelSrc = kit.getObjectByName('modular_chainlink_fence_double');
        const postSrc = kit.getObjectByName('modular_chainlink_post_middle');
        if (!panelSrc || !postSrc) return;
        for (let fx = 3.0; fx <= 37.0; fx += 2.0) {
          if (Math.abs(fx - sx) < 2.6) continue;
          const panel = panelSrc.clone(true);
          panel.position.set(fx, 1.24, fz);
          panel.scale.set(1.04, 0.96, 1.0);
          g.add(panel);
          const post = postSrc.clone(true);
          post.position.set(fx - 1.0, 1.26, fz);
          g.add(post);
        }
      }));
      for (const tx of [5.0, 36.2]) {
        g.add(box(0.22, 7.5, 0.22, darkSteel, tx, 3.75, fz + 0.3));
        g.add(box(0.9, 0.3, 0.2, soffitMat, tx, 7.4, fz + 0.3));
        addLight(tx, 7.1, fz + 0.6, 0xdfe8ff, 26, 22, 1.4);
      }
      placeCityModel('concrete_road_barrier', { x: sx - 3.6, y: 0, z: fz + 1.1, ry: 0.2 });
      placeCityModel('metal_trash_can', { x: 6.4, y: 0, z: fz + 0.9 });
      addTree(4.5, fz + 1.4, 1.5); addTree(36.6, fz + 1.4, 1.5);
    }
    if (l.vehicle) {
      extPromises.push(this.spawnPoliceUnit(l.vehicle.x, l.vehicle.z, l.vehicle.yaw, quality));
    }
    this.readyPromise = Promise.all(extPromises).then(() => {});
  }
  private async spawnPoliceUnit(x: number, z: number, yaw: number, quality: number) {
    try {
      const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync('./models/vehicle/marauder.glb');
      if (this.disposed) return;
      const v = gltf.scene;
      v.traverse((o: any) => {
        if (!o.isMesh) return;
        const m = o.material as THREE.MeshStandardMaterial;
        m.envMapIntensity = 0.85;
        const tint = MARAUDER_PAINT[m.name];
        if (tint) { m.color.setHex(tint[0]); m.roughness = tint[1]; m.metalness = tint[2]; }
      });
      const w = new THREE.Group();
      w.add(v); w.position.set(x, 0, z); w.rotation.y = yaw;
      this.group.add(w);
      w.updateMatrixWorld(true);
      const meshes: THREE.Mesh[] = [];
      v.traverse((o: any) => { if (o.isMesh) meshes.push(o); });
      const ray = new THREE.Raycaster();
      const hit = (from: THREE.Vector3, dir: THREE.Vector3) => {
        ray.set(w.localToWorld(from), dir.transformDirection(w.matrixWorld));
        return ray.intersectObjects(meshes, false)[0];
      };
      const tex = T.textTex('POLICE');
      for (const sgn of [-1, 1]) {
        const h = hit(new THREE.Vector3(2.05, 1.42, sgn * 4), new THREE.Vector3(0, 0, -sgn));
        if (!h || !h.face) continue;
        const n = h.face.normal.clone().transformDirection(h.object.matrixWorld);
        const d = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 0.2), new THREE.MeshStandardMaterial({ map: tex, transparent: true, roughness: 0.6, metalness: 0, polygonOffset: true, polygonOffsetFactor: -4 }));
        d.position.copy(h.point).addScaledVector(n, 0.012); d.lookAt(h.point.clone().add(n));
        this.group.add(d); w.attach(d);
      }
      const top = hit(new THREE.Vector3(0.9, 6, 0), new THREE.Vector3(0, -1, 0));
      const bar = new THREE.Group();
      bar.position.set(0.9, (top ? w.worldToLocal(top.point.clone()).y : 2.3) + 0.05, 0);
      bar.rotation.y = Math.PI / 2; w.add(bar);
      const dark = std({ color: 0x0c0e11, roughness: 0.4, metalness: 0.6 });
      bar.add(box(1.5, 0.05, 0.3, dark));
      this.strobeLens = [0x2a6bff, 0xff2a2a].map((c, i) => {
        const m = new THREE.MeshStandardMaterial({ color: 0x111418, emissive: c, emissiveIntensity: 0.3, roughness: 0.25 });
        const b = box(0.66, 0.1, 0.24, m, i ? 0.37 : -0.37, 0.075, 0);
        bar.add(b); return m;
      });
      if (quality > 0) {
        this.strobeBlue = new THREE.PointLight(0x2e7bff, 0, 14, 1.6); this.strobeBlue.position.set(-0.6, 0.45, 0.3);
        this.strobeRed = new THREE.PointLight(0xff3434, 0, 14, 1.6); this.strobeRed.position.set(0.6, 0.45, 0.3);
        bar.add(this.strobeBlue, this.strobeRed);
      }
    } catch { /* fallback quietly if asset unavailable */ }
  }
  update(dt = 0.016, time = 0, camX = this.sim.player.x, camZ = this.sim.player.z) {
    for (const d of this.doors) {
      d.pivot.rotation.y = d.base + d.door.open * 1.62;
      d.lock.visible = !!d.door.locked;
      d.wedge.visible = !!d.door.wedged;
      d.tripwire.visible = !!(d.door.trapped && d.door.trapKnown);
      if (d.glass && d.glass.visible && this.sim.brokenDoorGlass.has(d.door.id)) d.glass.visible = false;
    }
    // Sync dropped evidence weapons on the floor
    const activeEvIds = new Set<number>();
    for (const ev of this.sim.evidence) {
      if (ev.secured) continue;
      activeEvIds.add(ev.id);
      let g = this.evidenceViews.get(ev.id);
      if (!g) {
        g = new THREE.Group();
        const gunMesh = droppedPistol();
        gunMesh.scale.setScalar(ev.kind === 'pistol' ? 1.15 : 1.55);
        const halo = new THREE.Mesh(
          new THREE.RingGeometry(0.14, 0.2, 20),
          new THREE.MeshBasicMaterial({ color: 0x52c8ff, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false }),
        );
        halo.rotation.x = -Math.PI / 2;
        halo.position.y = 0.02;
        halo.name = 'halo';
        g.add(gunMesh, halo);
        g.position.set(ev.x, 0.01, ev.z);
        g.rotation.y = ev.yaw;
        this.group.add(g);
        this.evidenceViews.set(ev.id, g);
      }
      const halo = g.getObjectByName('halo') as THREE.Mesh | undefined;
      if (halo) {
        const pulse = 0.3 + 0.25 * Math.sin(time * 4.5 + ev.id);
        (halo.material as THREE.MeshBasicMaterial).opacity = pulse;
        halo.scale.setScalar(0.95 + 0.1 * Math.sin(time * 4.5 + ev.id));
      }
    }
    for (const [id, g] of this.evidenceViews) {
      if (!activeEvIds.has(id)) {
        this.group.remove(g);
        this.evidenceViews.delete(id);
      }
    }
    // Sync planted acoustic wall sensors + through-wall sonar ping rings
    for (const sn of this.sim.sensors) {
      if (this.sensorViews.has(sn)) continue;
      this.sensorViews.add(sn);
      const puck = new THREE.Mesh(
        new THREE.CylinderGeometry(0.08, 0.08, 0.04, 12),
        new THREE.MeshStandardMaterial({ color: 0x20262e, emissive: 0x1ee6b8, emissiveIntensity: 0.8, roughness: 0.35 }),
      );
      puck.position.set(sn.x, 1.3, sn.z);
      puck.rotation.x = Math.PI / 2;
      this.sensorGroup.add(puck);
    }
    for (const pg of this.sim.sensorPings) {
      if ((pg.t ?? 0) > 1.32) {
        const col = pg.kind === 'suspect' ? 0xff4848 : 0x4fd07a;
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(0.22, 0.32, 24),
          new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.85, depthTest: false, depthWrite: false, side: THREE.DoubleSide }),
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(pg.x, 0.9, pg.z);
        ring.renderOrder = 10;
        this.group.add(ring);
        this.pingRings.push({ mesh: ring, t: 1.1 });
      }
    }
    for (const pr of this.pingRings) {
      pr.t -= dt;
      const k = 1 - pr.t / 1.1;
      pr.mesh.scale.setScalar(1 + k * 2.4);
      (pr.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, pr.t * 0.78);
      if (pr.t <= 0) { this.group.remove(pr.mesh); pr.mesh.geometry.dispose(); }
    }
    this.pingRings = this.pingRings.filter(pr => pr.t > 0);
    for (const [k, m] of this.windows) {
      if (this.sim.brokenWindows.has(k) && m.visible) m.visible = false;
    }
    for (const pk of this.sim.brokenProps) {
      if (this.appliedBrokenProps.has(pk)) continue;
      this.appliedBrokenProps.add(pk);
      const pv = this.propViews.get(pk);
      if (!pv) continue;
      const { group, prop, serverLeds } = pv;
      if (prop.kind === 'server' && serverLeds) {
        for (const lm of serverLeds) (lm.material as THREE.MeshBasicMaterial).color.setHex(0x0c0f14);
      } else if (prop.kind === 'plant') {
        group.rotation.set(1.28, group.rotation.y, 0.25);
        group.position.y = 0.2;
      } else if (prop.kind === 'desk' || prop.kind === 'pc') {
        const ud = group.userData;
        if (ud.vase) ud.vase.visible = false;
        if (ud.deskMonitor) {
          ud.deskMonitor.scrMat.color.setHex(0x0a0d12);
          ud.deskMonitor.group.rotation.set(-0.34, 0.2, -0.14);
        }
        if (ud.pcMonitor) {
          const m = ud.pcMonitor;
          const dead = box(m.w, m.h, 0.03, new THREE.MeshStandardMaterial({ color: 0x0c1016, roughness: 0.25, metalness: 0.4 }), m.x, m.y, m.z + 0.015);
          dead.rotation.x = -0.08;
          group.add(dead);
        }
      }
    }
    const powerChanged = this.sim.powerOn !== this.lastPower;
    if (powerChanged) {
      this.lastPower = this.sim.powerOn;
      for (const lm of this.lampMeshes) lm.material = this.lastPower ? this.lampOnMat : this.lampOffMat;
    }
    if (this.lightPool.length > 0) {
      this.poolT -= dt;
      const moved = (camX - this.lastPoolX) * (camX - this.lastPoolX) + (camZ - this.lastPoolZ) * (camZ - this.lastPoolZ);
      if (powerChanged || (this.poolT <= 0 && moved > 0.12)) {
        this.lastPoolX = camX;
        this.lastPoolZ = camZ;
        this.poolT = 0.08;
        const active = this.lightSources
          .filter(s => !s.isRoom || this.sim.powerOn)
          .map(s => ({ s, d2: (s.x - camX) * (s.x - camX) + (s.z - camZ) * (s.z - camZ) }))
          .sort((a, b) => a.d2 - b.d2);
        for (let i = 0; i < this.lightPool.length; i++) {
          const pl = this.lightPool[i];
          const item = active[i];
          if (!item || item.d2 > 625) {
            pl.intensity = 0;
          } else {
            const s = item.s;
            pl.position.set(s.x, s.y, s.z);
            pl.color.setHex(s.color);
            pl.distance = s.distance;
            pl.decay = s.decay;
            pl.intensity = s.intensity;
          }
        }
      }
    }
    if (this.bombLed && this.sim.bomb) {
      if (this.sim.bomb.defused) { (this.bombLed.material as THREE.MeshBasicMaterial).color.setHex(0x4fd07a); this.bombLed.visible = true; }
      else { this.bombLed.visible = Math.floor(this.sim.time * (this.sim.bomb.time < 20 ? 6 : 2)) % 2 === 0; }
    }
    const ph = (time * 1.35) % 1, fl = (p: number) => (p < 0.08 || (p > 0.14 && p < 0.22) ? 1 : 0);
    if (this.strobeBlue) this.strobeBlue.intensity = fl(ph) * 28;
    if (this.strobeRed) this.strobeRed.intensity = fl((ph + 0.5) % 1) * 20;
    if (this.strobeLens.length) {
      this.strobeLens[0].emissiveIntensity = 0.25 + fl(ph) * 5;
      this.strobeLens[1].emissiveIntensity = 0.25 + fl((ph + 0.5) % 1) * 5;
    }
    if (this.discoBall) this.discoBall.rotation.y += dt * 0.9;
    if (this.lasers.length) {
      this.lasers.forEach((b, i) => {
        b.rotation.z = Math.sin(time * 1.4 + i) * 0.45;
        b.rotation.x = 0.72 + Math.cos(time * 1.1 + i * 0.7) * 0.22;
      });
    }
  }
}
function scaleUV(geo: THREE.BufferGeometry, sx: number, sy: number) { const uv = geo.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * sx, uv.getY(i) * sy); }

// ---------------- characters ----------------
const SKIN = [0xe0b494, 0xc68f6a, 0x8d5a3c, 0xf0c8a8, 0xa9744f, 0xd8a47c];
const HOOD = [0x3b3b3b, 0x5a3a2a, 0x2f4a36, 0x4a2f4a, 0x6b1f1f, 0x2a3a5a];
const SHIRT = [0xe8e8e8, 0x9cc4e8, 0xe8a8b8, 0xe6d58a, 0x6ab8a8, 0xb0b0b8];
const HAIR = [0x2a1c12, 0x111111, 0x6b4a2a, 0xc9a85a, 0x4a4a4a, 0x7a2f1a];
export const TEAM_COLOR = { A: 0xe04848, B: 0x3d8bf0 };
const shadowGeo = new THREE.CircleGeometry(0.42, 16), shadowMat = new THREE.MeshBasicMaterial({ color: 0, transparent: true, opacity: 0.38, depthWrite: false });
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

const GUNPOSE = { p: [0, 0.08, 0], r: [1.57, 0, 0], s: 1.15 }; // carbine in the right hand bone
// extra bone rotations (radians) for the kneeling poses; tuned by eye
const POSE = { thigh: 0, shin: 1.7, drop: 0.42, up: [2.4, 0.4, 0, 0, 0.7], cuff: [-0.5, 0.5, 0, 0, 0.9], head: 0.4 };
const P_DROP = () => ((window as any).__pose ?? POSE).drop;
export class ActorView {
  /** Officers use the detailed operator model (off on the lowest graphics setting). */
  static detailed = true;
  root = new THREE.Group(); body = new THREE.Group(); torso = new THREE.Group();
  legs: { hip: THREE.Group; knee: THREE.Group }[] = []; arms: { sh: THREE.Group; el: THREE.Group }[] = [];
  head = new THREE.Group(); gun = new THREE.Group(); label?: THREE.Sprite; fall = 0; flashT = 0; flash: THREE.Sprite;
  pool?: THREE.Mesh; poolT = 0; dropped?: THREE.Group; wounds = 0;
  rig?: Rig; private shootT = 0; private rifle = false; op?: OperatorBody; private teamMat?: THREE.MeshStandardMaterial; private teamShown?: Team;
  private playerShield?: THREE.Group; private playerTorch?: THREE.SpotLight; private torchGlow?: THREE.Mesh;
  private labelState = '';
  constructor(public a: Actor) {
    const v = a.variant, off = a.kind === 'officer' || a.kind === 'player', tcol = a.kind === 'player' ? 0x4fd07a : TEAM_COLOR[a.team];
    const cloth = std({ color: off ? 0x1b2434 : a.kind === 'suspect' ? HOOD[v] : SHIRT[v] });
    const pants = std({ color: off ? 0x161d2a : a.kind === 'suspect' ? 0x24303f : [0x2b2b33, 0x3a3f4a, 0x4a3a2a][v % 3] });
    const skin = std({ color: SKIN[(v + a.id) % 6], roughness: 0.7 }), black = std({ color: 0x0e1014, roughness: 0.6 }), boot = std({ color: 0x15130f });
    const tc = off ? std({ color: tcol, emissive: tcol, emissiveIntensity: 0.35 }) : null;
    if (a.kind === 'officer' && tc) { this.teamMat = tc; this.teamShown = a.team; }
    if (a.kind === 'player') {
      const sg = buildBallisticShield(true);
      sg.position.set(-0.14, 1.15, -0.44);
      sg.visible = false;
      this.root.add(sg);
      this.playerShield = sg;

      const tg = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 8), new THREE.MeshBasicMaterial({ color: 0xfff0cc }));
      tg.position.set(0.16, 1.38, -0.45);
      tg.visible = false;
      this.root.add(tg);
      this.torchGlow = tg;

      const sp = new THREE.SpotLight(0xfff1d4, 0, 14, 0.48, 0.55, 1.4);
      sp.position.set(0.16, 1.38, -0.42);
      sp.target.position.set(0.16, 1.28, -6);
      this.root.add(sp, sp.target);
      this.playerTorch = sp;
    }
    this.root.add(this.body); const sh = new THREE.Mesh(shadowGeo, shadowMat); sh.rotation.x = -Math.PI / 2; sh.position.y = 0.012; this.root.add(sh);
    for (const s of [-1, 1]) {
      const hip = new THREE.Group(); hip.position.set(s * 0.1, 0.92, 0); hip.add(box(0.16, 0.48, 0.18, pants, 0, -0.23, 0));
      const knee = new THREE.Group(); knee.position.y = -0.46; knee.add(box(0.14, 0.42, 0.15, pants, 0, -0.21, 0), box(0.15, 0.1, 0.27, boot, 0, -0.42, -0.05)); hip.add(knee);
      if (off) knee.add(box(0.16, 0.14, 0.05, black, 0, -0.04, -0.08));
      this.body.add(hip); this.legs.push({ hip, knee });
    }
    this.torso.position.y = 0.92; this.body.add(this.torso); const t = this.torso;
    t.add(box(0.38, 0.2, 0.22, pants, 0, 0.08, 0), box(0.42, 0.42, 0.24, cloth, 0, 0.36, 0));
    if (off) {
      t.add(box(0.46, 0.4, 0.3, black, 0, 0.36, 0), box(0.3, 0.12, 0.08, black, 0, 0.2, -0.17), box(0.1, 0.14, 0.07, black, -0.14, 0.34, -0.18), box(0.1, 0.14, 0.07, black, 0.05, 0.34, -0.18));
      const back = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.15), new THREE.MeshBasicMaterial({ map: T.polisTex() })); back.position.set(0, 0.43, 0.152); t.add(back);
      const front = back.clone(); front.scale.set(0.5, 0.5, 1); front.rotation.y = Math.PI; front.position.set(0.1, 0.48, -0.152); t.add(front);
      t.add(box(0.47, 0.05, 0.31, tc!, 0, 0.18, 0));
    } else if (a.kind === 'suspect') t.add(box(0.3, 0.16, 0.12, cloth, 0, 0.58, 0.1));
    for (const s of [-1, 1]) {
      const shd = new THREE.Group(); shd.position.set(s * 0.27, 0.52, 0); shd.add(box(0.12, 0.32, 0.13, cloth, 0, -0.14, 0));
      const el = new THREE.Group(); el.position.y = -0.3; el.add(box(0.1, 0.27, 0.11, a.kind === 'civ' && v % 2 ? skin : cloth, 0, -0.13, 0), box(0.09, 0.1, 0.1, off || a.kind === 'suspect' ? black : skin, 0, -0.31, 0)); shd.add(el);
      if (tc) shd.add(box(0.135, 0.09, 0.145, tc, 0, -0.1, 0));
      t.add(shd); this.arms.push({ sh: shd, el });
    }
    this.head.position.y = 0.6; t.add(this.head); const h = this.head;
    h.add(box(0.1, 0.08, 0.1, skin, 0, 0.02, 0));
    if (off) { h.add(box(0.2, 0.2, 0.21, skin, 0, 0.16, 0)); const helm = new THREE.Mesh(new THREE.SphereGeometry(0.15, 12, 8, 0, 6.3, 0, 1.75), black); helm.position.y = 0.2; helm.scale.set(1, 0.95, 1.08); h.add(helm, box(0.2, 0.07, 0.03, std({ color: 0x223040, roughness: 0.2, metalness: 0.5 }), 0, 0.18, -0.115), box(0.24, 0.035, 0.26, tc!, 0, 0.275, 0), box(0.07, 0.12, 0.1, black, -0.13, 0.15, 0), box(0.07, 0.12, 0.1, black, 0.13, 0.15, 0)); }
    else if (a.kind === 'suspect') { const mask = v % 3 !== 2; h.add(box(0.2, 0.22, 0.21, mask ? black : skin, 0, 0.16, 0)); if (mask) h.add(box(0.15, 0.04, 0.02, skin, 0, 0.19, -0.105)); else h.add(box(0.21, 0.07, 0.22, std({ color: 0x20242c }), 0, 0.26, -0.01), box(0.2, 0.02, 0.1, std({ color: 0x20242c }), 0, 0.235, -0.15)); }
    else { h.add(box(0.2, 0.22, 0.21, skin, 0, 0.16, 0)); const hair = std({ color: HAIR[v] }); h.add(box(0.215, 0.09, 0.225, hair, 0, 0.245, 0.005)); if (v % 2 === 0) h.add(box(0.215, 0.2, 0.06, hair, 0, 0.14, 0.09)); h.add(box(0.03, 0.03, 0.01, black, -0.05, 0.18, -0.106), box(0.03, 0.03, 0.01, black, 0.05, 0.18, -0.106)); }
    if (a.kind !== 'civ') {
      const sus = a.kind === 'suspect', gm = std({ color: sus ? 0x3b4048 : 0x23262b, roughness: 0.45, metalness: 0.3 }), wood = std({ color: 0x7a4a22, roughness: 0.8 }), g = this.gun;
      g.add(box(0.05, 0.08, 0.42, gm, 0, 0, -0.1), box(0.03, 0.03, 0.3, gm, 0, 0.01, -0.44), box(0.04, 0.14, 0.06, gm, 0, -0.1, -0.08), box(0.045, 0.07, 0.2, sus ? wood : gm, 0, -0.01, 0.2), box(0.035, 0.1, 0.05, sus ? wood : gm, 0, -0.08, 0.06));
      if (sus) { g.add(box(0.055, 0.06, 0.16, wood, 0, -0.005, -0.3)); const mag = box(0.036, 0.16, 0.06, gm, 0, -0.12, -0.13); mag.rotation.x = 0.3; g.add(mag); g.scale.setScalar(1.2); }
      // the weapon sits in the right hand, so it follows the arm in every pose
      g.rotation.x = -Math.PI / 2; g.position.set(0, -0.23, -0.1); this.arms[1].el.add(g);
      if (sus) { const d = g.clone(); d.rotation.set(0, 0.9 + a.id, Math.PI / 2); d.position.set(0.45, 0.04, -0.25); d.visible = false; this.root.add(d); this.dropped = d; }
    }
    this.flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: T.glowTex(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true })); this.flash.scale.setScalar(0.5); this.flash.position.set(0.1, 0.43, -0.9); this.flash.visible = false; t.add(this.flash);
    if (off) { const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: T.labelTex(a.name.slice(0, 7), '#' + tcol.toString(16)), transparent: true, depthWrite: false })); sp.scale.set(0.34, 0.17, 1); sp.position.y = 2.0; this.root.add(sp); this.label = sp; }
    this.root.position.set(a.x, 0, a.z); this.root.rotation.y = a.yaw;
  }
  muzzle() { this.flashT = 0.05; this.shootT = 0.35; }
  /** Animated 3D character: pick the animation that matches what the actor is doing. */
  private updateRig(dt: number, time: number) {
    const a = this.a, g = this.rig!, armed = a.armed && a.kind !== 'civ';
    this.flashT -= dt; this.shootT -= dt; this.flash.visible = this.flashT > 0 && a.alive; if (this.flash.visible) this.flash.material.rotation = time * 50;
    const kneel = a.alive && (a.down || a.downed);
    if (!a.alive) g.play('Death', 0.1, true);
    else if (kneel) g.play('Idle', 0.25);
    else if (a.stun > 0.3 && a.kind !== 'officer' && a.kind !== 'player') g.play('HitRecieve', 0.1, false, 0.8);
    else if (a.moving) { if (armed) g.play(a.target || this.shootT > 0 ? 'Run_Shoot' : 'Run', 0.15, false, a.kind === 'suspect' ? 0.9 : 1.1); else g.play(a.kind === 'civ' ? 'Run' : 'Walk', 0.15); }
    else if (armed) g.play(this.shootT > 0 ? 'Idle_Gun_Shoot' : a.target || a.ads ? 'Idle_Gun_Pointing' : 'Idle_Gun', 0.12);
    else g.play(a.kind === 'civ' ? 'Idle_Neutral' : 'Idle', 0.25);
    g.mixer.update(dt);
    this.kneelK = lerp(this.kneelK, kneel ? 1 : 0, Math.min(1, dt * 6));
    if (this.kneelK > 0.01) { // kneeling with hands up (surrendered) or behind the back (cuffed): bend the animated skeleton
      const k = this.kneelK, B = g.bones, P = (window as any).__pose ?? POSE, up = a.restrained ? P.cuff : P.up;
      for (const s of ['L', 'R']) { const sg = s === 'L' ? 1 : -1;
        B['UpperLeg' + s]?.rotateX(P.thigh * k); B['LowerLeg' + s]?.rotateX(P.shin * k);
        const ua = B['UpperArm' + s], la = B['LowerArm' + s]; if (ua) { ua.rotateX(up[0] * k); ua.rotateZ(up[1] * k * sg); ua.rotateY(up[2] * k * sg); } if (la) { la.rotateX(up[3] * k); la.rotateZ(up[4] * k * sg); }
      }
      B['Head']?.rotateX((a.restrained ? P.head : 0) * k);
    }
    this.proneK = lerp(this.proneK, a.alive && (a.prone || a.downed) ? 1 : 0, Math.min(1, dt * 7));
    g.obj.rotation.x = -this.proneK * Math.PI / 2; // crawling or downed: lying low
    g.obj.position.y = -P_DROP() * this.kneelK - (a.kind === 'player' && a.crouch && a.alive ? 0.25 : 0) + this.proneK * 0.2 + (a.alive ? a.jumpY : 0); g.obj.position.z = this.proneK * 0.8;
    if (g.gun) g.gun.visible = armed && a.alive && !a.down && !a.downed;
    if (this.op) { this.op.update(g, dt, { alive: a.alive, aim: !!a.target || a.ads || this.shootT > 0, armed }); this.gun.visible = false; }
    else if (this.rifle) { this.gun.visible = armed && a.alive; const G = (window as any).__gun; if (G) { this.gun.position.set(G.p[0], G.p[1], G.p[2]); this.gun.rotation.set(G.r[0], G.r[1], G.r[2]); this.gun.scale.setScalar(G.s); } }
    if (this.label) this.label.visible = a.alive;
    if (this.dropped) this.dropped.visible = !a.armed || !a.alive;
    if (!a.alive) {
      if (!this.pool) { const pm = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: T.bloodTex(), transparent: true, depthWrite: false, opacity: 0.92 })); pm.rotation.x = -Math.PI / 2; pm.rotation.z = a.id * 1.7; pm.position.set(0, 0.016 + (a.id % 7) * 0.0006, 0.5); this.root.add(pm); this.pool = pm; }
      this.poolT = Math.min(1, this.poolT + dt / 5); const e = 1 - (1 - this.poolT) * (1 - this.poolT); this.pool.scale.setScalar(0.35 + e * (1.25 + (a.id % 3) * 0.2));
    }
  }
  private kneelK = 0; private proneK = 0;
  /** Visible bullet wound on the clothes. */
  wound() {
    if (this.wounds >= 6) return; this.wounds++;
    if (this.rig) { // blood spots on the animated body: camera-facing sprites that follow the chest / belly bones
      const bone = this.rig.bones['Torso'] ?? this.rig.bones['Abdomen']; if (!bone) return;
      const ws = bone.getWorldScale(new THREE.Vector3()).x || 1, sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: T.bloodTex(), transparent: true, depthWrite: false }));
      // place it on the chest/back surface in world space, then attach to the bone so it follows the animation
      this.root.updateMatrixWorld(true); const yaw = this.root.rotation.y, fx = -Math.sin(yaw), fz = -Math.cos(yaw), side = (Math.random() - 0.5) * 0.24, out = (Math.random() < 0.7 ? 1 : -1) * 0.14;
      const wp = bone.getWorldPosition(new THREE.Vector3()); wp.x += fx * out - fz * side; wp.z += fz * out + fx * side; wp.y += Math.random() * 0.3;
      sp.position.copy(bone.worldToLocal(wp)); sp.scale.setScalar((0.11 + Math.random() * 0.07) / ws); bone.add(sp); return;
    }
    const m = new THREE.Mesh(new THREE.PlaneGeometry(0.1 + Math.random() * 0.08, 0.1 + Math.random() * 0.1), new THREE.MeshBasicMaterial({ map: T.bloodTex(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 }));
    const front = Math.random() < 0.7; m.position.set((Math.random() - 0.5) * 0.3, 0.2 + Math.random() * 0.36, front ? -0.156 : 0.156); if (front) m.rotation.y = Math.PI; this.torso.add(m);
  }
  update(dt: number, time: number) {
    const a = this.a, k = Math.min(1, dt * 12), r = this.root;
    if (a.kind === 'player') {
      if (this.playerShield) this.playerShield.visible = a.alive && !a.downed && a.shield;
      if (this.torchGlow) this.torchGlow.visible = a.alive && !a.downed && a.torch;
      if (this.playerTorch) {
        this.playerTorch.intensity = a.alive && !a.downed && a.torch ? 5.5 : 0;
        this.playerTorch.target.position.set(0.16, 1.28 + Math.sin(a.pitch) * 5, -6 * Math.cos(a.pitch));
      }
      if (this.label) {
        const st = a.downed ? `DOWN ${Math.ceil(a.bleedT)}s` : a.speaking ? `${a.name.slice(0, 7)} [MIC]` : a.readyBreach ? `${a.name.slice(0, 7)} [RDY]` : a.name.slice(0, 8);
        if (st !== this.labelState) {
          this.labelState = st;
          const mat = this.label.material as THREE.SpriteMaterial;
          mat.map?.dispose();
          mat.map = T.labelTex(st, a.downed ? '#ff4a4a' : a.speaking ? '#52e8ff' : a.readyBreach ? '#f2c14e' : '#4fd07a');
          mat.needsUpdate = true;
        }
        this.label.position.y = a.downed ? 1.15 : 2.04;
      }
    }
    if (a.kind === 'officer' && this.teamShown && a.team !== this.teamShown) {
      this.teamShown = a.team;
      const tcol = TEAM_COLOR[a.team];
      if (this.teamMat) { this.teamMat.color.setHex(tcol); this.teamMat.emissive.setHex(tcol); }
      if (this.label) {
        const mat = this.label.material as THREE.SpriteMaterial;
        mat.map?.dispose();
        mat.map = T.labelTex(a.name.slice(0, 7), '#' + tcol.toString(16));
        mat.needsUpdate = true;
      }
    }
    if (a.kind !== 'officer' && a.kind !== 'player' && a.name !== 'Suspect' && a.name !== 'Civilian' && a.name !== 'VIP Hostage' && !this.label) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: T.labelTex(a.name.slice(0, 10), '#f2c14e'), transparent: true, depthWrite: false }));
      sp.scale.set(0.46, 0.22, 1); sp.position.y = 2.05; this.root.add(sp); this.label = sp;
    }
    r.position.x = lerp(r.position.x, a.x, Math.min(1, dt * 25)); r.position.z = lerp(r.position.z, a.z, Math.min(1, dt * 25));
    let dy = a.yaw - r.rotation.y; dy = Math.atan2(Math.sin(dy), Math.cos(dy)); r.rotation.y += dy * Math.min(1, dt * 14);
    if (!this.rig && modelsReady) {
      this.rig = new Rig(a.kind, a.id); for (const l of this.legs) l.hip.visible = false; this.torso.visible = false;
      this.body.add(this.rig.obj); this.body.add(this.flash); this.flash.position.set(0.1, 1.28, -0.7);
      if (this.dropped) { this.root.remove(this.dropped); const d = droppedPistol(); d.position.set(0.4, 0.035, 0.15); d.rotation.y = a.id; d.visible = false; this.root.add(d); this.dropped = d; }
      const hand = this.rig.bones['WristR'];
      if (hand && (a.kind === 'officer' || a.kind === 'player')) { // officers carry the carbine instead of the model's pistol
        if (this.rig.gun) { this.rig.gun.visible = false; this.rig.gun = null; }
        const G = (window as any).__gun ?? GUNPOSE; this.gun.position.set(G.p[0], G.p[1], G.p[2]); this.gun.rotation.set(G.r[0], G.r[1], G.r[2]); this.gun.scale.setScalar(G.s); hand.add(this.gun); this.rifle = true;
        const real = weaponModel('rifle'); if (real) { this.gun.clear(); real.scale.setScalar(0.9); real.position.set(0, -0.03, -0.08); this.gun.add(real); }
      }
    }
    if (this.rig && !this.op && ActorView.detailed && operatorReady() && (a.kind === 'officer' || a.kind === 'player')) { // the same operator as in the menu
      this.op = new OperatorBody(); this.rig.obj.traverse((o: any) => { if (o.isMesh) o.visible = false; }); this.body.add(this.op.obj); this.flash.position.set(0.13, 1.45, -1.0);
    }
    if (this.rig) { this.updateRig(dt, time); return; }
    this.flashT -= dt; this.flash.visible = this.flashT > 0; if (this.flash.visible) this.flash.material.rotation = time * 50;
    // target pose
    let by = 0, lean = 0, hipL = 0, hipR = 0, kneeL = 0, kneeR = 0, aL = 0.05, aR = 0.05, eL = 0.1, eR = 0.1, zL = 0, zR = 0, headX = 0, gun = false;
    const armed = a.armed && a.kind !== 'civ';
    if (!a.alive) { this.fall = Math.min(1, this.fall + dt * 2.6); aL = 0.6; aR = -0.4; zL = -0.7; zR = 0.6; hipL = 0.3; kneeR = 0.5; }
    else if (a.downed) {
      by = -0.58; kneeL = kneeR = 1.57; lean = -0.35; headX = -0.2;
      aL = 0.5; aR = 0.4; eL = eR = 0.9; zL = 0.3; zR = -0.3;
    } else if (a.down) {
      by = -0.44; kneeL = kneeR = 1.57; lean = a.restrained ? 0.22 : 0.05; headX = a.restrained ? 0.45 : 0.1;
      if (a.restrained) { aL = aR = -0.55; eL = eR = 0.5; zL = 0.25; zR = -0.25; } else { aL = aR = 2.85 + Math.sin(time * 9 + a.id) * 0.03; zL = -0.3; zR = 0.3; eL = eR = 0.25; }
    } else if (a.stun > 0.3 && a.kind !== 'officer') { lean = 0.5; aL = aR = 2.3; eL = eR = 1.6; zL = 0.35; zR = -0.35; headX = 0.4; by = -0.05; hipL = 0.25; hipR = 0.25; kneeL = kneeR = 0.4; }
    else {
      if (a.moving) { const s = Math.sin(a.walk), c = Math.sin(a.walk + Math.PI); hipL = s * 0.65; hipR = c * 0.65; kneeL = Math.max(0, -s) * 0.9 + 0.1; kneeR = Math.max(0, -c) * 0.9 + 0.1; by = -Math.abs(Math.cos(a.walk)) * 0.03; }
      if (armed) { gun = true; const aim = a.target ? 1 : 0; aR = 1.05 + aim * 0.3; eR = 0.5 - aim * 0.3; zR = -0.25; aL = 1.15 + aim * 0.25; eL = 0.25; zL = 0.6; lean = 0.08 + aim * 0.06; }
      else if (a.moving) { aL = -hipL * 0.7; aR = -hipR * 0.7; }
      else if (a.kind === 'civ') { by = -0.12; lean = 0.25; aL = aR = 1.9; eL = eR = 1.9; zL = 0.3; zR = -0.3; hipL = hipR = 0.35; kneeL = kneeR = 0.55; headX = 0.3 + Math.sin(time * 14 + a.id) * 0.015; }
    }
    const b = this.body; b.position.y = lerp(b.position.y, by + this.fall * 0.14, k);
    const f = this.fall * this.fall * (3 - 2 * this.fall); b.rotation.x = f * (Math.PI / 2) * (a.id % 2 ? 1 : -1); b.rotation.z = f * ((a.id % 3) - 1) * 0.2;
    this.torso.rotation.x = lerp(this.torso.rotation.x, -lean, k); this.head.rotation.x = lerp(this.head.rotation.x, -headX + lean, k);
    const [L, R] = this.legs; L.hip.rotation.x = lerp(L.hip.rotation.x, hipL, k); R.hip.rotation.x = lerp(R.hip.rotation.x, hipR, k); L.knee.rotation.x = lerp(L.knee.rotation.x, -kneeL, k); R.knee.rotation.x = lerp(R.knee.rotation.x, -kneeR, k);
    const [AL, AR] = this.arms; AL.sh.rotation.x = lerp(AL.sh.rotation.x, aL, k); AR.sh.rotation.x = lerp(AR.sh.rotation.x, aR, k); AL.sh.rotation.z = lerp(AL.sh.rotation.z, zL, k); AR.sh.rotation.z = lerp(AR.sh.rotation.z, zR, k);
    AL.el.rotation.x = lerp(AL.el.rotation.x, eL, k); AR.el.rotation.x = lerp(AR.el.rotation.x, eR, k);
    this.gun.visible = gun || (armed && a.alive && !a.down); if (this.label) this.label.visible = a.alive;
    if (this.dropped) this.dropped.visible = !a.armed || !a.alive; // weapon lies on the floor after surrender or death
    if (!a.alive) {
      if (!this.pool) { const pm = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: T.bloodTex(), transparent: true, depthWrite: false, opacity: 0.92 })); pm.rotation.x = -Math.PI / 2; pm.rotation.z = a.id * 1.7; pm.position.set(0, 0.016 + (a.id % 7) * 0.0006, (a.id % 2 ? 1 : -1) * 0.25); this.root.add(pm); this.pool = pm; while (this.wounds < 2) this.wound(); }
      this.poolT = Math.min(1, this.poolT + dt / 5); const e = 1 - (1 - this.poolT) * (1 - this.poolT); this.pool.scale.setScalar(0.35 + e * (1.25 + (a.id % 3) * 0.2));
    }
  }
}

// ---------------- effects ----------------
const MAXP = 450;
function softPuffTex(inner: string, outer: string) {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const gr = g.createRadialGradient(32, 32, 2, 32, 32, 31);
  gr.addColorStop(0, inner); gr.addColorStop(0.5, outer); gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

export class FX {
  group = new THREE.Group(); private pos = new Float32Array(MAXP * 3); private col = new Float32Array(MAXP * 3); private vel = new Float32Array(MAXP * 3); private life = new Float32Array(MAXP); private grav = new Float32Array(MAXP);
  private pts: THREE.Points; private pi = 0; private tracers: { line: THREE.Line; t: number }[] = []; private ti = 0;
  private decals: THREE.Mesh[] = []; private di = 0;
  private debrisList: { m: THREE.Mesh; vx: number; vy: number; vz: number; rx: number; rz: number; settled: boolean }[] = []; private dbi = 0;
  private smokePuffs: { s: THREE.Sprite; vx: number; vy: number; vz: number; life: number; maxLife: number; baseScale: number }[] = []; private spi = 0;
  private cloudGroups: Map<object, { g: THREE.Group; puffs: { s: THREE.Sprite; ox: number; oy: number; oz: number; phase: number }[] }> = new Map();
  private smokeTex = softPuffTex('rgba(220,226,232,0.55)', 'rgba(170,180,192,0.26)');
  private gasTex = softPuffTex('rgba(190,225,110,0.55)', 'rgba(140,185,70,0.24)');
  private gunSmokeTex = softPuffTex('rgba(215,220,226,0.34)', 'rgba(160,168,176,0.12)');
  private shells: { m: THREE.Mesh; vx: number; vy: number; vz: number; rx: number; rz: number; life: number }[] = []; private shi = 0;
  private laserDot: THREE.Mesh;
  private irBeam: THREE.Line;
  light = new THREE.PointLight(0xffc070, 0, 12, 1.6); private lightT = 0; private markers: { m: THREE.Mesh; t: number }[] = [];
  private pings: { g: THREE.Group; ring: THREE.Mesh; sp: THREE.Sprite; t: number }[] = [];
  nades: THREE.Mesh[] = [];
  constructor() {
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3)); geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    this.pos.fill(-999); this.pts = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.05, vertexColors: true, transparent: true, depthWrite: false })); this.pts.frustumCulled = false; this.group.add(this.pts);

    // Surface-oriented bullet-hole decal pool
    const hc = document.createElement('canvas'); hc.width = hc.height = 64;
    const hctx = hc.getContext('2d')!;
    const hgrad = hctx.createRadialGradient(32, 32, 3, 32, 32, 28);
    hgrad.addColorStop(0, 'rgba(6,6,6,0.98)');
    hgrad.addColorStop(0.32, 'rgba(20,18,16,0.92)');
    hgrad.addColorStop(0.6, 'rgba(65,60,55,0.45)');
    hgrad.addColorStop(1, 'rgba(0,0,0,0)');
    hctx.fillStyle = hgrad; hctx.fillRect(0, 0, 64, 64);
    const holeTex = new THREE.CanvasTexture(hc);
    const decalGeo = new THREE.PlaneGeometry(0.08, 0.08);
    for (let i = 0; i < 160; i++) {
      const m = new THREE.Mesh(decalGeo, new THREE.MeshBasicMaterial({ map: holeTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3 }));
      m.visible = false;
      this.group.add(m);
      this.decals.push(m);
    }

    // Physical wood/glass floor debris pool
    const debGeo = new THREE.BoxGeometry(0.055, 0.012, 0.025);
    for (let i = 0; i < 110; i++) {
      const m = new THREE.Mesh(debGeo, new THREE.MeshStandardMaterial({ color: 0x9c6e42, roughness: 0.75, metalness: 0.08 }));
      m.visible = false;
      this.group.add(m);
      this.debrisList.push({ m, vx: 0, vy: 0, vz: 0, rx: 0, rz: 0, settled: false });
    }

    // Lingering gunsmoke puff sprites
    for (let i = 0; i < 36; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.gunSmokeTex, transparent: true, depthWrite: false, opacity: 0 }));
      s.visible = false;
      this.group.add(s);
      this.smokePuffs.push({ s, vx: 0, vy: 0, vz: 0, life: 0, maxLife: 1, baseScale: 0.2 });
    }

    for (let i = 0; i < 24; i++) { const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]); const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xffe2a0, transparent: true, opacity: 0.7 })); line.visible = false; line.frustumCulled = false; this.group.add(line); this.tracers.push({ line, t: 0 }); }
    const shellGeo = new THREE.CylinderGeometry(0.006, 0.006, 0.028, 6);
    for (let i = 0; i < 48; i++) {
      const m = new THREE.Mesh(shellGeo, new THREE.MeshStandardMaterial({ color: 0xd8a840, metalness: 0.85, roughness: 0.25 }));
      m.visible = false; this.group.add(m);
      this.shells.push({ m, vx: 0, vy: 0, vz: 0, rx: 0, rz: 0, life: 0 });
    }
    this.laserDot = new THREE.Mesh(
      new THREE.SphereGeometry(0.016, 8, 8),
      new THREE.MeshBasicMaterial({ color: 0xff2222, transparent: true, opacity: 0.92 }),
    );
    this.laserDot.visible = false; this.group.add(this.laserDot);
    const beamGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    this.irBeam = new THREE.Line(beamGeo, new THREE.LineBasicMaterial({ color: 0x64ff88, transparent: true, opacity: 0.42 }));
    this.irBeam.visible = false; this.irBeam.frustumCulled = false; this.group.add(this.irBeam);
    this.group.add(this.light);
    const ng = new THREE.CylinderGeometry(0.035, 0.035, 0.13, 8), nm = std({ color: 0x3a4a3a, metalness: 0.5, roughness: 0.4 });
    for (let i = 0; i < 4; i++) { const n = new THREE.Mesh(ng, nm); n.visible = false; this.group.add(n); this.nades.push(n); }
  }
  burst(x: number, y: number, z: number, n: number, color: number, speed: number, grav = 5, life = 0.5) {
    const c = new THREE.Color(color);
    for (let i = 0; i < n; i++) {
      const j = this.pi = (this.pi + 1) % MAXP; this.pos[j * 3] = x; this.pos[j * 3 + 1] = y; this.pos[j * 3 + 2] = z;
      const a = Math.random() * 6.28, u = Math.random() * 2 - 1, s = speed * (0.3 + Math.random()), q = Math.sqrt(1 - u * u);
      this.vel[j * 3] = Math.cos(a) * q * s; this.vel[j * 3 + 1] = Math.abs(u) * s; this.vel[j * 3 + 2] = Math.sin(a) * q * s;
      const k = 0.7 + Math.random() * 0.3; this.col[j * 3] = c.r * k; this.col[j * 3 + 1] = c.g * k; this.col[j * 3 + 2] = c.b * k; this.life[j] = life * (0.5 + Math.random()); this.grav[j] = grav;
    }
  }
  hole(x: number, y: number, z: number, nx = 0, ny = 1, nz = 0, mat: 'concrete' | 'wood' | 'glass' | 'metal' = 'concrete') {
    const m = this.decals[this.di = (this.di + 1) % this.decals.length];
    const len = Math.hypot(nx, ny, nz) || 1;
    const ux = nx / len, uy = ny / len, uz = nz / len;
    m.position.set(x + ux * 0.008, y + uy * 0.008, z + uz * 0.008);
    m.lookAt(x + ux * 2, y + uy * 2, z + uz * 2);
    m.rotateZ(Math.random() * Math.PI * 2);
    m.scale.setScalar(mat === 'wood' ? 1.15 : mat === 'metal' ? 0.75 : 1.0);
    (m.material as THREE.MeshBasicMaterial).color.setHex(mat === 'metal' ? 0xb8c2ce : mat === 'wood' ? 0x5c4028 : 0xffffff);
    m.visible = true;
  }
  debris(x: number, y: number, z: number, count: number, kind: 'wood' | 'glass' | 'concrete') {
    const col = kind === 'glass' ? 0x9cd6f0 : kind === 'wood' ? 0x8b5e36 : 0x7a7d82;
    for (let i = 0; i < count; i++) {
      const d = this.debrisList[this.dbi = (this.dbi + 1) % this.debrisList.length];
      d.m.position.set(x + (Math.random() - 0.5) * 0.25, Math.max(0.04, y + (Math.random() - 0.5) * 0.2), z + (Math.random() - 0.5) * 0.25);
      d.m.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
      d.m.scale.set(0.7 + Math.random() * 1.1, kind === 'glass' ? 0.4 : 0.9, 0.6 + Math.random() * 1.0);
      const dm = d.m.material as THREE.MeshStandardMaterial;
      dm.color.setHex(col);
      dm.roughness = kind === 'glass' ? 0.12 : 0.85;
      dm.metalness = kind === 'glass' ? 0.25 : 0.05;
      dm.transparent = kind === 'glass';
      dm.opacity = kind === 'glass' ? 0.68 : 1;
      d.m.visible = true;
      d.vx = (Math.random() - 0.5) * 2.8;
      d.vy = 0.8 + Math.random() * 2.2;
      d.vz = (Math.random() - 0.5) * 2.8;
      d.rx = (Math.random() - 0.5) * 18;
      d.rz = (Math.random() - 0.5) * 18;
      d.settled = false;
    }
  }
  gunsmoke(x: number, y: number, z: number, dx: number, dy: number, dz: number, count = 2) {
    for (let i = 0; i < count; i++) {
      const p = this.smokePuffs[this.spi = (this.spi + 1) % this.smokePuffs.length];
      p.s.position.set(x + dx * (0.1 + i * 0.08), y + dy * 0.1, z + dz * (0.1 + i * 0.08));
      p.vx = dx * (0.4 + Math.random() * 0.4) + (Math.random() - 0.5) * 0.22;
      p.vy = 0.18 + Math.random() * 0.22;
      p.vz = dz * (0.4 + Math.random() * 0.4) + (Math.random() - 0.5) * 0.22;
      p.maxLife = 0.85 + Math.random() * 0.65;
      p.life = p.maxLife;
      p.baseScale = 0.16 + Math.random() * 0.12;
      p.s.scale.setScalar(p.baseScale);
      (p.s.material as THREE.SpriteMaterial).opacity = 0.36;
      p.s.visible = true;
    }
  }
  shell(x: number, y: number, z: number, vx: number, vy: number, vz: number, color = 0xd8a840, hull = false) {
    const s = this.shells[this.shi = (this.shi + 1) % this.shells.length];
    s.m.position.set(x, y, z);
    s.m.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
    s.m.scale.setScalar(hull ? 1.55 : 1);
    (s.m.material as THREE.MeshStandardMaterial).color.setHex(color);
    s.m.visible = true;
    s.vx = vx; s.vy = vy; s.vz = vz;
    s.rx = (Math.random() - 0.5) * 28; s.rz = (Math.random() - 0.5) * 28;
    s.life = 5.5;
  }
  setLaser(on: boolean, x = 0, y = 0, z = 0, ox = 0, oy = 0, oz = 0, irBeam = false) {
    this.laserDot.visible = on;
    if (on) {
      this.laserDot.position.set(x, y, z);
      (this.laserDot.material as THREE.MeshBasicMaterial).color.setHex(irBeam ? 0x80ff98 : 0xff2222);
    }
    this.irBeam.visible = on && irBeam;
    if (this.irBeam.visible) {
      const p = this.irBeam.geometry.attributes.position as THREE.BufferAttribute;
      p.setXYZ(0, ox, oy, oz);
      p.setXYZ(1, x, y, z);
      p.needsUpdate = true;
    }
  }
  shieldHit(x: number, y: number, z: number) {
    this.burst(x, y, z, 14, 0xffd27a, 4.2, 6, 0.28);
    this.flashAt(x, y, z, 18, 0.05, 0xffd27a);
  }
  tracer(a: THREE.Vector3, b: THREE.Vector3, color = 0xffe2a0) {
    const t = this.tracers[this.ti = (this.ti + 1) % this.tracers.length];
    (t.line.material as THREE.LineBasicMaterial).color.setHex(color);
    const p = t.line.geometry.attributes.position as THREE.BufferAttribute; p.setXYZ(0, a.x, a.y, a.z); p.setXYZ(1, b.x, b.y, b.z); p.needsUpdate = true; t.line.visible = true; t.t = color === 0x50d8ff ? 0.14 : 0.06;
  }
  flashAt(x: number, y: number, z: number, intensity = 30, dur = 0.06, color = 0xffc070) { this.light.position.set(x, y, z); this.light.intensity = intensity; this.light.color.setHex(color); this.lightT = dur; }
  marker(x: number, z: number, color: number) {
    const m = new THREE.Mesh(new THREE.RingGeometry(0.32, 0.42, 28), new THREE.MeshBasicMaterial({ color, transparent: true, depthTest: false, side: THREE.DoubleSide })); m.rotation.x = -Math.PI / 2; m.position.set(x, 0.05, z); m.renderOrder = 5; this.group.add(m); this.markers.push({ m, t: 2.5 });
  }
  ping(x: number, y: number, z: number, color: number, label: string) {
    const g = new THREE.Group();
    g.position.set(x, Math.max(0.05, y), z);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.18, 0.28, 24), new THREE.MeshBasicMaterial({ color, transparent: true, depthTest: false, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2; ring.renderOrder = 8;
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 1.2, 8), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7, depthTest: false }));
    beam.position.y = 0.6; beam.renderOrder = 8;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: T.labelTex(label, '#' + color.toString(16).padStart(6, '0')), transparent: true, depthTest: false, depthWrite: false }));
    sp.scale.set(0.55, 0.24, 1); sp.position.y = 1.35; sp.renderOrder = 9;
    g.add(ring, beam, sp);
    this.group.add(g);
    this.pings.push({ g, ring, sp, t: 7.0 });
  }
  update(dt: number, sim: Sim) {
    for (let j = 0; j < MAXP; j++) {
      if (this.life[j] <= 0) continue; this.life[j] -= dt;
      if (this.life[j] <= 0) { this.pos[j * 3 + 1] = -999; continue; }
      this.vel[j * 3 + 1] -= this.grav[j] * dt; for (let k = 0; k < 3; k++) this.pos[j * 3 + k] += this.vel[j * 3 + k] * dt;
      if (this.pos[j * 3 + 1] < 0.02) { this.pos[j * 3 + 1] = 0.02; this.vel[j * 3] = this.vel[j * 3 + 2] = 0; }
    }
    this.pts.geometry.attributes.position.needsUpdate = true; this.pts.geometry.attributes.color.needsUpdate = true;
    for (const t of this.tracers) if (t.line.visible) { t.t -= dt; if (t.t <= 0) t.line.visible = false; }
    for (const d of this.debrisList) {
      if (!d.m.visible || d.settled) continue;
      d.vy -= 9.8 * dt;
      d.m.position.x += d.vx * dt; d.m.position.y += d.vy * dt; d.m.position.z += d.vz * dt;
      d.m.rotation.x += d.rx * dt; d.m.rotation.z += d.rz * dt;
      if (d.m.position.y <= 0.012) {
        d.m.position.y = 0.012;
        if (Math.abs(d.vy) > 0.5) { d.vy = -d.vy * 0.25; d.vx *= 0.4; d.vz *= 0.4; }
        else { d.settled = true; d.m.rotation.x = 0; d.m.rotation.z = 0; }
      }
    }
    for (const p of this.smokePuffs) {
      if (!p.s.visible) continue;
      p.life -= dt;
      if (p.life <= 0) { p.s.visible = false; continue; }
      p.s.position.x += p.vx * dt; p.s.position.y += p.vy * dt; p.s.position.z += p.vz * dt;
      const k = 1 - p.life / p.maxLife;
      p.s.scale.setScalar(p.baseScale * (1 + k * 2.6));
      (p.s.material as THREE.SpriteMaterial).opacity = 0.34 * (1 - k);
    }
    // Sync 3D volumetric smoke & CS tear gas clouds
    const activeSet = new Set<object>(sim.clouds);
    for (const [k, cg] of this.cloudGroups) {
      if (!activeSet.has(k)) { this.group.remove(cg.g); this.cloudGroups.delete(k); }
    }
    for (const cl of sim.clouds) {
      let cg = this.cloudGroups.get(cl);
      if (!cg) {
        const g = new THREE.Group();
        g.position.set(cl.x, 0, cl.z);
        const puffs: { s: THREE.Sprite; ox: number; oy: number; oz: number; phase: number }[] = [];
        const tex = cl.kind === 'gas' ? this.gasTex : this.smokeTex;
        for (let i = 0; i < 22; i++) {
          const ang = (i / 22) * Math.PI * 2 + (i % 3) * 0.4;
          const rad = (i % 4) * 0.85;
          const ox = Math.cos(ang) * rad, oz = Math.sin(ang) * rad, oy = 0.75 + (i % 3) * 0.58;
          const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.7 });
          const s = new THREE.Sprite(mat);
          s.position.set(ox, oy, oz);
          s.scale.setScalar(2.6 + (i % 3) * 0.75);
          g.add(s);
          puffs.push({ s, ox, oy, oz, phase: i * 0.7 });
        }
        this.group.add(g);
        cg = { g, puffs };
        this.cloudGroups.set(cl, cg);
      }
      const fadeIn = Math.min(1, (cl.maxT - cl.t) / 1.4);
      const fadeOut = Math.min(1, cl.t / 3.0);
      const env = fadeIn * fadeOut;
      for (const pf of cg.puffs) {
        const drift = sim.time * 0.9 + pf.phase;
        pf.s.position.set(
          pf.ox * (0.45 + 0.55 * fadeIn) + Math.sin(drift) * 0.22,
          pf.oy + Math.cos(drift * 0.8) * 0.14,
          pf.oz * (0.45 + 0.55 * fadeIn) + Math.cos(drift) * 0.22,
        );
        (pf.s.material as THREE.SpriteMaterial).opacity = (cl.kind === 'gas' ? 0.58 : 0.78) * env;
      }
    }

    for (const s of this.shells) {
      if (!s.m.visible) continue;
      s.life -= dt;
      if (s.life <= 0) { s.m.visible = false; continue; }
      if (s.m.position.y > 0.015 || s.vy > 0.05) {
        s.vy -= 9.8 * dt;
        s.m.position.x += s.vx * dt; s.m.position.y += s.vy * dt; s.m.position.z += s.vz * dt;
        s.m.rotation.x += s.rx * dt; s.m.rotation.z += s.rz * dt;
        if (s.m.position.y <= 0.015) {
          s.m.position.y = 0.015;
          if (Math.abs(s.vy) > 0.45) { s.vy = -s.vy * 0.35; s.vx *= 0.45; s.vz *= 0.45; s.rx *= 0.5; s.rz *= 0.5; }
          else { s.vy = s.vx = s.vz = 0; s.m.rotation.x = Math.PI / 2; }
        }
      }
    }
    this.lightT -= dt; if (this.lightT <= 0) this.light.intensity = 0;
    for (const m of this.markers) { m.t -= dt; (m.m.material as THREE.MeshBasicMaterial).opacity = Math.min(1, m.t); m.m.scale.setScalar(1 + Math.sin(m.t * 8) * 0.12); if (m.t <= 0) { this.group.remove(m.m); m.m.geometry.dispose(); } }
    this.markers = this.markers.filter(m => m.t > 0);
    for (const p of this.pings) {
      p.t -= dt;
      const op = Math.min(1, p.t * 0.8);
      p.ring.scale.setScalar(1 + Math.sin(p.t * 7) * 0.16);
      (p.ring.material as THREE.MeshBasicMaterial).opacity = op;
      (p.sp.material as THREE.SpriteMaterial).opacity = op;
      if (p.t <= 0) { this.group.remove(p.g); }
    }
    this.pings = this.pings.filter(p => p.t > 0);
    this.nades.forEach((n, i) => {
      const g = sim.grenades[i];
      n.visible = !!g;
      if (g) {
        n.position.set(g.x, g.y, g.z);
        n.rotation.x += dt * 9; n.rotation.z += dt * 6;
        (n.material as THREE.MeshStandardMaterial).color.setHex(g.kind === 'smoke' ? 0x62707a : g.kind === 'gas' ? 0xb59c24 : 0x3a4a3a);
      }
    });
  }
}

// ---------------- first-person weapon ----------------
export function makeViewModel() {
  const g = new THREE.Group(), gm = std({ color: 0x4a4f57, roughness: 0.5, metalness: 0.1 }), gm2 = std({ color: 0x666c75, roughness: 0.65, metalness: 0.05 }), glove = std({ color: 0x383c44 }), sleeve = std({ color: 0x34466a });
  const rifle = new THREE.Group(), pistol = new THREE.Group(), shotgun = new THREE.Group(), beanbag = new THREE.Group();
  rifle.add(box(0.055, 0.085, 0.36, gm, 0, 0, 0), box(0.05, 0.06, 0.3, gm2, 0, 0.005, -0.32), box(0.022, 0.022, 0.2, gm, 0, 0.01, -0.56), box(0.04, 0.045, 0.07, gm, 0, 0.01, -0.67),
    box(0.04, 0.15, 0.07, gm2, 0, -0.11, -0.06), box(0.04, 0.1, 0.05, gm, 0, -0.085, 0.11), box(0.045, 0.075, 0.24, gm2, 0, -0.01, 0.3), box(0.03, 0.035, 0.1, gm, 0, 0.065, -0.02), box(0.012, 0.04, 0.012, gm, 0, 0.06, -0.44), box(0.03, 0.03, 0.12, gm, 0, -0.045, -0.3));
  const dot = new THREE.Mesh(new THREE.CircleGeometry(0.004, 8), new THREE.MeshBasicMaterial({ color: 0xff3020 })); dot.position.set(0, 0.07, 0.031); rifle.add(dot);
  const hl = new THREE.Group(); hl.add(box(0.07, 0.07, 0.1, glove, 0, 0, 0), box(0.075, 0.075, 0.3, sleeve, 0.03, -0.03, 0.2)); hl.position.set(-0.01, -0.07, -0.3); hl.rotation.set(0.2, -0.5, 0); rifle.add(hl);
  const hr = new THREE.Group(); hr.add(box(0.07, 0.09, 0.08, glove, 0, 0, 0), box(0.08, 0.08, 0.3, sleeve, 0.02, -0.05, 0.19)); hr.position.set(0.005, -0.09, 0.11); rifle.add(hr);
  pistol.add(box(0.035, 0.05, 0.2, gm, 0, 0, -0.05), box(0.034, 0.12, 0.05, gm2, 0, -0.07, 0.02), box(0.07, 0.09, 0.09, glove, 0, -0.07, 0.03), box(0.08, 0.08, 0.3, sleeve, 0.02, -0.11, 0.2), box(0.07, 0.07, 0.09, glove, -0.04, -0.09, 0.03));
  pistol.children.slice(2).forEach(c => { c.userData.hand = true; });
  pistol.visible = false; shotgun.visible = false; beanbag.visible = false;
  g.add(rifle, pistol, shotgun, beanbag);
  const flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: T.glowTex(), blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, transparent: true })); flash.scale.setScalar(0.28); flash.position.set(0, 0.02, -0.78); flash.visible = false; g.add(flash);
  const shield = buildBallisticShield(true);
  shield.position.set(-0.18, -0.04, -0.45);
  shield.scale.setScalar(0.76);
  shield.visible = false; g.add(shield);
  return { group: g, rifle, pistol, shotgun, beanbag, flash, shield };
}
/** Swap the box weapons of the first-person view for the real models (hands and sleeves stay). */
export function upgradeViewModel(vm: ReturnType<typeof makeViewModel>) {
  const V = (window as any).__vm ?? { r: [0, 0, 0.11, 1], p: [0, -0.005, 0.03, 1.1], s: [0, -0.01, 0.08, 0.95] };
  for (const [grp, kind, keep] of [[vm.rifle, 'rifle', V.r], [vm.pistol, 'pistol', V.p], [vm.shotgun, 'shotgun', V.s], [vm.beanbag, 'beanbag', V.s]] as const) {
    const m = weaponModel(kind); if (!m) continue;
    for (const c of [...grp.children]) if ((c as THREE.Mesh).isMesh && !c.userData.hand) grp.remove(c);
    m.position.set(keep[0], keep[1], keep[2]); m.scale.setScalar(keep[3]); m.traverse(o => { o.castShadow = false; }); grp.add(m);
  }
  vm.flash.position.set(0, 0.03, -0.66);
}
