#!/usr/bin/env python3
"""增强 02 的眼睛贴图（eye1.png）：加虹膜层次 + 动画式高光。

原贴图是 300x300 的虹膜：青绿底色 + 黑瞳孔描边 + 右下角一个小高光。
动画里的 02 眼睛有明显的高光点（左上）和虹膜环状层次，这里离线补上。
输出：models/final/mmd-tex/eye1.png（build.py 会自动覆盖到插件 assets）
"""
import math
import pathlib
import sys

from PIL import Image, ImageDraw, ImageFilter

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "models" / "mmd" / "TDA-ZeroTwo" / "eye1.png"
OUT = ROOT / "models" / "final" / "mmd-tex" / "eye1.png"


def main():
    im = Image.open(SRC).convert("RGBA")
    w, h = im.size
    px = im.load()

    # 1) 找虹膜区域（青绿/深色像素）的包围盒
    xs, ys = [], []
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a < 40:
                continue
            if (g > 60 and g > r + 20 and g > b - 40) or (r < 70 and g < 70 and b < 70):
                xs.append(x)
                ys.append(y)
    if not xs:
        print("找不到虹膜区域，跳过")
        return 1
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
    rx, ry = (x1 - x0) / 2.0, (y1 - y0) / 2.0
    print("虹膜包围盒:", (x0, y0, x1, y1), "中心", (round(cx), round(cy)))

    # 2) 虹膜环状层次：外圈压暗，内圈提亮
    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    lp = layer.load()
    for y in range(max(0, y0), min(h, y1 + 1)):
        for x in range(max(0, x0), min(w, x1 + 1)):
            r, g, b, a = px[x, y]
            if a < 40:
                continue
            if not (g > 60 and g > r + 10):
                continue
            nx = (x - cx) / max(1.0, rx)
            ny = (y - cy) / max(1.0, ry)
            d = math.sqrt(nx * nx + ny * ny)  # 0 中心 -> 1 边缘
            if d > 1.05:
                continue
            # 外圈 0.86 压暗，靠中心 1.06 提亮，最中心瞳孔附近不动
            factor = 1.0
            if d > 0.62:
                factor = 0.86 + (1.0 - d) / 0.38 * 0.06
            elif d < 0.45:
                factor = 1.04
            if abs(factor - 1.0) < 0.005:
                continue
            nr = min(255, int(r * factor))
            ng = min(255, int(g * factor))
            nb = min(255, int(b * factor))
            lp[x, y] = (nr, ng, nb, int(a * 0.55))
    im = Image.alpha_composite(im, layer)

    # 3) 动画式高光：左上大椭圆 + 右下小点（保留原图已有小高光，叠加更亮的）
    hl = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(hl)
    hx = cx - rx * 0.34
    hy = cy - ry * 0.40
    hr_x, hr_y = max(2, rx * 0.19), max(3, ry * 0.25)
    d.ellipse(
        [hx - hr_x, hy - hr_y, hx + hr_x, hy + hr_y],
        fill=(255, 255, 255, 225),
    )
    # 第二颗小高光（右下方，偏青白）
    hx2 = cx + rx * 0.30
    hy2 = cy + ry * 0.30
    r2 = max(2, rx * 0.10)
    d.ellipse([hx2 - r2, hy2 - r2, hx2 + r2, hy2 + r2], fill=(235, 255, 250, 170))
    hl = hl.filter(ImageFilter.GaussianBlur(radius=max(0.8, rx * 0.022)))
    im = Image.alpha_composite(im, hl)

    # 4) 整体轻微提亮/加饱和（虹膜更"发光"）
    px2 = im.load()
    for y in range(h):
        for x in range(w):
            r, g, b, a = px2[x, y]
            if a < 40:
                continue
            # 只处理青绿区域（不动黑瞳孔/白高光）
            if g > 70 and g > r + 10 and b < g + 30:
                r = min(255, int(r * 1.02))
                g = min(255, int(g * 1.08))
                b = min(255, int(b * 1.04))
                px2[x, y] = (r, g, b, a)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    im.save(OUT)
    print("写出", OUT)
    return 0


if __name__ == "__main__":
    sys.exit(main())
