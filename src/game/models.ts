// Optional external 3D models (glTF). If public/models/<file> is missing the procedural figures are used.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as skinnedClone } from 'three/examples/jsm/utils/SkeletonUtils.js';

export interface ModelTemplate { scene: THREE.Object3D; clips: THREE.AnimationClip[]; skinned: boolean; credit: string }
export interface ModelInstance { obj: THREE.Object3D; mixer?: THREE.AnimationMixer; idle?: THREE.AnimationAction; walk?: THREE.AnimationAction; run?: THREE.AnimationAction }
export const MODELS: { officer?: ModelTemplate } = {};
export let modelStatus = 'Inbyggda figurer används (ingen 3D-modell inlagd).';

export async function loadModels(base = './models/'): Promise<void> {
  try {
    const cfg = await (await fetch(base + 'models.json', { cache: 'no-cache' })).json(); const o = cfg.officer; if (!o?.file) return;
    const gltf = await new GLTFLoader().loadAsync(base + o.file);
    const src = gltf.scene; src.updateMatrixWorld(true);
    let skinned = false; src.traverse((m: any) => { if (m.isSkinnedMesh) skinned = true; if (m.isMesh) { for (const mt of Array.isArray(m.material) ? m.material : [m.material]) if (mt && 'metalness' in mt) { mt.metalness = Math.min(mt.metalness, 0.25); mt.metalnessMap = null; mt.roughness = Math.max(mt.roughness, 0.6); } m.castShadow = true; m.receiveShadow = false; m.frustumCulled = !m.isSkinnedMesh; } });
    // normalise: feet on the ground, centred, requested height, facing the game's forward (-z)
    const box = new THREE.Box3().setFromObject(src), size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
    const k = (o.height || 1.85) / (size.y || 1);
    const inner = new THREE.Group(); inner.add(src); src.position.set(-c.x, -box.min.y, -c.z); inner.scale.setScalar(k); inner.rotation.y = (o.yaw ?? 180) * Math.PI / 180;
    const wrap = new THREE.Group(); wrap.add(inner);
    MODELS.officer = { scene: wrap, clips: gltf.animations || [], skinned, credit: String(o.credit || '') };
    modelStatus = `3D-modell laddad: ${o.file}` + (skinned && gltf.animations.length ? ` (animationer: ${gltf.animations.map(a => a.name).join(', ')})` : ' (utan animationer – figuren rör sig i fast pose)');
  } catch (e) { /* missing or broken file → procedural figures */ }
}

export function instance(t: ModelTemplate): ModelInstance {
  const obj = t.skinned ? skinnedClone(t.scene) : t.scene.clone(true); const r: ModelInstance = { obj };
  if (t.skinned && t.clips.length) {
    r.mixer = new THREE.AnimationMixer(obj);
    const find = (re: RegExp) => { const c = t.clips.find(c => re.test(c.name)); return c ? r.mixer!.clipAction(c) : undefined; };
    r.idle = find(/idle|stand/i); r.walk = find(/walk/i); r.run = find(/run|sprint/i) || r.walk; r.walk = r.walk || r.run;
    for (const a of new Set([r.idle, r.walk, r.run])) if (a) { a.play(); a.setEffectiveWeight(a === r.idle ? 1 : 0); }
  }
  return r;
}
