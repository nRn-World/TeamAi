import * as THREE from 'three';
import * as T from './textures';
import { ActorView } from './world';
import { Actor } from '../sim/sim';

/** Live 3D backdrop for the main menu: the squad waiting in a parking garage, lit by a patrol car's light bar. */
export class MenuScene {
  scene = new THREE.Scene(); cam = new THREE.PerspectiveCamera(30, 1, 0.1, 80);
  private views: ActorView[] = []; private t = 0; private blue: THREE.PointLight; private red: THREE.PointLight; private dust: THREE.Points;
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
    // unmarked van silhouette behind the squad
    const vanM = std({ color: 0x1c232c, roughness: 0.4, metalness: 0.3 }), glass = std({ color: 0x1b2836, roughness: 0.1, metalness: 0.9 });
    box(5.2, 1.9, 2.2, vanM, 3.4, 1.3, -4.2); box(1.5, 1.2, 2.2, vanM, 0.2, 0.95, -4.2); box(0.06, 0.7, 1.8, glass, 0.82, 1.85, -4.2);
    for (const x of [0.4, 4.8]) { const w = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 2.3, 18), std({ color: 0x08090b, roughness: 0.9 })); w.rotation.x = Math.PI / 2; w.position.set(x, 0.42, -4.2); s.add(w); }
    const bar = box(0.3, 0.1, 1.2, new THREE.MeshBasicMaterial({ color: 0x223355 }), 1.6, 2.3, -4.2); bar.castShadow = false;
    // lights
    s.add(new THREE.HemisphereLight(0xa9c0e0, 0x1a1d22, 1.1));
    const key = new THREE.SpotLight(0xffe2bd, 250, 30, 0.6, 0.6, 1.6); key.position.set(-2.5, 4.1, 6); key.target.position.set(1.6, 1, 0); key.castShadow = true; key.shadow.mapSize.set(1024, 1024); key.shadow.bias = -0.002; s.add(key, key.target);
    const rim = new THREE.SpotLight(0x6fb6ff, 420, 30, 0.7, 0.7, 1.5); rim.position.set(6.5, 3.6, -5); rim.target.position.set(1.5, 1.2, 0.5); s.add(rim, rim.target);
    this.blue = new THREE.PointLight(0x2a6bff, 0, 16, 1.6); this.blue.position.set(1.6, 2.6, -3.4); this.red = new THREE.PointLight(0xff2a2a, 0, 16, 1.6); this.red.position.set(1.6, 2.6, -5); s.add(this.blue, this.red);
    for (const x of [-6, 0, 6]) { const w = new THREE.SpotLight(0xbfd4ff, 60, 14, 0.9, 0.8, 1.4); w.position.set(x, 4, -6.5); w.target.position.set(x, 1.5, -9); s.add(w, w.target); }
    // drifting dust in the light
    const n = 260, pos = new Float32Array(n * 3); for (let i = 0; i < n; i++) { pos[i * 3] = (Math.random() - 0.5) * 14; pos[i * 3 + 1] = Math.random() * 4; pos[i * 3 + 2] = (Math.random() - 0.5) * 10; }
    const dg = new THREE.BufferGeometry(); dg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.dust = new THREE.Points(dg, new THREE.PointsMaterial({ color: 0xcfe0ff, size: 0.025, transparent: true, opacity: 0.45, depthWrite: false })); s.add(this.dust);
    window.addEventListener('mousemove', e => { this.mx = e.clientX / innerWidth - 0.5; this.my = e.clientY / innerHeight - 0.5; });
  }
  /** Put the squad in the scene (call once the character models are loaded; safe to call again). */
  squad() {
    for (const v of this.views) this.scene.remove(v.root); this.views = [];
    //            x     z     yaw   aiming
    const spots = [[1.5, 1.5, -0.25, 0], [2.7, 0.7, -0.6, 1], [0.4, 0.5, 0.1, 0], [3.8, -0.3, -0.45, 0], [-0.6, -0.5, 0.3, 0]];
    spots.forEach(([x, z, yaw, aim], i) => {
      const a = new Actor(900 + i, 'officer', ''); a.team = i === 1 || i === 3 ? 'B' : 'A'; a.armed = true; a.variant = i; a.x = x; a.z = z; a.yaw = yaw; if (aim) a.target = a;
      a.yaw = yaw + Math.PI; const v = new ActorView(a); if (v.label) { v.root.remove(v.label); v.label = undefined; } v.root.position.set(x, 0, z); v.root.rotation.y = a.yaw; this.scene.add(v.root); this.views.push(v);
      for (let k = 0; k < 40 + i * 7; k++) v.update(0.033, k); // settle into pose, each at a different phase of the idle
    });
  }
  resize(aspect: number) { this.cam.aspect = aspect; this.cam.fov = aspect < 1.3 ? 44 : 30; this.cam.updateProjectionMatrix(); }
  update(dt: number) {
    this.t += dt; const t = this.t;
    for (const v of this.views) { v.a.x = v.root.position.x; v.a.z = v.root.position.z; v.update(dt, t); }
    // light bar: alternating double flashes
    const ph = (t * 1.3) % 1, fl = (p: number) => (p < 0.08 || (p > 0.14 && p < 0.22) ? 1 : 0);
    this.blue.intensity = fl(ph) * 55; this.red.intensity = fl((ph + 0.5) % 1) * 40;
    this.dust.rotation.y = t * 0.012; this.dust.position.y = Math.sin(t * 0.2) * 0.1;
    this.cx += (this.mx - this.cx) * Math.min(1, dt * 2); this.cy += (this.my - this.cy) * Math.min(1, dt * 2);
    const wide = this.cam.aspect >= 1.3;
    this.cam.position.set((wide ? -1.3 : 1.2) + Math.sin(t * 0.13) * 0.35 + this.cx * 0.5, 1.5 - this.cy * 0.25 + Math.sin(t * 0.21) * 0.04, 7.4 + Math.cos(t * 0.11) * 0.25);
    this.cam.lookAt(wide ? -0.1 : 1.4, 0.98, 0);
  }
}
