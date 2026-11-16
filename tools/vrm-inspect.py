#!/usr/bin/env python3
"""VRM/GLB 解剖工具：列出节点/材质/贴图，把内嵌贴图导出成 PNG，方便离线改色。

用法：
  python3 tools/vrm-inspect.py models/Sendagaya_Shino.vrm            # 打印结构
  python3 tools/vrm-inspect.py models/Sendagaya_Shino.vrm --dump out  # 导出贴图到 out/
"""
import json
import pathlib
import struct
import sys


def read_glb(path):
    raw = pathlib.Path(path).read_bytes()
    magic, version, length = struct.unpack_from("<4sII", raw, 0)
    assert magic == b"glTF", f"不是 GLB: {path}"
    off = 12
    chunks = []
    while off < length:
        clen, ctype = struct.unpack_from("<II", raw, off)
        data = raw[off + 8: off + 8 + clen]
        chunks.append((ctype, data, off + 8))
        off += 8 + clen
    js = None
    bins = {}
    for ctype, data, doff in chunks:
        if ctype == 0x4E4F534A:
            js = json.loads(data.decode("utf-8").rstrip("\x00 "))
        elif ctype == 0x004E4942:
            bins[doff] = data
    return raw, js, bins


def dump_images(js, bins, outdir):
    out = pathlib.Path(outdir)
    out.mkdir(parents=True, exist_ok=True)
    views = js.get("bufferViews", [])
    imgs = js.get("images", [])
    tex_to_img = {}
    for i, t in enumerate(js.get("textures", [])):
        tex_to_img[i] = t.get("source")
    mat_tex = {}
    for mat in js.get("materials", []):
        name = mat.get("name", "?")
        pbr = mat.get("pbrMetallicRoughness", {})
        slot = []
        if "baseColorTexture" in pbr:
            slot.append(("base", pbr["baseColorTexture"].get("index")))
        ext = mat.get("extensions", {})
        for k, v in ext.items():
            if isinstance(v, dict) and "baseColorTexture" in v:
                slot.append(("base", v["baseColorTexture"].get("index")))
        for s in slot:
            if s[1] is not None and tex_to_img.get(s[1]) is not None:
                mat_tex.setdefault(tex_to_img[s[1]], []).append(f"{name}:{s[0]}")
    files = []
    for idx, img in enumerate(imgs):
        bv = img.get("bufferView")
        if bv is None:
            continue
        v = views[bv]
        # 找 buffer 数据
        data = None
        for doff, blob in bins.items():
            start = v.get("byteOffset", 0)
            data = blob[start:start + v["byteLength"]]
            break
        if data is None:
            continue
        mime = img.get("mimeType", "image/png")
        ext = ".png" if "png" in mime else ".jpg" if "jpeg" in mime else ".bin"
        p = out / f"img{idx:02d}{ext}"
        p.write_bytes(data)
        users = mat_tex.get(idx, [])
        files.append((p, len(data), users))
    return files


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    dump = None
    if "--dump" in sys.argv:
        dump = sys.argv[sys.argv.index("--dump") + 1]
    path = args[0]
    raw, js, bins = read_glb(path)
    print(f"== {path}  {len(raw)/1048576:.1f} MB")
    print("asset:", json.dumps(js.get("asset", {}), ensure_ascii=False)[:200])
    print("extensionsUsed:", js.get("extensionsUsed"))
    print(f"nodes={len(js.get('nodes', []))} meshes={len(js.get('meshes', []))} materials={len(js.get('materials', []))} textures={len(js.get('textures', []))} images={len(js.get('images', []))} skins={len(js.get('skins', []))}")
    print("\n-- materials --")
    for i, m in enumerate(js.get("materials", [])):
        pbr = m.get("pbrMetallicRoughness", {})
        ext = m.get("extensions", {})
        has_tex = "baseColorTexture" in pbr or any(
            isinstance(v, dict) and "baseColorTexture" in v for v in ext.values()
        )
        print(f"  [{i:02d}] {m.get('name','?'):40s} tex={has_tex} ext={list(ext.keys())[:2]}")
    print("\n-- meshes --")
    for i, m in enumerate(js.get("meshes", [])):
        prims = m.get("primitives", [])
        mats = [p.get("material") for p in prims]
        print(f"  [{i:02d}] {m.get('name','?'):32s} prims={len(prims)} mats={mats}")
    if dump:
        files = dump_images(js, bins, dump)
        print(f"\n-- dumped {len(files)} images to {dump} --")
        for p, size, users in files:
            print(f"  {p.name:14s} {size/1024:7.1f}KB  used by: {', '.join(users[:3]) or '-'}")


if __name__ == "__main__":
    main()
