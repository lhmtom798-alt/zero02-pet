# 02 3D 模型评估报告（TDA-ZeroTwo vs Darling02 vs ZeroTwo-Plugsuit）

> 任务：对比 `models/mmd/` 下三套 02 模型，选出最接近动画/项目 2D 立绘的一个，并给出评分与换模型的迁移成本。
> 评估方式：项目自带 lab 预览页（three.js `MMDLoader`）同角度渲染 + PMX/贴图定量分析。
> 只读评估：本报告与 `shots/eval-*.png` 是唯一产物，未改动 `src/`、`build.py`、`models/final`、插件安装。

---

## 0. 结论（TL;DR）

| 名次 | 模型 | 加权总分（满分 5） | 一句话结论 |
| --- | --- | --- | --- |
| **① 推荐** | **TDA-ZeroTwo（当前在用）** | **3.78** | 与项目 2D 立绘的整体造型最接近（红大衣/白领/橙领带/黄肩章/黑丝/白靴全齐），骨架完整可直接动画；短板（粉发偏淡、缺红色眼线、hair 贴图仅 256px）**全部可用贴图增强补齐**。 |
| ② 备选 | Darling02（游戏风） | 3.70 | 面部/眼部贴图最精致、分辨率最高（47.5 MPx），但**缺 02 标志性红色眼线**、下装是黑短裙+灰丝+白球鞋（与立绘不符），且 **242 根骨骼中 241 根父级乱序**，换用需重建骨架。 |
| ③ 排除 | ZeroTwo-Plugsuit（驾驶服） | 2.38 | 是驾驶服而非红大衣制服；292 根全英文骨骼、无 IK/无物理、432 表情全非 MMD 标准名、贴图在 MMDLoader 下发白起斑；迁移成本最高、观感最差。 |

**推荐：继续使用 TDA-ZeroTwo，不换模型。** 把预算投到「TDA 贴图增强」（`docs/02-TEXTURES.md` / task-2）而不是迁移 Darling02：
预计增强后 TDA 的头发/眼睛/面部可再 +0.2~0.3，总分约 **4.0**（渲染风格分），而 Darling02 的服装与骨架短板**无法通过贴图解决**。

---

## 1. 评估对象

| 项 | TDA-ZeroTwo | Darling02 | ZeroTwo-Plugsuit |
| --- | --- | --- | --- |
| 目录 | `models/mmd/TDA-ZeroTwo/` | `models/mmd/Darling02/` | `models/mmd/ZeroTwo-Plugsuit/` |
| PMX | `ZeroTwo_TDA.pmx`（仓库内）/ `test-fixed2.pmx`＝`models/final/ZeroTwo_TDA.pmx`（插件实际加载） | `ZeroTwo_GameStyle.pmx` | `ZeroTwo_ArmorSuit.pmx` |
| 漫游/授权 | 模之屋预览管线重建（aplaybox `kZJ1ITyPybKX`，TDA 改模） | aplaybox `OuIN09PTuJbz`（guruguruguro，游戏三渲二风） | aplaybox `gUQb7LYhmuKD`（cunny / TDA 头 + ChieTheBeKoN） |
| 造型 | 02 经典红大衣制服 + 黑丝 + 白靴 + 红色角 | 红大衣制服（游戏变体：黑短裙 + 灰丝 + 白球鞋） | 红色驾驶服（plugsuit） |
| 授权 | 同人模型，版权归 DARLING in the FRANXX 权利方；仅个人桌面宠物使用，禁止再分发/商用 | 同左 | 同左 |

**目标基准**：项目 2D 立绘 `_assets/onee.webp`（红大衣 + 白领 + 橙领带 + 黄色肩章 + 黑丝 + 白靴；粉发、青绿眼 + **外眼角红色眼线**、红色角 + 白色头带）。3D 形象的目标是向这张立绘靠拢。

---

## 2. 评估方法

### 2.1 渲染（同角度、同尺寸）

- 页面：`http://127.0.0.1:8899/lab/mmd-preview.html`
- 工具：`tools/shot.mjs`（无头 Chrome / CDP），视口 **480×800**，`--wait 2000~3000`，`--ready window.__LAB_READY`
- 三个视角（三模型完全同参数）：
  - **front**：`yaw=0&zoom=1`
  - **3/4 侧**：`yaw=0.5`（≈28.6°）
  - **脸部特写**：`yaw=0`，加载完成后用 `--eval` 把相机对准 `頭` 骨骼（各模型头部位置自动取，见下）
- **公平性**：主评估用 PMX 原始 **bind pose**（不烘焙手臂）；`?bake=1`（项目实际运行时的"手臂放下"烘焙）作为迁移成本证据单独出图（`eval-tda-bake.png` / `eval-darling-bake.png`）。
- 说明：lab 页是裸 `MMDLoader` 渲染（无 `src/3d/mmd-shade.js` 的赛璐璐描边/高光），插件内实际观感会略有差异；本报告比较的是"模型本体"。

脸部特写相机注入（`tools/shot.mjs --eval`）：

```js
(function(){var L=window.__LAB,T=window.THREE;
 var hb=L.boneMap["頭"]||L.boneMap["Head"]||null;if(!hb)return "no-head-bone";
 var p=new T.Vector3();hb.getWorldPosition(p);var bb=L.bbox,top=bb.maxY;
 var faceY=p.y+0.42*(top-p.y);var span=1.30*(top-p.y);
 var dist=span/(2*Math.tan(26*Math.PI/360));
 L.camera.position.set(0,faceY+0.006*bb.h,dist);L.camera.lookAt(0,faceY,0);
 L.camera.updateProjectionMatrix();return{faceY:faceY,dist:dist};})()
```

TDA 使用 `test-fixed2.pmx`（MD5 `f20d2e23…`，与 `models/final/ZeroTwo_TDA.pmx` 完全一致），因为它是 `build.py` 实际打进插件的那一份；`models/mmd/TDA-ZeroTwo/ZeroTwo_TDA.pmx` 是未修骨骼的原始重建文件（见 §6.1）。

### 2.2 定量分析

- **PMX 解析**：`mmd-parser@1.0.4`（`/tmp/mmdparser.js`，由模之屋预览管线还原时使用的同款解析器）读取顶点/面/材质/贴图/骨骼/表情/刚体/Joint。
- **骨骼父级正确性**：以 `tools/mmd-fix-skeleton.py` 的标准 MMD 骨骼父名表（128 条）为基准，对"该骨骼名在表内且父骨骼存在"的骨骼做父子对照；另用「父骨骼不应明显低于子骨骼（>2.5 单位）」做乱序启发式统计。
- **管线兼容性**：对照 `src/3d/mmdchar.js` 依赖的骨骼名（`頭/首/上半身/上半身2/下半身/腰/センター/左右肩/左右腕/左右ひじ`、头发 `cf_J_hair*`、裙摆 `スカート_r_c`）与 `EXPR` 表情名（まばたき・笑い・ウィンク右・照れ・びっくり・なごみ・困る・あいうえお・はぁと・horns +）。
- **贴图**：PIL 统计分辨率、数量、总像素（MPx）、关键贴图（face/hair/eye/coat）清晰度与平均 HSV（头发饱和度）。

---

## 3. 规格对比

| 指标 | TDA-ZeroTwo（final 修复版） | Darling02 | ZeroTwo-Plugsuit |
| --- | --- | --- | --- |
| 顶点 / 面 | 26,193 / 37,823 | 28,938 / 40,198 | 42,927 / 67,136 |
| 骨骼数 | **322** | 242 | 292 |
| 表情 morph | 56 | 44 | **432** |
| 材质 | 24 | 18 | 25 |
| 贴图 | 24 张 / **11.3 MPx** | 21 张 / **47.5 MPx** | 24 张 / 11.9 MPx |
| 物理（刚体/Joint） | **220 / 319** | 224 / 222 | 0 / 0（原作者标注 No physics） |
| IK | 4 | 4 | 0（No IK-support） |
| 骨骼树（父级对照） | **123/123 正确**（修复后） | 1/51 正确（乱序） | 0/0（无 MMD 标准名） |
| 根骨骼数 / 父级低于子骨骼比例 | 1 / **1.2%** | 5 / 27.4% | 2 / 23.4% |
| 头发骨骼 | 47 × `cf_J_hair*` | 122 × `HairJoint-*` / `Hairs` / `Hair001` | 20 × `HairB_*` |
| 裙摆骨骼 | 150 × `スカート_r_c` | 24 × `J_Sec_*_Skirt*` | 0 |
| 管线表情命中 | **15/15** | 6/15 | 0/15 |
| PMX 贴图路径分隔符 | `/`（已规范） | `\`（21 条，需转换） | `\`（24 条，需转换） |
| 模型原始高度（lab bbox） | 19.69 | 24.29 | 19.61 |
| 加载（lab / MMDLoader） | ✅ | ✅ | ✅（材质/贴图观感异常） |

---

## 4. 评分表（1-5 分）与加权总分

| 维度 | 权重 | TDA-ZeroTwo | Darling02 | ZeroTwo-Plugsuit | 评分依据 |
| --- | --- | --- | --- | --- | --- |
| 脸型五官还原度 | 20% | **3.5** | **4.5** | 2.5 | Darling 下巴更尖、五官比例最接近立绘；TDA 是标准 TDA 娃娃脸，偏圆、较通用；Plugsuit 脸长/眼形偏凶、默认无嘴部细节 |
| 眼睛（青绿眼 + 红色眼线） | 20% | 3.0 | 3.5 | **4.0** | 三者都是青绿眼；**只有 Plugsuit 有清晰的红色眼线**；Darling 虹膜细节最好（3072×512 渐变+高光）但无红眼线；TDA 虹膜最平（300×300）且无红眼线 |
| 头发（粉色/层次/高光） | 15% | 3.5 | **4.0** | 2.5 | TDA 发色最接近立绘的浅粉但饱和度低、256px 贴图发糊；Darling 粉发层次/高光最好（1536~3072）；Plugsuit hair 是 512 纯色贴图，渲染偏灰紫、无高光 |
| 服装（红大衣/白领/橙领带/黄肩章） | 20% | **4.5** | 3.5 | 1.5 | TDA 与立绘一一对应（红大衣+白领+橙领带+金色肩章+黑丝+白靴）；Darling 同款式但红色偏淡、下装黑短裙+灰丝+白球鞋；Plugsuit 是驾驶服，无上述要素 |
| 贴图清晰度 | 10% | 3.0 | **5.0** | 2.5 | Darling 47.5 MPx（外套/身体 6144×2048、脸 3072×1024）；TDA 11.3 MPx（脸/身体 1024、hair 256、眼 300）；Plugsuit 11.9 MPx 但发白斑块、hair 512 纯色 |
| 骨骼完整性（能否动画） | 15% | **5.0** | 2.0 | 1.0 | TDA 修复版 123/123 父级正确、1 根骨、4 IK、220 刚体；Darling 241/242 父级错、5 根、发/裙摆骨骼非自定义命名、表情仅 6/15；Plugsuit 全英文骨骼、0 IK/0 物理、表情 0/15 |
| **加权总分** | 100% | **3.78** | **3.70** | **2.38** | `Σ(分×权重)` |

权重设定理由（面向本插件）：服装是桌宠在 200~460px 尺寸下最强的身份识别特征（20%）；脸+眼 40% 决定"像不像 02"；骨架 15%——没有可用骨架模型就完全不能用（"能否动画"是硬需求）；贴图 10%——桌宠显示尺寸小，清晰度收益低于造型。

> 敏感性：三模型差距集中在 TDA 与 Darling02 之间（3.78 vs 3.70，差 ≈2%）。若把「服装」权重下调、「贴图」权重上调，Darling02 会以 <0.1 分反超。因此推荐结论除分数外，**同时依据"红大衣造型 + 现成可动画骨架"这两项项目硬需求**，以及 §6 的迁移成本。

---

## 5. 逐项分析

### 5.1 脸型与五官

- **Darling02（4.5）**：小下巴、五官比例与立绘最接近；面部贴图带柔和腮红/鼻影，整体是干净的三渲二游戏风。`eval-darling-face.png` 中眉、眼、鼻、嘴层次最完整。
- **TDA（3.5）**：标准 TDA 动漫娃娃脸，眼距宽、下巴偏圆，是"通用好看的二次元脸"而不是 02 专属；优点是轮廓干净、描边友好（插件有描边处理）。头带偏银灰，立绘是白色。
- **Plugsuit（2.5）**：脸偏长、眼形上挑偏"凶"，正面默认几乎看不到嘴，皮肤贴图几乎无腮红；与立绘的少女感差距大。

### 5.2 眼睛（02 标志性青绿眼 + 外眼角红色眼线）

- **TDA（3.0）**：`eye1.png` 300×300，青绿虹膜 + 黑色外圈，渲染后眼睛大而干净；但虹膜无渐变细节，**外眼角没有红色眼线**（只有黑色睫毛）。
- **Darling02（3.5）**：`eyeiris` 3072×512，青绿渐变 + 多段高光 + 睫毛细节，是三者里**虹膜质量最高**；但同样**没有红色眼线**（只有眼周淡粉红晕），不满足"02 标志性"的一半。
- **Plugsuit（4.0）**：`cf_m_face_00.png` 中眼睛直接画了**外眼角红色眼线**（渲染图 `eval-plugsuit-face.png` 非常清楚），青绿虹膜也在；但虹膜是 512px 平涂、眼形偏窄，细节最弱。它是三者中**唯一同时满足"青绿眼 + 红眼线"**的。

> 这也是 task-2「TDA 贴图增强」把"外眼角红色眼线"列为核心项的原因：这是 TDA 相对立绘最大的一处缺失，且纯贴图就能补。

### 5.3 头发

- **TDA（3.5）**：发色最准（浅粉，贴近立绘）；47 根 `cf_J_hair` 骨骼 + 大量发片，形态好；但 `hair.png` 只有 **256×256**（多层发片共用一张竖向渐变），渲染发糊、发丝层次与高光弱，整体偏"奶白粉"。
- **Darling02（4.0）**：4 张 1536×1024 + hairback 3072×1024，粉色饱和度和高光带最接近立绘；发束分缝清楚。略偏"高光塑料感"。
- **Plugsuit（2.5）**：20 根 `HairB_*` 骨骼，几何分束还行；但 `hair_tex.png` 是 512×512 **纯色渐变**，MMDLoader 下渲染成灰紫、无高光，是三者中最差。

### 5.4 服装（红大衣/白领/橙领带/黄肩章）

- **TDA（4.5）**：与 `_assets/onee.webp` 几乎一一对应——红大衣（深红）、白领+黑色翻领、橙领带、金色/黄色肩章、双排黑扣、白色滚边、黑丝、白色长靴。仅个别细节简化。
- **Darling02（3.5）**：同款制服但红色明显偏淡偏粉；下装是**黑短裙 + 灰色丝袜 + 白色球鞋**（立绘是黑丝 + 白靴），整体 silhouette 偏离；肩章/领带/扣子都在。
- **Plugsuit（1.5）**：红色驾驶服，没有大衣/白领/橙领带/黄肩章；作为"02 的另一套皮肤"成立，但不符合本插件当前的红大衣形象。且 MMDLoader 下贴图发白起斑（高光/材质参数不匹配），观感受损。

### 5.5 贴图清晰度

| 模型 | 关键贴图分辨率 | 总像素 | 备注 |
| --- | --- | --- | --- |
| TDA | face 1024²、body 1024²、socks 1024²、**hair 256²**、**eye 300²**、sph 500² | 11.3 MPx | 2021 年的 MMD 老资产；hair/eye 分辨率是硬伤（task-2 计划 Lanczos 放大+锐化） |
| Darling02 | **coat 6144×2048、body 6144×2048、face 3072×1024、eyeiris/eyeline/eyewhite 3072×512、hair 1536×1024×4** | **47.5 MPx** | 三者中最高，且命名规范（f00_* 分层：脸/眉/眼线/虹膜/高光） |
| Plugsuit | body 2048²、face 1024²、hair 512²（纯色）、虹膜/眼线 512² | 11.9 MPx | 渲染出现白色斑块（材质/贴图在 MMDLoader 下失配），有效清晰度更低 |

### 5.6 骨骼完整性（含 parentIndex 乱序问题）

三套 PMX 都来自「模之屋预览管线 → PMX 重建」，共同问题是 **payload 的骨骼 `parentIndex` 乱序**（`position` 是对的），当前 `src/3d/mmdchar.js` 依赖正确的骨骼树做动画。

| 模型 | 骨骼数 | 根数 | 父级对照 | 父<子里程碑 | 结论 |
| --- | --- | --- | --- | --- | --- |
| TDA 原始 `models/mmd/TDA-ZeroTwo/ZeroTwo_TDA.pmx` | 322 | 1 | **0/123** | 99/321（30.8%） | 未修，**不可动画** |
| TDA 修复 `models/final/ZeroTwo_TDA.pmx`（=`test-fixed2.pmx`，插件实际加载） | 322 | 1 | **123/123** | 4/321（1.2%） | ✅ 完整可用：4 IK、220 刚体/319 Joint、15/15 表情命中、47 发骨+150 裙摆骨 |
| Darling02 | 242 | 5 | **1/51** | 65/237（27.4%） | ❌ 乱序：需重建；无 `cf_J_hair*`/`スカート_*` 命名；表情仅 6/15 |
| Plugsuit | 292 | 2 | 0/0（无 MMD 标准名） | 68/290（23.4%） | ❌ 乱序 + 全英文命名；0 IK/0 物理；表情 0/15 |

**修复可行性实测**（把 `tools/mmd-fix-skeleton.py` 的 `build_parents()` 逻辑套到 pmx-parser 读出的骨骼上，纯离线计算、不写文件）：

- **TDA**：该工具的标准名表覆盖全部关键链，修复后 1 根骨、无环、父级对照 123/123 —— 这就是当前 `models/final` 的做法，已验证。
- **Darling02**：标准名表仅覆盖 **51/242** 根；其余 **191 根走"最近更高骨骼"兜底**（含 122 根 `HairJoint-<uuid>` / `Hairs` 发丝、48 根 `J_Sec/J_Bip` 系骨骼——其中 24 根是 `J_Sec_*_Skirt*` 裙摆、另 21 根为 `J_Adj`/`Body`/`Face` 等；部分标准名如 `腰/左右足` 因缺少 `グルーブ/腰キャンセル` 父名也不在显式覆盖内）。兜底后无环、1 根骨、父级乱序率从 27.4% 降到 ~1.2%，**树能立起来，但发丝/裙摆链的顺序无法靠名字判断**，需人工校验或新增命名规则；表情/表情名映射还得补。
- **Plugsuit**：标准名表覆盖 **0/292**，全部走位置兜底（兜底后 1 根骨、无环、乱序率 ~0.3%）；即使树修好，所有骨骼名（`Head/Left arm/…`）仍需完整别名表才能被 `mmdchar.js` 使用。

---

## 6. 推荐结论与迁移成本

### 6.1 推荐：继续用 TDA-ZeroTwo（迁移成本 = 0）

理由：
1. **造型最接近项目 2D 立绘**：红大衣/白领/橙领带/黄肩章/黑丝/白靴全齐（服装 4.5 vs Darling 3.5 vs Plugsuit 1.5），这是桌宠小尺寸下最重要的识别特征。
2. **骨架已经修好并在线上跑**：`models/final/ZeroTwo_TDA.pmx`（`build.py` 打包的那份）父级 123/123 正确，头发/裙摆物理、4 IK、56 表情（15/15 管线命中）都可用；`eval-tda-bake.png` 显示手臂烘焙正常。
3. **短板全是"贴图级"短板**：粉发偏淡/层次弱（hair.png 256）、缺红色眼线（face.png）、眼睛虹膜平（eye1.png 300）——task-2 的「贴图美术增强」正好逐项覆盖，且风险为零（不动骨架）。
4. **增强后预期收益**：头发 3.5→4.0、眼睛 3.0→4.0、脸部 3.5→3.8（加红色眼线/腮红），加权总分预计 3.78 → **~4.0**，拉开与 Darling02（3.70）的差距。

> 注意：`models/mmd/TDA-ZeroTwo/ZeroTwo_TDA.pmx` 本身是**未修骨骼**的原始文件（父级 0/123）；线上用的是 `models/final/ZeroTwo_TDA.pmx`（= `test-fixed2.pmx`，123/123）。若要做任何重新打包，务必从 `models/final` 那份出发，或重跑 `tools/mmd-fix-skeleton.py`。

### 6.2 若换 Darling02：成本清单（约 1~2 人日，风险中高）

| # | 改动点 | 具体工作 | 风险 |
| --- | --- | --- | --- |
| 1 | 骨骼树修复 | 重跑/扩展 `tools/mmd-fix-skeleton.py`：现有标准表仅覆盖 51/242，需为 `HairJoint-<uuid>`（122 根）、`J_Sec_*_Skirt*`（24 根）新增命名链规则或人工校验；输出 PMX 并顺带把 21 条 `\` 贴图路径转 `/` | 发丝/裙摆链顺序无法用名字判定，动画可能"拧麻花" |
| 2 | 构建/配置 | `build.py` 的 MMD 目录硬编码为 `TDA-ZeroTwo`（且只拷贝 `tex/toon/sph`，Darling 只有 `tex/`）；`src/client/engine2d.js` 的 `MMD_BASE` 指向新目录 | 本次任务禁改这些文件，需主 agent 排期 |
| 3 | 头发物理 | `mmdchar.js` 里 `^cf_J_hair` 匹配 0 根 → 需改匹配 `Hairs/Hair001/HairJoint-*` 并重算深度 | 中 |
| 4 | 裙摆物理 | `^スカート_(\d+)_(\d+)$` 匹配 0 根 → 需新增 `J_Sec_*_SkirtFront/Back0..2` 解析 | 中 |
| 5 | 表情映射 | `EXPR` 15 项只命中 6（まばたき + あいうえお）：`笑い/ウィンク右/照れ/びっくり/なごみ/困る/はぁと/horns+` 缺失 → 需映射到 `怒/楽/喜/哀/驚/Face.*` 等，`はぁと`（心形眼）与 `horns+` 无对应，功能降级 | 低-中 |
| 6 | 手臂烘焙 | 现有 bakePose 按权重绕肩旋转烘顶点；Darling 长袖大衣权重跨肩/上身骨，实测烘出**袖子三角翼**（`eval-darling-bake.png`）→ 需重做烘焙策略或改走骨骼摆臂 | 高（观感） |
| 7 | 取景/尺寸 | 原生高 24.29（TDA 19.69）；`stage.frame` 自适应可吸收，但 camera.margin、Q 版 `headScale` 路径需复验 | 低 |
| 8 | 造型代价 | 换掉黑丝+白靴（变灰丝+白球鞋）、大衣红色偏淡——**视觉负优化**，需贴图重着色才能补 | 中 |

### 6.3 若换 Plugsuit：成本清单（约 2~3 人日，风险高，收益低）

1. **骨骼**：292 根全英文（`Hips/Spine/Chest/Neck/Head/Left arm/…`），父级乱序（2 根、23.4% 父低于子）；修树后仍需完整「英文名 → mmdchar 日文骨骼名」别名表（13 个核心 + BASE/POSES 所用 19 个）。
2. **表情**：432 个 morph 全部非 MMD 标准名（`eye_face.f00_*` / `kuti_face.f00_*` / `mayuge.*` / `eye_line_u.*`…），管线命中 0/15；需手工建立眨眼/口型/情绪/笑/心的映射，且没有 `horns +`。
3. **物理/IK**：0 刚体、0 Joint、0 IK（原作者标注 No physics / No IK-support）→ 与 TDA 相比直接丢失头发/裙摆物理能力。
4. **材质/渲染**：MMDLoader 下驾驶服贴图发白/斑块（`eval-plugsuit-*.png`），需修材质 flag/diffuse/specular；无 sphere map/toon。
5. **造型**：驾驶服 ≠ 红大衣制服，与项目 2D 立绘不符，属于"另一套皮肤"而非替代；且 hair 是 512 纯色贴图、观感最差。
6. **构建**：同 Darling，`build.py` / `engine2d.js` 需改造（本次禁改）。

### 6.4 决策建议

```
现在 ──> 保留 TDA（零成本） ──> 执行 task-2 贴图增强（红眼线/粉发层次/暖肤色）
                                        └──> 预期 TDA 视觉分 3.78 → ~4.0，稳居第一
Darling02 ──> 不迁移；仅作"面部/眼部贴图"的参考素材（如需重绘 TDA face/eye 可取色）
Plugsuit  ──> 排除（可留作未来"驾驶服换装"皮肤，但需先修骨架/补材质，优先级最低）
```

---

## 7. 截图清单（`shots/eval-*.png`，单张 480×800，PIL 合成对比图为多联）

| 文件 | 内容 | 复现参数（相对 `lab/mmd-preview.html`） |
| --- | --- | --- |
| `eval-tda-front.png` | TDA front（bind pose） | `base=/models/mmd/TDA-ZeroTwo/&file=test-fixed2.pmx&yaw=0&zoom=1` |
| `eval-tda-side.png` | TDA 3/4 侧 | 同上 + `yaw=0.5` |
| `eval-tda-face.png` | TDA 脸部特写 | 同上 + `--eval` 相机对准 `頭` |
| `eval-tda-bake.png` | TDA 手臂烘焙（插件实际姿势，正常） | 同上 + `&bake=1&angle=72` |
| `eval-darling-front.png` | Darling02 front | `base=/models/mmd/Darling02/&file=ZeroTwo_GameStyle.pmx&yaw=0&zoom=1` |
| `eval-darling-side.png` | Darling02 3/4 侧 | 同上 + `yaw=0.5` |
| `eval-darling-face.png` | Darling02 脸部特写 | 同上 + `--eval` 相机对准 `頭` |
| `eval-darling-bake.png` | Darling02 手臂烘焙**失败证据**（袖子三角翼） | 同上 + `&bake=1&angle=72` |
| `eval-plugsuit-front.png` | Plugsuit front | `base=/models/mmd/ZeroTwo-Plugsuit/&file=ZeroTwo_ArmorSuit.pmx&yaw=0&zoom=1` |
| `eval-plugsuit-side.png` | Plugsuit 3/4 侧 | 同上 + `yaw=0.5` |
| `eval-plugsuit-face.png` | Plugsuit 脸部特写（红眼线可见） | 同上 + `--eval` 相机对准 `Head` |
| `eval-compare.png` | **三联对比图**（front × 3，带名称/分数标注） | PIL 合成（480×800 ×3 → 1144×680） |
| `eval-compare-faces.png` | 三联对比（脸部特写 × 3） | PIL 合成 |
| `eval-compare-ref.png` | 2D 立绘 + 三模型对照（4 联） | PIL 合成 |

复现命令模板：

```bash
NODE=~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node
$NODE tools/shot.mjs \
  --url "http://127.0.0.1:8899/lab/mmd-preview.html?base=/models/mmd/Darling02/&file=ZeroTwo_GameStyle.pmx&yaw=0&zoom=1" \
  --out shots/eval-darling-front.png --size 480x800 --wait 2500 --ready "window.__LAB_READY"
```

---

## 8. 风险与注意事项

1. **渲染环境**：lab 页是裸 `MMDLoader`，插件实际运行时会叠加 `src/3d/mmd-shade.js` 的赛璐璐描边/高光与舞台灯光，颜色/对比会与截图不同；评分基于"模型本体"，最终观感请在 `preview/?pkg=zero02-pet` 复验。
2. **贴图路径大小写/分隔符**：Darling/Plugsuit 的 PMX 贴图路径是 `\` 分隔，须统一为 `/` 并确认服务器路径大小写（macOS 大小写不敏感，Linux 敏感）。TDA 已规范。
3. **「最接近动画」的判定基准**：本报告以项目 2D 立绘 `_assets/onee.webp`（红大衣造型）为基准；若产品方向改为"驾驶服皮肤"，Plugsuit 的造型与红眼线价值会上升，但骨骼/材质成本不变。
4. **授权**：三套均为同人模型，版权归 Aniplex / DARLING in the FRANXX 权利方，仅限个人桌面宠物使用，禁止再分发/商用；换模型不改变授权义务。
5. **本报告不改代码**：Darling02/Plugsuit 若确定迁移，需主 agent 排期改 `build.py`、`src/client/engine2d.js`、`src/3d/mmdchar.js`（本任务禁改），并重跑 build + 插件安装验证。
