import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

// Real weapon models (CC BY 4.0, see public/models/weapons/*/license.txt and the credits in Settings).
// Each template is normalised: metres, muzzle towards -z, up +y, origin at the top of the pistol grip.
type Spec = { dir: string; yaw: number; length: number; grip: [number, number, number] };
const SPECS: Record<'rifle' | 'pistol', Spec> = {
  rifle: { dir: 'm4', yaw: Math.PI / 2, length: 0.84, grip: [-30, -3, 1.9] },   // source: muzzle +x, 187.7 units long
  pistol: { dir: 'glock', yaw: 0, length: 0.202, grip: [-0.31, 4.9, 1.3] },     // source: muzzle -z, 7.54 units long
};
const TPL: Partial<Record<'rifle' | 'pistol', THREE.Group>> = {};
export let weaponsReady = false;

export async function loadWeapons(base = './models/weapons/'): Promise<void> {
  try {
    const loader = new GLTFLoader();
    await Promise.all((Object.keys(SPECS) as ('rifle' | 'pistol')[]).map(async k => {
      const sp = SPECS[k], src = (await loader.loadAsync(base + sp.dir + '/scene.gltf')).scene, drop: THREE.Object3D[] = [];
      src.traverse((o: any) => {
        if (o.isLight || o.isCamera) drop.push(o);
        if (!o.isMesh) return; o.castShadow = true;
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) { // near-black source colours: keep them dark but readable under the game's lights
          const c = m.color as THREE.Color, l = Math.max(c.r, c.g, c.b); if (l < 0.07) c.multiplyScalar(0.07 / Math.max(l, 0.005)); m.metalness = 0.45; m.roughness = 0.5;
        }
      });
      for (const o of drop) o.removeFromParent();
      src.updateMatrixWorld(true);
      // the rifle is exported with a skeleton: bake its pose into plain meshes so copies can be placed freely
      const skinned: THREE.SkinnedMesh[] = []; src.traverse((o: any) => { if (o.isSkinnedMesh) skinned.push(o); });
      for (const sm of skinned) {
        sm.skeleton.update(); const geo = sm.geometry.clone(), pos = geo.getAttribute('position'), v = new THREE.Vector3();
        for (let i = 0; i < pos.count; i++) { sm.getVertexPosition(i, v); pos.setXYZ(i, v.x, v.y, v.z); }
        geo.deleteAttribute('skinIndex'); geo.deleteAttribute('skinWeight'); geo.computeVertexNormals(); geo.computeBoundingBox(); geo.computeBoundingSphere();
        const m = new THREE.Mesh(geo, sm.material); m.castShadow = true; m.position.copy(sm.position); m.quaternion.copy(sm.quaternion); m.scale.copy(sm.scale); sm.parent!.add(m); sm.removeFromParent();
      }
      src.updateMatrixWorld(true); const bb = new THREE.Box3().setFromObject(src), size = bb.getSize(new THREE.Vector3()), scale = sp.length / Math.max(size.x, size.y, size.z);
      const move = new THREE.Group(); move.add(src); move.position.set(-sp.grip[0], -sp.grip[1], -sp.grip[2]);
      const turn = new THREE.Group(); turn.add(move); turn.rotation.y = sp.yaw; turn.scale.setScalar(scale);
      const g = new THREE.Group(); g.add(turn); TPL[k] = g;
    }));
    weaponsReady = true;
  } catch (e) { console.warn('weapon models', e); }
}
/** A copy of a weapon (shares geometry and materials). Null until the models are loaded. */
export function weaponModel(kind: 'rifle' | 'pistol'): THREE.Group | null { const t = TPL[kind]; return t ? t.clone(true) : null; }
