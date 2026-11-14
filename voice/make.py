"""Renders every spoken line in voice/lines.json with free Piper voices into public/voice/.
Run by .github/workflows/voices.yml (needs internet for the voice models). Output: <voice>/<index>.mp3 + manifest.json."""
import json, os, subprocess, urllib.request, wave, pathlib
from piper import PiperVoice, SynthesisConfig

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / 'public' / 'voice'
HF = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/sv/sv_SE/'
VOICES = {'m': 'nst/medium/sv_SE-nst-medium', 'f': 'lisa/medium/sv_SE-lisa-medium'}
lines = json.load(open(ROOT / 'voice' / 'lines.json', encoding='utf-8'))
tmp = pathlib.Path('/tmp/pipervoices'); tmp.mkdir(exist_ok=True)

def get(url, dst):
    if not dst.exists():
        print('download', url, flush=True); urllib.request.urlretrieve(url, dst)

# names are spelled out so the synthesiser reads "A1" as "A ett"
def spoken(t):
    for a, b in (('A1', 'A ett'), ('A2', 'A två'), ('B1', 'B ett'), ('B2', 'B två'), ('1 man', 'En man'), ('2 man', 'Två man')): t = t.replace(a, b)
    return t

cards = {}
for key, path in VOICES.items():
    base = path.split('/')[-1]; model = tmp / (base + '.onnx')
    get(HF + path + '.onnx?download=true', model); get(HF + path + '.onnx.json?download=true', tmp / (base + '.onnx.json'))
    card = tmp / (base + '.MODEL_CARD'); get(HF + path.rsplit('/', 1)[0] + '/MODEL_CARD?download=true', card)
    cards[key] = card.read_text(encoding='utf-8', errors='replace')
    voice = PiperVoice.load(str(model)); (OUT / key).mkdir(parents=True, exist_ok=True)
    for i, text in enumerate(lines):
        wav = tmp / f'{key}{i}.wav'
        with wave.open(str(wav), 'wb') as w: voice.synthesize_wav(spoken(text), w, syn_config=SynthesisConfig(length_scale=0.92, noise_scale=0.8, noise_w_scale=0.9))
        subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', str(wav), '-af',
                        'silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse,dynaudnorm=p=0.9',
                        '-ac', '1', '-ar', '22050', '-b:a', '48k', str(OUT / key / f'{i}.mp3')], check=True)
    (OUT / f'MODEL_CARD-{base}.txt').write_text(cards[key], encoding='utf-8')
json.dump({'voices': list(VOICES), 'lines': lines}, open(OUT / 'manifest.json', 'w', encoding='utf-8'), ensure_ascii=False)
print('done', len(lines), 'lines x', len(VOICES), 'voices')
