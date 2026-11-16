# Darling02（游戏风 02）高保真路线：骨架重建 + 换色 + 对比评估

> 任务来源：`team_task_list` **task-6 Darling02 高保真路线：骨架重建 + 换色 + 对比评估**。
> 输入（只读）：`models/mmd/Darling02/`（模之屋预览管线重建的 PMX，脸/贴图质量优于现用 TDA 版，但骨骼父级乱序、服装偏粉）。
> 产出：`models/final/Darling02_fixed.pmx`（可动画）、`models/final/darling-tex/`（换色贴图）、`tools/darling-fix.py`、`tools/darling-recolor.py`、`tools/darling-verify.py`、`lab/mmd-char.html`（用桌宠真实渲染管线验收的页面）、`shots/darling-*.png`。
> 约束遵守：**未改** `src/3d/mmd-shade.js`、`src/3d/mmdchar.js`、`src/client/engine2d.js`、`src/client/persona.js`；`build.py` 只**追加** Darling 段落（TDA 逻辑原样）；未安装插件包；未 kill 8899 dev server。

---

## 0. 结论（TL;DR）

| 问题 | 答案 |
|---|---|
| Darling02 现在能动画了吗？ | **能**。242 根骨全部重建父级（规则命中 242/242，几何兜底 0 根），根骨骼 1 个、无环；桌宠管线实测「转哪根动哪根、不牵动无关部位」**9/9 用例通过**（修复前 1/9）。 |
| 骨架修复统计 | 标准日文骨名 65 根、`J_*` 命名规则 50 根、`HairJoint-<uuid>` 发丝链 120 根（24 束 × 5 节）、glTF 节点 6 根、根 1 根、**几何兜底 0 根**；172 根有蒙皮权重的骨全部有有效父级。 |
| 颜色改好了吗？ | 大衣贴图红 (129,36,47)→(198,30,40)，**渲染后**大衣 (206,93,103)/(饱和 0.56) → **(250,88,97)/(饱和 0.65)**，已略超过 TDA 版 (245,97,110)/0.61；裤袜渲染 (53,40,52)→(45,36,38)（黑丝）、白鞋去灰粉 (235,211,216)→(237,222,226)。 |
| 值不值得换？ | **值，但不急——本轮结论是「并存」**：Darling 的骨架/配色两个硬伤已经解决，它现在是**可用的高保真备选**；但线上主力仍建议留在 TDA，原因见 §7（切换要动 `engine2d.js`、桌宠小尺寸下画质收益被稀释、表情集比 TDA 少 6 个、身高/取景要重调）。 |
| 需要主 agent 决策的一件事 | 想让桌宠真正用上 Darling，只需改 `src/client/engine2d.js` 里 `MMD_BASE`/`MMD_MODELS`（本轮禁改）——模型侧已经准备就绪：`build.py` 已把 `assets/mmd/Darling02/Darling02_fixed.pmx` 打进包，`mmdchar.js` 无需改动即可加载（骨骼名、物理命名、表情名都已适配）。 |

---

## 1. 输入现状（为什么必须修骨架）

`models/mmd/Darling02/ZeroTwo_GameStyle.pmx`（3.0 MB，28938 顶点 / 40198 面 / 18 材质 / 44 表情 / 242 骨骼）来自「模之屋预览 payload → PMX 重建」：

* `bone.position` 存的是**绝对坐标**；
* `bone.parentIndex` **乱序**：242 根里只有 1 根标准骨的父级正确（`docs/02-MODEL-EVAL.md` §5.6），根骨骼 5 个、27.4% 的骨父级明显低于子骨；
* 头发是 `HairJoint-<uuid>`（120 根）、裙摆/袖子/胸/眼是 `J_Sec_*` / `J_Adj_*`（50 根）——**不是** mmdchar 认识的 `cf_J_hair*` / `スカート_r_c`；
* 贴图路径是 `tex\xxx.png`（反斜杠）。

直接丢进桌宠的表现（`shots/darling-orig-broken.png`）：手臂拧成麻花、裙摆炸开、脚和身体分离——因为 `mmdchar.js` 的待机动画一旋转骨骼，错乱的父子关系就把模型撕开。

### 1.1 一个关键认知：修复 = 只改 parentIndex，**不能**把坐标改成相对坐标

three.js 的 `MMDLoader` 在 `geometryBuilder.build()` 里是这么处理 PMX 骨骼的（见 `vendor/three-vrm.global.js`）：

```js
M.parent !== -1 && (
  M.pos[0] -= e.bones[M.parent].position[0],
  M.pos[1] -= e.bones[M.parent].position[1],
  M.pos[2] -= e.bones[M.parent].position[2]
)
```

也就是说：**loader 把 PMX 里的 position 当绝对坐标，自己减去父骨位置**。所以写回时必须保留 payload 的绝对坐标，只改 `parentIndex`；一旦「好心」转成相对坐标，模型会整体错位。

### 1.2 顺手挖出的 payload 错位规律（只做交叉验证，不依赖它）

payload 的 `parentIndex` 并不是随机噪声，而是**原始 VRM 骨架索引 + 固定偏移**：

* 头发/左半身一带偏移 **+121**：`stored == (真父索引 + 121) % 242`；链头（如 `HairJoint-fd37…`）存的是 `頭(94)+121=215`；
* 右半身/躯干一带偏移 **+60**：如 `右足`(8) 存 67 = `腰`(7)+60；
* 索引 +121 超过 241 时会 wrap（`121` 的 parent 存成 `-1` 而不是 241）——这就是「乱序」的来源。

因为偏移随部位不同且会 wrap，**不能**用「减常数」修；但这条规律可以当交叉验证：按我们重建的父级回推，**119/120 根头发骨**满足 `stored == (parent+121) % 242`（唯一例外是那个 wrap 成 -1 的），说明重建出来的发丝链是对的。

---

## 2. 骨骼重建（`tools/darling-fix.py`）

### 2.1 规则（5 级，命中即有归类，最后一级兜底）

| 级 | 规则 | 命中 | 说明 |
|---|---|---|---|
| A | **标准 MMD 日文骨名表**（本模型实际层级：`センター → 腰 → 上半身/下半身`，`上半身2 → 上半身3 → 首 → 頭`，`肩 → 上半身3`，`腕縺/ひじ/手首`，手指三段链，`足/ひざ/足首/つま先`，`腕捩/手捩`，`目`，`IK`） | **65 根** | 本模型没有 `グルーブ/肩P/肩C/腰キャンセル/操作中心`，所以父级改挂到等价骨（`腰→センター`、`肩→上半身3`、`足→下半身`） |
| B | **`J_*` 命名规则**：`J_Sec_*_Skirt{Front,Back,Side}{0,1,2,_end}` 环链（0 挂 `下半身`）、`J_Sec_*_TipSleeve→手首`、`LowerSleeve→ひじ`、`Bust1→上半身2`、`J_Adj_*_FaceEyeSet→頭`、`J_Bip_*_ToeBase_end→つま先`、`J_Bip_*_{Thumb,Index,Middle,Ring,Little}3_end→对应手指３` | **50 根** | 这类骨名 payload 里没有标准名，只能按命名规律 |
| C | **`HairJoint-<uuid>` 发丝链**：同一束在骨骼表里 index 连续、Y 严格递减、束与束之间头部的 Y 抬升 > 4；据此切束 → 束根挂 `頭`，其余挂上一节 | **120 根 = 24 束 × 5 节** | 不依赖 uuid 内容；切完自动校验「每束 5 节 + Y 单调」 |
| D | **glTF 节点骨**：`Root→全ての親`、`Body/Face/Hairs/secondary→Root`、`Hair001→Hairs` | **6 根** | 无蒙皮的层级骨 |
| E | **几何兜底**：按绝对坐标找「最近的、不低于自己的、已定位骨」 | **0 根** | 本模型规则已 100% 覆盖 |

> 根：`全ての親` 是唯一根（parent = -1）。修复前后无环（脚本内置防环 + `json2pmx.sanitize_bones` 双保险）。

### 2.2 统计（`tools/darling-fix.py` 输出原文）

```
骨骼数: 242
  规则命中: {'std': 65, 'jsec': 50, 'hair': 120, 'gltf': 6, 'root': 1}
  头发束: 24 束 / 每束 [5]
  改动父级: 242/242 根
  改前: 根 5 / 最大深度 20 / 父骨明显低于子骨 65 根 / 未定位 0
  改后: 根 1 / 最大深度 14 / 父骨明显低于子骨 3 根 / 未定位 0
  坐标不一致: 0 根 / 父级不一致: 0 根
  复验通过 ✓
```

* 「父骨明显低于子骨」剩 3 根都是**正常结构**：`全ての親`（原点根骨）、`センター`（MMD 标准里就在腰下方）、`両目`（MMD 的视线骨，位置在头顶上方）。
* 与 `tools/mmd-fix-skeleton.py`（TDA 版）同一口径（128 条标准表）：模型里有 **61 根**标准名骨，其中 **51 根**在本模型能找到同名父骨 → **修复前 1/51 正确 → 修复后 51/51 语义正确**（48 根与 TDA 表逐字一致，3 根为有意偏离：`首→上半身3`（UpperChest，比 TDA 表的 `上半身2` 更符合本模型层级）、`左右目→J_Adj_*_FaceEyeSet`（眼球调整骨，比直接挂 `頭` 更贴合原始 VRM 骨架））。
* **有蒙皮权重的 172 根骨全部有有效父级**（修复前其中有乱序/根骨）。

### 2.3 行为验收（不靠肉眼）：`tools/darling-verify.py`

验收页 `lab/mmd-char.html` 会把指定骨骼的**世界坐标**写进 `window.__LAB.probe`；脚本对 9 个用例各跑一次页面（同一待机姿势、仅额外旋转一根骨），比对探针位移：

| 用例 | 旋转 | 应动 | 不应动 | 修复前 | 修复后 |
|---|---|---|---|---|---|
| 左腕 | z+1.2 | 左ひじ 5.67 / 左手首 **11.16** | 右半身/头/脚 0.000 | ❌ 左手首 0.00，杂散位移 0.17 | ✅ PASS |
| 右腕 | z-1.2 | 右ひじ 5.67 / 右手首 11.16 | 同上 0.000 | ❌ 0.00 / 0.062 | ✅ |
| 左ひじ | z+1.0 | 左手首 3.23 | 躯干/脚 0.000 | ❌ 0.00，**异常位移 7.37** | ✅ |
| 右手首 | x+0.9 | 右親指１ 0.30 / 右中指１ 0.64 | 头/身体/另一只手 0.000 | ❌ 0.00 | ✅ |
| 首 | x+0.5 | 頭 0.56 / 両目 5.59 | 躯干/手/脚 0.000 | ❌ 0.00 | ✅ |
| 頭 | x+0.4 | 头发（`cf_J_hair_00_02`）0.34 | 首/躯干/手 0.000 | ❌ 0.00，异常 2.46 | ✅ |
| 上半身 | z+0.45 | 頭 2.73 / 首 2.22 | 双脚 0.000 | ❌ 0.00 | ✅ |
| 下半身 | z+0.35 | 左足/右足 0.62 | 头/上半身 0.000 | ⚠️ 0.11~0.15（误判） | ✅ |
| 左足 | x+0.5 | 左ひざ 2.72 | 右腿/上半身 0.000 | ❌ 0.06 | ✅ |

**修复后 9/9 通过；原始乱序模型 1/9**（明细见 `docs/darling-skeleton-verify.json`，截图见 §6）。

### 2.4 物理命名适配（让现有 mmdchar 的头发/裙摆物理直接生效）

`mmdchar.js` 用名字识别物理骨：`/^cf_J_hair/` 与 `/^スカート_(\d+)_(\d+)$/`。修复脚本把：

* 120 根 `HairJoint-<uuid>` → `cf_J_hair_SS_JJ`（SS=第几束 00~23，JJ=第几节 00~04），原始 uuid 名写进 `englishName` 保留溯源；
* 24 根 `J_Sec_*_Skirt*` → `スカート_ring_col`（ring 0~3、col 0~5 对应前/后/侧 × 左/右）。

骨名只影响 mmdchar 的识别与调试，**骨骼索引不变 → 蒙皮零影响**。效果（`lab/mmd-char.html` 状态栏 / `--info`）：

| | TDA（现用） | Darling02 修复版 |
|---|---|---|
| 骨骼 | 322 | 242 |
| mmdchar 识别到的头发骨 | 47 | **120** |
| mmdchar 识别到的裙摆骨 | 150 | **24** |

### 2.5 表情名适配（可选，默认开启）

Darling 的表情是 VRM 表情名，mmdchar 的 `EXPR` 表按 MMD 标准名找，原始只有 `まばたき` + `あいうえお` 能对上（6/18）。修复脚本把 7 个有对应语义的表情改名（表情索引不变）：

`喜→笑い`、`驚→びっくり`、`哀→困る`、`楽→なごみ`、`ウィンク２→ウィンク`、`ｳｨﾝｸ２右→ウィンク右`、`怒→怒り`

→ mmdchar 可用表情名 **6/18 → 12/18**（眨眼/笑/惊讶/困/平静/单眨眼/口型齐全）；`照れ`（脸红）/`はぁと`/`horns +`/`ぺろっ`/`にやり`/`じと目` 源模型没有对应 morph，保持缺失（不额外加表情）。效果见 `shots/darling-expr-happy.png`、`shots/darling-expr-pat.png`（张嘴笑；眨眼 `まばたき` 原生可用）。

---

## 3. 贴图换色（`tools/darling-recolor.py`）

### 3.1 为什么不能直接「把大衣涂成目标红」

先测了桌宠真实管线（`mmdchar` + `mmd-shade` + `stage`）里贴图与渲染的关系：**渲染结果比贴图亮一档且发粉**（大衣贴图 R≈148 → 渲染 R≈206，G/B 也被抬高；`shots/darling-fixed-front.png` 与贴图 `f00_002_01_tops_01_cloth.png` 对比可见）。排查过程：

* 材质 `ambient`（VRM 导出的偏蓝值 0.81/0.84/0.97）**实测无效**——把衣服材质 ambient 从 (0.81,0.84,0.97) 压到 (0.42,0.43,0.50) 后渲染采样**逐像素不变**（`MMDToonMaterial` 不使用 PMX ambient 作 emissive），所以**颜色只能在贴图上补偿**；
* `matcap_rim.png` 是「黑圆 + 棕边 + 灰底」的球面贴图，球面采样只落在内切圆内（灰底不会被采样），也不是发粉主因；主因是 `mmd-shade` 的赛璐璐边光/高光 + 多灯把红通道推饱和、把 G/B 抬起来。

因此换色按**渲染后采样标定**：目标不是「贴图颜色」，而是「渲染后颜色接近 TDA / 2D 立绘」。

### 3.2 三张主贴图的处理（只动颜色；文件名/尺寸/mode/alpha 全部保持）

| 贴图（材质） | 处理 | 贴图统计（改前→改后） | 渲染统计（改前→改后，TDA 对照） |
|---|---|---|---|
| `f00_002_01_tops_01_cloth.png`（大衣/短裙/领子/肩章，6144×2048 RGBA） | 红像素 R×1.34（深红褶皱 ×1.15 额外提亮）、G×0.84、B×0.86；白领/金章/藏青垫肩/蓝扣/白滚边**不碰** | 红区均值 (129,36,47)→**(198,30,40)**，中位 (148,39,49)→(228,32,42) | 大衣 (206,93,103)/饱和 0.563 → **(250,88,97)/0.646**；TDA (245,97,110)/0.607 |
| `f00_002_02_body_00_skin.png`（皮肤/裤袜/短裙，6144×2048 RGBA） | 只处理「暗且偏蓝」的像素（max<92 且 B>R-6）：去蓝 → 中性黑并再压暗 0.72；**皮肤像素一个都没动** | 裤袜/短裙区去蓝压黑 | 裤袜 (53,40,52) → **(45,36,38)**；TDA (85,72,82) |
| `f00_002_01_shoes_01_cloth.png`（白鞋，1536×512 RGBA） | 白色像素提纯（min>168 → 取 max 通道 ×1.04、封顶 250、蓝 +2），去灰粉 | 白面封顶 250 | 鞋 (235,211,216) → **(237,222,226)**；TDA 白靴 (241,229,220) |

其余 18 张（脸/眉/眼线/虹膜/眼白/高光/嘴/睫毛/头发 4 张/后发/领带/球面贴图）**逐字节原样复制**——「头发保持粉、皮肤/眼睛不动」这条约束是硬性满足的（脚本对每张都校验 `alpha_identical=true`）。

* 复现：`python3 tools/darling-recolor.py`，输出 `models/final/darling-tex/tex/`（**镜像 PMX 里的 `tex/xxx.png` 相对路径**，这样才能被 build 按相对路径覆盖），并写 `manifest.json`（每张的 mask 像素数/尺寸/mode/alpha 一致性/大衣红区前后统计）+ `shots/darling-tex-*.png` 纹理 before/after 对比图。
* 所有可调参数集中在脚本顶部 `COAT` / `DARK` / `SHOES` 常量，方便再标定。

### 3.3 没做的 / 做不到的

* **黑短裙仍在**：立绘是红色连衣裙，Darling 是「红大衣 + 黑短裙」。短裙和裤袜在贴图上连成一片、UV 岛相邻，本轮没做分割改色（风险 > 收益），保留几何原样。
* **白球鞋不是靴**：换色只能把白色提纯；「球鞋→靴」是几何差异，改不了。
* 红色眼线（02 标志性）：源模型没有这条贴图，Darling 只有眼周淡红晕；要补需要像 TDA 那样在 `face/eyeline` 贴图上画（本轮未做，见 §7 后续可选项）。

---

## 4. 构建集成（`build.py` 只追加一段）

在 `write_assets()` 末尾追加（TDA 段落一行未改）：

```python
# MMD 备选：Darling02（游戏风 02）—— 骨架修复版 PMX + 可选换色贴图
# 只在 models/final/Darling02_fixed.pmx 或 models/final/darling-tex 存在时生效，不影响 TDA。
...
    assets/mmd/Darling02/Darling02_fixed.pmx   ← models/final/Darling02_fixed.pmx
    assets/mmd/Darling02/tex/*                 ← models/mmd/Darling02/tex/*（原贴图）
    再按相对路径覆盖 models/final/darling-tex/*（换色贴图）
```

* 运行结果：`+ Darling02 换色贴图 21 张` / `built v2.5.0 … assets 20`。本任务往 `build.py` 只追加了这一段，`src/` 一行没动，所以 `client.js` 体积在改动前后一致（1,594,501 B）；**之后**并行任务（voice）会往 `src/`/`build.py` 的 RAW 数组加文件，那之后的体积变化与本任务无关。
* 回归：`/preview/?pkg=zero02-pet&z02debug=1&skin=onee` 仍正常加载 TDA（`__z02.get3d().ready('onee') === true`，`char.type === "mmd"`）——**插件线上行为零变化**，Darling 只是「可用的备选资产」。
* 注意：`engine2d.js` 的 `MMD_BASE` 仍指向 `mmd/TDA-ZeroTwo/`（本轮禁改）。将来要接 Darling：把 `MMD_BASE` 换成 `.../mmd/Darling02/`、三个 `url` 换成 `Darling02_fixed.pmx` 即可，`mmdchar` 无需改。

---

## 5. 验收用的新工具：`lab/mmd-char.html`

原来的 `lab/mmd-preview.html` 是「MMDLoader 直出」：灯光很亮（环境 0.9 + 两盏方向光 1.6/0.6）→ 红大衣被推成粉白、没有赛璐璐质感、没有头发/裙摆物理、没有待机动画，**它的画面不代表桌宠实际效果**（这也是最初 `docs/02-MODEL-EVAL.md` 把 Darling 判成「粉色大衣」的部分原因）。

新页面把插件真正在用的 4 个模块原样加载（`kit` + `stage` + `mmd-shade` + `mmdchar`，浏览器里 fetch + 极小 `__def/__req`），所以画面/动画/物理/取景和桌宠一致：

```
http://127.0.0.1:8899/lab/mmd-char.html?base=<URL编码的基础目录>&file=<PMX>&t=1.5
```

支持的参数：`state=`（idle/pat/happy/talk/sleep/eat…）、`t=`（预演秒数，冻结保证可复现）、`bone=左腕=0,0,1.2;…`（手动摆骨）、`probe=`（探针骨骼世界坐标）、`az/el/zoom/camY/distK`（机位）、`armIdle/armForwardX/headScale/idleWave`（mmdchar 配置）、`shade=anime|soft|off`、`yaw=`、`freeze=0`。
截图：`node tools/shot.mjs --url "..." --out shots/x.png --size 480x800 --wait 2400 --ready "window.__LAB_READY"`。

---

## 6. 对比评估：TDA（现用）vs Darling02（修复+换色）

同一条渲染管线、同机位、同待机动画（t=1.5s，`shots/darling-compare-front.png`）：

| 维度 | TDA-ZeroTwo（现用） | Darling02（修复版） | 谁更好 |
|---|---|---|---|
| 脸型/五官 | 标准 TDA 娃娃脸，偏通用 | 小下巴、五官比例最接近立绘（原评估 4.5 vs 3.5） | **Darling** |
| 眼睛 | 虹膜最平（300×300），无红色眼线 | 虹膜 3072×512 渐变+高光，青绿眼最好看；仍无红色眼线 | **Darling** |
| 头发 | 47 根细发束 + 256px 贴图（增强后接近 4.0） | 120 根发束、1536/3072 贴图，层次清楚，但整体偏「白粉」（源模型发色浅） | 平手（TDA 发色更准） |
| 衣服 | 红大衣+白领+橙领带+黄肩章+**黑长袜+白靴**，与立绘一一对应 | 换色后红大衣+白领+橙领带+肩章都已到位，**黑短裙仍在、白球鞋不是靴** | **TDA** |
| 贴图分辨率 | 11.3 MPx | **47.5 MPx** | **Darling** |
| 可动画性 | 322 骨、123/123 标准父级、物理 47+150 | 242 骨、**修复后 51/51 标准父级**、物理 **120+24** | TDA 更细，Darling 够用 |
| 表情兼容（mmdchar EXPR） | 高（TDA 是标准 MMD 表情集） | 中（改名后 12/18，缺脸红/爱心眼/角） | **TDA** |
| 身高/取景 | 19.69（已经调好 camera/headScale） | 24.29（接 app 要重调取景与 Q 版头身比） | **TDA** |

截图清单：

| 文件 | 内容 |
|---|---|
| `shots/darling-compare-front.png` | **TDA vs Darling（修复+换色）正面对比** |
| `shots/darling-compare-face.png` | 脸部特写对比（Darling 的脸/眼明显更精致） |
| `shots/darling-compare-skeleton.png` | **骨架修复前后**（左：撕开；右：正常站姿） |
| `shots/darling-compare-recolor.png` | 换色前后（大衣红/黑丝/白鞋） |
| `shots/darling-compare-pose.png` | 同一 `happy` 动画状态 + 3/4 机位 |
| `shots/darling-fixed-front.png` / `darling-fixed-face.png` / `darling-fixed-pose.png` | Darling 成片 |
| `shots/darling-tda-front.png` / `darling-tda-face.png` / `darling-tda-pose.png` | TDA 对照（同管线同机位） |
| `shots/darling-orig-broken.png` / `darling-fixed-front-before-recolor.png` | 修复前 / 修复后未换色 |
| `shots/darling-pose-{arm,elbow,head,wrist}.png` | 摆骨验收（抬臂/弯肘/低头/转手腕） |
| `shots/darling-expr-{happy,pat,wink}.png` | 表情验收（`笑い` 生效=张嘴笑；源模型的单眨眼 morph `ｳｨﾝｸ２右` 变形较弱，wink 只有轻微变化） |
| `shots/darling-tex-*.png` | 3 张主贴图的纹理级 before/after |
| `shots/darling-pose-*-*.png`（`tools/darling-verify.py --shots`） | 9 个验收用例的整套截图 |

---

## 7. 结论：值不值得换 / 怎么并存

**模型侧的两个硬伤都已经解决**（骨架可动画、配色接近 02），所以答案从「不值得（原评估：迁移成本高、骨架修不动）」变成「**值得，但现在先并存**」：

* **建议并存（推荐）**：线上主力继续 TDA-ZeroTwo（零风险、表情/取景/裙摆物理都已调好）；Darling 修复+换色版作为**高保真备选**放在 `assets/mmd/Darling02/`，`lab/mmd-char.html` 随时可以看效果。想「升级脸部」时再切，不必重做模型工程。
* **只在这几种情况下值得立刻切**：① 桌宠要放大（近景/合影/大屏），脸和虹膜的画质差距才明显；② 想要更「游戏风」的干净脸部；③ 后续要给 Darling 补红色眼线/红裙（贴图还有大量余量，47.5 MPx 很耐改）。
* **不建议现在切**：① 切模型要改 `src/client/engine2d.js`（本轮明令禁改）；② 桌宠默认尺寸（~200px 高）下，Darling 的脸部优势被稀释，而「黑短裙/球鞋」以及「缺脸红爱心眼」反而更容易被看出来；③ 身高 24.29 vs 19.69，`camera`/`headScale`/Q 版头身比要重调，属于另一轮工作量（约 0.5 人日）。

### 后续可选项（按性价比排序）

1. **接进 app**（0.5 人日）：`engine2d.js` 改 `MMD_BASE` + 3 个 url → `Darling02_fixed.pmx`，按 24.29 身高重调 `camera`/`headScale`；用 `lab/mmd-char.html?state=...` 逐状态验收。
2. **补 02 标志性红眼线**（0.5 人日）：在 `f00_000_00_faceeyeline_00_face.png` / `face_00_skin.png` 上画外眼角红色眼线（TDA 版已有同类脚本 `tools/enhance-textures.py` 的 `EYE_LINE_*` 参数可复用），这张贴图 3072×256 空间充足。
3. **黑短裙改红**（0.5 人日）：需要精确定位 body 贴图里短裙 UV 岛（本轮试过按 y 分带 + 连通域，短裙与裤袜在 UV 上连成一片，得做三角形级栅格化遮罩才能干净分割）。
4. **表情补齐**（1 人日）：给缺失的 `照れ/はぁと/horns +` 做 morph（可用 `J_Adj_*` 眼/眉骨 + face 贴图叠加实现脸红、爱心眼），或在 `mmdchar` 的 `EXPR` 里加 Darling 专属别名（需改 `mmdchar.js`，本轮禁改）。

---

## 8. 复现步骤

```bash
cd .

# 1. 重建骨架（输出 models/final/Darling02_fixed.pmx + 复读校验 + 目标 JSON）
python3 tools/darling-fix.py
#    可选：--no-rename（保留 HairJoint-uuid 原名）/ --no-morph-alias / --from-json 缓存

# 2. 换色（输出 models/final/darling-tex/tex/* + manifest.json + 纹理对比图）
python3 tools/darling-recolor.py

# 3. 打包（Darling 段落会自动把 PMX + 原贴图 + 换色贴图放进 assets/mmd/Darling02/）
python3 build.py

# 4. 行为验收（9 用例 × 修复前后，写 docs/darling-skeleton-verify.json）
python3 tools/darling-verify.py --target both
#    --shots 还会把每个用例截图到 shots/

# 5. 截图（示例：Darling 正面；TDA 同理换 base/file）
NODE=~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node
BASE=$(python3 -c "import urllib.parse;print(urllib.parse.quote('/api/zero02-pet/assets?f=mmd/Darling02/', safe=''))")
$NODE tools/shot.mjs --url "http://127.0.0.1:8899/lab/mmd-char.html?base=$BASE&file=Darling02_fixed.pmx&t=1.5" \
  --out shots/darling-fixed-front.png --size 480x800 --wait 2400 --ready "window.__LAB_READY"
```

### 环境/依赖
* python：`~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3`（PIL + numpy）
* node：`~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node`；PMX 解析用 `/tmp/mmdparser.js`（可用 `MMD_PARSER` 环境变量覆盖）
* dev server：`http://127.0.0.1:8899`（`python3 tools/serve.py`，本轮未 kill）

## 9. 已知限制 / 坑

1. **不要**把 PMX 骨骼 position 转成相对坐标（见 §1.1）——写回必须是绝对坐标。
2. 骨名改名只影响 mmdchar 的识别，骨索引不变；但**别改骨骼索引**（蒙皮/刚体/IK/表情都按索引引用）。
3. `MMDToonMaterial` 不消费 PMX 的材质 `ambient`（实测），想让衣服颜色变只能改贴图（或改 `mmd-shade`，本轮禁改）。
4. `lab/mmd-preview.html` 的灯光偏亮，会高估「发粉」程度；**验收请用 `lab/mmd-char.html`**（桌宠真实管线）。
5. Darling 比 TDA 高 23%（24.29 vs 19.69），两个模型都按身高取景所以对比图看起来同高，但接 app 后 `height/headScale/camera` 要重算。
6. `models/final/Darling02_fixed.model.json` 是修复脚本的中间产物（mmd-parser 结构，可复现/二次加工），不会被 build 打进插件包（build 只拷 `*.vrm`）。

---

## 10. 第 2 轮打磨（2.7.0）：发丝孔洞修复 + 接入实验开关

**发丝孔洞**：Darling02 头发是 alpha 卡片，在桌宠管线里出现孔洞/条纹。修复方式：在重建 PMX 时把头发材质改为
`alphaTest≈0.35 + depthWrite=true + 非 transparent`（写进 PMX 材质 flag），lab 里正/背/侧三视角都变成实心发片。
修复前后对比：`shots/darling2-hair-orig-front.png` vs `shots/darling2-hair-fixed-front.png`（正/侧/背三张）。

**接入方式**：`src/client/engine2d.js` 的 `buildMmdModels()` 支持 `S.modelHd` 分支（Darling 用
`assets/mmd/Darling02/Darling02_fixed.pmx`，身高 24.29 由包围盒自适应取景，手臂姿势单独适配 A-pose）。
设置面板「02 的 3D 模型（实验）」可在 经典 TDA / 游戏风 Darling 之间切换，切换会重建 3D（约 1~2 秒加载）。
默认仍是 TDA；实验选项标注了「造型是黑短裙+白球鞋」。

**当前差距（若要转正）**：黑短裙→红裙（需三角形级 UV 遮罩）、白球鞋→白靴（几何不可改）、
`照れ/horns +` 等表情缺失、脸部默认表情略僵。约 1 人日。

---

## 11. 第 3 轮（造型向 02 靠拢）：红裙/白靴/红眼线 + 表情可行性

> 目标：让 Darling 配得上 02 的造型。按「黑短裙→红裙 > 白球鞋→白靴 > 红眼线 > 表情补齐」优先级做。
> 全部改动可复现：`tools/darling-recolor.py`（贴图）、`tools/darling-hem-cap.py`（内衬几何）、`python3 build.py`。

### 11.1 第 1 项：黑短裙 → 02 红裙（重点，结论有反转）

**先按要求做了三角形级 UV 栅格化遮罩**（`tools/darling-recolor.py` 的 `build_skirt_mask()` / `recolor_skirt()`）：
从 `Darling02_fixed.model.json` 里取 Tops 材质（mat 9）的面，把「三个顶点都采样到贴图近黑」的
**156 个面**在 UV 空间按三角形栅格化 → mask（100,649 px，膨胀 3px）→ 只在 mask 内把近黑像素换成 02 红
（`(206,30,44)`，上亮下暗渐变），改色 87,552 px。**技术上跑通了，但渲染画面几乎没变化。**

**根因排查（重要，改变了结论）：那块「黑短裙」根本不是贴图。**

| 实验 | 结果 | 说明 |
|---|---|---|
| 把 Tops 贴图**整张涂绿**再渲染 | 连衣裙全绿，**黑裙区域仍是 (54,34,62)** | 该区域不采样 Tops 贴图 |
| 隐藏 mmd-shade 生成的**描边壳**（inverse hull） | **黑裙区域消失**，裙摆干净收口 | 黑裙 = 描边壳 |
| 描边色 `0x3a2431` = (58,36,49) | 黑裙区域实测 (54,34,62)（叠加背景 glow） | 颜色完全对上 |
| 相机抬高 `elevation` 0.05 → 0.42 | **黑裙完全消失，整条裙子全红** | 相机略低于裙摆时，会通过裙摆底部开口看到**内侧的描边壳背面** |
| 把描边宽度 uniform 置 0 | 无变化 | 不是宽度问题，是壳的背面本身露出来 |

**结论**：Darling 的红大衣下摆是「开口的裙摆」；默认桌宠机位（`elevation 0.05`）略低于/平于裙摆，
视线穿过开口看到描边壳背面 → 视觉上像一条黑短裙。**这不是贴图问题，改色无法解决**（已保留 mask
重绘作为“万一有黑贴图区域”的兜底，但真正起效的是下面的两条）。

**PMX 侧缓解（已实装）**：`tools/darling-hem-cap.py` 把裙摆下半部分的 220 个三角形复制一份、
向中轴收缩 0.90、抬高 0.05 作为**红色内衬**（+138 顶点 / +220 面，UV 沿用原裙 UV，蒙皮权重抄自原顶点，
跟随裙摆骨骼）。从下方低角度看时，开口里能看到红色内衬；但默认机位仍以描边壳为主，缓解有限
（`shots/darling3-compare-skirt.png`）。

**推荐修法（参数级，不需要改 src/）**：把 Darling 的 `camera.elevation` 从 `0.05` 提到 **`0.35 ~ 0.45`**。
实测 `0.42` 时黑裙完全消失、整条裙子全红（`shots/darling3-skirt-clean.png`），观感和 02 的红连衣裙一致。
这是 `src/client/engine2d.js` 里 `buildMmdModels()` 的 hd 分支 `common.camera` 一行参数的事
（本轮约束不改 src/，留给主 agent 决策）。

### 11.2 第 2 项：白球鞋 → 白靴配色（完成）

`f00_002_01_shoes_01_cloth.png`：橙色饰边/彩色块（8,314 px）→ 白系（保留明暗），
深蓝鞋底/袜口（327,695 px，含透明像素）→ 中性深灰 `(58,58,62)`，白色鞋面再提纯（封顶 250 + 微冷调）。
渲染对比：`shots/darling3-compare-boots.png`（几何不变，仍是球鞋形状；配色上已经是「白靴 + 深灰鞋底」）。

### 11.3 第 3 项：02 标志性红眼线（完成）

`f00_000_00_faceeyeline_00_face.png`（1024×256 有效区，左右两条**镜像** strip）：
1. 把贴图里已有的暗红眼线（7,052 px，原色 (205,86,63) 偏橙）提成 02 鲜红 `(232,20,58)`，保留明暗；
2. 沿上睫毛**外眼角**补一段上扬的红色眼线（用一串渐变半径圆点画，实测左 strip 外眼角在 x≈108，
   另一条由 x → 1024-x 镜像，所以**两只眼同时生效**）。
渲染对比：`shots/darling3-compare-eyeliner.png`（外眼角红线清晰可见，且左右对称）。

### 11.4 第 4 项：表情补齐（可行性结论 + 剩余方案）

先确认了 `MMDLoader` 的能力边界（`vendor/three-vrm.global.js` 的 geometryBuilder）：
**只有 vertex morph（type 1）和 group morph（type 0）会被转成 morphTarget**；
**UV morph（type 3）和 material morph（type 8）会被解析但不会生效**。所以：

| 目标表情 | 能不能只改 PMX morph | 方案与代价 |
|---|---|---|
| `horns +`（角加长） | ✅ 可以 | 角 = `Hair_04` 材质（mat 7，128 面/140 顶点，y 23.43~23.76）；写一个顶点 morph，按 y 梯度把角尖向上/外推 ~0.35。约 1 小时，含验证 |
| `照れ`（脸红） | ❌ 不行（UV/mat morph 不生效） | 方案 A：贴图永久加腮红（所有状态都脸红，不推荐）；方案 B：加「隐藏腮红面片 + 顶点 morph 位移」——在颅内藏两片贴红色贴图的腮红片，morph 把它们移到脸颊表面；MMDLoader 支持顶点 morph，所以能生效。约 0.5 人日 |
| `はぁと`（爱心眼） | ❌ 不行（同上） | 同方案 B：在颅内藏两片「爱心瞳孔」面片（贴图里画红心），morph 位移到眼前同时把原瞳孔顶点后移。约 0.5 人日 |

本轮时间用于前 3 项（尤其黑裙根因排查），**morph 只给出方案与代价、未实装**（避免收尾阶段改 PMX 几何引入风险）。
另：`照れ` 缺失时 `mmdchar` 的「害羞脸红」只是少一层表情，不影响骨骼/动作。

### 11.5 第 3 轮截图清单（`shots/darling3-*.png`）

| 文件 | 内容 |
|---|---|
| `darling3-compare-skirt.png` | **黑短裙对比**：默认机位（像黑短裙）vs elevation=0.42（全红下摆，黑裙消失） |
| `darling3-skirt-default.png` / `darling3-skirt-clean.png` | 上面两张的原图 |
| `darling3-compare-boots.png` | 白球鞋 → 白靴配色前后（含深灰鞋底） |
| `darling3-compare-eyeliner.png` | 02 红眼线前后（双眼外眼角） |
| `darling3-front.png` / `darling3-face.png` / `darling3-legs.png` | 第 3 轮成片（全身 / 脸部 / 腿+鞋） |
| `darling3-showcase.png` | 全身+脸部拼图 |
| `darling3-hide-outline.png` / `darling3-hide-mat9.png` / `darling3-matid-front.png` | 根因排查证据（隐藏描边壳 / 隐藏 Tops 材质 / 材质分色） |
| `darling3-eyeliner-{before,after}.png`、`darling3-boots-{before,after}.png`、`darling3-skirt-{default,clean}.png` | 成对原图 |

### 11.6 是否建议把 Darling 设为可选主模型？

**暂时不建议转正，继续做「实验模式」**。理由（按影响排序）：

1. **黑下摆要靠相机参数兜底**：`elevation` 必须从 0.05 提到 0.35+ 才好看，这属于跨模块参数（engine2d.js），
   且抬高相机后构图上仰角变小、桌面小窗里腿会显得短一点，需要和整体 UI 一起调。
2. **表情仍缺 6 个**（照れ/はぁと/horns +/ぺろっ/にやり/じと目），02 的「害羞/爱心眼/角」是灵魂表情；
   补齐要 1~1.5 人日（见 11.4）。
3. 几何仍是「短裙 + 球鞋」形状，配色到位但剪影和 02 的军装大衣有差距。
4. 反过来说，**如果只做「脸/近景」用途**（聊天面板、合影、大图壁纸），Darling 已经完全可用：
   这轮之后红大衣、黑丝、白靴、红眼线的配色都到位了，脸/眼的精度明显高于 TDA。

---

## 12. 第 4 轮：补齐缺失表情（顶点 morph 实装）

> 第 3 轮结论：`MMDLoader` 只把 **vertex morph（type 1）** 转成 morphTarget，UV/material morph 不生效。
> 本轮用「顶点 morph + 小面片」把缺的三个表情实装进 PMX，**mmdchar.js 零改动**（名字与它 EXPR 表完全一致）。
> 工具：`tools/darling-morphs.py`（可复现；必须在 `darling-fix.py` → `darling-hem-cap.py` 之后跑）。

### 12.1 实现方式

| 表情（MMD morph 名） | 类型 | 实现 | 验证 |
|---|---|---|---|
| **`horns +`** | 顶点 morph | 角 = `Hair_04` 材质（mat 7，140 顶点）；以「头带根部」为基点把角几何放大 `1.65×`（`new = base + (v-base)*1.65`），角尖位移 ≈ **0.34**（模型单位），根部不动 | `shots/darling4-compare-horns.png`：角明显变长/外张 |
| **`照れ`**（脸红） | 顶点 morph + 2 片腮红面片 | 新增**透明材质** `darling_blush` + 新贴图 `tex/darling_blush.png`（256² RGBA 透明底红色径向渐变，alpha 峰值 205）；2 片 0.56×0.56 面片平时藏在颅内 `z=-0.55`（不可见），morph 把它们移到脸颊表面外 `z=-1.24`（`(±0.70, 21.36)`） | `shots/darling4-compare-face-morphs.png`：双颊出现柔和红晕 |
| **`はぁと`**（爱心眼） | 顶点 morph + 2 片爱心面片 | 新增透明材质 `darling_heart` + 贴图 `tex/darling_heart.png`（红心 + 高光）；2 片 0.46×0.46 面片藏在颅内，morph 移到虹膜前 `z=-1.21`（`(±0.55, 21.96)`） | 同上图：双眼变成红色爱心眼 |

技术要点（都实测过）：
* 面片顶点必须**真实存在于顶点数组且有蒙皮权重**——两片面片各 4 顶点，`type=0`（BDEF1）、权重 1.0 绑 `頭` 骨，所以会跟头一起动；
* 面片材质用 **diffuse alpha = 0.995**（≠1）→ MMDLoader 判定 `transparent=true`，alpha 贴图生效；
  同时 `classify()` 会把它归为 `transparent` → **不加边光/描边**，不会出现一圈黑边；
* `flag=15`（双面、无描边位）、`toonFlag=1`（内置 toon）、`envTextureIndex=-1`；
* 面片朝 `-z`（模型正面），双面材质所以不用担心绕序；面片作为新材质的 face group 追加在面列表末尾，
  材质顺序/面范围保持连续（PMX 要求），骨架/蒙皮/既有 morph 索引全部不变；
* 新材质 2 个（materialCount 18→20）、新贴图 2 张（textureCount 21→23）、顶点 +16、面 +8、morph 44→47。

> 踩坑记录：`json2pmx.write_pmx()` 写材质时按数组长度写 `ambient`，新材质如果给 4 个分量会把 PMX 写歪
> （解析报 `Offset is outside the bounds of the DataView`）。新材质的 `ambient` 必须是 **3 个分量**。

### 12.2 mmdchar 需要改什么？——**EXPR 名字都不用动**

三个 morph 名已与 `src/3d/mmdchar.js` 的 `EXPR` 表逐字一致，**不需要往 EXPR 里加名字**：

```js
// 现有 EXPR 已有：
blush: "照れ",        // pat() 里 applyExprStatic({ smile:0.9, blush:0.85 }) → 会自动显示腮红
heartEyes: "はぁと",   // 目前没有 state 用到
horns: "horns +",     // 目前没有 state 用到
```

**端到端实测**：`state=pat` 时 `mmdchar` 的 `applyExprStatic({smile:0.9, blush:0.85})` 已经把
`照れ` 权重推到 0.85，Darling 脸颊出现红晕 + 张嘴笑（`shots/darling4-pat-blush.png`）——这条**无需任何改动即已生效**。
也就是说：**摸头（pat）现在就会让 Darling 脸红**；`はぁと` / `horns +`
需要在 `EXPR_POSES` 里挂到某个 state（或在 engine2d 里手动触发权重）才会出现——这属于 mmdchar/engine2d
侧接线，本轮不改 src/。验收命令（lab 里手动设权重）：

```
http://127.0.0.1:8899/lab/mmd-char.html?base=<base>&file=Darling02_fixed.pmx&t=1.5&zoom=0.30&camY=21.6
# --eval 里：mesh.morphTargetDictionary["照れ"] / ["はぁと"] / ["horns +"] → morphTargetInfluences[...] = 1
```

### 12.3 截图清单（`shots/darling4-*.png`）

| 文件 | 内容 |
|---|---|
| `darling4-compare-face-morphs.png` | 默认 / `照れ`=1（腮红）/ `はぁと`=1（爱心眼）三连对比 |
| `darling4-compare-horns.png` | `horns +` 0 vs 1（角加长） |
| `darling4-base.png` / `darling4-blush-1.png` / `darling4-heart-1.png` / `darling4-horns-{0,1}.png` | 单张原图 |
| `darling4-pat-blush.png` / `darling4-shy-blush.png` | 端到端：`state=pat` / `state=shy` 时 mmdchar 自动把 `照れ` 推到 0.85 → 脸红（无需改代码） |

### 12.4 剩余差距（表情维度）

* `ぺろっ`（吐舌）/ `にやり`（坏笑）/ `じと目`（半眯眼）仍缺——这些需要**脸部表情 morph**（TDA 版有 56 个表情 morph，
  Darling 源模型只有 VRM 的 Fcl_* 系列，其中 `MTH_*` 嘴部系列可以拿来做「吐舌/坏笑」：
  `はぁと` 的「藏面片 + 顶点 morph」方案同样可复用于舌头（在口腔内藏一片舌头面片），约 0.3 人日；
* 现在可用的表情：`まばたき`、`ウィンク`、`ウィンク右`、`笑い`、`びっくり`、`なごみ`、`困る`、`あいうえお`、
  **`照れ`、`はぁと`、`horns +`** = 15/19（TDA 版 19/19），已覆盖 02 的标志性「脸红 / 爱心眼 / 角」。

---

## 13. 第 5 轮：表情覆盖 15/19 → 19/19（别名 morph + 舌头面片）

> 第 4 轮后已有 11 个标准名表情；本轮把 `にやり` / `にこり` / `じと目` / `ぺろっ` 补齐。
> 全部在 `tools/darling-morphs.py` 里（管线顺序：`darling-fix.py` → `darling-hem-cap.py` → `darling-morphs.py` → `build.py`）。

### 13.1 别名 morph（复制源模型 Fcl_* 的顶点位移，**不改原 morph**）

| 新增标准名 | 来源（源模型 morph × 权重，按顶点合并） | 效果 |
|---|---|---|
| **`にやり`**（坏笑） | `Face.M_F00_000_00_Fcl_MTH_Fun` × 1.0 | 嘴角上挑的闭嘴坏笑 → `shots/darling5-にやり.png` |
| **`にこり`**（微笑） | `Fcl_EYE_Joy` × 1.0 + `Fcl_MTH_Joy` × 0.6 | 弯眼 + 张口笑（权重调过，避免笑太开） → `shots/darling5-にこり.png` |
| **`じと目`**（半眯眼） | `まばたき` × 0.55 + `Fcl_BRW_Angry` × 0.6 | 半闭眼 + 压眉 = 02 的「じとー」不悦凝视；比起源模型任何单个 `EYE_*` 都更像（`EYE_Sorrow`/`EYE_Angry` 实测几乎看不出变化） → `shots/darling5-じと目.png` |

> 实现：`merge_deltas()` 把「源 morph × 权重」的 `{index, position(delta)}` 按顶点索引累加，
> 生成新 morph 的 element 列表（2339 顶点/个，与原 morph 完全同构），源 morph 保持不动（VRM 原始表情仍可用）。

### 13.2 `ぺろっ`（吐舌头）——源模型没有舌头几何，用「舌头面片 + 顶点 morph」

源模型的嘴是**贴图 + 薄面片**（`FaceMouth` 材质，z −1.31~−0.75），没有舌头几何，
所以复用第 4 轮方案：
* 新建透明材质 `darling_tongue` + 贴图 `tex/darling_tongue.png`（256² RGBA，粉色舌头 U 形 + 中缝/高光）；
* 1 片 0.24×0.24 面片（4 顶点、BDEF1 绑 `頭` 骨）平时藏在口腔内 `z≈−0.78`（**默认完全不可见**）；
* 顶点 morph `ぺろっ` 把面片位移到嘴前下方 `(0, 21.12, −1.34)` → 吐舌：`shots/darling5-ぺろっ.png`。

> 注意：舌头面片和嘴部贴图是两个材质，舌头是 transparent 材质、在透明队列里排在后面，
> 所以会正确盖在嘴上面；默认权重 0 时面片藏在头内，出片/截图无任何残留（`shots/darling5-base.png` 已验证）。

### 13.3 最终数字

| 项 | 第 4 轮后 | 第 5 轮后 |
|---|---|---|
| morph 总数 | 47 | **51**（+ にやり / にこり / じと目 / ぺろっ） |
| 材质 / 贴图 | 20 / 23 | **21 / 24**（+ darling_tongue / darling_tongue.png） |
| 顶点 / 面 | 29,092 / 40,426 | **29,096 / 40,428** |
| **mmdchar EXPR 覆盖** | 15/19 键 | **19/19 键全覆盖** |

`EXPR` 表 19 个键 → 18 个唯一 morph 名（`shy` 与 `blush` 共用 `照れ`），全部就位：

```
まばたき / 笑い / ウィンク右 / ウィンク / 照れ / びっくり / なごみ / 困る
あ い う え お / はぁと / horns + / ぺろっ / にやり / じと目
```
另外 `にこり`、`怒り` 也作为额外 morph 存在（`にこり` 目前**不在** mmdchar 的 EXPR 表里，可用但不会自动触发；
如果主线要「微笑」可以直接把 `smile` 指到 `にこり`，或在 EXPR 里加 `nicon: "にこり"`）。

**mmdchar 需要加什么名字？——还是一个都不用加**：`tongue: "ぺろっ"` / `tease: "にやり"` / `jito: "じと目"`
早就在 EXPR 表里，现在 PMX 有同名 morph 就自动可用。唯一可选的接线是把它们挂到状态（例如
`EXPR_POSES.shy` 加 `{jito: 0.6}`、新 state `tease: {tease: 1}`、`eat` 偶尔加 `tongue`）。

### 13.4 截图清单（`shots/darling5-*.png`）

| 文件 | 内容 |
|---|---|
| `darling5-compare-morphs.png` | **默认 / にやり / にこり / じと目 / ぺろっ 五连对比**（lab 里设 `morphTargetInfluences=1`） |
| `darling5-base.png` / `darling5-にやり.png` / `darling5-にこり.png` / `darling5-じと目.png` / `darling5-ぺろっ.png` | 单张原图 |

### 13.5 剩余差距（表情维度：已无）

19/19 EXPR 键全部可用。仍可继续打磨的只有「更好看」而非「缺功能」：
* `にこり` 目前偏「张口笑」，如果想要更含蓄的微笑，可以调 `MTH_Joy` 权重（0.4~0.6）；
* `じと目` 是「半闭眼+压眉」组合，若想要更凶可以再加 `EYE_Angry`；
* 吐舌面片是 2D 贴图卡片，侧脸极限角度会穿帮（正面/3/4 视角无问题），若要全角度完美需要真舌头几何。
