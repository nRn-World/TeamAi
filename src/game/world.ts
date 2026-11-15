// three.js presentation of the simulation: level geometry, characters, effects. All geometry is procedural.
import * as THREE from 'three';
import { Sim, Actor, Team } from '../sim/sim';
import { WALL, OUT, WINDOW, Door } from '../sim/level';
import * as T from './textures';
import { modelsReady, Rig, droppedPistol } from './models';
import { weaponModel } from './weapons';
import { OperatorBody, operatorReady } from './operator';
import { propsReady, onPropsReady, propModel, exteriorPlanterModel, exteriorTreeModel } from './props';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

const BOX = new THREE.BoxGeometry(1, 1, 1);
const std = (o: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0, ...o });
function box(w: number, h: number, d: number, m: THREE.Material, x = 0, y = 0, z = 0) { const b = new THREE.Mesh(BOX, m); b.scale.set(w, h, d); b.position.set(x, y, z); return b; }

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
  doors: { door: Door; pivot: THREE.Group; base: number; wedge: THREE.Mesh; lock: THREE.Mesh }[] = [];
  windows = new Map<number, THREE.Mesh>();
  private roomLights: { light: THREE.PointLight; baseInt: number }[] = [];
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
      new THREE.PlaneGeometry(l.w + 32, l.h + 32),
      std({ map: groundMap, roughness: plazaGround ? 0.24 : 0.34, metalness: plazaGround ? 0.36 : 0.25 }),
    );
    scaleUV(ground.geometry, (l.w + 32) / 3, (l.h + 32) / 3); ground.rotation.x = -Math.PI / 2; ground.position.set(l.w / 2, -0.012, l.h / 2); g.add(ground);
    // rooms: floor + ceiling + lamps
    const ceilMat = std({ map: T.floorTex('ceiling') });
    const lampOn = this.lampOnMat = new THREE.MeshBasicMaterial({ color: l.theme === 'club' ? 0xc864ff : 0xfff4dc });
    const lampOff = this.lampOffMat = std({ color: 0x3a3a38 });
    let lights = 0;
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
        if ((!dark || l.theme === 'club') && quality > 0 && lights < (quality > 1 ? 22 : 12)) {
          const col = l.theme === 'club' ? (i % 2 ? 0xff3ea5 : 0x3ea8ff) : r.kind === 'warehouse' ? 0xdfe8ff : 0xffe9c8;
          const baseInt = l.theme === 'club' ? 12 : r.kind === 'warehouse' ? 26 : 15;
          const pl = new THREE.PointLight(col, baseInt, 11, 1.7); pl.position.set(x, 2.55, z); g.add(pl);
          this.roomLights.push({ light: pl, baseInt });
          lights++;
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
    const glassMat = new THREE.MeshPhysicalMaterial({ color: 0xaad8ee, transparent: true, opacity: 0.3, roughness: 0.08, metalness: 0.15 });
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
    const glassDoorMat = new THREE.MeshPhysicalMaterial({ color: 0x99d0e8, transparent: true, opacity: 0.36, roughness: 0.08, metalness: 0.2 });
    const wedgeMat = std({ color: 0xf2a82e, roughness: 0.4 }), lockMat = std({ color: 0xe04848, emissive: 0x801010, emissiveIntensity: 0.6 });
    for (const d of l.doors) {
      const frontGlassDoor = (l.theme === 'office' || l.theme === 'hotel' || l.theme === 'bank') && (sim.cell(d.cx, d.cz + 1) === OUT || sim.cell(d.cx, d.cz - 1) === OUT);
      const lintel = box(1, 0.8, 1, frontGlassDoor ? frameAlum : wallMat, d.cx + 0.5, 2.6, d.cz + 0.5); g.add(lintel);
      const pivot = new THREE.Group();
      if (frontGlassDoor) {
        pivot.add(box(0.94, 2.18, 0.05, glassDoorMat, 0.47, 1.09, 0));
        pivot.add(box(0.96, 0.08, 0.07, frameMat, 0.47, 0.04, 0), box(0.96, 0.08, 0.07, frameMat, 0.47, 2.15, 0));
        pivot.add(box(0.06, 2.18, 0.07, frameMat, 0.03, 1.09, 0), box(0.06, 2.18, 0.07, frameMat, 0.91, 1.09, 0));
        pivot.add(box(0.03, 0.55, 0.14, std({ color: 0xd0d6de, metalness: 0.85, roughness: 0.2 }), 0.82, 1.05, 0));
      } else {
        const panel = box(0.94, 2.18, 0.06, doorMat, 0.47, 1.09, 0); pivot.add(panel);
        pivot.add(box(0.05, 0.05, 0.16, std({ color: 0xc9b46a, metalness: 0.7, roughness: 0.3 }), 0.84, 1.05, 0));
      }
      const lock = box(0.08, 0.06, 0.18, lockMat, 0.84, 1.15, 0); lock.visible = !!d.locked; pivot.add(lock);
      const wedge = box(0.22, 0.08, 0.2, wedgeMat, 0.72, 0.04, 0); wedge.visible = !!d.wedged; pivot.add(wedge);
      if (d.horiz) { pivot.position.set(d.cx + 0.03, 0, d.cz + 0.5); g.add(box(0.06, 2.2, 1.02, frameMat, d.cx + 0.0, 1.1, d.cz + 0.5), box(0.06, 2.2, 1.02, frameMat, d.cx + 1.0, 1.1, d.cz + 0.5)); }
      else { pivot.position.set(d.cx + 0.5, 0, d.cz + 0.03); g.add(box(1.02, 2.2, 0.06, frameMat, d.cx + 0.5, 1.1, d.cz + 0.0), box(1.02, 2.2, 0.06, frameMat, d.cx + 0.5, 1.1, d.cz + 1.0)); }
      const base = d.horiz ? 0 : -Math.PI / 2; pivot.rotation.y = base; g.add(pivot); this.doors.push({ door: d, pivot, base, wedge, lock });
    }
    // breaker box
    if (l.breaker) {
      const bm = std({ color: 0x3b444d, metalness: 0.5, roughness: 0.4 });
      const bg = new THREE.Group(); bg.position.set(l.breaker.x, 0, l.breaker.z);
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
      const o = new THREE.Group(); o.position.set(p.cx + 0.5, 0, p.cz + 0.5); const rj = ((p.cx * 13 + p.cz * 7) % 10) / 10;
      const seed = p.cx * 31 + p.cz * 17 + p.rot;
      const high = sim.cell(p.cx, p.cz) === 5;
      if (p.kind === 'server') {
        const rackFrame = std({ color: 0x16191f, metalness: 0.55, roughness: 0.42 });
        const grille = std({ color: 0x222832, metalness: 0.65, roughness: 0.38 });
        o.add(
          box(0.86, 2.15, 0.74, rackFrame, 0, 1.075, 0),
          box(0.76, 1.98, 0.76, grille, 0, 1.075, 0),
          box(0.66, 0.05, 0.77, new THREE.MeshBasicMaterial({ color: 0x2de080 }), 0, 1.72, 0),
          box(0.66, 0.05, 0.77, new THREE.MeshBasicMaterial({ color: 0x3ea8ff }), 0, 1.38, 0),
          box(0.66, 0.05, 0.77, new THREE.MeshBasicMaterial({ color: 0x2de080 }), 0, 1.04, 0),
        );
        o.rotation.y = (p.rot * Math.PI) / 2;
      } else {
        const buildFallback = () => {
          switch (p.kind) {
            case 'crate': { const a = box(0.94, 0.94, 0.94, crate, 0, 0.47, 0); a.rotation.y = (rj - 0.5) * 0.2; o.add(a); if (high) { const b = box(0.86, 0.86, 0.86, crate, (rj - 0.5) * 0.08, 0.94 + 0.43, 0); b.rotation.y = (rj - 0.5) * 0.5; o.add(b); if (rj > 0.5) o.add(box(0.7, 0.5, 0.7, crate, 0, 2.05, 0)); } break; }
            case 'desk': o.add(box(0.98, 0.05, 0.86, wood, 0, 0.76, 0), box(0.05, 0.74, 0.8, wood, -0.44, 0.37, 0), box(0.05, 0.74, 0.8, wood, 0.44, 0.37, 0), box(0.86, 0.4, 0.03, wood, 0, 0.5, -0.38));
              if (rj > 0.3) { o.add(box(0.42, 0.28, 0.03, dark, 0, 1.0, -0.15), box(0.06, 0.1, 0.06, dark, 0, 0.83, -0.15)); const scr = new THREE.Mesh(new THREE.PlaneGeometry(0.38, 0.24), new THREE.MeshBasicMaterial({ color: rj > 0.6 ? 0x2a4f7a : 0x0c1016 })); scr.position.set(0, 1.0, -0.133); o.add(scr); }
              break;
            case 'bar': o.add(box(0.98, 1.05, 0.6, dark, 0, 0.525, 0), box(1.0, 0.08, 0.68, std({ color: 0x722f8a, emissive: 0x3b124d, emissiveIntensity: 0.4 }), 0, 1.06, 0)); break;
            case 'shelf': o.add(box(0.96, 2.1, 0.5, shelf, 0, 1.05, 0)); break;
            case 'locker': o.add(box(0.92, 2.0, 0.6, locker, 0, 1.0, 0)); break;
            case 'bed': o.add(box(0.96, 0.3, 0.96, wood, 0, 0.15, 0), box(0.9, 0.2, 0.9, white, 0, 0.4, 0), box(0.6, 0.1, 0.3, white, 0, 0.55, -0.26)); break;
            case 'sofa': { const fm = std({ map: T.fabricTex('s' + (p.rot % 4), sofaCols[p.rot % 4]) }); o.add(box(0.96, 0.42, 0.9, fm, 0, 0.21, 0), box(0.96, 0.4, 0.2, fm, 0, 0.62, -0.36), box(0.14, 0.24, 0.9, fm, -0.41, 0.54, 0), box(0.14, 0.24, 0.9, fm, 0.41, 0.54, 0)); break; }
            case 'plant': { const c = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.16, 0.4, 10), pot); c.position.y = 0.2; o.add(c); for (let i = 0; i < 3; i++) { const s = new THREE.Mesh(new THREE.IcosahedronGeometry(0.26 - i * 0.05, 0), leaf); s.position.set((i - 1) * 0.08, 0.6 + i * 0.22, (rj - 0.5) * 0.1); s.rotation.set(i, rj * 6, i * 2); o.add(s); } break; }
          }
        };
        const fill = () => {
          const real = propModel(p.kind, seed, high);
          if (!real) return false;
          o.clear();
          o.add(real);
          return true;
        };
        if (p.kind === 'shelf') o.rotation.y = (p.rot % 2 ? Math.PI / 2 : 0);
        else if (p.kind !== 'crate' && p.kind !== 'plant') o.rotation.y = (p.rot * Math.PI) / 2;
        else if (p.kind === 'plant') o.rotation.y = rj * Math.PI * 2;
        if (!fill()) {
          buildFallback();
          this.propSlots.push(() => { fill(); });
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
    const granite = std({ color: 0x454a52, roughness: 0.68, metalness: 0.1 });
    const warmGlass = std({ color: 0x382818, emissive: 0x6b4218, emissiveIntensity: 0.78, roughness: 0.25, metalness: 0.35 });
    const darkGlass = std({ color: 0x0d1522, emissive: 0x091324, emissiveIntensity: 0.4, roughness: 0.15, metalness: 0.78 });
    const soffitMat = new THREE.MeshBasicMaterial({ color: 0xffe4b8 });
    const potMat = std({ color: 0x26292e, roughness: 0.85 });
    const shrubMat = std({ color: 0x264b2b, roughness: 0.9 });

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
    const addStreetLamp = (x: number, z: number, col = 0xffe0b2) => {
      g.add(box(0.12, 4.6, 0.12, darkSteel, x, 2.3, z), box(0.7, 0.08, 0.18, darkSteel, x + 0.3, 4.6, z));
      g.add(box(0.32, 0.04, 0.14, new THREE.MeshBasicMaterial({ color: col }), x + 0.5, 4.55, z));
      if (quality > 0) { const pl = new THREE.PointLight(col, 14, 14, 1.6); pl.position.set(x + 0.5, 4.3, z); g.add(pl); }
    };

    if (l.theme === 'office') {
      // Cylindrical portico pillars flanking glass entrance (x=14.5, z=20.5)
      for (const px of [12.5, 16.5]) {
        const col = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 3.1, 18), concrete);
        col.position.set(px, 1.55, 21.15); g.add(col);
      }
      // Portico flat canopy overhang + soffit downlights + EXIT sign
      g.add(box(10.6, 0.24, 2.4, darkSteel, 15.0, 3.18, 21.1));
      for (const lx of [11.2, 13.0, 14.5, 16.0, 17.8, 19.3]) {
        const d = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.03, 12), soffitMat);
        d.position.set(lx, 3.05, 21.3); g.add(d);
      }
      if (quality > 0) {
        for (const lx of [12.4, 14.5, 16.6]) {
          const pl = new THREE.PointLight(0xffdfb0, 16, 11, 1.5); pl.position.set(lx, 2.95, 21.35); g.add(pl);
        }
      }
      addSign('EXIT', '#093818', '#52ff88', '#34e86a', 0.9, 0.3, 14.5, 2.52, 20.02);
      // Bollards + entrance planters & courtyard trees
      for (const bx of [10.4, 11.7, 12.8, 16.2]) addBollard(bx, 22.85);
      addShrub(10.5, 21.3); addShrub(17.4, 21.3);
      addTree(8.5, 22.0, 1.55); addTree(27.0, 22.2, 1.55);

      // 2nd Floor Warm-Lit Glass Curtain-Wall Offices (y=3.2..6.5) matching image-3.png
      g.add(box(24.4, 0.35, 18.2, darkSteel, 16.0, 3.28, 11.9));
      g.add(box(24.2, 3.1, 0.18, warmGlass, 16.0, 4.95, 20.38));
      // Silhouetted 2nd-floor office furniture & pendant lights behind the warm glass
      for (let fx = 6.5; fx <= 25.5; fx += 3.2) {
        g.add(box(1.5, 0.72, 0.7, darkSteel, fx, 3.82, 19.8));
        g.add(box(0.5, 0.95, 0.5, darkSteel, fx, 3.95, 19.15));
        const pnd = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.22, 12), soffitMat);
        pnd.position.set(fx, 5.75, 19.85); g.add(pnd);
      }
      for (let mx = 4.0; mx <= 28.0; mx += 2.0) g.add(box(0.11, 3.25, 0.26, darkSteel, mx, 4.95, 20.42));
      g.add(box(24.4, 0.42, 18.2, darkSteel, 16.0, 6.65, 11.9));
      // 3rd–5th Floor Corporate Dark Glass Tower (y=6.8..16.5)
      g.add(box(24.2, 9.6, 18.0, darkGlass, 16.0, 11.6, 11.9));
      for (const fy of [9.8, 13.0, 16.3]) g.add(box(24.4, 0.24, 18.2, darkSteel, 16.0, fy, 11.9));
      for (let mx = 4.0; mx <= 28.0; mx += 2.0) g.add(box(0.1, 9.6, 0.2, darkSteel, mx, 11.6, 20.92));
      // Scattered warm upper-floor office glow strips
      for (const [wx, wy] of [[9.0, 8.3], [19.0, 8.3], [15.0, 11.4], [23.0, 14.6]]) {
        g.add(box(3.4, 1.4, 0.06, warmGlass, wx, wy, 20.95));
      }

      // Neighboring Curved Glass Skyscraper with Glowing Blue LED Floor Bands on the right
      const skyX = 39.5, skyZ = 10.5;
      const tower = new THREE.Mesh(new THREE.CylinderGeometry(6.2, 6.2, 24, 24), darkGlass);
      tower.position.set(skyX, 12, skyZ); g.add(tower);
      const ledMat = new THREE.MeshBasicMaterial({ color: 0x2ca2ff });
      for (let ly = 3.5; ly <= 22.5; ly += 3.1) {
        const ring = new THREE.Mesh(new THREE.CylinderGeometry(6.26, 6.26, 0.14, 24), ledMat);
        ring.position.set(skyX, ly, skyZ); g.add(ring);
      }
      addStreetLamp(6.5, 25.4, 0xd8e8ff);
      addStreetLamp(27.5, 25.4, 0xd8e8ff);
    } else if (l.theme === 'warehouse') {
      const steelSiding = std({ color: 0x3b424b, roughness: 0.55, metalness: 0.5 });
      const haz = std({ color: 0xc2921e, roughness: 0.6 });
      g.add(box(35.4, 4.2, 20.2, steelSiding, 21.5, 5.2, 13.9));
      g.add(box(35.6, 0.35, 20.4, darkSteel, 21.5, 7.35, 13.9));
      g.add(box(5.6, 0.25, 1.6, darkSteel, 16.5, 3.18, 23.8), box(5.6, 0.1, 0.12, haz, 16.5, 3.05, 24.55));
      addSign('WAREHOUSE 04', '#161a1e', '#f0c050', '#c89020', 2.6, 0.48, 16.5, 2.75, 23.02);
      if (quality > 0) { const pl = new THREE.PointLight(0xffb454, 18, 13, 1.5); pl.position.set(16.5, 2.95, 24.1); g.add(pl); }
      // Stacked shipping containers in the dockyard
      const cont = (x: number, y: number, z: number, col: number, ry = 0) => {
        const c = box(5.8, 2.5, 2.4, std({ color: col, roughness: 0.62, metalness: 0.45 }), x, y, z);
        c.rotation.y = ry; g.add(c);
      };
      cont(7.2, 1.25, 27.6, 0x6b2e26, 0.08); cont(7.2, 3.75, 27.6, 0x2b4554, -0.04);
      cont(31.2, 1.25, 28.0, 0x2b4554, -0.14);
      // Dockside harbor cranes in the background
      for (const cx of [-2.5, 37.5]) {
        g.add(box(1.1, 16, 1.1, darkSteel, cx, 8, -2), box(1.1, 16, 1.1, darkSteel, cx + 3.2, 8, -2));
        g.add(box(14, 0.9, 1.2, haz, cx + 4, 15.5, -2));
        if (quality > 0) { const pl = new THREE.PointLight(0xffa64d, 24, 24, 1.4); pl.position.set(cx + 4, 14.5, -1); g.add(pl); }
      }
    } else if (l.theme === 'hotel') {
      const stone = std({ color: 0x3b3530, roughness: 0.65 });
      const brass = std({ color: 0xc29848, roughness: 0.3, metalness: 0.8 });
      // Wide marble plaza entry runner + brass columns + coffered gold canopy
      g.add(box(7.2, 0.08, 3.2, std({ color: 0x9b948a, roughness: 0.32, metalness: 0.15 }), 22.5, 0.03, 25.5));
      for (const px of [20.4, 24.6]) {
        const c = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.36, 3.3, 16), brass);
        c.position.set(px, 1.65, 25.4); g.add(c);
      }
      g.add(box(11.4, 0.35, 3.0, darkSteel, 22.5, 3.4, 25.3));
      addSign('HOTEL NORTH STAR', '#1c1510', '#ffd480', '#e0a238', 3.8, 0.54, 22.5, 3.42, 26.82);
      if (quality > 0) {
        for (const lx of [20.5, 22.5, 24.5]) { const pl = new THREE.PointLight(0xffcf88, 18, 12, 1.5); pl.position.set(lx, 3.1, 25.6); g.add(pl); }
      }
      addShrub(18.6, 25.5); addShrub(26.4, 25.5);
      addTree(16.2, 25.8, 1.65); addTree(36.6, 26.2, 1.65);
      // 5-Story Limestone & Lit Guest-Window Hotel Tower
      g.add(box(38.2, 14.2, 21.2, stone, 23.0, 10.3, 14.4));
      for (let fy = 5.0; fy <= 14.5; fy += 3.1) {
        g.add(box(38.4, 0.16, 21.4, brass, 23.0, fy - 1.4, 14.4));
        for (let wx = 7.0; wx <= 39.0; wx += 4.0) {
          const lit = ((wx + fy) % 3) !== 0;
          g.add(box(1.8, 1.4, 0.12, lit ? warmGlass : darkGlass, wx, fy, 25.02));
        }
      }
    } else if (l.theme === 'bank') {
      const limestone = std({ color: 0x767a82, roughness: 0.62 });
      // Classical steps + 4 monumental fluted columns + entablature + triangular pediment
      g.add(box(14.0, 0.12, 3.6, limestone, 15.5, 0.05, 25.8));
      for (const cx of [11.2, 13.4, 17.6, 19.8]) {
        const col = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.46, 6.4, 16), limestone);
        col.position.set(cx, 3.2, 25.6); g.add(col);
      }
      g.add(box(12.2, 1.1, 2.8, limestone, 15.5, 6.95, 25.1));
      addSign('NORDIA BANK', '#141a22', '#e8edf2', '#8eb6e0', 4.0, 0.56, 15.5, 6.95, 26.52);
      const ped = new THREE.Mesh(new THREE.ConeGeometry(6.4, 2.2, 3), limestone);
      ped.rotation.y = Math.PI / 6; ped.scale.set(1.0, 1.0, 0.35); ped.position.set(15.5, 8.6, 25.1); g.add(ped);
      // 2nd story granite bank wing + security bollards
      g.add(box(36.2, 4.4, 21.2, granite, 22.0, 5.4, 14.4));
      for (let wx = 7.5; wx <= 37.5; wx += 4.2) g.add(box(1.5, 2.1, 0.12, warmGlass, wx, 5.2, 25.02));
      for (const bx of [9.6, 11.2, 12.8, 18.2, 19.8]) addBollard(bx, 27.1);
      addShrub(12.3, 25.7); addShrub(18.7, 25.7);
      addTree(7.8, 26.2, 1.6); addTree(30.8, 26.2, 1.6);
      if (quality > 0) {
        for (const lx of [12.5, 15.5, 18.5]) { const pl = new THREE.PointLight(0xffdfb8, 18, 12, 1.5); pl.position.set(lx, 5.8, 25.8); g.add(pl); }
      }
    } else if (l.theme === 'club') {
      const brick = std({ map: T.brickTex('club_ext', '#261e2a', '#1b1520') });
      // Narrow brick alley framing + 2nd floor brick club facade + glowing ECLIPSE neon sign
      g.add(box(32.2, 4.4, 21.2, brick, 20.0, 5.4, 13.4));
      g.add(box(1.2, 6.5, 6.0, brick, 5.5, 3.25, 26.8), box(1.2, 6.5, 6.0, brick, 24.0, 3.25, 26.8));
      addSign('ECLIPSE', '#12061c', '#ff52e0', '#d438ff', 3.4, 0.72, 13.5, 3.25, 24.06);
      addShrub(7.6, 24.6); addShrub(15.2, 24.6);
      // Magenta & cyan alley sconces
      for (const [sx, sz, col] of [[6.15, 25.5, 0xd438ff], [6.15, 28.0, 0x38c8ff], [23.35, 25.5, 0x38c8ff], [23.35, 28.0, 0xd438ff]] as const) {
        g.add(box(0.14, 0.45, 0.2, new THREE.MeshBasicMaterial({ color: col }), sx, 2.3, sz));
        if (quality > 0) { const pl = new THREE.PointLight(col, 14, 10, 1.6); pl.position.set(sx + (sx < 13 ? 0.5 : -0.5), 2.3, sz); g.add(pl); }
      }
      // Mirror disco ball & animated laser beams inside the dancefloor
      const ballGrp = new THREE.Group(); ballGrp.position.set(14.0, 2.62, 16.5);
      const ball = new THREE.Mesh(new THREE.IcosahedronGeometry(0.34, 1), std({ color: 0xe6eeff, metalness: 0.95, roughness: 0.08, emissive: 0x384460 }));
      ballGrp.add(ball); g.add(ballGrp); this.discoBall = ballGrp;
      for (let i = 0; i < 6; i++) {
        const beam = new THREE.Mesh(
          new THREE.CylinderGeometry(0.015, 0.06, 9.5, 6),
          new THREE.MeshBasicMaterial({ color: i % 2 ? 0xff38c8 : 0x38d8ff, transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending, depthWrite: false }),
        );
        beam.position.set(14.0 + (i - 2.5) * 1.4, 2.4, 17.5);
        beam.rotation.set(0.7, 0, (i - 2.5) * 0.25);
        g.add(beam); this.lasers.push(beam);
      }
    } else if (l.theme === 'raid') {
      const sx = l.playerSpawn.x, sz = l.playerSpawn.z;
      const conc = std({ color: 0x4b4e54, roughness: 0.85 });
      const meshMat = std({ color: 0x7a828c, metalness: 0.6, roughness: 0.45, wireframe: true });
      // Upper compound roof & yard floodlight towers + perimeter security fence with open entry gate
      g.add(box(32.2, 3.2, 20.4, conc, 20.0, 4.8, 13.0));
      const fz = sz - 1.5;
      for (let fx = 3.0; fx <= 37.0; fx += 2.0) {
        if (Math.abs(fx - sx) < 2.6) continue; // open gate gap
        g.add(box(0.1, 2.3, 0.1, darkSteel, fx, 1.15, fz));
        g.add(box(2.0, 2.1, 0.04, meshMat, fx, 1.1, fz));
      }
      // Tall yard security floodlight towers
      for (const tx of [5.0, 36.2]) {
        g.add(box(0.22, 7.5, 0.22, darkSteel, tx, 3.75, fz + 0.3));
        g.add(box(0.9, 0.3, 0.2, soffitMat, tx, 7.4, fz + 0.3));
        if (quality > 0) { const pl = new THREE.PointLight(0xdfe8ff, 26, 22, 1.4); pl.position.set(tx, 7.1, fz + 0.6); g.add(pl); }
      }
      addTree(4.5, fz + 1.4, 1.5); addTree(36.6, fz + 1.4, 1.5);
    }
    if (l.vehicle) {
      this.readyPromise = this.spawnPoliceUnit(l.vehicle.x, l.vehicle.z, l.vehicle.yaw, quality);
    }
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
  update(dt = 0.016, time = 0) {
    for (const d of this.doors) {
      d.pivot.rotation.y = d.base + d.door.open * 1.62;
      d.lock.visible = !!d.door.locked;
      d.wedge.visible = !!d.door.wedged;
    }
    for (const [k, m] of this.windows) {
      if (this.sim.brokenWindows.has(k) && m.visible) m.visible = false;
    }
    if (this.sim.powerOn !== this.lastPower) {
      this.lastPower = this.sim.powerOn;
      for (const rl of this.roomLights) rl.light.intensity = this.lastPower ? rl.baseInt : 0;
      for (const lm of this.lampMeshes) lm.material = this.lastPower ? this.lampOnMat : this.lampOffMat;
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
  constructor(public a: Actor) {
    const v = a.variant, off = a.kind === 'officer' || a.kind === 'player', tcol = a.kind === 'player' ? 0x4fd07a : TEAM_COLOR[a.team];
    const cloth = std({ color: off ? 0x1b2434 : a.kind === 'suspect' ? HOOD[v] : SHIRT[v] });
    const pants = std({ color: off ? 0x161d2a : a.kind === 'suspect' ? 0x24303f : [0x2b2b33, 0x3a3f4a, 0x4a3a2a][v % 3] });
    const skin = std({ color: SKIN[(v + a.id) % 6], roughness: 0.7 }), black = std({ color: 0x0e1014, roughness: 0.6 }), boot = std({ color: 0x15130f });
    const tc = off ? std({ color: tcol, emissive: tcol, emissiveIntensity: 0.35 }) : null;
    if (a.kind === 'officer' && tc) { this.teamMat = tc; this.teamShown = a.team; }
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
    const kneel = a.alive && a.down;
    if (!a.alive) g.play('Death', 0.1, true);
    else if (kneel) g.play('Idle', 0.25);
    else if (a.stun > 0.3 && a.kind !== 'officer' && a.kind !== 'player') g.play('HitRecieve', 0.1, false, 0.8);
    else if (a.moving) { if (armed) g.play(a.target || this.shootT > 0 ? 'Run_Shoot' : 'Run', 0.15, false, a.kind === 'suspect' ? 0.9 : 1.1); else g.play(a.kind === 'civ' ? 'Run' : 'Walk', 0.15); }
    else if (armed) g.play(this.shootT > 0 ? 'Idle_Gun_Shoot' : a.target ? 'Idle_Gun_Pointing' : 'Idle_Gun', 0.12);
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
    this.proneK = lerp(this.proneK, a.alive && a.prone ? 1 : 0, Math.min(1, dt * 7));
    g.obj.rotation.x = -this.proneK * Math.PI / 2; // crawling: lying face down
    g.obj.position.y = -P_DROP() * this.kneelK - (a.kind === 'player' && a.crouch && a.alive ? 0.25 : 0) + this.proneK * 0.2 + (a.alive ? a.jumpY : 0); g.obj.position.z = this.proneK * 0.8;
    if (g.gun) g.gun.visible = armed && a.alive && !a.down;
    if (this.op) { this.op.update(g, dt, { alive: a.alive, aim: !!a.target || this.shootT > 0, armed }); this.gun.visible = false; }
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
    else if (a.down) {
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
const MAXP = 400;
export class FX {
  group = new THREE.Group(); private pos = new Float32Array(MAXP * 3); private col = new Float32Array(MAXP * 3); private vel = new Float32Array(MAXP * 3); private life = new Float32Array(MAXP); private grav = new Float32Array(MAXP);
  private pts: THREE.Points; private pi = 0; private tracers: { line: THREE.Line; t: number }[] = []; private ti = 0;
  private holes: THREE.Points; private hpos = new Float32Array(200 * 3); private hi = 0;
  light = new THREE.PointLight(0xffc070, 0, 12, 1.6); private lightT = 0; private markers: { m: THREE.Mesh; t: number }[] = []; nades: THREE.Mesh[] = [];
  constructor() {
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3)); geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    this.pos.fill(-999); this.pts = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.05, vertexColors: true, transparent: true, depthWrite: false })); this.pts.frustumCulled = false; this.group.add(this.pts);
    const hg = new THREE.BufferGeometry(); this.hpos.fill(-999); hg.setAttribute('position', new THREE.BufferAttribute(this.hpos, 3));
    this.holes = new THREE.Points(hg, new THREE.PointsMaterial({ size: 0.07, color: 0x070707 })); this.holes.frustumCulled = false; this.group.add(this.holes);
    for (let i = 0; i < 24; i++) { const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]); const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xffe2a0, transparent: true, opacity: 0.7 })); line.visible = false; line.frustumCulled = false; this.group.add(line); this.tracers.push({ line, t: 0 }); }
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
  hole(x: number, y: number, z: number) { const j = this.hi = (this.hi + 1) % 200; this.hpos[j * 3] = x; this.hpos[j * 3 + 1] = y; this.hpos[j * 3 + 2] = z; this.holes.geometry.attributes.position.needsUpdate = true; }
  tracer(a: THREE.Vector3, b: THREE.Vector3, color = 0xffe2a0) {
    const t = this.tracers[this.ti = (this.ti + 1) % this.tracers.length];
    (t.line.material as THREE.LineBasicMaterial).color.setHex(color);
    const p = t.line.geometry.attributes.position as THREE.BufferAttribute; p.setXYZ(0, a.x, a.y, a.z); p.setXYZ(1, b.x, b.y, b.z); p.needsUpdate = true; t.line.visible = true; t.t = color === 0x50d8ff ? 0.14 : 0.06;
  }
  flashAt(x: number, y: number, z: number, intensity = 30, dur = 0.06, color = 0xffc070) { this.light.position.set(x, y, z); this.light.intensity = intensity; this.light.color.setHex(color); this.lightT = dur; }
  marker(x: number, z: number, color: number) {
    const m = new THREE.Mesh(new THREE.RingGeometry(0.32, 0.42, 28), new THREE.MeshBasicMaterial({ color, transparent: true, depthTest: false, side: THREE.DoubleSide })); m.rotation.x = -Math.PI / 2; m.position.set(x, 0.05, z); m.renderOrder = 5; this.group.add(m); this.markers.push({ m, t: 2.5 });
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
    this.lightT -= dt; if (this.lightT <= 0) this.light.intensity = 0;
    for (const m of this.markers) { m.t -= dt; (m.m.material as THREE.MeshBasicMaterial).opacity = Math.min(1, m.t); m.m.scale.setScalar(1 + Math.sin(m.t * 8) * 0.12); if (m.t <= 0) { this.group.remove(m.m); m.m.geometry.dispose(); } }
    this.markers = this.markers.filter(m => m.t > 0);
    this.nades.forEach((n, i) => { const g = sim.grenades[i]; n.visible = !!g; if (g) { n.position.set(g.x, g.y, g.z); n.rotation.x += dt * 9; n.rotation.z += dt * 6; } });
  }
}

// ---------------- first-person weapon ----------------
export function makeViewModel() {
  const g = new THREE.Group(), gm = std({ color: 0x4a4f57, roughness: 0.5, metalness: 0.1 }), gm2 = std({ color: 0x666c75, roughness: 0.65, metalness: 0.05 }), glove = std({ color: 0x383c44 }), sleeve = std({ color: 0x34466a });
  const rifle = new THREE.Group(), pistol = new THREE.Group();
  rifle.add(box(0.055, 0.085, 0.36, gm, 0, 0, 0), box(0.05, 0.06, 0.3, gm2, 0, 0.005, -0.32), box(0.022, 0.022, 0.2, gm, 0, 0.01, -0.56), box(0.04, 0.045, 0.07, gm, 0, 0.01, -0.67),
    box(0.04, 0.15, 0.07, gm2, 0, -0.11, -0.06), box(0.04, 0.1, 0.05, gm, 0, -0.085, 0.11), box(0.045, 0.075, 0.24, gm2, 0, -0.01, 0.3), box(0.03, 0.035, 0.1, gm, 0, 0.065, -0.02), box(0.012, 0.04, 0.012, gm, 0, 0.06, -0.44), box(0.03, 0.03, 0.12, gm, 0, -0.045, -0.3));
  const dot = new THREE.Mesh(new THREE.CircleGeometry(0.004, 8), new THREE.MeshBasicMaterial({ color: 0xff3020 })); dot.position.set(0, 0.07, 0.031); rifle.add(dot);
  const hl = new THREE.Group(); hl.add(box(0.07, 0.07, 0.1, glove, 0, 0, 0), box(0.075, 0.075, 0.3, sleeve, 0.03, -0.03, 0.2)); hl.position.set(-0.01, -0.07, -0.3); hl.rotation.set(0.2, -0.5, 0); rifle.add(hl);
  const hr = new THREE.Group(); hr.add(box(0.07, 0.09, 0.08, glove, 0, 0, 0), box(0.08, 0.08, 0.3, sleeve, 0.02, -0.05, 0.19)); hr.position.set(0.005, -0.09, 0.11); rifle.add(hr);
  pistol.add(box(0.035, 0.05, 0.2, gm, 0, 0, -0.05), box(0.034, 0.12, 0.05, gm2, 0, -0.07, 0.02), box(0.07, 0.09, 0.09, glove, 0, -0.07, 0.03), box(0.08, 0.08, 0.3, sleeve, 0.02, -0.11, 0.2), box(0.07, 0.07, 0.09, glove, -0.04, -0.09, 0.03));
  pistol.children.slice(2).forEach(c => { c.userData.hand = true; });
  pistol.visible = false; g.add(rifle, pistol);
  const flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: T.glowTex(), blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, transparent: true })); flash.scale.setScalar(0.28); flash.position.set(0, 0.02, -0.78); flash.visible = false; g.add(flash);
  const shield = new THREE.Group();
  shield.add(
    box(0.36, 0.52, 0.025, std({ color: 0x14181f, metalness: 0.4, roughness: 0.5 }), -0.18, -0.02, -0.45),
    box(0.22, 0.1, 0.03, new THREE.MeshPhysicalMaterial({ color: 0x99d0e8, transparent: true, opacity: 0.35, roughness: 0.1 }), -0.18, 0.12, -0.45),
  );
  shield.visible = false; g.add(shield);
  return { group: g, rifle, pistol, flash, shield };
}
/** Swap the box weapons of the first-person view for the real models (hands and sleeves stay). */
export function upgradeViewModel(vm: ReturnType<typeof makeViewModel>) {
  const V = (window as any).__vm ?? { r: [0, 0, 0.11, 1], p: [0, -0.005, 0.03, 1.1] };
  for (const [grp, kind, keep] of [[vm.rifle, 'rifle', V.r], [vm.pistol, 'pistol', V.p]] as const) {
    const m = weaponModel(kind); if (!m) continue;
    for (const c of [...grp.children]) if ((c as THREE.Mesh).isMesh && !c.userData.hand) grp.remove(c);
    m.position.set(keep[0], keep[1], keep[2]); m.scale.setScalar(keep[3]); m.traverse(o => { o.castShadow = false; }); grp.add(m);
  }
  vm.flash.position.set(0, 0.03, -0.66);
}
