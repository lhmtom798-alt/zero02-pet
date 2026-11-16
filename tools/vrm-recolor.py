#!/usr/bin/env python3
"""离线改造 VRM：按材质重绘贴图（换发色 / 衣服染色 / 瞳色 / 配饰色），并可选压缩贴图。

产物是新的 .vrm，运行时直接加载，不需要任何 shader 魔法。

用法：
  python3 tools/vrm-recolor.py in.vrm out.vrm --preset onee
  python3 tools/vrm-recolor.py in.vrm out.vrm --preset onee --max-tex 512
"""
import argparse
import io
import json
import struct

import numpy as np
from PIL import Image


# ---------------------------------------------------------------- GLB 读写
def read_glb(path):
    raw = open(path, "rb").read()
    magic, version, length = struct.unpack_from("<4sII", raw, 0)
    assert magic == b"glTF", "不是 GLB"
    off = 12
    js = None
    bin_data = b""
    while off < length:
        clen, ctype = struct.unpack_from("<II", raw, off)
        data = raw[off + 8: off + 8 + clen]
        if ctype == 0x4E4F534A:
            js = json.loads(data.decode("utf-8").rstrip("\x00 "))
        elif ctype == 0x004E4942:
            bin_data = data
        off += 8 + clen
    return js, bytearray(bin_data)


def write_glb(js, bin_data, path):
    js_bytes = json.dumps(js, separators=(",", ":")).encode("utf-8")
    js_bytes += b" " * ((4 - len(js_bytes) % 4) % 4)
    bin_bytes = bytes(bin_data) + b"\x00" * ((4 - len(bin_data) % 4) % 4)
    total = 12 + 8 + len(js_bytes) + 8 + len(bin_bytes)
    out = bytearray()
    out += struct.pack("<4sII", b"glTF", 2, total)
    out += struct.pack("<II", len(js_bytes), 0x4E4F534A) + js_bytes
    out += struct.pack("<II", len(bin_bytes), 0x004E4942) + bin_bytes
    open(path, "wb").write(out)


# ---------------------------------------------------------------- 图像操作
def to_hsl(rgb):
    """rgb: float array (...,3) in 0..1 -> h(0..1), s(0..1), l(0..1)"""
    mx = rgb.max(axis=-1)
    mn = rgb.min(axis=-1)
    l = (mx + mn) / 2
    d = mx - mn
    s = np.where(l > 0.5, d / np.maximum(1e-6, 2 - mx - mn), d / np.maximum(1e-6, mx + mn))
    s = np.where(d < 1e-6, 0, s)
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    h = np.zeros_like(l)
    mask = d > 1e-6
    idx = (mx == r) & mask
    h[idx] = ((g[idx] - b[idx]) / d[idx]) % 6
    idx = (mx == g) & mask
    h[idx] = (b[idx] - r[idx]) / d[idx] + 2
    idx = (mx == b) & mask
    h[idx] = (r[idx] - g[idx]) / d[idx] + 4
    h = h / 6
    return h, s, l


def from_hsl(h, s, l):
    def hue2rgb(p, q, t):
        t = np.mod(t, 1.0)
        out = np.where(t < 1 / 6, p + (q - p) * 6 * t,
              np.where(t < 1 / 2, q,
              np.where(t < 2 / 3, p + (q - p) * (2 / 3 - t) * 6, p)))
        return out
    q = np.where(l < 0.5, l * (1 + s), l + s - l * s)
    p = 2 * l - q
    return np.stack([hue2rgb(p, q, h + 1 / 3), hue2rgb(p, q, h), hue2rgb(p, q, h - 1 / 3)], axis=-1)


def gradient_map(l, stops):
    """把亮度映射成颜色：stops = [(pos, (r,g,b)), ...]"""
    out = np.zeros(l.shape + (3,), dtype=np.float32)
    for i in range(len(stops) - 1):
        p0, c0 = stops[i]
        p1, c1 = stops[i + 1]
        m = (l >= p0) & (l <= p1)
        t = np.clip((l[m] - p0) / max(1e-6, p1 - p0), 0, 1)[..., None]
        out[m] = np.array(c0, dtype=np.float32) * (1 - t) + np.array(c1, dtype=np.float32) * t
    out[l < stops[0][0]] = stops[0][1]
    out[l > stops[-1][0]] = stops[-1][1]
    return out


def recolor_image(img, rule):
    """rule: {mode: 'gradient'|'hue'|'tint', ...}"""
    arr = np.asarray(img.convert("RGB"), dtype=np.float32) / 255.0
    if rule["mode"] == "gradient":
        h, s, l = to_hsl(arr)
        # 灰度化求"明度"，再按明度映射到目标色阶
        lum = arr @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
        lum = np.clip(lum, 0, 1) ** rule.get("gamma", 1.0)
        col = gradient_map(lum, rule["stops"])
        return Image.fromarray((np.clip(col, 0, 1) * 255).astype(np.uint8), "RGB")
    if rule["mode"] == "hue":
        h, s, l = to_hsl(arr)
        h = np.full_like(h, rule.get("hue", 0.0)) if rule.get("forceHue", True) else np.mod(h + rule.get("hue", 0.0), 1)
        s = np.clip(s * rule.get("satMul", 1.0), 0, 1)
        l = np.clip(l * rule.get("lumMul", 1.0) + rule.get("lift", 0.0), 0, 1)
        return Image.fromarray((np.clip(from_hsl(h, s, l), 0, 1) * 255).astype(np.uint8), "RGB")
    if rule["mode"] == "selective":  # 只改满足条件的像素（例如只把深色衣服染红、保留白衬衫）
        h, s, l = to_hsl(arr)
        target = from_hsl(np.full_like(h, rule.get("hue", 0.0)), np.clip(s * rule.get("satMul", 1.0) + rule.get("satAdd", 0.0), 0, 1),
                          np.clip(l * rule.get("lumMul", 1.0) + rule.get("lift", 0.0), 0, 1))
        lo, hi = rule.get("lumRange", [0.0, 1.0])
        m = (l >= lo) & (l <= hi)
        out = arr.copy()
        out[m] = target[m]
        return Image.fromarray((np.clip(out, 0, 1) * 255).astype(np.uint8), "RGB")
    return img.convert("RGB")



def hair_rule(stops, gamma=0.62):
    return {"mode": "gradient", "gamma": gamma,
            "set": {"baseColorFactor": [1, 1, 1, 1], "unlit_remove_emissive": 1},
            "vrmColor": [1, 1, 1, 1],
            "vrmShadeColor": [0.83, 0.60, 0.70, 1],
            "vrmEmissive": [0, 0, 0],
            "vrmOutlineWidth": 0.010,
            "stops": stops}

def cloth_rule(hue, satMul=3.2, lumRange=(0.0, 0.58), lumMul=1.0):
    return {"mode": "selective", "hue": hue, "satMul": satMul, "satAdd": 0.35,
            "lumMul": lumMul, "lift": 0.02, "lumRange": list(lumRange),
            "vrmColor": [1, 1, 1, 1]}

def bright_rule(hue=0.0, satMul=0.15, lumMul=1.1):
    return {"mode": "hue", "hue": hue, "satMul": satMul, "lumMul": lumMul, "lift": 0.0,
            "vrmColor": [1, 1, 1, 1]}

PINK_STOPS = [(0.0, (0.42, 0.10, 0.22)), (0.40, (0.86, 0.36, 0.58)), (0.78, (1.0, 0.64, 0.80)), (1.0, (1.0, 0.90, 0.95))]
LIGHT_PINK_STOPS = [(0.0, (0.55, 0.16, 0.30)), (0.40, (0.95, 0.48, 0.66)), (0.80, (1.0, 0.72, 0.86)), (1.0, (1.0, 0.94, 0.97))]
BLUE_STOPS = [(0.0, (0.06, 0.10, 0.30)), (0.40, (0.18, 0.34, 0.66)), (0.78, (0.38, 0.62, 0.92)), (1.0, (0.72, 0.88, 1.0))]

# ---------------------------------------------------------------- 预设
PRESETS = {
    # 02 · 御姐：粉长直 + 红大衣 + 青绿瞳 + 橙领结
    "onee": {
        "materials": {
            "HairBack": {"mode": "gradient", "gamma": 0.62, "set": {"baseColorFactor": [1, 1, 1, 1], "unlit_remove_emissive": 1}, "vrmColor": [1, 1, 1, 1], "vrmShadeColor": [0.86, 0.62, 0.72, 1], "vrmEmissive": [0, 0, 0], "vrmOutlineWidth": 0.012, "stops": [(0.0, (0.42, 0.10, 0.22)), (0.40, (0.86, 0.36, 0.58)), (0.78, (1.0, 0.64, 0.80)), (1.0, (1.0, 0.90, 0.95))]},
            "Hair_00_HAIR": {"mode": "gradient", "gamma": 0.62, "set": {"baseColorFactor": [1, 1, 1, 1], "unlit_remove_emissive": 1}, "vrmColor": [1, 1, 1, 1], "vrmShadeColor": [0.86, 0.62, 0.72, 1], "vrmEmissive": [0, 0, 0], "vrmOutlineWidth": 0.012, "stops": [(0.0, (0.42, 0.10, 0.22)), (0.40, (0.86, 0.36, 0.58)), (0.78, (1.0, 0.64, 0.80)), (1.0, (1.0, 0.90, 0.95))]},
            "Hair_00_HAIR_02": {"mode": "gradient", "gamma": 0.62, "set": {"baseColorFactor": [1, 1, 1, 1], "unlit_remove_emissive": 1}, "vrmColor": [1, 1, 1, 1], "vrmShadeColor": [0.86, 0.62, 0.72, 1], "vrmEmissive": [0, 0, 0], "vrmOutlineWidth": 0.012, "stops": [(0.0, (0.42, 0.10, 0.22)), (0.40, (0.86, 0.36, 0.58)), (0.78, (1.0, 0.64, 0.80)), (1.0, (1.0, 0.90, 0.95))]},
            "Tops_01_CLOTH": {"mode": "selective", "hue": 0.985, "satMul": 3.2, "satAdd": 0.35, "lumMul": 1.0, "lift": 0.02, "lumRange": [0.0, 0.55]},
            "Bottoms_01_CLOTH": {"mode": "selective", "hue": 0.985, "satMul": 3.2, "satAdd": 0.35, "lumMul": 1.05, "lift": 0.02, "lumRange": [0.0, 0.6]},
            "Shoes_01_CLOTH": {"mode": "hue", "hue": 0.0, "satMul": 0.2, "lumMul": 0.72, "lift": 0.0},
            "AccessoryNeck_01_CLOTH": {"mode": "hue", "hue": 0.07, "satMul": 2.4, "lumMul": 1.1, "lift": 0.05, "vrmColor": [1, 1, 1, 1]},
            "EyeIris": {"mode": "hue", "hue": 0.44, "satMul": 1.5, "lumMul": 1.05, "vrmColor": [1, 1, 1, 1]},
        }
    }
}



PRESETS["genki"] = {
    "materials": {
        "HairBack": hair_rule(LIGHT_PINK_STOPS),
        "Hair_00_HAIR": hair_rule(LIGHT_PINK_STOPS),
        "Hair_00_HAIR_02": hair_rule(LIGHT_PINK_STOPS),
        "Hair_00_HAIR_03": hair_rule(LIGHT_PINK_STOPS),
        "Hair_00_HAIR_04": hair_rule(LIGHT_PINK_STOPS),
        "Tops_01_CLOTH": cloth_rule(0.985),
        "Bottoms_01_CLOTH": cloth_rule(0.985),
        "Shoes_01_CLOTH": bright_rule(0.0, 0.1, 0.85),
        "AccessoryNeck_01_CLOTH": {"mode": "hue", "hue": 0.07, "satMul": 2.4, "lumMul": 1.1, "lift": 0.05, "vrmColor": [1, 1, 1, 1]},
        "EyeIris": {"mode": "hue", "hue": 0.44, "satMul": 1.5, "lumMul": 1.05, "vrmColor": [1, 1, 1, 1]},
    }
}

PRESETS["chibi"] = {
    "materials": {
        "Hair_00_HAIR": hair_rule(PINK_STOPS),
        "Hair_00_HAIR_02": hair_rule(PINK_STOPS),
        "Hair_00_HAIR_03": hair_rule(PINK_STOPS),
        "Hair_00_HAIR_04": hair_rule(PINK_STOPS),
        "Tops_01_CLOTH": {"mode": "hue", "hue": 0.985, "satMul": 1.8, "satAdd": 0.72, "lumMul": 0.52, "lift": 0.0, "vrmColor": [1, 1, 1, 1]},
        "Shoes_01_CLOTH": bright_rule(0.0, 0.08, 1.05),
        "EyeIris": {"mode": "hue", "hue": 0.44, "satMul": 1.6, "lumMul": 1.05, "vrmColor": [1, 1, 1, 1]},
    }
}

PRESETS["whalemaid"] = {
    "materials": {
        "Hair_00_HAIR": hair_rule(BLUE_STOPS, gamma=0.55),
        "Hair_00_HAIR_02": hair_rule(BLUE_STOPS, gamma=0.55),
        "Hair_00_HAIR_03": hair_rule(BLUE_STOPS, gamma=0.55),
        "Hair_00_HAIR_04": hair_rule(BLUE_STOPS, gamma=0.55),
        "Tops_01_CLOTH": {"mode": "hue", "hue": 0.58, "satMul": 1.3, "satAdd": 0.26, "lumMul": 0.80, "lift": 0.0, "vrmColor": [1, 1, 1, 1]},
        "Shoes_01_CLOTH": bright_rule(0.58, 0.1, 1.0),
        "EyeIris": {"mode": "hue", "hue": 0.58, "satMul": 1.7, "lumMul": 1.05, "vrmColor": [1, 1, 1, 1]},
    }
}

PRESETS["whale"] = {
    "materials": {
        "HairBack": hair_rule(BLUE_STOPS, gamma=0.55),
        "Hair_00_HAIR": hair_rule(BLUE_STOPS, gamma=0.55),
        "Hair_00_HAIR_02": hair_rule(BLUE_STOPS, gamma=0.55),
        "Hair_00_HAIR_03": hair_rule(BLUE_STOPS, gamma=0.55),
        "Hair_00_HAIR_04": hair_rule(BLUE_STOPS, gamma=0.55),
        "Tops_01_CLOTH": {"mode": "hue", "hue": 0.58, "satMul": 0.45, "satAdd": 0.18, "lumMul": 1.25, "lift": 0.08, "vrmColor": [1, 1, 1, 1]},
        "Shoes_01_CLOTH": bright_rule(0.58, 0.12, 1.0),
        "EyeIris": {"mode": "hue", "hue": 0.58, "satMul": 1.6, "lumMul": 1.1, "vrmColor": [1, 1, 1, 1]},
    }
}

PRESETS["chibi_b"] = {
    "materials": {
        "Hair_00_HAIR": hair_rule(PINK_STOPS, gamma=0.6),
        "Hair_00_HAIR_02": hair_rule(PINK_STOPS, gamma=0.6),
        "Hair_00_HAIR_03": hair_rule(PINK_STOPS, gamma=0.6),
        "Hair_00_HAIR_04": hair_rule(PINK_STOPS, gamma=0.6),
        "Hair_00_HAIR_05": hair_rule(PINK_STOPS, gamma=0.6),
        "Hair_00_HAIR_06": hair_rule(PINK_STOPS, gamma=0.6),
        "Tops_01_CLOTH": {"mode": "hue", "hue": 0.985, "satMul": 2.2, "satAdd": 0.6, "lumMul": 0.9, "lift": 0.02, "vrmColor": [1, 1, 1, 1]},
        "Bottoms_01_CLOTH": {"mode": "hue", "hue": 0.985, "satMul": 2.2, "satAdd": 0.5, "lumMul": 0.85, "lift": 0.02, "vrmColor": [1, 1, 1, 1]},
        "Shoes_01_CLOTH": bright_rule(0.0, 0.1, 1.0),
        "EyeIris": {"mode": "hue", "hue": 0.44, "satMul": 1.6, "lumMul": 1.05, "vrmColor": [1, 1, 1, 1]},
    }
}

PRESETS["whale_v"] = {
    "materials": {
        "HairBack": hair_rule(BLUE_STOPS, gamma=0.55),
        "Hair_00_HAIR": hair_rule(BLUE_STOPS, gamma=0.55),
        "Hair_00_HAIR_02": hair_rule(BLUE_STOPS, gamma=0.55),
        "Hair_00_HAIR_03": hair_rule(BLUE_STOPS, gamma=0.55),
        "Tops_01_CLOTH": {"mode": "hue", "hue": 0.58, "satMul": 0.5, "satAdd": 0.16, "lumMul": 1.1, "lift": 0.06, "vrmColor": [1, 1, 1, 1]},
        "Shoes_01_CLOTH": bright_rule(0.58, 0.1, 1.0),
        "EyeIris": {"mode": "hue", "hue": 0.58, "satMul": 1.7, "lumMul": 1.1, "vrmColor": [1, 1, 1, 1]},
    }
}

# ---- VRM1 成品模型（osakura：粉发水手服，可再分发/署名）----
OSAKURA_HAIR = [(0.0, (0.44, 0.10, 0.24)), (0.42, (0.90, 0.38, 0.62)), (0.80, (1.0, 0.68, 0.84)), (1.0, (1.0, 0.93, 0.97))]
OSAKURA_HAIR_LIGHT = [(0.0, (0.52, 0.14, 0.30)), (0.42, (0.96, 0.50, 0.70)), (0.80, (1.0, 0.76, 0.88)), (1.0, (1.0, 0.96, 0.98))]

PRESETS["osakura_onee"] = {
    "materials": {
        "Hair_00_HAIR": {"mode": "gradient", "gamma": 0.7, "stops": OSAKURA_HAIR,
                          "set": {"baseColorFactor": [1, 1, 1, 1]}},
        "Tops_01_CLOTH": {"mode": "selective", "hue": 0.985, "satMul": 1.6, "satAdd": 0.62,
                           "lumMul": 0.58, "lift": 0.0, "lumRange": [0.55, 1.0],
                           "set": {"baseColorFactor": [1, 1, 1, 1]}},
        "Bottoms_01_CLOTH": {"mode": "hue", "hue": 0.985, "satMul": 2.4, "satAdd": 0.45,
                              "lumMul": 0.62, "lift": 0.02, "set": {"baseColorFactor": [1, 1, 1, 1]}},
        "Shoes_01_CLOTH": {"mode": "hue", "hue": 0.0, "satMul": 0.15, "lumMul": 1.08, "lift": 0.0,
                            "set": {"baseColorFactor": [1, 1, 1, 1]}},
        "EyeIris": {"mode": "hue", "hue": 0.44, "satMul": 1.35, "lumMul": 1.0,
                     "set": {"baseColorFactor": [1, 1, 1, 1]}},
    }
}

PRESETS["osakura_genki"] = {
    "materials": {
        "Hair_00_HAIR": {"mode": "gradient", "gamma": 0.72, "stops": OSAKURA_HAIR_LIGHT,
                          "set": {"baseColorFactor": [1, 1, 1, 1]}},
        "Tops_01_CLOTH": {"mode": "selective", "hue": 0.985, "satMul": 1.5, "satAdd": 0.55,
                           "lumMul": 0.64, "lift": 0.0, "lumRange": [0.55, 1.0],
                           "set": {"baseColorFactor": [1, 1, 1, 1]}},
        "Bottoms_01_CLOTH": {"mode": "hue", "hue": 0.985, "satMul": 2.2, "satAdd": 0.42,
                              "lumMul": 0.66, "lift": 0.02, "set": {"baseColorFactor": [1, 1, 1, 1]}},
        "Shoes_01_CLOTH": {"mode": "hue", "hue": 0.0, "satMul": 0.15, "lumMul": 1.1, "lift": 0.0,
                            "set": {"baseColorFactor": [1, 1, 1, 1]}},
        "EyeIris": {"mode": "hue", "hue": 0.44, "satMul": 1.4, "lumMul": 1.0,
                     "set": {"baseColorFactor": [1, 1, 1, 1]}},
    }
}

def find_base_color_image(js, mat_index):
    """返回该材质 baseColorTexture 对应的 images 下标"""
    mat = js["materials"][mat_index]
    tex_idx = None
    pbr = mat.get("pbrMetallicRoughness", {})
    if "baseColorTexture" in pbr:
        tex_idx = pbr["baseColorTexture"]["index"]
    else:
        for v in mat.get("extensions", {}).values():
            if isinstance(v, dict) and "baseColorTexture" in v:
                tex_idx = v["baseColorTexture"]["index"]
                break
    if tex_idx is None:
        return None
    tex = js["textures"][tex_idx]
    return tex.get("source")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--preset", required=True)
    ap.add_argument("--max-tex", type=int, default=0, help="把所有贴图压到不超过该边长（0=不压）")
    args = ap.parse_args()

    preset = PRESETS[args.preset]
    js, bin_data = read_glb(args.src)
    views = js["bufferViews"]
    images = js.get("images", [])

    # VRM0 的 MToon 颜色不在 glTF material 里，而在 extensions.VRM.materialProperties
    vrm_mats = {}
    vrm_ext = js.get("extensions", {}).get("VRM", {})
    for mp in vrm_ext.get("materialProperties", []):
        vrm_mats[mp.get("name", "")] = mp

    def patch_vrm_mat(name, rule):
        mp = vrm_mats.get(name)
        if not mp:
            return
        vp = mp.setdefault("vectorProperties", {})
        fp = mp.setdefault("floatProperties", {})
        if "vrmColor" in rule:
            vp["_Color"] = rule["vrmColor"]
        if "vrmShadeColor" in rule:
            vp["_ShadeColor"] = rule["vrmShadeColor"]
        if "vrmEmissive" in rule:
            vp["_EmissiveColor"] = rule["vrmEmissive"]
        if "vrmOutlineWidth" in rule:
            fp["_OutlineWidth"] = rule["vrmOutlineWidth"]
            fp["_OutlineWidthMode"] = rule.get("vrmOutlineMode", 1)
        if "vrmShadeShift" in rule:
            fp["_ShadeShift"] = rule["vrmShadeShift"]
        if "vrmShadeToony" in rule:
            fp["_ShadeToony"] = rule["vrmShadeToony"]

    matched = []
    for mi, mat in enumerate(js.get("materials", [])):
        name = mat.get("name", "")
        for key, rule in preset["materials"].items():
            if key in name:
                if "set" in rule:
                    for mk, mv in rule["set"].items():
                        if mk == "baseColorFactor" and "pbrMetallicRoughness" in mat:
                            mat["pbrMetallicRoughness"]["baseColorFactor"] = mv
                        elif mk == "emissiveFactor":
                            mat["emissiveFactor"] = mv
                        elif mk == "unlit_remove_emissive":
                            mat.pop("emissiveTexture", None)
                            mat["emissiveFactor"] = [0, 0, 0]
                        else:
                            mat[mk] = mv
                patch_vrm_mat(name, rule)
                img_idx = find_base_color_image(js, mi)
                if img_idx is not None:
                    matched.append((name, img_idx, rule))
                break
    print(f"匹配到 {len(matched)} 个材质：")
    for name, idx, rule in matched:
        print(f"  {name:36s} -> image {idx:02d} ({rule['mode']})")

    # 逐图重绘（同一张图被多个材质引用时只处理一次）
    done = {}
    for name, idx, rule in matched:
        if idx in done:
            continue
        done[idx] = rule
    for idx, rule in done.items():
        v = views[images[idx]["bufferView"]]
        start = v.get("byteOffset", 0)
        blob = bytes(bin_data[start:start + v["byteLength"]])
        img = Image.open(io.BytesIO(blob))
        if args.max_tex:
            if max(img.size) > args.max_tex:
                img = img.copy()
                img.thumbnail((args.max_tex, args.max_tex), Image.LANCZOS)
        out = recolor_image(img, rule)
        buf = io.BytesIO()
        out.save(buf, format="PNG", optimize=True)
        png = buf.getvalue()
        if len(png) > v["byteLength"]:
            print(f"  ! image {idx} 变大 {len(png)}>{v['byteLength']}，跳过压缩优化")
        print(f"  image {idx:02d}: {img.size} -> {len(png)/1024:.0f}KB")
        v["byteLength"] = len(png)
        images[idx]["mimeType"] = "image/png"
        # 先把旧数据占位，最后统一重建 BIN
        v["_newData"] = png

    # 未改动的图也一起压缩尺寸（可选）
    if args.max_tex:
        for idx, img_def in enumerate(images):
            if idx in done:
                continue
            v = views[img_def["bufferView"]]
            if v.get("_newData"):
                continue
            start = v.get("byteOffset", 0)
            blob = bytes(bin_data[start:start + v["byteLength"]])
            try:
                img = Image.open(io.BytesIO(blob))
            except Exception:
                continue
            if max(img.size) <= args.max_tex:
                continue
            img = img.copy()
            img.thumbnail((args.max_tex, args.max_tex), Image.LANCZOS)
            buf = io.BytesIO()
            if img_def.get("mimeType") == "image/jpeg":
                img.save(buf, format="JPEG", quality=92)
            else:
                img.save(buf, format="PNG", optimize=True)
            data = buf.getvalue()
            v["byteLength"] = len(data)
            v["_newData"] = data

    # 重建 BIN：复用原来的 bufferViews 排布顺序（只允许同 buffer 0）
    new_bin = bytearray()
    for v in views:
        data = v.pop("_newData", None)
        if data is None:
            start = v.get("byteOffset", 0)
            data = bytes(bin_data[start:start + v["byteLength"]])
        # 4 字节对齐
        pad = (4 - len(new_bin) % 4) % 4
        new_bin += b"\x00" * pad
        v["byteOffset"] = len(new_bin)
        v["byteLength"] = len(data)
        new_bin += data
    js["buffers"] = [{"byteLength": len(new_bin)}]
    write_glb(js, new_bin, args.dst)
    import os
    print(f"\n写出 {args.dst}  ({os.path.getsize(args.dst)/1048576:.1f} MB)")


if __name__ == "__main__":
    main()
