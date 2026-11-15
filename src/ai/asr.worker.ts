// Speech-to-text on the player's own computer: Whisper through Transformers.js, in a worker so the game keeps its frame rate.
// The model files are downloaded once from the Hugging Face hub and kept in the browser cache.
import { pipeline, env } from '@huggingface/transformers';

env.allowLocalModels = false; // otherwise it first asks our own server, which answers with the game page
type Msg = { t: 'load' } | { t: 'run'; id: number; pcm: Float32Array; lang: string };
const post = (m: unknown) => (self as unknown as Worker).postMessage(m);
let asr: any = null, loading: Promise<void> | null = null, device = '';

async function load() {
  const files = new Map<string, [number, number]>();
  const progress_callback = (p: any) => {
    if (p?.status !== 'progress' || !p.file || !p.total) return; files.set(p.file, [p.loaded, p.total]);
    let a = 0, b = 0; for (const [l, t] of files.values()) { a += l; b += t; } post({ t: 'progress', p: b ? a / b : 0, mb: Math.round(b / 1e6) });
  };
  const tries: [string, string, any][] = [];
  if ((navigator as any).gpu) tries.push(['webgpu', 'onnx-community/whisper-base', { encoder_model: 'fp32', decoder_model_merged: 'q4' }]);
  tries.push(['wasm', 'Xenova/whisper-tiny', 'q8']); // without a GPU the smaller model keeps the answer time around a second
  let err: unknown = null;
  for (const [dev, model, dtype] of tries) {
    try {
      files.clear(); const p = await pipeline('automatic-speech-recognition', model, { device: dev as any, dtype, progress_callback } as any);
      await p(new Float32Array(16000), { language: 'en', task: 'transcribe', max_new_tokens: 4 } as any); // warm-up: compiles the shaders now instead of on the first order
      asr = p; device = dev; post({ t: 'ready', device: dev, model }); return;
    } catch (e) { err = e; }
  }
  throw err;
}
self.onmessage = async (e: MessageEvent<Msg>) => {
  const m = e.data;
  try {
    if (!asr) await (loading ??= load());
    if (m.t === 'run') { const t0 = performance.now(), out = await asr(m.pcm, { language: m.lang, task: 'transcribe', max_new_tokens: 60 }); post({ t: 'text', id: m.id, text: String(Array.isArray(out) ? out[0]?.text : out?.text ?? ''), ms: Math.round(performance.now() - t0), device }); }
  } catch (err) { loading = null; post({ t: 'error', id: (m as any).id ?? -1, msg: String((err as any)?.message ?? err).slice(0, 200) }); }
};
