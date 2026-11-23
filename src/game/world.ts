// three.js presentation of the simulation: level geometry, characters, effects. All geometry is procedural.
import * as THREE from 'three';
import { Sim, Actor, Team } from '../sim/sim';
import { WALL, OUT, WINDOW, FLOOR, Door, Prop, groundHeightAt } from '../sim/level';
import * as T from './textures';
import { modelsReady, Rig, droppedPistol } from './models';
import { weaponModel, buildBallisticShield } from './weapons';
import { OperatorBody, operatorReady } from './operator';
import { propsReady, onPropsReady, propModel, exteriorPlanterModel, exteriorTreeModel } from './props';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const BOX = new THREE.BoxGeometry(1, 1, 1);
const std = (o: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0, ...o });
function box(w: number, h: number, d: number, m: THREE.Material, x = 0, y = 0, z = 0) { const b = new THREE.Mesh(BOX, m); b.scale.set(w, h, d); b.position.set(x, y, z); return b; }

type SlabRect = { x: number; z: number; w: number; d: number };
/** Splits a horizontal slab around a rectangular opening, so a stair can break through it. */
function cutSlab(rects: SlabRect[], hole: SlabRect): SlabRect[] {
  const out: SlabRect[] = [];
  for (const r of rects) {
    const x0 = Math.max(r.x, hole.x), x1 = Math.min(r.x + r.w, hole.x + hole.w);
    const z0 = Math.max(r.z, hole.z), z1 = Math.min(r.z + r.d, hole.z + hole.d);
    if (x1 - x0 <= 0.001 || z1 - z0 <= 0.001) { out.push(r); continue; }
    if (z0 - r.z > 0.001) out.push({ x: r.x, z: r.z, w: r.w, d: z0 - r.z });
    if (r.z + r.d - z1 > 0.001) out.push({ x: r.x, z: z1, w: r.w, d: r.z + r.d - z1 });
    if (x0 - r.x > 0.001) out.push({ x: r.x, z: z0, w: x0 - r.x, d: z1 - z0 });
    if (r.x + r.w - x1 > 0.001) out.push({ x: x1, z: z0, w: r.x + r.w - x1, d: z1 - z0 });
  }
  return out;
}

const CITY_CACHE = new Map<string, Promise<THREE.Group | null>>();
// Traffic-cone template is shared by every exterior: one GLB fetch/decode no matter how many
// cordons a level builds. Cones stay purely decorative (no shadow casting) so the extra
// dressing cannot stall software GPUs in the High smoke test.
let coneTplPromise: Promise<THREE.Group | null> | null = null;
function loadConeTemplate(): Promise<THREE.Group | null> {
  if (!coneTplPromise) {
    coneTplPromise = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder)
      .loadAsync('./models/props/traffic_cone.glb')
      .then(tpl => { tpl.scene.updateMatrixWorld(true); return tpl.scene as THREE.Group; })
      .catch(() => null);
  }
  return coneTplPromise;
}
let coneOrangeMat: THREE.MeshStandardMaterial | null = null;
let coneWhiteMat: THREE.MeshStandardMaterial | null = null;
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
          if ('envMapIntensity' in m) m.envMapIntensity = /glass|window|cteclo/i.test(m.name || '') ? 0.9 : 0.85;
          if (/lamp.*glass|glow/i.test(m.name || '')) {
            m.emissive = new THREE.Color(0xffe4b5);
            m.emissiveIntensity = 1.7;
          }
          // GLB textures default to anisotropy 1, which smears facades into soft blobs when you
          // stand next to a building and look up. Ask for the sharpest mip filtering we can get.
          for (const slot of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap']) {
            const tex = (m as any)[slot] as THREE.Texture | undefined;
            if (!tex) continue;
            tex.anisotropy = 16;
            if (tex.minFilter === THREE.LinearFilter) tex.minFilter = THREE.LinearMipmapLinearFilter;
          }
          // Lit interiors / neon: let those materials emit instead of rendering as flat paint.
          if (/glow|neon|lit/i.test(m.name || '') && m.map && !m.emissiveMap) {
            m.emissiveMap = m.map;
            if (!m.emissive || (m.emissive.r + m.emissive.g + m.emissive.b) === 0) m.emissive = new THREE.Color(0xffffff);
            m.emissiveIntensity = Math.max(m.emissiveIntensity || 1, 0.55);
          }
        }
      });
      return sc;
    }).catch(() => {
      if (CITY_CACHE.get(name) === p) CITY_CACHE.delete(name); // preserve fallback and allow a later retry
      return null;
    });
    CITY_CACHE.set(name, p);
  }
  return p;
}

// ---------------- modular facades (Poly Haven CC0, already credited in public/models/city/LICENSE.txt) ----------------
// The baked-texture building models read as blurry orange blobs when you stand on the pavement and
// look up, so the street-facing mass is assembled from the real modular facade kits instead: actual
// window recesses, sills, plaster, trim and 1024px PBR textures.
interface FacadeModule { nodes: THREE.Object3D[]; origin: THREE.Matrix4; width: number }
const FACADE_CACHE = new Map<string, FacadeModule | null>();

function facadeModule(kit: THREE.Group | null, wallName: string): FacadeModule | null {
  if (!kit) return null;
  const key = kit.name + '/' + wallName;
  const hit = FACADE_CACHE.get(key);
  if (hit !== undefined) return hit;
  const wall = kit.getObjectByName(wallName);
  if (!wall) { FACADE_CACHE.set(key, null); return null; }
  wall.updateWorldMatrix(true, true);
  const wb = new THREE.Box3().setFromObject(wall);
  const nodes: THREE.Object3D[] = [wall];
  for (const c of kit.children) {
    if (c === wall || /^(wall_|cornice|crown|dado|base)/.test(c.name)) continue;
    const b = new THREE.Box3().setFromObject(c);
    const ctr = b.getCenter(new THREE.Vector3());
    if (ctr.x > wb.min.x && ctr.x < wb.max.x && ctr.y > wb.min.y && ctr.y < wb.max.y && ctr.z > wb.max.z - 1.2 && ctr.z < wb.max.z + 0.6) nodes.push(c);
  }
  const mod: FacadeModule = {
    nodes,
    origin: new THREE.Matrix4().makeTranslation(wb.min.x, wb.min.y, wb.max.z),
    width: Math.max(1, Math.round(wb.max.x - wb.min.x)),
  };
  FACADE_CACHE.set(key, mod);
  return mod;
}

/**
 * KHR_mesh_quantization stores positions/normals/uvs as normalised integers, which
 * BufferGeometry.applyMatrix4 silently ignores. Widen them to float before baking a placement in.
 */
function dequantize(g: THREE.BufferGeometry): THREE.BufferGeometry {
  for (const name of Object.keys(g.attributes)) {
    const a = g.getAttribute(name) as THREE.BufferAttribute;
    if (!a || (a.array instanceof Float32Array && !a.normalized)) continue;
    const size = a.itemSize, arr = new Float32Array(a.count * size);
    for (let i = 0; i < a.count; i++) {
      arr[i * size] = a.getX(i);
      if (size > 1) arr[i * size + 1] = a.getY(i);
      if (size > 2) arr[i * size + 2] = a.getZ(i);
      if (size > 3) arr[i * size + 3] = (a as any).getW ? (a as any).getW(i) : 0;
    }
    g.setAttribute(name, new THREE.Float32BufferAttribute(arr, size));
  }
  return g;
}

/** Bake a kit module (wall + its window/door dressing) into world-space geometry buckets. */
function collectModule(mod: FacadeModule, M: THREE.Matrix4, out: Map<THREE.Material, THREE.BufferGeometry[]>) {
  const inv = mod.origin.clone().invert();
  for (const n of mod.nodes) {
    n.updateWorldMatrix(true, true);
    n.traverse((o: any) => {
      if (!o.isMesh || !o.geometry) return;
      const g = dequantize((o.geometry as THREE.BufferGeometry).clone());
      g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(M, inv).multiply(o.matrixWorld));
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (!m) continue;
        const bucket = out.get(m);
        if (bucket) bucket.push(g); else out.set(m, [g]);
      }
    });
  }
}

/**
 * Build one building shell out of modular facade tiles. Rises `floors` storeys of 3 m from `y0`.
 */
async function buildFacadeBlock(
  kitName: 'modular_urban_apartments_facade' | 'modular_factory_facade',
  box: { x0: number; z0: number; x1: number; z1: number; y0: number; floors: number; seed: number },
  group: THREE.Group,
  quality: number,
  isAlive: () => boolean,
  ownedGeometry: Set<THREE.BufferGeometry>,
): Promise<void> {
  const kit = await loadCityAsset(kitName);
  if (!kit || !isAlive()) return;
  const apt = kitName === 'modular_urban_apartments_facade';
  const upper = apt
    ? ['wall_window_centered_large_01', 'wall_window_centered_double_01', 'wall_window_centered_small_01', 'wall_window_offset_small_01']
    : ['wall_window_centered_large_01', 'wall_window_tall_large_01', 'wall_window_centered_medium_01', 'wall_window_centered_double_01'];
  // no door modules up here: their leaves swing out over the pavement
  const ground = apt
    ? ['wall_window_centered_large_01', 'wall_window_centered_double_01', 'wall_window_offset_small_01']
    : ['wall_window_centered_large_01', 'wall_window_centered_medium_01', 'wall_window_offset_small_01'];
  let rs = box.seed * 9301 + 49297;
  const rnd = () => ((rs = (rs * 9301 + 49297) % 233280) / 233280);
  const { x0, z0, x1, z1, y0, floors } = box;
  const parts = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1), up = new THREE.Vector3(0, 1, 0);
  const faces = [
    { len: x1 - x0, at: (i: number) => new THREE.Vector3(x0 + i, 0, z1), rot: 0 },
    { len: x1 - x0, at: (i: number) => new THREE.Vector3(x1 - i, 0, z0), rot: Math.PI },
    { len: z1 - z0, at: (i: number) => new THREE.Vector3(x1, 0, z1 - i), rot: Math.PI / 2 },
    { len: z1 - z0, at: (i: number) => new THREE.Vector3(x0, 0, z0 + i), rot: -Math.PI / 2 },
  ];
  const fallback = facadeModule(kit, 'wall_standard_standard_01');
  for (const f of faces) {
    q.setFromAxisAngle(up, f.rot);
    for (let fl = 0; fl < floors; fl++) {
      let u = 0, guard = 0;
      while (u < f.len - 0.01 && guard++ < 64) {
        const pool = fl === 0 ? ground : upper;
        let m = facadeModule(kit, pool[(rnd() * pool.length) | 0] ?? upper[fl % 2]);
        // never let a module hang past the corner: that stuck a 3 m slab out of every storey
        if (!m || u + m.width > f.len + 0.01) m = u === 0 ? (fallback ?? null) : null;
        if (!m) break;
        const p = f.at(u); p.y = y0 + fl * 3;
        collectModule(m, new THREE.Matrix4().compose(p, q, one), parts);
        u += m.width;
      }
    }
  }
  // one merged mesh per material keeps the draw calls down
  const temporary = new Set<THREE.BufferGeometry>(), retained = new Set<THREE.BufferGeometry>();
  for (const [mat, geos] of parts) {
    geos.forEach(geo => temporary.add(geo));
    let merged: THREE.BufferGeometry | null = null;
    try { merged = mergeGeometries(geos, false); } catch { merged = null; }
    if (!merged) {
      for (const geo of geos) { retained.add(geo); const mesh = new THREE.Mesh(geo, mat); mesh.userData.sharedMaterial = true; group.add(mesh); }
      continue;
    }
    ownedGeometry.add(merged);
    const mesh = new THREE.Mesh(merged, mat); mesh.userData.sharedMaterial = true;
    // no shadow casting from the street facades: 140k triangles through the torch shadow pass is not worth it
    mesh.receiveShadow = true; group.add(mesh);
  }
  for (const geo of temporary) if (!retained.has(geo)) geo.dispose();
  // flat roof slab so the block reads as a finished building from street level
  const roof = new THREE.Mesh(
    new THREE.BoxGeometry(x1 - x0, 0.34, z1 - z0),
    new THREE.MeshStandardMaterial({ color: 0x23282f, roughness: 0.92 }),
  );
  roof.position.set((x0 + x1) / 2, y0 + floors * 3 + 0.17, (z0 + z1) / 2);
  roof.castShadow = quality >= 2; roof.receiveShadow = true;
  group.add(roof);
}

const MARAUDER_PAINT: Record<string, [number, number, number]> = { Body_2: [0x3d485e, 0.45, 0.58], Metal_UP_5: [0x4b5363, 0.5, 0.62] };

const THEME = {
  office: { wall: '#c9c3b6', trim: '#4a443c', brickA: '#3a3e46', brickB: '#2f333b', fog: 0x0b0e12 },
  warehouse: { wall: '#8b9095', trim: '#33373b', brickA: '#5f6469', brickB: '#4e5358', fog: 0x090b0d },
  hotel: { wall: '#bfa58e', trim: '#4d2e24', brickA: '#695c52', brickB: '#584c43', fog: 0x0d0b0a },
  bank: { wall: '#d6d4ce', trim: '#2d3b4e', brickA: '#6d737c', brickB: '#5d636b', fog: 0x0a0d12 },
  club: { wall: '#282633', trim: '#6a1b6a', brickA: '#28202c', brickB: '#1f1823', fog: 0x05030a },
  raid: { wall: '#b8b4aa', trim: '#3b3c40', brickA: '#635c54', brickB: '#524b44', fog: 0x090b0e },
  tower: { wall: '#c7d0d9', trim: '#253b52', brickA: '#384552', brickB: '#2d3945', fog: 0x09111a },
};

function disposeLoadedObjectResources(root: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>(), textures = new Set<THREE.Texture>();
  root.traverse((obj: any) => {
    if (!obj.isMesh) return;
    if (obj.geometry) geometries.add(obj.geometry);
    const mats: THREE.Material[] = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const mat of mats) {
      if (!mat) continue;
      materials.add(mat);
      for (const value of Object.values(mat)) { const tex = value as THREE.Texture | null; if (tex?.isTexture) textures.add(tex); }
    }
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  for (const texture of textures) texture.dispose();
}

export class LevelView {
  group = new THREE.Group();
  doors: { door: Door; pivot: THREE.Group; base: number; wedge: THREE.Mesh; lock: THREE.Mesh; tripwire: THREE.Mesh; glass?: THREE.Mesh }[] = [];
  /** Sliding landing doors and their indicator lamps, one entry per stop. */
  liftViews: {
    id: number; stopIndex: number; left: THREE.Group; right: THREE.Group;
    up: THREE.MeshBasicMaterial; down: THREE.MeshBasicMaterial; cabLight: THREE.MeshBasicMaterial;
    callUp: THREE.MeshBasicMaterial; callDown: THREE.MeshBasicMaterial; floorLamps: THREE.MeshBasicMaterial[];
    carPip: THREE.Mesh; cabButtons: THREE.MeshBasicMaterial[];
  }[] = [];
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
  private removePropsReady?: () => void;
  private ownedGeometry = new Set<THREE.BufferGeometry>();
  private ownedMaterial = new Set<THREE.Material>();
  private ownedTexture = new Set<THREE.Texture>();
  private disposed = false;
  private readyPromise: Promise<void> = Promise.resolve();
  whenReady() { return this.readyPromise; }
  private retainDetachedResources(root: THREE.Object3D) {
    root.traverse((obj: any) => {
      if (!obj.isMesh) return;
      if (obj.geometry && obj.geometry !== BOX) this.ownedGeometry.add(obj.geometry);
      const mats: THREE.Material[] = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const mat of mats) {
        if (!mat) continue;
        this.ownedMaterial.add(mat);
        for (const value of Object.values(mat)) {
          const tex = value as THREE.Texture | null;
          if (tex?.isTexture && !T.isCachedTexture(tex)) this.ownedTexture.add(tex);
        }
      }
    });
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.propSlots.length = 0; this.removePropsReady?.(); this.removePropsReady = undefined;
    const geometries = new Set<THREE.BufferGeometry>(this.ownedGeometry), materials = new Set<THREE.Material>(this.ownedMaterial), textures = new Set<THREE.Texture>(this.ownedTexture);
    const hasSharedAncestor = (obj: THREE.Object3D) => {
      for (let p: THREE.Object3D | null = obj; p && p !== this.group; p = p.parent) if (p.userData.sharedAsset) return true;
      return false;
    };
    this.group.traverse((obj: any) => {
      if (!obj.isMesh) return;
      const shared = hasSharedAncestor(obj);
      if (!shared && obj.geometry && obj.geometry !== BOX) geometries.add(obj.geometry);
      if (shared || obj.userData.sharedMaterial) return;
      const mats: THREE.Material[] = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const mat of mats) {
        if (!mat) continue;
        materials.add(mat);
        for (const value of Object.values(mat)) {
          const tex = value as THREE.Texture | null;
          if (tex?.isTexture && !T.isCachedTexture(tex)) textures.add(tex);
        }
      }
    });
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    for (const texture of textures) texture.dispose();
    this.ownedGeometry.clear(); this.ownedMaterial.clear(); this.ownedTexture.clear(); this.group.clear(); this.group.removeFromParent();
    this.lightPool.length = 0; this.lightSources.length = 0; this.propViews.clear(); this.evidenceViews.clear(); this.sensorViews.clear(); this.windows.clear(); this.doors.length = 0;
  }
  constructor(public sim: Sim, quality: number) {
    const l = sim.level, th = THEME[l.theme], g = this.group;
    // exterior ground: wet stone plaza for architectural themes, dark wet asphalt elsewhere
    const plazaGround = l.theme === 'office' || l.theme === 'hotel' || l.theme === 'bank' || l.theme === 'tower';
    const groundMap = plazaGround ? T.plazaTex(l.theme) : T.floorTex('asphalt');
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(l.w + 72, l.h + 72),
      std({ map: groundMap, roughness: plazaGround ? 0.24 : 0.34, metalness: plazaGround ? 0.36 : 0.25 }),
    );
    scaleUV(ground.geometry, (l.w + 72) / 3, (l.h + 72) / 3); ground.rotation.x = -Math.PI / 2; ground.position.set(l.w / 2, -0.012, l.h / 2); g.add(ground);
    // rooms: floor + ceiling + lamps
    const ceilMat = std({ map: T.floorTex('ceiling'), color: quality > 0 ? 0xa8afba : 0xffffff });
    const lampOn = this.lampOnMat = new THREE.MeshBasicMaterial({ color: l.theme === 'club' ? 0xc864ff : 0xfff4dc });
    // push the panels above 1.0 in linear space so the bloom pass only picks up the light fittings
    lampOn.color.multiplyScalar(l.theme === 'club' ? 1.3 : 1.28);
    const lampOff = this.lampOffMat = std({ color: 0x3a3a38 });
    const poolCount = quality >= 3 ? 16 : quality === 2 ? 11 : quality === 1 ? 7 : 0;
    for (let i = 0; i < poolCount; i++) {
      const pl = new THREE.PointLight(0xffffff, 0, 12, 1.6);
      g.add(pl);
      this.lightPool.push(pl);
    }
    // A stair flight has to break through the slab it arrives on. Without this opening the top
    // steps are swallowed by the ceiling/floor plane and the player climbs into solid geometry.
    // The opening is widened to the cell boundaries across the flight so the handrails never run
    // through the shaft walls, and it reaches STAIR_LANDING metres past the bottom tread: a
    // stairwell you can only see into from the first step reads as a slot in a low ceiling, so the
    // foot of the flight stands in the open shaft and you look up into the stairwell from the floor.
    const STAIR_LANDING = 1.6;
    const stairBounds = (s: (typeof l.staircases)[number]) => {
      const alongX = Math.abs(s.x1 - s.x0) >= Math.abs(s.z1 - s.z0);
      const ax0 = Math.min(s.x0, s.x1), ax1 = Math.max(s.x0, s.x1);
      const az0 = Math.min(s.z0, s.z1), az1 = Math.max(s.z0, s.z1);
      const up = s.toY >= s.fromY;
      return {
        // The opening ends exactly at the top tread, so the last step meets the upper floor
        // instead of leaving a walkable gap, and it runs past the bottom tread over the landing.
        x0: alongX ? (up ? ax0 - STAIR_LANDING : ax0) : Math.floor(ax0 - s.width / 2),
        x1: alongX ? (up ? ax1 : ax1 + STAIR_LANDING) : Math.ceil(ax1 + s.width / 2),
        z0: alongX ? Math.floor(az0 - s.width / 2) : (up ? az0 - STAIR_LANDING : az0),
        z1: alongX ? Math.ceil(az1 + s.width / 2) : (up ? az1 : az1 + STAIR_LANDING),
      };
    };
    const slabHoles = l.staircases.map(s => {
      const b = stairBounds(s);
      return { x: b.x0, z: b.z0, w: b.x1 - b.x0, d: b.z1 - b.z0, y: Math.max(s.fromY, s.toY) };
    });
    for (const r of l.rooms) {
      const floorY = r.floorY ?? 0;
      const floorMat = std({ map: T.floorTex(r.floor), roughness: r.floor === 'tile' ? 0.35 : 0.95 });
      const ceilRoomMat = ceilMat.clone(); (ceilRoomMat as THREE.MeshStandardMaterial).map = T.floorTex('ceiling');
      const roomRect: SlabRect = { x: r.x, z: r.z, w: r.w, d: r.h };
      let floorRects: SlabRect[] = [roomRect];
      for (const h of slabHoles) if (Math.abs(h.y - floorY) < 0.06) floorRects = cutSlab(floorRects, h);
      let ceilRects: SlabRect[] = [roomRect];
      for (const h of slabHoles) if (Math.abs(h.y - (floorY + 3)) < 0.06) ceilRects = cutSlab(ceilRects, h);
      for (const rc of floorRects) {
        const fl = new THREE.Mesh(new THREE.PlaneGeometry(rc.w, rc.d), floorMat);
        scaleUV(fl.geometry, rc.w / 2, rc.d / 2); fl.rotation.x = -Math.PI / 2; fl.position.set(rc.x + rc.w / 2, floorY + r.id * 0.0006, rc.z + rc.d / 2); g.add(fl);
      }
      for (const rc of ceilRects) {
        const ce = new THREE.Mesh(new THREE.PlaneGeometry(rc.w, rc.d), ceilRoomMat);
        scaleUV(ce.geometry, rc.w / 2, rc.d / 2); ce.rotation.x = Math.PI / 2; ce.position.set(rc.x + rc.w / 2, floorY + 3 - r.id * 0.0006, rc.z + rc.d / 2); g.add(ce);
      }
      const dark = l.theme === 'club' ? (r.kind === 'club') : (r.kind !== 'corridor' && r.kind !== 'lobby' && ((r.id * 7 + sim.mission * 3 + Math.floor(l.suspects[0]?.x ?? 0)) % 4 === 0));
      const nx = Math.max(1, Math.round((r.w - 2) / 6)), nz = Math.max(1, Math.round((r.h - 2) / 6));
      for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
        const x = r.x + 1 + ((i + 0.5) * (r.w - 2)) / nx, z = r.z + 1 + ((j + 0.5) * (r.h - 2)) / nz;
        // do not leave a light fitting floating in the stairwell opening
        if (slabHoles.some(h => Math.abs(h.y - (floorY + 3)) < 0.06 && x > h.x && x < h.x + h.w && z > h.z && z < h.z + h.d)) continue;
        const lm = box(r.kind === 'warehouse' ? 0.4 : 1.1, 0.05, r.kind === 'corridor' ? 0.3 : 0.5, dark ? lampOff : lampOn, x, floorY + 2.97, z);
        g.add(lm);
        if (!dark) this.lampMeshes.push(lm);
        if ((!dark || l.theme === 'club') && poolCount > 0) {
          const col = l.theme === 'club' ? (i % 2 ? 0xff3ea5 : 0x3ea8ff) : r.kind === 'warehouse' ? 0xdfe8ff : 0xffe9c8;
          const baseInt = l.theme === 'club' ? 9 : r.kind === 'warehouse' ? 17 : 10.5;
          this.lightSources.push({ x, y: floorY + 2.55, z, color: col, intensity: baseInt, distance: 11, decay: 1.7, isRoom: true });
        }
      }
    }
    // Stair flights are built as real rising treads, with two metal handrails. The simulation samples
    // the same flight endpoints to give the player a continuous walkable height while they climb.
    if (l.staircases.length) {
      const treadMat = std({ color: 0x687581, roughness: 0.82, metalness: 0.12 });
      const treadAlt = std({ color: 0x586571, roughness: 0.85, metalness: 0.1 });
      const nosingMat = std({ color: 0x9ca8b1, roughness: 0.56, metalness: 0.28 });
      const railMat = std({ color: 0x26323c, roughness: 0.32, metalness: 0.78 });
      const up = new THREE.Vector3(0, 1, 0);
      for (const s of l.staircases) {
        const dx = s.x1 - s.x0, dz = s.z1 - s.z0, length = Math.hypot(dx, dz);
        if (length < 0.1 || s.steps < 1) continue;
        const ux = dx / length, uz = dz / length, px = -uz, pz = ux, stepDepth = length / s.steps, yaw = Math.atan2(ux, uz);
        for (let i = 0; i < s.steps; i++) {
          const t0 = i / s.steps, t1 = (i + 1) / s.steps;
          const y0 = s.fromY + (s.toY - s.fromY) * t0, y1 = s.fromY + (s.toY - s.fromY) * t1;
          const rise = Math.max(0.07, Math.abs(y1 - y0));
          const cx = s.x0 + ux * ((i + 0.5) * stepDepth), cz = s.z0 + uz * ((i + 0.5) * stepDepth);
          const tread = box(s.width, rise, stepDepth + 0.02, i % 2 ? treadMat : treadAlt, cx, (y0 + y1) / 2, cz);
          tread.rotation.y = yaw; tread.castShadow = quality >= 2; tread.receiveShadow = true; g.add(tread);
          const nosing = box(s.width * 0.98, 0.035, 0.055, nosingMat,
            cx + ux * (stepDepth * 0.46), Math.max(y0, y1) + 0.018, cz + uz * (stepDepth * 0.46));
          nosing.rotation.y = yaw; g.add(nosing);
        }
        for (const side of [-1, 1]) {
          const railOffset = side * (s.width / 2 + 0.1);
          for (let i = 0; i <= Math.ceil(length / 1.7); i++) {
            const t = Math.min(1, (i * 1.7) / length), x = s.x0 + dx * t + px * railOffset, z = s.z0 + dz * t + pz * railOffset;
            const y = s.fromY + (s.toY - s.fromY) * t;
            const post = box(0.065, 1.02, 0.065, railMat, x, y + 0.51, z); post.rotation.y = yaw; g.add(post);
          }
          for (const height of [0.78, 1.02]) {
            const a = new THREE.Vector3(s.x0 + px * railOffset, s.fromY + height, s.z0 + pz * railOffset);
            const b = new THREE.Vector3(s.x1 + px * railOffset, s.toY + height, s.z1 + pz * railOffset);
            const span = b.clone().sub(a), bar = new THREE.Mesh(new THREE.CylinderGeometry(height === 1.02 ? 0.035 : 0.022, height === 1.02 ? 0.035 : 0.022, span.length(), 8), railMat);
            bar.position.copy(a).add(b).multiplyScalar(0.5); bar.quaternion.setFromUnitVectors(up, span.normalize()); g.add(bar);
          }
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
      cells.forEach(([x, z], i) => {
        const floorY = l.groundY[z * l.w + x] ?? 0;
        m.makeScale(1, h / 3, 1); m.setPosition(x + 0.5, floorY + h / 2, z + 0.5); im.setMatrixAt(i, m);
      }); g.add(im);
    };
    const wallMat = std({ map: T.wallTex(th.wall, th.trim, l.theme), color: quality > 0 ? 0xb2b8c2 : 0xffffff });
    const brickMat = l.theme === 'office'
      ? std({ color: 0x20252d, roughness: 0.35, metalness: 0.45 })
      : std({ map: T.brickTex(l.theme === 'bank' || l.theme === 'club' || l.theme === 'raid' ? 'office' : l.theme, th.brickA, th.brickB) });
    const curbMat = std({ color: 0x262a31, roughness: 0.72, metalness: 0.25 });
    const perimH = l.theme === 'club' ? 2.6 : 0.85;
    mk(inner, wallMat); mk(outer.filter(([x, z]) => !(x === 0 || z === 0 || x === l.w - 1 || z === l.h - 1)), brickMat, 3.2); mk(outer.filter(([x, z]) => x === 0 || z === 0 || x === l.w - 1 || z === l.h - 1), l.theme === 'club' ? brickMat : curbMat, perimH);
    // Enclose the stairwell above the level it leaves: the flight breaks through the F1 ceiling,
    // so it needs a real shaft (walls + ceiling) rather than a raw hole into the sky.
    for (const s of l.staircases) {
      const top = Math.max(s.fromY, s.toY), low = Math.min(s.fromY, s.toY);
      if (top - low < 1) continue;
      const dx = s.x1 - s.x0, dz = s.z1 - s.z0;
      if (Math.abs(dx) > 0.01 && Math.abs(dz) > 0.01) continue; // only axis-aligned shafts; others keep the opening
      const b = stairBounds(s);
      const x0 = b.x0, x1 = b.x1, z0 = b.z0, z1 = b.z1;
      const shaftH = 3, t = 0.12;
      for (let x = x0; x < x1 - 0.01; x += 1) {
        const w = Math.min(1, x1 - x);
        g.add(box(w, shaftH, t, wallMat, x + w / 2, top + shaftH / 2, z0));
        g.add(box(w, shaftH, t, wallMat, x + w / 2, top + shaftH / 2, z1));
      }
      for (let z = z0; z < z1 - 0.01; z += 1) {
        const d = Math.min(1, z1 - z);
        g.add(box(t, shaftH, d, wallMat, x0, top + shaftH / 2, z + d / 2));
      }
      const sc = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0), ceilMat.clone());
      (sc.material as THREE.MeshStandardMaterial).map = T.floorTex('ceiling');
      scaleUV(sc.geometry, (x1 - x0) / 2, (z1 - z0) / 2);
      sc.rotation.x = Math.PI / 2; sc.position.set((x0 + x1) / 2, top + shaftH, (z0 + z1) / 2); g.add(sc);
      if (quality > 0) {
        const light = new THREE.PointLight(0xffe9c8, 8, 10, 1.7);
        light.position.set((x0 + x1) / 2, top + shaftH - 0.3, (z0 + z1) / 2); g.add(light);
      }
    }
    // Perimeter cells are drawn with the dark exterior brick/curb material, but many of them also
    // face a playable room. Skin those faces in the interior plaster so the level does not end in
    // a matte-black wall like the corridor corner did.
    const skins: { x: number; y: number; z: number; ry: number }[] = [];
    for (const [x, z] of outer) {
      for (const [dx, dz] of [[0, -1], [0, 1], [-1, 0], [1, 0]] as const) {
        const nx = x + dx, nz = z + dz;
        if (nx < 0 || nz < 0 || nx >= l.w || nz >= l.h) continue;
        if (sim.cell(nx, nz) !== FLOOR) continue;   // only open floor gets a plaster face; frames dress themselves
        skins.push({ x: x + 0.5 + dx * 0.503, y: (l.groundY[z * l.w + x] ?? 0) + 1.5, z: z + 0.5 + dz * 0.503, ry: Math.atan2(dx, dz) });
      }
    }
    if (skins.length) {
      const skinGeo = new THREE.PlaneGeometry(1, 3);
      const im = new THREE.InstancedMesh(skinGeo, wallMat, skins.length);
      const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1), pos = new THREE.Vector3();
      im.receiveShadow = quality >= 2;
      skins.forEach((s, i) => {
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), s.ry);
        m4.compose(pos.set(s.x, s.y, s.z), q, one);
        im.setMatrixAt(i, m4);
      });
      g.add(im);
    }
    // Breakable glass windows. Only interior glass partitions are left in the level — every
    // exterior window is sealed to solid wall in the level data — so these always get a sill below
    // and a header above, exactly the 0.9–2.3 m band the bullet code lets glass pass through.
    const glassMat = quality > 0
      ? new THREE.MeshPhysicalMaterial({ color: 0xaad8ee, transparent: true, opacity: 0.2, roughness: 0.24, metalness: 0.05, specularIntensity: 0.45 })
      : std({ color: 0xaad8ee, transparent: true, opacity: 0.34, roughness: 0.15 });
    const frameAlum = std({ color: 0x161a20, roughness: 0.35, metalness: 0.65 });
    for (const w of l.windows) {
      const cx = Math.floor(w.x), cz = Math.floor(w.z), floorY = w.floorY ?? groundHeightAt(l, w.x, w.z);
      const horiz = sim.cell(cx - 1, cz) === WALL || sim.cell(cx - 1, cz) === WINDOW || sim.cell(cx + 1, cz) === WALL || sim.cell(cx + 1, cz) === WINDOW;
      g.add(box(1, 0.9, 1, wallMat, w.x, floorY + 0.45, w.z), box(1, 0.7, 1, wallMat, w.x, floorY + 2.65, w.z));
      const pane = box(horiz ? 0.98 : 0.06, 1.4, horiz ? 0.06 : 0.98, glassMat, w.x, floorY + 1.6, w.z);
      g.add(pane);
      this.windows.set(cz * l.w + cx, pane);
    }
    // doors (+ lock & wedge indicators; glass entrance doors on office/hotel/bank)
    const doorMat = std({ map: T.doorTex(), roughness: 0.6 }), frameMat = std({ color: 0x202328, roughness: 0.4, metalness: 0.4 });
    const glassDoorMat = quality > 0
      ? new THREE.MeshPhysicalMaterial({ color: 0x99d0e8, transparent: true, opacity: 0.36, roughness: 0.22, metalness: 0.08, specularIntensity: 0.45 })
      : std({ color: 0x99d0e8, transparent: true, opacity: 0.38, roughness: 0.15 });
    const wedgeMat = std({ color: 0xf2a82e, roughness: 0.4 }), lockMat = std({ color: 0xe04848, emissive: 0x801010, emissiveIntensity: 0.6 });
    for (const d of l.doors) {
      const floorY = d.floorY ?? groundHeightAt(l, d.cx + 0.5, d.cz + 0.5);
      const frontGlassDoor = (l.theme === 'office' || l.theme === 'hotel' || l.theme === 'bank') && (sim.cell(d.cx, d.cz + 1) === OUT || sim.cell(d.cx, d.cz - 1) === OUT);
      const lintel = box(1, 0.8, 1, frontGlassDoor ? frameAlum : wallMat, d.cx + 0.5, floorY + 2.6, d.cz + 0.5); g.add(lintel);
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
        pivot.position.set(d.cx + 0.03, floorY, d.cz + 0.5);
        tripwire.position.set(d.cx + 0.5, floorY + 0.24, d.cz + 0.5);
        g.add(box(0.06, 2.2, 1.02, frameMat, d.cx + 0.0, floorY + 1.1, d.cz + 0.5), box(0.06, 2.2, 1.02, frameMat, d.cx + 1.0, floorY + 1.1, d.cz + 0.5), tripwire);
      } else {
        pivot.position.set(d.cx + 0.5, floorY, d.cz + 0.03);
        tripwire.rotation.y = Math.PI / 2;
        tripwire.position.set(d.cx + 0.5, floorY + 0.24, d.cz + 0.5);
        g.add(box(1.02, 2.2, 0.06, frameMat, d.cx + 0.5, floorY + 1.1, d.cz + 0.0), box(1.02, 2.2, 0.06, frameMat, d.cx + 0.5, floorY + 1.1, d.cz + 1.0), tripwire);
      }
      if (quality >= 2) pivot.traverse((o: any) => { if (o.isMesh && o !== glass) { o.castShadow = true; o.receiveShadow = true; } });
      const base = d.horiz ? 0 : -Math.PI / 2; pivot.rotation.y = base; g.add(pivot); this.doors.push({ door: d, pivot, base, wedge, lock, tripwire, glass });
    }
    // Functional lifts. Each landing is a pair of brushed-steel sliding panels set into a wall
    // pocket: press the button, the panels part, the car closes its doors, travels three metres and
    // opens again on the other floor (Sim.updateElevators drives the numbers used here).
    if (l.elevators.length) {
      const liftFrame = std({ color: 0x2a333c, roughness: 0.4, metalness: 0.72 });
      const liftWall = std({ map: T.brushedTex('#4d5760'), roughness: 0.6, metalness: 0.45, envMapIntensity: 0.5 });
      // Brushed, matte leaves: a polished finish mirrored the corridor lamp into a white bloom.
      const liftLeaf = std({ map: T.brushedTex('#77828c'), roughness: 0.5, metalness: 0.5, envMapIntensity: 0.55 });
      const liftBrushed = std({ color: 0x5d6771, roughness: 0.55, metalness: 0.45 });
      const doorGlass = std({ color: 0x0b1016, roughness: 0.25, metalness: 0.6 });
      for (const elevator of l.elevators) for (let si = 0; si < elevator.stops.length; si++) {
        const stop = elevator.stops[si];
        // The doorway sits in the wall behind the landing; local -z is out into the room.
        const fx = -Math.sin(stop.yaw), fz = -Math.cos(stop.yaw);
        const doors = new THREE.Group();
        doors.position.set(stop.x - fx * 0.58, stop.floorY, stop.z - fz * 0.58);
        doors.rotation.y = stop.yaw;
        // Recessed cab: a dark brushed back wall with a lit ceiling strip and a handrail, so an
        // open door shows a lift car rather than the inside of the wall.
        const cab = new THREE.Group();
        cab.add(
          box(1.02, 2.34, 0.04, doorGlass, 0, 1.17, 0.035),
          box(1.02, 0.06, 0.05, liftBrushed, 0, 1.02, 0.02),
          box(0.035, 1.02, 0.035, liftBrushed, -0.49, 1.05, 0.02),
          box(0.035, 1.02, 0.035, liftBrushed, 0.49, 1.05, 0.02),
        );
        const cabLight = new THREE.MeshBasicMaterial({ color: 0x2a2118 });
        cab.add(box(0.92, 0.05, 0.06, cabLight, 0, 2.34, 0.005));
        cab.add(box(0.86, 0.02, 0.02, new THREE.MeshBasicMaterial({ color: 0x9fb6c4 }), 0, 0.02, -0.06));
        // Inside: mirror over the handrail and a car-button plate, so the cab reads as a lift.
        cab.add(box(0.66, 0.74, 0.012, std({ color: 0x1c262e, roughness: 0.14, metalness: 0.9, envMapIntensity: 0.7 }), 0, 1.68, 0.055));
        cab.add(box(0.12, 0.3, 0.014, liftBrushed, 0.39, 1.32, 0.055));
        const cabButtons = [0, 1].map(i => {
          const m = new THREE.MeshBasicMaterial({ color: 0x1b2a33 });
          cab.add(box(0.05, 0.04, 0.006, m, 0.39, 1.41 - i * 0.09, 0.063));
          return m;
        });
        doors.add(cab);
        // Opening 1.01 m wide, framed by brushed-steel wall panels that hide the open leaves.
        doors.add(
          box(2.46, 0.05, 0.4, liftFrame, 0, 0.025, -0.08),
          box(1.12, 0.035, 0.16, liftBrushed, 0, 0.017, -0.11),
          box(0.56, 2.38, 0.1, liftWall, -0.79, 1.19, -0.055),
          box(0.56, 2.38, 0.1, liftWall, 0.79, 1.19, -0.055),
          box(2.14, 0.2, 0.12, liftFrame, 0, 2.5, -0.05),
          box(1.09, 0.08, 0.11, liftFrame, 0, 2.37, -0.055),
        );
        // Two sliding panels meeting at the centre seam.
        const leaf = (seal: number) => {
          const g2 = new THREE.Group();
          g2.add(box(0.548, 2.3, 0.045, liftLeaf, 0, 1.15, 0));
          g2.add(box(0.52, 0.28, 0.012, liftBrushed, 0, 0.2, -0.023));
          // Dark rubber seal on the meeting edge makes the centre seam read when shut.
          g2.add(box(0.018, 2.3, 0.05, liftFrame, seal * 0.265, 1.15, 0));
          return g2;
        };
        const left = leaf(1), right = leaf(-1);
        left.position.set(-0.2725, 0, -0.105);
        right.position.set(0.2725, 0, -0.105);
        doors.add(left, right);
        // Above the door: illuminated car-position panel and direction arrows.
        doors.add(box(1.24, 0.28, 0.06, liftFrame, 0, 2.63, -0.09));
        const upMat = new THREE.MeshBasicMaterial({ color: 0x1b2a33 });
        const downMat = new THREE.MeshBasicMaterial({ color: 0x1b2a33 });
        const up = new THREE.Mesh(new THREE.ConeGeometry(0.062, 0.1, 3), upMat);
        const down = new THREE.Mesh(new THREE.ConeGeometry(0.062, 0.1, 3), downMat);
        up.position.set(-0.26, 2.63, -0.125); down.position.set(0.26, 2.63, -0.125);
        down.rotation.z = Math.PI;
        doors.add(up, down);
        const floorLampMats = [0, 1].map(i => {
          const m = new THREE.MeshBasicMaterial({ color: 0x1b2a33 });
          // Narrow lamps either side of the centre gap, so the travelling pip stays readable.
          doors.add(box(0.15, 0.11, 0.04, m, i === 0 ? 0.12 : -0.12, 2.63, -0.125));
          return m;
        });
        // A small amber pip slides between the two floor lamps while the car is travelling.
        const carPip = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.03), new THREE.MeshBasicMaterial({ color: 0xffb545 }));
        carPip.position.set(0, 2.57, -0.128);
        doors.add(carPip);
        // Landing call plate with separate up and down buttons and a key switch.
        const callUp = new THREE.MeshBasicMaterial({ color: 0x1b2a33 });
        const callDown = new THREE.MeshBasicMaterial({ color: 0x1b2a33 });
        doors.add(box(0.17, 0.52, 0.06, liftBrushed, 1.19, 1.35, -0.1));
        const bu = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.075, 3), callUp);
        const bd = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.075, 3), callDown);
        bu.position.set(1.19, 1.5, -0.14); bd.position.set(1.19, 1.31, -0.14); bd.rotation.z = Math.PI;
        doors.add(bu, bd, box(0.055, 0.055, 0.05, new THREE.MeshBasicMaterial({ color: 0xffd166 }), 1.19, 1.18, -0.13));
        const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 0.2), new THREE.MeshBasicMaterial({ map: T.signTex(`${elevator.name.toUpperCase()} · ${stop.label}`, '#0b1620', '#dbeafe', '#38bdf8') }));
        sign.position.set(0, 2.86, -0.1); sign.rotation.y = Math.PI; doors.add(sign);
        if (quality >= 2) doors.traverse((o: any) => { if (o.isMesh && o.material !== cabLight) o.receiveShadow = true; });
        g.add(doors);
        this.liftViews.push({ id: elevator.id, stopIndex: si, left, right, up: upMat, down: downMat, cabLight, callUp, callDown, floorLamps: floorLampMats, carPip, cabButtons });
      }
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
      bg.position.set(l.breaker.x + ox, l.breaker.floorY ?? groundHeightAt(l, l.breaker.x, l.breaker.z), l.breaker.z + oz);
      bg.rotation.y = ry;
      bg.add(box(0.32, 1.4, 0.22, bm, 0, 0.7, 0), box(0.16, 0.12, 0.25, new THREE.MeshBasicMaterial({ color: 0x4fd07a }), 0, 1.15, 0));
      g.add(bg);
    }
    // bomb device
    if (l.bomb) {
      const bm = std({ color: 0x1e2228, metalness: 0.4, roughness: 0.5 });
      const bg = new THREE.Group(); bg.position.set(l.bomb.x, l.bomb.floorY ?? groundHeightAt(l, l.bomb.x, l.bomb.z), l.bomb.z);
      bg.add(box(0.55, 0.28, 0.38, bm, 0, 0.14, 0), box(0.42, 0.16, 0.28, std({ color: 0x5c2222 }), 0, 0.3, 0));
      this.bombLed = box(0.12, 0.04, 0.08, new THREE.MeshBasicMaterial({ color: 0xff2a2a }), 0, 0.4, 0);
      bg.add(this.bombLed);
      g.add(bg); this.bombBox = bg;
    }
    // props
    const crate = std({ map: T.crateTex() }), wood = std({ map: T.woodTex(), roughness: 0.6 }), shelf = std({ map: T.shelfTex() }), dark = std({ color: 0x1a1c20, roughness: 0.5 });
    const locker = std({ map: T.metalTex('locker', '#5d6b78'), metalness: 0.4, roughness: 0.55 }), white = std({ map: T.fabricTex('w', '#d8d6d0') }), pot = std({ color: 0x8a5a3c }), leaf = std({ color: 0x2f6b35 });
    // Shared geometry for the procedural plant, used until the scanned plant models arrive.
    const potGeo = new THREE.CylinderGeometry(0.25, 0.18, 0.46, 14), rimGeo = new THREE.CylinderGeometry(0.266, 0.256, 0.06, 14), soilGeo = new THREE.CylinderGeometry(0.225, 0.225, 0.03, 14);
    const stemGeo = new THREE.CylinderGeometry(0.022, 0.036, 0.95, 6), leafGeo = new THREE.SphereGeometry(1, 6, 4);
    const soilMat = std({ color: 0x2a1d14, roughness: 1 }), stemMat = std({ color: 0x3d6b3a, roughness: 0.85 });
    const leafMats = [leaf, std({ color: 0x3f7f45, roughness: 0.8 }), std({ color: 0x255a2d, roughness: 0.8 })];
    const sofaCols = ['#7a2f2f', '#2f4a6a', '#4a4a4a', '#6a5a2f'];
    for (const p of l.props) {
      const o = new THREE.Group();
      const pw = p.w ?? 1, pd = p.d ?? 1;
      o.position.set(p.cx + pw / 2, p.floorY ?? groundHeightAt(l, p.cx + pw / 2, p.cz + pd / 2), p.cz + pd / 2);
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
            case 'plant': {
              // Real potted plant: tapered terracotta pot, soil, a stem and nine broad leaves
              // fanned out at different heights. The 3D scans replace it when they finish loading.
              const c = new THREE.Mesh(potGeo, pot); c.position.y = 0.23; o.add(c);
              const rim = new THREE.Mesh(rimGeo, pot); rim.position.y = 0.44; o.add(rim);
              const soil = new THREE.Mesh(soilGeo, soilMat); soil.position.y = 0.455; o.add(soil);
              const stem = new THREE.Mesh(stemGeo, stemMat); stem.position.y = 0.9; o.add(stem);
              for (let i = 0; i < 9; i++) {
                const a = (i / 9) * Math.PI * 2 + rj * 1.7, y = 0.55 + ((i * 7) % 5) * 0.125;
                const lf = new THREE.Mesh(leafGeo, leafMats[i % 3]);
                lf.scale.set(0.17, 0.4 + (i % 3) * 0.06, 0.055);
                lf.position.set(Math.cos(a) * 0.19, y + 0.2, Math.sin(a) * 0.19);
                lf.rotation.set(0, -a + Math.PI / 2, 0);
                lf.rotateX(-0.62 - (i % 3) * 0.16);
                o.add(lf);
              }
              break;
            }
          }
        };
        const fill = () => {
          const real = propModel(p.kind, seed, high);
          if (!real) return false;
          this.retainDetachedResources(o);
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
    this.buildInteriorDetail(quality);
    this.buildExterior(quality);
    if (!propsReady && this.propSlots.length) {
      this.removePropsReady = onPropsReady(() => {
        this.removePropsReady = undefined;
        if (this.disposed) return;
        for (const populate of this.propSlots) populate();
        this.propSlots.length = 0;
      });
    }
  }
  /**
   * Interior finish that does not collide with anything: skirting boards, framed signs, clocks,
   * whiteboards, fire extinguishers, exit signs and area rugs. Everything is merged per material,
   * so a whole floor of trim costs a handful of draw calls.
   */
  private buildInteriorDetail(quality: number) {
    const l = this.sim.level, g = this.group;
    const buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();
    /** Clone a geometry, turn it to face the room, move it into place and file it under its material. */
    const add = (mat: THREE.Material, geo: THREE.BufferGeometry, x: number, y: number, z: number, ry = 0) => {
      const c = geo.clone();
      c.applyMatrix4(new THREE.Matrix4().makeRotationY(ry));
      c.translate(x, y, z);
      geo.dispose();
      const b = buckets.get(mat);
      if (b) b.push(c); else buckets.set(mat, [c]);
    };
    const trimMat = std({ color: 0x20262c, roughness: 0.8, metalness: 0.08 });
    const frameMat = std({ color: 0x14181d, roughness: 0.55, metalness: 0.3 });
    const ventMat = std({ color: 0x2b333b, roughness: 0.45, metalness: 0.6 });
    const redMat = std({ color: 0x9e1b1b, roughness: 0.42, metalness: 0.25 });
    const artMats = [
      T.signTex('KISTA', '#0f172a', '#dbeafe', '#38bdf8'),
      T.signTex('SAFETY FIRST', '#1f2937', '#fbbf24', '#fbbf24'),
      T.signTex('TEAM AI', '#0b1620', '#e0f2fe', '#22d3ee'),
      T.signTex('EVIDENCE', '#111827', '#c7d2fe', '#818cf8'),
    ].map(t => new THREE.MeshBasicMaterial({ map: t }));
    const exitMat = new THREE.MeshBasicMaterial({ map: T.signTex('EXIT', '#0b2a1b', '#7df0b0', '#34d399') });
    const clockMat = new THREE.MeshBasicMaterial({ map: T.signTex('09:41', '#0b1016', '#e6edf3', '#64748b') });
    const boardMat = std({ map: T.signTex('WHITEBOARD', '#e8eef2', '#334155', ''), roughness: 0.35, metalness: 0.05 });
    const corkMat = std({ map: T.signTex('NOTICE', '#7a5a3a', '#f8f4e8', '#caa46a'), roughness: 0.9 });
    const rugs = [std({ map: T.fabricTex('rug_a2', '#46282a'), roughness: 1 }), std({ map: T.fabricTex('rug_b2', '#28323f'), roughness: 1 }), std({ map: T.fabricTex('rug_c2', '#3b3529'), roughness: 1 })];
    const doorCells = new Set(l.doors.map(d => d.cz * l.w + d.cx));
    const liftCells = new Set<number>();
    for (const e of l.elevators) for (const s of e.stops) for (let oz = -1; oz <= 1; oz++) for (let ox = -1; ox <= 1; ox++) liftCells.add((Math.floor(s.z) + oz) * l.w + Math.floor(s.x) + ox);
    const tallProp = (x: number, z: number) => {
      const p = l.propAt.get(z * l.w + x);
      return !!p && (p.kind === 'shelf' || p.kind === 'locker' || p.kind === 'server' || p.kind === 'bar' || p.kind === 'bed');
    };
    const faceYaw = (dx: number, dz: number) => Math.atan2(dx, dz);

    // Skirting boards around every wall face, no collision and one merged mesh in the end.
    for (let z = 0; z < l.h; z++) for (let x = 0; x < l.w; x++) {
      if (l.cells[z * l.w + x] !== WALL) continue;
      for (const [dx, dz] of [[0, 1], [0, -1], [1, 0], [-1, 0]] as const) {
        const nx = x + dx, nz = z + dz;
        if (nx < 0 || nz < 0 || nx >= l.w || nz >= l.h) continue;
        if (l.cells[nz * l.w + nx] !== FLOOR) continue;
        const fy = l.groundY[nz * l.w + nx] ?? 0;
        if (Math.abs(fy - (l.groundY[z * l.w + x] ?? 0)) > 0.4) continue;
        const alongX = dx === 0;
        add(trimMat, new THREE.BoxGeometry(alongX ? 0.96 : 0.06, 0.13, alongX ? 0.06 : 0.96),
          x + 0.5 + dx * 0.49, fy + 0.065, z + 0.5 + dz * 0.49);
      }
    }

    for (const r of l.rooms) {
      const fy = r.floorY ?? 0;
      type Face = { x: number; z: number; dx: number; dz: number };
      const faces: Face[] = [];
      for (let x = r.x + 1; x < r.x + r.w - 1; x++) {
        if (l.cells[r.z * l.w + x] === WALL) faces.push({ x, z: r.z, dx: 0, dz: 1 });
        if (l.cells[(r.z + r.h - 1) * l.w + x] === WALL) faces.push({ x, z: r.z + r.h - 1, dx: 0, dz: -1 });
      }
      for (let z = r.z + 1; z < r.z + r.h - 1; z++) {
        if (l.cells[z * l.w + r.x] === WALL) faces.push({ x: r.x, z, dx: 1, dz: 0 });
        if (l.cells[z * l.w + r.x + r.w - 1] === WALL) faces.push({ x: r.x + r.w - 1, z, dx: -1, dz: 0 });
      }
      // Prints, whiteboards and notice boards are 1–1.5 m wide, so they hang over their neighbours
      // too. Both cells along the wall must be solid as well, otherwise a whiteboard centred on the
      // last wall cell before a door would cover most of the doorway.
      const solidRun = (f: Face) => {
        const ax = f.dz !== 0 ? 1 : 0, az = f.dx !== 0 ? 1 : 0;
        for (const s of [-1, 1]) {
          const nx = f.x + ax * s, nz = f.z + az * s;
          if (nx < 0 || nz < 0 || nx >= l.w || nz >= l.h) return false;
          if (l.cells[nz * l.w + nx] !== WALL) return false;
        }
        return true;
      };
      const usable = (f: Face) => {
        const k = f.z * l.w + f.x;
        if (doorCells.has(k) || liftCells.has(k)) return false;
        const fx = f.x + f.dx, fz = f.z + f.dz;
        if (fz < 0 || fz >= l.h || fx < 0 || fx >= l.w) return false;
        if (l.cells[fz * l.w + fx] !== FLOOR) return false;
        if (Math.abs((l.groundY[fz * l.w + fx] ?? 0) - fy) > 0.4) return false;
        if (tallProp(fx, fz)) return false;
        return solidRun(f);
      };
      const hash = (f: Face) => ((f.x * 73856093) ^ (f.z * 19349663) ^ (r.id * 83492791)) >>> 0;
      const wallFace = faces.find(usable);
      if (wallFace && r.w * r.h > 20) {
        const yaw = faceYaw(wallFace.dx, wallFace.dz);
        const px = wallFace.x + 0.5 + wallFace.dx * 0.505, pz = wallFace.z + 0.5 + wallFace.dz * 0.505;
        add(frameMat, new THREE.BoxGeometry(0.5, 0.28, 0.045), px, fy + 2.02, pz, yaw);
        add(clockMat, new THREE.PlaneGeometry(0.44, 0.2), px + wallFace.dx * 0.026, fy + 2.02, pz + wallFace.dz * 0.026, yaw);
      }
      let placed = 0;
      for (const f of faces) {
        if (placed >= 5) break;
        if (!usable(f)) continue;
        const h = hash(f), pick = h % 12;
        const yaw = faceYaw(f.dx, f.dz);
        const px = f.x + 0.5 + f.dx * 0.505, pz = f.z + 0.5 + f.dz * 0.505;
        const office = r.kind === 'office' || r.kind === 'corridor' || r.kind === 'lobby' || r.kind === 'bedroom';
        if (pick < 4) {
          const art = artMats[(h >> 4) % artMats.length];
          add(frameMat, new THREE.BoxGeometry(1.02, 0.58, 0.045), px, fy + 1.68, pz, yaw);
          add(art, new THREE.PlaneGeometry(0.92, 0.48), px + f.dx * 0.026, fy + 1.68, pz + f.dz * 0.026, yaw);
          placed++;
        } else if (pick === 4 && (r.kind === 'office' || r.kind === 'storage')) {
          add(frameMat, new THREE.BoxGeometry(1.5, 0.98, 0.045), px, fy + 1.5, pz, yaw);
          add(boardMat, new THREE.PlaneGeometry(1.4, 0.88), px + f.dx * 0.026, fy + 1.5, pz + f.dz * 0.026, yaw);
          add(trimMat, new THREE.BoxGeometry(0.3, 0.035, 0.07), px + f.dx * 0.05, fy + 0.98, pz + f.dz * 0.05, yaw);
          placed++;
        } else if (pick === 5 && (r.kind === 'storage' || r.kind === 'warehouse' || r.kind === 'vault')) {
          add(frameMat, new THREE.BoxGeometry(1.25, 0.85, 0.045), px, fy + 1.55, pz, yaw);
          add(corkMat, new THREE.PlaneGeometry(1.17, 0.77), px + f.dx * 0.026, fy + 1.55, pz + f.dz * 0.026, yaw);
          placed++;
        } else if (pick === 6 && office) {
          // Fire extinguisher on a wall bracket, a small green tag above it.
          add(redMat, new THREE.CylinderGeometry(0.09, 0.11, 0.62, 10), px, fy + 0.82, pz);
          add(frameMat, new THREE.BoxGeometry(0.11, 0.1, 0.09), px, fy + 1.18, pz, yaw);
          add(redMat, new THREE.PlaneGeometry(0.16, 0.09), px + f.dx * 0.05, fy + 1.36, pz + f.dz * 0.05, yaw);
          placed++;
        }
      }
    }

    // EXIT signage above each door, on both faces of the wall so it reads from either room.
    for (const d of l.doors) {
      const fy = d.floorY ?? 0;
      const cx = d.cx + 0.5, cz = d.cz + 0.5;
      if (d.horiz) {
        add(exitMat, new THREE.PlaneGeometry(0.72, 0.24), d.cx + 0.01, fy + 2.55, cz, -Math.PI / 2);
        add(exitMat, new THREE.PlaneGeometry(0.72, 0.24), d.cx + 0.99, fy + 2.55, cz, Math.PI / 2);
      } else {
        add(exitMat, new THREE.PlaneGeometry(0.72, 0.24), cx, fy + 2.55, d.cz + 0.01, Math.PI);
        add(exitMat, new THREE.PlaneGeometry(0.72, 0.24), cx, fy + 2.55, d.cz + 0.99, 0);
      }
    }

    // Area rugs, laid flat under whatever furniture is already in the room. A PlaneGeometry stands
    // upright by default and add() only turns it around Y, so without this the rugs rose up as
    // floating dark plates in the middle of rooms that you could walk straight through.
    for (const r of l.rooms) {
      if (r.w < 6 || r.h < 5) continue;
      if (r.kind !== 'office' && r.kind !== 'lobby' && r.kind !== 'bedroom' && r.kind !== 'club') continue;
      const fy = (r.floorY ?? 0) + 0.014;
      const rug = new THREE.PlaneGeometry(Math.min(r.w - 3, 3.6), Math.min(r.h - 3, 2.6));
      rug.rotateX(-Math.PI / 2);
      add(rugs[(r.id + l.index) % rugs.length], rug, r.x + r.w / 2, fy, r.z + r.h / 2, 0);
    }

    for (const [mat, geos] of buckets) {
      if (!geos.length) continue;
      const merged = mergeGeometries(geos, false);
      for (const q of geos) q.dispose();
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, mat);
      mesh.receiveShadow = quality >= 2;
      g.add(mesh);
    }

    // Ceiling grilles: a pair per larger room, just below the lamps.
    for (const r of l.rooms) {
      if (r.kind !== 'corridor' && r.kind !== 'office' && r.kind !== 'warehouse') continue;
      if (r.w < 5 || r.h < 5) continue;
      const y = (r.floorY ?? 0) + 2.975;
      for (let i = 0; i < 2; i++) {
        const x = r.x + 1.5 + ((i + 0.5) * (r.w - 3)) / 2, z = r.z + 1.5 + ((i + 0.5) * (r.h - 3)) / 2;
        if (x >= r.x + r.w - 1 || z >= r.z + r.h - 1) continue;
        g.add(box(0.62, 0.03, 0.32, ventMat, x, y, z));
      }
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
        wrap.userData.sharedAsset = true; // keep CITY_CACHE template geometry/materials alive
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
        this.retainDetachedResources(grp);
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
        this.retainDetachedResources(grp);
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
    // Kenney CC0 traffic cones (public/models/props/LICENSE.txt) dressing up docks, alleys
    // and cordons. Purely visual: no colliders, so they can never block the squad or a route.
    const addTrafficCones = (spots: [number, number][]) => {
      if (!coneOrangeMat) coneOrangeMat = std({ color: 0xd8541e, roughness: 0.6 });
      if (!coneWhiteMat) coneWhiteMat = std({ color: 0xe8e4da, roughness: 0.55 });
      const coneOrange = coneOrangeMat, coneWhite = coneWhiteMat;
      const buildProcedural = (parent: THREE.Group) => {
        const base = box(0.3, 0.04, 0.3, coneOrange, 0, 0.02, 0);
        base.castShadow = false; base.receiveShadow = true; parent.add(base);
        const c = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.52, 12), coneOrange);
        c.position.y = 0.3; c.castShadow = false; c.receiveShadow = true; parent.add(c);
        const band = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.105, 0.1, 12), coneWhite);
        band.position.y = 0.32; band.castShadow = false; band.receiveShadow = true; parent.add(band);
      };
      extPromises.push(loadConeTemplate().then(tpl => {
        if (this.disposed) return;
        if (!tpl) {
          for (const [x, z] of spots) {
            const grp = new THREE.Group();
            grp.position.set(x, 0, z);
            buildProcedural(grp);
            g.add(grp);
          }
          return;
        }
        for (const [x, z] of spots) {
          const cone = tpl.clone(true);
          cone.position.set(x, 0, z);
          cone.rotation.y = (x * 3.1 + z * 1.7) % (Math.PI * 2);
          cone.traverse((o: any) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = true; } });
          g.add(cone);
        }
      }));
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
      // Street-facing storeys are built from real modular facade tiles (real window recesses and
      // 1K PBR plaster/stone) instead of the old single baked-texture building.
      g.add(box(23.6, 12.2, 17.4, std({ color: 0x1a1f26, roughness: 0.9, emissive: 0x1d1409, emissiveIntensity: 0.55 }), 16.0, 9.5, 11.9));
      extPromises.push(buildFacadeBlock('modular_urban_apartments_facade', { x0: 3.9, z0: 2.9, x1: 28.1, z1: 21.05, y0: 3.34, floors: quality >= 2 ? 4 : 3, seed: 11 }, g, quality, () => !this.disposed, this.ownedGeometry));
      placeCityModel('hotel_neighbor', { x: 39.5, y: 0, z: 10.5, w: 13.5, h: 28.0, d: 11.0, ry: -0.14 });
      placeCityModel('office_tower', { x: -13.5, y: 0, z: 11.5, w: 26.0, h: 12.5, d: 14.0, ry: Math.PI / 2 });
      placeCityModel('hotel_neighbor', { x: 18.0, y: 0, z: -12.0, w: 24.0, h: 11.5, d: 12.0 });
      placeCityModel('metal_trash_can', { x: 9.2, y: 0, z: 24.2 });
      placeCityModel('fire_hydrant', { x: 4.9, y: 0, z: 25.4 });
      placeCityModel('concrete_road_barrier_02', { x: 26.2, y: 0, z: 26.2, ry: 0.18 });
      addTrafficCones([[9.0, 23.8], [18.8, 23.8]]);
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
      addTrafficCones([[13.2, 27.2], [18.6, 27.0], [11.4, 28.6], [35.8, 28.2], [27.2, 26.8]]);
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
      placeCityModel('hotel_neighbor', { x: 23.0, y: 0, z: -12.0, w: 30.0, h: 12.5, d: 14.0 });
      placeCityModel('fire_hydrant', { x: 14.4, y: 0, z: 26.8 });
      addTrafficCones([[19.5, 27.2], [25.5, 27.2]]);
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
      placeCityModel('office_tower', { x: 22.0, y: 3.26, z: 14.4, w: 36.2, h: 14.5, d: 21.2 });
      placeCityModel('bank_annex', { x: -6.5, y: 0, z: 17.0, w: 18.5, h: 12.5, d: 12.0, ry: Math.PI / 2 });
      placeCityModel('bank_annex', { x: 50.5, y: 0, z: 17.0, w: 18.5, h: 12.5, d: 12.0, ry: -Math.PI / 2 });
      placeCityModel('hotel_neighbor', { x: 22.0, y: 0, z: -13.0, w: 26.0, h: 16.0, d: 15.0 });
      for (const bx of [9.6, 11.2, 12.8, 18.2, 19.8]) addBollard(bx, 27.1);
      addShrub(12.3, 25.7); addShrub(18.7, 25.7);
      addTree(7.8, 26.2, 1.6); addTree(30.8, 26.2, 1.6);
      for (const lx of [12.5, 15.5, 18.5]) addLight(lx, 5.8, 25.8, 0xffdfb8, 18, 12, 1.5);
      placeCityModel('concrete_road_barrier_02', { x: 21.8, y: 0, z: 28.4 });
      addTrafficCones([[9.0, 28.6], [21.8, 27.4]]);
      placeCityModel('fire_hydrant', { x: 6.4, y: 0, z: 27.4 });
      addStreetLamp(6.2, 26.8, 0xffe4b8);
      addStreetLamp(32.5, 26.8, 0xffe4b8, Math.PI);
    } else if (l.theme === 'club') {
      const brick = std({ map: T.brickTex('club_ext', '#261e2a', '#1b1520') });
      g.add(box(32.2, 0.26, 21.2, brick, 20.0, 3.22, 13.4));
      placeCityModel('club_main', { x: 20.0, y: 3.24, z: 13.4, w: 32.2, h: 13.5, d: 21.2 });
      placeCityModel('club_alley', { x: -4.2, y: 0, z: 22.0, w: 14.0, h: 12.0, d: 14.0, ry: Math.PI / 2 });
      placeCityModel('club_alley', { x: 34.5, y: 0, z: 24.5, w: 14.0, h: 12.0, d: 14.0, ry: -Math.PI / 2 });
      placeCityModel('hotel_neighbor', { x: 48.0, y: 0, z: 12.0, w: 18.0, h: 11.0, d: 11.0, ry: -Math.PI / 2 });
      placeCityModel('modular_fire_escape', { x: 4.8, y: 2.6, z: 27.0, ry: Math.PI / 2, scale: 0.72 });
      placeCityModel('metal_trash_can', { x: 6.8, y: 0, z: 28.4, ry: Math.PI / 2 });
      addTrafficCones([[10.5, 26.8], [12.0, 28.4], [23.0, 28.2]]);
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
          panel.userData.sharedAsset = true;
          panel.position.set(fx, 1.24, fz);
          panel.scale.set(1.04, 0.96, 1.0);
          g.add(panel);
          const post = postSrc.clone(true);
          post.userData.sharedAsset = true;
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
      addTrafficCones([[sx - 5.2, fz + 1.2], [sx + 5.2, fz + 1.2], [sx - 3.6, fz + 2.2]]);
      placeCityModel('metal_trash_can', { x: 6.4, y: 0, z: fz + 0.9 });
      addTree(4.5, fz + 1.4, 1.5); addTree(36.6, fz + 1.4, 1.5);
    } else if (l.theme === 'tower') {
      // Kista-inspired glass-and-steel campus: the licensed office-tower asset is a skyline
      // silhouette beyond the playable perimeter, while the actual F1/F2 walls remain walkable.
      // A steel canopy on two posts marks the entrance; there is deliberately no glass screen in
      // front of the facade — one stood here with no collider, so the building read as a solid
      // glass wall and you walked through it to get in. The facade's own entrance panes do the job.
      const steel = std({ color: 0x202a35, roughness: 0.32, metalness: 0.72 });
      g.add(box(12.4, 0.22, 3.0, steel, 8.5, 3.12, 34.2));
      for (const x of [3.2, 13.8]) g.add(box(0.22, 3.05, 0.22, steel, x, 1.52, 34.5));
      const entrySign = new THREE.Mesh(new THREE.PlaneGeometry(4.8, 0.62), new THREE.MeshBasicMaterial({ map: T.signTex('KISTA TECH CENTER', '#0c1624', '#dbeafe', '#3b82f6') }));
      entrySign.position.set(8.5, 3.5, 35.73); entrySign.rotation.y = Math.PI; g.add(entrySign);
      const exitSign = new THREE.Mesh(new THREE.PlaneGeometry(1.35, 0.28), new THREE.MeshBasicMaterial({ map: T.signTex('NÖDUTGÅNG · EXIT', '#093818', '#52ff88', '#34e86a') }));
      exitSign.position.set(8.5, 2.48, 32.87); g.add(exitSign);
      for (const x of [5.2, 8.5, 11.8]) addLight(x, 2.85, 34.6, 0xdbeafe, 16, 12, 1.45);
      placeCityModel('office_tower', { x: 44.5, y: 0, z: -14.5, w: 31, h: 34, d: 21, ry: -0.12 });
      placeCityModel('office_tower', { x: -13.5, y: 0, z: 10.0, w: 22, h: 18, d: 15, ry: Math.PI / 2 });
      placeCityModel('street_lamp_01', { x: 2.6, y: 0, z: 36.3, scale: 1.1 });
      placeCityModel('street_lamp_02', { x: 15.3, y: 0, z: 36.1, scale: 1.05 });
      addLight(2.6, 4.2, 36.3, 0xcde7ff, 12, 13, 1.5);
      addLight(15.3, 4.0, 36.1, 0xcde7ff, 12, 13, 1.5);
      placeCityModel('metal_trash_can', { x: 16.8, y: 0, z: 35.9 });
      addBollard(4.0, 36.0); addBollard(13.0, 36.0);
      addTrafficCones([[2.0, 35.2], [15.8, 35.0]]);
    }
    if (l.vehicle) {
      extPromises.push(this.spawnPoliceUnit(l.vehicle.x, l.vehicle.z, l.vehicle.yaw, quality));
    }
    this.readyPromise = Promise.all(extPromises).then(() => {});
  }
  private async spawnPoliceUnit(x: number, z: number, yaw: number, quality: number) {
    try {
      const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync('./models/vehicle/marauder.glb');
      if (this.disposed) { disposeLoadedObjectResources(gltf.scene); return; }
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
    // Landing doors follow the car's state: opening, held open, closing, and open again on arrival.
    for (const v of this.liftViews) {
      const car = this.sim.elevators[v.id];
      const elevator = this.sim.level.elevators[v.id];
      if (!car || !elevator) continue;
      const k = Math.max(0, Math.min(1, car.door));
      v.left.position.x = -0.2725 - k * 0.55;
      v.right.position.x = 0.2725 + k * 0.55;
      v.left.visible = k < 0.995;
      v.right.visible = k < 0.995;
      const stop = elevator.stops[v.stopIndex];
      const to = elevator.stops[car.target];
      const goingUp = to.floorY > stop.floorY;
      const active = car.phase !== 'idle';
      v.up.color.setHex(active && goingUp ? 0xffb545 : 0x1b2a33);
      v.down.color.setHex(active && !goingUp ? 0xffb545 : 0x1b2a33);
      // The indicator lights the landing the car is actually at, and the pip rides between floors.
      v.floorLamps.forEach((m, i) => m.color.setHex(car.at === i ? (i === 1 ? 0x9ee8ff : 0xffd88a) : 0x1b2a33));
      const pipFloor = car.phase === 'moving' ? car.at + (car.target - car.at) * Math.max(0, Math.min(1, car.travel)) : car.at;
      v.carPip.position.y = 2.57 + pipFloor * 0.12;
      v.cabButtons.forEach((m, i) => m.color.setHex(car.at === i ? (i === 1 ? 0x9ee8ff : 0xffd88a) : 0x1b2a33));
      // The landing button lights for the trip, and blinks while the empty car is on its way over.
      const atLanding = active && car.phase !== 'moving';
      const blink = Math.sin(this.sim.time * 9) > -0.2;
      const calling = !!car.pending || car.calling;
      const callUpLit = calling ? car.at < v.stopIndex && blink : atLanding && goingUp;
      const callDownLit = calling ? car.at > v.stopIndex && blink : atLanding && !goingUp;
      v.callUp.color.setHex(callUpLit ? 0xffb545 : 0x1b2a33);
      v.callDown.color.setHex(callDownLit ? 0xffb545 : 0x1b2a33);
      const warm = 0.06 + k * 1.25;
      v.cabLight.color.setRGB(warm * 1.0, warm * 0.86, warm * 0.66);
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
        g.position.set(ev.x, groundHeightAt(this.sim.level, ev.x, ev.z) + 0.01, ev.z);
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
      puck.position.set(sn.x, (sn.floorY ?? groundHeightAt(this.sim.level, sn.x, sn.z)) + 1.3, sn.z);
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
        ring.position.set(pg.x, pg.y ?? groundHeightAt(this.sim.level, pg.x, pg.z) + 0.9, pg.z);
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
        group.position.y = (prop.floorY ?? groundHeightAt(this.sim.level, prop.cx, prop.cz)) + 0.2;
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
    g.obj.rotation.z = -this.leanK * 0.28;
    g.obj.position.x = this.leanK * 0.12;
    g.obj.position.y = -P_DROP() * this.kneelK - (a.kind === 'player' && a.crouch && a.alive ? 0.25 : 0) + this.proneK * 0.2 + (a.alive ? a.jumpY : 0); g.obj.position.z = this.proneK * 0.8;
    if (g.gun) g.gun.visible = armed && a.alive && !a.down && !a.downed;
    if (this.op) {
      // Feet are planted on the floor only while he is actually standing on it (not crouched, prone, downed or airborne).
      const plant = a.alive && !a.crouch && !a.prone && !a.down && !a.downed && a.jumpY <= 0.01;
      this.op.update(g, dt, { alive: a.alive, aim: !!a.target || a.ads || this.shootT > 0, armed, plant }); this.gun.visible = false;
    }
    else if (this.rifle) { this.gun.visible = armed && a.alive; const G = (window as any).__gun; if (G) { this.gun.position.set(G.p[0], G.p[1], G.p[2]); this.gun.rotation.set(G.r[0], G.r[1], G.r[2]); this.gun.scale.setScalar(G.s); } }
    if (this.label) this.label.visible = a.alive;
    if (this.dropped) this.dropped.visible = !a.armed || !a.alive;
    if (!a.alive) {
      if (!this.pool) { const pm = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: T.bloodTex(), transparent: true, depthWrite: false, opacity: 0.92 })); pm.rotation.x = -Math.PI / 2; pm.rotation.z = a.id * 1.7; pm.position.set(0, 0.016 + (a.id % 7) * 0.0006, 0.5); this.root.add(pm); this.pool = pm; }
      this.poolT = Math.min(1, this.poolT + dt / 5); const e = 1 - (1 - this.poolT) * (1 - this.poolT); this.pool.scale.setScalar(0.35 + e * (1.25 + (a.id % 3) * 0.2));
    }
  }
  private kneelK = 0; private proneK = 0; private leanK = 0;
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
  update(dt: number, time: number, floorY = 0) {
    const a = this.a, k = Math.min(1, dt * 12), r = this.root;
    r.position.y = lerp(r.position.y, floorY, Math.min(1, dt * 22));
    const leanTarget = a.alive && !a.down && !a.downed && !a.prone ? Math.max(-1, Math.min(1, a.lean)) : 0;
    this.leanK = lerp(this.leanK, leanTarget, Math.min(1, dt * 12));
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
          // The label map is a shared entry in the global procedural texture cache.
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
        // The label map is a shared entry in the global procedural texture cache.
        mat.map = T.labelTex(a.name.slice(0, 7), '#' + tcol.toString(16));
        mat.needsUpdate = true;
      }
    }
    if (a.kind !== 'officer' && a.kind !== 'player' && a.name !== 'Suspect' && a.name !== 'Civilian' && a.name !== 'VIP Hostage' && !this.label) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: T.labelTex(a.name.slice(0, 10), '#f2c14e'), transparent: true, depthWrite: false }));
      sp.scale.set(0.46, 0.22, 1); sp.position.y = 2.05; this.root.add(sp); this.label = sp;
    }
    const dx = a.x - r.position.x, dz = a.z - r.position.z;
    if (dx * dx + dz * dz > 0.25 * 0.25) {
      // Do not smooth a collision correction or network reconciliation through a wall/prop.
      r.position.x = a.x; r.position.z = a.z;
    } else {
      r.position.x = lerp(r.position.x, a.x, Math.min(1, dt * 25));
      r.position.z = lerp(r.position.z, a.z, Math.min(1, dt * 25));
    }
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
    const b = this.body; b.position.x = lerp(b.position.x, this.leanK * 0.12, k); b.position.y = lerp(b.position.y, by + this.fall * 0.14, k);
    const f = this.fall * this.fall * (3 - 2 * this.fall); b.rotation.x = f * (Math.PI / 2) * (a.id % 2 ? 1 : -1); b.rotation.z = f * ((a.id % 3) - 1) * 0.2 - this.leanK * 0.28;
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
  private laserDot: THREE.Sprite;
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
    // A flat sprite, not a sphere: its size is set from the distance every frame, so the dot keeps
    // the same small size on screen instead of ballooning when the player stands close to a wall.
    this.laserDot = new THREE.Sprite(new THREE.SpriteMaterial({ map: T.glowTex(), color: 0xff2a1e, transparent: true, opacity: 0.95, depthWrite: false }));
    this.laserDot.visible = false; this.laserDot.renderOrder = 3; this.group.add(this.laserDot);
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
  /** The laser dot and its beam. `dotDist` is the distance from the eye to the dot, used to keep the dot a constant small size on screen. */
  setLaser(on: boolean, x = 0, y = 0, z = 0, ox = 0, oy = 0, oz = 0, irBeam = false, dotDist = 6) {
    this.laserDot.visible = on;
    this.irBeam.visible = on;
    if (!on) return;
    this.laserDot.position.set(x, y, z);
    // ~6 px on screen at any distance: the world size grows with the distance
    this.laserDot.scale.setScalar(Math.max(0.004, dotDist * 0.009));
    const mat = this.laserDot.material as THREE.SpriteMaterial;
    mat.color.setHex(irBeam ? 0x80ff98 : 0xff2a1e);
    const beam = this.irBeam.material as THREE.LineBasicMaterial;
    beam.color.setHex(irBeam ? 0x64ff88 : 0xff2a1e);
    beam.opacity = irBeam ? 0.5 : 0.26;
    const p = this.irBeam.geometry.attributes.position as THREE.BufferAttribute;
    p.setXYZ(0, ox, oy, oz);
    p.setXYZ(1, x, y, z);
    p.needsUpdate = true;
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
  marker(x: number, z: number, color: number, floorY = 0) {
    const m = new THREE.Mesh(new THREE.RingGeometry(0.32, 0.42, 28), new THREE.MeshBasicMaterial({ color, transparent: true, depthTest: false, side: THREE.DoubleSide })); m.rotation.x = -Math.PI / 2; m.position.set(x, floorY + 0.05, z); m.renderOrder = 5; this.group.add(m); this.markers.push({ m, t: 2.5 });
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
      const particleFloor = groundHeightAt(sim.level, this.pos[j * 3], this.pos[j * 3 + 2]) + 0.02;
      if (this.pos[j * 3 + 1] < particleFloor) { this.pos[j * 3 + 1] = particleFloor; this.vel[j * 3] = this.vel[j * 3 + 2] = 0; }
    }
    this.pts.geometry.attributes.position.needsUpdate = true; this.pts.geometry.attributes.color.needsUpdate = true;
    for (const t of this.tracers) if (t.line.visible) { t.t -= dt; if (t.t <= 0) t.line.visible = false; }
    for (const d of this.debrisList) {
      if (!d.m.visible || d.settled) continue;
      d.vy -= 9.8 * dt;
      d.m.position.x += d.vx * dt; d.m.position.y += d.vy * dt; d.m.position.z += d.vz * dt;
      d.m.rotation.x += d.rx * dt; d.m.rotation.z += d.rz * dt;
      const debrisFloor = groundHeightAt(sim.level, d.m.position.x, d.m.position.z) + 0.012;
      if (d.m.position.y <= debrisFloor) {
        d.m.position.y = debrisFloor;
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
        g.position.set(cl.x, cl.y ?? groundHeightAt(sim.level, cl.x, cl.z), cl.z);
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
      const shellFloor = groundHeightAt(sim.level, s.m.position.x, s.m.position.z) + 0.015;
      if (s.m.position.y > shellFloor || s.vy > 0.05) {
        s.vy -= 9.8 * dt;
        s.m.position.x += s.vx * dt; s.m.position.y += s.vy * dt; s.m.position.z += s.vz * dt;
        if (s.m.position.y <= groundHeightAt(sim.level, s.m.position.x, s.m.position.z) + 0.015) {
          s.m.position.y = groundHeightAt(sim.level, s.m.position.x, s.m.position.z) + 0.015;
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
