#!/usr/bin/env python3
"""Rebuilds a .glb from a model that only exists as a Unity import (prefab + mesh .asset + .mat + textures).
All meshes are baked into world space and merged per material; textures are shrunk.
Usage: python3 tools/pack_unity_prefab.py <folder with X.prefab, meshes/, materials/, textures/, license.txt> <output folder> [max texture size] [desaturate 0..1]
Then shrink it: npx @gltf-transform/cli optimize model.glb out.glb --compress meshopt --simplify-error 0.0015 --simplify-ratio 0.35 --texture-size 1024 --texture-compress webp"""
import json, re, struct, sys, io
from pathlib import Path
import numpy as np
from PIL import Image
Image.MAX_IMAGE_PIXELS = None
src, out = Path(sys.argv[1]), Path(sys.argv[2]); big = int(sys.argv[3]) if len(sys.argv) > 3 else 1024
grey = float(sys.argv[4]) if len(sys.argv) > 4 else 0   # 0..1: how far the colour textures are desaturated (to repaint the model with a material tint)
out.mkdir(parents=True, exist_ok=True)
guid = {}
for m in src.rglob('*.meta'):
    g = re.search(r'^guid: (\w+)', m.read_text(), re.M)
    if g: guid[g.group(1)] = m.with_suffix('')
vec = lambda s: {k: float(v) for k, v in re.findall(r'(\w): ([-\d.e]+)', s)}
docs = {}
for head, body in re.findall(r'^--- !u!(\d+) &(\d+)\n(.*?)(?=^--- |\Z)', next(src.glob('*.prefab')).read_text(), re.M | re.S) and \
        [((t, i), b) for t, i, b in re.findall(r'^--- !u!(\d+) &(\d+)\n(.*?)(?=^--- |\Z)', next(src.glob('*.prefab')).read_text(), re.M | re.S)]:
    docs[head[1]] = (int(head[0]), body)
ref = lambda body, key: re.search(key + r': \{fileID: (\d+)', body).group(1)
tf_of, filt, rend, xf = {}, {}, {}, {}
for i, (t, b) in docs.items():
    if t == 4:
        go = ref(b, 'm_GameObject'); tf_of[go] = i
        xf[i] = (vec(re.search(r'm_LocalRotation: \{(.*?)\}', b).group(1)), vec(re.search(r'm_LocalPosition: \{(.*?)\}', b).group(1)), vec(re.search(r'm_LocalScale: \{(.*?)\}', b).group(1)), ref(b, 'm_Father'))
    elif t == 33: filt[ref(b, 'm_GameObject')] = re.search(r'm_Mesh: \{fileID: \d+, guid: (\w+)', b).group(1)
    elif t == 23: rend[ref(b, 'm_GameObject')] = re.findall(r'- \{fileID: \d+, guid: (\w+)', b.split('m_Materials:')[1].split('m_StaticBatchInfo')[0])
def local(i):
    q, p, s, _ = xf[i]; x, y, z, w = q['x'], q['y'], q['z'], q['w']
    r = np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)], [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)], [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])
    m = np.eye(4); m[:3, :3] = r * np.array([s['x'], s['y'], s['z']]); m[:3, 3] = [p['x'], p['y'], p['z']]; return m
def world(i): return local(i) if xf[i][3] == '0' else world(xf[i][3]) @ local(i)
def mesh(path):
    t = path.read_text(); n = int(re.search(r'm_VertexCount: (\d+)', t).group(1))
    ch = [tuple(map(int, c)) for c in re.findall(r'- stream: (\d+)\n\s+offset: (\d+)\n\s+format: (\d+)\n\s+dimension: (\d+)', t)]
    data = bytes.fromhex(re.search(r'_typelessdata: (\w+)', t).group(1)); stride = len(data) // n
    assert all(c[0] == 0 and c[2] == 0 for c in ch if c[3]), 'only single-stream float meshes are supported'
    a = np.frombuffer(data, dtype='<f4').reshape(n, stride // 4)
    get = lambda k: a[:, ch[k][1] // 4: ch[k][1] // 4 + ch[k][3]] if ch[k][3] else None
    idx = np.frombuffer(bytes.fromhex(re.search(r'm_IndexBuffer: (\w+)', t).group(1)), dtype='<u2' if re.search(r'm_IndexFormat: (\d)', t).group(1) == '0' else '<u4').astype(np.uint32)
    subs = [(int(a_), int(b_), int(c_)) for a_, b_, c_ in re.findall(r'firstByte: (\d+)\n\s+indexCount: (\d+)\n\s+topology: \d+\n\s+baseVertex: (\d+)', t)]
    return get(0), get(1), get(4), idx, subs, 2 if idx.dtype == np.uint16 else (2 if '<u2' else 4)
parts = {}
for go, mg in filt.items():
    if go not in rend or mg not in guid: continue
    pos, nor, uv, idx, subs, _ = mesh(guid[mg]); M = world(tf_of[go]); wide = 2 if re.search(r'm_IndexFormat: (\d)', guid[mg].read_text()).group(1) == '0' else 4
    p = (np.c_[pos, np.ones(len(pos))] @ M.T)[:, :3]; N = np.linalg.inv(M[:3, :3]).T; nn = nor @ N.T; nn /= np.maximum(np.linalg.norm(nn, axis=1, keepdims=True), 1e-9)
    flip = np.linalg.det(M[:3, :3]) < 0
    p[:, 0] *= -1; nn[:, 0] *= -1                         # Unity is left-handed, glTF right-handed
    uv = np.c_[uv[:, 0], 1 - uv[:, 1]] if uv is not None else np.zeros((len(p), 2))
    for (first, count, base), mat in zip(subs, rend[go]):
        tri = (idx[first // wide: first // wide + count] + base).reshape(-1, 3)
        if not flip: tri = tri[:, ::-1]                    # mirroring x reverses the winding
        used, inv = np.unique(tri, return_inverse=True); d = parts.setdefault(mat, {'p': [], 'n': [], 'u': [], 'i': [], 'c': 0})
        d['p'].append(p[used]); d['n'].append(nn[used]); d['u'].append(uv[used]); d['i'].append(inv.reshape(-1) + d['c']); d['c'] += len(used)
allp = np.concatenate([np.concatenate(d['p']) for d in parts.values()]); lo, hi = allp.min(0), allp.max(0)
shift = np.array([(lo[0] + hi[0]) / 2, lo[1], (lo[2] + hi[2]) / 2])   # centre on the ground
blob = bytearray(); views, accs, imgs, texs, mats, prims = [], [], [], [], [], []
def view(b, target=None):
    while len(blob) % 4: blob.append(0)
    views.append({'buffer': 0, 'byteOffset': len(blob), 'byteLength': len(b), **({'target': target} if target else {})}); blob.extend(b); return len(views) - 1
def acc(a, typ, ct, target, mm=False):
    accs.append({'bufferView': view(a.tobytes(), target), 'componentType': ct, 'count': len(a), 'type': typ, **({'min': a.min(0).tolist(), 'max': a.max(0).tolist()} if mm else {})}); return len(accs) - 1
def tex(g, size, q=82, colour=False):
    if g not in guid or not guid[g].exists(): return None
    im = Image.open(guid[g]); alpha = im.mode == 'RGBA' and im.getextrema()[3][0] < 250; im.thumbnail((size, size), Image.LANCZOS); b = io.BytesIO()
    if colour and grey and not alpha: im = Image.blend(im.convert('RGB'), im.convert('L').convert('RGB'), grey)
    if alpha: im.save(b, 'PNG', optimize=True)
    else: im.convert('RGB').save(b, 'JPEG', quality=q, optimize=True)
    imgs.append({'bufferView': view(b.getvalue()), 'mimeType': 'image/png' if alpha else 'image/jpeg'}); texs.append({'source': len(imgs) - 1, 'sampler': 0}); return len(texs) - 1, alpha
for mg, d in parts.items():
    mt = guid[mg].read_text(); name = re.search(r'm_Name: (.+)', mt).group(1)
    tg = lambda k: (re.search(r'- ' + k + r':\n\s+m_Texture: \{fileID: \d+, guid: (\w+)', mt) or [None, None])[1]
    fl = lambda k, dv: float((re.search(r'- ' + k + r': ([-\d.e]+)', mt) or [0, dv])[1])
    col = vec(re.search(r'- _Color: \{(.*?)\}', mt).group(1)); m = {'name': name, 'pbrMetallicRoughness': {'baseColorFactor': [col['r'], col['g'], col['b'], col['a']], 'metallicFactor': fl('_Metallic', 0), 'roughnessFactor': 1 - fl('_Glossiness', 0.5) * fl('_GlossMapScale', 1)}}
    bc = tex(tg('_MainTex'), big, 82, True) if tg('_MainTex') else None; nm = tex(tg('_BumpMap'), big, 88) if tg('_BumpMap') else None
    if bc: m['pbrMetallicRoughness']['baseColorTexture'] = {'index': bc[0]}; m.update({'alphaMode': 'BLEND'} if bc[1] or col['a'] < 0.99 else {})
    if nm: m['normalTexture'] = {'index': nm[0]}
    mats.append(m); P = (np.concatenate(d['p']) - shift).astype('<f4')
    prims.append({'attributes': {'POSITION': acc(P, 'VEC3', 5126, 34962, True), 'NORMAL': acc(np.concatenate(d['n']).astype('<f4'), 'VEC3', 5126, 34962), 'TEXCOORD_0': acc(np.concatenate(d['u']).astype('<f4'), 'VEC2', 5126, 34962)},
                  'indices': acc(np.concatenate(d['i']).astype('<u4'), 'SCALAR', 5125, 34963), 'material': len(mats) - 1})
    print(name, len(P), 'verts', sum(len(i) for i in d['i']) // 3, 'tris')
g = {'asset': {'version': '2.0', 'generator': 'TeamAi pack_unity_prefab.py'}, 'scene': 0, 'scenes': [{'nodes': [0]}], 'nodes': [{'mesh': 0, 'name': src.name}], 'meshes': [{'primitives': prims}],
     'materials': mats, 'textures': texs, 'images': imgs, 'samplers': [{'magFilter': 9729, 'minFilter': 9987}], 'accessors': accs, 'bufferViews': views, 'buffers': [{'byteLength': len(blob)}]}
js = json.dumps(g, separators=(',', ':')).encode(); js += b' ' * (-len(js) % 4); blob += b'\0' * (-len(blob) % 4)
(out / 'model.glb').write_bytes(struct.pack('<4sII', b'glTF', 2, 28 + len(js) + len(blob)) + struct.pack('<I4s', len(js), b'JSON') + js + struct.pack('<I4s', len(blob), b'BIN\0') + bytes(blob))
(out / 'license.txt').write_text((src / 'license.txt').read_text())
print('size', (hi - lo).round(2).tolist(), 'glb', (out / 'model.glb').stat().st_size // 1024, 'kB')
