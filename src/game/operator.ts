// The detailed «S.W.A.T. Operator» (CC BY 4.0, see credits) used for the squad in the menu and for every officer in the game.
// The model ships with one animation only (standing ready with the rifle), so in the game it is driven by the animated
// stand-in skeleton: legs and hips follow it all the time, the whole body when the officer goes down, and the arms are
// solved onto the rifle when it is shouldered.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as skinnedClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { Rig, HEIGHT } from './models';
import { weaponModel, buildBallisticShield } from './weapons';

const V = () => new THREE.Vector3(), Q = () => new THREE.Quaternion();
const key = (n: string) => /mixamorig:?(\w+?)_\d+$/.exec(n)?.[1] ?? '';
// stand-in bone -> operator bone, parents before children; `leg` bones always follow the stand-in
const MAP: [string, string, boolean][] = [
  ['Hips', 'Hips', true], ['UpperLegL', 'LeftUpLeg', true], ['LowerLegL', 'LeftLeg', true], ['FootL', 'LeftFoot', true], ['UpperLegR', 'RightUpLeg', true], ['LowerLegR', 'RightLeg', true], ['FootR', 'RightFoot', true],
  ['Abdomen', 'Spine', false], ['Torso', 'Spine1', false], ['Chest', 'Spine2', false], ['Neck', 'Neck', false], ['Head', 'Head', false],
  ['ShoulderL', 'LeftShoulder', false], ['UpperArmL', 'LeftArm', false], ['LowerArmL', 'LeftForeArm', false], ['WristL', 'LeftHand', false],
  ['ShoulderR', 'RightShoulder', false], ['UpperArmR', 'RightArm', false], ['LowerArmR', 'RightForeArm', false], ['WristR', 'RightHand', false],
];
// the bone each one points at (stand-in name, operator name): the two skeletons are lined up by these directions
const AIM: Record<string, [string, string]> = {
  Hips: ['Abdomen', 'Spine'], Spine: ['Torso', 'Spine1'], Spine1: ['Chest', 'Spine2'], Spine2: ['Neck', 'Neck'], Neck: ['Head', 'Head'],
  LeftUpLeg: ['LowerLegL', 'LeftLeg'], LeftLeg: ['FootL', 'LeftFoot'], LeftFoot: ['PTL', 'LeftToeBase'], RightUpLeg: ['LowerLegR', 'RightLeg'], RightLeg: ['FootR', 'RightFoot'], RightFoot: ['PTR', 'RightToeBase'],
  LeftShoulder: ['UpperArmL', 'LeftArm'], LeftArm: ['LowerArmL', 'LeftForeArm'], LeftForeArm: ['WristL', 'LeftHand'], LeftHand: ['Middle1L', 'LeftHandMiddle1'],
  RightShoulder: ['UpperArmR', 'RightArm'], RightArm: ['LowerArmR', 'RightForeArm'], RightForeArm: ['WristR', 'RightHand'], RightHand: ['Middle1R', 'RightHandMiddle1'],
};
const dirIn = (wrap: THREE.Object3D, a: THREE.Object3D, b: THREE.Object3D) => wrap.worldToLocal(b.getWorldPosition(V())).sub(wrap.worldToLocal(a.getWorldPosition(V()))).normalize();
interface Tpl { wrap: THREE.Group; clip: THREE.AnimationClip | null; rest: Record<string, THREE.Quaternion>; dir: Record<string, THREE.Vector3>; hips: THREE.Vector3; gunIn: THREE.Matrix4; lIn: THREE.Matrix4; rIn: THREE.Matrix4 }
let T: Tpl | null = null, SRC: { rest: Record<string, THREE.Quaternion>; hips: THREE.Vector3 } | null = null, loading: Promise<boolean> | null = null;
export const operatorReady = () => !!T;

const bonesOf = (o: THREE.Object3D) => { const b: Record<string, THREE.Bone> = {}; o.traverse((n: any) => { if (n.isBone && key(n.name)) b[key(n.name)] = n; }); return b; };
/** Rotation of a bone in the space of the character wrapper. */
const inWrap = (wrap: THREE.Object3D, b: THREE.Object3D, out = Q()) => b.getWorldQuaternion(out).premultiply(wrap.getWorldQuaternion(Q()).invert());

export function loadOperator(url = './models/operator/scene.gltf'): Promise<boolean> {
  return loading ??= (async () => {
    try {
      const g = await new GLTFLoader().loadAsync(url), scene = g.scene; scene.updateMatrixWorld(true);
      const bb = new THREE.Box3().setFromObject(scene), k = 1.84 / (bb.max.y - bb.min.y);
      scene.traverse((o: any) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = !o.isSkinnedMesh; if (o.material) { o.material.envMapIntensity = 0.6; if (o.material.name === 'eyes') o.material.color.setScalar(0.5); } } });
      const wrap = new THREE.Group(); scene.scale.setScalar(k); scene.position.y = -bb.min.y * k; wrap.add(scene); wrap.updateMatrixWorld(true);
      // The rifle and the two patches are loose objects placed for the first frame of the animation: hang them on the bones they belong to.
      const clip = g.animations[0] ?? null, B = bonesOf(wrap), mixer = new THREE.AnimationMixer(wrap);
      if (clip) { mixer.clipAction(clip).play(); mixer.setTime(0); } wrap.updateMatrixWorld(true);
      const loose: Record<string, string> = { part_2_low_101: 'RightHand', Circle_102: 'LeftArm', Plane_103: 'Spine2' };
      let gun: THREE.Object3D | null = null; const moved: [THREE.Object3D, THREE.Matrix4][] = [];
      for (const [n, bone] of Object.entries(loose)) { const o = wrap.getObjectByName(n); if (o && B[bone]) { B[bone].attach(o); o.updateMatrix(); moved.push([o, o.matrix.clone()]); if (bone === 'RightHand') { gun = o; o.name = 'OperatorRifle'; } } }
      wrap.updateMatrixWorld(true);
      // where the rifle sits relative to the chest, and where each hand sits on the rifle, in the ready pose
      const inv = (o: THREE.Object3D) => new THREE.Matrix4().copy(o.matrixWorld).invert();
      const gunIn = gun ? inv(B.Spine2).multiply(gun.matrixWorld) : new THREE.Matrix4(), lIn = gun ? inv(gun).multiply(B.LeftHand.matrixWorld) : new THREE.Matrix4(), rIn = gun ? inv(gun).multiply(B.RightHand.matrixWorld) : new THREE.Matrix4();
      mixer.stopAllAction(); mixer.uncacheRoot(wrap);
      for (const [o, m] of moved) m.decompose(o.position, o.quaternion, o.scale); // stopping the animation put them back where they were
      if (clip) clip.tracks = clip.tracks.filter(tr => !/^(part_2_low_101|Circle_102|Plane_103)\./.test(tr.name));
      wrap.updateMatrixWorld(true);
      const rest: Record<string, THREE.Quaternion> = {}; const dir: Record<string, THREE.Vector3> = {}; for (const [, t] of MAP) if (B[t]) { rest[t] = inWrap(wrap, B[t]); const c = AIM[t] && B[AIM[t][1]]; if (c) dir[t] = dirIn(wrap, B[t], c); }
      (window as any).__opT = { wrap, B };
      T = { wrap, clip, rest, dir, hips: wrap.worldToLocal(B.Hips.getWorldPosition(V())), gunIn, lIn, rIn };
      return true;
    } catch (e) { console.warn('operator model', e); return false; }
  })();
}
/** A copy for the menu: plays the model's own animation. */
export function menuOperator(phase: number): { obj: THREE.Object3D; mixer: THREE.AnimationMixer | null } | null {
  if (!T) return null; const obj = skinnedClone(T.wrap); let mixer: THREE.AnimationMixer | null = null;
  if (T.clip) { mixer = new THREE.AnimationMixer(obj); mixer.clipAction(T.clip).play(); mixer.setTime(phase); }
  return { obj, mixer };
}

/** Swap the 3D primary weapon & ballistic shield on a menu operator to match the live Loadout selection. */
export function equipOperatorLoadout(obj: THREE.Object3D, primary: 'carbine' | 'shotgun' | 'beanbag' | 'shield', secondary: 'pistol' | 'taser') {
  const opGun = obj.getObjectByName('OperatorRifle');
  if (!opGun) return;
  const B = bonesOf(obj);
  const old = obj.getObjectByName('LoadoutPreviewGroup');
  if (old) old.removeFromParent();
  const oldShield = obj.getObjectByName('LoadoutShieldGroup');
  if (oldShield) oldShield.removeFromParent();
  const oldSec = obj.getObjectByName('LoadoutSecondaryGroup');
  if (oldSec) oldSec.removeFromParent();

  opGun.visible = primary === 'carbine';
  if (primary !== 'carbine' && opGun.parent) {
    const grp = new THREE.Group();
    grp.name = 'LoadoutPreviewGroup';
    const wKind = primary === 'shotgun' ? 'shotgun' : primary === 'beanbag' ? 'beanbag' : (secondary === 'taser' ? 'taser' : 'pistol');
    const mod = weaponModel(wKind);
    if (mod) {
      obj.updateMatrixWorld(true);
      const handWs = opGun.parent.getWorldScale(new THREE.Vector3()).x || 1;
      grp.position.copy(opGun.position);
      grp.quaternion.copy(opGun.quaternion);
      // Map weaponModel (-Z barrel, +Y up) -> OperatorRifle space (+Y barrel, -Z up)
      mod.rotation.set(Math.PI / 2, 0, Math.PI);
      mod.scale.setScalar(1 / handWs);
      if (primary === 'shield') mod.position.set(0, 0.04 / handWs, 0.02 / handWs);
      else mod.position.set(0, 0.22 / handWs, 0.03 / handWs);
      grp.add(mod);
    }
    opGun.parent.add(grp);
  }

  if (primary === 'shield' && B.LeftForeArm) {
    obj.updateMatrixWorld(true);
    const armWs = B.LeftForeArm.getWorldScale(new THREE.Vector3()).x || 1;
    const shWrap = new THREE.Group();
    shWrap.name = 'LoadoutShieldGroup';
    const sh = buildBallisticShield(true);
    sh.scale.setScalar(1 / armWs);
    // Orient shield outward in front of the operator's left arm
    sh.rotation.set(-0.25, 0.65, 0.15);
    sh.position.set(0.05 / armWs, 0.15 / armWs, 0.18 / armWs);
    shWrap.add(sh);
    B.LeftForeArm.add(shWrap);
  }

  // Visible holstered secondary on the right thigh when holding a long gun
  if (primary !== 'shield' && B.RightUpLeg) {
    obj.updateMatrixWorld(true);
    const legWs = B.RightUpLeg.getWorldScale(new THREE.Vector3()).x || 1;
    const secWrap = new THREE.Group();
    secWrap.name = 'LoadoutSecondaryGroup';
    const sec = weaponModel(secondary === 'taser' ? 'taser' : 'pistol');
    if (sec) {
      sec.scale.setScalar(0.95 / legWs);
      sec.rotation.set(-Math.PI / 2, 0, Math.PI / 2);
      sec.position.set(-0.09 / legWs, 0.14 / legWs, 0.01 / legWs);
      secWrap.add(sec);
      B.RightUpLeg.add(secWrap);
    }
  }
}

const P = { // tuning (overridable from the console through window.__op)
  grip: [0.07, 0.02, 0.3],  // where the right hand goes when the rifle is shouldered, from the right shoulder joint (to the left, up, forward) in metres
  twist: -0.55,             // the chest turns so the support arm reaches the handguard
  head: [0.5, 0.12, -0.2],  // the head turns back to the front (share of the twist), tips down and leans to the stock
  env: 0.55,
};
// rifle axes in its own space: the muzzle points along +y, the sights are on -z
const AIMQ = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 1, 0).cross(new THREE.Vector3(0, 0, -1))).transpose())
  .premultiply(new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1).cross(new THREE.Vector3(0, 1, 0)))));
let ENV: THREE.Texture | null = null; const GAME_MATS = new Map<THREE.Material, THREE.Material>();
const PLANT_EVERY = 0.05; // seconds between sole measurements
/** Reflections for the operator's metal and fabric inside the game (the game scene itself has no environment map). */
export function operatorEnv(t: THREE.Texture | null) { ENV = t; }
/** One officer in the game. `obj` faces -z like every other character in the game. */
export class OperatorBody {
  obj = new THREE.Group(); private inner: THREE.Object3D; private B: Record<string, THREE.Bone>; private mixer: THREE.AnimationMixer; private gun: THREE.Object3D | null;
  private deadK = 0; private aimK = 0; private q = Q(); private q2 = Q(); private v = V(); private v2 = V();
  private boots: THREE.SkinnedMesh[] = [];
  // Foot planting: the boots are sampled a few times a second (not every frame) and the whole officer
  // eases towards the result, so the pose cannot make him twitch frame by frame.
  private plantY = 0; private plantWant = 0; private plantT = 0;
  constructor() {
    this.inner = skinnedClone(T!.wrap); this.inner.rotation.y = Math.PI; this.obj.add(this.inner); this.B = bonesOf(this.inner); this.gun = this.inner.getObjectByName('OperatorRifle') ?? null;
    this.inner.traverse((o: any) => {
      if (!o.isMesh) return; if (!o.isSkinnedMesh) o.castShadow = false;
      if (o.isSkinnedMesh && o.material && o.material.name === 'boots') this.boots.push(o);
      let m = GAME_MATS.get(o.material); if (!m) { m = (o.material as THREE.MeshStandardMaterial).clone(); if (ENV) { (m as THREE.MeshStandardMaterial).envMap = ENV; (m as THREE.MeshStandardMaterial).envMapIntensity = P.env; } GAME_MATS.set(o.material, m); } o.material = m;
    });
    this.mixer = new THREE.AnimationMixer(this.inner); if (T!.clip) { const a = this.mixer.clipAction(T!.clip); a.play(); this.mixer.setTime(Math.random() * 7); }
    if (!SRC) { // line the two skeletons up once: the stand-in's reference pose, and the operator turned so that every limb points the same way
      const r = new Rig('officer', 0), w = r.obj.children[0]; r.mixer.stopAllAction(); r.obj.updateMatrixWorld(true);
      const rest: Record<string, THREE.Quaternion> = {};
      for (const [sn, tn] of MAP) { const b = r.bones[sn]; if (!b) continue; rest[sn] = inWrap(w, b); const c = AIM[tn] && r.bones[AIM[tn][0]]; if (c && T!.dir[tn]) T!.rest[tn].premultiply(Q().setFromUnitVectors(T!.dir[tn], dirIn(w, b, c))); }
      SRC = { rest, hips: w.worldToLocal(r.bones.Hips.getWorldPosition(V())) };
    }
  }
  /** Call after the stand-in rig has been animated and placed. */
  update(src: Rig, dt: number, o: { alive: boolean; aim: boolean; armed: boolean; plant: boolean }) {
    const t = T!, S = SRC!, B = this.B, C = (window as any).__op ?? P;
    this.obj.position.copy(src.obj.position); this.obj.rotation.copy(src.obj.rotation);
    this.deadK = Math.min(1, Math.max(0, this.deadK + (o.alive ? -1 : 1) * dt * 5)); this.aimK += ((o.aim && o.alive ? 1 : 0) - this.aimK) * Math.min(1, dt * 9);
    if (o.alive) this.mixer.update(dt);
    src.obj.updateMatrixWorld(true); this.obj.updateMatrixWorld(true);
    const sw = src.obj.children[0], tw = this.inner, twq = tw.getWorldQuaternion(Q()).invert();
    for (const [sn, tn, leg] of MAP) {
      const w = leg ? 1 : this.deadK; if (w <= 0) continue;
      const sb = src.bones[sn], tb = B[tn]; if (!sb || !tb || !S.rest[sn] || !t.rest[tn]) continue;
      const want = inWrap(sw, sb, this.q).multiply(this.q2.copy(S.rest[sn]).invert()).multiply(t.rest[tn]);      // same turn away from the rest pose
      const parent = tb.parent!.getWorldQuaternion(this.q2).premultiply(twq).invert(); want.premultiply(parent);
      if (w >= 1) tb.quaternion.copy(want); else tb.quaternion.slerp(want, w);
      if (tn === 'Hips') { // height and sway of the hips
        const p = sw.worldToLocal(sb.getWorldPosition(this.v)).sub(S.hips).multiplyScalar(t.hips.y / S.hips.y).add(t.hips);
        tb.parent!.updateWorldMatrix(true, false); tb.position.copy(tb.parent!.worldToLocal(tw.localToWorld(p)));
      }
      tb.updateMatrixWorld(true);
    }
    if (this.gun) this.gun.visible = o.armed || !o.alive;
    if (this.aimK > 0.01 && this.gun) this.shoulder(this.aimK * (1 - this.deadK), C);
    // Measure the soles at ~20 Hz and ease the correction in, then move the officer by the eased value.
    if (o.plant && this.deadK <= 0.001) {
      this.plantT -= dt;
      if (this.plantT <= 0) { this.plantWant = this.soleOffset(src); this.plantT = PLANT_EVERY; }
    } else this.plantWant = 0;
    const k = Math.min(1, dt * 12);
    this.plantY += (this.plantWant - this.plantY) * k;
    if (Math.abs(this.plantY) < 0.0008) this.plantY = this.plantWant;
    if (this.plantY) this.obj.position.y += this.plantY;
  }
  /** How far the officer has to move down (or up) for the lower boot to touch the floor he stands on. */
  private soleOffset(src: Rig) {
    if (!this.boots.length) return 0;
    const body = src.obj.parent; if (!body) return 0;
    const v = this.v; let lowest = Infinity;
    for (const m of this.boots) {
      const pos = m.geometry.getAttribute('position'), step = Math.max(1, Math.floor(pos.count / 24));
      for (let i = 0; i < pos.count; i += step) { m.getVertexPosition(i, v); m.localToWorld(v); if (v.y < lowest) lowest = v.y; }
    }
    const dy = body.getWorldPosition(this.v2).y - lowest;
    if (!Number.isFinite(dy) || Math.abs(dy) > 0.2) return 0; // never react to a wildly different pose (stairs, fall, ladder)
    return dy;
  }
  /** Bring the rifle up to the shoulder and put both hands back on it. */
  private shoulder(k: number, C: typeof P) {
    const t = T!, B = this.B, tw = this.inner, gun = this.gun!; if (k <= 0.001) return;
    const turn = (b: THREE.Bone, world: THREE.Quaternion) => { b.quaternion.copy(world).premultiply(b.parent!.getWorldQuaternion(Q()).invert()); b.updateMatrixWorld(true); };
    const yawOf = (a: number) => { const wq = tw.getWorldQuaternion(Q()); return wq.clone().multiply(Q().setFromAxisAngle(V().set(0, 1, 0), a)).multiply(wq.invert()); };
    tw.updateMatrixWorld(true);
    // where the rifle is now (ready position), before anything moves
    const p0 = V(), q0 = Q(), s0 = V(); gun.matrixWorld.decompose(p0, q0, s0);
    // chest turns, head stays on the target
    turn(B.Spine1, yawOf(C.twist * k).multiply(B.Spine1.getWorldQuaternion(Q())));
    const wq = tw.getWorldQuaternion(Q()), hq = wq.clone().multiply(Q().setFromEuler(new THREE.Euler(C.head[1] * k, -C.twist * C.head[0] * k, C.head[2] * k, 'YXZ'))).multiply(wq.clone().invert());
    turn(B.Neck, hq.multiply(B.Neck.getWorldQuaternion(Q())));
    // shouldered: muzzle straight ahead, sights up, grip in front of the right shoulder
    const qA = wq.clone().multiply(AIMQ), grip = tw.localToWorld(tw.worldToLocal(B.RightArm.getWorldPosition(V())).add(V().set(C.grip[0], C.grip[1], C.grip[2])));
    const rp = V().setFromMatrixPosition(t.rIn).multiply(s0).applyQuaternion(qA), pA = grip.sub(rp);
    const M = new THREE.Matrix4().compose(p0.lerp(pA, k), q0.slerp(qA, k), s0);
    for (const [side, m] of [['Right', t.rIn], ['Left', t.lIn]] as const) {
      const H = new THREE.Matrix4().multiplyMatrices(M, m), hp = V(), hq2 = Q(); H.decompose(hp, hq2, V());
      const arm = B[side + 'Arm'], fore = B[side + 'ForeArm'], hand = B[side + 'Hand'];
      const S = arm.getWorldPosition(V()), E0 = fore.getWorldPosition(V()), W0 = hand.getWorldPosition(V()), l1 = E0.distanceTo(S), l2 = W0.distanceTo(E0);
      const d = hp.clone().sub(S), len = Math.min(Math.max(d.length(), Math.abs(l1 - l2) + 0.005), l1 + l2 - 0.005), dir = d.normalize();
      const e = E0.clone().sub(S), pole = e.addScaledVector(dir, -e.dot(dir)); if (pole.lengthSq() < 1e-6) pole.set(0, -1, 0); pole.normalize();
      const a = (l1 * l1 - l2 * l2 + len * len) / (2 * len), h = Math.sqrt(Math.max(0, l1 * l1 - a * a)), E = S.clone().addScaledVector(dir, a).addScaledVector(pole, h), Hc = S.clone().addScaledVector(dir, len);
      turn(arm, Q().setFromUnitVectors(E0.sub(S).normalize(), E.clone().sub(S).normalize()).multiply(arm.getWorldQuaternion(Q())));
      const E1 = fore.getWorldPosition(V()), W1 = hand.getWorldPosition(V());
      turn(fore, Q().setFromUnitVectors(W1.sub(E1).normalize(), Hc.sub(E1).normalize()).multiply(fore.getWorldQuaternion(Q())));
      turn(hand, hq2);
    }
  }
}
