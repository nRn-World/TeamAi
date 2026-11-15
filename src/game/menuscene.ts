import * as THREE from 'three';
import * as T from './textures';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { weaponModel, weaponsReady } from './weapons';

const LOCKER_NAMES = ['KEN', 'MAYA', 'JACK', 'ZOE'];

/** Crisp nameplate texture for each SWAT locker. */
function plateTex(name: string) {
  return T.make('plate_' + name, 192, 48, (g, w, h) => {
    g.fillStyle = '#14181e'; g.fillRect(0, 0, w, h);
    g.strokeStyle = '#4c5868'; g.lineWidth = 3; g.strokeRect(2, 2, w - 4, h - 4);
    g.fillStyle = '#e8eef5'; g.font = 'bold 26px "Barlow Condensed", system-ui, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(name, w / 2, h / 2 + 1);
  });
}

/** Stencil wall badge texture (e.g. A1). */
function stencilTex(text: string) {
  return T.make('stencil_' + text, 128, 128, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    g.fillStyle = 'rgba(210, 220, 232, 0.34)';
    g.font = 'bold 72px "Barlow Condensed", system-ui, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, w / 2, h / 2);
  });
}

/** Live 3D backdrop for the main menu: illuminated SWAT armory & locker room (Ken, Maya, Jack, Zoe). */
export class MenuScene {
  scene = new THREE.Scene();
  cam = new THREE.PerspectiveCamera(34, 1, 0.1, 80);
  private t = 0;
  private dust: THREE.Points;
  private lockerRifles: THREE.Group[] = [];
  private riflesUpgraded = false;
  private mx = 0; private my = 0; private cx = 0; private cy = 0;

  constructor() {
    const s = this.scene;
    s.background = new THREE.Color(0x070a0f);
    s.fog = new THREE.Fog(0x070a0f, 7, 22);

    const std = (o: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial(o);
    const box = (parent: THREE.Object3D, w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number) => {
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
      b.position.set(x, y, z); b.castShadow = true; b.receiveShadow = true;
      parent.add(b);
      return b;
    };

    // Floor
    const ft = T.floorTex('concrete').clone();
    ft.wrapS = ft.wrapT = THREE.RepeatWrapping; ft.repeat.set(10, 10); ft.needsUpdate = true;
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(36, 36),
      std({ map: ft, color: 0x626a74, roughness: 0.38, metalness: 0.32 }),
    );
    floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true;
    s.add(floor);

    // Armory walls & ceiling
    const wallMat = std({ color: 0x262d36, roughness: 0.85, metalness: 0.1 });
    const trimMat = std({ color: 0x141920, roughness: 0.7 });
    box(s, 28, 6, 0.3, wallMat, 0, 3, -3.5);
    box(s, 0.3, 6, 18, wallMat, -5.6, 3, 2);
    box(s, 0.3, 6, 18, wallMat, 8.2, 3, 2);
    box(s, 28, 0.3, 18, trimMat, 0, 4.5, 2);

    // Wall stencil "A1" on left wall
    const a1 = new THREE.Mesh(
      new THREE.PlaneGeometry(0.9, 0.9),
      new THREE.MeshBasicMaterial({ map: stencilTex('A1'), transparent: true, depthWrite: false }),
    );
    a1.position.set(-5.42, 1.85, 0.2); a1.rotation.y = Math.PI / 2;
    s.add(a1);

    // Tactical whiteboard on right wall (background interest behind briefing card)
    const wb = new THREE.Group();
    wb.position.set(5.6, 1.9, -3.28);
    box(wb, 2.2, 1.25, 0.05, std({ color: 0x28303a, metalness: 0.4, roughness: 0.5 }), 0, 0, 0);
    box(wb, 2.08, 1.13, 0.06, std({ color: 0x9aa4ae, roughness: 0.8 }), 0, 0, 0.01);
    s.add(wb);

    // Materials for lockers & tactical gear
    const steel = std({ color: 0x1a2027, roughness: 0.42, metalness: 0.68 });
    const steelDark = std({ color: 0x101419, roughness: 0.55, metalness: 0.5 });
    const vestMat = std({ color: 0x16191e, roughness: 0.82 });
    const pouchMat = std({ color: 0x22272e, roughness: 0.78 });
    const gunMat = std({ color: 0x232830, roughness: 0.38, metalness: 0.62 });
    const helmMat = std({ color: 0x181c22, roughness: 0.45, metalness: 0.3 });
    const visorMat = std({ color: 0x111a24, roughness: 0.2, metalness: 0.5 });
    const ledMat = new THREE.MeshBasicMaterial({ color: 0xfff1d8 });
    const polisMat = std({ map: T.polisTex(), roughness: 0.6 });
    const canisterMat = std({ color: 0x2f3b32, roughness: 0.45, metalness: 0.4 });

    // 4 Illuminated SWAT Lockers (KEN, MAYA, JACK, ZOE)
    const lockerRow = new THREE.Group();
    lockerRow.position.set(-1.35, 0, -2.55);
    lockerRow.rotation.y = 0.28;
    s.add(lockerRow);

    const bayW = 1.12, bayH = 2.62, bayD = 0.78;
    const totalW = bayW * 4;
    // Shared top/back structure
    box(lockerRow, totalW + 0.08, bayH, 0.06, steelDark, 0, bayH / 2, -bayD / 2);
    box(lockerRow, totalW + 0.08, 0.08, bayD, steel, 0, bayH, 0);

    for (let i = 0; i < 4; i++) {
      const bx = (i - 1.5) * bayW;
      const bay = new THREE.Group();
      bay.position.set(bx, 0, 0);
      lockerRow.add(bay);

      // Dividers & shelves
      box(bay, 0.05, bayH, bayD, steel, -bayW / 2, bayH / 2, 0);
      if (i === 3) box(bay, 0.05, bayH, bayD, steel, bayW / 2, bayH / 2, 0);
      box(bay, bayW - 0.04, 0.58, bayD - 0.04, steelDark, 0, 0.29, 0); // lower cabinet
      box(bay, bayW - 0.04, 0.04, bayD - 0.06, steel, 0, 2.08, 0);     // helmet shelf
      box(bay, bayW - 0.04, 0.04, bayD - 0.06, steel, 0, 0.85, 0);     // gear shelf

      // Nameplate
      const plate = new THREE.Mesh(
        new THREE.PlaneGeometry(0.42, 0.1),
        new THREE.MeshBasicMaterial({ map: plateTex(LOCKER_NAMES[i]) }),
      );
      plate.position.set(0, 2.48, bayD / 2 + 0.005);
      bay.add(plate);

      // Overhead warm LED light bar + interior spotlight
      box(bay, 0.65, 0.025, 0.07, ledMat, 0, 2.42, 0.14);
      const pl = new THREE.PointLight(0xffe6c0, 3.6, 3.2, 1.8);
      pl.position.set(0, 2.0, 0.18);
      bay.add(pl);

      // Top shelf: Tactical Helmet
      const helm = new THREE.Group();
      helm.position.set(-0.08, 2.1, 0.02);
      helm.rotation.y = 0.25 - i * 0.12;
      const dome = new THREE.Mesh(new THREE.SphereGeometry(0.16, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.6), helmMat);
      dome.position.y = 0.11; dome.scale.set(0.95, 1.0, 1.1);
      helm.add(dome);
      box(helm, 0.16, 0.06, 0.08, visorMat, 0, 0.14, 0.15);
      bay.add(helm);

      // Hanging Tactical Ballistic Vest with POLICE patch
      const vest = new THREE.Group();
      vest.position.set(-0.2, 1.56, -0.05);
      box(vest, 0.42, 0.48, 0.16, vestMat, 0, 0, 0);
      box(vest, 0.1, 0.14, 0.16, vestMat, -0.15, 0.28, 0);
      box(vest, 0.1, 0.14, 0.16, vestMat, 0.15, 0.28, 0);
      for (let p = -1; p <= 1; p++) box(vest, 0.09, 0.15, 0.07, pouchMat, p * 0.11, -0.13, 0.1);
      const patch = new THREE.Mesh(new THREE.PlaneGeometry(0.24, 0.09), polisMat);
      patch.position.set(0, 0.09, 0.085);
      vest.add(patch);
      bay.add(vest);

      // Upright M4 Carbine inside right side of locker
      const rifleHolder = new THREE.Group();
      rifleHolder.position.set(0.24, 1.32, 0.02);
      rifleHolder.rotation.set(0.04, -0.2, 0);
      const fb = new THREE.Group();
      box(fb, 0.055, 0.34, 0.08, gunMat, 0, 0, 0);
      box(fb, 0.045, 0.38, 0.055, gunMat, 0, 0.34, 0);
      box(fb, 0.022, 0.24, 0.022, gunMat, 0, 0.62, 0);
      box(fb, 0.045, 0.24, 0.1, pouchMat, 0, -0.28, 0);
      box(fb, 0.04, 0.14, 0.065, gunMat, 0, -0.04, 0.09);
      rifleHolder.add(fb);
      bay.add(rifleHolder);
      this.lockerRifles.push(rifleHolder);

      // Lower shelf gear: pouches / flashbang canisters
      for (let k = 0; k < 3; k++) {
        const c = new THREE.Mesh(new THREE.CylinderGeometry(0.036, 0.036, 0.14, 10), canisterMat);
        c.position.set(-0.28 + k * 0.1, 0.67, 0.12);
        bay.add(c);
      }
      box(bay, 0.34, 0.22, 0.26, pouchMat, 0.15, 0.71, 0.04);
    }

    // Foreground left bench + tactical POLICE gear bag & resting helmet
    const bench = new THREE.Group();
    bench.position.set(-3.15, 0, -0.35);
    bench.rotation.y = 0.55;
    box(bench, 1.35, 0.07, 0.48, std({ color: 0x3f2d21, roughness: 0.75 }), 0, 0.45, 0);
    box(bench, 0.08, 0.45, 0.42, steelDark, -0.55, 0.225, 0);
    box(bench, 0.08, 0.45, 0.42, steelDark, 0.55, 0.225, 0);
    // Police gear bag on bench
    box(bench, 0.54, 0.32, 0.34, vestMat, -0.24, 0.65, 0);
    const bagPatch = new THREE.Mesh(new THREE.PlaneGeometry(0.28, 0.1), polisMat);
    bagPatch.position.set(-0.24, 0.66, 0.175);
    bench.add(bagPatch);
    // Resting helmet next to bag
    const bHelm = new THREE.Mesh(new THREE.SphereGeometry(0.15, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.6), helmMat);
    bHelm.position.set(0.32, 0.56, 0.03);
    bench.add(bHelm);
    s.add(bench);

    // Foreground right tactical equipment crate
    box(s, 1.2, 0.55, 0.7, steelDark, 3.2, 0.275, -1.6);

    // Lighting
    s.add(new THREE.HemisphereLight(0x7c9bc4, 0x101318, 0.75));
    const key = new THREE.SpotLight(0xd9e8ff, 110, 18, 0.75, 0.65, 1.4);
    key.position.set(-1.5, 4.1, 3.8); key.target.position.set(-1.0, 1.3, -2.3);
    key.castShadow = true; key.shadow.mapSize.set(1024, 1024); key.shadow.bias = -0.002;
    s.add(key, key.target);

    const blueFill = new THREE.SpotLight(0x3b7fff, 95, 16, 0.85, 0.7, 1.4);
    blueFill.position.set(5.2, 3.6, 2.2); blueFill.target.position.set(1.0, 1.1, -2.4);
    s.add(blueFill, blueFill.target);

    // Subtle floating dust motes in overhead light
    const n = 180, pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 10;
      pos[i * 3 + 1] = 0.3 + Math.random() * 3.4;
      pos[i * 3 + 2] = -3 + Math.random() * 5;
    }
    const dg = new THREE.BufferGeometry();
    dg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.dust = new THREE.Points(dg, new THREE.PointsMaterial({ color: 0xbcd4f5, size: 0.022, transparent: true, opacity: 0.38, depthWrite: false }));
    s.add(this.dust);

    window.addEventListener('mousemove', e => { this.mx = e.clientX / innerWidth - 0.5; this.my = e.clientY / innerHeight - 0.5; });
  }

  /** Upgrade fallback locker rifles to the real GLB weapon model once loaded. */
  upgradeWeapons() {
    if (this.riflesUpgraded || !weaponsReady) return;
    this.riflesUpgraded = true;
    for (const h of this.lockerRifles) {
      const m = weaponModel('rifle');
      if (!m) continue;
      h.clear();
      m.rotation.set(Math.PI / 2, 0, 0);
      m.scale.setScalar(1.35);
      m.position.set(0, 0.02, 0);
      h.add(m);
    }
  }

  // Compatibility stubs so callers remain clean
  squad() { /* armory lockers serve as the hero backdrop */ }
  async hero(_count = 3) { return false; }
  async vehicle(_url = '') { return false; }

  env(r: THREE.WebGLRenderer) {
    if (this.scene.environment) return;
    const pm = new THREE.PMREMGenerator(r);
    this.scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.28;
    pm.dispose();
  }

  resize(aspect: number) {
    this.cam.aspect = aspect;
    this.cam.fov = aspect < 1.3 ? 46 : 34;
    this.cam.updateProjectionMatrix();
  }

  update(dt: number) {
    this.t += dt;
    this.upgradeWeapons();
    this.dust.rotation.y = this.t * 0.009;
    this.cx += (this.mx - this.cx) * Math.min(1, dt * 2.2);
    this.cy += (this.my - this.cy) * Math.min(1, dt * 2.2);
    const wide = this.cam.aspect >= 1.3;
    this.cam.position.set(
      (wide ? 1.55 : 0.4) + Math.sin(this.t * 0.14) * 0.16 + this.cx * 0.35,
      1.52 - this.cy * 0.18 + Math.sin(this.t * 0.22) * 0.025,
      wide ? 3.55 : 4.6,
    );
    this.cam.lookAt(wide ? 0.35 : -0.4, 1.38, -2.35);
  }
}
