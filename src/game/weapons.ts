import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import * as T from './textures';

export type WeaponModelKind = 'rifle' | 'pistol' | 'shotgun' | 'beanbag' | 'taser';

// Real weapon models (CC BY 4.0 & CC0, see public/models/weapons/*/license.txt and the credits in Settings).
// Each template is normalised: metres, muzzle towards -z, up +y, origin at the top of the pistol grip.
type Spec = { dir: string; file: string; yaw: number; length: number; grip: [number, number, number] };
const SPECS: Record<'rifle' | 'pistol' | 'shotgun', Spec> = {
  rifle: { dir: 'm4', file: 'scene.gltf', yaw: Math.PI / 2, length: 0.84, grip: [-30, -3, 1.9] },   // source: muzzle +x, 187.7 units long
  pistol: { dir: 'glock', file: 'scene.gltf', yaw: 0, length: 0.202, grip: [-0.31, 4.9, 1.3] },     // source: muzzle -z, 7.54 units long
  shotgun: { dir: 'shotgun', file: 'scene.glb', yaw: 0, length: 0.94, grip: [0, 0, 0] },            // source: muzzle -z
};
const TPL: Partial<Record<WeaponModelKind, THREE.Group>> = {};
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

/** Add tactical rail, 4-shell side saddle, fiber-optic bead & optional bright orange less-lethal markings to the M1014/M870 shotgun. */
function enhanceShotgun(root: THREE.Group, beanbag: boolean) {
  const metal = new THREE.MeshStandardMaterial({ color: 0x1b1e24, metalness: 0.8, roughness: 0.34 });
  const saddle = new THREE.MeshStandardMaterial({ color: 0x17191d, metalness: 0.3, roughness: 0.65 });
  const brass = new THREE.MeshStandardMaterial({ color: 0xc99c3c, metalness: 0.85, roughness: 0.24 });
  const shellMat = new THREE.MeshStandardMaterial({ color: beanbag ? 0x2679cf : 0xb21e1e, roughness: 0.45, metalness: 0.1 });
  const orangeMat = new THREE.MeshStandardMaterial({ color: 0xe65810, roughness: 0.55, metalness: 0.08 });
  const fiber = new THREE.MeshBasicMaterial({ color: beanbag ? 0xff9a2e : 0x45ff6b });

  const g = new THREE.Group();
  // Picatinny rail + ghost-ring rear sight + front fiber-optic bead
  g.add(
    mkBox(0.022, 0.008, 0.14, metal, 0, 0.056, -0.06),
    mkBox(0.018, 0.012, 0.01, metal, 0, 0.066, 0.004),
    mkBox(0.006, 0.012, 0.014, metal, 0, 0.056, -0.58),
  );
  const bead = new THREE.Mesh(new THREE.SphereGeometry(0.0022, 8, 8), fiber);
  bead.position.set(0, 0.064, -0.582);
  g.add(bead);

  // Side saddle carrier with 4 shells on left receiver
  g.add(mkBox(0.012, 0.042, 0.125, saddle, -0.024, 0.024, -0.05));
  for (let i = 0; i < 4; i++) {
    const z = -0.092 + i * 0.026;
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.0085, 0.0085, 0.014, 10), brass);
    cap.position.set(-0.031, 0.046, z);
    const hull = new THREE.Mesh(new THREE.CylinderGeometry(0.0082, 0.0082, 0.044, 10), shellMat);
    hull.position.set(-0.031, 0.02, z);
    g.add(cap, hull);
  }

  // Less-lethal high-visibility orange pump forend & buttstock collar for Beanbag Shotgun
  if (beanbag) {
    g.add(
      mkBox(0.042, 0.044, 0.18, orangeMat, 0, -0.004, -0.25),   // ribbed orange pump forend
      mkBox(0.034, 0.062, 0.055, orangeMat, 0, -0.012, 0.22),  // orange buttstock warning band
      mkBox(0.038, 0.014, 0.048, orangeMat, 0, 0.026, -0.06),  // side receiver orange stripe
    );
  }

  g.traverse(o => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
  root.add(g);
}

/** Compact yellow/black X26-style police TASER with cartridges & laser housing. */
function buildTaser(): THREE.Group {
  const g = new THREE.Group();
  const yellow = new THREE.MeshStandardMaterial({ color: 0xe2b118, roughness: 0.48, metalness: 0.15 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x16191f, roughness: 0.65, metalness: 0.2 });
  const sight = new THREE.MeshBasicMaterial({ color: 0x45ff6b });
  g.add(
    mkBox(0.034, 0.042, 0.15, yellow, 0, 0.026, -0.055),
    mkBox(0.028, 0.09, 0.034, dark, 0, -0.025, 0.002),
    mkBox(0.036, 0.038, 0.032, dark, 0, 0.025, -0.142),
    mkBox(0.018, 0.01, 0.02, dark, 0, 0.049, -0.02),
  );
  const dot = new THREE.Mesh(new THREE.SphereGeometry(0.0018, 6, 6), sight);
  dot.position.set(0, 0.052, -0.11);
  g.add(dot);
  g.traverse(o => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
  return g;
}

/** Detailed ballistic tactical shield with angled kevlar armor plate, bolted armored polycarbonate visor,
 *  POLICE stencil lettering, SureFire-style weapon light bar, and rear handle. */
export function buildBallisticShield(withLight = true): THREE.Group {
  const g = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x1b2029, roughness: 0.56, metalness: 0.35 });
  const rimMat = new THREE.MeshStandardMaterial({ color: 0x0e1116, roughness: 0.78, metalness: 0.15 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x353c48, roughness: 0.32, metalness: 0.85 });
  const visorMat = new THREE.MeshPhysicalMaterial({ color: 0x9ed0ff, transparent: true, opacity: 0.28, roughness: 0.06, metalness: 0.08, side: THREE.DoubleSide });

  // Lower solid armor plate + upper flanking wings around the recessed viewport
  g.add(
    mkBox(0.54, 0.58, 0.028, bodyMat, 0, -0.22, 0),          // lower torso shield
    mkBox(0.14, 0.22, 0.028, bodyMat, -0.2, 0.18, 0),          // left visor pillar
    mkBox(0.14, 0.22, 0.028, bodyMat, 0.2, 0.18, 0),           // right visor pillar
    mkBox(0.54, 0.12, 0.028, bodyMat, 0, 0.35, 0),             // top brow armor
    // Beveled rubber edge trim
    mkBox(0.56, 0.026, 0.036, rimMat, 0, 0.42, 0),
    mkBox(0.56, 0.026, 0.036, rimMat, 0, -0.52, 0),
    mkBox(0.024, 0.96, 0.036, rimMat, -0.275, -0.05, 0),
    mkBox(0.024, 0.96, 0.036, rimMat, 0.275, -0.05, 0),
    // Visor steel frame & rivets
    mkBox(0.28, 0.02, 0.036, steel, 0, 0.285, 0),
    mkBox(0.28, 0.02, 0.036, steel, 0, 0.075, 0),
    // Rear grip bar & forearm strap
    mkBox(0.026, 0.18, 0.026, steel, -0.04, 0.02, 0.065),
    mkBox(0.024, 0.024, 0.06, steel, -0.04, 0.1, 0.035),
    mkBox(0.024, 0.024, 0.06, steel, -0.04, -0.06, 0.035),
    mkBox(0.11, 0.032, 0.045, rimMat, 0.06, 0.02, 0.045),
  );

  // Armored polycarbonate viewport glass + progressive bullet crack overlay
  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.19, 0.016), visorMat);
  visor.position.set(0, 0.18, 0);
  g.add(visor);
  const crackMat = new THREE.MeshBasicMaterial({ map: shieldCrackTex(), transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
  const visorCrack = new THREE.Mesh(new THREE.PlaneGeometry(0.25, 0.18), crackMat);
  visorCrack.position.set(0, 0.18, 0.01);
  visorCrack.visible = false;
  g.add(visorCrack);
  g.userData.visorCrack = visorCrack;

  // Rivets around viewport frame
  for (const rx of [-0.11, -0.04, 0.04, 0.11]) {
    for (const ry of [0.075, 0.285]) {
      const bolt = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.042, 6), steel);
      bolt.rotation.x = Math.PI / 2;
      bolt.position.set(rx, ry, 0);
      g.add(bolt);
    }
  }

  // POLICE decal on front armor plate
  const decal = new THREE.Mesh(
    new THREE.PlaneGeometry(0.36, 0.075),
    new THREE.MeshStandardMaterial({ map: T.textTex('POLICE'), transparent: true, roughness: 0.65, metalness: 0.05, polygonOffset: true, polygonOffsetFactor: -2 }),
  );
  decal.rotation.y = Math.PI;
  decal.position.set(0, -0.04, -0.016);
  g.add(decal);

  // Integrated tactical shield weapon light under the visor
  if (withLight) {
    const lampLens = new THREE.MeshStandardMaterial({ color: 0xeef6ff, emissive: 0xfff1d6, emissiveIntensity: 1.8, roughness: 0.12 });
    const housing = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.022, 0.052, 12), steel);
    housing.rotation.x = Math.PI / 2;
    housing.position.set(0, 0.04, -0.032);
    const lens = new THREE.Mesh(new THREE.CircleGeometry(0.017, 12), lampLens);
    lens.rotation.y = Math.PI;
    lens.position.set(0, 0.04, -0.059);
    g.add(mkBox(0.11, 0.026, 0.028, rimMat, 0, 0.04, -0.02), housing, lens);
  }

  g.traverse(o => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
  return g;
}

function shieldCrackTex() {
  return T.make('shield_cracks', 256, 192, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    const hubs = [[w * 0.34, h * 0.44], [w * 0.68, h * 0.52], [w * 0.5, h * 0.32]];
    for (const [hx, hy] of hubs) {
      g.strokeStyle = 'rgba(235, 245, 255, 0.85)';
      g.lineWidth = 1.6;
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * Math.PI * 2 + hx * 0.03;
        g.beginPath();
        g.moveTo(hx, hy);
        const len = 26 + ((i * 19) % 34);
        g.lineTo(hx + Math.cos(a) * len * 0.55, hy + Math.sin(a) * len * 0.55);
        g.lineTo(hx + Math.cos(a + 0.14) * len, hy + Math.sin(a + 0.14) * len);
        g.stroke();
      }
      g.beginPath();
      g.arc(hx, hy, 6, 0, Math.PI * 2);
      g.strokeStyle = 'rgba(255, 255, 255, 0.92)';
      g.stroke();
    }
  });
}

export function setShieldCracks(shield: THREE.Group, hits: number) {
  const crack = shield.userData.visorCrack as THREE.Mesh | undefined;
  if (!crack) return;
  crack.visible = hits > 0;
  if (hits > 0) {
    (crack.material as THREE.MeshBasicMaterial).opacity = Math.min(0.95, 0.28 + hits * 0.2);
  }
}

function eotechReticleTex() {
  return T.make('eotech_reticle', 256, 256, (g, w, h) => {
    const cx = w / 2, cy = h / 2;
    g.clearRect(0, 0, w, h);
    g.strokeStyle = 'rgba(255, 42, 34, 0.94)';
    g.fillStyle = 'rgba(255, 58, 42, 1)';
    g.lineWidth = 4;
    // Outer 65-MOA ring
    g.beginPath();
    g.arc(cx, cy, 56, 0, Math.PI * 2);
    g.stroke();
    // 4 cardinal hash ticks (12, 3, 6, 9 o'clock)
    for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
      g.beginPath();
      g.moveTo(cx + dx * 44, cy + dy * 44);
      g.lineTo(cx + dx * 68, cy + dy * 68);
      g.stroke();
    }
    // Crisp 1-MOA center dot
    g.beginPath();
    g.arc(cx, cy, 4.2, 0, Math.PI * 2);
    g.fill();
  });
}

export async function loadWeapons(base = './models/weapons/'): Promise<void> {
  try {
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    const loaded = await Promise.allSettled((Object.keys(SPECS) as ('rifle' | 'pistol' | 'shotgun')[]).map(async k => {
      const sp = SPECS[k], src = (await loader.loadAsync(base + sp.dir + '/' + sp.file)).scene, drop: THREE.Object3D[] = [];
      src.traverse((o: any) => {
        if (o.isLight || o.isCamera) drop.push(o);
        if (!o.isMesh) return; o.castShadow = true;
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) { // near-black source colours: keep them dark but readable under the game's lights
          const c = m.color as THREE.Color, l = Math.max(c.r, c.g, c.b); if (l < 0.07) c.multiplyScalar(0.07 / Math.max(l, 0.005)); m.metalness = Math.max(m.metalness ?? 0.45, 0.45); m.roughness = Math.min(m.roughness ?? 0.5, 0.65);
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
      if (k === 'shotgun') {
        src.scale.setScalar(scale);
        src.updateMatrixWorld(true);
        const bb2 = new THREE.Box3().setFromObject(src);
        src.position.set(-(bb2.min.x + bb2.max.x) * 0.5, -bb2.min.y - (bb2.max.y - bb2.min.y) * 0.62, -bb2.max.z * 0.68);
        const sg = new THREE.Group(); sg.add(src);
        enhanceShotgun(sg, false);
        TPL.shotgun = sg;
        const bbGun = sg.clone(true);
        enhanceShotgun(bbGun, true);
        TPL.beanbag = bbGun;
      } else {
        const move = new THREE.Group(); move.add(src); move.position.set(-sp.grip[0], -sp.grip[1], -sp.grip[2]);
        const turn = new THREE.Group(); turn.add(move); turn.rotation.y = sp.yaw; turn.scale.setScalar(scale);
        const g = new THREE.Group(); g.add(turn);
        if (k === 'pistol') enhanceSwatPistol(g);
        TPL[k] = g;
      }
    }));
    // One bad source model must not throw away the others: the carbine is the weapon the player
    // sees almost all the time, so keep whatever loaded instead of falling back to the box guns.
    for (const r of loaded) if (r.status === 'rejected') console.warn('weapon model failed', r.reason);
    TPL.taser = buildTaser();
    weaponsReady = !!(TPL.rifle || TPL.pistol || TPL.shotgun);
  } catch (e) { console.warn('weapon models', e); }
}
/** A copy of a weapon (shares geometry and materials). Null until the models are loaded. */
export function weaponModel(kind: WeaponModelKind): THREE.Group | null { const t = TPL[kind]; return t ? t.clone(true) : null; }

/** Animated first-person arms holding carbine (with EOTech holographic sight + flip-to-side 3x magnifier),
 *  M1014/Beanbag shotgun, or SWAT Glock 17 / Taser. */
export class FpsArms {
  root = new THREE.Group(); private mixer!: THREE.AnimationMixer; private act: Record<string, THREE.AnimationAction> = {}; private cur = ''; private busy = 0;
  private rifleParts: THREE.Object3D[] = []; private left: THREE.Object3D[] = [];
  private glock: THREE.Group | null = null; private taser: THREE.Group | null = null;
  private shotgun: THREE.Group | null = null; private beanbag: THREE.Group | null = null;
  private holoGroup = new THREE.Group();
  private magPivot = new THREE.Group();
  private reticleMesh!: THREE.Mesh;
  private magK = 0;
  private adsSight = false;
  private magActive = false;
  private weapon = -1;
  muzzle = new THREE.Object3D(); ready = false; private turn = new THREE.Group();
  async load(url = './models/fpsarms/scene.gltf') {
    try {
      const g = await new GLTFLoader().loadAsync(url), sc = g.scene; let cam: THREE.Object3D | null = null, rif: THREE.Object3D | null = null;
      sc.traverse((o: any) => {
        if (o.name.startsWith('Head_Cam_0')) cam = o; if (o.name.startsWith('Hand_R_')) rif = o; if (/^(Arm_L_|IK_Hand_Cntrl_L_|IK_PoleTrgt_L_)/.test(o.name)) this.left.push(o);
        if (!o.isMesh) return; o.frustumCulled = false;
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          // The animation pack's own optic glows with a red ring that sits nearer the eye than the
          // EOTech reticle built below, so aiming showed two rings. Keep the pack's glass and body,
          // drop its glow: the game's own reticle is the one that stays.
          if (m.name === 'Scope' && (m as THREE.MeshStandardMaterial).emissiveMap) {
            (m as THREE.MeshStandardMaterial).emissiveMap = null;
            (m as THREE.MeshStandardMaterial).emissive.setHex(0x000000);
            m.needsUpdate = true;
          }
        }
        const n = o.material.name;
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

      // 3D EOTech EXPS3 Holographic Sight + G33 Flip-to-Side 3x Magnifier aligned with carbine ADS line (0.113, -0.036, -0.36)
      this.buildOpticAssembly();
      // Mount the holographic sight + magnifier on the weapon itself. It used to hang off the
      // arms root at a fixed offset, which only matched while the rifle sat still, so it drifted
      // away from the gun as soon as the run/walk or reload animation moved the weapon.
      this.root.updateMatrixWorld(true);
      const host = this.rifleBone();
      if (host) {
        host.updateWorldMatrix(true, false);
        host.attach(this.holoGroup); // keeps the tuned world pose, then follows the bone
      } else {
        this.root.add(this.holoGroup);
      }

      if (rif) {
        const prep = (m: THREE.Group | null) => {
          if (!m) return null;
          m.visible = false;
          m.traverse(o => {
            const ms = o as THREE.Mesh;
            if (ms.isMesh && ms.material && 'envMapIntensity' in (ms.material as THREE.MeshStandardMaterial)) {
              (ms.material as THREE.MeshStandardMaterial).envMapIntensity = 0.95;
            }
          });
          (rif as THREE.Object3D).add(m);
          return m;
        };
        this.glock = prep(weaponModel('pistol'));
        this.taser = prep(weaponModel('taser'));
        this.shotgun = prep(weaponModel('shotgun'));
        this.beanbag = prep(weaponModel('beanbag'));
      }
      this.pose(); this.ready = true;
    } catch (e) { console.warn('fps arms', e); }
    return this.ready;
  }

  /** The bone the carbine meshes are actually skinned to — the optic has to ride on it. */
  private rifleBone(): THREE.Object3D | null {
    const tally = new Map<THREE.Object3D, number>();
    for (const part of this.rifleParts) {
      const m = part as THREE.SkinnedMesh;
      const geo = m.geometry as THREE.BufferGeometry | undefined;
      const sw = geo?.getAttribute('skinWeight') as THREE.BufferAttribute | undefined;
      const si = geo?.getAttribute('skinIndex') as THREE.BufferAttribute | undefined;
      const bones = m.skeleton?.bones;
      if (!sw || !si || !bones?.length) continue;
      const step = Math.max(1, Math.floor(si.count / 96));
      for (let i = 0; i < si.count; i += step) {
        const w = [sw.getX(i), sw.getY(i), sw.getZ(i), sw.getW(i)];
        let k = 0;
        for (let j = 1; j < 4; j++) if (w[j] > w[k]) k = j;
        const b = bones[[si.getX(i), si.getY(i), si.getZ(i), si.getW(i)][k]];
        if (b) tally.set(b, (tally.get(b) ?? 0) + w[k]);
      }
    }
    let best: THREE.Object3D | null = null, bestW = -1;
    for (const [b, w] of tally) if (w > bestW) { bestW = w; best = b; }
    return best;
  }
  private buildOpticAssembly() {
    this.holoGroup.position.set(0.113, -0.036, -0.35);
    const housing = new THREE.MeshStandardMaterial({ color: 0x181b21, metalness: 0.72, roughness: 0.34 });
    const matte = new THREE.MeshStandardMaterial({ color: 0x101216, metalness: 0.3, roughness: 0.65 });
    // colourless glass: only a faint specular sheen, no blue tint across the sight picture
    const lensMat = new THREE.MeshPhysicalMaterial({ color: 0xb9c3c9, transparent: true, opacity: 0.06, roughness: 0.03, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.04, depthWrite: false });
    // smoked rear glass in the flip-to-side magnifier (it used to be a bright blue disc)
    const magGlassMat = new THREE.MeshPhysicalMaterial({ color: 0x1b222a, transparent: true, opacity: 0.22, roughness: 0.07, metalness: 0.25, clearcoat: 1, clearcoatRoughness: 0.03, depthWrite: false });
    // EOTech hood frame
    this.holoGroup.add(
      mkBox(0.038, 0.004, 0.056, housing, 0, -0.017, -0.04),  // base mount
      mkBox(0.004, 0.034, 0.048, housing, -0.018, 0.0, -0.04),  // left hood wall
      mkBox(0.004, 0.034, 0.048, housing, 0.018, 0.0, -0.04),   // right hood wall
      mkBox(0.038, 0.004, 0.048, housing, 0, 0.017, -0.04),   // top hood arch
    );
    const lens = new THREE.Mesh(new THREE.PlaneGeometry(0.032, 0.028), lensMat);
    lens.position.set(0, 0, -0.042);
    this.holoGroup.add(lens);

    const retMat = new THREE.MeshBasicMaterial({
      map: eotechReticleTex(),
      transparent: true,
      opacity: 0.92,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    });
    this.reticleMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.024, 0.024), retMat);
    this.reticleMesh.position.set(0, 0, -0.04);
    this.reticleMesh.renderOrder = 10;
    this.holoGroup.add(this.reticleMesh);

    // G33 3x Flip-to-Side Magnifier pivoted on the right side of the rail
    this.magPivot.position.set(0.016, -0.013, 0.022);
    const magBody = new THREE.Mesh(new THREE.CylinderGeometry(0.0165, 0.0155, 0.058, 16, 1, true), matte); // open tube: you see through it
    magBody.rotation.x = Math.PI / 2;
    magBody.position.set(-0.016, 0.013, 0);
    const magFront = new THREE.Mesh(new THREE.CylinderGeometry(0.0175, 0.0175, 0.012, 16), housing);
    magFront.rotation.x = Math.PI / 2;
    magFront.position.set(-0.016, 0.013, -0.028);
    const magGlass = new THREE.Mesh(new THREE.CircleGeometry(0.0135, 24), magGlassMat);
    magGlass.position.set(-0.016, 0.013, 0.029);
    const magArm = mkBox(0.018, 0.014, 0.018, housing, -0.006, 0.004, 0);
    this.magPivot.add(magBody, magFront, magGlass, magArm);
    this.magPivot.rotation.z = -1.2; // flipped to right side by default
    this.holoGroup.add(this.magPivot);
  }

  setSight(ads: boolean, zoomed: boolean) {
    this.adsSight = ads;
    this.magActive = zoomed;
  }

  /** Re-applies the tunable offsets of the things attached to the rifle bone. */
  pose() {
    const A = ARMS;
    const place = (m: THREE.Group | null, p: number[], r: number[], s: number) => {
      if (!m) return;
      const sc = m.parent?.getWorldScale(new THREE.Vector3()).x || 1;
      m.position.set(p[0], p[1], p[2]); m.rotation.set(r[0], r[1], r[2]); m.scale.setScalar(s / sc);
    };
    place(this.glock, A.gp, A.gr, A.gs);
    place(this.taser, A.gp, A.gr, A.gs * 1.05);
    place(this.shotgun, A.sp, A.sr, A.ss);
    place(this.beanbag, A.sp, A.sr, A.ss);
  }
  private play(name: string, fade = 0.08, once = false, speed = 1) {
    const a = this.act[name]; if (!a) return; if (this.cur === name && !once) return;
    a.reset(); a.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity); a.timeScale = speed; a.fadeIn(fade).play();
    if (this.cur !== name) this.act[this.cur]?.fadeOut(fade); this.cur = name; this.busy = once ? a.getClip().duration / speed : 0;
  }
  fire() { if (this.ready) this.play('Shoot', 0.02, true, 1.2); }
  reload(dur: number) { if (this.ready) this.play('Reload_Fast', 0.1, true, this.act.Reload_Fast.getClip().duration / dur); }
  draw() { if (this.ready) this.play('Draw', 0.03, true); }
  /** weapon: 0=carbine, 1=pistol, 2=shotgun, 3=beanbag, 4=taser. move: 0 standing, 1 walking, 2 running. */
  update(dt: number, weapon: number, move: number) {
    if (!this.ready) return;
    if (weapon !== this.weapon) {
      this.weapon = weapon;
      const isRifle = weapon === 0;
      const isTwoHand = weapon === 0 || weapon === 2 || weapon === 3;
      const A = ARMS, m = isTwoHand ? A.mz : A.mzp;
      this.muzzle.position.set(m[0], m[1], m[2]);
      this.turn.position.set(A.p[0] + (isTwoHand ? 0 : A.pp[0]), A.p[1] + (isTwoHand ? 0 : A.pp[1]), A.p[2] + (isTwoHand ? 0 : A.pp[2]));
      this.pose();
      for (const o of this.rifleParts) o.visible = isRifle;
      if (this.glock) this.glock.visible = weapon === 1;
      if (this.taser) this.taser.visible = weapon === 4;
      if (this.shotgun) this.shotgun.visible = weapon === 2;
      if (this.beanbag) this.beanbag.visible = weapon === 3;
      this.holoGroup.visible = isRifle;
    }
    this.magK += ((this.magActive ? 1 : 0) - this.magK) * Math.min(1, dt * 14);
    this.magPivot.rotation.z = -1.22 * (1 - this.magK);
    if (this.reticleMesh) {
      const mat = this.reticleMesh.material as THREE.MeshBasicMaterial;
      mat.opacity = this.adsSight ? 0.96 : 0.45;
      const s = this.magActive && this.adsSight ? 1.25 : 1.0;
      this.reticleMesh.scale.setScalar(s);
    }
    if (this.busy > 0) { this.busy -= dt; if (this.busy <= 0) this.play(move === 2 ? 'Run' : move ? 'Walk' : 'Idle', 0.12); }
    else this.play(move === 2 ? 'Run' : move ? 'Walk' : 'Idle', 0.18);
    for (const b of this.left) { const o = b.userData.off as THREE.Vector3 | undefined; if (o) { b.position.sub(o); b.userData.off = undefined; } } // bones without a position track keep last frame's offset
    this.mixer.update(dt);
    const isOneHand = this.weapon === 1 || this.weapon === 4;
    if (isOneHand) { // pistol/taser: one-handed, so drop the support arm out of sight (the clip repositions it every frame)
      const down = new THREE.Vector3(0, -1.5, 0).applyQuaternion(this.root.getWorldQuaternion(new THREE.Quaternion()));
      for (const b of this.left) { const par = b.parent!; const o = down.clone().applyQuaternion(par.getWorldQuaternion(new THREE.Quaternion()).invert()).divideScalar(par.getWorldScale(new THREE.Vector3()).x || 1); b.position.add(o); b.userData.off = o; }
    }
  }
}
const ARMS = {
  p: [0.085, -0.055, -0.02], r: [0, Math.PI + 0.06, 0], s: 1,
  mz: [0.15, -0.1, -0.95], mzp: [0.094, -0.11, -0.53], pp: [-0.08, 0.06, -0.22],
  gp: [0, 0.08, -0.05], gr: [1.5096, 0.2021, 2.8383], gs: 1,
  sp: [0.015, 0.085, -0.06], sr: [1.52, 0.14, 2.9], ss: 0.92,
};
/** Soft reflections for the metal parts of the first-person weapon. */
export function studioEnv(r: THREE.WebGLRenderer) { const pm = new THREE.PMREMGenerator(r), t = pm.fromScene(new RoomEnvironment(), 0.04).texture; pm.dispose(); return t; }
