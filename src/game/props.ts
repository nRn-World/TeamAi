// Realistic 3D furniture, plants, trees & flowers (Poly Haven CC0, Khronos CC0, Sketchfab/Objaverse CC BY 4.0).
// See public/models/props/LICENSE.txt and Settings -> Credits for attributions.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Prop } from '../sim/level';

const PROP_FILES = {
  plant_leafy: { file: 'plant_leafy.glb', fit: 'h', size: 1.12, maxXZ: 0.94, doubleSide: true },
  plant_succulent: { file: 'plant_succulent.glb', fit: 'h', size: 0.44, doubleSide: true },
  plant_urn: { file: 'plant_urn.glb', fit: 'h', size: 1.55, maxXZ: 0.92, doubleSide: true },
  flowers: { file: 'flowers.glb', fit: 'h', size: 0.44, doubleSide: true },
  geranium: { file: 'geranium.glb', fit: 'xz', size: 0.72, doubleSide: true },
  rose_bush: { file: 'rose_bush.glb', fit: 'xz', size: 0.68, doubleSide: true },
  planter_box: { file: 'planter_box.glb', fit: 'xz', size: 1.12, doubleSide: false },
  armchair: { file: 'armchair.glb', fit: 'h', size: 1.06, maxXZ: 0.92, doubleSide: false },
  greenchair: { file: 'greenchair.glb', fit: 'h', size: 1.06, maxXZ: 0.92, doubleSide: false },
  sofa: { file: 'sofa.glb', fit: 'xz', size: 1.88, doubleSide: false },
  desk: { file: 'desk.glb', fit: 'xz', size: 1.88, doubleSide: false },
  desk_pc: { file: 'desk_pc.glb', fit: 'h', size: 1.26, maxXZ: 1.84, doubleSide: false },
  shelf: { file: 'shelf.glb', fit: 'h', size: 2.02, maxXZ: 0.96, doubleSide: false },
  bed: { file: 'bed.glb', fit: 'xz', size: 1.94, doubleSide: false },
  crate: { file: 'crate.glb', fit: 'xz', size: 0.94, doubleSide: false },
  locker: { file: 'locker.glb', fit: 'h', size: 1.94, maxXZ: 1.86, doubleSide: false },
  bar: { file: 'bar.glb', fit: 'xz', size: 1.92, doubleSide: false },
} as const;

export type PropAssetKey = keyof typeof PROP_FILES;

interface NormEntry {
  scene: THREE.Group;
  size: THREE.Vector3;
}

const TPL: Partial<Record<PropAssetKey, NormEntry>> = {};
const WAITERS: (() => void)[] = [];
export let propsReady = false;
let loadingPromise: Promise<void> | null = null;

function normalizeAsset(src: THREE.Object3D, spec: (typeof PROP_FILES)[PropAssetKey]): NormEntry {
  src.updateMatrixWorld(true);
  src.traverse((o: any) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = true;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m) continue;
      if ('envMapIntensity' in m) m.envMapIntensity = 0.85;
      if (spec.doubleSide && (m.alphaTest > 0 || m.transparent || /leaf|foliage|petal|flower|plant|rose|geranium/i.test(m.name || ''))) {
        m.side = THREE.DoubleSide;
      }
      if (m.alphaTest > 0 && m.alphaTest < 0.25) m.alphaTest = 0.25;
    }
  });

  const rawBox = new THREE.Box3().setFromObject(src);
  const rawSize = rawBox.getSize(new THREE.Vector3());
  const rawCenter = rawBox.getCenter(new THREE.Vector3());

  let scale = 1;
  if (spec.fit === 'xz') {
    scale = spec.size / Math.max(rawSize.x, rawSize.z, 0.001);
  } else {
    scale = spec.size / Math.max(rawSize.y, 0.001);
    if ('maxXZ' in spec && spec.maxXZ) {
      const xz = Math.max(rawSize.x, rawSize.z) * scale;
      if (xz > spec.maxXZ) scale *= spec.maxXZ / xz;
    }
  }

  const wrap = new THREE.Group();
  src.position.set(-rawCenter.x * scale, -rawBox.min.y * scale, -rawCenter.z * scale);
  src.scale.setScalar(scale);
  wrap.add(src);
  wrap.updateMatrixWorld(true);

  const finalSize = new THREE.Box3().setFromObject(wrap).getSize(new THREE.Vector3());
  return { scene: wrap, size: finalSize };
}

export function loadProps(base = './models/props/'): Promise<void> {
  if (loadingPromise) return loadingPromise;
  const loader = new GLTFLoader();
  loadingPromise = Promise.allSettled(
    (Object.keys(PROP_FILES) as PropAssetKey[]).map(async key => {
      const spec = PROP_FILES[key];
      const gltf = await loader.loadAsync(base + spec.file);
      TPL[key] = normalizeAsset(gltf.scene, spec);
    }),
  ).then(() => {
    propsReady = Object.keys(TPL).length > 0;
    for (const fn of WAITERS.splice(0)) fn();
  });
  return loadingPromise;
}

export function onPropsReady(fn: () => void): void {
  if (propsReady) fn();
  else WAITERS.push(fn);
}

function cloneAsset(key: PropAssetKey): { obj: THREE.Group; size: THREE.Vector3 } | null {
  const entry = TPL[key];
  if (!entry) return null;
  return { obj: entry.scene.clone(true), size: entry.size.clone() };
}

const pedestalWood = new THREE.MeshStandardMaterial({ color: 0x3a2d24, roughness: 0.65, metalness: 0.08 });
const pedestalStone = new THREE.MeshStandardMaterial({ color: 0x2a2e35, roughness: 0.72, metalness: 0.15 });
const soilMat = new THREE.MeshStandardMaterial({ color: 0x2a2118, roughness: 0.96, metalness: 0 });
const PED_CYL = new THREE.CylinderGeometry(0.18, 0.21, 0.56, 14);
const PLINTH_BOX = new THREE.BoxGeometry(0.74, 0.34, 0.74);
const SOIL_BOX = new THREE.BoxGeometry(0.8, 0.08, 0.32);

function onStand(key: PropAssetKey, h = 0.56): THREE.Group | null {
  const c = cloneAsset(key);
  if (!c) return null;
  const g = new THREE.Group();
  const stand = new THREE.Mesh(PED_CYL, pedestalWood);
  stand.scale.y = h / 0.56;
  stand.position.y = h / 2;
  stand.castShadow = true;
  stand.receiveShadow = true;
  c.obj.position.y = h;
  g.add(stand, c.obj);
  return g;
}

/** Realistic 3D model for an interior prop cell, or null if assets aren't loaded yet. */
export function propModel(kind: Prop['kind'], seed: number, high: boolean): THREE.Group | null {
  const g = new THREE.Group();
  switch (kind) {
    case 'crate': {
      const addPair = (y: number, rotY: number, sc = 1) => {
        for (const off of [-0.22, 0.22]) {
          const c = cloneAsset('crate');
          if (!c) return 0;
          c.obj.scale.setScalar(sc);
          const dx = Math.cos(rotY) * off * sc, dz = -Math.sin(rotY) * off * sc;
          c.obj.position.set(dx, y, dz);
          c.obj.rotation.y = rotY;
          g.add(c.obj);
        }
        return (TPL.crate?.size.y ?? 0.37) * sc;
      };
      const h1 = addPair(0, ((seed % 5) - 2) * 0.04, 0.98);
      if (!h1) return null;
      const h2 = addPair(h1, Math.PI / 2 + ((seed % 3) - 1) * 0.06, 0.96);
      if (high) {
        const h3 = addPair(h1 + h2, ((seed % 5) - 2) * 0.08, 0.92);
        const h4 = addPair(h1 + h2 + h3, Math.PI / 2, 0.88);
        if (seed % 2 === 0) {
          const top = cloneAsset('crate');
          if (top) {
            top.obj.position.set(0, h1 + h2 + h3 + h4, 0);
            top.obj.rotation.y = 0.35;
            top.obj.scale.setScalar(0.84);
            g.add(top.obj);
          }
        }
      }
      return g;
    }
    case 'pc': {
      const c = cloneAsset('desk_pc');
      if (!c) return null;
      g.add(c.obj);
      // Tag monitor screen position so shooting the PC shatters/darkens the screen
      g.userData.pcMonitor = { x: -0.37, y: 1.03, z: 0, w: 0.62, h: 0.38, rotY: Math.PI / 2 };
      return g;
    }
    case 'desk': {
      const c = cloneAsset('desk');
      if (!c) return null;
      g.add(c.obj);
      const topY = c.size.y - 0.01;
      if (seed % 3 === 0) {
        const fl = cloneAsset('flowers');
        if (fl) {
          fl.obj.position.set(0.45, topY, -0.1);
          g.add(fl.obj);
          g.userData.vase = fl.obj;
        }
      }
      // Desktop LCD monitor + keyboard + tower on executive desk (shootable!)
      const mon = new THREE.Group();
      mon.position.set(0, topY, -0.12);
      const dark = new THREE.MeshStandardMaterial({ color: 0x16191f, roughness: 0.45, metalness: 0.4 });
      const scrMat = new THREE.MeshBasicMaterial({ color: seed % 2 ? 0x265c96 : 0x1e4a78 });
      const bezel = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.38, 0.03), dark);
      bezel.position.set(0, 0.28, 0);
      const scr = new THREE.Mesh(new THREE.PlaneGeometry(0.57, 0.33), scrMat);
      scr.position.set(0, 0.28, 0.017);
      const stand = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.14, 0.06), dark);
      stand.position.set(0, 0.07, -0.02);
      const base = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.02, 0.16), dark);
      base.position.set(0, 0.01, 0);
      const kb = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.02, 0.14), dark);
      kb.position.set(0, 0.01, 0.22);
      mon.add(bezel, scr, stand, base, kb);
      g.add(mon);
      g.userData.deskMonitor = { group: mon, scrMat };
      return g;
    }
    case 'sofa': {
      const c = cloneAsset('sofa');
      if (!c) return null;
      g.add(c.obj);
      return g;
    }
    case 'chair': {
      const c = cloneAsset(seed % 2 === 0 ? 'armchair' : 'greenchair');
      if (!c) return null;
      g.add(c.obj);
      return g;
    }
    case 'shelf': {
      const c = cloneAsset('shelf');
      if (!c) return null;
      g.add(c.obj);
      return g;
    }
    case 'bed': {
      const c = cloneAsset('bed');
      if (!c) return null;
      g.add(c.obj);
      return g;
    }
    case 'locker': {
      const c = cloneAsset('locker');
      if (!c) return null;
      g.add(c.obj);
      return g;
    }
    case 'bar': {
      const c = cloneAsset('bar');
      if (!c) return null;
      g.add(c.obj);
      return g;
    }
    case 'plant': {
      const pick = seed % 5;
      if (pick === 0) return cloneAsset('plant_leafy')?.obj ?? null;
      if (pick === 1) return cloneAsset('plant_urn')?.obj ?? null;
      if (pick === 2) return onStand('flowers', 0.62);
      if (pick === 3) return onStand('plant_succulent', 0.62);
      return onStand('geranium', 0.56);
    }
    default:
      return null;
  }
}

/** Outdoor flower/shrub planter box composed from real 3D models. */
export function exteriorPlanterModel(seed: number): THREE.Group | null {
  const box = cloneAsset('planter_box');
  if (!box) return null;
  const g = new THREE.Group();
  box.obj.scale.setScalar(1.1);
  g.add(box.obj);

  const soil = new THREE.Mesh(SOIL_BOX, soilMat);
  soil.position.y = 0.34;
  g.add(soil);

  const plantKey: PropAssetKey = seed % 3 === 0 ? 'rose_bush' : seed % 3 === 1 ? 'geranium' : 'plant_leafy';
  const offsets = plantKey === 'plant_leafy' ? [0] : [-0.2, 0.2];
  for (let i = 0; i < offsets.length; i++) {
    const pl = cloneAsset(plantKey);
    if (!pl) continue;
    pl.obj.position.set(offsets[i], 0.33, 0);
    pl.obj.rotation.y = (seed + i) * 1.4;
    pl.obj.scale.setScalar(plantKey === 'plant_leafy' ? 0.92 : 0.85);
    g.add(pl.obj);
  }
  return g;
}

/** Tall courtyard/plaza ornamental tree in a stone plinth for building exteriors. */
export function exteriorTreeModel(seed: number, scale = 1.55): THREE.Group | null {
  const urn = cloneAsset('plant_urn');
  if (!urn) return null;
  const g = new THREE.Group();

  const plinth = new THREE.Mesh(PLINTH_BOX, pedestalStone);
  plinth.position.y = 0.17;
  plinth.castShadow = true;
  plinth.receiveShadow = true;
  g.add(plinth);

  urn.obj.position.y = 0.32;
  urn.obj.scale.setScalar(scale);
  urn.obj.rotation.y = (seed % 8) * 0.78;
  g.add(urn.obj);

  // Tuck blooming flowers around the plinth rim for rich street greenery
  const accentKey: PropAssetKey = seed % 2 === 0 ? 'rose_bush' : 'geranium';
  for (const [ox, oz] of [[-0.24, 0.22], [0.24, -0.22]]) {
    const fl = cloneAsset(accentKey);
    if (!fl) continue;
    fl.obj.position.set(ox, 0.32, oz);
    fl.obj.scale.setScalar(0.55);
    fl.obj.rotation.y = seed + ox * 5;
    g.add(fl.obj);
  }
  return g;
}
