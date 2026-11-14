// three.js presentation of the simulation: level geometry, characters, effects. All geometry is procedural.
import * as THREE from 'three';
import { Sim, Actor } from '../sim/sim';
import { WALL, OUT, Door } from '../sim/level';
import * as T from './textures';
import { modelsReady, Rig } from './models';

const BOX = new THREE.BoxGeometry(1, 1, 1);
const std = (o: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0, ...o });
function box(w: number, h: number, d: number, m: THREE.Material, x = 0, y = 0, z = 0) { const b = new THREE.Mesh(BOX, m); b.scale.set(w, h, d); b.position.set(x, y, z); return b; }

const THEME = {
  office: { wall: '#c9c3b6', trim: '#4a443c', brickA: '#8e5a48', brickB: '#7c4c3d', fog: 0x0b0e12 },
  warehouse: { wall: '#8b9095', trim: '#33373b', brickA: '#6f7377', brickB: '#62666a', fog: 0x090b0d },
  hotel: { wall: '#bfa58e', trim: '#4d2e24', brickA: '#9a7a5c', brickB: '#8a6c50', fog: 0x0d0b0a },
};

export class LevelView {
  group = new THREE.Group(); doors: { door: Door; pivot: THREE.Group; base: number }[] = [];
  constructor(public sim: Sim, quality: number) {
    const l = sim.level, th = THEME[l.theme], g = this.group;
    // ground
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(l.w, l.h), std({ map: T.floorTex('asphalt') }));
    scaleUV(ground.geometry, l.w / 3, l.h / 3); ground.rotation.x = -Math.PI / 2; ground.position.set(l.w / 2, -0.012, l.h / 2); g.add(ground);
    // rooms: floor + ceiling + lamps
    const ceilMat = std({ map: T.floorTex('ceiling') }), lampOn = new THREE.MeshBasicMaterial({ color: 0xfff4dc }), lampOff = std({ color: 0x3a3a38 });
    let lights = 0;
    for (const r of l.rooms) {
      const fl = new THREE.Mesh(new THREE.PlaneGeometry(r.w, r.h), std({ map: T.floorTex(r.floor), roughness: r.floor === 'tile' ? 0.45 : 0.95 }));
      scaleUV(fl.geometry, r.w / 2, r.h / 2); fl.rotation.x = -Math.PI / 2; fl.position.set(r.x + r.w / 2, r.id * 0.0006, r.z + r.h / 2); g.add(fl);
      const ce = new THREE.Mesh(new THREE.PlaneGeometry(r.w, r.h), ceilMat.clone()); (ce.material as THREE.MeshStandardMaterial).map = T.floorTex('ceiling');
      scaleUV(ce.geometry, r.w / 2, r.h / 2); ce.rotation.x = Math.PI / 2; ce.position.set(r.x + r.w / 2, 3 - r.id * 0.0006, r.z + r.h / 2); g.add(ce);
      const dark = r.kind !== 'corridor' && r.kind !== 'lobby' && ((r.id * 7 + sim.mission * 3 + Math.floor(l.suspects[0]?.x ?? 0)) % 4 === 0);
      const nx = Math.max(1, Math.round((r.w - 2) / 6)), nz = Math.max(1, Math.round((r.h - 2) / 6));
      for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
        const x = r.x + 1 + ((i + 0.5) * (r.w - 2)) / nx, z = r.z + 1 + ((j + 0.5) * (r.h - 2)) / nz;
        g.add(box(r.kind === 'warehouse' ? 0.4 : 1.1, 0.05, r.kind === 'corridor' ? 0.3 : 0.5, dark ? lampOff : lampOn, x, 2.97, z));
        if (!dark && quality > 0 && lights < (quality > 1 ? 22 : 12)) { const pl = new THREE.PointLight(r.kind === 'warehouse' ? 0xdfe8ff : 0xffe9c8, r.kind === 'warehouse' ? 26 : 15, 11, 1.7); pl.position.set(x, 2.55, z); g.add(pl); lights++; }
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
    const wallMat = std({ map: T.wallTex(th.wall, th.trim, l.theme) }), brickMat = std({ map: T.brickTex(l.theme, th.brickA, th.brickB) });
    mk(inner, wallMat); mk(outer.filter(([x, z]) => !(x === 0 || z === 0 || x === l.w - 1 || z === l.h - 1)), brickMat, 3.2); mk(outer.filter(([x, z]) => x === 0 || z === 0 || x === l.w - 1 || z === l.h - 1), brickMat, 2.4);
    // doors
    const doorMat = std({ map: T.doorTex(), roughness: 0.6 }), frameMat = std({ color: 0x2c2620 });
    for (const d of l.doors) {
      const lintel = box(1, 0.8, 1, wallMat, d.cx + 0.5, 2.6, d.cz + 0.5); g.add(lintel);
      const pivot = new THREE.Group(), panel = box(0.94, 2.18, 0.06, doorMat, 0.47, 1.09, 0); pivot.add(panel);
      pivot.add(box(0.05, 0.05, 0.16, std({ color: 0xc9b46a, metalness: 0.7, roughness: 0.3 }), 0.84, 1.05, 0));
      if (d.horiz) { pivot.position.set(d.cx + 0.03, 0, d.cz + 0.5); g.add(box(0.06, 2.2, 1.02, frameMat, d.cx + 0.0, 1.1, d.cz + 0.5), box(0.06, 2.2, 1.02, frameMat, d.cx + 1.0, 1.1, d.cz + 0.5)); }
      else { pivot.position.set(d.cx + 0.5, 0, d.cz + 0.03); g.add(box(1.02, 2.2, 0.06, frameMat, d.cx + 0.5, 1.1, d.cz + 0.0), box(1.02, 2.2, 0.06, frameMat, d.cx + 0.5, 1.1, d.cz + 1.0)); }
      const base = d.horiz ? 0 : -Math.PI / 2; pivot.rotation.y = base; g.add(pivot); this.doors.push({ door: d, pivot, base });
    }
    // props
    const crate = std({ map: T.crateTex() }), wood = std({ map: T.woodTex(), roughness: 0.6 }), shelf = std({ map: T.shelfTex() }), dark = std({ color: 0x1a1c20, roughness: 0.5 });
    const locker = std({ map: T.metalTex('locker', '#5d6b78'), metalness: 0.4, roughness: 0.55 }), white = std({ map: T.fabricTex('w', '#d8d6d0') }), pot = std({ color: 0x8a5a3c }), leaf = std({ color: 0x2f6b35 });
    const sofaCols = ['#7a2f2f', '#2f4a6a', '#4a4a4a', '#6a5a2f'];
    for (const p of l.props) {
      const o = new THREE.Group(); o.position.set(p.cx + 0.5, 0, p.cz + 0.5); const rj = ((p.cx * 13 + p.cz * 7) % 10) / 10;
      switch (p.kind) {
        case 'crate': { const high = sim.cell(p.cx, p.cz) === 5; const a = box(0.94, 0.94, 0.94, crate, 0, 0.47, 0); a.rotation.y = (rj - 0.5) * 0.2; o.add(a); if (high) { const b = box(0.86, 0.86, 0.86, crate, (rj - 0.5) * 0.08, 0.94 + 0.43, 0); b.rotation.y = (rj - 0.5) * 0.5; o.add(b); if (rj > 0.5) o.add(box(0.7, 0.5, 0.7, crate, 0, 2.05, 0)); } break; }
        case 'desk': o.add(box(0.98, 0.05, 0.86, wood, 0, 0.76, 0), box(0.05, 0.74, 0.8, wood, -0.44, 0.37, 0), box(0.05, 0.74, 0.8, wood, 0.44, 0.37, 0), box(0.86, 0.4, 0.03, wood, 0, 0.5, -0.38));
          if (rj > 0.3) { o.add(box(0.42, 0.28, 0.03, dark, 0, 1.0, -0.15), box(0.06, 0.1, 0.06, dark, 0, 0.83, -0.15)); const scr = new THREE.Mesh(new THREE.PlaneGeometry(0.38, 0.24), new THREE.MeshBasicMaterial({ color: rj > 0.6 ? 0x2a4f7a : 0x0c1016 })); scr.position.set(0, 1.0, -0.133); o.add(scr); }
          o.rotation.y = (p.rot * Math.PI) / 2; break;
        case 'shelf': o.add(box(0.96, 2.1, 0.5, shelf, 0, 1.05, 0)); o.rotation.y = (p.rot % 2 ? Math.PI / 2 : 0); break;
        case 'locker': o.add(box(0.92, 2.0, 0.6, locker, 0, 1.0, 0)); o.rotation.y = (p.rot * Math.PI) / 2; break;
        case 'bed': o.add(box(0.96, 0.3, 0.96, wood, 0, 0.15, 0), box(0.9, 0.2, 0.9, white, 0, 0.4, 0), box(0.6, 0.1, 0.3, white, 0, 0.55, -0.26)); o.rotation.y = (p.rot * Math.PI) / 2; break;
        case 'sofa': { const fm = std({ map: T.fabricTex('s' + (p.rot % 4), sofaCols[p.rot % 4]) }); o.add(box(0.96, 0.42, 0.9, fm, 0, 0.21, 0), box(0.96, 0.4, 0.2, fm, 0, 0.62, -0.36), box(0.14, 0.24, 0.9, fm, -0.41, 0.54, 0), box(0.14, 0.24, 0.9, fm, 0.41, 0.54, 0)); o.rotation.y = (p.rot * Math.PI) / 2; break; }
        case 'plant': { const c = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.16, 0.4, 10), pot); c.position.y = 0.2; o.add(c); for (let i = 0; i < 3; i++) { const s = new THREE.Mesh(new THREE.IcosahedronGeometry(0.26 - i * 0.05, 0), leaf); s.position.set((i - 1) * 0.08, 0.6 + i * 0.22, (rj - 0.5) * 0.1); s.rotation.set(i, rj * 6, i * 2); o.add(s); } break; }
      }
      g.add(o);
    }
  }
  update() { for (const d of this.doors) d.pivot.rotation.y = d.base + d.door.open * 1.62; }
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

// extra bone rotations (radians) for the kneeling poses; tuned by eye
const POSE = { thigh: 0, shin: 1.7, drop: 0.42, up: [2.4, 0.4, 0, 0, 0.7], cuff: [-0.5, 0.5, 0, 0, 0.9], head: 0.4 };
const P_DROP = () => ((window as any).__pose ?? POSE).drop;
export class ActorView {
  root = new THREE.Group(); body = new THREE.Group(); torso = new THREE.Group();
  legs: { hip: THREE.Group; knee: THREE.Group }[] = []; arms: { sh: THREE.Group; el: THREE.Group }[] = [];
  head = new THREE.Group(); gun = new THREE.Group(); label?: THREE.Sprite; fall = 0; flashT = 0; flash: THREE.Sprite;
  pool?: THREE.Mesh; poolT = 0; dropped?: THREE.Group; wounds = 0;
  rig?: Rig; private shootT = 0;
  constructor(public a: Actor) {
    const v = a.variant, off = a.kind === 'officer' || a.kind === 'player', tcol = a.kind === 'player' ? 0x4fd07a : TEAM_COLOR[a.team];
    const cloth = std({ color: off ? 0x1b2434 : a.kind === 'suspect' ? HOOD[v] : SHIRT[v] });
    const pants = std({ color: off ? 0x161d2a : a.kind === 'suspect' ? 0x24303f : [0x2b2b33, 0x3a3f4a, 0x4a3a2a][v % 3] });
    const skin = std({ color: SKIN[(v + a.id) % 6], roughness: 0.7 }), black = std({ color: 0x0e1014, roughness: 0.6 }), boot = std({ color: 0x15130f });
    const tc = off ? std({ color: tcol, emissive: tcol, emissiveIntensity: 0.35 }) : null;
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
    g.obj.position.y = -P_DROP() * this.kneelK - (a.kind === 'player' && a.crouch && a.alive ? 0.25 : 0);
    if (g.gun) g.gun.visible = armed && a.alive && !a.down;
    if (this.label) this.label.visible = a.alive;
    if (this.dropped) this.dropped.visible = !a.armed || !a.alive;
    if (!a.alive) {
      if (!this.pool) { const pm = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: T.bloodTex(), transparent: true, depthWrite: false, opacity: 0.92 })); pm.rotation.x = -Math.PI / 2; pm.rotation.z = a.id * 1.7; pm.position.set(0, 0.016 + (a.id % 7) * 0.0006, 0.5); this.root.add(pm); this.pool = pm; }
      this.poolT = Math.min(1, this.poolT + dt / 5); const e = 1 - (1 - this.poolT) * (1 - this.poolT); this.pool.scale.setScalar(0.35 + e * (1.25 + (a.id % 3) * 0.2));
    }
  }
  private kneelK = 0;
  /** Visible bullet wound on the clothes. */
  wound() {
    if (this.wounds >= 6 || this.rig) return; this.wounds++;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(0.1 + Math.random() * 0.08, 0.1 + Math.random() * 0.1), new THREE.MeshBasicMaterial({ map: T.bloodTex(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 }));
    const front = Math.random() < 0.7; m.position.set((Math.random() - 0.5) * 0.3, 0.2 + Math.random() * 0.36, front ? -0.156 : 0.156); if (front) m.rotation.y = Math.PI; this.torso.add(m);
  }
  update(dt: number, time: number) {
    const a = this.a, k = Math.min(1, dt * 12), r = this.root;
    r.position.x = lerp(r.position.x, a.x, Math.min(1, dt * 25)); r.position.z = lerp(r.position.z, a.z, Math.min(1, dt * 25));
    let dy = a.yaw - r.rotation.y; dy = Math.atan2(Math.sin(dy), Math.cos(dy)); r.rotation.y += dy * Math.min(1, dt * 14);
    if (!this.rig && modelsReady) {
      this.rig = new Rig(a.kind, a.id); for (const l of this.legs) l.hip.visible = false; this.torso.visible = false;
      this.body.add(this.rig.obj); this.body.add(this.flash); this.flash.position.set(0.1, 1.28, -0.7); this.dropped?.scale.setScalar(0.55);
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
  tracer(a: THREE.Vector3, b: THREE.Vector3) { const t = this.tracers[this.ti = (this.ti + 1) % this.tracers.length]; const p = t.line.geometry.attributes.position as THREE.BufferAttribute; p.setXYZ(0, a.x, a.y, a.z); p.setXYZ(1, b.x, b.y, b.z); p.needsUpdate = true; t.line.visible = true; t.t = 0.06; }
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
  pistol.visible = false; g.add(rifle, pistol);
  const flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: T.glowTex(), blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, transparent: true })); flash.scale.setScalar(0.28); flash.position.set(0, 0.02, -0.78); flash.visible = false; g.add(flash);
  return { group: g, rifle, pistol, flash };
}
