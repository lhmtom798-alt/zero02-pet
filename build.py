#!/usr/bin/env python3
"""把 src/ 组装成两个产物：

  1) zero02-pet/lib/client.js —— DSH 客户端插件（单文件，内联 three.js，无外部依赖）
  2) lab/bundle.js           —— 角色实验室（配合 /vendor/three.global.js 使用）

模块机制：极简 __def/__req（CommonJS 风格），各文件里可以正常写 module.exports。
2D 老引擎（skins2d/engine2d）保持"同作用域顺序拼接"，不改成模块，避免无谓重构。
"""
import json
import pathlib
import re
import shutil
import subprocess

ROOT = pathlib.Path(__file__).parent
PKG_ID = "zero02-pet"
VERSION = "4.81.0"
PKG_DESC = "02 桌宠 · 四个 3D 动漫形象（VRM 手办）+ 2D 立绘双形态，本地或云端模型"

# 顺序拼接的"老"代码（共享作用域）
RAW = [
    "src/client/00-prelude.js",
    "src/client/persona.js",
    "src/client/persona-extra.js",
    "src/client/skins2d.js",
    "src/client/voice.js",
    "src/client/engine2d.js",
]

# __def 模块：name -> 文件
MODULES = [
    ("kit", "src/3d/kit.js"),
    ("fig", "src/3d/fig.js"),
    ("fx", "src/3d/fx.js"),
    ("stage", "src/3d/stage.js"),
    ("vrmchar", "src/3d/vrmchar.js"),
    ("mmdchar", "src/3d/mmdchar.js"),
    ("mmd-shade", "src/3d/mmd-shade.js"),
    ("mmd-hair", "src/3d/mmd-hair.js"),
    ("chars.zerotwo", "src/3d/chars/zerotwo.js"),
    ("chars.zerotwo-tall", "src/3d/chars/zerotwo-tall.js"),
    ("chars.whale", "src/3d/chars/whale.js"),
    ("sfx", "src/3d/sfx.js"),
    ("vrm-style", "src/3d/vrm-style.js"),
    ("vrm-props", "src/3d/vrm-props.js"),
    ("vrm-look", "src/3d/vrm-look.js"),
    ("registry", "src/3d/registry.js"),
    ("pet3d", "src/3d/pet3d.js"),
]

BOOT_CLIENT = "src/client/90-boot.js"
BOOT_LAB = "src/lab/boot-lab.js"

import os as _os
NODE = _os.environ.get("NODE") or shutil.which("node") or "node"


def indent(text, n):
    pad = " " * n
    return "\n".join(pad + line if line.strip() else "" for line in text.split("\n"))


def registry_js():
    return """
var __REG = Object.create(null), __CACHE = Object.create(null);
function __def(name, fn) { __REG[name] = fn; }
function __req(name) {
  if (__CACHE[name]) return __CACHE[name].exports;
  var fn = __REG[name];
  if (!fn) throw new Error("模块未定义: " + name + "（可用: " + Object.keys(__REG).join(",") + "）");
  var mod = { exports: {} };
  __CACHE[name] = mod;
  try { fn(mod, mod.exports, __req); } catch (e) { delete __CACHE[name]; throw e; }
  return mod.exports;
}
"""


def read(rel):
    path = ROOT / rel
    if not path.exists():
        return f"/* [build] 缺失文件 {rel} */"
    return path.read_text()


def modules_js():
    out = []
    for name, rel in MODULES:
        code = read(rel)
        wrapped = (
            f"\n/* ==================== module: {name}  ({rel}) ==================== */\n"
            f'__def("{name}", function (module, exports, require) {{\n"use strict";\n'
            + indent(code, 2)
            + "\n});\n"
        )
        out.append(wrapped)
    return "".join(out)


def raw_js():
    parts = []
    for rel in RAW:
        parts.append(f"\n/* ==================== raw: {rel} ==================== */\n" + read(rel) + "\n")
    return "".join(parts)


def three_js():
    return "\n/* ============ vendor: three.js r166 + @pixiv/three-vrm 3.5.5 (MIT) ============ */\n" + read("vendor/three-vrm.global.js") + "\n"


PING_JS = """
function _z02ping(note) {
  try {
    fetch("/api/__ID__/ping?ver=" + BUILD + "&note=" + encodeURIComponent(String(note || "")).slice(0, 220), { cache: "no-store" }).catch(function () {});
  } catch (e) {}
}
try { _z02ping("materialized"); } catch (e) {}
try {
  window.addEventListener("error", function (ev) {
    _z02ping("ERR " + (ev.message || "?") + " @" + String(ev.filename || "").slice(-40) + ":" + (ev.lineno || 0));
  });
  window.addEventListener("unhandledrejection", function (ev) {
    _z02ping("REJECT " + ((ev.reason && ev.reason.message) || ev.reason || "?"));
  });
} catch (e) {}
"""


def build_client():
    host = read("_host-template.js").replace("__ID__", PKG_ID)
    client = f"""/**
 * {PKG_ID} —— {PKG_DESC}
 * 单文件客户端：three.js 内联 + 四形象 2D/3D + 气泡聊天 + 设置面板。
 * 对话经宿主 /api/{PKG_ID}/chat 转发到用户配置的 OpenAI 兼容端点。
 */
window.__ModuleLoader__.load({{
  id: "{PKG_ID}",
  factory: function (require) {{
    var module = {{ exports: {{}} }};
    var BUILD = "{VERSION}";
{PING_JS}
{registry_js()}
{indent(three_js(), 4)}
{raw_js()}
{modules_js()}
{indent(read(BOOT_CLIENT), 4)}

    module.exports.apply = function () {{}};
    module.exports.inject = ["slots"];
    return module.exports;
  }}
}});
"""
    lib = ROOT / PKG_ID / "lib"
    lib.mkdir(parents=True, exist_ok=True)
    (lib / "client.js").write_text(client)
    (lib / "index.js").write_text(host)
    return len(client)


def build_lab():
    bundle = f"""/* 自动生成：角色实验室（勿手改，改 src/ 后重跑 build.py） */
(function () {{
"use strict";
{registry_js()}
{modules_js()}
{read(BOOT_LAB)}
}})();
"""
    lab = ROOT / "lab"
    lab.mkdir(parents=True, exist_ok=True)
    (lab / "bundle.js").write_text(bundle)
    return len(bundle)


PKG_EXTRA = ["locale", "docs", "icon.svg"]


def copy_extra():
    pkg_dir = ROOT / PKG_ID
    for name in PKG_EXTRA:
        src = ROOT / "pkg" / name
        dst = pkg_dir / name
        if src.is_dir():
            if dst.exists():
                shutil.rmtree(dst)
            shutil.copytree(src, dst)
        elif src.exists():
            shutil.copy2(src, dst)
    for license_name in ("THREE-LICENSE.txt", "THREE-VRM-LICENSE.txt"):
        shutil.copy2(ROOT / "vendor" / license_name, pkg_dir / "docs" / license_name)


def write_assets():
    pkg_dir = ROOT / PKG_ID
    assets = pkg_dir / "assets"
    assets.mkdir(parents=True, exist_ok=True)
    for f in (ROOT / "_assets").iterdir():
        if f.is_file() and f.name != "README.md":
            shutil.copy2(f, assets / f.name)
    # 3D 角色的 VRM 模型（离线改色后的成品）
    model_dir = assets / "models"
    if model_dir.exists():
        shutil.rmtree(model_dir)
    model_dir.mkdir(parents=True, exist_ok=True)
    final = ROOT / "models" / "final"
    n_models = 0
    if final.is_dir():
        for f in final.glob("*.vrm"):
            shutil.copy2(f, model_dir / f.name)
            n_models += 1
    # MMD 角色（02）：PMX + 贴图整套
    mmd_src = ROOT / "models" / "mmd" / "TDA-ZeroTwo"
    mmd_dst = assets / "mmd" / "TDA-ZeroTwo"
    if mmd_src.is_dir():
        if mmd_dst.exists():
            shutil.rmtree(mmd_dst)
        mmd_dst.mkdir(parents=True, exist_ok=True)
        pmx_final = ROOT / "models" / "final" / "ZeroTwo_TDA.pmx"
        shutil.copy2(pmx_final if pmx_final.exists() else (mmd_src / "ZeroTwo_TDA.pmx"), mmd_dst / "ZeroTwo_TDA.pmx")
        for sub in ("tex", "toon", "sph", "tga"):
            if (mmd_src / sub).is_dir():
                shutil.copytree(mmd_src / sub, mmd_dst / sub)
        for f in list(mmd_src.glob("*.png")) + list(mmd_src.glob("*.bmp")) + list(mmd_src.glob("*.tga")):
            shutil.copy2(f, mmd_dst / f.name)
        # 增强贴图（可选）：models/final/mmd-tex/ 里的同名文件覆盖原贴图
        tex_final = ROOT / "models" / "final" / "mmd-tex"
        if tex_final.is_dir():
            n_tex = 0
            for f in tex_final.rglob("*"):
                if not f.is_file():
                    continue
                rel = f.relative_to(tex_final)
                dst = mmd_dst / rel
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(f, dst)
                n_tex += 1
            print("  + 增强贴图", n_tex, "张")
        n_models += 1
    # MMD 备选：Darling02（游戏风 02）—— 骨架修复版 PMX + 可选换色贴图
    # 只在 models/final/Darling02_fixed.pmx 或 models/final/darling-tex 存在时生效，不影响 TDA。
    darling_src = ROOT / "models" / "mmd" / "Darling02"
    darling_pmx = ROOT / "models" / "final" / "Darling02_fixed.pmx"
    tex_darling = ROOT / "models" / "final" / "darling-tex"
    if darling_src.is_dir() and (darling_pmx.exists() or tex_darling.is_dir()):
        darling_dst = assets / "mmd" / "Darling02"
        if darling_dst.exists():
            shutil.rmtree(darling_dst)
        darling_dst.mkdir(parents=True, exist_ok=True)
        if (darling_src / "tex").is_dir():
            shutil.copytree(darling_src / "tex", darling_dst / "tex")
        shutil.copy2(darling_pmx if darling_pmx.exists() else (darling_src / "ZeroTwo_GameStyle.pmx"),
                     darling_dst / "Darling02_fixed.pmx")
        # 换色贴图（可选）：models/final/darling-tex/ 里的同名文件覆盖原贴图
        if tex_darling.is_dir():
            n_tex = 0
            for f in tex_darling.rglob("*"):
                if not f.is_file() or f.name == "manifest.json":
                    continue  # manifest 只是换色脚本的记录，不是贴图，不进包
                rel = f.relative_to(tex_darling)
                dst = darling_dst / rel
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(f, dst)
                n_tex += 1
            print("  + Darling02 换色贴图", n_tex, "张")
        n_models += 1
    return len(list(assets.iterdir())) + n_models


def write_manifest():
    pkg_dir = ROOT / PKG_ID
    pkg = {
        "name": PKG_ID,
        "version": VERSION,
        "private": True,
        "description": PKG_DESC,
        "type": "module",
        "main": "lib/index.js",
        "exports": {
            ".": {"default": "./lib/index.js"},
            "./client": {"default": "./lib/client.js"},
            "./assets/*": "./assets/*",
            "./locale/*.json": "./locale/*.json",
            "./icon": "./icon.svg",
            "./docs/*": "./docs/*",
            "./cordis.patch.yml": "./cordis.patch.yml",
            "./package.json": "./package.json",
        },
        "files": ["lib", "assets", "locale", "docs", "icon.svg", "cordis.patch.yml", "package.json"],
        "dsh": {"bundle": {"patch": "./cordis.patch.yml"}, "client": {"platform": "web", "inject": ["slots"]}},
        "license": "MIT",
    }
    (pkg_dir / "package.json").write_text(json.dumps(pkg, ensure_ascii=False, indent=2) + "\n")
    (pkg_dir / "cordis.patch.yml").write_text(
        "# 把桌宠挂到 profile 组合上（零侵入）\n"
        "- insert:\n"
        f"    - id: {PKG_ID}\n"
        f"      name: {PKG_ID}\n"
    )


def check_syntax(path):
    if not pathlib.Path(NODE).exists():
        return
    result = subprocess.run([NODE, "--check", str(path)], capture_output=True, text=True)
    if result.returncode != 0:
        raise SystemExit(f"语法错误 {path}:\n{result.stderr[:4000]}")


def main():
    size = build_client()
    lab_size = build_lab()
    n = write_assets()
    copy_extra()
    write_manifest()
    check_syntax(ROOT / PKG_ID / "lib" / "client.js")
    check_syntax(ROOT / "lab" / "bundle.js")
    print(f"built v{VERSION}: client.js {size:,} B / lab {lab_size:,} B / assets {n}")


if __name__ == "__main__":
    main()
