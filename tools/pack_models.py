"""Converts Quaternius "Ultimate Modular Men" glTF files (CC0) into compact .glb files for the game.
Keeps only the animations the game uses, and only in the first file (all characters share one skeleton).
Usage: python tools/pack_models.py <folder with .gltf files> public/models"""
import base64, json, struct, sys, pathlib
SRC, OUT = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
CHARS = [('Swat', 'swat'), ('Punk', 'punk'), ('Casual_Hoodie', 'hoodie'), ('Casual_2', 'casual'), ('Suit', 'suit'), ('Worker', 'worker')]
KEEP = ['Death', 'HitRecieve', 'Idle', 'Idle_Gun', 'Idle_Gun_Pointing', 'Idle_Gun_Shoot', 'Run', 'Run_Shoot', 'Walk', 'Idle_Neutral', 'Interact']

def pack(name, out, anims):
    src = SRC / (name + '.gltf')
    if src.exists():
        g = json.load(open(src)); bufs = [base64.b64decode(b['uri'].split(',', 1)[1]) for b in g['buffers']]
    else:  # binary .glb input (women pack)
        raw = open(SRC / (name + '.glb'), 'rb').read(); n = struct.unpack('<I', raw[12:16])[0]
        g = json.loads(raw[20:20 + n]); bufs = [raw[20 + n + 8:]]
    g['animations'] = [a for a in g.get('animations', []) if a['name'] in KEEP] if anims else []
    if not g['animations']: del g['animations']
    used = set()
    for m in g['meshes']:
        for p in m['primitives']:
            used.update(p['attributes'].values())
            if 'indices' in p: used.add(p['indices'])
            for t in p.get('targets', []): used.update(t.values())
    for s in g.get('skins', []):
        if 'inverseBindMatrices' in s: used.add(s['inverseBindMatrices'])
    for a in g.get('animations', []):
        for s in a['samplers']: used.update((s['input'], s['output']))
    assert not g.get('images'), 'textures not handled'
    order = sorted(used); amap = {old: i for i, old in enumerate(order)}
    blob = bytearray(); views = []; accs = []
    for old in order:
        a = dict(g['accessors'][old]); bv = g['bufferViews'][a['bufferView']]
        assert 'byteStride' not in bv
        ncomp = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}[a['type']]; csz = {5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4}[a['componentType']]
        start = bv.get('byteOffset', 0) + a.get('byteOffset', 0); data = bufs[bv['buffer']][start:start + a['count'] * ncomp * csz]
        while len(blob) % 4: blob.append(0)
        v = {'buffer': 0, 'byteOffset': len(blob), 'byteLength': len(data)}
        if 'target' in bv: v['target'] = bv['target']
        blob += data; a['bufferView'] = len(views); a.pop('byteOffset', None); views.append(v); accs.append(a)
    for m in g['meshes']:
        for p in m['primitives']:
            p['attributes'] = {k: amap[v] for k, v in p['attributes'].items()}
            if 'indices' in p: p['indices'] = amap[p['indices']]
    for s in g.get('skins', []):
        if 'inverseBindMatrices' in s: s['inverseBindMatrices'] = amap[s['inverseBindMatrices']]
    for a in g.get('animations', []):
        for s in a['samplers']: s['input'] = amap[s['input']]; s['output'] = amap[s['output']]
    while len(blob) % 4: blob.append(0)
    g['accessors'] = accs; g['bufferViews'] = views; g['buffers'] = [{'byteLength': len(blob)}]
    g['asset']['copyright'] = 'Quaternius - CC0 1.0 (Ultimate Modular Men / Women)'
    js = json.dumps(g, separators=(',', ':')).encode(); js += b' ' * (-len(js) % 4)
    total = 12 + 8 + len(js) + 8 + len(blob)
    with open(OUT / (out + '.glb'), 'wb') as f:
        f.write(struct.pack('<4sII', b'glTF', 2, total)); f.write(struct.pack('<I4s', len(js), b'JSON')); f.write(js); f.write(struct.pack('<I4s', len(blob), b'BIN\0')); f.write(blob)
    print(out, total // 1024, 'kB', [a['name'] for a in g.get('animations', [])])

OUT.mkdir(parents=True, exist_ok=True)
# Men ("Ultimate Modular Men", .gltf) share the animations stored in swat.glb;
# women ("Ultimate Modular Women", .glb: casual, formal) share the ones stored in wcasual.glb.
WOMEN = [('casual', 'wcasual'), ('formal', 'wformal')]
if (SRC / 'Swat.gltf').exists():
    for i, (n, o) in enumerate(CHARS): pack(n, o, i == 0)
else:
    for i, (n, o) in enumerate(WOMEN): pack(n, o, i == 0)
