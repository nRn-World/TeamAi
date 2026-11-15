import * as THREE from 'three';
import * as T from './textures';
import { ActorView } from './world';
import { Actor } from '../sim/sim';
import { loadOperator, menuOperator } from './operator';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

const HERO = [[-0.65, 2.0, 0.25], [0.45, 1.15, -0.15], [-1.75, 0.9, 0.45]]; // x, z, yaw — framed left-center so right briefing card never covers the squad
const TRUCK = [0.35, -3.9, 3.48, 2.3, 0.9, 2.05, 1.42]; // Paramount Marauder: x, z, yaw, fallback roof height, light bar x, lettering x & y
const PATROL = [3.15, -6.0, -0.58]; // Police SUV cruiser: x, z, yaw (right-rear of Marauder, clear of #armoryCard)
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

function windowMaskTex(seed: number) {
  return T.make('winmask_' + seed, 128, 256, (g, w, h) => {
    g.fillStyle = '#000000';
    g.fillRect(0, 0, w, h);
    let r = seed * 9301 + 49297;
    const rnd = () => { r = (r * 9301 + 49297) % 233280; return r / 233280; };
    const cols = 8, rows = 20, cw = w / cols, rh = h / rows;
    for (let y = 1; y < rows - 1; y++) {
      const floorLit = rnd() > 0.35;
      for (let x = 0; x < cols; x++) {
        if (rnd() > (floorLit ? 0.55 : 0.85)) {
          const warm = rnd() > 0.45;
          g.fillStyle = warm ? `rgba(255,215,155,${0.28 + rnd() * 0.45})` : `rgba(145,195,255,${0.22 + rnd() * 0.35})`;
          g.fillRect(x * cw + 2, y * rh + 3, cw - 4, rh - 6);
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
    // Subtle overcast storm clouds
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

function makeJerseyBarrier(mat: THREE.Material, stripeMat: THREE.Material) {
  const g = new THREE.Group();
  const shape = new THREE.Shape();
  shape.moveTo(-0.30, 0);
  shape.lineTo(0.30, 0);
  shape.lineTo(0.24, 0.18);
  shape.lineTo(0.11, 0.46);
  shape.lineTo(0.08, 0.84);
  shape.lineTo(-0.08, 0.84);
  shape.lineTo(-0.11, 0.46);
  shape.lineTo(-0.24, 0.18);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: 2.1, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.02, bevelSegments: 1 });
  geo.translate(0, 0, -1.05);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = mesh.receiveShadow = true;
  mesh.rotation.y = Math.PI / 2;
  g.add(mesh);
  const cap = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.08, 0.18), stripeMat);
  cap.position.set(0, 0.86, 0);
  g.add(cap);
  return g;
}

/** Live 3D backdrop for the main menu: rainy Nordic night urban police perimeter with SWAT squad, Marauder & Police SUV. */
export class MenuScene {
  scene = new THREE.Scene();
  cam = new THREE.PerspectiveCamera(31, 1, 0.1, 160);
  private views: ActorView[] = [];
  private t = 0;
  private blue: THREE.PointLight;
  private red: THREE.PointLight;
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

  constructor() {
    const s = this.scene;
    s.background = new THREE.Color(0x08101b);
    s.fog = new THREE.FogExp2(0x09111d, 0.021);

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
    const roadColor = loadTex('./textures/menu/road_color.webp', 10, 18, true);
    const roadNorm = loadTex('./textures/menu/road_normal.webp', 10, 18, false);
    const roadRough = loadTex('./textures/menu/road_rough.webp', 10, 18, false);
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
    const road = new THREE.Mesh(new THREE.PlaneGeometry(36, 92), roadMat);
    road.rotation.x = -Math.PI / 2;
    road.position.set(0, 0, -28);
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
    const swColor = loadTex('./textures/menu/sidewalk_color.webp', 4, 22, true);
    const swNorm = loadTex('./textures/menu/sidewalk_normal.webp', 4, 22, false);
    const swMat = std({ map: swColor, normalMap: swNorm, color: 0x707884, roughness: 0.45, metalness: 0.12 });
    const kerbMat = std({ color: 0x4b535e, roughness: 0.65 });
    for (const side of [-1, 1]) {
      box(s, 9, 0.14, 92, swMat, side * 11.4, 0.07, -28);
      box(s, 0.22, 0.15, 92, kerbMat, side * 6.9, 0.075, -28);
    }

    // Concrete Jersey barriers & yellow police tape perimeter
    const barrierMat = std({ map: loadTex('./textures/menu/wall_concrete.webp', 2, 1, true), color: 0x8d959e, roughness: 0.85 });
    const hazardMat = std({ color: 0xd49c1a, roughness: 0.55 });
    const barrierPositions: [number, number, number][] = [
      [-4.9, -0.6, 0.28],
      [-5.65, -3.1, 0.12],
      [5.5, -2.2, -0.35],
      [6.2, -5.0, -0.15],
    ];
    for (const [bx, bz, bry] of barrierPositions) {
      const jb = makeJerseyBarrier(barrierMat, hazardMat);
      jb.position.set(bx, 0, bz);
      jb.rotation.y = bry;
      s.add(jb);
    }

    // Chain-link security fence posts + police caution tape along left and right edges
    const postMat = std({ color: 0x2e3640, roughness: 0.45, metalness: 0.75 });
    const meshWireMat = std({ color: 0x5c6978, roughness: 0.5, metalness: 0.7, wireframe: true, transparent: true, opacity: 0.5 });
    const tapeMat = new THREE.MeshBasicMaterial({ map: cautionTapeTex(), side: THREE.DoubleSide });
    const fenceLine = (x0: number, z0: number, x1: number, z1: number, segs: number, withMesh = true) => {
      for (let i = 0; i <= segs; i++) {
        const f = i / segs, px = x0 + (x1 - x0) * f, pz = z0 + (z1 - z0) * f;
        box(s, 0.06, 2.05, 0.06, postMat, px, 1.02, pz);
      }
      const dx = x1 - x0, dz = z1 - z0, len = Math.hypot(dx, dz), ang = Math.atan2(dx, dz);
      if (withMesh) {
        const panel = new THREE.Mesh(new THREE.PlaneGeometry(len, 1.9, Math.max(4, segs * 4), 6), meshWireMat);
        panel.position.set((x0 + x1) / 2, 1.02, (z0 + z1) / 2);
        panel.rotation.y = ang + Math.PI / 2;
        s.add(panel);
      }
      const tape = new THREE.Mesh(new THREE.PlaneGeometry(len, 0.08), tapeMat);
      tape.position.set((x0 + x1) / 2, 0.96, (z0 + z1) / 2);
      tape.rotation.y = ang + Math.PI / 2;
      s.add(tape);
    };
    fenceLine(-6.3, 2.2, -6.5, -11.5, 4, true);
    fenceLine(5.9, 0.8, 6.4, -10.5, 4, false);

    // Streetlamps with emissive luminaires & atmospheric mist halos
    const lampMat = std({ color: 0x1b222b, roughness: 0.4, metalness: 0.8 });
    const bulbMat = new THREE.MeshBasicMaterial({ color: 0xfff0d4 });
    const haloTex = glowTex('rgba(255,236,198,0.65)', 'rgba(130,175,235,0.16)');
    for (const [lx, lz, dir] of [[-6.8, -2.5, 1], [-6.8, -14.5, 1], [-6.8, -28, 1], [6.8, -6.5, -1], [6.8, -19.5, -1], [6.8, -33, -1]] as const) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.1, 5.4, 8), lampMat);
      pole.position.set(lx, 2.7, lz);
      pole.castShadow = true;
      s.add(pole);
      const arm = box(s, 1.6, 0.08, 0.08, lampMat, lx + dir * 0.72, 5.32, lz);
      arm.castShadow = false;
      const head = box(s, 0.44, 0.06, 0.22, bulbMat, lx + dir * 1.38, 5.26, lz);
      head.castShadow = false;
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: haloTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.68 }));
      sp.position.set(lx + dir * 1.38, 5.1, lz);
      sp.scale.set(3.2, 3.2, 1);
      s.add(sp);
      if (lz > -20) {
        const pl = new THREE.PointLight(lz < -10 ? 0xa6c4ec : 0xffe4b8, lz < -10 ? 18 : 26, 17, 1.6);
        pl.position.set(lx + dir * 1.35, 4.9, lz);
        s.add(pl);
      }
    }

    // Modern Nordic glass office towers & brick buildings lining the rainy street
    const facadeTex = loadTex('./textures/menu/facade_modern.webp', 2, 3, true);
    const brickTex = loadTex('./textures/menu/wall_brick.webp', 3, 4, true);
    const concreteTex = loadTex('./textures/menu/wall_concrete.webp', 2, 3, true);
    const bldgSpecs: [number, number, number, number, number, 'glass' | 'brick' | 'concrete', number, boolean][] = [
      // Left street block (visible behind Marauder & SWAT squad)
      [-12.5, -10.5, 9, 10.5, 10, 'glass', 1, true],
      [-13.0, -23.5, 10, 14.5, 12, 'concrete', 2, true],
      [-13.5, -38.0, 11, 13.5, 13, 'brick', 3, true],
      [-12.0, -53.0, 10, 18.0, 12, 'glass', 4, false],
      // Center-distant skyline closing the avenue in mist
      [-4.2, -39.0, 9.5, 12.0, 8, 'glass', 5, true],
      [4.4, -44.0, 10, 15.5, 9, 'concrete', 6, true],
      [-0.5, -56.0, 16, 19.5, 10, 'glass', 7, true],
      // Right side kept darker so the mission briefing card remains legible
      [13.0, -13.0, 9.5, 11.0, 11, 'concrete', 8, false],
      [13.5, -26.5, 10, 13.5, 12, 'brick', 9, false],
      [14.0, -41.0, 11, 16.0, 13, 'glass', 10, false],
    ];
    for (const [bx, bz, bw, bh, bd, kind, seed, lit] of bldgSpecs) {
      const map = kind === 'glass' ? facadeTex : kind === 'brick' ? brickTex : concreteTex;
      const win = lit ? windowMaskTex(seed) : null;
      const mat = std({
        map,
        color: kind === 'glass' ? 0x3b4d63 : kind === 'brick' ? 0x4b3f3c : 0x3c434d,
        roughness: kind === 'glass' ? 0.28 : 0.78,
        metalness: kind === 'glass' ? 0.55 : 0.1,
        emissive: lit ? new THREE.Color(0xffffff) : new THREE.Color(0x000000),
        emissiveMap: win,
        emissiveIntensity: lit ? 0.85 : 0,
      });
      const b = box(s, bw, bh, bd, mat, bx, bh / 2, bz);
      b.castShadow = false;
      // Rooftop parapet trim
      box(s, bw + 0.25, 0.35, bd + 0.25, std({ color: 0x1a2029, roughness: 0.7 }), bx, bh + 0.15, bz);
    }

    // Subtle glowing rooftop sign on distant left-center office tower (reminiscent of Stockholm/Kista skyline)
    const signTex = T.make('sky_sign', 192, 48, (g, w, h) => {
      g.fillStyle = '#070b12'; g.fillRect(0, 0, w, h);
      g.fillStyle = '#8cc2ff'; g.font = 'bold 26px "Barlow Condensed", system-ui, sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('KISTA CORP', w / 2, h / 2 + 1);
    });
    const skySign = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 1.0), new THREE.MeshBasicMaterial({ map: signTex }));
    skySign.position.set(-4.2, 11.2, -34.9);
    s.add(skySign);

    // Urban street trees in sidewalk planters (midground)
    const trunkMat = std({ color: 0x221d1a, roughness: 0.9 });
    const leafMat = std({ color: 0x16241f, roughness: 0.85 });
    for (const [tx, tz] of [[-8.1, -7.2], [-8.1, -18.5], [8.1, -10.5]]) {
      const tr = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.16, 2.2, 7), trunkMat);
      tr.position.set(tx, 1.2, tz);
      s.add(tr);
      for (let k = 0; k < 3; k++) {
        const crown = new THREE.Mesh(new THREE.IcosahedronGeometry(1.15 - k * 0.16, 1), leafMat);
        crown.position.set(tx + (k - 1) * 0.35, 2.75 + (k % 2) * 0.45, tz + (k === 1 ? 0.3 : -0.2));
        s.add(crown);
      }
    }

    // Real CC0 Kenney 3D traffic cones along the police perimeter
    void new GLTFLoader().loadAsync('./models/props/traffic_cone.glb').then(g => {
      const proto = g.scene;
      proto.traverse((o: any) => { if (o.isMesh) { o.castShadow = o.receiveShadow = true; } });
      for (const [cx, cz, sMul] of [[-3.75, 0.7, 1.15], [-4.45, -1.65, 1.15], [4.55, -1.35, 1.15], [5.15, -3.75, 1.15]]) {
        const c = proto.clone(true);
        c.position.set(cx, 0, cz);
        c.scale.setScalar(sMul);
        s.add(c);
      }
    }).catch(() => { /* optional cone props */ });

    // Outdoor night lighting: cool skylight + key backlight rim on operators + emergency light bounces
    s.add(new THREE.HemisphereLight(0x6385b0, 0x0e141e, 1.05));
    const moonKey = new THREE.DirectionalLight(0xc2d8ff, 1.55);
    moonKey.position.set(-7.5, 11.5, 6.5);
    moonKey.castShadow = true;
    moonKey.shadow.mapSize.set(1024, 1024);
    moonKey.shadow.camera.near = 1;
    moonKey.shadow.camera.far = 35;
    moonKey.shadow.camera.left = -9; moonKey.shadow.camera.right = 9;
    moonKey.shadow.camera.top = 8; moonKey.shadow.camera.bottom = -8;
    moonKey.shadow.bias = -0.0015;
    s.add(moonKey);

    const warmFill = new THREE.SpotLight(0xffdfb8, 115, 22, 0.65, 0.75, 1.5);
    warmFill.position.set(-4.8, 4.4, 5.2);
    warmFill.target.position.set(-0.5, 1.05, 1.1);
    s.add(warmFill, warmFill.target);

    const coolRim = new THREE.SpotLight(0x529dff, 175, 24, 0.7, 0.75, 1.5);
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
      const rz = -12 + Math.random() * 20;
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
    this.mist = new THREE.Points(dg, new THREE.PointsMaterial({ color: 0xb6cde8, size: 0.03, transparent: true, opacity: 0.26, depthWrite: false }));
    s.add(this.mist);

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

  /** Armored SWAT truck («Paramount Marauder») + Police SUV cruiser behind the squad on the wet street. */
  async vehicle(url: string) {
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    const marauderJob = loader.loadAsync(url).then(g => {
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
      this.blue.position.set(-0.6, 0.55, 0.3); this.red.position.set(0.6, 0.55, 0.3);
      bar.add(this.blue, this.red);

      // Subtle Marauder LED headlights glowing on the wet road
      const boxM = new THREE.Box3().setFromObject(v);
      const frontX = boxM.max.x > Math.abs(boxM.min.x) ? boxM.max.x : boxM.min.x;
      const headGlowTex = glowTex('rgba(255,244,225,0.9)', 'rgba(180,215,255,0.2)');
      for (const hz of [-0.72, 0.72]) {
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: headGlowTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.72 }));
        sp.position.set(frontX * 0.96, 1.05, hz);
        sp.scale.set(0.9, 0.9, 1);
        w.add(sp);
      }
      return true;
    }).catch(e => { console.warn('vehicle model', e); return false; });

    const patrolJob = this.patrolCar('./models/vehicle/police_suv.glb');
    const [ok] = await Promise.all([marauderJob, patrolJob]);
    return ok;
  }

  /** Realistic CC0 Police SUV cruiser parked to the right-rear with glowing headlights & flashing beacon. */
  async patrolCar(url: string) {
    try {
      const g = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(url);
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

      // Dark tactical police livery + glowing headlights, taillights & roof beacons
      this.suvBeacons = [];
      let headBox = new THREE.Box3();
      let beaconBox = new THREE.Box3();
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
      this.scene.add(w);
      this.patrol = w;

      // Headlight beam pools & wet-asphalt reflection bounce
      if (!headBox.isEmpty()) {
        const hc = headBox.getCenter(new THREE.Vector3());
        const forwardSign = hc.z >= 0 ? 1 : -1;
        const spot = new THREE.SpotLight(0xfff1dc, 55, 16, 0.58, 0.72, 1.4);
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
      return true;
    } catch (e) {
      console.warn('patrol SUV model', e);
      return false;
    }
  }

  upgradeWeapons() { /* kept for compatibility */ }

  env(r: THREE.WebGLRenderer) {
    if (this.scene.environment) return;
    // Cool night environment reflection for wet asphalt, glass towers & vehicles
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
        const nz = -12 + Math.random() * 20;
        rp[i] = nx; rp[i + 1] = ny; rp[i + 2] = nz;
        rp[i + 3] = nx - 0.04; rp[i + 4] = ny - dy; rp[i + 5] = nz + 0.02;
      }
    }
    (this.rain.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;

    this.mist.rotation.y = t * 0.008;
    this.mist.position.y = Math.sin(t * 0.22) * 0.08;
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
