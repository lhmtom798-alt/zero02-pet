#!/usr/bin/env python3
"""把四个 3D 角色的透明底截图拼成插件详情页 / README 用的预览图。

依赖：tools/shot.mjs 先在 lab 里渲染透明底单人图（shots/char-<id>.png），
然后本脚本裁边、按脚底对齐、加柔和背光，输出：
  docs/preview.png          README 用大图（透明底）
  pkg/docs/preview.svg      插件详情页用（640×300，内嵌 PNG base64）
"""
import base64
import io
import pathlib
import subprocess

from PIL import Image, ImageDraw, ImageFilter

ROOT = pathlib.Path(__file__).resolve().parent.parent
NODE = "~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node"
CHARS = [("chibi", "Q版"), ("whale", "鲸鲸"), ("onee", "御姐"), ("genki", "元气")]


def shot(char):
    out = ROOT / "shots" / f"char-{char}.png"
    subprocess.run(
        [NODE, "tools/shot.mjs",
         "--url", f"http://127.0.0.1:8899/lab/?char={char}&mode=single&bg=transparent",
         "--out", str(out), "--size", "640x860", "--wait", "800",
         "--transparent", "--ready", "window.__LAB_READY"],
        cwd=ROOT, check=True, capture_output=True,
    )
    return out


def trim(im):
    bbox = im.getchannel("A").getbbox()
    return im.crop(bbox) if bbox else im


def fit_height(im, h):
    w = int(im.width * h / im.height)
    return im.resize((w, h), Image.LANCZOS)


def build(char_images, width, height, gap, bottom_pad):
    canvas = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    # 背光：每个角色后面一团柔和的粉色光
    glow = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    d = ImageDraw.Draw(glow)
    col = [(255, 150, 185, 90), (120, 190, 255, 90), (255, 150, 185, 80), (255, 170, 130, 80)]
    total_w = sum(im.width for im in char_images) + gap * (len(char_images) - 1)
    scale = min(1.0, (width - 60) / total_w)
    cur = (width - total_w * scale) / 2
    for i, im in enumerate(char_images):
        w = im.width * scale
        h = im.height * scale
        x = cur
        y = height - bottom_pad - h
        d.ellipse([x + w * 0.12, y + h * 0.18, x + w * 0.88, y + h * 0.95], fill=col[i % 4])
        cur += w + gap * scale
    glow = glow.filter(ImageFilter.GaussianBlur(28))
    canvas = Image.alpha_composite(canvas, glow)

    cur = (width - total_w * scale) / 2
    for im in char_images:
        w = int(im.width * scale)
        h = int(im.height * scale)
        x = int(cur)
        y = int(height - bottom_pad - h)
        canvas.alpha_composite(im.resize((w, h), Image.LANCZOS), (x, y))
        cur += w + gap * scale
    return canvas


def main():
    for name, _ in CHARS:
        shot(name)
    images = [trim(Image.open(ROOT / "shots" / f"char-{name}.png").convert("RGBA")) for name, _ in CHARS]

    # README 大图：高 520，角色高 ~420
    big = build([fit_height(im, 420) for im in images], 1200, 520, 48, 60)
    (ROOT / "docs").mkdir(exist_ok=True)
    big.save(ROOT / "docs" / "preview.png")

    # 详情页：640×300，角色高 ~236
    small = build([fit_height(im, 236) for im in images], 640, 300, 14, 26)
    buf = io.BytesIO()
    small.save(buf, format="PNG", optimize=True)
    b64 = base64.b64encode(buf.getvalue()).decode()
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="300" viewBox="0 0 640 300">\n'
        f'  <image width="640" height="300" href="data:image/png;base64,{b64}"/>\n'
        "</svg>\n"
    )
    out = ROOT / "pkg" / "docs" / "preview.svg"
    out.write_text(svg)
    print(f"wrote docs/preview.png ({big.width}x{big.height}) and {out} ({len(svg)//1024} KB)")


if __name__ == "__main__":
    main()
