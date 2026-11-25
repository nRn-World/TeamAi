import * as THREE from 'three';
import * as T from './textures';
import { ActorView } from './world';
import { Actor } from '../sim/sim';
import { loadOperator, menuOperator, equipOperatorLoadout } from './operator';
import type { PrimaryLoadout, SecondaryLoadout } from '../sim/sim';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { loadGltfWithRetry, runChunked } from './loader';

const HERO = [[-0.65, 2.0, 0.25], [0.45, 1.15, -0.15], [-1.75, 0.9, 0.45]]; // x, z, yaw — framed left-center so right briefing card never covers the squad
const TRUCK = [0.05, -4.05, 3.48, 2.3, 0.9, 2.05, 1.42]; // Paramount Marauder: x, z, yaw, fallback roof height, light bar x, lettering x & y
const PATROL = [2.65, -8.1, -0.44]; // Police SUV cruiser: visible in open street corridor right-rear of Marauder
const PAINT: Record<string, [number, number, number]> = { Body_2: [0x2c3648, 0.36, 0.55], Metal_UP_5: [0x394354, 0.42, 0.62] };

function loadTex(url: string, rx: number, ry: number, srgb = true) {
  const tex = new THREE.TextureLoader().load(url);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(rx, ry);
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function glowTex(inner: string, outer: string) {
  return T.make('glow_' + inner + '_' + outer, 128, 128, (g, w, h) => {
    const gr = g.createRadialGradient(w / 2, h / 2, 2, w / 2, h / 2, w / 2);
    gr.addColorStop(0, inner);
    gr.addColorStop(0.35, outer);
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, w, h);
  });
}

/** Subtle interior room glow atlas rendered behind the 3D Poly Haven glass window panes. */
function nightRoomTex(seed: number, dim = 1) {
  return T.make('night_rooms_' + seed + '_' + dim, 128, 128, (g, w, h) => {
    g.fillStyle = '#090d14';
    g.fillRect(0, 0, w, h);
    let r = seed * 9301 + 49297;
    const rnd = () => { r = (r * 9301 + 49297) % 233280; return r / 233280; };
    const cols = 6, rows = 6, cw = w / cols, rh = h / rows;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        if (rnd() > 0.62) {
          const warm = rnd() > 0.35;
          const alpha = (0.28 + rnd() * 0.48) * dim;
          const gr = g.createLinearGradient(x * cw, y * rh, x * cw, (y + 1) * rh);
          gr.addColorStop(0, warm ? `rgba(255,212,148,${alpha})` : `rgba(155,204,255,${alpha * 0.85})`);
          gr.addColorStop(1, warm ? `rgba(140,102,58,${alpha * 0.45})` : `rgba(60,92,135,${alpha * 0.4})`);
          g.fillStyle = gr;
          g.fillRect(x * cw + 1, y * rh + 1, cw - 2, rh - 2);
        }
      }
    }
  });
}

function cautionTapeTex() {
  return T.make('caution_tape', 256, 32, (g, w, h) => {
    g.fillStyle = '#d8a61c';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#17191d';
    for (let x = -32; x < w + 32; x += 36) {
      g.beginPath();
      g.moveTo(x, 0); g.lineTo(x + 14, 0); g.lineTo(x + 2, h); g.lineTo(x - 12, h);
      g.closePath(); g.fill();
    }
    g.fillStyle = '#14161a';
    g.font = 'bold 13px "Barlow Condensed", system-ui, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('POLICE LINE · DO NOT CROSS', w / 2, h / 2 + 0.5);
  });
}

function skyTex() {
  return T.make('night_sky', 512, 256, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, 0, h);
    gr.addColorStop(0.0, '#040810');
    gr.addColorStop(0.45, '#091322');
    gr.addColorStop(0.75, '#132236');
    gr.addColorStop(1.0, '#0c1522');
    g.fillStyle = gr;
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 36; i++) {
      const cx = ((i * 73) % w), cy = h * 0.42 + ((i * 29) % 70);
      const rad = 55 + (i % 5) * 28;
      const cg = g.createRadialGradient(cx, cy, 4, cx, cy, rad);
      cg.addColorStop(0, 'rgba(34,54,82,0.22)');
      cg.addColorStop(1, 'rgba(10,18,30,0)');
      g.fillStyle = cg;
      g.fillRect(cx - rad, cy - rad, rad * 2, rad * 2);
    }
  });
}

interface FacadeModule {
  nodes: THREE.Object3D[];
  origin: THREE.Matrix4;
  width: number;
}

interface InstEntry {
  mesh: THREE.Mesh;
  mats: THREE.Matrix4[];
  shadow: boolean;
}

/** Live 3D backdrop for the main menu: rainy Nordic night urban police perimeter with Poly Haven modular architecture, SWAT squad, Marauder & Police SUV. */
export class MenuScene {
  scene = new THREE.Scene();
  cam = new THREE.PerspectiveCamera(31, 1, 0.1, 160);
  private views: ActorView[] = [];
  private t = 0;
  private blue: THREE.PointLight;
  private red: THREE.PointLight;
  private moonKey: THREE.DirectionalLight;
  private suvBlue?: THREE.PointLight;
  private suvRed?: THREE.PointLight;
  private suvBeacons: THREE.MeshStandardMaterial[] = [];
  private rain: THREE.LineSegments;
  private rainPos: Float32Array;
  private mist: THREE.Points;
  private truck?: THREE.Group;
  private patrol?: THREE.Group;
  private lens: THREE.MeshStandardMaterial[] = [];
  private heroes: THREE.Group[] = [];
  private mixers: THREE.AnimationMixer[] = [];
  private heroMode = false;
  private mx = 0; private my = 0; private cx = 0; private cy = 0;
  ready = false;
  private cityReady: Promise<void>;

  constructor() {
    const s = this.scene;
    s.background = new THREE.Color(0x08101b);
    s.fog = new THREE.FogExp2(0x09111d, 0.017);

    const std = (o: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial(o);
    const box = (parent: THREE.Object3D, w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number) => {
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
      b.position.set(x, y, z); b.castShadow = b.receiveShadow = true;
      parent.add(b);
      return b;
    };

    // Stormy overcast Nordic night sky dome
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(95, 24, 16),
      new THREE.MeshBasicMaterial({ map: skyTex(), side: THREE.BackSide, fog: false }),
    );
    s.add(sky);

    // Wet reflective asphalt street (Poly Haven CC0 textures)
    const roadColor = loadTex('./textures/menu/road_color.webp', 10, 20, true);
    const roadNorm = loadTex('./textures/menu/road_normal.webp', 10, 20, false);
    const roadRough = loadTex('./textures/menu/road_rough.webp', 10, 20, false);
    const roadMat = std({
      map: roadColor,
      normalMap: roadNorm,
      normalScale: new THREE.Vector2(0.85, 0.85),
      roughnessMap: roadRough,
      color: 0x5c6674,
      roughness: 0.24,
      metalness: 0.36,
      envMapIntensity: 1.25,
    });
    const road = new THREE.Mesh(new THREE.PlaneGeometry(36, 108), roadMat);
    road.rotation.x = -Math.PI / 2;
    road.position.set(0, 0, -34);
    road.receiveShadow = true;
    s.add(road);

    // Crosswalk stripes & road markings
    const paintMat = std({ color: 0xc9d2dd, roughness: 0.32, metalness: 0.1, polygonOffset: true, polygonOffsetFactor: -2 });
    for (let i = -5; i <= 5; i++) {
      const stripe = new THREE.Mesh(new THREE.PlaneGeometry(0.48, 2.2), paintMat);
      stripe.rotation.x = -Math.PI / 2;
      stripe.position.set(i * 1.05, 0.004, 1.35);
      stripe.receiveShadow = true;
      s.add(stripe);
    }
    for (let z = -3; z > -65; z -= 4.8) {
      const dash = new THREE.Mesh(new THREE.PlaneGeometry(0.14, 2.1), paintMat);
      dash.rotation.x = -Math.PI / 2;
      dash.position.set(0.2, 0.004, z);
      s.add(dash);
    }

    // Raised concrete sidewalks & granite kerbs
    const swColor = loadTex('./textures/menu/sidewalk_color.webp', 5, 28, true);
    const swNorm = loadTex('./textures/menu/sidewalk_normal.webp', 5, 28, false);
    const swMat = std({ map: swColor, normalMap: swNorm, color: 0x727a86, roughness: 0.45, metalness: 0.12 });
    const kerbMat = std({ color: 0x4b535e, roughness: 0.65 });
    for (const side of [-1, 1]) {
      box(s, 14, 0.14, 108, swMat, side * 13.9, 0.07, -34);
      box(s, 0.24, 0.16, 108, kerbMat, side * 6.9, 0.08, -34);
    }

    // Chain-link security fence posts + police caution tape along left & right perimeter
    const postMat = std({ color: 0x2e3640, roughness: 0.45, metalness: 0.75 });
    const meshWireMat = std({ color: 0x5c6978, roughness: 0.5, metalness: 0.7, wireframe: true, transparent: true, opacity: 0.42 });
    const tapeMat = new THREE.MeshBasicMaterial({ map: cautionTapeTex(), side: THREE.DoubleSide });
    const fenceLine = (x0: number, z0: number, x1: number, z1: number, segs: number, withMesh = true) => {
      for (let i = 0; i <= segs; i++) {
        const f = i / segs, px = x0 + (x1 - x0) * f, pz = z0 + (z1 - z0) * f;
        box(s, 0.06, 2.0, 0.06, postMat, px, 1.0, pz);
      }
      const dx = x1 - x0, dz = z1 - z0, len = Math.hypot(dx, dz), ang = Math.atan2(dx, dz);
      if (withMesh) {
        const panel = new THREE.Mesh(new THREE.PlaneGeometry(len, 1.85, Math.max(4, segs * 4), 6), meshWireMat);
        panel.position.set((x0 + x1) / 2, 1.0, (z0 + z1) / 2);
        panel.rotation.y = ang + Math.PI / 2;
        s.add(panel);
      }
      const tape = new THREE.Mesh(new THREE.PlaneGeometry(len, 0.08), tapeMat);
      tape.position.set((x0 + x1) / 2, 0.94, (z0 + z1) / 2);
      tape.rotation.y = ang + Math.PI / 2;
      s.add(tape);
    };
    fenceLine(-6.35, 2.2, -6.55, -10.5, 4, true);
    fenceLine(5.95, 0.8, 6.45, -9.8, 4, false);

    // Outdoor night lighting: cool skylight + key backlight rim on operators + emergency light bounces
    s.add(new THREE.HemisphereLight(0x6d92be, 0x101722, 1.15));
    const moonKey = this.moonKey = new THREE.DirectionalLight(0xc2d8ff, 1.65);
    moonKey.position.set(-7.5, 13.5, 7.5);
    moonKey.castShadow = true;
    moonKey.shadow.mapSize.set(1024, 1024);
    moonKey.shadow.camera.near = 1;
    moonKey.shadow.camera.far = 42;
    moonKey.shadow.camera.left = -12; moonKey.shadow.camera.right = 12;
    moonKey.shadow.camera.top = 12; moonKey.shadow.camera.bottom = -8;
    moonKey.shadow.bias = -0.0015;
    s.add(moonKey);

    const warmFill = new THREE.SpotLight(0xffdfb8, 115, 24, 0.65, 0.75, 1.5);
    warmFill.position.set(-4.8, 4.4, 5.2);
    warmFill.target.position.set(-0.5, 1.05, 1.1);
    s.add(warmFill, warmFill.target);

    const coolRim = new THREE.SpotLight(0x529dff, 175, 26, 0.7, 0.75, 1.5);
    coolRim.position.set(3.2, 3.8, -5.5);
    coolRim.target.position.set(-0.6, 1.1, 1.2);
    s.add(coolRim, coolRim.target);

    this.blue = new THREE.PointLight(0x246bff, 0, 18, 1.5); this.blue.position.set(1.2, 2.3, -3.5);
    this.red = new THREE.PointLight(0xff2626, 0, 18, 1.5); this.red.position.set(2.0, 2.3, -3.8);
    s.add(this.blue, this.red);

    // Falling night rain streaks
    const rc = 780;
    this.rainPos = new Float32Array(rc * 6);
    for (let i = 0; i < rc; i++) {
      const rx = (Math.random() - 0.5) * 24;
      const ry = Math.random() * 11;
      const rz = -14 + Math.random() * 22;
      const len = 0.24 + Math.random() * 0.18;
      this.rainPos[i * 6] = rx; this.rainPos[i * 6 + 1] = ry; this.rainPos[i * 6 + 2] = rz;
      this.rainPos[i * 6 + 3] = rx - 0.04; this.rainPos[i * 6 + 4] = ry - len; this.rainPos[i * 6 + 5] = rz + 0.02;
    }
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(this.rainPos, 3));
    this.rain = new THREE.LineSegments(rg, new THREE.LineBasicMaterial({ color: 0xa8c6e8, transparent: true, opacity: 0.28, depthWrite: false }));
    s.add(this.rain);

    // Subtle low mist motes catching headlights
    const n = 180, pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 18;
      pos[i * 3 + 1] = 0.15 + Math.random() * 3.4;
      pos[i * 3 + 2] = -9 + Math.random() * 14;
    }
    const dg = new THREE.BufferGeometry();
    dg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.mist = new THREE.Points(dg, new THREE.PointsMaterial({ color: 0xb6cde8, size: 0.03, transparent: true, opacity: 0.24, depthWrite: false }));
    s.add(this.mist);

    // Load real photorealistic Poly Haven CC0 buildings, streetlights, concrete barriers & urban props
    this.cityReady = this.buildCity();

    window.addEventListener('mousemove', e => { this.mx = e.clientX / innerWidth - 0.5; this.my = e.clientY / innerHeight - 0.5; });
  }

  whenReady() { return this.cityReady; }

  /** Assembles real Poly Haven CC0 modular apartment & industrial buildings, cast-iron streetlamps, concrete barriers and street props. */
  private async buildCity() {
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    const cityFiles = [
      'modular_urban_apartments_facade',
      'modular_factory_facade',
      'street_lamp_01',
      'street_lamp_02',
      'concrete_road_barrier',
      'concrete_road_barrier_02',
      'fire_hydrant',
      'metal_trash_can',
      'exterior_aircon_unit',
    ] as const;

    const kits: Record<string, THREE.Group> = {};
    await runChunked(cityFiles, 4, async name => {
      try {
        const g = await loadGltfWithRetry(loader, `./models/city/${name}.glb`, 3, 450);
        const sc = g.scene;
        sc.updateMatrixWorld(true);
        sc.traverse((o: any) => {
          if (!o.isMesh) return;
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of mats) {
            if (!m) continue;
            m.envMapIntensity = /glass/i.test(m.name) ? 1.65 : 0.9;
            if (m.name === 'street_lamp_01_glass' || /lamp.*glass/i.test(m.name)) {
              m.emissive = new THREE.Color(0xffe4b5);
              m.emissiveIntensity = 3.4;
            }
          }
        });
        kits[name] = sc;
      } catch (e) {
        console.warn('city asset failed:', name, e);
      }
    });

    const inst = new Map<string, InstEntry>();
    const modCache: Record<string, FacadeModule | null> = {};
    const propCache: Record<string, { nodes: THREE.Object3D[]; origin: THREE.Matrix4 } | null> = {};
    const cityGroup = new THREE.Group();

    const placeNodes = (nodes: THREE.Object3D[], originM: THREE.Matrix4, M: THREE.Matrix4, shadow = true) => {
      const inv = originM.clone().invert();
      for (const n of nodes) {
        n.traverse((o: any) => {
          if (!o.isMesh) return;
          const key = o.uuid + (shadow ? 's' : 'n');
          let e = inst.get(key);
          if (!e) { e = { mesh: o, mats: [], shadow }; inst.set(key, e); }
          e.mats.push(new THREE.Matrix4().multiplyMatrices(M, inv).multiply(o.matrixWorld));
        });
      }
    };

    const getMod = (kitName: string, wallName: string): FacadeModule | null => {
      const key = kitName + '/' + wallName;
      if (key in modCache) return modCache[key];
      const kit = kits[kitName];
      if (!kit) return (modCache[key] = null);
      const wall = kit.getObjectByName(wallName);
      if (!wall) return (modCache[key] = null);
      const wb = new THREE.Box3().setFromObject(wall);
      const nodes: THREE.Object3D[] = [wall];
      for (const c of kit.children) {
        if (c === wall || /^(wall_|cornice|crown|dado|base)/.test(c.name)) continue;
        const b = new THREE.Box3().setFromObject(c);
        const ctr = b.getCenter(new THREE.Vector3());
        if (ctr.x > wb.min.x && ctr.x < wb.max.x && ctr.y > wb.min.y && ctr.y < wb.max.y && ctr.z > wb.max.z - 1.2 && ctr.z < wb.max.z + 0.6) {
          nodes.push(c);
        }
      }
      const origin = new THREE.Matrix4().makeTranslation(wb.min.x, wb.min.y, wb.max.z);
      return (modCache[key] = { nodes, origin, width: Math.round(wb.max.x - wb.min.x) });
    };

    const getTrim = (kitName: string, name: string) => {
      const kit = kits[kitName];
      if (!kit) return null;
      const n = kit.getObjectByName(name);
      if (!n) return null;
      const b = new THREE.Box3().setFromObject(n);
      return { nodes: [n], origin: new THREE.Matrix4().makeTranslation(b.min.x, b.min.y, 0) };
    };

    const q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1), up = new THREE.Vector3(0, 1, 0);
    const buildBlock = (x0: number, z0: number, x1: number, z1: number, floors: number, kit: 'apt' | 'fac', seed: number, lightDim = 1) => {
      const K = kit === 'apt' ? 'modular_urban_apartments_facade' : 'modular_factory_facade';
      if (!kits[K]) return;
      let rs = seed * 9301 + 49297;
      const rnd = () => ((rs = (rs * 9301 + 49297) % 233280) / 233280);
      const ground = kit === 'apt'
        ? ['wall_door_centered_large_01', 'wall_standard_standard_01', 'wall_door_centered_small_01', 'wall_standard_standard_01', 'wall_door_centered_small_02', 'wall_standard_standard_01']
        : ['wall_door_recessed_large_01', 'wall_standard_standard_01', 'wall_door_recessed_small_01', 'wall_door_garage_door_01', 'wall_standard_standard_01', 'wall_door_centered_small_01'];
      const upperSets = kit === 'apt'
        ? [['wall_window_centered_large_01', 'wall_window_centered_large_02'], ['wall_window_centered_double_01', 'wall_window_centered_double_02'], ['wall_window_centered_small_01', 'wall_window_centered_small_02'], ['wall_door_window_small_01', 'wall_window_centered_large_01'], ['wall_window_offset_small_01', 'wall_window_offset_small_03']]
        : [['wall_window_centered_large_01', 'wall_window_centered_large_02'], ['wall_window_tall_large_01', 'wall_window_tall_large_02'], ['wall_window_centered_medium_01', 'wall_window_centered_medium_02'], ['wall_window_centered_double_01', 'wall_window_centered_double_02'], ['wall_window_tall_small_01', 'wall_window_tall_small_02']];
      const upper = upperSets[(rnd() * upperSets.length) | 0];
      const H = floors * 3;
      const faces = [
        { len: x1 - x0, at: (i: number) => new THREE.Vector3(x0 + i, 0, z1), rot: 0 },
        { len: x1 - x0, at: (i: number) => new THREE.Vector3(x1 - i, 0, z0), rot: Math.PI },
        { len: z1 - z0, at: (i: number) => new THREE.Vector3(x1, 0, z1 - i), rot: Math.PI / 2 },
        { len: z1 - z0, at: (i: number) => new THREE.Vector3(x0, 0, z0 + i), rot: -Math.PI / 2 },
      ];
      const corn = getTrim(K, kit === 'apt' ? 'cornice_standard_standard_01' : 'cornice02_standard_standard_01');
      const crown = getTrim(K, 'crown_standard_standard_01');
      for (const f of faces) {
        q.setFromAxisAngle(up, f.rot);
        for (let fl = 0; fl < floors; fl++) {
          let u = 0;
          while (u < f.len - 0.01) {
            const name = fl === 0 ? ground[(rnd() * ground.length) | 0] : upper[fl % 2];
            let m = getMod(K, name);
            if (!m || u + m.width > f.len + 0.01) m = getMod(K, fl === 0 ? 'wall_standard_standard_01' : upper[0]);
            if (!m) break;
            const p = f.at(u); p.y = fl * 3 + 0.14;
            placeNodes(m.nodes, m.origin, new THREE.Matrix4().compose(p, q, one), true);
            u += Math.max(1, m.width);
          }
          if (fl > 0 && corn) {
            for (let u2 = 0; u2 < f.len - 0.01; u2 += 3) {
              const p = f.at(u2); p.y = fl * 3 + 0.04;
              placeNodes(corn.nodes, corn.origin, new THREE.Matrix4().compose(p, q, one), false);
            }
          }
        }
        if (crown) {
          for (let u2 = 0; u2 < f.len - 0.01; u2 += 3) {
            const p = f.at(u2); p.y = H + 0.14;
            placeNodes(crown.nodes, crown.origin, new THREE.Matrix4().compose(p, q, one), false);
          }
        }
      }
      const pier = kits[K].getObjectByName('wall_pier_corner_01');
      if (pier) {
        const pb = new THREE.Box3().setFromObject(pier);
        const pc = pb.getCenter(new THREE.Vector3());
        const po = new THREE.Matrix4().makeTranslation(pc.x, pb.min.y, pc.z);
        for (const [cx, cz] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) {
          for (let fl = 0; fl < floors; fl++) {
            placeNodes([pier], po, new THREE.Matrix4().makeTranslation(cx, fl * 3 + 0.14, cz), true);
          }
        }
      }
      // Interior lit-room core visible behind the 3D transparent glass window panes
      const roomTex = nightRoomTex(seed, lightDim);
      const innerMat = new THREE.MeshStandardMaterial({
        color: 0x10151e,
        roughness: 0.95,
        emissive: new THREE.Color(0xffffff),
        emissiveMap: roomTex,
        emissiveIntensity: 0.9 * lightDim,
      });
      const inner = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0 - 0.65, H - 0.1, z1 - z0 - 0.65), innerMat);
      inner.position.set((x0 + x1) / 2, H / 2 + 0.14, (z0 + z1) / 2);
      cityGroup.add(inner);

      const roof = new THREE.Mesh(
        new THREE.BoxGeometry(x1 - x0 - 0.1, 0.3, z1 - z0 - 0.1),
        new THREE.MeshStandardMaterial({ color: 0x262b33, roughness: 0.9 }),
      );
      roof.position.set((x0 + x1) / 2, H + 0.14, (z0 + z1) / 2);
      cityGroup.add(roof);
    };

    const placeProp = (file: string, filter: string, x: number, z: number, rot = 0, y = 0, scale = 1) => {
      const kit = kits[file];
      if (!kit) return;
      const key = file + '|' + filter;
      let pc = propCache[key];
      if (pc === undefined) {
        const rx = new RegExp(filter);
        const nodes = kit.children.filter(c => rx.test(c.name));
        if (!nodes.length) { propCache[key] = null; return; }
        const b = new THREE.Box3();
        nodes.forEach(n => b.expandByObject(n));
        const ctr = b.getCenter(new THREE.Vector3());
        pc = propCache[key] = { nodes, origin: new THREE.Matrix4().makeTranslation(ctr.x, b.min.y, ctr.z) };
      }
      if (!pc) return;
      const qProp = new THREE.Quaternion().setFromAxisAngle(up, rot);
      placeNodes(pc.nodes, pc.origin, new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), qProp, new THREE.Vector3(scale, scale, scale)), true);
    };

    // Real Poly Haven urban buildings lining the rainy street (18m/24m multiples for seamless 3m modular fit)
    buildBlock(-25.5, -20, -7.5, -2, 4, 'apt', 11, 1.0);
    buildBlock(-25.5, -40, -7.5, -22, 4, 'fac', 22, 0.95);
    buildBlock(-25.5, -60, -7.5, -42, 5, 'apt', 33, 0.85);

    buildBlock(-12, -63, 12, -45, 5, 'fac', 44, 0.8);
    buildBlock(-31, -65, -13, -47, 5, 'apt', 55, 0.75);
    buildBlock(13, -65, 31, -47, 5, 'apt', 66, 0.45);

    buildBlock(7.5, -21, 25.5, -3, 4, 'fac', 77, 0.35);
    buildBlock(7.5, -41, 25.5, -23, 5, 'apt', 88, 0.3);

    // Ornate Poly Haven cast-iron streetlamps along both sidewalks + glowing warm light pools
    const haloTex = glowTex('rgba(255,232,188,0.68)', 'rgba(130,175,235,0.16)');
    const lampSpecs: [number, number, number, boolean][] = [
      [-7.25, -3.5, Math.PI / 2, true],
      [-7.25, -17.5, Math.PI / 2, true],
      [-7.25, -31.5, Math.PI / 2, false],
      [7.25, -5.5, -Math.PI / 2, true],
      [7.25, -19.5, -Math.PI / 2, false],
      [7.25, -33.5, -Math.PI / 2, false],
    ];
    for (const [lx, lz, rot, withLight] of lampSpecs) {
      placeProp('street_lamp_01', '^street_lamp_01$', lx, lz, rot, 0.14, 1.15);
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: haloTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.72 }));
      sp.position.set(lx, 4.1, lz);
      sp.scale.set(2.9, 2.9, 1);
      cityGroup.add(sp);
      if (withLight) {
        const pl = new THREE.PointLight(0xffdfb4, lz < -10 ? 18 : 26, 17, 1.55);
        pl.position.set(lx + (lx < 0 ? 0.55 : -0.55), 4.05, lz);
        cityGroup.add(pl);
      }
    }

    // Wall-mounted street lamps & AC units on the left apartment/office facades
    for (const [wx, wy, wz] of [[-7.45, 3.3, -6.5], [-7.45, 3.3, -13.5], [-7.45, 3.3, -25.0]]) {
      placeProp('street_lamp_02', '.', wx, wz, Math.PI / 2, wy, 1.0);
      const wl = new THREE.PointLight(0xffd7a3, 10, 10, 1.6);
      wl.position.set(wx + 0.6, wy - 0.1, wz);
      cityGroup.add(wl);
    }
    for (const [ax, ay, az] of [[-7.4, 4.1, -9.5], [-7.4, 7.1, -11.5], [-7.4, 4.2, -28.5]]) {
      placeProp('exterior_aircon_unit', '^exterior_aircon_unit$', ax, az, Math.PI / 2, ay, 1.0);
    }

    // Real Poly Haven concrete road barriers along the police cordon
    const barrierSpots: [string, number, number, number][] = [
      ['concrete_road_barrier', -4.85, -0.7, 0.25],
      ['concrete_road_barrier_02', -5.55, -2.5, 0.12],
      ['concrete_road_barrier', 5.35, -2.1, -0.34],
      ['concrete_road_barrier_02', 5.95, -4.1, -0.15],
    ];
    for (const [kitName, bx, bz, rot] of barrierSpots) {
      placeProp(kitName, '.', bx, bz, rot, 0, 1.0);
    }

    // Sidewalk urban details (hydrants & trash cans)
    placeProp('fire_hydrant', '^fire_hydrant(?!.*aged)', -7.3, -1.3, Math.PI / 2, 0.14, 1.05);
    placeProp('fire_hydrant', '^fire_hydrant(?!.*aged)', 7.3, -10.5, -Math.PI / 2, 0.14, 1.05);
    placeProp('metal_trash_can', '^metal_trash_can(?!_rust)', -8.35, -8.8, 0.4, 0.14, 1.0);
    placeProp('metal_trash_can', '^metal_trash_can(?!_rust)', 8.35, -14.2, -0.3, 0.14, 1.0);

    // Finalize all instanced meshes cleanly
    for (const e of inst.values()) {
      const im = new THREE.InstancedMesh(e.mesh.geometry, e.mesh.material, e.mats.length);
      e.mats.forEach((m, i) => im.setMatrixAt(i, m));
      im.instanceMatrix.needsUpdate = true;
      im.castShadow = e.shadow;
      im.receiveShadow = true;
      im.computeBoundingSphere();
      cityGroup.add(im);
    }

    // Real CC0 Kenney 3D traffic cones along the perimeter cordon
    try {
      const cg = await loadGltfWithRetry(loader, './models/props/traffic_cone.glb', 2, 400);
      const proto = cg.scene;
      proto.traverse((o: any) => { if (o.isMesh) { o.castShadow = o.receiveShadow = true; } });
      for (const [cx, cz, sMul] of [[-3.75, 0.7, 1.15], [-4.45, -1.65, 1.15], [4.45, -1.35, 1.15], [5.05, -3.55, 1.15]]) {
        const c = proto.clone(true);
        c.position.set(cx, 0, cz);
        c.scale.setScalar(sMul);
        cityGroup.add(c);
      }
    } catch { /* optional cones */ }

    // Parked CC0 Innerscene sedan further down the wet curb for street depth
    try {
      const sg = await loadGltfWithRetry(loader, './models/vehicle/sedan_parked.glb', 2, 400);
      const car = sg.scene;
      car.updateMatrixWorld(true);
      const rb = new THREE.Box3().setFromObject(car);
      const sz = rb.getSize(new THREE.Vector3());
      const sf = 4.4 / (Math.max(sz.x, sz.z) || 1);
      car.scale.multiplyScalar(sf);
      car.updateMatrixWorld(true);
      const fb = new THREE.Box3().setFromObject(car);
      car.position.y -= fb.min.y;
      car.traverse((o: any) => {
        if (!o.isMesh) return;
        o.castShadow = o.receiveShadow = true;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          if (!m) continue;
          if (m.name === 'Paint') { m.color.setHex(0x28323e); m.roughness = 0.3; m.metalness = 0.55; }
          if (m.name === 'Taillight') { m.emissive = new THREE.Color(0xff2218); m.emissiveIntensity = 1.6; }
        }
      });
      const wrap = new THREE.Group();
      wrap.add(car);
      wrap.position.set(-5.0, 0, -16.5);
      wrap.rotation.y = 0.05;
      cityGroup.add(wrap);
    } catch { /* optional parked sedan */ }

    this.scene.add(cityGroup);
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
  private curLoadout: { primary: PrimaryLoadout; secondary: SecondaryLoadout } = { primary: 'carbine', secondary: 'pistol' };

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
    this.setHeroLoadout(this.curLoadout.primary, this.curLoadout.secondary);
    return true;
  }

  setHeroLoadout(primary: PrimaryLoadout, secondary: SecondaryLoadout) {
    this.curLoadout = { primary, secondary };
    const lead = this.heroes[0];
    if (lead && lead.children[0]) {
      equipOperatorLoadout(lead.children[0], primary, secondary);
    }
  }

  /** Armored SWAT truck («Paramount Marauder») + Police SUV cruiser behind the squad on the wet street. */
  async vehicle(url: string) {
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    const marauderJob = loadGltfWithRetry(loader, url, 3, 500).then(g => {
      const v = g.scene, C = (window as any).__truck ?? TRUCK;
      v.traverse((o: any) => {
        if (!o.isMesh) return;
        o.castShadow = true; o.receiveShadow = true;
        const m = o.material as THREE.MeshStandardMaterial; m.envMapIntensity = 1.05;
        const tint = PAINT[m.name];
        if (tint) { m.color.setHex(tint[0]); m.roughness = tint[1]; m.metalness = tint[2]; }
      });
      const w = new THREE.Group();
      w.add(v); w.position.set(C[0], 0, C[1]); w.rotation.y = C[2];
      this.truck = w;
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
        w.attach(d);
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
      this.blue.position.set(-0.6, 0.55, 0.3); this.red.position.set(0.6, 0.55, 0.3);
      bar.add(this.blue, this.red);

      const boxM = new THREE.Box3().setFromObject(v);
      const frontX = boxM.max.x > Math.abs(boxM.min.x) ? boxM.max.x : boxM.min.x;
      const headGlowTex = glowTex('rgba(255,244,225,0.9)', 'rgba(180,215,255,0.2)');
      for (const hz of [-0.72, 0.72]) {
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: headGlowTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.72 }));
        sp.position.set(frontX * 0.96, 1.05, hz);
        sp.scale.set(0.9, 0.9, 1);
        w.add(sp);
      }
      return w;
    }).catch(e => { console.warn('vehicle model', e); return null; });

    const patrolJob = this.patrolCar('./models/vehicle/police_suv.glb');
    const [truckGroup, patrolGroup] = await Promise.all([marauderJob, patrolJob]);
    if (truckGroup) this.scene.add(truckGroup);
    if (patrolGroup) this.scene.add(patrolGroup);
    return !!truckGroup;
  }

  /** Realistic CC0 Police SUV cruiser parked to the right-rear with glowing headlights & flashing beacon. */
  async patrolCar(url: string): Promise<THREE.Group | null> {
    try {
      const g = await loadGltfWithRetry(new GLTFLoader().setMeshoptDecoder(MeshoptDecoder), url, 3, 500);
      const v = g.scene;
      v.updateMatrixWorld(true);
      const rawBox = new THREE.Box3().setFromObject(v);
      const rawSize = rawBox.getSize(new THREE.Vector3());
      const maxDim = Math.max(rawSize.x, rawSize.z) || 1;
      const sFactor = 4.85 / maxDim;
      v.scale.multiplyScalar(sFactor);
      v.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(v);
      v.position.y -= box.min.y;
      v.updateMatrixWorld(true);

      this.suvBeacons = [];
      const headBox = new THREE.Box3();
      const beaconBox = new THREE.Box3();
      v.traverse((o: any) => {
        if (!o.isMesh) return;
        o.castShadow = o.receiveShadow = true;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          if (!m) continue;
          m.envMapIntensity = 1.15;
          if (m.name === 'Paint') { m.color.setHex(0x141c27); m.roughness = 0.25; m.metalness = 0.65; }
          if (m.name === 'Headlight') {
            m.emissive = new THREE.Color(0xfff0d6);
            m.emissiveIntensity = 5.0;
            headBox.expandByObject(o);
          }
          if (m.name === 'Taillight') {
            m.emissive = new THREE.Color(0xff1e1e);
            m.emissiveIntensity = 2.2;
          }
          if (m.name === 'Beacon') {
            const bm = m.clone() as THREE.MeshStandardMaterial;
            bm.color.setHex(0x162238);
            bm.emissive = new THREE.Color(this.suvBeacons.length % 2 === 0 ? 0x2674ff : 0xff2b2b);
            bm.emissiveIntensity = 4.5;
            o.material = bm;
            this.suvBeacons.push(bm);
            beaconBox.expandByObject(o);
          }
        }
      });

      const w = new THREE.Group();
      w.add(v);
      w.position.set(PATROL[0], 0, PATROL[1]);
      w.rotation.y = PATROL[2];
      this.patrol = w;

      if (!headBox.isEmpty()) {
        const hc = headBox.getCenter(new THREE.Vector3());
        const forwardSign = hc.z >= 0 ? 1 : -1;
        const spot = new THREE.SpotLight(0xfff1dc, 62, 18, 0.58, 0.72, 1.4);
        spot.position.set(0, hc.y + 0.05, hc.z + forwardSign * 0.1);
        spot.target.position.set(0, 0.05, hc.z + forwardSign * 6.5);
        w.add(spot, spot.target);

        const hg = glowTex('rgba(255,246,225,0.9)', 'rgba(180,215,255,0.22)');
        for (const sx of [-0.68, 0.68]) {
          const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: hg, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.78 }));
          sp.position.set(sx, hc.y, hc.z + forwardSign * 0.12);
          sp.scale.set(0.95, 0.95, 1);
          w.add(sp);
        }
      }

      const by = beaconBox.isEmpty() ? 2.1 : beaconBox.getCenter(new THREE.Vector3()).y + 0.25;
      const bz = beaconBox.isEmpty() ? -0.1 : beaconBox.getCenter(new THREE.Vector3()).z;
      this.suvBlue = new THREE.PointLight(0x2870ff, 0, 14, 1.6);
      this.suvBlue.position.set(-0.4, by, bz);
      this.suvRed = new THREE.PointLight(0xff2626, 0, 14, 1.6);
      this.suvRed.position.set(0.4, by, bz);
      w.add(this.suvBlue, this.suvRed);
      return w;
    } catch (e) {
      console.warn('patrol SUV model', e);
      return null;
    }
  }

  upgradeWeapons() { this.setHeroLoadout(this.curLoadout.primary, this.curLoadout.secondary); }

  env(r: THREE.WebGLRenderer) {
    if (this.scene.environment) return;
    const envScene = new THREE.Scene();
    envScene.background = new THREE.Color(0x0c1624);
    const hemi = new THREE.HemisphereLight(0x4b74a8, 0x0b1118, 1.4);
    envScene.add(hemi);
    const coolStrip = new THREE.Mesh(new THREE.PlaneGeometry(16, 4), new THREE.MeshBasicMaterial({ color: 0x6ea4e8, side: THREE.DoubleSide }));
    coolStrip.position.set(-6, 7, 4); coolStrip.lookAt(0, 0, 0);
    const warmStrip = new THREE.Mesh(new THREE.PlaneGeometry(10, 3), new THREE.MeshBasicMaterial({ color: 0xffd7a6, side: THREE.DoubleSide }));
    warmStrip.position.set(6, 6, -4); warmStrip.lookAt(0, 0, 0);
    envScene.add(coolStrip, warmStrip);

    const pm = new THREE.PMREMGenerator(r);
    this.scene.environment = pm.fromScene(envScene, 0.06).texture;
    this.scene.environmentIntensity = 0.45;
    pm.dispose();
  }

  setQuality(qual: number) {
    this.rain.visible = qual >= 1;
    this.mist.visible = qual >= 1;
    this.moonKey.castShadow = qual >= 2;
    const sz = qual >= 3 ? 2048 : 1024;
    if (this.moonKey.shadow.mapSize.x !== sz) {
      this.moonKey.shadow.mapSize.set(sz, sz);
      this.moonKey.shadow.map?.dispose();
      this.moonKey.shadow.map = null;
    }
    this.scene.environmentIntensity = qual >= 3 ? 0.55 : qual >= 2 ? 0.45 : 0.25;
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
    const ph = (t * 1.35) % 1, fl = (p: number) => (p < 0.08 || (p > 0.14 && p < 0.22) ? 1 : 0);
    const bOn = fl(ph), rOn = fl((ph + 0.5) % 1);
    this.blue.intensity = bOn * 58;
    this.red.intensity = rOn * 44;
    if (this.lens.length) {
      this.lens[0].emissiveIntensity = 0.35 + bOn * 5.2;
      this.lens[1].emissiveIntensity = 0.35 + rOn * 5.2;
    }
    const ph2 = (t * 1.35 + 0.28) % 1, b2 = fl(ph2), r2 = fl((ph2 + 0.5) % 1);
    if (this.suvBlue) this.suvBlue.intensity = b2 * 48;
    if (this.suvRed) this.suvRed.intensity = r2 * 38;
    for (let i = 0; i < this.suvBeacons.length; i++) {
      this.suvBeacons[i].emissiveIntensity = 0.4 + (i % 2 === 0 ? b2 : r2) * 5.5;
    }

    // Animate falling rain streaks
    if (this.rain.visible) {
      const rp = this.rainPos;
      const drop = dt * 13.5;
      for (let i = 0; i < rp.length; i += 6) {
        rp[i] -= drop * 0.055;
        rp[i + 1] -= drop;
        rp[i + 3] -= drop * 0.055;
        rp[i + 4] -= drop;
        if (rp[i + 4] < 0) {
          const dy = rp[i + 1] - rp[i + 4];
          const nx = (Math.random() - 0.5) * 24;
          const ny = 9.5 + Math.random() * 2;
          const nz = -14 + Math.random() * 22;
          rp[i] = nx; rp[i + 1] = ny; rp[i + 2] = nz;
          rp[i + 3] = nx - 0.04; rp[i + 4] = ny - dy; rp[i + 5] = nz + 0.02;
        }
      }
      (this.rain.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    }

    if (this.mist.visible) {
      this.mist.rotation.y = t * 0.008;
      this.mist.position.y = Math.sin(t * 0.22) * 0.08;
    }
    this.cx += (this.mx - this.cx) * Math.min(1, dt * 2);
    this.cy += (this.my - this.cy) * Math.min(1, dt * 2);
    const wide = this.cam.aspect >= 1.3, heroCam = this.heroes.length > 0 || this.heroMode;
    this.cam.position.set(
      (wide ? -0.95 : 0.8) + Math.sin(t * 0.13) * 0.26 + this.cx * 0.45,
      1.5 - this.cy * 0.22 + Math.sin(t * 0.21) * 0.032,
      (heroCam ? 6.65 : 7.4) + Math.cos(t * 0.11) * 0.22,
    );
    this.cam.lookAt(wide ? 0.55 : 0.9, heroCam ? 1.18 : 0.98, -0.35);
  }
}
