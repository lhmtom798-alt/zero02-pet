#!/usr/bin/env python3
"""修复模之屋预览 payload 的 MMD 骨骼树，并重打包成可动画的 PMX。

背景：aplaybox 公开预览 payload 里骨骼的 parentIndex 是乱序的（但 absolute position 是对的）。
直接拿去动画会牵动错误部位。本脚本：
  1) 按 MMD 标准骨骼名称表重建父子关系；
  2) 头发 cf_J_hair* / 裙子 スカート_r_c 按命名规则连成链；
  3) 注意：three 的 MMDLoader 会把 PMX 骨骼 position 当作"绝对坐标"，加载时自己减去父骨骼
     （见 vendor 里的 Parser：pos -= parent.position），所以这里【保留绝对坐标】，只修 parentIndex；
  4) 贴图路径统一成 "/"。

用法：
  python3 tools/mmd-fix-skeleton.py <payload.model.json> <out.pmx>
"""
import json
import sys

sys.path.insert(0, "tools/hunt")
import json2pmx  # noqa: E402

# 标准 MMD 骨骼：孩子名 -> 父名（"L"/"R" 表示左右对称）
STD = {
    "全ての親": "操作中心",
    "センター": "全ての親",
    "グルーブ": "センター",
    "腰": "グルーブ",
    "上半身": "腰",
    "上半身2": "上半身",
    "上半身2先": "上半身2",
    "首": "上半身2",
    "頭": "首",
    "頭先": "頭",
    "下半身": "腰",
    "下半身先": "下半身",
    "両目": "頭",
    "舌１": "頭",
    "舌２": "舌１",
    "舌３": "舌２",
    "メガネ": "頭",
    "ヘッドセット": "頭",
    "左肩P": "上半身2", "右肩P": "上半身2",
    "左肩": "左肩P", "右肩": "右肩P",
    "左肩C": "左肩", "右肩C": "右肩",
    "左腕": "左肩C", "右腕": "右肩C",
    "左ひじ": "左腕", "右ひじ": "右腕",
    "左ひじ補助": "左ひじ", "右ひじ補助": "右ひじ",
    "+左ひじ補助": "左ひじ補助", "+右ひじ補助": "右ひじ補助",
    "左ひじ補助1": "左ひじ補助", "右ひじ補助1": "右ひじ補助",
    "左ひじ補助＋": "左ひじ補助1", "右ひじ補助＋": "右ひじ補助1",
    "左手首": "左ひじ", "右手首": "右ひじ",
    "左手先": "左手首", "右手先": "右手首",
    "左ダミー": "左手首", "右ダミー": "右手首",
    "左親指０": "左手首", "右親指０": "右手首",
    "左親指１": "左親指０", "右親指１": "右親指０",
    "左親指２": "左親指１", "右親指２": "右親指１",
    "左親指先": "左親指２", "右親指先": "右親指２",
    "左人指１": "左手首", "右人指１": "右手首",
    "左人指２": "左人指１", "右人指２": "右人指１",
    "左人指３": "左人指２", "右人指３": "右人指２",
    "左人指先": "左人指３", "右人指先": "右人指３",
    "左人差指先": "左人指先", "右人差指先": "右人指先",
    "左中指１": "左手首", "右中指１": "右手首",
    "左中指２": "左中指１", "右中指２": "右中指１",
    "左中指３": "左中指２", "右中指３": "右中指２",
    "左中指先": "左中指３", "右中指先": "右中指３",
    "左薬指１": "左手首", "右薬指１": "右手首",
    "左薬指２": "左薬指１", "右薬指２": "右薬指１",
    "左薬指３": "左薬指２", "右薬指３": "右薬指２",
    "左薬指先": "左薬指３", "右薬指先": "右薬指３",
    "左小指１": "左手首", "右小指１": "右手首",
    "左小指２": "左小指１", "右小指２": "右小指１",
    "左小指３": "左小指２", "右小指３": "右小指２",
    "左小指先": "左小指３", "右小指先": "右小指３",
    "左足IK親": "操作中心", "右足IK親": "操作中心",
    "左足ＩＫ": "左足IK親", "右足ＩＫ": "右足IK親",
    "左つま先ＩＫ": "左足ＩＫ", "右つま先ＩＫ": "右足ＩＫ",
    "左足ＩＫ先": "左足ＩＫ", "右足ＩＫ先": "右足ＩＫ",
    "左つま先ＩＫ先": "左つま先ＩＫ", "右つま先ＩＫ先": "右つま先ＩＫ",
    "左腰キャンセル": "下半身", "右腰キャンセル": "下半身",
    "腰キャンセル左": "下半身", "腰キャンセル右": "下半身",
    "左足": "腰キャンセル左", "右足": "腰キャンセル右",
    "左ひざ": "左足", "右ひざ": "右足",
    "左足首": "左ひざ", "右足首": "右ひざ",
    "左つま先": "左足首", "右つま先": "右足首",
    "左足D": "左足", "右足D": "右足",
    "+左足D": "左足D", "+右足D": "右足D",
    "左ひざD": "左ひざ", "右ひざD": "右ひざ",
    "左足首D": "左足首", "右足首D": "右足首",
    "左足先EX": "左足首D", "右足先EX": "右足首D",
    "左つま先X回転": "左足先EX", "右つま先X回転": "右足先EX",
    "左足リング": "左足首", "右足リング": "右足首",
    "足リング": "足首",
    "足リング先": "足リング",
    "手リング": "左手首",
    "手リング先": "手リング",
}
for side in ("左", "右"):
    STD[side + "目"] = "頭"
    for n in ("両目",):
        pass
    STD[side + "目戻"] = side + "目"


def build_parents(bones):
    by_name = {}
    for i, b in enumerate(bones):
        by_name.setdefault(b.get("name", ""), i)

    def idx(name):
        return by_name.get(name)

    n = len(bones)
    parent = [-2] * n
    def setp(i, p):
        if p is None or p == i:
            return
        parent[i] = p
    # 1) 标准表
    for i, b in enumerate(bones):
        name = b.get("name", "")
        pname = STD.get(name)
        if pname is not None:
            p = idx(pname)
            setp(i, p)
    # 2) 头发链
    hair_top = {"hairF_top": "頭", "hairB_top": "頭"}
    for i, b in enumerate(bones):
        name = b.get("name", "")
        if not name.startswith("cf_J_"):
            continue
        if name in hair_top:
            setp(i, idx(hair_top[name]))
            continue
        # cf_J_hairX_YY or cf_J_hairXX_YY_ZZ
        rest = name[len("cf_J_"):]
        parts = rest.split("_")
        if len(parts) == 3:  # hairB_03 -> top = hairB_top
            pre, num = parts[0], int(parts[1])
            top = "cf_J_" + pre + "_top"
            if parts[1] in ("00", "0"):
                setp(i, idx(top))
            else:
                setp(i, idx("cf_J_%s_%02d" % (pre, num - 1)))
            continue
        if len(parts) == 4:  # hairFL_01_03 -> first under top, others chain
            pre, mid, num = parts[0], parts[1], int(parts[2])
            if mid == "00":
                setp(i, idx("cf_J_" + pre + "_" + parts[1] + "_top"))
                if parent[i] == -2:
                    setp(i, idx("cf_J_hairF_top"))
            else:
                setp(i, idx("cf_J_%s_%s_%02d" % (pre, mid, num - 1)))
            if parent[i] == -2:
                setp(i, idx("cf_J_hairF_top"))
    # 3) 裙子：スカート_r_c -> 上一圈同列，第 0 圈挂下半身
    for i, b in enumerate(bones):
        name = b.get("name", "")
        if not name.startswith("スカート_"):
            continue
        parts = name.split("_")
        if len(parts) != 3:
            continue
        r, c = int(parts[1]), int(parts[2])
        if r == 0:
            setp(i, idx("下半身"))
        else:
            setp(i, idx("スカート_%d_%d" % (r - 1, c)))
    # 3.5) 清理无效 parent
    for i in range(n):
        if not isinstance(parent[i], int):
            parent[i] = -2
    # 4) 兜底：按绝对坐标找最近且更高的已确定骨骼
    pos = [tuple(b.get("position") or (0, 0, 0)) for b in bones]
    order = sorted(range(n), key=lambda i: -(pos[i][1]))
    placed = [i for i in range(n) if parent[i] != -2]
    for i in order:
        if parent[i] != -2:
            continue
        best, bestd = None, 1e9
        for j in placed:
            dy = pos[j][1] - pos[i][1]
            if dy < -2.5:  # 允许略微更低（同高度链条）
                continue
            d = ((pos[j][0] - pos[i][0]) ** 2 + (pos[j][2] - pos[i][2]) ** 2 + max(0.0, dy) ** 2) ** 0.5
            if d < bestd:
                bestd, best = d, j
        parent[i] = best if best is not None else 0
        placed.append(i)
    # 5) 根
    root = parent.index(-2) if -2 in parent else -1
    # 操作中心 作为根
    op = by_name.get("操作中心")
    for i in range(n):
        if parent[i] == -2:
            parent[i] = op if op is not None and op != i else -1
        if parent[i] == i:
            parent[i] = -1
    # 防环
    for i in range(n):
        seen = set()
        cur = i
        while cur >= 0 and cur not in seen:
            seen.add(cur)
            cur = parent[cur]
        if cur >= 0:
            parent[i] = -1
    return parent


def main():
    payload_path, out_path = sys.argv[1], sys.argv[2]
    model = json.load(open(payload_path))
    bones = model["bones"]
    parent = build_parents(bones)
    abs_pos = [tuple(b.get("position") or (0, 0, 0)) for b in bones]

    # 保留绝对坐标（three 的 MMDLoader 会自己算相对偏移）
    local = list(abs_pos)
    print("骨骼数:", len(bones), " 父骨骼修复完成")

    for i, b in enumerate(bones):
        b["parentIndex"] = parent[i]
        b["position"] = local[i]
    model["textures"] = [t.replace("\\", "/") for t in (model.get("textures") or [])]
    json2pmx.write_pmx(model, out_path)
    print("写出:", out_path)


if __name__ == "__main__":
    main()
