#!/usr/bin/env python3
"""Shrinks the textures of a Sketchfab glTF download so it is small enough to ship.
Usage: python3 tools/pack_operator.py <folder with scene.gltf, scene.bin, textures/> <output folder> [max texture size]"""
import json, shutil, sys
from pathlib import Path
from PIL import Image
Image.MAX_IMAGE_PIXELS = None
src, out = Path(sys.argv[1]), Path(sys.argv[2]); big = int(sys.argv[3]) if len(sys.argv) > 3 else 1024
(out / 'textures').mkdir(parents=True, exist_ok=True)
g = json.load(open(src / 'scene.gltf'))
used = set()
for m in g['materials']:
    m.get('extensions', {}).pop('KHR_materials_transmission', None)
    if 'extensions' in m and not m['extensions']: del m['extensions']
    def walk(o):
        if isinstance(o, dict):
            if 'index' in o and len(o) <= 4 and all(k in ('index', 'texCoord', 'scale', 'strength', 'extensions') for k in o): used.add(g['textures'][o['index']]['source'])
            for v in o.values(): walk(v)
    walk(m)
for i, im in enumerate(g['images']):
    p = src / im['uri']
    if i not in used: im['uri'] = 'textures/' + p.stem + '.jpg'; im['mimeType'] = 'image/jpeg'; Image.new('RGB', (4, 4)).save(out / im['uri']); continue
    img = Image.open(p); alpha = img.mode in ('RGBA', 'LA') and img.getextrema()[-1][0] < 250 and 'baseColor' in p.name
    size = big if ('baseColor' in p.name or 'normal' in p.name) else big // 2
    if 'uniform' in p.name and 'metallic' not in p.name: size = big * 2
    img.thumbnail((size, size), Image.LANCZOS)
    if alpha: name = p.stem + '.png'; img.save(out / 'textures' / name, optimize=True); im['mimeType'] = 'image/png'
    else: name = p.stem + '.jpg'; img.convert('RGB').save(out / 'textures' / name, quality=84, optimize=True); im['mimeType'] = 'image/jpeg'
    im['uri'] = 'textures/' + name
g['extensionsUsed'] = [e for e in g.get('extensionsUsed', []) if e != 'KHR_materials_transmission']
g['extensionsRequired'] = [e for e in g.get('extensionsRequired', []) if e != 'KHR_materials_transmission']
if not g['extensionsRequired']: del g['extensionsRequired']
json.dump(g, open(out / 'scene.gltf', 'w'), separators=(',', ':'))
shutil.copy(src / 'scene.bin', out / 'scene.bin'); shutil.copy(src / 'license.txt', out / 'license.txt')
print('ok', sum(f.stat().st_size for f in out.rglob('*') if f.is_file()) // 1024, 'kB')
