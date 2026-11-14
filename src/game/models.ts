// Rigged, animated characters: Quaternius "Ultimate Modular Men" (CC0), packed by tools/pack_models.py into public/models/.
// If the files cannot be loaded the game falls back to its built-in block figures.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as skinnedClone } from 'three/examples/jsm/utils/SkeletonUtils.js';

const FILES = ['swat', 'punk', 'hoodie', 'casual', 'suit', 'worker', 'wcasual', 'wformal'] as const;
type Name = typeof FILES[number];
const TPL: Partial<Record<Name, THREE.Object3D>> = {};
let clips: THREE.AnimationClip[] = [], clipsW: THREE.AnimationClip[] = [], unit = 1, pistol: { geo: THREE.BufferGeometry; mat: THREE.Material | THREE.Material[] }[] = [];
export let modelsReady = false;
export const HEIGHT = 1.8;

export async function loadModels(base = './models/'): Promise<void> {
  try {
    const loader = new GLTFLoader();
    const all = await Promise.all(FILES.map(f => loader.loadAsync(base + f + '.glb')));
    all.forEach((gltf, i) => {
      const src = gltf.scene; src.updateMatrixWorld(true);
      src.traverse((m: any) => {
        if (!m.isMesh) return; m.castShadow = true; m.receiveShadow = false; m.frustumCulled = false;
        for (const mt of Array.isArray(m.material) ? m.material : [m.material]) { mt.metalness = 0; mt.roughness = 0.85; mt.flatShading = true; }
        if (i === 0 && isPistol(m)) pistol.push({ geo: m.geometry, mat: m.material });
      });
      const box = new THREE.Box3().setFromObject(src), k = HEIGHT / (box.max.y - box.min.y || 1);
      const inner = new THREE.Group(); inner.add(src); inner.scale.setScalar(k); inner.rotation.y = Math.PI; // models face +z, the game's forward is -z
      const wrap = new THREE.Group(); wrap.add(inner); TPL[FILES[i]] = wrap;
      if (i === 0) { clips = gltf.animations; unit = k; }
      if (FILES[i] === 'wcasual') clipsW = gltf.animations;
    });
    modelsReady = clips.length > 0;
  } catch { modelsReady = false; }
}

const isPistol = (o: THREE.Object3D) => o.name.startsWith('Pistol') || !!o.parent?.name.startsWith('Pistol');
const TINT = new Set(['Purple', 'Red_Dark', 'LightBrown', 'Tie', 'Red', 'Orange', 'LimeGreen']);
/** A pistol lying on the floor (static copy of the characters' pistol). */
export function droppedPistol(): THREE.Group {
  const g = new THREE.Group(), inner = new THREE.Group(); const c = new THREE.Vector3();
  for (const p of pistol) { const m = new THREE.Mesh(p.geo, p.mat); m.castShadow = true; inner.add(m); if (!p.geo.boundingBox) p.geo.computeBoundingBox(); }
  if (pistol.length) pistol[0].geo.boundingBox!.getCenter(c);
  inner.position.copy(c).multiplyScalar(-1); const tilt = new THREE.Group(); tilt.add(inner); tilt.rotation.z = Math.PI / 2; tilt.scale.setScalar(unit * 1.15); g.add(tilt); return g;
}
/** Which model a character uses (women for the characters that speak with the female voice). */
export function modelFor(kind: string, id: number): Name {
  if (kind === 'suspect') return id % 5 === 2 ? 'wcasual' : (['punk', 'hoodie'] as const)[id % 2];
  if (kind === 'civ') return (['wcasual', 'suit', 'wformal', id % 2 ? 'casual' : 'worker', 'wcasual'] as const)[id % 5];
  return 'swat';
}
export class Rig {
  obj: THREE.Object3D; mixer: THREE.AnimationMixer; private act: Record<string, THREE.AnimationAction> = {}; cur = ''; bones: Record<string, THREE.Bone> = {}; gun: THREE.Object3D | null = null;
  constructor(kind: string, id: number) {
    const name = modelFor(kind, id);
    this.obj = skinnedClone(TPL[name]!); let skinned: THREE.SkinnedMesh | null = null;
    const mats = new Map<THREE.Material, THREE.Material>();
    this.obj.traverse((o: any) => {
      if (o.isBone) this.bones[o.name] = o;
      if (o.name === 'Pistol') this.gun = o;
      if (o.isSkinnedMesh && !isPistol(o)) skinned = skinned ?? o;
      if (o.isMesh && name !== 'swat') { // give every suspect / civilian their own clothes and skin tone
        const conv = (m: THREE.Material) => { let c = mats.get(m); if (!c) { c = m.clone(); const col = (c as THREE.MeshStandardMaterial).color; if (kind === 'suspect' && (TINT.has(m.name) || m.name === 'White' || m.name === 'Grey')) col.multiplyScalar(m.name === 'White' ? 0.3 : 0.28); else if (kind === 'suspect' && m.name.startsWith('Hair')) col.setHex(0x0c0c0c); else if (kind === 'suspect' && m.name === 'LightBlue') col.multiplyScalar(0.5); else if (TINT.has(m.name)) col.offsetHSL(((id * 7) % 10) / 10, 0, 0.02); else if (m.name.startsWith('Skin')) col.multiplyScalar([1, 0.8, 0.6, 0.9][id % 4]); mats.set(m, c); } return c; };
        o.material = Array.isArray(o.material) ? o.material.map(conv) : conv(o.material);
      }
    });
    if (!this.gun && kind === 'suspect' && pistol.length && skinned) { // same skeleton in every file, so the pistol can be bound to it
      const sm = skinned as THREE.SkinnedMesh, grp = new THREE.Group(); for (const p of pistol) { const g = new THREE.SkinnedMesh(p.geo, p.mat); g.frustumCulled = false; g.castShadow = true; grp.add(g); g.bind(sm.skeleton, sm.bindMatrix); } sm.parent!.add(grp); this.gun = grp;
    }
    this.mixer = new THREE.AnimationMixer(this.obj);
    for (const c of name.startsWith('w') && clipsW.length ? clipsW : clips) this.act[c.name] = this.mixer.clipAction(c);
    this.play('Idle', 0);
  }
  play(name: string, fade = 0.18, once = false, speed = 1) {
    const next = this.act[name]; if (!next) return; next.timeScale = speed; if (name === this.cur) return;
    const prev = this.act[this.cur]; next.reset(); next.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, once ? 1 : Infinity); next.clampWhenFinished = once;
    next.setEffectiveWeight(1); if (prev && fade > 0) { next.crossFadeFrom(prev, fade, false); } else prev?.stop(); next.play(); this.cur = name;
  }
}
