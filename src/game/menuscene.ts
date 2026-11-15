import * as THREE from 'three';
import * as T from './textures';
import { ActorView } from './world';
import { Actor } from '../sim/sim';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { loadOperator, menuOperator } from './operator';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

const HERO = [[0.75, 2.2, -0.1], [1.75, 1.0, -0.4], [-0.45, 0.6, 0.2]]; // x, z, yaw
const TRUCK = [2.5, -3.7, 3.56, 2.3, 0.9, 2.05, 1.42]; // x, z, yaw, fallback roof height, light bar position along the roof, lettering position along the flank and its height
// police livery: paint and trim by material name -> colour, roughness, metalness
const PAINT: Record<string, [number, number, number]> = { Body_2: [0x4a566e, 0.5, 0.55], Metal_UP_5: [0x596273, 0.55, 0.6] };
/** Live 3D backdrop for the main menu: the squad waiting in a parking garage, lit by a patrol car's light bar. */
export class MenuScene {
  scene = new THREE.Scene(); cam = new THREE.PerspectiveCamera(30, 1, 0.1, 80);
  private views: ActorView[] = []; private t = 0; private blue: THREE.PointLight; private red: THREE.PointLight; private dust: THREE.Points;
  private truck?: THREE.Group; private lens: THREE.MeshStandardMaterial[] = [];
  private heroes: THREE.Group[] = []; private mixers: THREE.AnimationMixer[] = []; private heroMode = false;
  private mx = 0; private my = 0; private cx = 0; private cy = 0;
  constructor() {
    const s = this.scene; s.background = new THREE.Color(0x07090d); s.fog = new THREE.Fog(0x07090d, 12, 34);
    const std = (o: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial(o);
    const ft = T.floorTex('concrete').clone(); ft.wrapS = ft.wrapT = THREE.RepeatWrapping; ft.repeat.set(14, 14); ft.needsUpdate = true;
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), std({ map: ft, color: 0x8a9099, roughness: 0.42, metalness: 0.25 })); floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; s.add(floor);
    const wallM = std({ color: 0x565d66, roughness: 0.9 }), dark = std({ color: 0x14181d, roughness: 0.8 }), yellow = std({ color: 0xc79a1e, roughness: 0.7 });
    const box = (w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number) => { const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); b.position.set(x, y, z); b.castShadow = b.receiveShadow = true; s.add(b); return b; };
    box(60, 7, 0.4, wallM, 0, 3.5, -9);                                   // back wall
    box(60, 0.4, 30, dark, 0, 4.4, 0);                                    // ceiling
    for (let i = -3; i <= 3; i++) { box(0.7, 4.4, 0.7, wallM, i * 5.2 + 1.2, 2.2, -5.5); box(0.74, 0.9, 0.74, yellow, i * 5.2 + 1.2, 0.45, -5.5); } // pillars with hazard paint
    for (let i = -4; i <= 4; i++) box(0.12, 0.012, 3.6, std({ color: 0xb9bec4, roughness: 0.6 }), i * 2.6, 0.006, -7);                           // parking lines
    // ceiling strip lights
    for (const x of [-4, 3.2]) { const tube = box(1.6, 0.06, 0.16, new THREE.MeshBasicMaterial({ color: 0xdfeaff }), x, 4.15, -2.5); tube.castShadow = false; }
    // concrete barriers and a steel shutter in the back wall give the room some depth
    const steel = std({ color: 0x3a4149, roughness: 0.45, metalness: 0.7 });
    for (let i = 0; i < 14; i++) box(6.4, 0.2, 0.08, steel, 3.2, 0.3 + i * 0.24, -8.75);
    box(6.8, 0.25, 0.3, yellow, 3.2, 3.75, -8.7);
    for (const [x, z, r] of [[-3.4, -2.6, 0.25]]) { const b = box(2.4, 0.85, 0.5, std({ color: 0x7c8087, roughness: 0.95 }), x, 0.425, z); b.rotation.y = r; }
    // lights
    s.add(new THREE.HemisphereLight(0xa9c0e0, 0x1a1d22, 1.1));
    const key = new THREE.SpotLight(0xffe2bd, 250, 30, 0.6, 0.6, 1.6); key.position.set(-2.5, 4.1, 6); key.target.position.set(1.6, 1, 0); key.castShadow = true; key.shadow.mapSize.set(1024, 1024); key.shadow.bias = -0.002; s.add(key, key.target);
    const rim = new THREE.SpotLight(0x6fb6ff, 420, 30, 0.7, 0.7, 1.5); rim.position.set(6.5, 3.6, -5); rim.target.position.set(1.5, 1.2, 0.5); s.add(rim, rim.target);
    this.blue = new THREE.PointLight(0x2a6bff, 0, 16, 1.6); this.blue.position.set(5.5, 2.2, 1.5); this.red = new THREE.PointLight(0xff2a2a, 0, 16, 1.6); this.red.position.set(6.5, 2.2, 0); s.add(this.blue, this.red);
    for (const x of [-6, 0, 6]) { const w = new THREE.SpotLight(0xbfd4ff, 32, 14, 0.9, 0.8, 1.4); w.position.set(x, 4, -6.5); w.target.position.set(x, 1.5, -9); s.add(w, w.target); }
    // drifting dust in the light
    const n = 260, pos = new Float32Array(n * 3); for (let i = 0; i < n; i++) { pos[i * 3] = (Math.random() - 0.5) * 14; pos[i * 3 + 1] = Math.random() * 4; pos[i * 3 + 2] = (Math.random() - 0.5) * 10; }
    const dg = new THREE.BufferGeometry(); dg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.dust = new THREE.Points(dg, new THREE.PointsMaterial({ color: 0xcfe0ff, size: 0.025, transparent: true, opacity: 0.45, depthWrite: false })); s.add(this.dust);
    window.addEventListener('mousemove', e => { this.mx = e.clientX / innerWidth - 0.5; this.my = e.clientY / innerHeight - 0.5; });
  }
  /** Put the squad in the scene (call once the character models are loaded; safe to call again). */
  squad() {
    if (this.heroes.length) return;
    this.heroMode = false;
    for (const v of this.views) this.scene.remove(v.root); this.views = [];
    //            x     z     yaw   aiming
    const spots = [[1.5, 1.5, -0.25, 0], [2.7, 0.7, -0.6, 1], [0.4, 0.5, 0.1, 0], [3.8, -0.3, -0.45, 0], [-0.6, -0.5, 0.3, 0]];
    spots.forEach(([x, z, yaw, aim], i) => {
      const a = new Actor(900 + i, 'officer', ''); a.team = i === 1 || i === 3 ? 'B' : 'A'; a.armed = true; a.variant = i; a.x = x; a.z = z; a.yaw = yaw; if (aim) a.target = a;
      a.yaw = yaw + Math.PI; const v = new ActorView(a); if (v.label) { v.root.remove(v.label); v.label = undefined; } v.root.position.set(x, 0, z); v.root.rotation.y = a.yaw; this.scene.add(v.root); this.views.push(v);
      for (let k = 0; k < 40 + i * 7; k++) v.update(0.033, k); // settle into pose, each at a different phase of the idle
    });
  }
  /** Replace the stand-in squad with the detailed operator model (CC BY, see credits). Keeps the stand-ins if it cannot be loaded. */
  async hero(count: number) {
    this.heroMode = true;
    if (!(await loadOperator())) { this.heroMode = false; return false; }
    for (const v of this.views) this.scene.remove(v.root); this.views = [];
    for (const h of this.heroes) this.scene.remove(h); this.heroes = []; this.mixers = [];
    const spots = (window as any).__spots ?? HERO;
    for (let i = 0; i < Math.min(count, spots.length); i++) {
      const [x, z, yaw] = spots[i], m = menuOperator(i * 2.3)!, w = new THREE.Group(); w.add(m.obj); w.position.set(x, 0, z); w.rotation.y = yaw; this.scene.add(w); this.heroes.push(w);
      if (m.mixer) this.mixers.push(m.mixer);
    }
    return true;
  }
  /** The squad's armoured truck behind them («Paramount Marauder», CC BY, see credits), with a light bar on the roof. */
  async vehicle(url: string) {
    try {
      const g = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(url), v = g.scene, C = (window as any).__truck ?? TRUCK;
      v.traverse((o: any) => { if (!o.isMesh) return; o.castShadow = true; o.receiveShadow = true; const m = o.material as THREE.MeshStandardMaterial; m.envMapIntensity = 0.9; const tint = PAINT[m.name]; if (tint) { m.color.setHex(tint[0]); m.roughness = tint[1]; m.metalness = tint[2]; } });
      const w = new THREE.Group(); w.add(v); w.position.set(C[0], 0, C[1]); w.rotation.y = C[2]; this.scene.add(w); this.truck = w;
      w.updateMatrixWorld(true);
      const meshes: THREE.Mesh[] = []; v.traverse((o: any) => { if (o.isMesh) meshes.push(o); });
      const ray = new THREE.Raycaster(), hit = (from: THREE.Vector3, dir: THREE.Vector3) => { ray.set(w.localToWorld(from), dir.transformDirection(w.matrixWorld)); return ray.intersectObjects(meshes, false)[0]; };
      // lettering on both flanks, laid onto the armour where a ray from the side meets it
      const tex = T.textTex('POLICE');
      for (const sgn of [-1, 1]) {
        const h = hit(new THREE.Vector3(C[5], C[6], sgn * 4), new THREE.Vector3(0, 0, -sgn)); if (!h || !h.face) continue;
        const n = h.face.normal.clone().transformDirection(h.object.matrixWorld), d = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 0.2), new THREE.MeshStandardMaterial({ map: tex, transparent: true, roughness: 0.6, metalness: 0, polygonOffset: true, polygonOffsetFactor: -4 }));
        d.position.copy(h.point).addScaledVector(n, 0.012); d.lookAt(h.point.clone().add(n)); this.scene.add(d); w.attach(d);
      }
      // light bar sitting on the roof
      const top = hit(new THREE.Vector3(C[4], 6, 0), new THREE.Vector3(0, -1, 0)), bar = new THREE.Group(); bar.position.set(C[4], (top ? w.worldToLocal(top.point.clone()).y : C[3]) + 0.05, 0); bar.rotation.y = Math.PI / 2; w.add(bar);
      const dark = new THREE.MeshStandardMaterial({ color: 0x0c0e11, roughness: 0.4, metalness: 0.6 }); bar.add(new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.05, 0.3), dark));
      for (const x of [-0.6, 0.6]) { const foot = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.1, 0.3), dark); foot.position.set(x, -0.05, 0); bar.add(foot); }
      this.lens = [0x2a6bff, 0xff2a2a].map((c, i) => { const m = new THREE.MeshStandardMaterial({ color: 0x111418, emissive: c, emissiveIntensity: 0, roughness: 0.25 }); const b = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.1, 0.24), m); b.position.set(i ? 0.37 : -0.37, 0.075, 0); bar.add(b); return m; });
      const mid = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.11, 0.26), dark); mid.position.y = 0.075; bar.add(mid);
      this.blue.position.set(-0.6, 0.5, 0.3); this.red.position.set(0.6, 0.5, 0.3); bar.add(this.blue, this.red);
      return true;
    } catch (e) { console.warn('vehicle model', e); return false; }
  }
  /** Soft studio reflections so the metal and fabric of the detailed model read properly. */
  env(r: THREE.WebGLRenderer) { if (this.scene.environment) return; const pm = new THREE.PMREMGenerator(r); this.scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture; this.scene.environmentIntensity = 0.35; pm.dispose(); }
  resize(aspect: number) { this.cam.aspect = aspect; this.cam.fov = aspect < 1.3 ? 44 : 30; this.cam.updateProjectionMatrix(); }
  update(dt: number) {
    this.t += dt; const t = this.t;
    for (const m of this.mixers) m.update(dt);
    for (const v of this.views) { v.a.x = v.root.position.x; v.a.z = v.root.position.z; v.update(dt, t); }
    // light bar: alternating double flashes
    const ph = (t * 1.3) % 1, fl = (p: number) => (p < 0.08 || (p > 0.14 && p < 0.22) ? 1 : 0);
    this.blue.intensity = fl(ph) * 55; this.red.intensity = fl((ph + 0.5) % 1) * 40;
    if (this.lens.length) { this.lens[0].emissiveIntensity = 0.25 + fl(ph) * 5; this.lens[1].emissiveIntensity = 0.25 + fl((ph + 0.5) % 1) * 5; }
    this.dust.rotation.y = t * 0.012; this.dust.position.y = Math.sin(t * 0.2) * 0.1;
    this.cx += (this.mx - this.cx) * Math.min(1, dt * 2); this.cy += (this.my - this.cy) * Math.min(1, dt * 2);
    const wide = this.cam.aspect >= 1.3, heroCam = this.heroes.length > 0 || this.heroMode;
    this.cam.position.set((wide ? -1.3 : 1.2) + Math.sin(t * 0.13) * 0.35 + this.cx * 0.5, 1.5 - this.cy * 0.25 + Math.sin(t * 0.21) * 0.04, (heroCam ? 6.6 : 7.4) + Math.cos(t * 0.11) * 0.25);
    this.cam.lookAt(wide ? -0.1 : 1.4, heroCam ? 1.22 : 0.98, 0);
  }
}
