// All textures are generated procedurally at runtime – no third-party image assets.
import * as THREE from 'three';

type Draw = (g: CanvasRenderingContext2D, w: number, h: number) => void;
const cache = new Map<string, THREE.CanvasTexture>();

function rnd(seed: number) { let a = seed; return () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; }; }

function grain(g: CanvasRenderingContext2D, w: number, h: number, amt: number, seed = 1) {
  const img = g.getImageData(0, 0, w, h), d = img.data, r = rnd(seed);
  for (let i = 0; i < d.length; i += 4) { const n = (r() - 0.5) * amt; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
  g.putImageData(img, 0, 0);
}
function blotches(g: CanvasRenderingContext2D, w: number, h: number, n: number, color: string, seed = 3) {
  const r = rnd(seed);
  for (let i = 0; i < n; i++) {
    const x = r() * w, y = r() * h, s = 10 + r() * 50, gr = g.createRadialGradient(x, y, 0, x, y, s);
    gr.addColorStop(0, color); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(x - s, y - s, s * 2, s * 2);
  }
}
export function make(key: string, w: number, h: number, draw: Draw): THREE.CanvasTexture {
  const hit = cache.get(key); if (hit) return hit;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true })!; draw(g, w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
  cache.set(key, t); return t;
}

export const wallTex = (base: string, trim: string, key: string) => make('wall' + key, 128, 384, (g, w, h) => {
  g.fillStyle = base; g.fillRect(0, 0, w, h);
  const gr = g.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, 'rgba(0,0,0,0.18)'); gr.addColorStop(0.2, 'rgba(0,0,0,0)'); gr.addColorStop(0.8, 'rgba(0,0,0,0.05)'); gr.addColorStop(1, 'rgba(0,0,0,0.3)');
  g.fillStyle = gr; g.fillRect(0, 0, w, h);
  blotches(g, w, h, 8, 'rgba(0,0,0,0.07)', key.length * 7 + 1);
  g.fillStyle = trim; g.fillRect(0, h - 16, w, 16); g.fillStyle = 'rgba(255,255,255,0.12)'; g.fillRect(0, h - 16, w, 2);
  g.fillStyle = 'rgba(0,0,0,0.12)'; g.fillRect(0, h * 0.62, w, 2);
  grain(g, w, h, 14, 5);
});
export const brickTex = (key: string, a: string, b: string) => make('brick' + key, 128, 384, (g, w, h) => {
  g.fillStyle = '#3a3836'; g.fillRect(0, 0, w, h); const r = rnd(11);
  for (let y = 0, row = 0; y < h; y += 16, row++) for (let x = -32; x < w; x += 32) {
    const k = r(); g.fillStyle = k < 0.5 ? a : b; g.globalAlpha = 0.8 + r() * 0.2; g.fillRect(x + (row % 2 ? 16 : 0) + 1, y + 1, 30, 14);
  }
  g.globalAlpha = 1; const gr = g.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, 'rgba(0,0,0,0.25)'); gr.addColorStop(0.3, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,0.4)'); g.fillStyle = gr; g.fillRect(0, 0, w, h);
  grain(g, w, h, 22, 9);
});
export const floorTex = (kind: string) => make('floor' + kind, 256, 256, (g, w, h) => {
  const r = rnd(kind.length * 31 + 7);
  if (kind === 'carpet') { g.fillStyle = '#39485c'; g.fillRect(0, 0, w, h); grain(g, w, h, 34, 2); g.strokeStyle = 'rgba(0,0,0,0.12)'; for (let i = 0; i <= w; i += 128) { g.strokeRect(i, 0, 128, h); g.strokeRect(0, i, w, 128); } }
  else if (kind === 'tile') { g.fillStyle = '#b9b4a8'; g.fillRect(0, 0, w, h); for (let x = 0; x < w; x += 64) for (let y = 0; y < h; y += 64) { g.fillStyle = `rgba(${r() < 0.5 ? '255,255,255' : '0,0,0'},${r() * 0.07})`; g.fillRect(x, y, 64, 64); } g.strokeStyle = '#6f6a60'; g.lineWidth = 2; for (let i = 0; i <= w; i += 64) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, h); g.moveTo(0, i); g.lineTo(w, i); g.stroke(); } grain(g, w, h, 12, 3); }
  else if (kind === 'wood') { for (let y = 0; y < h; y += 32) { let x = -r() * 100; while (x < w) { const l = 90 + r() * 80; g.fillStyle = `hsl(${26 + r() * 8},${38 + r() * 10}%,${24 + r() * 9}%)`; g.fillRect(x, y, l, 32); g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(x, y, 1.5, 32); x += l; } g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(0, y, w, 1.5); } grain(g, w, h, 16, 4); }
  else if (kind === 'asphalt') { g.fillStyle = '#2b2d30'; g.fillRect(0, 0, w, h); grain(g, w, h, 40, 6); blotches(g, w, h, 10, 'rgba(0,0,0,0.25)', 8); }
  else if (kind === 'ceiling') { g.fillStyle = '#c9c9c4'; g.fillRect(0, 0, w, h); grain(g, w, h, 16, 7); g.strokeStyle = '#8d8d88'; g.lineWidth = 3; for (let i = 0; i <= w; i += 128) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, h); g.moveTo(0, i); g.lineTo(w, i); g.stroke(); } }
  else { g.fillStyle = '#77756f'; g.fillRect(0, 0, w, h); blotches(g, w, h, 14, 'rgba(0,0,0,0.12)', 5); blotches(g, w, h, 8, 'rgba(255,255,255,0.05)', 12); grain(g, w, h, 26, 8); g.strokeStyle = 'rgba(0,0,0,0.25)'; g.lineWidth = 1; g.beginPath(); let x = r() * w, y = 0; g.moveTo(x, y); while (y < h) { x += (r() - 0.5) * 30; y += 12; g.lineTo(x, y); } g.stroke(); g.strokeStyle = 'rgba(0,0,0,0.3)'; g.lineWidth = 2; g.strokeRect(0, 0, w, h); }
});
export const crateTex = () => make('crate', 128, 128, (g, w, h) => {
  g.fillStyle = '#8a6a3c'; g.fillRect(0, 0, w, h);
  for (let y = 0; y < h; y += 21) { g.fillStyle = `rgba(0,0,0,${0.05 + ((y / 21) % 2) * 0.07})`; g.fillRect(0, y, w, 20); g.fillStyle = 'rgba(0,0,0,0.4)'; g.fillRect(0, y + 20, w, 1.5); }
  g.strokeStyle = '#5d4424'; g.lineWidth = 12; g.strokeRect(6, 6, w - 12, h - 12); g.lineWidth = 9; g.beginPath(); g.moveTo(8, 8); g.lineTo(w - 8, h - 8); g.stroke();
  grain(g, w, h, 24, 13);
});
export const woodTex = () => make('wood', 128, 128, (g, w, h) => { g.fillStyle = '#6b4a2b'; g.fillRect(0, 0, w, h); const r = rnd(4); for (let i = 0; i < 60; i++) { g.fillStyle = `rgba(0,0,0,${r() * 0.12})`; g.fillRect(0, r() * h, w, 1 + r() * 2); } grain(g, w, h, 12, 2); });
export const metalTex = (key: string, col: string) => make('metal' + key, 128, 256, (g, w, h) => {
  g.fillStyle = col; g.fillRect(0, 0, w, h); g.strokeStyle = 'rgba(0,0,0,0.45)'; g.lineWidth = 2; g.strokeRect(4, 4, w / 2 - 6, h - 8); g.strokeRect(w / 2 + 2, 4, w / 2 - 6, h - 8);
  g.fillStyle = 'rgba(0,0,0,0.5)'; for (let i = 0; i < 5; i++) { g.fillRect(14, 22 + i * 7, 34, 3); g.fillRect(w / 2 + 12, 22 + i * 7, 34, 3); } g.fillStyle = '#ccc'; g.fillRect(w / 2 - 12, h / 2, 5, 14); g.fillRect(w - 14, h / 2, 5, 14);
  grain(g, w, h, 14, 6);
});
export const shelfTex = () => make('shelf', 128, 256, (g, w, h) => {
  g.fillStyle = '#4a3a2a'; g.fillRect(0, 0, w, h); const r = rnd(21);
  for (let y = 8; y < h - 10; y += 50) { g.fillStyle = '#1e1812'; g.fillRect(6, y, w - 12, 42); let x = 9; while (x < w - 16) { const bw = 5 + r() * 9, bh = 26 + r() * 14; g.fillStyle = `hsl(${r() * 360},${25 + r() * 35}%,${28 + r() * 30}%)`; g.fillRect(x, y + 42 - bh, bw, bh); x += bw + 1; if (r() < 0.12) x += 12; } }
  grain(g, w, h, 10, 3);
});
export const doorTex = () => make('door', 128, 256, (g, w, h) => {
  g.fillStyle = '#7b5a3a'; g.fillRect(0, 0, w, h); const r = rnd(8); for (let i = 0; i < 70; i++) { g.fillStyle = `rgba(0,0,0,${r() * 0.1})`; g.fillRect(r() * w, 0, 1 + r() * 2, h); }
  g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = 3; g.strokeRect(14, 14, w - 28, h / 2 - 22); g.strokeRect(14, h / 2 + 6, w - 28, h / 2 - 22);
  g.fillStyle = '#c9b46a'; g.beginPath(); g.arc(w - 14, h / 2, 6, 0, 7); g.fill(); grain(g, w, h, 12, 5);
});
export const fabricTex = (key: string, col: string) => make('fab' + key, 64, 64, (g, w, h) => { g.fillStyle = col; g.fillRect(0, 0, w, h); grain(g, w, h, 26, 9); });
export const labelTex = (text: string, color: string) => make('label' + text + color, 128, 64, (g, w, h) => {
  g.clearRect(0, 0, w, h); g.fillStyle = 'rgba(8,12,18,0.7)'; g.beginPath(); (g as any).roundRect(14, 12, 100, 40, 9); g.fill(); g.strokeStyle = color; g.lineWidth = 4; g.stroke();
  g.fillStyle = '#fff'; g.font = `bold ${text.length > 3 ? 20 : 30}px system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, w / 2, h / 2 + 2, 92);
});
export const polisTex = () => make('polis', 128, 64, (g, w, h) => { g.fillStyle = '#10141b'; g.fillRect(0, 0, w, h); g.fillStyle = '#e9edf2'; g.font = 'bold 28px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('POLICE', w / 2, h / 2 + 2); });
export const glowTex = () => make('glow', 64, 64, (g, w, h) => { const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.3, 'rgba(255,220,150,0.7)'); gr.addColorStop(1, 'rgba(255,160,40,0)'); g.fillStyle = gr; g.fillRect(0, 0, w, h); });

/** Irregular blood pool / splatter (transparent background). */
export const bloodTex = () => make('blood', 128, 128, (g, w, h) => {
  g.clearRect(0, 0, w, h); let seed = 7; const r = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const blob = (x: number, y: number, rad: number, a: number) => { const gr = g.createRadialGradient(x, y, 0, x, y, rad); gr.addColorStop(0, `rgba(70,3,3,${a})`); gr.addColorStop(0.75, `rgba(105,6,6,${a})`); gr.addColorStop(1, 'rgba(110,8,8,0)'); g.fillStyle = gr; g.beginPath(); g.arc(x, y, rad, 0, 6.3); g.fill(); };
  blob(64, 64, 34, 0.95); for (let i = 0; i < 9; i++) { const an = r() * 6.3, d = 14 + r() * 20; blob(64 + Math.cos(an) * d, 64 + Math.sin(an) * d, 12 + r() * 14, 0.9); }
  for (let i = 0; i < 16; i++) { const an = r() * 6.3, d = 44 + r() * 16; blob(64 + Math.cos(an) * d, 64 + Math.sin(an) * d, 1.5 + r() * 3.5, 0.9); }
});
