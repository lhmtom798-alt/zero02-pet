#!/usr/bin/env python3
"""Darling02 第 3 轮：给「红大衣下摆」封底（把默认机位看到的黑裙/黑内衬变成红下摆）。

**根因（实测）**：默认桌宠机位比裙摆略高，会通过裙摆下方的开口看到裙子**内侧的背面**；
mmd-shade 生成的描边壳（inverse hull，颜色 0x3a2431 = (58,36,49)）正好铺在那里，
于是视觉上像一条「黑短裙」。证据：
  * 把描边壳隐藏 → 黑色区域消失（裙摆干净收口）；
  * 相机抬高（el 0.05 → 0.45）→ 黑色区域自然消失；
  * 把 Tops 贴图整张涂绿 → 该区域仍然是 (54,34,62) 的描边色，说明它不是贴图（改色无效）。

**做法**：在 PMX 里给「Tops 材质的下摆边界环」补一个**内衬封底**（三角扇，法线朝下、双面材质，
UV 采样大衣贴图里的红色区域，蒙皮权重抄自下摆顶点），把开口挡住：
默认机位往里看时看到的是红色内衬，而不是描边壳的背面。

用法：
  python3 tools/darling-hem-cap.py            # 修改 models/final/Darling02_fixed.model.json 并重写 PMX
  python3 tools/darling-hem-cap.py --dry-run  # 只统计不写
  python3 tools/darling-hem-cap.py --remove   # 把之前加的封底移除（重跑 darling-fix.py 也行）
"""
import argparse
import json
import sys
import pathlib

import numpy as np
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools" / "hunt"))
import json2pmx  # noqa: E402

MODEL_JSON = ROOT / "models" / "final" / "Darling02_fixed.model.json"
PMX_OUT = ROOT / "models" / "final" / "Darling02_fixed.pmx"
TEX = ROOT / "models" / "mmd" / "Darling02" / "tex" / "f00_002_01_tops_01_cloth.png"

TOPS_TEXTURE = "f00_002_01_tops_01_cloth.png"
SEGMENTS = 40          # 封底扇的边数（沿边界环采样）
RAISE = 0.06           # 封底相对下摆抬高的量（藏在裙子里，默认机位看不到边）
UV_CENTER = (0.06, 0.62)   # 封底 UV 采样的红色区域中心（实测该点为大衣红 (153,40,50)）
UV_RADIUS = (0.05, 0.03)


def find_tops_material(model):
    for mi, mat in enumerate(model["materials"]):
        if mat["textureIndex"] >= 0:
            name = model["textures"][mat["textureIndex"]].replace("\\", "/").split("/")[-1]
            if name == TOPS_TEXTURE:
                return mi
    raise SystemExit("找不到 Tops 材质")


def boundary_ring(verts, faces, face_range):
    """找该材质面片里「只被一个面使用」的边 → 下摆边界环（取 y 较低的那部分）。"""
    from collections import Counter, defaultdict
    edge_cnt = Counter()
    edge_faces = defaultdict(list)
    for fi in range(*face_range):
        idx = faces[fi]["indices"]
        for k in range(3):
            a, b = idx[k], idx[(k + 1) % 3]
            e = (a, b) if a < b else (b, a)
            edge_cnt[e] += 1
    bnd = [e for e, c in edge_cnt.items() if c == 1]
    # 取低处边界（y 低于整体中位数）
    ys = np.array([verts[e[0]]["position"][1] for e in bnd])
    y_lo = ys.min()
    lower = [e for e in bnd if verts[e[0]]["position"][1] < y_lo + 2.2 and verts[e[1]]["position"][1] < y_lo + 2.2]
    # 连成环
    nbr = defaultdict(list)
    for a, b in lower:
        nbr[a].append(b); nbr[b].append(a)
    start = lower[0][0] if lower else None
    ring, cur, prev = [], start, None
    seen = set()
    while cur is not None and cur not in seen:
        seen.add(cur); ring.append(cur)
        nxt = [n for n in nbr[cur] if n != prev]
        prev, cur = cur, (nxt[0] if nxt else None)
    return ring, len(lower)


def build_cap(model, dry=False):
    """把「裙摆下半部分」复制一份、向中轴收缩后作为红色内衬（inner lining）。

    内衬比外裙更靠近中轴，从裙摆开口看进去时它挡在描边壳（向外扩了 0.03~0.04）前面，
    于是那块「黑」就变成了红色内衬。UV 直接沿用外裙的 UV（本来就是红色贴图）。
    """
    verts = model["vertices"]; faces = model["faces"]; mats = model["materials"]
    mi = find_tops_material(model)
    start = sum(m["faceCount"] for m in mats[:mi])
    rng = (start, start + mats[mi]["faceCount"])
    # 选裙摆区域的三角形：三个顶点 y 都在 [Y_MIN, Y_MAX]，且整体离中轴有足够半径
    Y_LO, Y_HI, SCALE = 9.0, 13.4, 0.90
    picked = []
    for fi in range(*rng):
        idx = faces[fi]["indices"]
        ys = [verts[i]["position"][1] for i in idx]
        if min(ys) < Y_LO or max(ys) > Y_HI:
            continue
        rs = [np.hypot(verts[i]["position"][0], verts[i]["position"][2]) for i in idx]
        if max(rs) < 0.45:
            continue
        if min(rs) < 0.12:
            continue
        picked.append(fi)
    print("内衬来源面: %d / %d" % (len(picked), rng[1] - rng[0]))
    if len(picked) < 20:
        raise SystemExit("裙摆面太少，放弃")
    if dry:
        print("[dry-run] 将追加 %d 顶点 / %d 面" % (len(picked) * 3, len(picked)))
        return 0
    # 复制顶点（向中轴收缩 SCALE，抬高一点点避免和外裙 z-fighting），UV 不变
    vmap = {}
    for fi in picked:
        for i in faces[fi]["indices"]:
            if i in vmap:
                continue
            src = verts[i]
            p = src["position"]
            v = dict(src)
            v["position"] = [float(p[0] * SCALE), float(p[1] + 0.05), float(p[2] * SCALE)]
            v["normal"] = [float(-src["normal"][0]), float(-src["normal"][1]), float(-src["normal"][2])]
            vmap[i] = len(verts)
            verts.append(v)
    new_faces = [{"indices": [vmap[i] for i in faces[fi]["indices"]]} for fi in picked]
    insert_at = rng[1]
    faces[insert_at:insert_at] = new_faces
    mats[mi]["faceCount"] += len(new_faces)
    model["metadata"]["faceCount"] = len(faces)
    model["metadata"]["vertexCount"] = len(verts)
    print("内衬: +%d 顶点 / +%d 面（材质 %d: %s）" % (len(vmap), len(new_faces), mi, mats[mi]["name"]))
    return len(new_faces)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    model = json.loads(MODEL_JSON.read_text())
    n = build_cap(model, args.dry_run)
    if args.dry_run or not n:
        return
    model["textures"] = [t.replace("\\", "/") for t in model["textures"]]
    MODEL_JSON.write_text(json.dumps(model, ensure_ascii=False))
    size = json2pmx.write_pmx(model, str(PMX_OUT), lower_textures=True)
    print("写出:", PMX_OUT, size, "bytes")


if __name__ == "__main__":
    main()
