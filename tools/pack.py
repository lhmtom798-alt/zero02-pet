#!/usr/bin/env python3
"""把 zero02-pet/ 打成 npm 风格 tarball（package/ 前缀），供 DSH 插件管理器安装。"""
import json
import pathlib
import shutil
import tarfile
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
PKG = "zero02-pet"


def main():
    src = ROOT / PKG
    manifest = json.loads((src / "package.json").read_text())
    version = manifest["version"]
    out = ROOT / "dist" / f"{PKG}-{version}.tgz"
    out.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory() as tmp:
        stage = pathlib.Path(tmp) / "package"
        for name in manifest.get("files", ["lib", "assets", "package.json", "cordis.patch.yml"]):
            target = stage / name
            target.parent.mkdir(parents=True, exist_ok=True)
            s = src / name
            if s.is_dir():
                shutil.copytree(s, target)
            elif s.exists():
                shutil.copy2(s, target)
        with tarfile.open(out, "w:gz") as tar:
            tar.add(stage, arcname="package")

    print(f"packed {out} ({(out.stat().st_size / 1024):.0f} KB)")
    return out


if __name__ == "__main__":
    main()
