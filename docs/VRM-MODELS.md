# 3D 模型来源与授权

四个 3D 形象都用**成品模型**（不是手搓几何）：

| 皮肤 | 模型 | 来源 / 作者 | 授权 |
| --- | --- | --- | --- |
| 02·御姐 / 元气 / Q版 | **TDA Zero Two**（PMX，3.7 万面，56 表情，24 贴图） | 模之屋 `aplaybox.com/details/model/kZJ1ITyPybKX`，作者 hellhound0101（TDA 素体） | 同人改模，**仅个人桌面宠物使用**，禁止再分发/商用 |
| 鲸鲸 | **DeepSeek-WhaleGirl**（VRM 1.0，53 人形骨 / 18 表情 / 22 组 spring bone） | 模之屋 `ayXkRzVflmnd`，作者 木子恶魔 | VRM 标准许可 personalNonProfit，仅个人使用 |
| （备选/未用）osakura-avatar | VRoid Studio 1.22 成品 | MekaHime Inc. | 允许改/再分发，需署名（本仓库不再使用） |
| （备选/未用）Victoria_Rubin | VRoid 官方示例 | VRoid | CC0 |

> ⚠️ 02 和鲸鲸的模型是**同人/个人使用授权**，不能随插件公开发布；`models/.gitignore` 已把整个目录排除出仓库。
> 插件包内包含它们是给你本机桌面宠物用的，**不要转售/再分发**。

## 关键技术：MMD 骨骼树修复（2.1.0）

模之屋预览 payload 的骨骼有两个坑：

1. `parentIndex` 是乱序的（左腕的父骨可能是右人差指先）；
2. `position` 是**绝对坐标**，而正常 PMX 里是相对父骨骼的。

另外 three 的 `MMDLoader` 在加载 PMX 时会把骨骼 position 当作绝对坐标、自己减去父骨骼位置
（`pos -= parent.position`）。所以修复必须是：**按名字/命名规则重建 parentIndex，同时保留绝对坐标**。
`tools/mmd-fix-skeleton.py` 做了这件事：

- MMD 标准骨骼名表（お全ての親/センター/上半身/肩P/肩/肩C/腕/ひじ/手首/指/足/ひざ/足首/目…）；
- 头发 `cf_J_hair*` 按 `_top` / `_NN` 序号连成链，挂到「頭」；
- 裙子 `スカート_r_c` 按圈层 `r-1` 连链，第 0 圈挂「下半身」；
- 未知骨骼用"最近的更高骨骼"兜底。

修好之后：可以正常做骨骼动画；`cf_J_hair*` 47 根头发骨 + `スカート_*` 150 根裙摆骨跑程序化弹簧物理。

## 关键技术：为什么 02 用 MMD 而不是 VRM

TDA-ZeroTwo 的 PMX 来自模之屋公开预览管线（登录下载不可用）。预览 payload 有两个问题：

1. **骨骼父子索引是错乱的**（左腕的父骨指向右人差指先），不能做骨骼动画；
2. 网格 / 蒙皮权重 / 贴图 / 56 个表情 morph 都是完整的。

所以 `src/3d/mmdchar.js` 的做法是：

- **加载时烘焙姿势**：用蒙皮权重（skinIndex/skinWeight）把 T-pose 的手臂直接绕肩关节旋到身体两侧（线性混合权重），
  不需要骨骼动画也能得到自然站姿；Q 版皮肤额外做「头放大 + 身体缩短」的顶点烘焙；
- **表情用 morphTargetInfluences**：まばたき（眨眼）/ 笑い / ウィンク右 / 照れ / あいうえお 口型 / はぁと（爱心眼）；
- **身体动画用整体变换**：呼吸缩放、左右摇摆、视线跟随（整体转向）、被摸压扁回弹；
- 纹理路径在 `tools/hunt/json2pmx.py` 重打包时统一改成 `/`（原始 PMX 是 Windows `\` 路径）。

## 复现步骤

```bash
# 02：从模之屋公开预览管线取 payload → 重打包 PMX（贴图路径统一为 /）
python3 tools/hunt/ap_fetch.py kZJ1ITyPybKX 10873 /tmp/tda-payload
python3 - <<'PY'
import json, sys; sys.path.insert(0, 'tools/hunt'); import json2pmx
m = json.load(open('/tmp/tda-payload/<hash>.model.json'))
m['textures'] = [t.replace('\\', '/') for t in (m.get('textures') or [])]
json2pmx.write_pmx(m, 'models/final/ZeroTwo_TDA.pmx')
PY

# 鲸鲸：VRM 直接放 models/final/whale.vrm
# 打包（build.py 会把 PMX+贴图、whale.vrm 复制进 assets/）
python3 build.py && python3 tools/pack.py
```

## 运行时

- `src/3d/mmdchar.js`：02 的加载/手臂烘焙/Q版烘焙/表情/整体动画
- `src/3d/vrmchar.js` + `vrm-style.js` + `vrm-look.js` + `vrm-props.js`：VRM 角色的加载/MToon 观感/改色/配件
- `src/client/engine2d.js` 里的组合 provider：02 走 MMD，鲸鲸走 VRM，其它皮肤可回退 2D 立绘
