"""Renders every spoken line in voice/lines.json with the free Kokoro speech model (Apache-2.0) into public/voice/.
Run by .github/workflows/voices.yml (needs internet for the model files). Output: <voice>/<index>.mp3 + manifest.json.
Each character role has its own set of voices; lines marked "s" are shouted: faster delivery, raised pitch, hard compression,
a presence boost, light overdrive and a short room echo, so a command sounds yelled across a room rather than spoken."""
import json, pathlib, shutil, subprocess, sys, traceback, wave
import numpy as np
import imageio_ffmpeg
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / 'public' / 'voice'
MODELS = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else '/tmp/kokoro')
# key: (Kokoro voice, speaking speed). First letter = role: p player, o officer, s suspect, c civilian.
VOICES = {
    'p1': ('am_fenrir', 1.0),
    'o1': ('am_michael', 1.0), 'o2': ('af_bella', 1.0), 'o3': ('am_puck', 0.97), 'o4': ('af_heart', 1.03),
    's1': ('am_onyx', 1.0), 's2': ('am_eric', 1.05), 's3': ('bm_george', 1.0), 's4': ('af_kore', 1.0), 's5': ('am_echo', 0.95),
    'c1': ('af_sarah', 1.05), 'c2': ('am_liam', 1.05), 'c3': ('bf_emma', 1.0), 'c4': ('am_adam', 1.1), 'c5': ('af_nova', 1.0),
}
lines = json.load(open(ROOT / 'voice' / 'lines.json', encoding='utf-8'))
tmp = pathlib.Path('/tmp/voicewav'); tmp.mkdir(exist_ok=True)
TRIM = 'silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse'
CALM = TRIM + ',highpass=f=90,dynaudnorm=p=0.9'
def shout(up):
    return (f'asetrate=24000*{up},aresample=24000,atempo={1 / up * 1.04:.4f},' + TRIM +
            ',highpass=f=220,equalizer=f=1500:t=q:w=1:g=4,equalizer=f=3100:t=q:w=0.9:g=9,'
            'acompressor=threshold=-30dB:ratio=10:attack=2:release=70:makeup=10,volume=7dB,asoftclip=type=tanh,'
            'aecho=0.85:0.55:27|63:0.2|0.11,alimiter=limit=0.93:level=disabled,dynaudnorm=p=0.95:m=4')

# call signs are spelled out so the synthesiser reads "A1" as "Alpha one"
def spoken(t):
    for a, b in (('A1', 'Alpha one'), ('A2', 'Alpha two'), ('B1', 'Bravo one'), ('B2', 'Bravo two'), ('1 up', 'One up'), ('2 up', 'Two up')): t = t.replace(a, b)
    return t

OUT.mkdir(parents=True, exist_ok=True)
try:
    from kokoro_onnx import Kokoro
    k = Kokoro(str(MODELS / 'kokoro-v1.0.onnx'), str(MODELS / 'voices-v1.0.bin'))
    for old in OUT.iterdir():
        if old.is_dir(): shutil.rmtree(old)
        elif old.name.startswith('MODEL_CARD'): old.unlink()
    n = 0
    for key, (name, speed) in VOICES.items():
        (OUT / key).mkdir(parents=True, exist_ok=True)
        for i, ln in enumerate(lines):
            if key[0] not in ln['r']: continue
            loud = bool(ln.get('s'))
            samples, sr = k.create(spoken(ln['t']), voice=name, speed=speed * (1.1 if loud else 1.0), lang='en-gb' if name[0] == 'b' else 'en-us')
            pcm = (np.clip(np.asarray(samples, dtype=np.float32), -1, 1) * 32767).astype('<i2')
            wav = tmp / f'{key}-{i}.wav'
            with wave.open(str(wav), 'wb') as w: w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr); w.writeframes(pcm.tobytes())
            up = 1.1 if key[0] in 'po' else 1.07
            subprocess.run([FFMPEG, '-y', '-loglevel', 'error', '-i', str(wav), '-af', shout(up) if loud else CALM,
                            '-ac', '1', '-ar', '24000', '-b:a', '56k', str(OUT / key / f'{i}.mp3')], check=True)
            n += 1
    json.dump({'voices': list(VOICES), 'lines': lines}, open(OUT / 'manifest.json', 'w', encoding='utf-8'))
    (OUT / 'LICENSE.txt').write_text(
        'The voice clips in this folder were generated for TeamAi with the Kokoro-82M speech model\n'
        '(https://huggingface.co/hexgrad/Kokoro-82M, Apache License 2.0, by hexgrad) through kokoro-onnx\n'
        '(https://github.com/thewh1teagle/kokoro-onnx, MIT). Voices used: ' + ', '.join(v[0] for v in VOICES.values()) + '.\n'
        'The clips were processed with FFmpeg (trimmed, normalised; shouted lines pitch-raised, compressed and given a room echo).\n', encoding='utf-8')
    print('done', n, 'clips'); (OUT / '_log.txt').write_text(f'ok {n} clips', encoding='utf-8')
except Exception:
    (OUT / '_log.txt').write_text(traceback.format_exc(), encoding='utf-8'); print(traceback.format_exc())
