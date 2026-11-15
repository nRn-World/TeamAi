// Run in GitHub Actions (.github/workflows/ai-check.yml), not in the game: checks that the model files the game asks
// for exist, that Whisper is called with valid options, and how well the small language models follow the order prompt.
// The game itself runs Qwen2.5 through WebLLM with the answer constrained to ORDER_SCHEMA; here the same models run
// unconstrained on the CPU, so this is the harder case.
import { pipeline } from '@huggingface/transformers';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { orderMessages, toAction } from '../src/sim/aiorders';
import { splitOrders } from '../src/sim/commands';

const out: string[] = [], log = (s: string) => { console.log(s); out.push(s); };
const save = () => writeFileSync('ai-check.txt', out.join('\n'));
const pcm = (file: string) => { const b = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', '16000', '-f', 'f32le', '-'], { maxBuffer: 1 << 28 }); return new Float32Array(b.buffer, b.byteOffset, b.byteLength >> 2).slice(); };

log('## Model files');
for (const u of ['mlc-ai/Qwen2.5-0.5B-Instruct-q4f16_1-MLC', 'mlc-ai/Qwen2.5-0.5B-Instruct-q4f32_1-MLC', 'mlc-ai/Qwen2.5-1.5B-Instruct-q4f16_1-MLC', 'mlc-ai/Qwen2.5-1.5B-Instruct-q4f32_1-MLC']) {
  try { const r = await fetch(`https://huggingface.co/${u}/resolve/main/mlc-chat-config.json`); log(`${u}: ${r.status}`); } catch (e) { log(`${u}: ${e}`); }
}
save();

log('\n## Whisper');
const man = JSON.parse(readFileSync('public/voice/manifest.json', 'utf8')), lines: { t: string }[] = JSON.parse(readFileSync('voice/lines.json', 'utf8'));
const clips = [0, 1, 2, 4, 8, 10].map(i => ({ file: `public/voice/o1/${i}.mp3`, want: lines[i]?.t ?? '?' }));
log('manifest keys: ' + Object.keys(man).slice(0, 6).join(','));
for (const [model, dtype] of [['onnx-community/whisper-base', { encoder_model: 'fp32', decoder_model_merged: 'q4' }], ['Xenova/whisper-tiny', 'q8']] as [string, any][]) {
  try {
    const asr: any = await pipeline('automatic-speech-recognition', model, { dtype } as any);
    await asr(new Float32Array(16000), { language: 'en', task: 'transcribe', max_new_tokens: 4 });
    for (const c of clips) { let a: Float32Array; try { a = pcm(c.file); } catch { continue; } const t0 = Date.now(), r = await asr(a, { language: 'en', task: 'transcribe', max_new_tokens: 60 }); log(`${model} | ${c.want} => ${String(r.text).trim()} (${Date.now() - t0} ms)`); }
    const r = await asr(pcm(clips[0].file), { language: 'sv', task: 'transcribe', max_new_tokens: 60 }); log(`${model} | language sv accepted => ${String(r.text).trim()}`);
  } catch (e) { log(`${model}: FAILED ${String((e as any)?.message ?? e).slice(0, 300)}`); }
  save();
}

log('\n## Order reading');
// Only wording the fixed rules cannot read reaches the model, one order at a time; the rules decide who it is for.
const tests: [string, string][] = [
  ['get yourselves through that door', 'breach'], ['you two stay put', 'hold'], ['nobody shoots unless they shoot first', 'fireHold'], ['put the bracelets on them', 'restrain'], ['toss one in before you enter', 'bang'],
  ['I wonder what is for lunch', 'none'], ['hey what was that noise', 'none'], ['stick with me', 'follow'], ['keep me safe', 'cover'], ['head over to where I am pointing', 'move there'], ['slide over to the left side', 'move left'],
  ['how are you doing', 'report'], ['take them into custody', 'restrain'], ['you are clear to fire', 'fireFree'], ['don\'t let anyone sneak up behind me', 'cover'], ['thank you', 'none'], ['nice work', 'none'],
  ['håll er nära mig', 'follow'], ['rör er inte', 'hold'], ['ta er in i rummet', 'breach'], ['sätt handklovar på honom', 'restrain'], ['hur mår ni', 'report'], ['vad var det där', 'none'], ['flytta er åt vänster', 'move left'], ['ni får skjuta', 'fireFree'],
];
let right = 0;
for (const model of ['onnx-community/Qwen2.5-1.5B-Instruct']) {
  try {
    const gen: any = await pipeline('text-generation', model, { dtype: 'q4' } as any);
    for (const [text, want] of tests) {
      if (splitOrders(text).every(x => x.cmd)) { log(`(rules already read: ${text})`); continue; }
      const t0 = Date.now(), r = await gen(orderMessages(text), { max_new_tokens: 40, do_sample: false }), ans = String(r[0].generated_text.at(-1).content), a = toAction(ans), got = a ? a.action + (a.dir ? ' ' + a.dir : '') : 'none';
      if (got === want) right++; log(`${got === want ? 'ok  ' : 'MISS'} ${text} => ${got} (wanted ${want})   raw: ${ans.replace(/\s+/g, ' ').slice(0, 80)} (${Date.now() - t0} ms)`);
    }
    log(`right: ${right}`);
  } catch (e) { log(`${model}: FAILED ${String((e as any)?.message ?? e).slice(0, 300)}`); }
  save();
}
