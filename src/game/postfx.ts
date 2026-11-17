// Screen-space finish for the tactical view: bloom on lights, cinematic grade,
// vignette, grain, edge aberration and FXAA. Built on the three.js addons (MIT).
//
// The world and the weapon are two separate scenes drawn one after the other, so
// the composer runs two render passes into the same HDR buffer — the weapon keeps
// its own camera and never gets fogged by the level.
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { FXAAPass } from 'three/examples/jsm/postprocessing/FXAAPass.js';

/** Grain, vignette, aberration and a teal-shadow / warm-highlight grade, in linear HDR. */
const GradeShader = {
  name: 'TacticalGrade',
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uVignette: { value: 0.72 },
    uGrain: { value: 0.026 },
    uCa: { value: 0.0015 },
    uContrast: { value: 1.12 },
    uSaturation: { value: 1.1 },
    uTintMix: { value: 0.16 },
    uCool: { value: new THREE.Color(0x9fc4ff) },
    uWarm: { value: new THREE.Color(0xffd7a8) },
    uFlash: { value: 0 },
    uFlashColor: { value: new THREE.Color(0xff2a24) },
    uNvg: { value: 0 },
    uResolution: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uTime, uVignette, uGrain, uCa, uContrast, uSaturation, uTintMix, uFlash, uNvg;
    uniform vec3 uCool, uWarm, uFlashColor;
    uniform vec2 uResolution;
    varying vec2 vUv;

    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }

    void main() {
      vec2 c = vUv - 0.5;
      float r2 = dot(c, c);

      // lens: a touch of colour fringing that grows towards the frame edge
      vec2 off = c * uCa * (0.4 + r2 * 3.0);
      vec3 col;
      col.r = texture2D(tDiffuse, vUv + off).r;
      col.g = texture2D(tDiffuse, vUv).g;
      col.b = texture2D(tDiffuse, vUv - off).b;

      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));

      // grade: cool the shadows, warm the highlights
      float sh = 1.0 - smoothstep(0.0, 0.55, l);
      float hi = smoothstep(0.5, 1.6, l);
      col = mix(col, col * uCool, sh * uTintMix);
      col = mix(col, col * uWarm, hi * uTintMix);

      col = (col - 0.5) * uContrast + 0.5;
      col = (col - 0.01) * 1.01;   // slight toe: crush the washed-out near-black
      float lg = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(lg), col, uSaturation);

      // night vision: green phosphor everywhere the lens sees
      if (uNvg > 0.001) {
        vec3 nv = vec3(lg * 0.42, lg * 1.55, lg * 0.62) + vec3(0.0, 0.012, 0.004);
        col = mix(col, nv, uNvg);
      }

      // vignette + film grain
      vec2 vc = c * vec2(uResolution.x / max(uResolution.y, 1.0), 1.0);
      float vig = 1.0 - smoothstep(0.22, 1.15, length(vc) * 1.1);
      col *= mix(1.0, vig, uVignette);
      col += (hash(vUv * uResolution + fract(uTime) * 91.7) - 0.5) * uGrain * (1.0 + lg * 2.0);

      // damage / hit flash creeps in from the edges
      if (uFlash > 0.001) {
        float edge = smoothstep(0.22, 0.85, length(vc));
        col = mix(col, uFlashColor, edge * uFlash);
      }

      gl_FragColor = vec4(max(col, 0.0), 1.0);
    }
  `,
};

export interface PostOptions {
  bloom?: number;
  threshold?: number;
  radius?: number;
}

/**
 * Owns the composer for one mission's scenes. Recreate it whenever the level is
 * rebuilt (a new Scene is created per mission).
 */
export class PostFX {
  readonly composer: EffectComposer;
  private bloomPass: UnrealBloomPass;
  private grade: ShaderPass;
  private fxaa: FXAAPass;
  private quality = 2;
  private t = 0;

  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    viewScene: THREE.Scene,
    viewCam: THREE.Camera,
    opts: PostOptions = {},
  ) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const target = new THREE.WebGLRenderTarget(Math.max(1, size.x), Math.max(1, size.y), {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
    });
    this.composer = new EffectComposer(renderer, target);
    this.composer.setPixelRatio(renderer.getPixelRatio());

    const world = new RenderPass(scene, camera);
    const view = new RenderPass(viewScene, viewCam);
    view.clear = false;
    view.clearDepth = true;
    this.composer.addPass(world);
    this.composer.addPass(view);

    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(Math.max(1, size.x), Math.max(1, size.y)),
      opts.bloom ?? 0.17,
      opts.radius ?? 0.45,
      opts.threshold ?? 2.7,
    );
    this.composer.addPass(this.bloomPass);

    this.composer.addPass(new OutputPass());

    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);

    this.fxaa = new FXAAPass();
    this.composer.addPass(this.fxaa);

    this.composer.setSize(innerWidth, innerHeight);
  }

  /** 0 = straight to the canvas, 1 = grade + bloom, 2 = plus FXAA, 3 = a beefier bloom. */
  setQuality(q: number) {
    this.quality = Math.max(0, Math.min(3, q | 0));
    this.bloomPass.enabled = this.quality >= 1;
    this.grade.enabled = this.quality >= 1;
    this.fxaa.enabled = this.quality >= 2;
    this.bloomPass.strength = this.quality >= 3 ? 0.24 : 0.17;
    this.bloomPass.radius = this.quality >= 3 ? 0.52 : 0.45;
  }

  get enabled() { return this.quality >= 1; }

  setSize(w: number, h: number, pixelRatio = 1) {
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(w, h);
    this.grade.uniforms.uResolution.value.set(w * pixelRatio, h * pixelRatio);
    this.fxaa.setSize(w * pixelRatio, h * pixelRatio);
  }

  set flash(v: number) { this.grade.uniforms.uFlash.value = THREE.MathUtils.clamp(v, 0, 1); }
  set nvg(v: number) { this.grade.uniforms.uNvg.value = THREE.MathUtils.clamp(v, 0, 1); }
  set vignette(v: number) { this.grade.uniforms.uVignette.value = v; }

  render(dt: number) {
    this.t += dt;
    this.grade.uniforms.uTime.value = this.t;
    this.composer.render(dt);
  }

  dispose() {
    this.composer.dispose();
    this.bloomPass.dispose();
  }
}
