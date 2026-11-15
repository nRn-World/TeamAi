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

const BOX = new THREE.BoxGeometry(1, 1, 1);
function mkBox(w: number, h: number, d: number, m: THREE.Material, x = 0, y = 0, z = 0) {
  const b = new THREE.Mesh(BOX, m);
  b.scale.set(w, h, d);
  b.position.set(x, y, z);
  return b;
}

/** Upgrade the Glock 17 into a SWAT Tactical Sidearm (two-tone nitride slide & polymer frame,
 *  RMR micro red-dot optic, suppressor-height tritium 3-dot night sights, threaded match barrel,
 *  and SureFire X300U-style under-barrel weapon light). */
function enhanceSwatPistol(root: THREE.Group) {
  const slideMat = new THREE.MeshStandardMaterial({ color: 0x2a303a, metalness: 0.82, roughness: 0.28 });
  const barrelMat = new THREE.MeshStandardMaterial({ color: 0x565e6b, metalness: 0.88, roughness: 0.2 });
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x1a1c20, metalness: 0.08, roughness: 0.84 });
  const steelCtrl = new THREE.MeshStandardMaterial({ color: 0x3b424d, metalness: 0.78, roughness: 0.32 });

  // Apply realistic multi-tone PBR finishes across the Glock's 16 sub-meshes
  root.traverse((o: any) => {
    if (!o.isMesh) return;
    const n = o.name || '';
    if (n === 'Object_4' || n === 'Object_8' || n === 'Object_15') o.material = slideMat;
    else if (n === 'Object_5' || n === 'Object_10' || n === 'Object_14') o.material = barrelMat;
    else if (n === 'Object_6' || n === 'Object_0' || n === 'Object_1' || n === 'Object_11' || n === 'Object_12' || n === 'Object_13') o.material = steelCtrl;
    else o.material = frameMat;
  });

  const attach = new THREE.Group();
  const housing = new THREE.MeshStandardMaterial({ color: 0x16191f, metalness: 0.76, roughness: 0.34 });
  const bezel = new THREE.MeshStandardMaterial({ color: 0x323842, metalness: 0.85, roughness: 0.24 });
  const lensGlass = new THREE.MeshPhysicalMaterial({ color: 0x70c4ff, transparent: true, opacity: 0.22, roughness: 0.05, metalness: 0.1 });
  const redDot = new THREE.MeshBasicMaterial({ color: 0xff2a20 });
  const tritium = new THREE.MeshBasicMaterial({ color: 0x52ff88 });
  const lampLens = new THREE.MeshStandardMaterial({ color: 0xeaf4ff, emissive: 0xfff0d0, emissiveIntensity: 0.9, roughness: 0.15, metalness: 0.2 });

  // 1. Milled Trijicon RMR-style Micro Red-Dot Optic on top of the rear slide (y ≈ 0.047)
  attach.add(
    mkBox(0.026, 0.004, 0.044, housing, 0, 0.0485, 0.012),           // optic mounting plate
    mkBox(0.026, 0.005, 0.042, housing, 0, 0.052, 0.012),            // optic base
    mkBox(0.0032, 0.017, 0.028, housing, -0.0114, 0.061, 0.008),     // left protective hood wall
    mkBox(0.0032, 0.017, 0.028, housing, 0.0114, 0.061, 0.008),      // right protective hood wall
    mkBox(0.026, 0.0032, 0.028, housing, 0, 0.069, 0.008),           // top RMR hood arch
    mkBox(0.018, 0.006, 0.012, housing, 0, 0.056, 0.027),            // rear emitter shroud
  );
  const rmrGlass = new THREE.Mesh(new THREE.PlaneGeometry(0.019, 0.014), lensGlass);
  rmrGlass.position.set(0, 0.061, 0.005);
  attach.add(rmrGlass);
  const dot = new THREE.Mesh(new THREE.SphereGeometry(0.0011, 8, 8), redDot);
  dot.position.set(0, 0.061, 0.006);
  attach.add(dot);

  // 2. Suppressor-height Tritium 3-Dot Night Sights (co-witness with RMR)
  attach.add(
    mkBox(0.005, 0.009, 0.007, housing, -0.0055, 0.051, 0.046),
    mkBox(0.005, 0.009, 0.007, housing, 0.0055, 0.051, 0.046),
    mkBox(0.0045, 0.01, 0.011, housing, 0, 0.0515, -0.132),
  );
  const tRearL = new THREE.Mesh(new THREE.SphereGeometry(0.0009, 6, 6), tritium);
  tRearL.position.set(-0.0055, 0.0525, 0.0496);
  const tRearR = new THREE.Mesh(new THREE.SphereGeometry(0.0009, 6, 6), tritium);
  tRearR.position.set(0.0055, 0.0525, 0.0496);
  const tFront = new THREE.Mesh(new THREE.SphereGeometry(0.0011, 6, 6), tritium);
  tFront.position.set(0, 0.0535, -0.1264);
  attach.add(tRearL, tRearR, tFront);

  // 3. Threaded Match Barrel Extension + Knurled Thread Protector
  const threadBarrel = new THREE.Mesh(new THREE.CylinderGeometry(0.0068, 0.0068, 0.016, 14), barrelMat);
  threadBarrel.rotation.x = Math.PI / 2;
  threadBarrel.position.set(0, 0.0325, -0.146);
  const threadCap = new THREE.Mesh(new THREE.CylinderGeometry(0.0082, 0.0082, 0.009, 14), housing);
  threadCap.rotation.x = Math.PI / 2;
  threadCap.position.set(0, 0.0325, -0.15);
  attach.add(threadBarrel, threadCap);

  // 4. Under-Barrel SureFire X300U-style Tactical Weapon Light
  const lightBody = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.068, 16), housing);
  lightBody.rotation.x = Math.PI / 2;
  lightBody.position.set(0, -0.004, -0.118);
  const lightBezel = new THREE.Mesh(new THREE.CylinderGeometry(0.0138, 0.0132, 0.02, 16), bezel);
  lightBezel.rotation.x = Math.PI / 2;
  lightBezel.position.set(0, -0.004, -0.155);
  const lightGlass = new THREE.Mesh(new THREE.CircleGeometry(0.0112, 16), lampLens);
  lightGlass.rotation.y = Math.PI;
  lightGlass.position.set(0, -0.004, -0.1652);
  attach.add(
    lightBody,
    lightBezel,
    lightGlass,
    mkBox(0.022, 0.012, 0.048, housing, 0, 0.005, -0.116),         // Picatinny rail clamp
    mkBox(0.028, 0.008, 0.014, steelCtrl, 0, -0.002, -0.082),      // ambidextrous paddle switches
  );

  attach.traverse(o => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
  root.add(attach);
}

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
      const g = new THREE.Group(); g.add(turn);
      if (k === 'pistol') enhanceSwatPistol(g);
      TPL[k] = g;
    }));
    weaponsReady = true;
  } catch (e) { console.warn('weapon models', e); }
}
/** A copy of a weapon (shares geometry and materials). Null until the models are loaded. */
export function weaponModel(kind: 'rifle' | 'pistol'): THREE.Group | null { const t = TPL[kind]; return t ? t.clone(true) : null; }

/** Animated first-person arms holding a rifle ("Animated FPS hands" by Cransh, CC BY 4.0). In pistol mode the rifle is
 *  hidden, the support arm is folded away and the SWAT Glock 17 sits in the firing hand. */
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
      if (rif) {
        const gl = weaponModel('pistol');
        if (gl) {
          this.glock = gl;
          gl.visible = false;
          gl.traverse(o => {
            const m = o as THREE.Mesh;
            if (m.isMesh && m.material && 'envMapIntensity' in (m.material as THREE.MeshStandardMaterial)) {
              (m.material as THREE.MeshStandardMaterial).envMapIntensity = 0.95;
            }
          });
          (rif as THREE.Object3D).add(gl);
        }
      }
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
const ARMS = { p: [0.085, -0.055, -0.02], r: [0, Math.PI + 0.06, 0], s: 1, mz: [0.15, -0.1, -0.95], mzp: [0.094, -0.11, -0.53], pp: [-0.08, 0.06, -0.22], gp: [0, 0.08, -0.05], gr: [1.5096, 0.2021, 2.8383], gs: 1 };
/** Soft reflections for the metal parts of the first-person weapon. */
export function studioEnv(r: THREE.WebGLRenderer) { const pm = new THREE.PMREMGenerator(r), t = pm.fromScene(new RoomEnvironment(), 0.04).texture; pm.dispose(); return t; }
