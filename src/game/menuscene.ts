import * as THREE from 'three';
import * as T from './textures';
import { ActorView } from './world';
import { Actor } from '../sim/sim';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { loadOperator, menuOperator } from './operator';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

const HERO = [[-0.65, 2.0, 0.25], [0.45, 1.15, -0.15], [-1.75, 0.9, 0.45]]; // x, z, yaw — framed left-center so right briefing card never covers the squad
const TRUCK = [1.05, -3.5, 3.45, 2.3, 0.9, 2.05, 1.42]; // x, z, yaw, fallback roof height, light bar position along the roof, lettering position & height
const PAINT: Record<string, [number, number, number]> = { Body_2: [0x3d485e, 0.45, 0.58], Metal_UP_5: [0x4b5363, 0.5, 0.62] };
const LOCKER_NAMES = ['KEN', 'MAYA', 'JACK', 'ZOE'];

function plateTex(name: string) {
  return T.make('plate_' + name, 160, 40, (g, w, h) => {
    g.fillStyle = '#0e1319'; g.fillRect(0, 0, w, h);
    g.strokeStyle = '#3b4858'; g.lineWidth = 2; g.strokeRect(2, 2, w - 4, h - 4);
    g.fillStyle = '#dce6f2'; g.font = 'bold 22px "Barlow Condensed", system-ui, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(name, w / 2, h / 2 + 1);
  });
}

/** Live 3D backdrop for the main menu: detailed SWAT operators & Paramount Marauder truck in a dark tactical garage/armory bay. */
export class MenuScene {
  scene = new THREE.Scene();
  cam = new THREE.PerspectiveCamera(31, 1, 0.1, 80);
  private views: ActorView[] = [];
  private t = 0;
  private blue: THREE.PointLight;
  private red: THREE.PointLight;
  private dust: THREE.Points;
  private truck?: THREE.Group;
  private lens: THREE.MeshStandardMaterial[] = [];
  private heroes: THREE.Group[] = [];
  private mixers: THREE.AnimationMixer[] = [];
  private heroMode = false;
  private mx = 0; private my = 0; private cx = 0; private cy = 0;

  constructor() {
    const s = this.scene;
    s.background = new THREE.Color(0x05070b);
    s.fog = new THREE.Fog(0x05070b, 10, 28);

    const std = (o: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial(o);
    const box = (parent: THREE.Object3D, w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number) => {
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
      b.position.set(x, y, z); b.castShadow = b.receiveShadow = true;
      parent.add(b);
      return b;
    };

    // Floor
    const ft = T.floorTex('concrete').clone();
    ft.wrapS = ft.wrapT = THREE.RepeatWrapping; ft.repeat.set(14, 14); ft.needsUpdate = true;
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(60, 60),
      std({ map: ft, color: 0x6e757e, roughness: 0.36, metalness: 0.3 }),
    );
    floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true;
    s.add(floor);

    const wallM = std({ color: 0x3b424c, roughness: 0.9 });
    const dark = std({ color: 0x0f1318, roughness: 0.8 });
    const yellow = std({ color: 0xb88b19, roughness: 0.7 });
    box(s, 60, 7, 0.4, wallM, 0, 3.5, -9);
    box(s, 60, 0.4, 30, dark, 0, 4.4, 0);
    for (let i = -3; i <= 3; i++) {
      box(s, 0.7, 4.4, 0.7, wallM, i * 5.2 + 1.2, 2.2, -5.5);
      box(s, 0.74, 0.9, 0.74, yellow, i * 5.2 + 1.2, 0.45, -5.5);
    }
    for (let i = -4; i <= 4; i++) box(s, 0.12, 0.012, 3.6, std({ color: 0x9aa2ab, roughness: 0.6 }), i * 2.6, 0.006, -7);

    // Overhead ceiling strip lights
    for (const x of [-4.2, 2.4]) {
      const tube = box(s, 1.8, 0.06, 0.16, new THREE.MeshBasicMaterial({ color: 0xd6e6ff }), x, 4.15, -2.5);
      tube.castShadow = false;
    }

    // Steel shutter in back wall + concrete barriers
    const steel = std({ color: 0x2a313a, roughness: 0.45, metalness: 0.7 });
    for (let i = 0; i < 14; i++) box(s, 6.4, 0.2, 0.08, steel, 2.6, 0.3 + i * 0.24, -8.75);
    box(s, 6.8, 0.25, 0.3, yellow, 2.6, 3.75, -8.7);
    const bar = box(s, 2.4, 0.85, 0.5, std({ color: 0x5c6168, roughness: 0.95 }), -4.2, 0.425, -2.2);
    bar.rotation.y = 0.3;

    // Angled tactical gear lockers along the far left garage bay (complements SWAT squad + truck)
    const lockerBay = new THREE.Group();
    lockerBay.position.set(-4.3, 0, -4.4);
    lockerBay.rotation.y = 0.62;
    s.add(lockerBay);
    const lSteel = std({ color: 0x161c23, roughness: 0.45, metalness: 0.65 });
    const lDark = std({ color: 0x0d1116, roughness: 0.6 });
    const led = new THREE.MeshBasicMaterial({ color: 0xffe9c4 });
    const bw = 0.95, bh = 2.45, bd = 0.65;
    box(lockerBay, bw * 4 + 0.08, bh, 0.05, lDark, 0, bh / 2, -bd / 2);
    box(lockerBay, bw * 4 + 0.08, 0.06, bd, lSteel, 0, bh, 0);
    for (let i = 0; i < 4; i++) {
      const bay = new THREE.Group();
      bay.position.set((i - 1.5) * bw, 0, 0);
      lockerBay.add(bay);
      box(bay, 0.04, bh, bd, lSteel, -bw / 2, bh / 2, 0);
      if (i === 3) box(bay, 0.04, bh, bd, lSteel, bw / 2, bh / 2, 0);
      box(bay, bw - 0.04, 0.5, bd - 0.04, lDark, 0, 0.25, 0);
      box(bay, bw - 0.04, 0.04, bd - 0.06, lSteel, 0, 1.95, 0);
      const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.36, 0.09), new THREE.MeshBasicMaterial({ map: plateTex(LOCKER_NAMES[i]) }));
      plate.position.set(0, 2.32, bd / 2 + 0.005);
      bay.add(plate);
      box(bay, 0.55, 0.02, 0.05, led, 0, 2.26, 0.12);
      const lp = new THREE.PointLight(0xffdfb0, 1.8, 2.6, 1.8);
      lp.position.set(0, 1.85, 0.2);
      bay.add(lp);
      // Helmet + vest silhouette inside bay
      const h = new THREE.Mesh(new THREE.SphereGeometry(0.14, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.6), std({ color: 0x15191f, roughness: 0.4 }));
      h.position.set(0, 2.04, 0.02); bay.add(h);
      box(bay, 0.38, 0.46, 0.14, std({ color: 0x13171d, roughness: 0.85 }), -0.1, 1.4, -0.05);
    }

    // Garage lights
    s.add(new THREE.HemisphereLight(0x88a4cc, 0x12151a, 0.85));
    const key = new THREE.SpotLight(0xffe0b5, 230, 28, 0.62, 0.62, 1.6);
    key.position.set(-2.8, 4.1, 5.8); key.target.position.set(-0.3, 1.0, 0.8);
    key.castShadow = true; key.shadow.mapSize.set(1024, 1024); key.shadow.bias = -0.002;
    s.add(key, key.target);

    const rim = new THREE.SpotLight(0x5da8ff, 360, 28, 0.7, 0.7, 1.5);
    rim.position.set(5.5, 3.6, -4.5); rim.target.position.set(0.2, 1.1, 0.5);
    s.add(rim, rim.target);

    this.blue = new THREE.PointLight(0x2a6bff, 0, 16, 1.6); this.blue.position.set(4.5, 2.2, 1.5);
    this.red = new THREE.PointLight(0xff2a2a, 0, 16, 1.6); this.red.position.set(5.5, 2.2, 0);
    s.add(this.blue, this.red);

    // Floating dust motes
    const n = 220, pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 14;
      pos[i * 3 + 1] = Math.random() * 4;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 10;
    }
    const dg = new THREE.BufferGeometry();
    dg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.dust = new THREE.Points(dg, new THREE.PointsMaterial({ color: 0xcfe0ff, size: 0.024, transparent: true, opacity: 0.4, depthWrite: false }));
    s.add(this.dust);

    window.addEventListener('mousemove', e => { this.mx = e.clientX / innerWidth - 0.5; this.my = e.clientY / innerHeight - 0.5; });
  }

  /** Put the fallback squad in the scene if detailed operators cannot be loaded. */
  squad() {
    if (this.heroes.length) return;
    this.heroMode = false;
    for (const v of this.views) this.scene.remove(v.root);
    this.views = [];
    const spots = [[-0.5, 1.5, 0.25, 0], [0.7, 0.7, -0.2, 1], [-1.7, 0.6, 0.45, 0], [1.8, -0.2, -0.45, 0]];
    spots.forEach(([x, z, yaw, aim], i) => {
      const a = new Actor(900 + i, 'officer', '');
      a.team = i === 1 || i === 3 ? 'B' : 'A'; a.armed = true; a.variant = i; a.x = x; a.z = z; a.yaw = yaw + Math.PI;
      if (aim) a.target = a;
      const v = new ActorView(a);
      if (v.label) { v.root.remove(v.label); v.label = undefined; }
      v.root.position.set(x, 0, z); v.root.rotation.y = a.yaw;
      this.scene.add(v.root); this.views.push(v);
      for (let k = 0; k < 40 + i * 7; k++) v.update(0.033, k);
    });
  }

  /** Replace stand-in squad with detailed SWAT operator models. */
  async hero(count: number) {
    this.heroMode = true;
    if (!(await loadOperator())) { this.heroMode = false; return false; }
    for (const v of this.views) this.scene.remove(v.root);
    this.views = [];
    for (const h of this.heroes) this.scene.remove(h);
    this.heroes = []; this.mixers = [];
    const spots = (window as any).__spots ?? HERO;
    for (let i = 0; i < Math.min(count, spots.length); i++) {
      const [x, z, yaw] = spots[i], m = menuOperator(i * 2.3)!, w = new THREE.Group();
      w.add(m.obj); w.position.set(x, 0, z); w.rotation.y = yaw;
      this.scene.add(w); this.heroes.push(w);
      if (m.mixer) this.mixers.push(m.mixer);
    }
    return true;
  }

  /** Armored SWAT truck («Paramount Marauder») behind the squad, with flashing police light bar. */
  async vehicle(url: string) {
    try {
      const g = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(url), v = g.scene, C = (window as any).__truck ?? TRUCK;
      v.traverse((o: any) => {
        if (!o.isMesh) return;
        o.castShadow = true; o.receiveShadow = true;
        const m = o.material as THREE.MeshStandardMaterial; m.envMapIntensity = 0.9;
        const tint = PAINT[m.name];
        if (tint) { m.color.setHex(tint[0]); m.roughness = tint[1]; m.metalness = tint[2]; }
      });
      const w = new THREE.Group();
      w.add(v); w.position.set(C[0], 0, C[1]); w.rotation.y = C[2];
      this.scene.add(w); this.truck = w;
      w.updateMatrixWorld(true);
      const meshes: THREE.Mesh[] = [];
      v.traverse((o: any) => { if (o.isMesh) meshes.push(o); });
      const ray = new THREE.Raycaster();
      const hit = (from: THREE.Vector3, dir: THREE.Vector3) => { ray.set(w.localToWorld(from), dir.transformDirection(w.matrixWorld)); return ray.intersectObjects(meshes, false)[0]; };
      const tex = T.textTex('POLICE');
      for (const sgn of [-1, 1]) {
        const h = hit(new THREE.Vector3(C[5], C[6], sgn * 4), new THREE.Vector3(0, 0, -sgn));
        if (!h || !h.face) continue;
        const n = h.face.normal.clone().transformDirection(h.object.matrixWorld);
        const d = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 0.2), new THREE.MeshStandardMaterial({ map: tex, transparent: true, roughness: 0.6, metalness: 0, polygonOffset: true, polygonOffsetFactor: -4 }));
        d.position.copy(h.point).addScaledVector(n, 0.012); d.lookAt(h.point.clone().add(n));
        this.scene.add(d); w.attach(d);
      }
      const top = hit(new THREE.Vector3(C[4], 6, 0), new THREE.Vector3(0, -1, 0));
      const bar = new THREE.Group();
      bar.position.set(C[4], (top ? w.worldToLocal(top.point.clone()).y : C[3]) + 0.05, 0);
      bar.rotation.y = Math.PI / 2; w.add(bar);
      const dark = new THREE.MeshStandardMaterial({ color: 0x0c0e11, roughness: 0.4, metalness: 0.6 });
      bar.add(new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.05, 0.3), dark));
      for (const x of [-0.6, 0.6]) { const foot = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.1, 0.3), dark); foot.position.set(x, -0.05, 0); bar.add(foot); }
      this.lens = [0x2a6bff, 0xff2a2a].map((c, i) => {
        const m = new THREE.MeshStandardMaterial({ color: 0x111418, emissive: c, emissiveIntensity: 0, roughness: 0.25 });
        const b = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.1, 0.24), m);
        b.position.set(i ? 0.37 : -0.37, 0.075, 0); bar.add(b); return m;
      });
      const mid = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.11, 0.26), dark);
      mid.position.y = 0.075; bar.add(mid);
      this.blue.position.set(-0.6, 0.5, 0.3); this.red.position.set(0.6, 0.5, 0.3);
      bar.add(this.blue, this.red);
      return true;
    } catch (e) { console.warn('vehicle model', e); return false; }
  }

  upgradeWeapons() { /* kept for compatibility */ }

  env(r: THREE.WebGLRenderer) {
    if (this.scene.environment) return;
    const pm = new THREE.PMREMGenerator(r);
    this.scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.35;
    pm.dispose();
  }

  resize(aspect: number) {
    this.cam.aspect = aspect;
    this.cam.fov = aspect < 1.3 ? 44 : 31;
    this.cam.updateProjectionMatrix();
  }

  update(dt: number) {
    this.t += dt;
    const t = this.t;
    for (const m of this.mixers) m.update(dt);
    for (const v of this.views) { v.a.x = v.root.position.x; v.a.z = v.root.position.z; v.update(dt, t); }
    const ph = (t * 1.3) % 1, fl = (p: number) => (p < 0.08 || (p > 0.14 && p < 0.22) ? 1 : 0);
    this.blue.intensity = fl(ph) * 55;
    this.red.intensity = fl((ph + 0.5) % 1) * 40;
    if (this.lens.length) {
      this.lens[0].emissiveIntensity = 0.25 + fl(ph) * 5;
      this.lens[1].emissiveIntensity = 0.25 + fl((ph + 0.5) % 1) * 5;
    }
    this.dust.rotation.y = t * 0.012;
    this.dust.position.y = Math.sin(t * 0.2) * 0.1;
    this.cx += (this.mx - this.cx) * Math.min(1, dt * 2);
    this.cy += (this.my - this.cy) * Math.min(1, dt * 2);
    const wide = this.cam.aspect >= 1.3, heroCam = this.heroes.length > 0 || this.heroMode;
    this.cam.position.set(
      (wide ? -0.95 : 0.8) + Math.sin(t * 0.13) * 0.28 + this.cx * 0.45,
      1.48 - this.cy * 0.22 + Math.sin(t * 0.21) * 0.035,
      (heroCam ? 6.6 : 7.4) + Math.cos(t * 0.11) * 0.22,
    );
    this.cam.lookAt(wide ? 0.55 : 0.9, heroCam ? 1.18 : 0.98, -0.35);
  }
}
