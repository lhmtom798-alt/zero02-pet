#!/usr/bin/env python3
"""Darling02（游戏风 02）贴图换色：把服装/配色拉向动画 / 2D 立绘里的 02。

改什么（只动颜色，不动文件名/尺寸/mode/alpha；头发、皮肤、眼睛一律不碰）
----------------------------------------------------------------------
1) 红大衣（`f00_002_01_tops_01_cloth.png`，材质 Tops）：贴图里偏暗、偏砖红的大衣红提亮 + 提饱和，
   只动「红像素」，白领/金肩章/藏青垫肩/蓝扣/白滚边不碰；
2) 灰丝→黑丝（`f00_002_02_body_00_skin.png`，材质 Body）：腿上深蓝灰裤袜去蓝压暗成中性黑，
   皮肤像素完全不动；
3) 白球鞋→白靴配色（`f00_002_01_shoes_01_cloth.png`，材质 Shoes）：橙色饰边/彩块压成白色系，
   深蓝鞋底/袜口压成中性深灰；白色鞋面提纯（第 3 轮）；
4) 黑短裙→02 红裙（同一个 Tops 贴图）：用**三角形级 UV 栅格化**把「采样到贴图黑色区域」的裙子面片
   在 UV 空间栅格化成 mask，只在 mask 内、且原本是近黑像素的位置换成 02 红（第 3 轮）；
5) 02 红眼线（`f00_000_00_faceeyeline_00_face.png`）：把贴图里外眼角已有的暗红眼线提成鲜红，
   并沿上睫毛外眼角补一段上扬的红眼线；左右眼按 UV 镜像同时生效（第 3 轮）；
6) 其余贴图原样复制（`models/final/darling-tex/` = 可直接覆盖的完整贴图集）。

为什么不能只按「目标颜色」直接涂
--------------------------------
桌宠的 mmdchar + mmd-shade 管线会给 MMDToonMaterial 叠灯 + 赛璐璐边光 + 高光，
渲染出来的颜色比贴图亮一档（红大衣贴图 R≈148 → 渲染 R≈206，G/B 也被抬高）。
所以按「渲染后再采样」标定（见 docs/02-DARLING-PIPELINE.md §3）：
大衣 R ×1.34、G/B ×0.86 → 渲染后从 (206,93,103) 提到 ≈(250,88,97)，和 TDA 对齐。

用法
----
  python3 tools/darling-recolor.py                # 生成 models/final/darling-tex/
  python3 tools/darling-recolor.py --dry-run      # 只统计不写文件
  python3 tools/darling-recolor.py --out DIR      # 自定义输出目录
  python3 tools/darling-recolor.py --no-skirt     # 跳过「黑短裙→红裙」（不需要 model JSON）
  python3 tools/darling-recolor.py --model-json PATH   # 指定几何 JSON（默认 models/final/Darling02_fixed.model.json）

注意：黑短裙 mask 需要 mmd-parser 结构的模型 JSON（`tools/darling-fix.py` 会产出）。没有时自动跳过并提示。
依赖：Pillow + numpy（DSH 自带 python 即可）。
"""
import argparse
import json
import pathlib
import shutil

import numpy as np
from PIL import Image, ImageDraw

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "models" / "mmd" / "Darling02" / "tex"
OUT = ROOT / "models" / "final" / "darling-tex"
SHOTS = ROOT / "shots"

# ============================== 可调参数 ==============================
# 红大衣：在 sRGB 上做通道缩放（保留褶皱明暗，只改色相/饱和/亮度）
COAT = {
    "mask_r_minus_g": 22, "mask_r_minus_b": 18, "mask_r_min": 35,
    "kR": 1.34, "kG": 0.84, "kB": 0.86, "kR2": 1.15, "dark_thresh": 110,
}
# 裤袜 / 短裙（body 贴图深色区）：深蓝灰 → 中性黑
DARK = {
    "luma_max": 92, "blue_bias": -6, "strength": 0.72, "neutralize": 0.85,
}
# 白靴配色（第 3 轮）：橙色饰边/彩色块 → 白系；深蓝鞋底/袜口 → 中性深灰
BOOTS = {
    "white_min": 168, "k": 1.04, "cap": 250, "cool": 2,
    "trim_r_minus_g": 28, "trim_r_min": 120, "trim_out": [238, 238, 240],
    "dark_max": 95, "sole_out": [58, 58, 62],
}
# 第 3 轮：黑短裙 → 02 红裙（mask 来自 Tops 材质里采样贴图黑色区域的面片）
SKIRT = {
    "model_json": "models/final/Darling02_fixed.model.json",
    "dark_threshold": 40,   # 顶点采样 max(R,G,B) < 该值 → 判为「黑裙」面片
    "mask_dilate": 3,       # mask 膨胀像素（抵消双线性采样边缘）
    "red": [206, 30, 44],   # 目标红（≈ 大衣贴图红 (198,30,40)，略亮便于阴影里也读成红）
    "grad_top": 1.10, "grad_bottom": 0.82,
}
# 第 3 轮：02 红眼线（faceeyeline 贴图，两条以 x=512 镜像的 strip）
EYELINER = {
    "red_target": [232, 20, 58],
    "wing": True, "wing_len": 96, "wing_thick": 12,
    "mirror_center": 512,
    "outer_x": 108,     # 实测：左 strip 外眼角在 x 小侧（x≈108），另一个 strip 镜像
    "top_y": 64,        # 上睫毛线 y
}
# ====================================================================

TARGETS = {
    "f00_002_01_tops_01_cloth.png": "coat+skirt",
    "f00_002_02_body_00_skin.png": "tights",
    "f00_002_01_shoes_01_cloth.png": "boots",
    "f00_000_00_faceeyeline_00_face.png": "eyeliner",
}


def load_model_json(prefer=None):
    """读修复脚本产出的 mmd-parser 结构 JSON（只用于几何/UV/mask，不写回）。"""
    cands = []
    if prefer:
        cands.append(pathlib.Path(prefer))
    cands.append(ROOT / SKIRT["model_json"])
    cands.append(pathlib.Path("/tmp/darling-model.json"))
    for p in cands:
        if p and p.exists():
            return json.loads(p.read_text())
    return None


def red_stats(a):
    a = np.asarray(a, dtype=int)
    m = (a[:, :, 0] > a[:, :, 1] + 25) & (a[:, :, 0] > a[:, :, 2] + 20) & (a[:, :, 0] > 40)
    if not m.any():
        return None
    sel = a[m][:, :3]
    return {"n": int(m.sum()), "mean": sel.mean(axis=0).round().astype(int).tolist(),
            "median": np.median(sel, axis=0).astype(int).tolist()}


# ------------------------------ 大衣 ------------------------------
def recolor_coat(a):
    r, g, b = a[:, :, 0], a[:, :, 1], a[:, :, 2]
    mask = ((r - g) > COAT["mask_r_minus_g"]) & ((r - b) > COAT["mask_r_minus_b"]) & (r > COAT["mask_r_min"])
    luma = 0.299 * r + 0.587 * g + 0.114 * b
    out = a.copy()
    kR = np.where(luma < COAT["dark_thresh"], COAT["kR"] * COAT["kR2"], COAT["kR"])
    out[:, :, 0] = np.where(mask, np.clip(r * kR, 0, 255), r)
    out[:, :, 1] = np.where(mask, np.clip(g * COAT["kG"], 0, 255), g)
    out[:, :, 2] = np.where(mask, np.clip(b * COAT["kB"], 0, 255), b)
    return out, {"coat_px": int(mask.sum())}


# ------------------------------ 裤袜 ------------------------------
def recolor_tights(a):
    r, g, b = a[:, :, 0], a[:, :, 1], a[:, :, 2]
    mx = np.maximum(np.maximum(r, g), b)
    mask = (mx < DARK["luma_max"]) & ((b - r) > DARK["blue_bias"])
    out = a.copy()
    lum = (0.299 * r + 0.587 * g + 0.114 * b) * DARK["strength"]
    rg = (r + g) * 0.5
    nb = b + (rg - b) * DARK["neutralize"]
    out[:, :, 0] = np.where(mask, np.clip(lum * 0.98, 0, 255), r)
    out[:, :, 1] = np.where(mask, np.clip(lum * 0.98, 0, 255), g)
    out[:, :, 2] = np.where(mask, np.clip(np.minimum(lum * 0.62, nb), 0, 255), b)
    return out, {"tights_px": int(mask.sum())}


# ------------------------------ 白靴 ------------------------------
def recolor_boots(a):
    r, g, b = a[:, :, 0], a[:, :, 1], a[:, :, 2]
    mn = np.minimum(np.minimum(r, g), b)
    mx = np.maximum(np.maximum(r, g), b)
    white = mn > BOOTS["white_min"]
    trim = ((r - g) > BOOTS["trim_r_minus_g"]) & (r > BOOTS["trim_r_min"]) & (mx > 110)
    dark = mx < BOOTS["dark_max"]
    out = a.copy()
    # 1) 白色提纯
    nr = np.clip(mx * BOOTS["k"], 0, BOOTS["cap"])
    out[:, :, 0] = np.where(white, nr, out[:, :, 0])
    out[:, :, 1] = np.where(white, nr, out[:, :, 1])
    out[:, :, 2] = np.where(white, np.clip(nr + BOOTS["cool"], 0, 255), out[:, :, 2])
    # 2) 橙色饰边/彩色块 → 白色系（保留一点明暗）
    tcol = np.array(BOOTS["trim_out"], dtype=np.float32)
    lum = np.clip((0.299 * r + 0.587 * g + 0.114 * b) / 235.0, 0.92, 1.0)
    for c in range(3):
        out[:, :, c] = np.where(trim, np.clip(tcol[c] * lum, 0, 255), out[:, :, c])
    # 3) 深蓝鞋底/袜口 → 中性深灰
    for c, v in enumerate(BOOTS["sole_out"]):
        out[:, :, c] = np.where(dark, v, out[:, :, c])
    return out, {"white_px": int(white.sum()), "trim_px": int(trim.sum()), "sole_px": int(dark.sum())}


# --------------------------- 黑短裙 → 红裙 ---------------------------
def build_skirt_mask(model, texture_filename, used_w, used_h):
    """三角形级 UV 栅格化：Tops 材质里「三个顶点都采样到贴图黑色」的面片 = 黑短裙 → mask。"""
    verts, faces, mats, texs = model["vertices"], model["faces"], model["materials"], model["textures"]
    mat_index, start, ranges = None, 0, {}
    for mi, mat in enumerate(mats):
        ranges[mi] = (start, start + mat["faceCount"])
        if mat["textureIndex"] >= 0:
            name = texs[mat["textureIndex"]].replace("\\", "/").split("/")[-1]
            if name == texture_filename:
                mat_index = mi
        start += mat["faceCount"]
    if mat_index is None:
        raise SystemExit("贴图 %s 找不到对应材质" % texture_filename)
    arr = np.array(Image.open(SRC / texture_filename).convert("RGB")).astype(int)
    W, H = arr.shape[1], arr.shape[0]

    def sample(u, v):
        return arr[int((v % 1.0) * H) % H, int((u % 1.0) * W) % W]

    tri_uvs = []
    for fi in range(*ranges[mat_index]):
        idx = faces[fi]["indices"]
        cols = [sample(verts[i]["uv"][0], verts[i]["uv"][1]) for i in idx]
        if max(max(c) for c in cols) < SKIRT["dark_threshold"]:
            tri_uvs.append([((verts[i]["uv"][0] % 1.0) * used_w, (verts[i]["uv"][1] % 1.0) * used_h) for i in idx])
    mask = np.zeros((used_h, used_w), dtype=bool)

    def raster(tri):
        (x0, y0), (x1, y1), (x2, y2) = tri
        xmin = max(0, int(np.floor(min(x0, x1, x2)))); xmax = min(used_w - 1, int(np.ceil(max(x0, x1, x2))))
        ymin = max(0, int(np.floor(min(y0, y1, y2)))); ymax = min(used_h - 1, int(np.ceil(max(y0, y1, y2))))
        if xmax < xmin or ymax < ymin:
            return
        X, Y = np.meshgrid(np.arange(xmin, xmax + 1) + 0.5, np.arange(ymin, ymax + 1) + 0.5)
        den = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2)
        if abs(den) < 1e-9:
            return
        aa = ((y1 - y2) * (X - x2) + (x2 - x1) * (Y - y2)) / den
        bb = ((y2 - y0) * (X - x2) + (x0 - x2) * (Y - y2)) / den
        cc = 1 - aa - bb
        mask[ymin:ymax + 1, xmin:xmax + 1] |= (aa >= -0.01) & (bb >= -0.01) & (cc >= -0.01)

    for tri in tri_uvs:
        raster(tri)
    if SKIRT["mask_dilate"] > 0 and mask.any():
        d = int(SKIRT["mask_dilate"])
        pad = np.pad(mask, d, mode="constant", constant_values=False)
        grown = np.zeros_like(mask)
        for dy in range(2 * d + 1):
            for dx in range(2 * d + 1):
                grown |= pad[dy:dy + used_h, dx:dx + used_w]
        mask = grown
    return mask, mat_index, len(tri_uvs)


def recolor_skirt(a, model):
    """黑短裙 → 02 红裙：只在三角形级 mask 内、原本近黑的像素上换色（保留上亮下暗）。"""
    h, w = a.shape[:2]
    used_w = w // 3
    mask, mat_index, n_tri = build_skirt_mask(model, "f00_002_01_tops_01_cloth.png", used_w, h)
    region = a[:, :used_w, :3]
    sel = mask & (region.max(axis=2) < 80)
    if not sel.any():
        return a, {"mask_px": int(mask.sum()), "recolored_px": 0, "mat": mat_index, "faces": n_tri}
    ys = np.where(mask.any(axis=1))[0]
    y0, y1 = int(ys.min()), int(max(ys.max(), ys.min() + 1))
    t = np.clip((np.arange(h)[:, None] - y0) / float(y1 - y0), 0, 1)
    k = SKIRT["grad_top"] * (1 - t) + SKIRT["grad_bottom"] * t
    red = np.array(SKIRT["red"], dtype=np.float32)
    for c in range(3):
        region[:, :, c] = np.where(sel, np.clip(red[c] * k, 0, 255), region[:, :, c])
    a[:, :used_w, :3] = region
    return a, {"mask_px": int(mask.sum()), "recolored_px": int(sel.sum()), "mat": mat_index, "faces": n_tri}


# ------------------------------ 红眼线 ------------------------------
def _draw_wing(x_from, x_to, y, thick):
    """返回一串 (x, y, r) 圆点，连成一条粗细渐变的红线（y 基准，越往 x_to 越上扬）。"""
    canvas = []
    n = max(6, abs(int(x_to - x_from)) // 2)
    for i in range(n):
        t = i / float(n - 1)
        x = x_from + (x_to - x_from) * t
        yy = y - 10.0 * t          # 外眼角上扬
        wdt = thick * (1.0 - 0.55 * t)
        r = wdt * 0.5
        canvas.append((x, yy, r))
    return canvas


def recolor_eyeliner(a):
    """02 红眼线：已有暗红提成鲜红 + 外眼角上方补一段上扬红线（左右镜像）。"""
    h, w = a.shape[:2]
    used_w = w // 3
    region = np.array(a[:, :used_w])            # RGBA of used third
    r, g, b, al = region[:, :, 0].astype(int), region[:, :, 1].astype(int), region[:, :, 2].astype(int), region[:, :, 3]
    existing = ((r - g) > 35) & ((r - b) > 20) & (r > 110) & (al > 40)
    tr = np.array(EYELINER["red_target"], dtype=np.float32)
    if existing.any():
        lum = (0.299 * r + 0.587 * g + 0.114 * b)[existing].astype(float)
        mean = float(np.median(lum)) if lum.size else 200.0
        k = np.clip(lum / max(1.0, mean), 0.86, 1.12)[:, None]
        region[existing, 0] = np.clip(tr[0] * k[:, 0], 0, 255).astype(np.uint8)
        region[existing, 1] = np.clip(tr[1] * k[:, 0], 0, 255).astype(np.uint8)
        region[existing, 2] = np.clip(tr[2] * k[:, 0], 0, 255).astype(np.uint8)
        region[existing, 3] = 255
    added = 0
    if EYELINER["wing"]:
        L, th, oy = EYELINER["wing_len"], EYELINER["wing_thick"], EYELINER["top_y"]
        pts = _draw_wing(EYELINER["outer_x"] + L, EYELINER["outer_x"] - 6, oy + 26, th)
        tmp = Image.fromarray(np.clip(region, 0, 255).astype(np.uint8), "RGBA")
        d = ImageDraw.Draw(tmp)
        for side in (0, 1):
            for (x, yy, rad) in pts:
                xs = x if side == 0 else (used_w - 1 - x)
                d.ellipse([xs - rad, yy - rad, xs + rad, yy + rad], fill=tuple(EYELINER["red_target"]) + (255,))
            added += 1
        region = np.array(tmp).astype(np.float32)
    a[:, :used_w] = np.clip(region, 0, 255).astype(np.float32)
    return a, {"existing_red_px": int(existing.sum()), "wing_strokes": added}


# ------------------------------ 对比图 ------------------------------
def used_region(img, ratio=1.0 / 3.0):
    return img.crop((0, 0, int(img.width * ratio), img.height))


def save_compare(src_img, out_img, name, tag, height=320):
    ins = used_region(src_img.convert("RGBA"))
    outs = used_region(out_img.convert("RGBA"))
    if ins.size != outs.size:
        outs = outs.resize(ins.size)
    bg = Image.new("RGBA", ins.size, (245, 245, 245, 255))
    before = bg.copy(); before.alpha_composite(ins)
    after = bg.copy(); after.alpha_composite(outs)
    sc = height / ins.height
    sz = (max(1, int(ins.width * sc)), height)
    before = before.convert("RGB").resize(sz, Image.LANCZOS)
    after = after.convert("RGB").resize(sz, Image.LANCZOS)
    gap = 8
    canvas = Image.new("RGB", (sz[0] * 2 + gap, height + 22), (32, 26, 40))
    canvas.paste(before, (0, 22)); canvas.paste(after, (sz[0] + gap, 22))
    d = ImageDraw.Draw(canvas)
    d.text((6, 6), "before", fill=(200, 190, 220))
    d.text((sz[0] + gap + 6, 6), "after  (%s)" % tag, fill=(255, 200, 220))
    SHOTS.mkdir(exist_ok=True)
    path = SHOTS / ("darling-tex-%s.png" % name.replace(".png", ""))
    canvas.save(path)
    return path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=str(SRC))
    ap.add_argument("--out", default=str(OUT))
    ap.add_argument("--model-json", default="")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--no-skirt", action="store_true", help="跳过黑短裙→红裙（不需要 model JSON）")
    args = ap.parse_args()
    src = pathlib.Path(args.src)
    out = pathlib.Path(args.out)
    if not src.is_dir():
        raise SystemExit("找不到源贴图目录: %s" % src)
    tex_out = out / "tex"
    if not args.dry_run:
        tex_out.mkdir(parents=True, exist_ok=True)

    model = None
    if not args.no_skirt:
        model = load_model_json(args.model_json or None)
        if model is None:
            print("!! 找不到模型 JSON（先跑 tools/darling-fix.py），本轮跳过「黑短裙→红裙」")
    manifest = {"source": str(src.relative_to(ROOT)), "out": str(out.relative_to(ROOT)), "files": []}
    for f in sorted(src.iterdir()):
        if not f.is_file():
            continue
        rel = f.name
        if rel not in TARGETS:
            if not args.dry_run:
                (tex_out / rel).parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(f, tex_out / rel)
            manifest["files"].append({"file": rel, "action": "copy"})
            continue
        img = Image.open(f)
        mode = img.mode
        im = img.convert("RGBA")
        a = np.array(im).astype(np.float32)
        kind = TARGETS[rel]
        stats_extra = {}
        if kind == "coat+skirt":
            before_red = red_stats(np.array(img.convert("RGB")))
            a, st1 = recolor_coat(a)
            stats_extra.update(st1)
            if model is not None and not args.no_skirt:
                a, st2 = recolor_skirt(a, model)
                stats_extra.update(st2)
            res = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), "RGBA")
            stats_extra["red_before"] = before_red
            stats_extra["red_after"] = red_stats(np.array(res.convert("RGB")))
        elif kind == "tights":
            a, stats_extra = recolor_tights(a)
            res = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), "RGBA")
        elif kind == "boots":
            a, stats_extra = recolor_boots(a)
            res = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), "RGBA")
        else:
            a, stats_extra = recolor_eyeliner(a)
            res = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), "RGBA")
        # 还原 mode（RGB/RGBA 保持不变；alpha 逐像素保留）
        if mode != "RGBA" and "A" not in mode:
            res = res.convert(mode)
        stats = {"file": rel, "action": kind, "mode_in": mode, "mode_out": res.mode,
                 "size_in": list(img.size), "size_out": list(res.size)}
        stats.update(stats_extra)
        if "A" in img.mode:
            al0 = np.array(img.convert("RGBA"))[:, :, 3]
            al1 = np.array(res.convert("RGBA"))[:, :, 3]
            stats["alpha_identical"] = bool(np.array_equal(al0, al1))
        manifest["files"].append(stats)
        print("%-40s %-12s %s" % (rel, kind, json.dumps(stats_extra, ensure_ascii=False)))
        if not args.dry_run:
            res.save(tex_out / rel)
            cmp_path = save_compare(img, res, rel, kind)
            print("  对比图:", cmp_path.relative_to(ROOT))

    if not args.dry_run:
        (out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
        print("\n写出:", tex_out)
        print("  manifest:", (out / "manifest.json").relative_to(ROOT))


if __name__ == "__main__":
    main()
