// Run in GitHub Actions (.github/workflows/ai-check.yml), not in the game: checks that the model files the game asks
// for exist, that Whisper is called with valid options, and how well the small language models follow the order prompt.
// The game itself runs Qwen2.5 through WebLLM with the answer constrained to ORDER_SCHEMA; here the same models run
// unconstrained on the CPU, so this is the harder case.
import { pipeline } from '@huggingface/transformers';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { orderMessages, toCommands } from '../src/sim/aiorders';

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
const tests: [string, string][] = [
  ['Ken cover the door while team B goes in with a flash', 'ALL'], ['you two stay put', 'A'], ['Jack get in there', 'ALL'], ['everybody come back to me', 'B'], ['Maya watch my back and Zoe open that door', 'ALL'],
  ['team a take the left side and team b take the right', 'ALL'], ['nobody shoots unless they shoot first', 'ALL'], ['put the cuffs on them', 'Ken'], ['toss a flashbang in there Ken', 'ALL'], ['I wonder what is for lunch', 'ALL'],
  ['hey what was that noise', 'A'], ['you go left', 'Jack'], ['both teams line up on that door', 'A'], ['Zoe hold your fire', 'ALL'],
  ['Ken du täcker oss', 'ALL'], ['ni skyddar mig', 'B'], ['Zoe stäng dörren', 'ALL'], ['alla följ mig', 'A'], ['du går in', 'Ken'], ['Ken släng flash', 'ALL'], ['lag B följ med mig', 'ALL'], ['alla stannar här', 'ALL'], ['Maya öppna dörren och Jack skydda mig', 'ALL'], ['lag A gå till vänster', 'ALL'], ['sätt handbojor på dem', 'B'],
];
for (const model of ['onnx-community/Qwen2.5-1.5B-Instruct', 'onnx-community/Phi-3.5-mini-instruct-onnx-web']) {
  try {
    const gen: any = await pipeline('text-generation', model, { dtype: model.includes('Phi') ? 'q4f16' : 'q4' } as any);
    for (const [text, last] of tests) {
      const t0 = Date.now(), r = await gen(orderMessages(text, last), { max_new_tokens: 140, do_sample: false }), ans = String(r[0].generated_text.at(-1).content);
      const lw = ['Ken', 'Maya', 'Jack', 'Zoe'].indexOf(last), cmds = toCommands(ans, lw >= 0 ? (lw < 2 ? 'A' : 'B') : last as any, lw >= 0 ? lw : null);
      log(`${model.split('/')[1]} | [${last}] ${text} => ${cmds.map(c => [c.who != null ? ['Ken', 'Maya', 'Jack', 'Zoe'][c.who] : c.team, c.action, c.dir].filter(Boolean).join(' ')).join(' + ') || '(none)'}   raw: ${ans.replace(/\s+/g, ' ').slice(0, 160)} (${Date.now() - t0} ms)`);
    }
  } catch (e) { log(`${model}: FAILED ${String((e as any)?.message ?? e).slice(0, 300)}`); }
  save();
}
