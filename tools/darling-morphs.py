#!/usr/bin/env python3
"""Darling02 第 4 轮：补 mmdchar 缺的表情（顶点 morph 实装）。

背景（第 3 轮结论）：MMDLoader 只把 **vertex morph（type 1）** 转成 morphTarget；
UV morph / material morph 不生效。所以三个缺失表情用「顶点 morph + 小面片」实现：

1) `horns +`  —— 角（mat7 = Hair_04，140 顶点）沿「头带根部 → 角尖」方向放大 1.45 倍（角尖位移 ≈0.35）。
2) `照れ`（脸红）—— 新增 2 片「腮红面片」（新材质 + 新贴图 tex/darling_blush.png，透明底红色径向渐变），
   平时藏在头颅内部（z≈-0.55，不可见）；顶点 morph 把它们位移到脸颊表面外（z→-1.22）。
3) `はぁと`（爱心眼）—— 新增 2 片「爱心面片」（tex/darling_heart.png），藏在颅内；
   morph 位移到双眼虹膜前（z→-1.20）。

4) 第 5 轮「别名 morph」——源模型 44 个 morph 里已有 VRM 的 Fcl_* 系列，复制（不破坏原 morph）出标准名：
   `にやり`（坏笑）  ← MTH_Fun
   `にこり`（微笑）  ← EYE_Joy + MTH_Joy（合并）
   `じと目`（半眯眼）← 0.42 × まばたき + 0.5 × BRW_Angry（半闭眼 + 压眉，比源模型任何单个 EYE_* 更像「じと目」）
   `ぺろっ`（吐舌）  ← 源模型没有舌头几何 → 新增「舌头面片」（新材质+贴图，藏在口腔内）+ 顶点 morph 位移到嘴前

同时把 mmdchar 会用的表情名写成完全一致的字符串（mmdchar.js 的 EXPR 表）：
  `horns +` / `照れ` / `はぁと` / `にやり` / `にこり` / `じと目` / `ぺろっ`

用法（必须在 darling-fix.py / darling-hem-cap.py 之后跑，因为要基于修复后的 model JSON）：
  python3 tools/darling-morphs.py            # 追加 morph + 面片 + 贴图，重写 models/final/Darling02_fixed.pmx
  python3 tools/darling-morphs.py --dry-run
  python3 tools/darling-morphs.py --force    # 已存在也重建（先删掉同名 morph/材质/面片较复杂，建议直接重跑 darling-fix.py）

贴图生成到 models/final/darling-tex/tex/（build.py 会随换色贴图一起打进 assets）。
"""
import argparse
import json
import pathlib
import sys

import numpy as np
from PIL import Image, ImageDraw

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools" / "hunt"))
import json2pmx  # noqa: E402

MODEL_JSON = ROOT / "models" / "final" / "Darling02_fixed.model.json"
PMX_OUT = ROOT / "models" / "final" / "Darling02_fixed.pmx"
TEX_OUT = ROOT / "models" / "final" / "darling-tex" / "tex"

# 几何参数（第 3 轮实测）
HEAD_BONE_NAME = "頭"
HORN_MAT = 7                 # Hair_04 = 角
BLUSH_TEX_NAME = "darling_blush.png"
HEART_TEX_NAME = "darling_heart.png"
BLUSH_UV = (0.5, 0.5)        # 面片采样新贴图中心（新贴图自己独立，UV 0..1 直接用）
QUAD_SIZE = {"blush": 0.56, "heart": 0.46}
HIDDEN_Z = -0.55             # 藏在颅内（头前表面约 z=-1.0，后脑 +0.5）
BLUSH_POS = {1: (0.70, 21.36, -1.24), -1: (-0.70, 21.36, -1.24)}     # 脸颊表面外
HEART_POS = {1: (0.55, 21.96, -1.21), -1: (-0.55, 21.96, -1.21)}      # 虹膜前
TONGUE_TEX_NAME = "darling_tongue.png"
TONGUE_HIDDEN_Z = -0.78          # 藏在口腔/颅内（嘴前表面约 z=-1.30）
TONGUE_POS = (0.0, 21.12, -1.34) # 吐舌位置（嘴前下方）
TONGUE_SIZE = (0.20, 0.24)
HORN_GROW = 0.65             # 角放大比例（tip 位移 ≈ 0.45 * 半径 ≈ 0.35~0.4）
HORN_BASE = {1: (0.45, 23.44, -1.30), -1: (-0.45, 23.44, -1.30)}      # 头带根部


def make_blush_texture(path):
    """透明底 + 红色径向渐变（软腮红）。"""
    S = 256
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    px = im.load()
    cx = cy = S / 2.0
    r = S * 0.48
    for y in range(S):
        for x in range(S):
            d = ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5 / r
            if d >= 1.0:
                continue
            k = (1.0 - d) ** 1.6
            a = int(205 * k)
            px[x, y] = (232, 44, 78, a)
    path.parent.mkdir(parents=True, exist_ok=True)
    im.save(path)


def make_heart_texture(path):
    """透明底 + 红色爱心（亮部高光），用于「はぁと」爱心眼。"""
    S = 256
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    # 两个圆 + 一个三角拼爱心
    d.ellipse([S * 0.10, S * 0.06, S * 0.52, S * 0.48], fill=(232, 30, 66, 255))
    d.ellipse([S * 0.48, S * 0.06, S * 0.90, S * 0.48], fill=(232, 30, 66, 255))
    d.polygon([(S * 0.10, S * 0.33), (S * 0.90, S * 0.33), (S * 0.50, S * 0.94)], fill=(232, 30, 66, 255))
    # 高光
    d.ellipse([S * 0.26, S * 0.18, S * 0.40, S * 0.30], fill=(255, 190, 205, 235))
    path.parent.mkdir(parents=True, exist_ok=True)
    im.save(path)


def make_tongue_texture(path):
    """透明底 + 粉色舌头（U 形 + 中间压痕高光）。"""
    S = 256
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.ellipse([S * 0.16, S * 0.24, S * 0.84, S * 0.92], fill=(226, 96, 116, 255))
    d.ellipse([S * 0.28, S * 0.20, S * 0.72, S * 0.60], fill=(240, 128, 146, 255))
    d.line([(S * 0.50, S * 0.34), (S * 0.50, S * 0.80)], fill=(186, 62, 82, 235), width=max(2, S // 40))
    d.ellipse([S * 0.34, S * 0.40, S * 0.46, S * 0.52], fill=(255, 190, 200, 220))
    path.parent.mkdir(parents=True, exist_ok=True)
    im.save(path)


def merge_deltas(model, picks):
    """把若干「源 morph × 权重」的顶点位移按顶点索引合并成一份 delta 列表。"""
    acc = {}
    by_name = {mo["name"]: mo for mo in model["morphs"]}
    for name, weight in picks:
        mo = by_name.get(name)
        if mo is None:
            raise SystemExit("源 morph 不存在: " + name)
        for e in mo["elements"]:
            pos = e["position"]
            cur = acc.get(e["index"])
            if cur is None:
                acc[e["index"]] = [pos[0] * weight, pos[1] * weight, pos[2] * weight]
            else:
                for k in range(3):
                    cur[k] += pos[k] * weight
    return [{"index": i, "position": [float(v[0]), float(v[1]), float(v[2])]} for i, v in sorted(acc.items())]


def mat_vertex_ids(faces, series):
    vids = set()
    for fi in series:
        vids.update(faces[fi]["indices"])
    return vids


def material_range(mats, mi):
    start = sum(m["faceCount"] for m in mats[:mi])
    return start, start + mats[mi]["faceCount"]


def add_quad(model, material_index, center, size, head_bone, hidden_z):
    """加一片朝 -z 的四边形（新顶点），返回顶点索引列表；初始位置藏在颅内。"""
    verts = model["vertices"]
    cx, cy, cz = center
    hs = size / 2.0
    corners = [(cx - hs, cy + hs), (cx + hs, cy + hs), (cx + hs, cy - hs), (cx - hs, cy - hs)]
    uvs = [(0, 0), (1, 0), (1, 1), (0, 1)]
    base = len(verts)
    for (x, y), (u, v) in zip(corners, uvs):
        verts.append({
            "position": [float(x), float(y), float(HIDDEN_Z)],
            "normal": [0.0, 0.0, -1.0],
            "uv": [float(u), float(v)],
            "type": 0,
            "skinIndices": [head_bone, 0, 0, 0],
            "skinWeights": [1.0, 0.0, 0.0, 0.0],
            "edgeRatio": 1.0,
        })
    return list(range(base, base + 4))


def add_faces(model, material_index, quads):
    """把面追加到该材质的面块末尾（PMX 面按材质连续排列）。"""
    faces = model["faces"]
    start, end = material_range(model["materials"], material_index)
    new_faces = []
    for q in quads:
        a, b, c, d = q
        new_faces.append({"indices": [a, b, c]})
        new_faces.append({"indices": [a, c, d]})
    faces[end:end] = new_faces
    model["materials"][material_index]["faceCount"] += len(new_faces)
    model["metadata"]["faceCount"] = len(faces)
    model["metadata"]["vertexCount"] = len(model["vertices"])
    return len(new_faces)


def add_material(model, name, texture_path, face_count=0):
    """追加一个「透明 + 双面」材质（照れ/はぁと 面片用）。"""
    materials = model["materials"]
    textures = model["textures"]
    if texture_path not in textures:
        textures.append(texture_path)
    ti = textures.index(texture_path)
    materials.append({
        "name": name,
        "englishName": name,
        "diffuse": [1.0, 1.0, 1.0, 0.995],   # opacity != 1 → MMDLoader 标成 transparent
        "specular": [0.0, 0.0, 0.0],
        "shininess": 0.0,
        "ambient": [1.0, 1.0, 1.0],
        "flag": 15,                           # 双面 + 阴影相关；不含 0x10 → 无描边
        "edgeColor": [0.0, 0.0, 0.0, 1.0],
        "edgeSize": 0.0,
        "textureIndex": ti,
        "envTextureIndex": -1,
        "envFlag": 0,
        "toonFlag": 1,                        # 内置 toon
        "toonIndex": 0,
        "comment": "",
        "faceCount": face_count,
    })
    model["metadata"]["materialCount"] = len(materials)
    model["metadata"]["textureCount"] = len(textures)
    return len(materials) - 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    if not MODEL_JSON.exists():
        raise SystemExit("缺少 %s（先跑 tools/darling-fix.py + darling-hem-cap.py）" % MODEL_JSON)
    model = json.loads(MODEL_JSON.read_text())
    verts, faces, mats, bones = model["vertices"], model["faces"], model["materials"], model["bones"]
    names = [mo.get("name") for mo in model.get("morphs") or []]
    if all(n in names for n in ("horns +", "照れ", "はぁと", "にやり", "にこり", "じと目", "ぺろっ")):
        print("morph 已存在（horns + / 照れ / はぁと / にやり / にこり / じと目 / ぺろっ），跳过。要重建请先重跑 darling-fix.py")
        return
    head_bone = next((i for i, b in enumerate(bones) if b["name"] == HEAD_BONE_NAME), None)
    if head_bone is None:
        raise SystemExit("找不到 頭 骨")

    # ---------- 1) horns + ----------
    hs, he = material_range(mats, HORN_MAT)
    horn_vids = mat_vertex_ids(faces, range(hs, he))
    horn_delta = []
    for i in horn_vids:
        p = verts[i]["position"]
        base = HORN_BASE[1 if p[0] > 0 else -1]
        d = [p[k] - base[k] for k in range(3)]
        disp = [HORN_GROW * d[k] for k in range(3)]
        horn_delta.append({"index": i, "position": [float(disp[0]), float(disp[1]), float(disp[2])]})
    print("horns +: %d 个顶点（角尖最大位移 ≈ %.2f）" % (
        len(horn_delta), max(np.linalg.norm([e["position"][k] for k in range(3)]) for e in horn_delta)))

    # ---------- 2) 照れ（腮红面片） ----------
    blush_tex = pathlib.Path("tex") / BLUSH_TEX_NAME
    heart_tex = pathlib.Path("tex") / HEART_TEX_NAME
    if not args.dry_run:
        make_blush_texture(TEX_OUT / BLUSH_TEX_NAME)
        make_heart_texture(TEX_OUT / HEART_TEX_NAME)
        print("贴图:", TEX_OUT / BLUSH_TEX_NAME, TEX_OUT / HEART_TEX_NAME)
    blush_mi = add_material(model, "darling_blush", str(blush_tex).replace("\\", "/"))
    quads = []
    for side in (1, -1):
        quads.append(add_quad(model, blush_mi, BLUSH_POS[side], QUAD_SIZE["blush"], head_bone, HIDDEN_Z))
    nf = add_faces(model, blush_mi, quads)
    blush_verts = [i for q in quads for i in q]
    blush_delta = []
    for side, q in zip((1, -1), quads):
        cx, cy, cz = BLUSH_POS[side]
        hs2 = QUAD_SIZE["blush"] / 2.0
        corners = [(cx - hs2, cy + hs2), (cx + hs2, cy + hs2), (cx + hs2, cy - hs2), (cx - hs2, cy - hs2)]
        for vi, (x, y) in zip(q, corners):
            p = verts[vi]["position"]
            blush_delta.append({"index": vi, "position": [float(x - p[0]), float(y - p[1]), float(cz - p[2])]})
    print("照れ: 2 片腮红面片 / %d 面，材质 %d（transparent+双面）" % (nf, blush_mi))

    # ---------- 3) はぁと（爱心面片） ----------
    heart_mi = add_material(model, "darling_heart", str(heart_tex).replace("\\", "/"))
    quads2 = []
    for side in (1, -1):
        quads2.append(add_quad(model, heart_mi, HEART_POS[side], QUAD_SIZE["heart"], head_bone, HIDDEN_Z))
    nf2 = add_faces(model, heart_mi, quads2)
    heart_delta = []
    for side, q in zip((1, -1), quads2):
        cx, cy, cz = HEART_POS[side]
        hs2 = QUAD_SIZE["heart"] / 2.0
        corners = [(cx - hs2, cy + hs2), (cx + hs2, cy + hs2), (cx + hs2, cy - hs2), (cx - hs2, cy - hs2)]
        for vi, (x, y) in zip(q, corners):
            p = verts[vi]["position"]
            heart_delta.append({"index": vi, "position": [float(x - p[0]), float(y - p[1]), float(cz - p[2])]})
    print("はぁと: 2 片爱心面片 / %d 面，材质 %d" % (nf2, heart_mi))

    # ---------- 4) 第 5 轮：别名 morph（复制源模型 Fcl_* 的元素，不破坏原 morph） ----------
    alias_morphs = [
        ("にやり", [("Face.M_F00_000_00_Fcl_MTH_Fun", 1.0)]),
        ("にこり", [("Face.M_F00_000_00_Fcl_EYE_Joy", 1.0), ("Face.M_F00_000_00_Fcl_MTH_Joy", 0.6)]),
        ("じと目", [("まばたき", 0.55), ("Face.M_F00_000_00_Fcl_BRW_Angry", 0.6)]),
    ]
    alias_deltas = []
    for new_name, picks in alias_morphs:
        alias_deltas.append((new_name, merge_deltas(model, picks)))
        print("别名 morph: %s <- %s" % (new_name, " + ".join("%s×%.2f" % p for p in picks)))

    # ---------- 5) 第 5 轮：ぺろっ（舌头面片） ----------
    tongue_tex = pathlib.Path("tex") / TONGUE_TEX_NAME
    if not args.dry_run:
        make_tongue_texture(TEX_OUT / TONGUE_TEX_NAME)
        print("贴图:", TEX_OUT / TONGUE_TEX_NAME)
    tongue_mi = add_material(model, "darling_tongue", str(tongue_tex).replace("\\", "/"))
    tw, th = TONGUE_SIZE
    quads3 = [add_quad(model, tongue_mi, TONGUE_POS, max(tw, th), head_bone, TONGUE_HIDDEN_Z)]
    nf3 = add_faces(model, tongue_mi, quads3)
    tongue_delta = []
    q = quads3[0]
    hs3 = max(tw, th) / 2.0
    cx, cy, cz = TONGUE_POS
    corners = [(cx - hs3, cy + hs3), (cx + hs3, cy + hs3), (cx + hs3, cy - hs3), (cx - hs3, cy - hs3)]
    for vi, (x, y) in zip(q, corners):
        p = verts[vi]["position"]
        tongue_delta.append({"index": vi, "position": [float(x - p[0]), float(y - p[1]), float(cz - p[2])]})
    print("ぺろっ: 1 片舌头面片 / %d 面，材质 %d" % (nf3, tongue_mi))

    # ---------- morphs ----------
    def morph(name, deltas):
        return {"name": name, "englishName": "", "panel": 4, "type": 1,
                "elementCount": len(deltas), "elements": deltas}
    model.setdefault("morphs", []).extend([
        morph("horns +", horn_delta),
        morph("照れ", blush_delta),
        morph("はぁと", heart_delta),
    ] + [morph(nm, ds) for nm, ds in alias_deltas] + [
        morph("ぺろっ", tongue_delta),
    ])
    model["metadata"]["morphCount"] = len(model["morphs"])
    print("morphs: %d -> %d（新增 horns + / 照れ / はぁと）" % (len(names), len(model["morphs"])))
    if args.dry_run:
        print("[dry-run] 不写文件")
        return

    model["textures"] = [str(t).replace("\\", "/") for t in model["textures"]]
    MODEL_JSON.write_text(json.dumps(model, ensure_ascii=False))
    size = json2pmx.write_pmx(model, str(PMX_OUT), lower_textures=True)
    print("写出:", PMX_OUT, size, "bytes")


if __name__ == "__main__":
    main()
