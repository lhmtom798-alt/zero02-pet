#!/usr/bin/env python3
"""Darling02（游戏风 02）PMX 骨架重建 + 物理命名适配 + 复验。

背景
----
models/mmd/Darling02/ZeroTwo_GameStyle.pmx 来自「模之屋预览管线 → PMX 重建」：
  * bone.position 存的是**绝对坐标**（本脚本原样保留，不改相对/绝对！）；
  * bone.parentIndex 是**乱序的**：242 根骨里只有 1 根标准骨的父级正确
    （payload 里的 parent 是原始 VRM 骨架里的索引，整体存在 +60 / +121 的错位，
     链尾还会 wrap，见 docs/02-DARLING-PIPELINE.md §2.2 的实测证据）。
  * three 的 MMDLoader 读 PMX 时 `pos -= parent.position`（见 vendor/three-vrm.global.js
    里 geometryBuilder.build()），所以「修复」= 只重建 parentIndex，position 保持绝对坐标。

本脚本做的事
------------
1) 用 node + mmd-parser（/tmp/mmdparser.js）把 PMX 解析成 mmd-parser 的 JSON 结构；
2) 按 4 级规则重建 parentIndex：
     A. 标准 MMD 日文骨名表（65 根：センター/腰/上半身/首/頭/肩腕ひじ手首/手指/足/目/IK/捩）
     B. J_ 系命名规则（40 根：J_Sec_*_Skirt*/Sleeve/Bust、J_Adj_*_FaceEyeSet、J_Bip_*_ToeBase_end）
     C. HairJoint-<uuid> 发丝链（120 根 = 24 束 × 5 节，按「同一束 index 连续 + Y 递减」重建，
        束根挂 頭）；
     D. glTF 根节点（全ての親/Root/Hairs/secondary/...）；
     E. 兜底：按绝对坐标找「最近的、不低于自己的、已定位骨骼」（本模型触发 0 根）；
3) 可选 --rename：把 HairJoint-<uuid> / J_Sec_*_Skirt* 改成 mmdchar.js 能识别的
   `cf_J_hair_*` / `スカート_r_c`（原始 uuid 名保留在 englishName 里），
   这样现有 mmdchar 的程序化头发/裙摆物理直接生效（骨骼索引不变，蒙皮不受影响）；
4) 写回 PMX（贴图路径统一 "/"），再用 mmd-parser 复读 + 结构校验（环/根/深度/坐标不变）。

用法
----
  python3 tools/darling-fix.py                        # 默认输入输出（见下方常量）
  python3 tools/darling-fix.py --no-rename            # 不改骨名（纯骨架修复版）
  python3 tools/darling-fix.py --pmx X.pmx --out Y.pmx
  python3 tools/darling-fix.py --from-json /tmp/darling-model.json   # 跳过解析缓存

环境变量：NODE / MMD_PARSER 可覆盖 node 与 mmd-parser 的路径。
"""
import argparse
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools" / "hunt"))
import json2pmx  # noqa: E402

NODE = os.environ.get("NODE") or "~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node"
MMD_PARSER = os.environ.get("MMD_PARSER") or "/tmp/mmdparser.js"
DEFAULT_IN = ROOT / "models" / "mmd" / "Darling02" / "ZeroTwo_GameStyle.pmx"
DEFAULT_OUT = ROOT / "models" / "final" / "Darling02_fixed.pmx"
DUMP_JS = r"""
const fs = require('fs');
const { Parser } = require(process.argv[2]);
const buf = fs.readFileSync(process.argv[3]);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const model = new Parser().parsePmx(ab, false);
fs.writeFileSync(process.argv[4], JSON.stringify(model));
console.log(JSON.stringify({ verts: model.vertices.length, faces: model.faces.length,
  bones: model.bones.length, materials: model.materials.length, morphs: model.morphs.length,
  rigids: model.rigidBodies.length, constraints: model.constraints.length }));
"""

# ---------------------------------------------------------------------------
# A. 标准 MMD 日文骨名表（本模型的骨名子集 + 常用标准名，便于复用）
#    注意本模型没有 グルーブ / 肩P / 肩C / 腰キャンセル，所以：
#      腰 → センター，上半身/下半身 → 腰，肩 → 上半身3（UpperChest）
# ---------------------------------------------------------------------------
STD = {
    "センター": "全ての親",
    "腰": "センター",
    "下半身": "腰",
    "上半身": "腰",
    "上半身2": "上半身",
    "上半身3": "上半身2",
    "首": "上半身3",
    "頭": "首",
    "両目": "頭",
    "右目": "J_Adj_R_FaceEyeSet",
    "左目": "J_Adj_L_FaceEyeSet",
}
for side, suffix in (("左", "L"), ("右", "R")):
    STD.update({
        side + "肩": "上半身3",
        side + "腕": side + "肩",
        side + "腕捩": side + "腕",
        side + "ひじ": side + "腕",
        side + "ひじ補助": side + "ひじ",
        side + "手首": side + "ひじ",
        side + "手捩": side + "ひじ",
        side + "手先": side + "手首",
        side + "ダミー": side + "手首",
        # 手指：親指 0→1→2 链，其余四指 1→2→3 链，都从手首分叉
        side + "親指０": side + "手首",
        side + "親指１": side + "親指０",
        side + "親指２": side + "親指１",
        side + "親指先": side + "親指２",
        side + "足": "下半身",
        side + "ひざ": side + "足",
        side + "足首": side + "ひざ",
        side + "つま先": side + "足首",
        side + "足ＩＫ": "全ての親",
        side + "つま先ＩＫ": side + "足ＩＫ",
        side + "足ＩＫ先": side + "足ＩＫ",
        side + "つま先ＩＫ先": side + "つま先ＩＫ",
    })
    for finger in ("人指", "人差指", "中指", "薬指", "小指"):
        STD[side + finger + "１"] = side + "手首"
        STD[side + finger + "２"] = side + finger + "１"
        STD[side + finger + "３"] = side + finger + "２"
        STD[side + finger + "先"] = side + finger + "３"

# ---------------------------------------------------------------------------
# D. glTF 节点骨（无蒙皮，纯层级）：全ての親 ← Root ← {Body, Face, Hairs→Hair001, secondary, センター}
# ---------------------------------------------------------------------------
GLTF_ROOTS = {
    "Root": "全ての親",
    "Body": "Root",
    "Face": "Root",
    "Hairs": "Root",
    "Hair001": "Hairs",
    "secondary": "Root",
}

RE_TOE_END = re.compile(r"^J_Bip_([RL])_ToeBase_end$")
RE_FINGER_END = re.compile(r"^J_Bip_([RL])_(Thumb|Index|Middle|Ring|Little)3_end$")
FINGER_JP = {"Thumb": "親指", "Index": "人指", "Middle": "中指", "Ring": "薬指", "Little": "小指"}
RE_SKIRT = re.compile(r"^J_Sec_([RL])_Skirt(Front|Back|Side)(\d)(_end)?$")
RE_SLEEVE = re.compile(r"^J_Sec_([RL])_(TipSleeve|LowerSleeve)(_end)?$")
RE_BUST = re.compile(r"^J_Sec_([RL])_Bust([12])$")
RE_EYE_SET = re.compile(r"^J_Adj_([RL])_FaceEyeSet$")
SIDE_JP = {"L": "左", "R": "右"}

# ---------------------------------------------------------------------------
# F. 表情 morph 别名：这个模型是 VRM 表情名（喜/楽/驚/…），而 mmdchar.js 的 EXPR 表按
#    MMD 标准名找（笑い/照れ/びっくり/なごみ/困る/ウィンク右/ウィンク…）。逐项改成标准名，
#    表情索引不变（morph 元素都指向顶点，改名不影响蒙皮/几何），mmdchar 的笑脸/惊讶/困
#    等表情就能直接生效。没有对应来源的（照れ/はぁと/horns +）保持缺失 = 不额外加表情。
# ---------------------------------------------------------------------------
MORPH_ALIAS = {
    "喜": "笑い",              # EXPR.smile（happy/pat/eat/棒棒糖都会用）
    "驚": "びっくり",           # EXPR.surprise（stretch）
    "哀": "困る",              # EXPR.sad
    "楽": "なごみ",             # EXPR.calm（sleep）
    "ｳｨﾝｸ２右": "ウィンク右",   # EXPR.winkR（wink 状态）
    "ウィンク２": "ウィンク",     # EXPR.wink
    "怒": "怒り",              # 标准名（mmdchar 不用，但便于外部工具）
}


def side_jp(tag):
    return SIDE_JP.get(tag, "")


def build_parents(bones):
    """返回 (parent, stats, notes)。parent[i] = 父骨 index，-1 = 无父（根）。"""
    n = len(bones)
    names = [b.get("name") or "" for b in bones]
    by_name = {}
    for i, nm in enumerate(names):
        by_name.setdefault(nm, i)
    parent = [-2] * n          # -2 = 未定位；-1 = 根
    cat = [""] * n             # 归类，做统计/文档
    notes = []

    def setp(i, pname=None, pidx=None, category="?"):
        if parent[i] != -2:
            return False
        if pidx is None:
            pidx = by_name.get(pname) if pname else None
        if pidx is None:
            return False
        if pidx == i:
            return False
        parent[i] = pidx
        cat[i] = category
        return True

    pos = [tuple(b.get("position") or (0.0, 0.0, 0.0)) for b in bones]

    # ---- A. 标准名表 ----
    for i, nm in enumerate(names):
        pname = STD.get(nm)
        if pname is not None:
            setp(i, pname=pname, category="std")

    # ---- B1. J_Sec_*_Skirt{ring}: ring0 挂下半身，其余挂上一圈，_end 挂本圈 ----
    for i, nm in enumerate(names):
        m = RE_SKIRT.match(nm)
        if not m:
            continue
        side, part, ring, is_end = m.group(1), m.group(2), int(m.group(3)), bool(m.group(4))
        base = "J_Sec_%s_Skirt%s" % (side, part)
        if is_end:
            setp(i, pname="%s%d" % (base, ring), category="jsec")
        elif ring == 0:
            setp(i, pname="下半身", category="jsec")
        else:
            setp(i, pname="%s%d" % (base, ring - 1), category="jsec")

    # ---- B2. 袖子 / 袖口 ----
    for i, nm in enumerate(names):
        m = RE_SLEEVE.match(nm)
        if not m:
            continue
        side, kind, is_end = m.group(1), m.group(2), bool(m.group(3))
        s = side_jp(side)
        if is_end:
            setp(i, pname="J_Sec_%s_%s" % (side, kind), category="jsec")
        elif kind == "TipSleeve":          # 袖口（贴着手腕）
            setp(i, pname=s + "手首", category="jsec")
        else:                              # 小臂袖子（贴着肘）
            setp(i, pname=s + "ひじ", category="jsec")

    # ---- B3. 胸部 ----
    for i, nm in enumerate(names):
        m = RE_BUST.match(nm)
        if not m:
            continue
        side, idx = m.group(1), m.group(2)
        setp(i, pname="上半身2" if idx == "1" else "J_Sec_%s_Bust1" % side, category="jsec")

    # ---- B4. 眼部调整骨 / 脚趾末端 / 手指末端（_end 只挂父，不参与蒙皮） ----
    for i, nm in enumerate(names):
        if RE_EYE_SET.match(nm):
            setp(i, pname="頭", category="jsec")
        m = RE_TOE_END.match(nm)
        if m:
            setp(i, pname=side_jp(m.group(1)) + "つま先", category="jsec")
        m = RE_FINGER_END.match(nm)
        if m:
            # 拇指链只有 親指０/１/２（没有 親指３），其余手指末端挂 ３
            if m.group(2) == "Thumb":
                setp(i, pname=side_jp(m.group(1)) + "親指２", category="jsec")
            else:
                setp(i, pname=side_jp(m.group(1)) + FINGER_JP[m.group(2)] + "３", category="jsec")

    # ---- C. HairJoint-<uuid> 发丝链 ----
    # 观察到的结构：24 束 × 5 节，同一束在骨骼表里 index 连续、Y 严格递减
    # （束与束之间 head 的 Y 抬升 > 4 个单位）。这里用「同束继续 ⇔ 紧随其后且 Y 更低」
    # 的规则切束，不依赖 uuid 内容；切完再校验每束 5 节 & Y 单调。
    hair_idx = [i for i, nm in enumerate(names) if nm.startswith("HairJoint-")]
    strands = []
    for i in hair_idx:
        if strands and pos[i][1] < pos[strands[-1][-1]][1] - 0.4:
            strands[-1].append(i)
        else:
            strands.append([i])
    head_i = by_name.get("頭")
    for strand in strands:
        for j, i in enumerate(strand):
            if j == 0:
                setp(i, pidx=head_i, category="hair")
            else:
                setp(i, pidx=strand[j - 1], category="hair")
    bad_strands = [len(s) for s in strands if len(s) != 5]
    if bad_strands:
        notes.append("头发束长度异常: %r" % bad_strands)

    # ---- D. glTF 根节点 ----
    for i, nm in enumerate(names):
        pname = GLTF_ROOTS.get(nm)
        if pname is not None:
            setp(i, pname=pname, category="gltf")

    # ---- E. 兜底：最近的、不低于自己的、已定位骨骼（同 TDA 脚本思路） ----
    unresolved = [i for i in range(n) if parent[i] == -2]
    placed = [i for i in range(n) if parent[i] != -2]
    order = sorted(unresolved, key=lambda i: -pos[i][1])
    for i in order:
        best, bestd = None, 1e18
        for j in placed:
            dy = pos[j][1] - pos[i][1]
            if dy < -2.5:
                continue
            d = ((pos[j][0] - pos[i][0]) ** 2 + (pos[j][2] - pos[i][2]) ** 2 + max(0.0, dy) ** 2) ** 0.5
            if d < bestd:
                bestd, best = d, j
        if best is not None:
            parent[i] = best
            cat[i] = "geom"
            placed.append(i)
        else:
            parent[i] = -1
            cat[i] = "root"

    # ---- 根：全ての親（没有父）之外全部有父；防环 ----
    root = by_name.get("全ての親")
    for i in range(n):
        if parent[i] == -2:
            parent[i] = root if root is not None and root != i else -1
            cat[i] = cat[i] or "root"
    if root is not None:
        parent[root] = -1
        cat[root] = "root"
    for i in range(n):
        seen, cur = set(), i
        while cur >= 0 and cur not in seen:
            seen.add(cur)
            cur = parent[cur]
        if cur >= 0:
            notes.append("环: %d" % i)
            parent[i] = root if root is not None and root != i else -1
            cat[i] = "cycle-fix"

    stats = {}
    for c in cat:
        stats[c] = stats.get(c, 0) + 1
    return parent, stats, notes, strands


# ---------------------------------------------------------------------------
# 可选改名：让现有 mmdchar.js 的物理识别（/^cf_J_hair/ 与 /^スカート_r_c$/）生效
# ---------------------------------------------------------------------------
def rename_bones(bones, strands):
    """返回改名统计。骨骼索引不变，蒙皮权重不受影响；原始名写进 englishName。"""
    renamed = 0
    # 头发：cf_J_hair_SS_JJ（SS=束序号，JJ=第几节；mmdchar 按 /^cf_J_hair/ + 父链深度算弹簧）
    for si, strand in enumerate(strands):
        for j, i in enumerate(strand):
            b = bones[i]
            orig = b.get("name") or ""
            b["englishName"] = orig
            b["name"] = "cf_J_hair_%02d_%02d" % (si, j)
            renamed += 1
    # 裙摆：スカート_ring_col（mmdchar 用 ring/6 做弹簧强度、col 做相位）
    part_col = {("Front", "L"): 0, ("Front", "R"): 1, ("Back", "L"): 2,
                ("Back", "R"): 3, ("Side", "L"): 4, ("Side", "R"): 5}
    for i, b in enumerate(bones):
        m = RE_SKIRT.match(b.get("name") or "")
        if not m:
            continue
        side, part, ring, is_end = m.group(1), m.group(2), int(m.group(3)), bool(m.group(4))
        r = ring + 1 if is_end else ring      # _end 作为最后一圈（ring 3）
        c = part_col.get((part, side), 0)
        b["englishName"] = b.get("name")
        b["name"] = "スカート_%d_%d" % (r, c)
        renamed += 1
    return renamed


def alias_morphs(model):
    """把 VRM 表情名改成 mmdchar.js EXPR 表认的 MMD 标准名。返回改名列表。"""
    done = []
    for mo in model.get("morphs") or []:
        nm = mo.get("name") or ""
        if nm in MORPH_ALIAS:
            mo["englishName"] = (mo.get("englishName") or "") or nm
            mo["name"] = MORPH_ALIAS[nm]
            done.append((nm, mo["name"]))
    return done


# ---------------------------------------------------------------------------
# 统计辅助
# ---------------------------------------------------------------------------
def tree_stats(bones, parent):
    n = len(bones)
    roots = [i for i in range(n) if parent[i] == -1]
    depths = [0] * n
    for i in range(n):
        d, cur, seen = 0, i, set()
        while cur >= 0 and cur not in seen:
            seen.add(cur)
            d += 1
            cur = parent[cur]
        depths[i] = d
    pos = [tuple(b.get("position") or (0, 0, 0)) for b in bones]
    lower = sum(1 for i in range(n) if parent[i] >= 0 and pos[parent[i]][1] < pos[i][1] - 2.5)
    return {
        "roots": len(roots),
        "maxDepth": max(depths) if depths else 0,
        "parentBelowChild": lower,
        "unresolved": sum(1 for i in range(n) if parent[i] == -2),
    }


def std_name_hits(bones):
    """有多少根「标准 MMD 名」骨。"""
    return sum(1 for b in bones if (b.get("name") or "") in STD or (b.get("name") or "") in GLTF_ROOTS)


def dump_model(pmx_path, out_json):
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="darling-fix-"))
    js = tmp / "dump.js"
    js.write_text(DUMP_JS)
    res = subprocess.run([NODE, str(js), MMD_PARSER, str(pmx_path), str(out_json)],
                         capture_output=True, text=True)
    if res.returncode != 0:
        raise SystemExit("mmd-parser 解析失败:\n" + res.stderr[:4000])
    return json.loads(res.stdout)


def validate(pmx_path, want_path):
    """用 tools/hunt/validate.js 把写出的 PMX 与目标 JSON 逐字段对拍。"""
    js = ROOT / "tools" / "hunt" / "validate.js"
    if not js.exists():
        print("  (跳过校验: 找不到 tools/hunt/validate.js)")
        return True
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="darling-val-"))
    node_validate = tmp / "validate.js"
    src = js.read_text()
    src = src.replace("require('/tmp/mmdparser.js')", "require(process.argv[2])")
    # 原始用法: node validate.js <pmx> <json>  → 这里多传一个 parser 路径
    src = src.replace("const [,, pmxPath, jsonPath] = process.argv;",
                      "const [,, parserPath, pmxPath, jsonPath] = process.argv;")
    node_validate.write_text(src)
    res = subprocess.run([NODE, str(node_validate), MMD_PARSER, str(pmx_path), str(want_path)],
                         capture_output=True, text=True)
    print("  " + (res.stdout.strip() or res.stderr.strip()[:2000]))
    return res.returncode == 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pmx", default=str(DEFAULT_IN))
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    ap.add_argument("--from-json", default="", help="复用已 dump 的 model JSON（跳过 node 解析）")
    ap.add_argument("--json-out", default=str(ROOT / "models" / "final" / "Darling02_fixed.model.json"))
    ap.add_argument("--no-rename", action="store_true", help="不改骨名（纯骨架修复）")
    ap.add_argument("--no-morph-alias", action="store_true", help="不改表情名（保留 VRM 表情名）")
    ap.add_argument("--no-validate", action="store_true")
    args = ap.parse_args()

    pmx = pathlib.Path(args.pmx)
    out = pathlib.Path(args.out)

    if args.from_json and pathlib.Path(args.from_json).exists():
        model = json.load(open(args.from_json))
        print("读取缓存 JSON:", args.from_json)
    else:
        print("解析 PMX:", pmx)
        info = dump_model(pmx, "/tmp/darling-model.json")
        model = json.load(open("/tmp/darling-model.json"))
        print("  ", info)

    bones = model["bones"]
    n = len(bones)
    old_parent = [b.get("parentIndex", -1) for b in bones]
    abs_pos = [tuple(b.get("position") or (0, 0, 0)) for b in bones]

    print("\n==== 1. 骨骼父级重建 ====")
    parent, stats, notes, strands = build_parents(bones)
    print("骨骼数:", n)
    print("  规则命中:", {k: v for k, v in sorted(stats.items())})
    print("  头发束:", len(strands), "束 / 每束", sorted(set(len(s) for s in strands)))
    if notes:
        print("  注意:", notes)
    before = tree_stats(bones, [p if 0 <= p < n else -1 for p in old_parent])
    after = tree_stats(bones, parent)
    changed = sum(1 for i in range(n) if old_parent[i] != parent[i])
    print("  改动父级: %d/%d 根" % (changed, n))
    print("  改前: 根 %d / 最大深度 %d / 父骨明显低于子骨 %d 根 / 未定位 %d"
          % (before["roots"], before["maxDepth"], before["parentBelowChild"], before["unresolved"]))
    print("  改后: 根 %d / 最大深度 %d / 父骨明显低于子骨 %d 根 / 未定位 %d"
          % (after["roots"], after["maxDepth"], after["parentBelowChild"], after["unresolved"]))
    if after["roots"] != 1:
        raise SystemExit("!! 修复后根骨骼不是 1 个，拒绝写回")

    # 保留绝对坐标（关键！three 的 MMDLoader 自己会减父骨位置）
    for i, b in enumerate(bones):
        b["parentIndex"] = parent[i]
        b["position"] = abs_pos[i]

    if not args.no_rename:
        n_ren = rename_bones(bones, strands)
        print("  物理命名适配: 改名 %d 根（cf_J_hair_* / スカート_r_c，原名存 englishName）" % n_ren)
    else:
        print("  --no-rename：保留 HairJoint-uuid / J_Sec_*_Skirt* 原名")

    if not args.no_morph_alias:
        renamed_morphs = alias_morphs(model)
        print("  表情别名: %d 个 %r" % (len(renamed_morphs), renamed_morphs))
    else:
        print("  --no-morph-alias：保留 VRM 表情名")

    model["textures"] = [t.replace("\\", "/") for t in (model.get("textures") or [])]
    out.parent.mkdir(parents=True, exist_ok=True)
    size = json2pmx.write_pmx(model, str(out), lower_textures=True)
    print("\n==== 2. 写回 ====")
    print("写出:", out, size, "bytes")

    jout = pathlib.Path(args.json_out)
    json.dump(model, open(jout, "w"), ensure_ascii=False)
    print("写出目标 JSON:", jout)

    if not args.no_validate:
        print("\n==== 3. 复读校验（mmd-parser 再解析 vs 目标 JSON）====")
        ok = validate(out, jout)
        # 额外：坐标/父级与目标完全一致
        got = dump_model(out, "/tmp/darling-fixed-verify.json")
        back = json.load(open("/tmp/darling-fixed-verify.json"))
        bad_pos = bad_par = 0
        for i, b in enumerate(back["bones"]):
            if abs(b["position"][0] - abs_pos[i][0]) > 1e-4 or \
               abs(b["position"][1] - abs_pos[i][1]) > 1e-4 or \
               abs(b["position"][2] - abs_pos[i][2]) > 1e-4:
                bad_pos += 1
            if b["parentIndex"] != parent[i]:
                bad_par += 1
        print("  复读 %r" % got)
        print("  坐标不一致: %d 根 / 父级不一致: %d 根" % (bad_pos, bad_par))
        if bad_pos or bad_par or not ok:
            raise SystemExit("!! 复验失败")
        print("  复验通过 ✓")

    print("\n完成:", out)


if __name__ == "__main__":
    main()
