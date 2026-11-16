#!/usr/bin/env python3
"""Darling02 骨架修复验收：在「桌宠真实渲染管线」里摆骨骼，量探针骨骼的世界坐标位移。

为什么不是"看截图差不多"：
  parentIndex 修错的典型症状是「转 A 骨，B 骨不动 / 无关部位跟着动」。用世界坐标做量化断言，
  比目测可靠，而且能直接给出「修复前 vs 修复后」的对照数字。

做法
----
lab/mmd-char.html 会把指定骨骼的世界坐标写进 window.__LAB.probe（?probe=骨名1,骨名2）；
本脚本对每个用例调用 tools/shot.mjs 打开页面（冻结在 t 秒的待机姿势），
再用 --info 读回 probe，算每个骨骼相对 baseline 的位移 |Δ|。

用法
----
  python3 tools/darling-verify.py                    # 同时验修复后 + 原始乱序版
  python3 tools/darling-verify.py --target fixed     # 只验修复后
  python3 tools/darling-verify.py --shots            # 额外保存摆姿势截图到 shots/darling-pose-*.png
"""
import argparse
import json
import pathlib
import subprocess
import sys
import urllib.parse

ROOT = pathlib.Path(__file__).resolve().parent.parent
NODE = "~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node"
SHOT = ROOT / "tools" / "shot.mjs"
HOST = "http://127.0.0.1:8899"
PAGE = HOST + "/lab/mmd-char.html"

BASE_FIXED = urllib.parse.quote("/api/zero02-pet/assets?f=mmd/Darling02/", safe="")
BASE_ORIG = urllib.parse.quote("/models/mmd/Darling02/", safe="")

# 探针要同时覆盖「修复版改过名的 cf_J_hair_* / スカート_*」和「原始 HairJoint-uuid」两套命名
PROBES = ("頭,首,上半身,左手首,右手首,左ひじ,右ひじ,左足,右足,左ひざ,右ひざ,左足首,両目,"
          "右親指１,右中指１,"
          "cf_J_hair_00_02,HairJoint-fd37c289-94a8-4eaf-a8bf-996fe030c2ca")

# 用例：bone=<骨名=rx,ry,rz>  must=应位移的骨  mustnot=不应位移的骨
# 注意：骨骼绕自身原点旋转时，自身世界坐标不变，动的是子骨/后代骨骼（所以探针取后代）。
CASES = [
    {
        "id": "左腕",
        "bone": "左腕=0,0,1.2",
        "why": "抬左臂：左ひじ/左手首必须跟着走；右半身/头/脚必须完全不动",
        "must": ["左ひじ", "左手首"],
        "mustnot": ["右手首", "右ひじ", "頭", "首", "上半身", "左足", "右足"],
    },
    {
        "id": "右腕",
        "bone": "右腕=0,0,-1.2",
        "why": "抬右臂：镜像检查",
        "must": ["右ひじ", "右手首"],
        "mustnot": ["左手首", "左ひじ", "頭", "首", "上半身", "左足", "右足"],
    },
    {
        "id": "左ひじ",
        "bone": "左ひじ=0,0,1.0",
        "why": "弯左肘：只有左手首动，左肘自身/躯干不动",
        "must": ["左手首"],
        "mustnot": ["左ひじ", "右手首", "頭", "上半身", "左足", "右足"],
    },
    {
        "id": "右手首",
        "bone": "右手首=0.9,0,0",
        "why": "转右手腕：手指必须跟着走，身体/另一只手不动",
        "must": ["右親指１", "右中指１"],
        "mustnot": ["右手首", "左手首", "頭", "上半身", "左足", "右足"],
    },
    {
        "id": "首",
        "bone": "首=0.5,0,0",
        "why": "低头（颈）：头/两眼必须动，躯干/手/脚不动",
        "must": ["頭", "両目"],
        "mustnot": ["首", "上半身", "左手首", "右手首", "左足", "右足"],
    },
    {
        "id": "頭",
        "bone": "頭=0.4,0,0",
        "why": "低头（头）：头发必须跟着动，颈/躯干/手/脚不动",
        "must": ["cf_J_hair_00_02", "HairJoint-fd37c289-94a8-4eaf-a8bf-996fe030c2ca"],
        "mustnot": ["頭", "首", "上半身", "左手首", "右手首"],
    },
    {
        "id": "上半身",
        "bone": "上半身=0,0,0.45",
        "why": "侧弯躯干：头/颈跟着走，脚绝对不动",
        "must": ["頭", "首"],
        "mustnot": ["上半身", "左足", "右足"],
    },
    {
        "id": "下半身",
        "bone": "下半身=0,0,0.35",
        "why": "摆胯：腿跟着走，头/上半身不动",
        "must": ["左足", "右足"],
        "mustnot": ["頭", "首", "上半身", "左手首"],
    },
    {
        "id": "左足",
        "bone": "左足=0.5,0,0",
        "why": "抬左腿：左ひざ必须跟着走，右腿/上半身不动",
        "must": ["左ひざ"],
        "mustnot": ["右足", "頭", "上半身"],
    },
]

MOVE_EPS = 0.05      # 世界单位（模型高约 24）——大于 5cm 算"动了"
STILL_EPS = 0.02     # 小于 2cm 算"没动"


def run_page(base, file, extra_query="", out=None, wait=1200, info="JSON.stringify(window.__LAB.probe)"):
    prob = urllib.parse.quote(PROBES)
    url = "%s?base=%s&file=%s&t=1.5&probe=%s%s" % (PAGE, base, file, prob, extra_query)
    cmd = [NODE, str(SHOT), "--url", url, "--size", "480x800", "--wait", str(wait),
           "--ready", "window.__LAB_READY", "--info", info]
    cmd += ["--out", str(out or (pathlib.Path("/tmp") / "darling-verify-tmp.png"))]
    res = subprocess.run(cmd, capture_output=True, text=True)
    txt = res.stdout
    line = ""
    for ln in txt.splitlines():
        if ln.startswith("info:"):
            line = ln[len("info:"):].strip()
    if not line:
        raise SystemExit("页面没有返回 probe：\n" + txt[-3000:] + "\n" + res.stderr[-2000:])
    val = json.loads(line)
    if isinstance(val, str):
        val = json.loads(val)
    return val


def dist(a, b):
    return ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2) ** 0.5


def evaluate(name, base, file, shots=False):
    print("\n===== %s  (%s%s) =====" % (name, base == BASE_FIXED and "/api/.../mmd/Darling02/" or "/models/mmd/Darling02/", file))
    base_probe = run_page(base, file, out=ROOT / "shots" / ("darling-verify-%s-base.png" % name) if shots else None)
    rows, ok_cnt = [], 0
    for case in CASES:
        q = "&bone=" + urllib.parse.quote(case["bone"])
        out = ROOT / "shots" / ("darling-pose-%s-%s.png" % (name, case["id"])) if shots else None
        pr = run_page(base, file, q, out=out)
        moved = {k: dist(pr[k], base_probe[k]) for k in case["must"] if pr.get(k) and base_probe.get(k)}
        still = {k: dist(pr[k], base_probe[k]) for k in case["mustnot"] if pr.get(k) and base_probe.get(k)}
        missing = [k for k in case["must"] + case["mustnot"] if not pr.get(k)]
        # 头发在「修复版(cf_J_hair_*)」和「原始版(HairJoint-uuid)」里命名不同，
        # 一个模型只会命中其中一套：只要「至少有一根 must 骨存在且动了」就算通过。
        ok_move = bool(moved) and min(moved.values()) > MOVE_EPS
        ok_still = (not still) or max(still.values()) < STILL_EPS
        all_missing = all(k in missing for k in case["must"]) if case["must"] else True
        ok = ok_move and ok_still and not all_missing
        ok_cnt += 1 if ok else 0
        rows.append({
            "id": case["id"], "bone": case["bone"], "why": case["why"], "ok": ok,
            "moved": moved, "still": still, "missing": missing,
        })
    print("  用例通过: %d/%d" % (ok_cnt, len(CASES)))
    for r in rows:
        print("  [%s] %-6s %-18s 动:%6.2f~%6.2f  不动:max %5.3f%s" % (
            "PASS" if r["ok"] else "FAIL", r["id"], r["bone"].replace("=", "="),
            min(r["moved"].values()) if r["moved"] else -1,
            max(r["moved"].values()) if r["moved"] else -1,
            max(r["still"].values()) if r["still"] else 0,
            ("  缺骨:" + ",".join(r["missing"])) if r["missing"] else ""))
    return {"name": name, "file": file, "cases": rows, "passed": ok_cnt, "total": len(CASES)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--target", choices=["fixed", "orig", "both"], default="both")
    ap.add_argument("--shots", action="store_true")
    ap.add_argument("--json-out", default=str(ROOT / "docs" / "darling-skeleton-verify.json"))
    args = ap.parse_args()
    results = []
    if args.target in ("fixed", "both"):
        results.append(evaluate("fixed", BASE_FIXED, "Darling02_fixed.pmx", args.shots))
    if args.target in ("orig", "both"):
        results.append(evaluate("orig", BASE_ORIG, "ZeroTwo_GameStyle.pmx", args.shots))
    if args.json_out:
        pathlib.Path(args.json_out).write_text(json.dumps(results, ensure_ascii=False, indent=2))
        print("\n写出:", args.json_out)
    bad = [r for r in results if r["passed"] != r["total"]]
    if bad:
        print("\n!! 未通过: " + ", ".join(r["name"] for r in bad), file=sys.stderr)


if __name__ == "__main__":
    main()
