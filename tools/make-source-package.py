#!/usr/bin/env python3
"""生成可直接发到 GitHub 的干净源码包（不含任何版权素材/构建产物/截图）。

    python3 tools/make-source-package.py

产物：
  dist/zero02-pet-<version>-source.tar.gz
  dist/zero02-pet-<version>-source.zip
"""
import pathlib
import re
import shutil
import tarfile
import tempfile
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
PKG_ID = "zero02-pet"

# 只打包这些（相对仓库根）
INCLUDE_FILES = [
    "README.md", "CHANGELOG.md", "LICENSE", "ASSETS.md", ".gitignore",
    "build.py", "_host-template.js", "preview/index.html",
]
INCLUDE_DIRS = ["src", "tools", "docs", "pkg", "lab", "vendor"]

# 这些子路径/文件不打包
EXCLUDE_PATTERNS = [
    "tools/__pycache__", "tools/hunt", "lab/bundle.js", "pkg/docs/preview.svg",
    "vendor/vrm-src", "vendor/three.module.min.js",
    "docs/*.png",  # 截图里含角色形象，公开由发布者自行决定
]
EXCLUDE_SUFFIX = (".pyc", ".DS_Store", ".log")

# 文本文件里需要清洗的绝对路径/本机信息
SANITIZE = [
    (re.compile(r"/Users/[A-Za-z0-9._-]+/Documents/deepseek-harness/default-workspace/dsh-pets"), "."),
    (re.compile(r"/Users/[A-Za-z0-9._-]+/\.dsh/dsh-runtimes/[^\"'\\s)]*?/node"), "node"),
    (re.compile(r"/Users/[A-Za-z0-9._-]+"), "~"),
]
TEXT_SUFFIX = (".js", ".mjs", ".cjs", ".py", ".md", ".json", ".html", ".yml",
               ".yaml", ".sh", ".txt", ".svg", ".gitignore", "")


def version():
    m = re.search(r'VERSION\s*=\s*"([^"]+)"', (ROOT / "build.py").read_text())
    return m.group(1) if m else "0.0.0"


def excluded(rel: str) -> bool:
    rel = rel.replace("\\", "/")
    for p in EXCLUDE_PATTERNS:
        p = p.replace("\\", "/")
        if rel == p or rel.startswith(p.rstrip("/") + "/"):
            return True
        if pathlib.PurePosixPath(rel).match(p):
            return True
    return rel.endswith(EXCLUDE_SUFFIX)


def sanitize_text(path: pathlib.Path):
    try:
        if path.suffix not in TEXT_SUFFIX and path.name != ".gitignore":
            return
        text = path.read_text(errors="ignore")
        out = text
        for pat, repl in SANITIZE:
            out = pat.sub(repl, out)
        if out != text:
            path.write_text(out)
    except Exception as e:
        print("  ! sanitize skip", path, e)


def copy_tree(src_dir: pathlib.Path, dst_dir: pathlib.Path, rel_base: str):
    for item in src_dir.rglob("*"):
        rel = item.relative_to(src_dir)
        rel_str = str(pathlib.PurePosixPath(rel_base) / pathlib.PurePosixPath(str(rel)))
        if excluded(rel_str):
            continue
        target = dst_dir / rel
        if item.is_dir():
            target.mkdir(parents=True, exist_ok=True)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(item, target)
            sanitize_text(target)


def build_stage(stage: pathlib.Path):
    stage.mkdir(parents=True, exist_ok=True)

    for name in INCLUDE_FILES:
        src = ROOT / name
        if src.exists():
            target = stage / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, target)
            sanitize_text(target)

    for name in INCLUDE_DIRS:
        src = ROOT / name
        if not src.is_dir():
            continue
        copy_tree(src, stage / name, name)

    # 素材占位说明（不含任何素材本体）
    (stage / "models").mkdir(exist_ok=True)
    (stage / "_assets").mkdir(exist_ok=True)
    for pair in (("models", "models/README.md"), ("_assets", "_assets/README.md")):
        src = ROOT / pair[1]
        if src.exists():
            shutil.copy2(src, stage / pair[0] / "README.md")
            sanitize_text(stage / pair[0] / "README.md")

    # 根 .gitignore 兜底（防止发布者本地误提交素材）
    gitignore = stage / ".gitignore"
    if not gitignore.exists():
        shutil.copy2(ROOT / ".gitignore", gitignore)


def verify(stage: pathlib.Path):
    problems = []
    text_hits = []
    total = 0
    for item in stage.rglob("*"):
        if not item.is_file():
            continue
        total += 1
        rel = item.relative_to(stage)
        if rel.suffix in (".pmx", ".vrm", ".webp", ".png", ".jpg", ".bmp", ".tga", ".wasm"):
            problems.append(f"发现素材/二进制文件: {rel}")
        if item.stat().st_size > 3 * 1024 * 1024:
            problems.append(f"异常大文件: {rel} ({item.stat().st_size // 1024} KB)")
        if rel.suffix in TEXT_SUFFIX or item.name == ".gitignore":
            txt = item.read_text(errors="ignore")
            if str(pathlib.Path.home()) in txt:
                text_hits.append(str(rel))
            if rel.suffix == ".svg" and re.search(r"<(?:[\w.-]+:)?image\b|data:image/", txt, re.IGNORECASE):
                problems.append(f"发现引用或嵌入图片的 SVG: {rel}")
    if text_hits:
        problems.append("仍含本机绝对路径: " + ", ".join(text_hits[:8]))
    return total, problems


def make_archives(stage: pathlib.Path, version_str: str):
    out_dir = ROOT / "dist"
    out_dir.mkdir(exist_ok=True)
    base = f"{PKG_ID}-{version_str}-source"
    tgz = out_dir / f"{base}.tar.gz"
    zip_path = out_dir / f"{base}.zip"

    with tarfile.open(tgz, "w:gz") as tar:
        tar.add(stage, arcname=base)
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for item in stage.rglob("*"):
            if item.is_file():
                zf.write(item, arcname=str(pathlib.PurePosixPath(base) / item.relative_to(stage)))
    return tgz, zip_path


def main():
    v = version()
    with tempfile.TemporaryDirectory() as tmp:
        stage = pathlib.Path(tmp) / f"{PKG_ID}-{v}-source"
        build_stage(stage)
        total, problems = verify(stage)
        print(f"源码包 v{v}：{total} 个文件")
        if problems:
            raise SystemExit("源码包检查失败：\n  - " + "\n  - ".join(problems))
        print("检查通过：无素材/二进制、无本机绝对路径、无超大文件")
        tgz, zip_path = make_archives(stage, v)
        print(f"打包完成：\n  {tgz}（{tgz.stat().st_size // 1024} KB）\n  {zip_path}（{zip_path.stat().st_size // 1024} KB）")


if __name__ == "__main__":
    main()
