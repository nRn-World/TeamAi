import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

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

/** Animated first-person arms holding a rifle ("Animated FPS hands" by Cransh, CC BY 4.0). In pistol mode the rifle is
 *  hidden, the support arm is folded away and the Glock sits in the firing hand. */
export class FpsArms {
  root = new THREE.Group(); private mixer!: THREE.AnimationMixer; private act: Record<string, THREE.AnimationAction> = {}; private cur = ''; private busy = 0;
  private rifleParts: THREE.Object3D[] = []; private left: THREE.Object3D[] = []; private glock: THREE.Group | null = null; private weapon = -1;
  muzzle = new THREE.Object3D(); ready = false; private turn = new THREE.Group();
  async load(url = './models/fpsarms/scene.gltf') {
    try {
      const g = await new GLTFLoader().loadAsync(url), sc = g.scene; let cam: THREE.Object3D | null = null, rif: THREE.Object3D | null = null;
      sc.traverse((o: any) => {
        if (o.name.startsWith('Head_Cam_0')) cam = o; if (o.name.startsWith('Hand_R_')) rif = o; if (/^(Arm_L_|IK_Hand_Cntrl_L_|IK_PoleTrgt_L_)/.test(o.name)) this.left.push(o);
        if (!o.isMesh) return; o.frustumCulled = false; const n = o.material.name;
        if (n === 'Silencer') o.visible = false; else if (n !== 'arms') this.rifleParts.push(o);
        o.material.envMapIntensity = 0.9;
        // a few vertices in the source have no bone weights (or hang on the root) and would be drawn as long spikes: bind them to the mesh's main bone
        const sw = o.geometry.getAttribute('skinWeight'), si = o.geometry.getAttribute('skinIndex');
        if (sw && si) { const cnt = new Map<number, number>(), bad: number[] = [];
          const bones = o.skeleton?.bones ?? [];
          for (let i = 0; i < sw.count; i++) { if (sw.getX(i) + sw.getY(i) + sw.getZ(i) + sw.getW(i) < 0.01 || bones[si.getX(i)]?.name === '_rootJoint') bad.push(i); else cnt.set(si.getX(i), (cnt.get(si.getX(i)) ?? 0) + 1); }
          const main = [...cnt].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0; for (const i of bad) { si.setXYZW(i, main, 0, 0, 0); sw.setXYZW(i, 1, 0, 0, 0); } }
      });
      this.mixer = new THREE.AnimationMixer(sc);
      for (const c of g.animations) { const a = this.mixer.clipAction(c); a.clampWhenFinished = true; this.act[c.name.replace(/^.*Anim_/, '')] = a; }
      this.act.Idle.play(); this.cur = 'Idle'; this.mixer.update(0); sc.updateMatrixWorld(true);
      // put the model's own camera bone at the origin, so the game camera sees the arms as the animator did
      const A = ARMS, inner = new THREE.Group(); inner.add(sc);
      if (cam) { const cp = (cam as THREE.Object3D).getWorldPosition(new THREE.Vector3()); inner.position.copy(cp).multiplyScalar(-1); }
      const turn = this.turn; turn.add(inner); turn.rotation.set(A.r[0], A.r[1], A.r[2]); turn.scale.setScalar(A.s); turn.position.set(A.p[0], A.p[1], A.p[2]); this.root.add(turn);
      this.root.add(this.muzzle);
      if (rif) { const gl = weaponModel('pistol'); if (gl) { this.glock = gl; gl.visible = false; gl.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh) { const k = (m.material as THREE.MeshStandardMaterial).clone(); k.color.set(0x1b1c1f); k.metalness = 0.55; k.roughness = 0.5; k.envMapIntensity = 0.6; m.material = k; } }); (rif as THREE.Object3D).add(gl); } }
      this.pose(); this.ready = true;
    } catch (e) { console.warn('fps arms', e); }
    return this.ready;
  }
  /** Re-applies the tunable offsets of the things attached to the rifle bone. */
  pose() {
    const A = ARMS, sc = this.glock?.parent?.getWorldScale(new THREE.Vector3()).x || 1;
    if (this.glock) { this.glock.position.set(A.gp[0], A.gp[1], A.gp[2]); this.glock.rotation.set(A.gr[0], A.gr[1], A.gr[2]); this.glock.scale.setScalar(A.gs / sc); }
  }
  private play(name: string, fade = 0.08, once = false, speed = 1) {
    const a = this.act[name]; if (!a) return; if (this.cur === name && !once) return;
    a.reset(); a.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity); a.timeScale = speed; a.fadeIn(fade).play();
    if (this.cur !== name) this.act[this.cur]?.fadeOut(fade); this.cur = name; this.busy = once ? a.getClip().duration / speed : 0;
  }
  fire() { if (this.ready) this.play('Shoot', 0.02, true, 1.2); }
  reload(dur: number) { if (this.ready) this.play('Reload_Fast', 0.1, true, this.act.Reload_Fast.getClip().duration / dur); }
  draw() { if (this.ready) this.play('Draw', 0.03, true); }
  /** move: 0 standing, 1 walking, 2 running. */
  update(dt: number, weapon: number, move: number) {
    if (!this.ready) return;
    if (weapon !== this.weapon) { this.weapon = weapon; const r = weapon === 0; const A = ARMS, m = r ? A.mz : A.mzp; this.muzzle.position.set(m[0], m[1], m[2]); this.turn.position.set(A.p[0] + (r ? 0 : A.pp[0]), A.p[1] + (r ? 0 : A.pp[1]), A.p[2] + (r ? 0 : A.pp[2])); this.pose(); for (const o of this.rifleParts) o.visible = r; if (this.glock) this.glock.visible = !r; }
    if (this.busy > 0) { this.busy -= dt; if (this.busy <= 0) this.play(move === 2 ? 'Run' : move ? 'Walk' : 'Idle', 0.12); }
    else this.play(move === 2 ? 'Run' : move ? 'Walk' : 'Idle', 0.18);
    for (const b of this.left) { const o = b.userData.off as THREE.Vector3 | undefined; if (o) { b.position.sub(o); b.userData.off = undefined; } } // bones without a position track keep last frame's offset
    this.mixer.update(dt);
    if (this.weapon !== 0) { // pistol: one-handed, so drop the support arm out of sight (the clip repositions it every frame)
      const down = new THREE.Vector3(0, -1.5, 0).applyQuaternion(this.root.getWorldQuaternion(new THREE.Quaternion()));
      for (const b of this.left) { const par = b.parent!; const o = down.clone().applyQuaternion(par.getWorldQuaternion(new THREE.Quaternion()).invert()).divideScalar(par.getWorldScale(new THREE.Vector3()).x || 1); b.position.add(o); b.userData.off = o; }
    }
  }
}
const ARMS = { p: [0.085, -0.055, -0.02], r: [0, Math.PI + 0.06, 0], s: 1, mz: [0.15, -0.1, -0.95], mzp: [0.1, -0.08, -0.6], pp: [-0.08, 0.06, -0.22], gp: [0, 0.08, -0.05], gr: [-Math.PI / 2, Math.PI, 0], gs: 1 };
/** Soft reflections for the metal parts of the first-person weapon. */
export function studioEnv(r: THREE.WebGLRenderer) { const pm = new THREE.PMREMGenerator(r), t = pm.fromScene(new RoomEnvironment(), 0.04).texture; pm.dispose(); return t; }
