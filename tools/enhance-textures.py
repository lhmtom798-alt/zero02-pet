#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""TDA Zero Two（02）MMD 贴图美术增强管线（可复现）。

把 models/mmd/TDA-ZeroTwo/ 下的贴图做离线调色，输出到 models/final/mmd-tex/，
文件名 / 尺寸 / alpha 与原贴图保持一致（face.png 的 alpha 逐像素保留）。

用法：
    python3 tools/enhance-textures.py            # 生成增强贴图 + 纹理级前后对比图
    python3 tools/enhance-textures.py --stage    # 另外把模型复制到 models/mmd/_tex-test/ 并覆盖增强贴图
    python3 tools/enhance-textures.py --render-compare  # 用已渲染的 shots/tex-render-* 拼对比图

依赖：Pillow + numpy（运行环境自带）。
所有参数集中在下方 CONFIG / 各 enhance_* 函数里，改参数重跑即可复现。
"""

import argparse
import hashlib
import json
import os
import shutil
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "models" / "mmd" / "TDA-ZeroTwo"
OUT = ROOT / "models" / "final" / "mmd-tex"
SHOTS = ROOT / "shots"
TEST_MODEL_DIR = ROOT / "models" / "mmd" / "_tex-test"

# ---------------------------------------------------------------------------
# 通用颜色工具（numpy 向量化 HSV）
# ---------------------------------------------------------------------------


def rgb_to_hsv(rgb):
    """rgb: ...x3 float32 in [0,1] -> h,s,v each ... float32."""
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    mx = rgb.max(-1)
    mn = rgb.min(-1)
    d = mx - mn
    h = np.zeros_like(mx)
    nz = d > 1e-8
    # 防止除零
    dd = np.where(nz, d, 1.0)
    rm = nz & (mx == r)
    gm = nz & (mx == g) & ~rm
    bm = nz & (mx == b) & ~rm & ~gm
    h[rm] = ((g - b) / dd)[rm]
    h[gm] = (2.0 + (b - r) / dd)[gm]
    h[bm] = (4.0 + (r - g) / dd)[bm]
    h = (h / 6.0) % 1.0
    s = np.where(mx > 1e-8, d / np.maximum(mx, 1e-8), 0.0)
    return h.astype(np.float32), s.astype(np.float32), mx.astype(np.float32)


def hsv_to_rgb(h, s, v):
    h = (h % 1.0) * 6.0
    i = np.floor(h).astype(np.int32)
    f = h - i
    p = v * (1.0 - s)
    q = v * (1.0 - s * f)
    t = v * (1.0 - s * (1.0 - f))
    i = i % 6
    r = np.choose(i, [v, q, p, p, t, v])
    g = np.choose(i, [t, v, v, q, p, p])
    b = np.choose(i, [p, p, t, v, v, q])
    return np.stack([r, g, b], axis=-1).astype(np.float32)


def hex_rgb(s):
    s = s.lstrip("#")
    return np.array([int(s[i:i + 2], 16) / 255.0 for i in (0, 2, 4)], np.float32)


def smoothstep(a, b, x):
    """支持 a>b（反向过渡）与 a/b 为数组（渐变边界随位置变化）的平滑过渡。"""
    x = np.asarray(x, dtype=np.float32)
    a = np.asarray(a, dtype=np.float32)
    b = np.asarray(b, dtype=np.float32)
    den = b - a
    den = np.where(np.abs(den) < 1e-9, np.float32(1e-9), den)
    t = np.clip((x - a) / den, 0.0, 1.0)
    return (t * t * (3.0 - 2.0 * t)).astype(np.float32)


def to_img(rgb):
    return Image.fromarray((np.clip(rgb, 0, 1) * 255.0 + 0.5).astype(np.uint8), "RGB")


def load_rgb(rel):
    im = Image.open(SRC / rel)
    return im, np.asarray(im.convert("RGB"), dtype=np.float32) / 255.0


def save(im, rel):
    dst = OUT / rel
    dst.parent.mkdir(parents=True, exist_ok=True)
    im.save(dst, "PNG")
    return dst


# ---- 第 2 轮脸部精修通用工具：柔和遮罩 / 颜色混合（alpha 不参与） ----

def _blur(mask, radius):
    from PIL import ImageFilter
    im = Image.fromarray((np.clip(mask, 0, 1) * 255 + 0.5).astype(np.uint8), "L")
    im = im.filter(ImageFilter.GaussianBlur(radius))
    return np.asarray(im, dtype=np.float32) / 255.0


def _dilate(mask, size=3):
    from PIL import ImageFilter
    im = Image.fromarray((np.clip(mask, 0, 1) * 255 + 0.5).astype(np.uint8), "L")
    im = im.filter(ImageFilter.MaxFilter(size))
    return np.asarray(im, dtype=np.float32) / 255.0


def _blend(rgb, mask, color, strength=1.0):
    a = (np.clip(mask, 0, 1) * strength)[..., None]
    col = np.array(color, dtype=np.float32) / 255.0
    return rgb * (1.0 - a) + col[None, None, :] * a


def resize_lanczos_img(im, size):
    return im.resize(size, Image.LANCZOS)


# ---------------------------------------------------------------------------
# 1) 头发：hair.png (256) / hair_s.png (512 球面高光)
# ---------------------------------------------------------------------------

HAIR_TARGET = "#ff9ec4"          # 动画立绘的 02 粉
HAIR_SAT_MUL = 2.35              # 饱和度倍数（原图 s≈0.16 -> 0.40 左右）
HAIR_HUE_PULL = 0.60             # 向目标粉色 hue 靠拢的比例
HAIR_TOP_GAIN = 1.12             # 纹理顶部（发根/头顶）亮度增益
HAIR_BOTTOM_GAIN = 0.86          # 纹理底部（发梢）亮度增益


def enhance_hair():
    im, rgb = load_rgb("hair.png")
    assert im.size == (256, 256), im.size
    # 先在 2x Lanczos 上做调色 + 锐化（Lanczos 放大 -> 锐化 -> 降采样，保留发丝细节）
    hi = resize_lanczos_img(im.convert("RGB"), (512, 512))
    arr = np.asarray(hi, dtype=np.float32) / 255.0
    h, s, v = rgb_to_hsv(arr)

    target_h = rgb_to_hsv(hex_rgb(HAIR_TARGET)[None, None, :])[0][0, 0]
    dh = ((target_h - h + 0.5) % 1.0) - 0.5
    h = (h + dh * HAIR_HUE_PULL) % 1.0
    s = np.clip(s * HAIR_SAT_MUL + 0.03, 0.0, 0.62)

    # 上亮下暗：纹理 V=0（上）对应发根/头顶，V=1（下）对应发梢，
    # hairgrad 验证过：上方贴图行渲染在头顶，下方渲染在发梢。
    vy = np.linspace(0.0, 1.0, 512, dtype=np.float32)[:, None]
    v = np.clip(v * (HAIR_TOP_GAIN + (HAIR_BOTTOM_GAIN - HAIR_TOP_GAIN) * vy), 0.0, 1.0)

    out = to_img(hsv_to_rgb(h, s, v))
    out = out.filter(ImageFilter.UnsharpMask(radius=2.4, percent=95, threshold=0))
    out_2x = out
    final = out_2x.resize((256, 256), Image.LANCZOS)
    final = final.filter(ImageFilter.UnsharpMask(radius=1.1, percent=55, threshold=0))
    save(out_2x, "2x/hair.png")
    p = save(final, "hair.png")
    return p


HAIR_S_TINT = "#ffb7d4"          # 球面高光染色（比 hair 略浅，避免过曝）
HAIR_S_BOOST = 2.0               # 以亮度重标定的高光强度（原图最亮约 47/255）
HAIR_S_TOP_GAIN = 1.20
HAIR_S_BOTTOM_GAIN = 0.92


def enhance_hair_s():
    im, rgb = load_rgb("hair_s.png")
    assert im.size == (512, 512), im.size
    hi = resize_lanczos_img(im.convert("RGB"), (1024, 1024))
    arr = np.asarray(hi, dtype=np.float32) / 255.0
    lum = arr.max(-1)  # 球面贴图是黑底 + 弧形高光，用最大通道当亮度
    # 染色 + 提亮：原来灰白高光 -> 动画粉色高光；黑底保持黑（add 混合时无副作用）
    tint = hex_rgb(HAIR_S_TINT)
    val = np.clip(lum * HAIR_S_BOOST, 0.0, 1.0)
    vy = np.linspace(0.0, 1.0, 1024, dtype=np.float32)[:, None]
    grad = HAIR_S_TOP_GAIN + (HAIR_S_BOTTOM_GAIN - HAIR_S_TOP_GAIN) * vy
    out = tint[None, None, :] * (val[..., None] * grad[..., None])
    im2 = to_img(out)
    im2 = im2.filter(ImageFilter.UnsharpMask(radius=1.6, percent=70, threshold=0))
    final = im2.resize((512, 512), Image.LANCZOS)
    save(im2, "2x/hair_s.png")
    p = save(final, "hair_s.png")
    return p


# ---------------------------------------------------------------------------
# 2) 脸：face.png (1024 RGBA, alpha 逐像素保留)
#     - 双颊柔和腮红（径向渐变）
#     - 外眼角 02 红色眼线（只重涂贴图里已有的睫毛/眼尾暗部，形状保持不变）
#     - 整体肤色加暖
# 坐标来源：用 lab 页把屏幕坐标反投影到 UV 后逐格验证（见 docs/02-TEXTURES.md）。
# ---------------------------------------------------------------------------

FACE_WARM = np.array([1.050, 1.012, 0.975], np.float32)
FACE_SAT_MUL = 1.04
FACE_VAL_MUL = 1.02

# 双颊（face.png 像素坐标，反投影验证过：分别渲染在左右脸颊）
BLUSH_CENTERS = [(173, 587), (470, 611)]
BLUSH_RADIUS = 190.0
BLUSH_PEAK = 0.30                # 低透明度，柔和
BLUSH_FALLOFF = 2.2              # 径向渐变的柔化指数（越大边缘越柔）
BLUSH_COLOR = np.array([255, 118, 158], np.float32) / 255.0

# 外眼角红色眼线：只作用于 face.png 里原有的睫毛暗部
EYE_LINE_BOX = (652, 108, 772, 202)     # x0,y0,x1,y1（验证：这条 UV 带映射到双眼外眼角）
EYE_LINE_COLOR = np.array([236, 18, 62], np.float32) / 255.0
EYE_LINE_STRENGTH = 0.88

# ---------------------------------------------------------------------------
# 第 2 轮：脸部细节精修（2026-11-13）
#   坐标全部由 lab 页「屏幕坐标 → UV 反投影」逐点校准（mmd-preview, ty=0.9&zoom=0.2）：
#   - 嘴部在 face.png 的 UV 条带：u≈9 为嘴中心（该条带左右镜像，u 越大离嘴中心越远），
#     嘴角约在 u≈86；v 向下增大：上唇 632-666 / 唇线 666-684（自带的唇线画在 668-679）/
#     下唇 684-718。
#   - 眼下皮肤 UV 区：u 90-245, v 470-522（双眼镜像共用同一块贴图，画一次两只眼都有）。
#   - 桌宠 mmd-char 管线里会露出的「下唇贴片」用 (190..320, 800..910) 的大嘴唇画。
#   - 眉毛卡片在 材質1（睫毛材质）的 (620..760, 0..70) UV 区，平时被刘海盖住。
# ---------------------------------------------------------------------------

V2_LIP_CENTER_U = 9.0
V2_LIP_HALF_U = 78.0
V2_UPPER_LIP = (654, 669)
V2_LOWER_LIP = (684, 699)
V2_LOWER_LIP_HL = (686, 697)
V2_LINE_BAND = (660, 684)
V2_LINE_COLOR = (126, 56, 70)
V2_LIP_CARD = (176, 790, 336, 922)       # x0,y0,x1,y1
V2_LIP_CARD_COLOR = (249, 172, 190)
V2_LIP_CARD_EDGE_COLOR = (206, 118, 136)
V2_EYE_U = (86, 258)
V2_EYE_SHADOW = (462, 494)
V2_EYE_HIGHLIGHT = (488, 522)
V2_EYE_TAIL = (510, 540)
V2_BROW_BOX = (586, 0, 792, 96)
V2_BROW_COLOR = (102, 58, 70)


def _refine_face_v2(rgb, alpha):
    """第 2 轮脸部精修：只改 RGB，alpha 完全不碰（调用方保留原 alpha）。"""
    H, W = alpha.shape
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    u, v = xx, yy
    lum = rgb.mean(-1)

    # ---- 1a) 嘴部（画在脸部皮肤 UV 条带上，镜像后左右对称）----
    lip_c = V2_LIP_CENTER_U
    half = np.clip((u - lip_c) / V2_LIP_HALF_U, 0.0, 1.0)          # 0=嘴中心 1=嘴角
    prof = np.sqrt(np.clip(1.0 - half * half, 0.0, 1.0))
    prof_hi = np.sqrt(np.clip(1.0 - np.clip((u - lip_c) / 38.0, 0.0, 1.0) ** 2, 0.0, 1.0))

    # 上唇阴影（唇线上方，很淡）
    up = prof * smoothstep(V2_UPPER_LIP[0], V2_UPPER_LIP[0] + 6, v) \
        * smoothstep(V2_UPPER_LIP[1], V2_UPPER_LIP[1] - 4, v) * 0.07
    rgb = _blend(rgb, _blur(up, 1.6), (200, 140, 152))
    # 下唇浅粉（唇线正下方小片）
    low = prof * smoothstep(V2_LOWER_LIP[0], V2_LOWER_LIP[0] + 4, v) \
        * smoothstep(V2_LOWER_LIP[1], V2_LOWER_LIP[1] - 4, v) * 0.11
    rgb = _blend(rgb, _blur(low, 1.8), (246, 168, 182))
    # 下唇高光（中央偏上，镜像后落在嘴唇中央）
    hl = prof_hi * smoothstep(V2_LOWER_LIP_HL[0], V2_LOWER_LIP_HL[0] + 4, v) \
        * smoothstep(V2_LOWER_LIP_HL[1], V2_LOWER_LIP_HL[1] - 4, v) * 0.10
    rgb = _blend(rgb, _blur(hl, 1.6), (255, 232, 235))
    # 下唇下缘细阴影，给唇一点体积
    edge = prof * smoothstep(V2_LOWER_LIP[1] - 5, V2_LOWER_LIP[1] - 1, v) \
        * smoothstep(V2_LOWER_LIP[1] + 4, V2_LOWER_LIP[1], v) * 0.09
    rgb = _blend(rgb, _blur(edge, 1.4), (186, 104, 120))
    # 嘴角阴影
    corner = smoothstep(64, 76, u) * smoothstep(96, 84, u) \
        * smoothstep(656, 664, v) * smoothstep(696, 686, v) * 0.06
    rgb = _blend(rgb, _blur(corner, 1.4), (182, 102, 118))
    # 唇线：重涂原有深色唇线像素（保持原有形状），略微加粗并加深
    line_mask = (lum < 0.78).astype(np.float32)
    region = smoothstep(0, 5, u) * smoothstep(80, 68, u) \
        * smoothstep(V2_LINE_BAND[0], V2_LINE_BAND[0] + 6, v) \
        * smoothstep(V2_LINE_BAND[1], V2_LINE_BAND[1] - 6, v)
    m = _dilate(line_mask * region, 3)
    m = _blur(m, 0.9)
    rgb = _blend(rgb, m, V2_LINE_COLOR, 0.80)

    # ---- 1b) 下唇贴片（mmd-char / 桌宠管线可见的大嘴唇画）----
    x0, y0, x1, y1 = V2_LIP_CARD
    lp = (smoothstep(x0 - 14, x0, u) * smoothstep(x1 + 16, x1 - 6, u)
          * smoothstep(y0 - 16, y0, v) * smoothstep(y1 + 16, y1 - 4, v))
    rgb = _blend(rgb, _blur(lp, 3.0), V2_LIP_CARD_COLOR, 0.42)
    lpe = (smoothstep(x0 - 14, x0, u) * smoothstep(x1 + 16, x1 - 6, u)
           * smoothstep(y1 - 56, y1 - 42, v) * smoothstep(y1 + 16, y1 - 6, v))
    rgb = _blend(rgb, _blur(lpe, 3.0), V2_LIP_CARD_EDGE_COLOR, 0.20)

    # ---- 2) 下眼睑 / 卧蚕（眼下皮肤 UV 区，很淡）----
    eu0, eu1 = V2_EYE_U
    eye_u = smoothstep(eu0 - 4, eu0 + 16, u) * smoothstep(eu1 + 14, eu1 - 8, u)
    shadow = eye_u * smoothstep(V2_EYE_SHADOW[0], V2_EYE_SHADOW[0] + 12, v) \
        * smoothstep(V2_EYE_SHADOW[1], V2_EYE_SHADOW[1] - 12, v) * 0.23
    rgb = _blend(rgb, _blur(shadow, 2.0), (212, 118, 132))
    high = eye_u * smoothstep(V2_EYE_HIGHLIGHT[0], V2_EYE_HIGHLIGHT[0] + 10, v) \
        * smoothstep(V2_EYE_HIGHLIGHT[1], V2_EYE_HIGHLIGHT[1] - 12, v) * 0.26
    rgb = _blend(rgb, _blur(high, 2.0), (255, 233, 228))
    tail = eye_u * smoothstep(V2_EYE_TAIL[0], V2_EYE_TAIL[0] + 10, v) \
        * smoothstep(V2_EYE_TAIL[1], V2_EYE_TAIL[1] - 12, v) * 0.10
    rgb = _blend(rgb, _blur(tail, 2.0), (214, 128, 140))

    # ---- 3) 眉毛：把睫毛材质上的眉毛卡片（深色）改成深粉棕，刘海下更通透 ----
    bx0, by0, bx1, by1 = V2_BROW_BOX
    mu = smoothstep(bx0 - 10, bx0 + 14, u) * smoothstep(bx1 + 20, bx1 - 16, u)
    mv = smoothstep(by0, by0 + 6, v) * smoothstep(by1 + 22, by1 - 20, v)
    bdark = smoothstep(0.62, 0.28, lum) * mu * mv
    bdark = _blur(bdark, 1.2)
    rgb = _blend(rgb, bdark, V2_BROW_COLOR, 0.68)

    return rgb


# ---------------------------------------------------------------------------
# 第 3 轮：动画感细节（2026-11-13）
#   - 刘海投影：额头/上眼睑区域的暖紫棕柔和阴影（动画里头发在脸上压出的层次）
#   - 上眼睑极淡眼影
#   - 鼻侧 / 鼻下极淡阴影，增加鼻梁体积感
#   坐标同样来自 lab 反投影校准：额头 UV 条带 u≈9 为脸中线（镜像），
#   发际线约 v≈215，眉/眼约 v≈340-370；鼻侧 u≈16-68, v≈500-614。
#   阴影最深处 ≤0.14（刘海）/ 0.08（上眼睑）/ 0.075（鼻侧），全部柔和渐变。
# ---------------------------------------------------------------------------

V3_BANG_COLOR = (152, 114, 122)          # 暖紫棕（刘海投影）
V3_BANG_ALPHA = 0.14                     # 刘海投影最大透明度（任务要求 0.06~0.14）
V3_LID_COLOR = (172, 122, 128)           # 上眼睑眼影（暖紫）
V3_LID_ALPHA = 0.08
V3_NOSE_COLOR = (168, 124, 118)          # 鼻侧阴影（暖棕）
V3_NOSE_ALPHA = 0.075
V3_UNDER_NOSE_COLOR = (172, 128, 120)    # 鼻底阴影
V3_UNDER_NOSE_ALPHA = 0.06


def _refine_face_v3(rgb, alpha):
    """第 3 轮动画感细节：只改 RGB，alpha 由调用方保留。"""
    H, W = alpha.shape
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    u, v = xx, yy

    # ---- 1) 刘海在额头/上眼睑的投影（暖紫棕，软边、带一点发绺起伏）----
    top_in = smoothstep(196, 232, v)                        # 发际线附近渐入
    # 眉/眼之前渐出（v≈372 以下就到眉毛/上眼睑，v≈400 是眼睛区，不能压过去）
    fade_end = 356.0 + 14.0 * np.sin(u * 0.09) + 6.0 * np.sin(u * 0.037 + 1.5)
    fade_out = 1.0 - smoothstep(fade_end - 44.0, fade_end, v)
    h_fade = smoothstep(2, 12, u) * (1.0 - smoothstep(180, 208, u))
    wobble = 0.86 + 0.14 * np.sin(u * 0.09 + 1.2)
    bang = V3_BANG_ALPHA * top_in * fade_out * h_fade * wobble
    rgb = _blend(rgb, _blur(bang, 3.0), V3_BANG_COLOR)

    # ---- 2) 上眼睑极淡眼影（补充刘海在眼睑上的一点点暖色）----
    # 上眼睑/眉骨一带（反投影验证：v 350-396 是眉毛/上眼睑，v≥400 会碰到眼睛卡片）
    lid = smoothstep(344, 360, v) * (1.0 - smoothstep(384, 398, v))
    h2 = smoothstep(86, 108, u) * (1.0 - smoothstep(280, 306, u))
    lid_a = V3_LID_ALPHA * lid * h2 * (0.9 + 0.1 * np.sin(u * 0.07 + 0.5))
    rgb = _blend(rgb, _blur(lid_a, 2.5), V3_LID_COLOR)

    # ---- 3) 鼻侧 / 鼻下柔和阴影（≤0.075，增加体积感）----
    side = (smoothstep(16, 30, u) * (1.0 - smoothstep(52, 68, u))
            * smoothstep(500, 520, v) * (1.0 - smoothstep(574, 600, v)))
    rgb = _blend(rgb, _blur(V3_NOSE_ALPHA * side, 2.2), V3_NOSE_COLOR)
    under = (smoothstep(9, 13, u) * (1.0 - smoothstep(40, 54, u))
             * smoothstep(564, 580, v) * (1.0 - smoothstep(596, 614, v)))
    rgb = _blend(rgb, _blur(V3_UNDER_NOSE_ALPHA * under, 2.0), V3_UNDER_NOSE_COLOR)
    return rgb


def build_face(round2=True, round3=True):
    """第 1 轮脸部增强（+ 第 2 轮精修 + 第 3 轮动画感细节），返回 RGBA Image，alpha 与源逐像素一致。"""
    src = Image.open(SRC / "face.png")
    assert src.size == (1024, 1024) and src.mode == "RGBA"
    alpha = src.getchannel("A")
    alpha_arr = np.asarray(alpha, dtype=np.float32) / 255.0
    rgb = np.asarray(src.convert("RGB"), dtype=np.float32) / 255.0

    # --- 肤色加暖 + 轻微通透感 ---
    rgb = np.clip(rgb * FACE_WARM[None, None, :], 0.0, 1.0)
    h, s, v = rgb_to_hsv(rgb)
    s = np.clip(s * FACE_SAT_MUL, 0.0, 1.0)
    v = np.clip(v * FACE_VAL_MUL, 0.0, 1.0)
    rgb = hsv_to_rgb(h, s, v)

    # --- 双颊柔和腮红（低透明度粉色径向渐变）---
    yy, xx = np.mgrid[0:1024, 0:1024]
    blush = np.zeros((1024, 1024), np.float32)
    for (cx, cy) in BLUSH_CENTERS:
        d = np.sqrt((xx - cx) ** 2.0 + (yy - cy) ** 2.0) / BLUSH_RADIUS
        blush = np.maximum(blush, np.clip(1.0 - d, 0.0, 1.0) ** BLUSH_FALLOFF)
    blush *= BLUSH_PEAK
    rgb = rgb * (1.0 - blush[..., None]) + BLUSH_COLOR[None, None, :] * blush[..., None]

    # --- 外眼角红色眼线 ---
    x0, y0, x1, y1 = EYE_LINE_BOX
    lum = rgb.mean(-1)
    dark = smoothstep(0.62, 0.18, lum)                       # 越暗（睫毛）越强
    ramp_x = smoothstep(x0, x0 + 46.0, xx) * smoothstep(x1, x1 - 10.0, xx)   # 从内到外渐强
    ramp_y = smoothstep(y0, y0 + 18.0, yy) * smoothstep(y1, y1 - 18.0, yy)
    stroke = dark * ramp_x * ramp_y * EYE_LINE_STRENGTH
    stroke = stroke * alpha_arr
    rgb = rgb * (1.0 - stroke[..., None]) + EYE_LINE_COLOR[None, None, :] * stroke[..., None]

    # --- 第 2 轮脸部精修（腮红/眼线之后叠加，形状都对齐现有美术）---
    if round2:
        rgb = _refine_face_v2(rgb, np.asarray(alpha, dtype=np.uint8))

    # --- 第 3 轮动画感细节：刘海投影 / 上眼睑眼影 / 鼻侧阴影 ---
    if round3:
        rgb = _refine_face_v3(rgb, np.asarray(alpha, dtype=np.uint8))

    out = to_img(rgb)
    out.putalpha(alpha)  # alpha 逐像素保留
    return out


def enhance_face(round2=True, round3=True):
    p = save(build_face(round2=round2, round3=round3), "face.png")
    return p


# ---------------------------------------------------------------------------
# 3) 身体 / 袜子：肤色更暖（R +4~5%，B -2~4%）
# ---------------------------------------------------------------------------

SKIN_WARM = np.array([1.045, 1.012, 0.975], np.float32)   # R+4.5% / B-2.5%，配合 sat 后实测 B≈-3%
SKIN_SAT_MUL = 1.03


def _warm_skin(rgb, mask=None):
    warm = np.clip(rgb * SKIN_WARM[None, None, :], 0.0, 1.0)
    if mask is None:
        rgb = warm
    else:
        m = mask[..., None]
        rgb = rgb * (1.0 - m) + warm * m
    h, s, v = rgb_to_hsv(rgb)
    s = np.clip(s * SKIN_SAT_MUL, 0.0, 1.0)
    return hsv_to_rgb(h, s, v)


def enhance_body():
    im, rgb = load_rgb("body.png")
    assert im.size == (1024, 1024) and im.mode == "RGB"
    out = to_img(_warm_skin(rgb))
    p = save(out, "body.png")
    return p


def enhance_socks():
    im, rgb = load_rgb("tex/socks.png")
    assert im.size == (1024, 1024) and im.mode == "RGB"
    lum = rgb.mean(-1)
    # 只暖肤色区域（左半边大腿皮肤），黑色/深色袜子保持原样
    mask = smoothstep(0.55, 0.72, lum)
    out = to_img(_warm_skin(rgb, mask))
    p = save(out, "tex/socks.png")
    return p


# ---------------------------------------------------------------------------
# 4) 红大衣：tex/aka.png (800) 提高红色饱和度 + 对比度
# ---------------------------------------------------------------------------

COAT_SAT_MUL = 1.34
COAT_VAL_MUL = 1.13
COAT_CONTRAST = 1.16             # 围绕中灰的 S 曲线强度


def enhance_coat():
    im, rgb = load_rgb("tex/aka.png")
    assert im.size == (800, 800) and im.mode == "RGB"
    h, s, v = rgb_to_hsv(rgb)
    s = np.clip(s * COAT_SAT_MUL, 0.0, 1.0)
    v = np.clip(v * COAT_VAL_MUL, 0.0, 1.0)
    v = np.clip(0.5 + (v - 0.5) * COAT_CONTRAST, 0.0, 1.0)
    out = to_img(hsv_to_rgb(h, s, v))
    p = save(out, "tex/aka.png")
    return p


# ---------------------------------------------------------------------------
# 第 2 轮可选项：发梢渐层（在现有 hair.png 上追加，不从源贴图重建）
#   说明：hair.png 已被并行的头发优化线更新（512x512，含发丝细节），本步骤在原图基础上
#   只对底部 22% 做「更浅 / 更透」的渐层，模拟动画发梢末端变浅；不改尺寸、不碰其它区域。
# ---------------------------------------------------------------------------

HAIR_TIP_START = 0.78            # 从图片高度的 78% 开始
HAIR_TIP_MAX = 0.42              # 底部最大混合强度
HAIR_TIP_TINT = (255, 206, 224)  # 更浅的粉，模拟半透明发梢


def enhance_hair_tips():
    p = OUT / "hair.png"
    before = Image.open(p).convert("RGB")
    arr = np.asarray(before, dtype=np.float32) / 255.0
    hgt = arr.shape[0]
    vy = np.linspace(0.0, 1.0, hgt, dtype=np.float32)[:, None]
    t = smoothstep(HAIR_TIP_START, 1.0, vy) * HAIR_TIP_MAX        # (H,1)
    h, s, v = rgb_to_hsv(arr)
    s2 = np.clip(s * (1.0 - 0.45 * t), 0.0, 1.0)                    # 降饱和 -> 更透
    v2 = np.clip(v * (1.0 + 0.10 * t), 0.0, 1.0)                    # 提亮
    out = hsv_to_rgb(h, s2, v2)
    tint = np.array(HAIR_TIP_TINT, np.float32) / 255.0
    out = out * (1.0 - t[..., None]) + tint[None, None, :] * t[..., None]
    after = to_img(out)
    after.save(p, "PNG")
    # before/after 对比图（底部 40% 放大）
    y0 = int(hgt * 0.60)
    cb = before.crop((0, y0, before.width, hgt))
    ca = after.crop((0, y0, after.width, hgt))
    scale = max(1, int(round(640 / max(1, cb.width))))
    cb = cb.resize((cb.width * scale, cb.height * scale), Image.LANCZOS)
    ca = ca.resize((ca.width * scale, ca.height * scale), Image.LANCZOS)
    sheet = Image.new("RGB", (cb.width * 2 + 30, cb.height + 70), (24, 24, 30))
    d = ImageDraw.Draw(sheet)
    _label(d, (14, 8), "hair.png 发梢渐层（第 2 轮可选项）：BEFORE -> AFTER（底部 40% 放大）", 19)
    _label(d, (10, 40), "BEFORE 发梢偏深/实", 15, (200, 200, 210))
    _label(d, (cb.width + 24, 40), "AFTER 发梢更浅/更透", 15, (255, 180, 205))
    sheet.paste(cb, (0, 64))
    sheet.paste(ca, (cb.width + 30, 64))
    dst = SHOTS / "tex2-hair-tips-compare.png"
    SHOTS.mkdir(exist_ok=True)
    sheet.save(dst)
    print(f"[hair-tips] {p.relative_to(ROOT)} 底部 {int((1 - HAIR_TIP_START) * 100)}% 已做浅色/透明渐层")
    print(f"[cmp] {dst.relative_to(ROOT)}")
    return p


# ---------------------------------------------------------------------------
# 第 3 轮可选项：eye1.png 高光强化（在现有 eye1.png 上原地增强）
#   背景：eye1.png 由并行的眼睛优化线生成（已有左上主高光 + 右下小点）。
#   本步骤只做“动画感”加成：左上主高光加大/加亮一点点，右下补一条很小的反光弧。
#   不改尺寸、不改 alpha 通道（逐像素保留），不进瞳孔。
#   幂等保护：manifest.json 里记录输入/输出 md5，重复运行自动跳过。
# ---------------------------------------------------------------------------

EYE_ANIM_META_KEY = "eye1_anim_round3"


def _file_md5(path):
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _read_manifest():
    p = OUT / "manifest.json"
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _write_manifest(manifest):
    (OUT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
                                       encoding="utf-8")


def _eye_metrics(im):
    w, h = im.size
    px = im.load()
    xs, ys = [], []
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a < 40:
                continue
            if (g > 60 and g > r + 20 and g > b - 40) or (r < 70 and g < 70 and b < 70):
                xs.append(x)
                ys.append(y)
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    return (x0 + x1) / 2.0, (y0 + y1) / 2.0, (x1 - x0) / 2.0, (y1 - y0) / 2.0


def enhance_eye_anim(force=False):
    """eye1.png 高光强化（原地），返回输出路径或 None（已增强/文件缺失）。"""
    import math
    from PIL import ImageDraw, ImageFilter

    p = OUT / "eye1.png"
    if not p.exists():
        print("[eye-anim] 跳过：还没有 eye1.png（由眼睛优化线提供）")
        return None
    src_md5 = _file_md5(p)
    manifest = _read_manifest()
    meta = manifest.get(EYE_ANIM_META_KEY) or {}
    if not force and src_md5 == meta.get("out_md5"):
        print("[eye-anim] 已是加强版（manifest 记录匹配），跳过；用 --eye-anim-force 强制重跑")
        return None

    src = Image.open(p).convert("RGBA")
    w, h = src.size
    alpha = src.getchannel("A")
    arr = np.array(src).astype(np.float32)
    rgb = arr[:, :, :3]
    cx, cy, rx, ry = _eye_metrics(src)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    nx = (xx - cx) / rx
    ny = (yy - cy) / ry
    d = np.sqrt(nx * nx + ny * ny)
    lum = rgb.mean(-1)

    # ---- 1) 左上主高光：外扩一圈柔光 + 核心提亮一点点 ----
    hx, hy = cx - rx * 0.41, cy - ry * 0.46
    ang = math.radians(-18)
    dx = (xx - hx) * math.cos(ang) + (yy - hy) * math.sin(ang)
    dy = -(xx - hx) * math.sin(ang) + (yy - hy) * math.cos(ang)
    erx, ery = rx * 0.27, ry * 0.42
    ell = np.clip(1.0 - np.sqrt((dx / erx) ** 2 + (dy / ery) ** 2), 0.0, 1.0)
    grow = 0.60 * ell ** 0.75 * (1.0 - smoothstep(0.40, 0.52, d))
    gim = Image.fromarray((np.clip(grow, 0, 1) * 255).astype(np.uint8), "L")
    gim = gim.filter(ImageFilter.GaussianBlur(2.2))
    ga = np.asarray(gim, dtype=np.float32) / 255.0
    white = np.array([255, 253, 250], np.float32)
    rgb = rgb * (1.0 - ga[..., None]) + white[None, None, :] * ga[..., None]
    core = (lum > 205) & (nx < -0.05) & (ny < -0.05) & (d > 0.3) & (d < 0.95)
    boost = np.where(core, 0.22, 0.0).astype(np.float32)
    rgb = rgb * (1.0 - boost[..., None]) + np.array([255, 255, 252], np.float32)[None, None, :] * boost[..., None]

    # ---- 2) 右下次级高光 / 反光条（沿虹膜右下方向的小弧）----
    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    dr = ImageDraw.Draw(layer)
    arc_rx, arc_ry = rx * 0.70, ry * 0.70
    bbox = [cx - arc_rx, cy - arc_ry, cx + arc_rx, cy + arc_ry]
    dr.arc(bbox, start=12, end=74, fill=(240, 255, 250, 175), width=max(3, int(rx * 0.06)))
    dot_x, dot_y = cx + rx * 0.39, cy + ry * 0.34
    dr.ellipse([dot_x - rx * 0.10, dot_y - ry * 0.075, dot_x + rx * 0.10, dot_y + ry * 0.075],
               fill=(255, 255, 255, 200))
    layer = layer.filter(ImageFilter.GaussianBlur(1.3))
    lay = np.array(layer).astype(np.float32)
    la = (lay[:, :, 3:4] / 255.0) * (((d > 0.42) & (d < 0.95))[..., None].astype(np.float32))
    rgb = rgb * (1.0 - la) + lay[:, :, :3] * la

    out = np.dstack([np.clip(rgb, 0, 255).astype(np.uint8), np.array(alpha)])
    after = Image.fromarray(out, "RGBA")
    after.save(p, "PNG")

    # ---- before/after 纹理对比图（虹膜局部 3x）----
    SHOTS.mkdir(exist_ok=True)
    box = (max(0, int(cx - rx * 1.35)), max(0, int(cy - ry * 1.30)),
           min(w, int(cx + rx * 1.35)), min(h, int(cy + ry * 1.30)))
    b = src.crop(box).convert("RGB")
    a2 = after.crop(box).convert("RGB")
    scale = 3
    b = b.resize((b.width * scale, b.height * scale), Image.LANCZOS)
    a2 = a2.resize((a2.width * scale, a2.height * scale), Image.LANCZOS)
    sheet = Image.new("RGB", (b.width + a2.width + 30, b.height + 96), (24, 24, 30))
    d2 = ImageDraw.Draw(sheet)
    _label(d2, (14, 10), "eye1.png 高光强化（第 3 轮）：主高光加大加亮 + 右下反光弧", 21)
    _label(d2, (14, 42), "瞳孔/虹膜形状不动，alpha 通道逐像素保留；仅叠加高光", 14, (190, 190, 200))
    _label(d2, (10, 66), "BEFORE", 15, (200, 200, 210))
    _label(d2, (b.width + 24, 66), "AFTER", 15, (255, 180, 205))
    sheet.paste(b, (0, 88))
    sheet.paste(a2, (b.width + 30, 88))
    dst = SHOTS / "tex3-eye-compare.png"
    sheet.save(dst)

    # ---- 记录 manifest（幂等）----
    manifest[EYE_ANIM_META_KEY] = {
        "input_md5": src_md5,
        "output_md5": _file_md5(p),
        "note": "左上主高光加大加亮 + 右下反光弧；alpha 不变；若眼睛线重新生成 eye1.png 需重跑 --eye-anim",
    }
    _write_manifest(manifest)
    print(f"[eye-anim] {p.relative_to(ROOT)} 已强化高光（alpha 不变；再次运行会跳过）")
    print(f"[cmp] {dst.relative_to(ROOT)}")
    return p


# ---------------------------------------------------------------------------
# 纹理级前后对比图（shots/tex-*.png）
# ---------------------------------------------------------------------------

FONT_PATHS = [
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
]


def _font(size):
    for fp in FONT_PATHS:
        if os.path.exists(fp):
            try:
                return ImageFont.truetype(fp, size)
            except Exception:
                continue
    return ImageFont.load_default()


def _label(draw, xy, text, size=20, fill=(255, 255, 255)):
    draw.text(xy, text, font=_font(size), fill=fill)


def _checker(size, step=24):
    bg = Image.new("RGB", size, (52, 52, 60))
    d = ImageDraw.Draw(bg)
    for y in range(0, size[1], step):
        for x in range(0, size[0], step):
            if (x // step + y // step) % 2 == 0:
                d.rectangle([x, y, x + step - 1, y + step - 1], fill=(74, 74, 84))
    return bg


def _open_pair(rel):
    before = Image.open(SRC / rel).convert("RGBA")
    after = Image.open(OUT / rel).convert("RGBA")
    return before, after


def _sheet_pair(rel, title, cell, out_name, note_before="", note_after="", crop=None):
    before, after = _open_pair(rel)
    if crop:
        before = before.crop(crop)
        after = after.crop(crop)
    cb = _checker(cell)
    ca = _checker(cell)
    cb.paste(before.convert("RGB").resize(cell, Image.LANCZOS), (0, 0))
    ca.paste(after.convert("RGB").resize(cell, Image.LANCZOS), (0, 0))
    W = cell[0] * 2 + 40
    H = cell[1] + 96
    sheet = Image.new("RGB", (W, H), (24, 24, 30))
    d = ImageDraw.Draw(sheet)
    _label(d, (16, 10), title, 24)
    _label(d, (16, 44), note_before or "BEFORE  " + rel, 16, (200, 200, 210))
    _label(d, (cell[0] + 36, 44), note_after or "AFTER  " + rel, 16, (255, 190, 210))
    sheet.paste(cb, (0, 78))
    sheet.paste(ca, (cell[0] + 20, 78))
    dst = SHOTS / out_name
    sheet.save(dst)
    return dst


def make_tex_comparisons():
    SHOTS.mkdir(exist_ok=True)
    made = []
    made.append(_sheet_pair("hair.png", "hair.png  (256x256) 粉色饱和 + 上亮下暗 + Lanczos 2x 锐化",
                            (512, 512), "tex-hair-compare.png",
                            "BEFORE  偏灰粉 / 发丝发糊", "AFTER  鲜艳粉 #ff9ec4 区间 / 上亮下暗"))
    made.append(_sheet_pair("hair_s.png", "hair_s.png  (512x512) 球面高光染色 + 提亮 + 2x 锐化",
                            (512, 512), "tex-hair-s-compare.png",
                            "BEFORE  近黑底 / 灰白高光", "AFTER  粉色高光（add 混合后头发有粉色反光）"))
    made.append(_sheet_pair("body.png", "body.png  (1024x1024) 肤色更暖  R+4.5% / B-3.5%",
                            (512, 512), "tex-skin-compare.png",
                            "BEFORE  冷调白皙", "AFTER  暖调肤色"))
    made.append(_sheet_pair("tex/socks.png", "tex/socks.png  (1024x1024) 肤色更暖（只作用于肤色，袜子不变）",
                            (512, 512), "tex-socks-compare.png",
                            "BEFORE  皮肤偏冷", "AFTER  皮肤更暖 / 深色袜子保持"))
    made.append(_sheet_pair("tex/aka.png", "tex/aka.png  (800x800) 红大衣：饱和度 + 对比度",
                            (512, 512), "tex-aka-compare.png",
                            "BEFORE  砖红偏灰", "AFTER  鲜红对比更强"))

    # 脸：整张 + 腮红/眼线局部放大
    before, after = _open_pair("face.png")
    W, H = 1240, 1180
    sheet = Image.new("RGB", (W, H), (24, 24, 30))
    d = ImageDraw.Draw(sheet)
    _label(d, (16, 10), "face.png  (1024x1024 RGBA, alpha 保持) 腮红 + 02 红色眼线 + 肤色加暖", 24)
    _label(d, (16, 46), "整张贴图对比（棋盘格=透明区域）", 15, (200, 200, 210))
    sb = _checker((480, 480)); sb.paste(before.convert("RGB").resize((480, 480), Image.LANCZOS), (0, 0))
    sa = _checker((480, 480)); sa.paste(after.convert("RGB").resize((480, 480), Image.LANCZOS), (0, 0))
    sheet.paste(sb, (16, 72)); sheet.paste(sa, (516, 72))
    _label(d, (16, 556), "BEFORE", 18, (200, 200, 210)); _label(d, (516, 556), "AFTER", 18, (255, 170, 200))
    # 腮红局部（每个中心 before/after 并排）
    _label(d, (16, 588), "腮红局部（face.png 坐标；渲染落在左右脸颊）", 17)
    for i, (bx, by) in enumerate(BLUSH_CENTERS):
        cbox = (bx - 110, by - 110, bx + 110, by + 110)
        cb = before.crop(cbox).convert("RGB").resize((220, 220), Image.LANCZOS)
        ca = after.crop(cbox).convert("RGB").resize((220, 220), Image.LANCZOS)
        x0 = 16 + i * 520
        sheet.paste(cb, (x0, 616)); sheet.paste(ca, (x0 + 236, 616))
        _label(d, (x0, 844), f"BEFORE 腮红{i + 1}", 14, (200, 200, 210))
        _label(d, (x0 + 236, 844), f"AFTER 腮红{i + 1}", 14, (255, 170, 200))
    # 红色眼线局部
    x0e, y0e, x1e, y1e = EYE_LINE_BOX
    pad = 30
    ebox = (x0e - pad, y0e - pad, x1e + pad, y1e + pad)
    eb = before.crop(ebox).convert("RGB").resize((220, 220), Image.LANCZOS)
    ea = after.crop(ebox).convert("RGB").resize((220, 220), Image.LANCZOS)
    _label(d, (16, 880), "外眼角红色眼线局部（face.png 睫毛 UV 区；只重涂原有睫毛暗部，形状不变）", 17)
    sheet.paste(eb, (16, 908)); sheet.paste(ea, (252, 908))
    _label(d, (16, 1136), "BEFORE", 14, (200, 200, 210)); _label(d, (252, 1136), "AFTER", 14, (255, 170, 200))
    p = SHOTS / "tex-face-compare.png"
    sheet.save(p)
    made.append(p)
    return made


# ---------------------------------------------------------------------------
# 第 2 轮脸部精修：纹理级 before/after 对比图（shots/tex2-*.png）
#   before = 第 1 轮输出（build_face(round2=False) 在内存中重建，可复现）
#   after  = 当前 models/final/mmd-tex/face.png
# ---------------------------------------------------------------------------

TEX2_ITEMS = [
    ("tex2-lips-compare.png", (0, 600, 148, 736), 4,
     "嘴唇：深一度唇线 + 上唇略深 + 下唇浅粉", "上唇/下唇均为低透明度渐变"),
    ("tex2-undereye-compare.png", (64, 440, 276, 560), 3,
     "下眼睑 / 卧蚕：眼下淡粉阴影 + 柔和提亮", "幅度很小，避免熊猫眼"),
    ("tex2-brow-compare.png", (566, 0, 806, 116), 3,
     "眉毛卡片：深色 -> 深粉棕（刘海下更通透）", "眉毛卡片在睫毛材质的 UV 区，平时被刘海盖住"),
    ("tex2-lipcard-compare.png", (164, 764, 356, 946), 3,
     "桌宠管线可见的下唇贴片：偏灰白 -> 动画浅粉", "保留原有高光/暗边结构"),
]


def _tex2_sheet(before, after, box, scale, title, note, out_name,
                before_label="BEFORE（第 1 轮）", after_label="AFTER（第 2 轮）"):
    b = before.crop(box).convert("RGB")
    a = after.crop(box).convert("RGB")
    b = b.resize((b.width * scale, b.height * scale), Image.LANCZOS)
    a = a.resize((a.width * scale, a.height * scale), Image.LANCZOS)
    W = b.width + a.width + 30
    H = max(b.height, a.height) + 96
    sheet = Image.new("RGB", (W, H), (24, 24, 30))
    d = ImageDraw.Draw(sheet)
    _label(d, (14, 10), title, 21)
    _label(d, (14, 42), note, 14, (190, 190, 200))
    _label(d, (10, 66), before_label, 15, (200, 200, 210))
    _label(d, (b.width + 24, 66), after_label, 15, (255, 180, 205))
    sheet.paste(b, (0, 88))
    sheet.paste(a, (b.width + 30, 88))
    dst = SHOTS / out_name
    SHOTS.mkdir(exist_ok=True)
    sheet.save(dst)
    return dst


def make_tex2_comparisons():
    SHOTS.mkdir(exist_ok=True)
    before = build_face(round2=False, round3=False)
    after = build_face(round2=True, round3=False)     # 稳定基线：第 2 轮（不含第 3 轮）
    # alpha 一致性提示（第 2 轮只改 RGB）
    same_alpha = np.array_equal(np.asarray(before.getchannel("A")), np.asarray(after.getchannel("A")))
    made = []
    for out_name, box, scale, title, note in TEX2_ITEMS:
        made.append(_tex2_sheet(before, after, box, scale, title, note, out_name))
    # 整张脸贴图对比
    made.append(_tex2_sheet(before, after, (0, 0, 1024, 1024), 1,
                            "face.png 整张对比（第 1 轮 -> 第 2 轮）",
                            "腮红/眼线/加暖保持，新增唇部、眼下、眉毛；alpha 未变" +
                            ("" if same_alpha else "（警告：alpha 不一致）"),
                            "tex2-face-texture-compare.png"))
    print(f"[verify] 第 2 轮 face.png alpha 与第 1 轮一致: {'OK' if same_alpha else 'FAIL'}")
    return made


# ---------------------------------------------------------------------------
# 第 3 轮：动画感细节的纹理级 before/after 对比图（shots/tex3-*.png）
#   before = 第 2 轮脸部（在内存中重建，可复现）
#   after  = 第 3 轮脸部（在内存中重建）
# ---------------------------------------------------------------------------

TEX3_ITEMS = [
    ("tex3-forehead-compare.png", (0, 190, 220, 410), 3,
     "刘海投影：额头/上眼睑的暖紫棕柔和阴影（≤0.14）",
     "阴影边界随发绺起伏、眉/眼之前渐出，不过界到眼睛",
     ("BEFORE（第 2 轮）", "AFTER（第 3 轮）")),
    ("tex3-lid-compare.png", (80, 295, 320, 405), 3,
     "上眼睑：极淡暖紫眼影（≤0.08）",
     "补一点“被刘海遮住”的暖色层次",
     ("BEFORE（第 2 轮）", "AFTER（第 3 轮）")),
    ("tex3-nose-compare.png", (0, 470, 120, 630), 4,
     "鼻侧 / 鼻下柔和阴影（≤0.075）",
     "增加鼻梁/鼻底体积感，幅度很小",
     ("BEFORE（第 2 轮）", "AFTER（第 3 轮）")),
]


def make_tex3_comparisons():
    SHOTS.mkdir(exist_ok=True)
    before = build_face(round2=True, round3=False)
    after = build_face(round2=True, round3=True)
    same_alpha = np.array_equal(np.asarray(before.getchannel("A")), np.asarray(after.getchannel("A")))
    made = []
    for out_name, box, scale, title, note, labels in TEX3_ITEMS:
        made.append(_tex2_sheet(before, after, box, scale, title, note, out_name,
                                labels[0], labels[1]))
    made.append(_tex2_sheet(before, after, (0, 0, 1024, 1024), 1,
                            "face.png 整张对比（第 2 轮 -> 第 3 轮）",
                            "第 1/2 轮效果保持；新增刘海投影/上眼睑眼影/鼻侧阴影；alpha 未变" +
                            ("" if same_alpha else "（警告：alpha 不一致）"),
                            "tex3-face-texture-compare.png",
                            "BEFORE（第 2 轮）", "AFTER（第 3 轮）"))
    print(f"[verify] 第 3 轮 face.png alpha 与第 2 轮一致: {'OK' if same_alpha else 'FAIL'}")
    return made


# ---------------------------------------------------------------------------
# 渲染对比图：读取 shots/tex-render-{before,after}-{front,face}.png
# ---------------------------------------------------------------------------

def make_render_comparisons():
    made = []

    def pair(before_name, after_name, out_name, title, extra=None):
        bp, ap = SHOTS / before_name, SHOTS / after_name
        if not (bp.exists() and ap.exists()):
            return None
        b = Image.open(bp).convert("RGB")
        a = Image.open(ap).convert("RGB")
        W = b.width + a.width + 30
        H = max(b.height, a.height) + 74
        sheet = Image.new("RGB", (W, H), (18, 18, 24))
        d = ImageDraw.Draw(sheet)
        _label(d, (14, 10), title, 22)
        _label(d, (10, 46), "BEFORE 原始贴图", 16, (200, 200, 210))
        _label(d, (b.width + 20, 46), "AFTER 增强贴图", 16, (255, 180, 205))
        sheet.paste(b, (0, 70))
        sheet.paste(a, (b.width + 30, 70))
        if extra:
            sheet = extra(sheet, d, b, a)
        dst = SHOTS / out_name
        sheet.save(dst)
        return dst

    p = pair("tex-render-before-front.png", "tex-render-after-front.png",
             "tex-render-compare-front.png", "全身正面 对比（480x860，lab/mmd-preview.html，同机位同光照）")
    if p:
        made.append(p)
    p = pair("tex-render-before-3q.png", "tex-render-after-3q.png",
             "tex-render-compare-3q.png", "全身 3/4 侧面 对比（480x860，lab/mmd-preview.html）")
    if p:
        made.append(p)
    p = pair("tex-render-before-face.png", "tex-render-after-face.png",
             "tex-render-compare-face.png", "脸部特写对比（700x800，lab/mmd-preview.html）")
    if p:
        made.append(p)
    # ---- 第 2 轮脸部精修渲染对比 ----
    p = pair("tex2-face-render-before.png", "tex2-face-render-after.png",
             "tex2-face-render-compare.png",
             "第 2 轮脸部精修 渲染对比（mmd-preview，700x800，ty=0.9&zoom=0.2）")
    if p:
        made.append(p)
    p = pair("tex2-char-render-before.png", "tex2-char-render-after.png",
             "tex2-char-render-compare.png",
             "第 2 轮脸部精修 桌宠管线渲染对比（lab/mmd-char.html，700x800）")
    if p:
        made.append(p)
    # ---- 第 3 轮动画感细节渲染对比 ----
    p = pair("tex3-char-render-before.png", "tex3-char-render-after.png",
             "tex3-char-render-compare.png",
             "第 3 轮 动画感细节：桌宠真实管线头部特写对比（lab/mmd-char.html，700x800，同机位）")
    if p:
        made.append(p)
    p = pair("tex3-face-render-before.png", "tex3-face-render-after.png",
             "tex3-face-render-compare.png",
             "第 3 轮 动画感细节：mmd-preview 头部特写对比（700x800）")
    if p:
        made.append(p)
    p = pair("tex3-eye-render-before.png", "tex3-eye-render-after.png",
             "tex3-eye-render-compare.png",
             "第 3 轮 眼睛高光：桌宠管线眼睛特写对比（lab/mmd-char.html，700x800，zoom=0.09）")
    if p:
        made.append(p)
    return made


# ---------------------------------------------------------------------------
# 输出校验：文件名 / 尺寸 / 模式 / alpha 与源贴图一致
# ---------------------------------------------------------------------------

EXPECTED = [
    ("hair.png", [(256, 256), (512, 512)], "RGB", False),
    ("hair_s.png", [(512, 512)], "RGB", False),
    ("face.png", [(1024, 1024)], "RGBA", True),
    ("body.png", [(1024, 1024)], "RGB", False),
    ("tex/socks.png", [(1024, 1024)], "RGB", False),
    ("tex/aka.png", [(800, 800)], "RGB", False),
]


def verify_outputs():
    ok = True
    for rel, sizes, mode, alpha_same in EXPECTED:
        src = Image.open(SRC / rel)
        dst_path = OUT / rel
        if not dst_path.exists():
            print(f"[verify] {rel:14s} SKIP（还没有输出；默认只重建 face.png，可用 --all 全量重建）")
            continue
        dst = Image.open(dst_path)
        checks = []
        checks.append(("size", dst.size in sizes))
        checks.append(("mode", dst.mode == mode))
        if alpha_same and "A" in src.getbands():
            a = np.asarray(src.getchannel("A"))
            b = np.asarray(dst.getchannel("A"))
            checks.append(("alpha", bool(np.array_equal(a, b))))
        good = all(v for _, v in checks)
        ok = ok and good
        detail = " ".join(f"{k}={'OK' if v else 'FAIL'}" for k, v in checks)
        print(f"[verify] {rel:14s} {dst.size} {dst.mode:4s} {detail}")
    if not ok:
        raise SystemExit("verify failed")
    print("[verify] face.png 的 alpha 与源贴图逐像素一致（第 1+2 轮全程不改 alpha）")


# ---------------------------------------------------------------------------
# 验证用临时模型目录：复制 TDA-ZeroTwo 并把增强贴图覆盖进去（不动原文件）
# ---------------------------------------------------------------------------

def stage_test_model():
    if TEST_MODEL_DIR.exists():
        shutil.rmtree(TEST_MODEL_DIR)
    shutil.copytree(SRC, TEST_MODEL_DIR)
    # 与 build.py 行为一致：models/final/mmd-tex/ 下所有文件按相对路径覆盖进验证目录
    # （不只本脚本产出的 6 张，也覆盖其它线新增的 eye1.png / accessories 等，保证和最终 assets 一致）
    n = 0
    for f in OUT.rglob("*"):
        if not f.is_file():
            continue
        rel = f.relative_to(OUT)
        dst = TEST_MODEL_DIR / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(f, dst)
        n += 1
    print(f"[stage] 覆盖增强/调色贴图 {n} 个文件")
    print(f"[stage] {TEST_MODEL_DIR.relative_to(ROOT)} 已生成（PMX + 全部贴图 + 增强贴图覆盖）")
    print(f"[stage] 预览: http://127.0.0.1:8899/lab/mmd-preview.html?base=/models/mmd/_tex-test/&file=ZeroTwo_TDA.pmx")


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", action="store_true", help="生成 models/mmd/_tex-test/ 验证目录")
    ap.add_argument("--render-compare", action="store_true", help="用已渲染截图拼渲染对比图")
    ap.add_argument("--only", default="", help="只跑部分：hair,hair_s,face,body,socks,coat")
    ap.add_argument("--all", action="store_true",
                    help="从源贴图重建全部 6 张并重出第 1 轮对比图（会覆盖 hair.png；默认只重建 face.png）")
    ap.add_argument("--no-v2", action="store_true", help="脸部只做第 1 轮增强（生成第 2 轮 before 基准用）")
    ap.add_argument("--no-v3", action="store_true",
                    help="脸部不做第 3 轮动画感细节（生成第 3 轮 before 基准用）")
    ap.add_argument("--hair-tips", action="store_true",
                    help="第 2 轮可选项：在现有 hair.png 上追加发梢浅色/透明渐层")
    ap.add_argument("--eye-anim", action="store_true",
                    help="第 3 轮：在现有 eye1.png 上强化主高光 + 补右下反光弧（已加强会自动跳过）")
    ap.add_argument("--eye-anim-force", action="store_true", help="强制重跑眼睛高光（忽略 manifest 记录）")
    args = ap.parse_args()

    OUT.mkdir(parents=True, exist_ok=True)
    only = set(x.strip() for x in args.only.split(",") if x.strip())
    jobs = [
        ("hair", enhance_hair),
        ("hair_s", enhance_hair_s),
        ("face", lambda: enhance_face(round2=not args.no_v2, round3=not args.no_v3)),
        ("body", enhance_body),
        ("socks", enhance_socks),
        ("coat", enhance_coat),
    ]
    all_keys = [k for k, _ in jobs]
    if args.all:
        print("[warn] --all 会从源贴图重建 hair.png（并行头发优化线更新过的版本会被覆盖）")
        keys = all_keys
    elif only:
        keys = [k for k in all_keys if k in only]
    else:
        # 第 3 轮默认：只重建 face.png（避免覆盖并行线更新的 hair.png / eye1.png）
        keys = ["face"]
        print("[info] 默认只重建 face.png（第 1+2+3 轮脸部）；眼睛高光: --eye-anim；"
              "全量: --all；发梢: --hair-tips")

    results = {}
    for key, fn in jobs:
        if key not in keys:
            continue
        p = fn()
        results[key] = str(p.relative_to(ROOT))
        print(f"[tex] {key:6s} -> {p.relative_to(ROOT)}  ({Image.open(p).size}, {Image.open(p).mode})")

    verify_outputs()
    if args.all:
        for p in make_tex_comparisons():
            print(f"[cmp] {p.relative_to(ROOT)}")
        (OUT / "manifest.json").write_text(json.dumps({
            "target": "DARLING in the FRANXX - 02 (TDA Zero Two)",
            "source": "models/mmd/TDA-ZeroTwo",
            "output": "models/final/mmd-tex",
            "textures": results,
            "notes": "文件名/尺寸/alpha 与原贴图一致；2x/ 下为 Lanczos 2x 锐化中间产物（可选）",
        }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if "face" in keys:
        for p in make_tex2_comparisons():
            print(f"[cmp] {p.relative_to(ROOT)}")
        if not args.no_v3:
            for p in make_tex3_comparisons():
                print(f"[cmp] {p.relative_to(ROOT)}")

    if args.hair_tips:
        enhance_hair_tips()
    if args.eye_anim or args.eye_anim_force:
        enhance_eye_anim(force=args.eye_anim_force)

    if args.stage:
        stage_test_model()
    if args.render_compare:
        for p in make_render_comparisons():
            print(f"[rcmp] {p.relative_to(ROOT)}")
    print("[done]")


if __name__ == "__main__":
    main()
