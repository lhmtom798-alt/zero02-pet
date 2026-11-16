# 02 贴图美术增强（TDA Zero Two / DARLING in the FRANXX）

> 任务来源：`team_task_list` **task-2 贴图美术增强：把 TDA 02 的头发/脸/衣服调到接近动画立绘**。
> 目标：用 PIL 离线增强 MMD 贴图，让 TDA 02 渲染远离「偏灰/头发偏淡/衣服砖红」，靠近动画立绘（鲜艳粉发 + 奶白暖肤 + 鲜红大衣 + 02 标志性腮红/红色眼线）。
> 输入（只读）：`models/mmd/TDA-ZeroTwo/`；输出：`models/final/mmd-tex/`；可复现脚本：`tools/enhance-textures.py`。
> 原则：**文件名 / 尺寸 / alpha 不变**；不覆盖 `models/mmd` 原文件；不碰 `src/`、`build.py`、`models/final` 下除 `mmd-tex` 之外的东西。

---

## 1. 结论（TL;DR）

| 贴图 | 部位 | 改动 | 效果（渲染验证） |
|---|---|---|---|
| `hair.png` 256×256 | 头发 7 个材质的主贴图 | 粉色饱和 ×2.35、hue 拉向 `#ff9ec4`、上亮下暗、Lanczos 2x + 锐化 | 渲染后头顶发色采样 **(244,158,182)**，接近目标 `#ff9ec4 (255,158,196)`；发梢明显压暗，发丝更清晰 |
| `hair_s.png` 512×512 | 头发球面高光（env/add） | 灰白高光 → 粉色高光、提亮 2x、上亮下暗、2x 锐化 | 头发多一层粉色反光/高光，不再是灰白塑料感 |
| `face.png` 1024×1024 RGBA | 脸/脖/五官底图 5 个材质 | 双颊柔和腮红、外眼角 02 红色眼线、肤色加暖；**alpha 逐像素保留** | 特写里有明显但不脏的腮红与红色眼尾线，肤色更暖 |
| `body.png` 1024×1024 | 身体/手/指甲 | 肤色加暖 R +4.4% / B −3.2% | 手背、身体肤色更暖，和脸统一 |
| `tex/socks.png` 1024×1024 | 大腿肤色 + 深色过膝袜 | 只对肤色区域加暖（同 body 参数），深色袜子像素完全不动 | 腿部肤色变暖；袜子 RGB 平均变化 = 0 |
| `tex/aka.png` 800×800 | 红大衣 `Dress` | 饱和度 0.583→0.783、明度 0.636→0.755、对比 +16% | 大衣从「砖红偏灰」变成动画里的鲜红 |

全部 6 张输出通过自动校验：**文件名/尺寸/模式一致，`face.png` alpha 与源文件逐像素相同**（见 §5.1）。

---

## 2. 可复现流水线

```bash
# 生成全部增强贴图 + 纹理级 before/after 对比图（shots/tex-*-compare.png）
python3 tools/enhance-textures.py

# 生成验证用临时模型目录 models/mmd/_tex-test/（复制 PMX+全部贴图，再覆盖增强贴图；原 models/mmd 文件不动）
python3 tools/enhance-textures.py --stage

# 用已渲染的 shots/tex-render-{before,after}-*.png 拼渲染对比图
python3 tools/enhance-textures.py --render-compare
```

- 依赖：Pillow + numpy（DSH 自带 Python：`~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3`）。
- 全部可调参数集中在脚本顶部常量（`HAIR_TARGET` / `BLUSH_*` / `EYE_LINE_*` / `SKIN_WARM` / `COAT_*` 等）。
- 脚本同时输出 `models/final/mmd-tex/manifest.json`（源/目标/产出文件清单）。

### 输出目录

```
models/final/mmd-tex/
├── hair.png        256×256 RGB    (尺寸/文件名同源)
├── hair_s.png      512×512 RGB
├── face.png        1024×1024 RGBA (alpha 逐像素保留)
├── body.png        1024×1024 RGB
├── tex/socks.png   1024×1024 RGB
├── tex/aka.png     800×800 RGB
├── 2x/hair.png     512×512   ← “Lanczos 2x 放大 + 锐化”的中间产物（可选核对用）
├── 2x/hair_s.png   1024×1024 ← 同上
└── manifest.json
```

> 关于「Lanczos 2x 放大 + 轻微锐化」：为同时满足“保留原尺寸”的硬约束，流水线在 **2x（Lanczos 上采样）空间**里完成调色/锐化，再 Lanczos 降回原尺寸（超采样锐化）；2x 中间图另存于 `2x/` 方便核对。

---

## 3. PMX 贴图 → 材质映射（用脚本解析 `ZeroTwo_TDA.pmx` 得到）

| # | 贴图 | 使用材质（PMX material） | 是否增强 |
|---|---|---|---|
| 0 | `tga/miku_sw.tga` | `水着下`（被大衣遮住） | — |
| 3 | **`body.png`** | `Nails`, `body` | ✅ 肤色加暖 |
| 5 | **`tex/socks.png`** | `socks` | ✅ 肤色加暖（仅肤色区域） |
| 7 | **`face.png`** | `首`, `材質0`, `材質1`, `材質3`, `材質6` | ✅ 腮红/眼线/加暖 |
| 8 | `eye1.png` | `材質2`（teal 虹膜贴片） | —（保持原样） |
| 10 | **`hair.png`** | `材質5`, `材質6`, `材質3`, `材質1`, `材質2`, `材質3`, `材質4`（7 个头发材质） | ✅ |
| 11 | **`hair_s.png`** | 上述头发材质的 env（球面高光，add 混合） | ✅ |
| 13 | `02_horns.png` | `Material.004`（红角） | — |
| 16 | **`tex/aka.png`** | `Dress`（红大衣主体） | ✅ 饱和度/对比 |
| 17 | `tex/button.bmp` | `Button`（扣子） | — |
| 20/22 | `tex/accessories 1/2.bmp` | `Accessories`（领章等） | — |
| 23 | `tex/boots.png` | `Boots`（白靴） | — |
| 1/6/9/14/18/21 | `sph/*.bmp|png` | env 球面贴图（body00_s/spa2/spamm/cloth/cloth_2/huku） | — |
| 2/4/12/15/19 | `toon/*`, `toon_defo.bmp` | 卡通渐变色阶（skin2/toon/lightgray/darkgray；`toon_defo.bmp` 是 PMX 自带引用缺失，lab 控制台有 404，与本任务无关） | — |

> 大小写说明：PMX 内路径有 `tex\socks.png`、`tex/button.bmp`、`Toon/` 等不同写法，macOS 大小写不敏感、原目录按原样保留即可；本任务只覆盖同名文件，不重命名任何路径。

---

## 4. 逐项改动说明

### 4.1 `hair.png`（256×256，头发主贴图）

改动：
1. **粉色饱和**：HSV 中 `S ×2.35`，hue 向 `#ff9ec4`（H≈336.5°）拉近 60%；原来发灰的淡粉变成动画粉。
2. **上亮下暗层次**：沿纹理 V 方向做亮度渐变（顶部 ×1.12 → 底部 ×0.86）。已先在 lab 里用红→绿→蓝渐变贴图验证方向：纹理上方的行渲染在头顶/发根，下方的行渲染在发梢，所以「上亮下暗」= 发根亮、发梢暗。
3. **Lanczos 2x 放大 + 轻微锐化**：256→512 Lanczos 上采样，`UnsharpMask(radius=2.4, percent=95)`，再 Lanczos 降回 256，最后再轻锐化一次（radius=1.1, 55%）。
4. 输出尺寸仍为 256×256，文件名不变。

数据（脚本内置统计）：

| 指标 | before | after |
|---|---|---|
| 平均 RGB | (230.3, 193.3, 198.3) | (227.7, 134.7, 161.9) |
| 平均饱和度 S | 0.163 | **0.415**（目标色 `#ff9ec4` S=0.380） |
| 主色 hue | 约 350° 淡粉 | **342°**（目标 336.5°） |
| 顶部/底部亮度比 | 0.99（平） | **1.26（上亮下暗）** |

对比图：`shots/tex-hair-compare.png`
渲染采样（脸特写头顶发色）：`(241,201,209)` → **`(244,158,182)`**，接近 `#ff9ec4 (255,158,196)`。

### 4.2 `hair_s.png`（512×512，头发球面高光 / env add）

改动：
1. 原图近黑底 + 灰白弧形高光（最亮 47/255）→ 以亮度重标定 ×2.0，并用粉色 `#ffb7d4` 染色（保留黑底 = add 混合下无副作用），头发因此带**粉色高光**而不是灰白高光；
2. 上亮下暗渐变（顶部 ×1.20 → 底部 ×0.92）；
3. Lanczos 2x（1024）→ `UnsharpMask(1.6, 70%)` → 降回 512。

数据：均值 RGB (3.1,3.6,3.6)→(7.8,5.6,6.5)，最亮 47→105，饱和度 0.068→0.283。
对比图：`shots/tex-hair-s-compare.png`

### 4.3 `face.png`（1024×1024 RGBA：腮红 + 红色眼线 + 加暖）

**alpha 严格保持**：只改 RGB，`putalpha(原 alpha)`，脚本校验 `np.array_equal` 通过。原图并不是“大部分透明”——透明区约 22%（集中在中部眼洞/右侧局部），其余是脸皮底色；这里不改变任何透明区域。

改动：
1. **整体肤色加暖**：RGB ×(1.050, 1.012, 0.975)，再轻微提饱和 ×1.04、提亮 ×1.02；平均 RGB (192.8,172.0,163.8)→(203.1,172.8,158.7)（R +5.3%，B −3.1%）。
2. **双颊柔和腮红**：在 face.png 的 (173,587) 与 (470,611) 两个位置画峰值 0.30 的粉色径向渐变（半径 190px，falloff 2.2，颜色 RGB(255,118,158)）。坐标不是拍脑袋——先用 lab 页把这两个 UV 位置画成测试圆环渲染，确认分别落在左右脸颊后再定；两个位置分别对应左右脸（非镜像 UV），所以两颊独立渐变更自然。
3. **外眼角 02 红色眼线**：face.png 里 x∈[652,772]、y∈[108,202] 的 UV 带映射到**双眼外眼角上睫毛/眼尾的暗部**（同样是用 lab 反投影 + 分格色块逐格验证）。处理方式：只把该区域里**原本就是深色睫毛**的像素向红色 `#ec123e` 混合（按暗度 + 从内到外渐强 + 从中心向外柔化），亮度/形状完全沿用原睫毛图形，因此：
   - 不会凭空画错位置（宁少勿错）；
   - 两只眼睛共用同一 UV 区，红色眼尾线会镜像出现在左右眼外眼角；
   - 贴图侧平均色由 (36,36,36) → **(186,23,55)**，红色对比度 162。

对比图：`shots/tex-face-compare.png`（含整张、两处腮红局部、眼线局部的 before/after）

### 4.4 `body.png` / `tex/socks.png`（肤色更暖）

- `body.png`：肤色 RGB ×(1.045, 1.012, 0.975) + 轻微提饱和 ×1.03。平均 RGB (243.7,228.9,216.0)→(254.5,230.9,209.0)：**R +4.4% / B −3.2%**（落在任务要求的 R +3~5%、B −2~4% 内）。
- `tex/socks.png`：同样参数，但用亮度 mask（smoothstep 0.55→0.72）**只作用在肤色区域**，深色过膝袜部分保持原样（实测袜子区域 RGB 平均变化 = 0,0,0）。肤色区 R +4.4% / B −3.2%。
- 对比图：`shots/tex-skin-compare.png`、`shots/tex-socks-compare.png`

### 4.5 `tex/aka.png`（红大衣）

- HSV：`S ×1.34`、`V ×1.13`，再做围绕中灰的对比 S 曲线（×1.16）。
- 平均 RGB (162.5,68.1,73.6)→(192.8,42.1,50.8)；HSV：**S 0.583→0.783，V 0.636→0.755**，hue 稳定在 355.7°（红）。
- 大衣上的紫色饰条/白线也一起提了饱和和对比，但色相不变。
- 对比图：`shots/tex-aka-compare.png`

### 4.6 未改动的贴图（有意为之）

`eye1.png`（02 青绿虹膜）、`02_horns.png`（红角）、`tex/boots.png`（白靴）、`tex/button.bmp`、`tex/accessories*.bmp`、`sph/*`、`toon/*`、`tga/miku_sw.tga` 均保持原样：它们已经接近动画配色，或不在本任务范围；尤其是眼睛，动它风险大于收益。
（`toon_defo.bmp` 在 PMX 里被引用但磁盘上不存在 → lab 控制台 404，属于模型自带缺失，与本次贴图增强无关。）

---

## 5. 验证

### 5.1 自动校验（`tools/enhance-textures.py` 每次运行输出）

```
[verify] hair.png       (256, 256) RGB  name=OK size=OK mode=OK
[verify] hair_s.png     (512, 512) RGB  name=OK size=OK mode=OK
[verify] face.png       (1024, 1024) RGBA name=OK size=OK mode=OK alpha=OK
[verify] body.png       (1024, 1024) RGB  name=OK size=OK mode=OK
[verify] tex/socks.png  (1024, 1024) RGB  name=OK size=OK mode=OK
[verify] tex/aka.png    (800, 800) RGB  name=OK size=OK mode=OK
[verify] all textures: 文件名/尺寸/尺寸一致, face alpha 逐像素保留
```

- 原文件未被覆盖：`models/mmd/TDA-ZeroTwo/*.png` 的 mtime 仍是 11-12 20:02（早于本任务），增强结果只写入 `models/final/mmd-tex/`。
- 验证渲染用的是临时模型目录（完整复制 + 覆盖增强贴图），不写原模型：
  `models/mmd/_tex-test/`（评测完成后已删除；随时可 `python3 tools/enhance-textures.py --stage` 重建）。

### 5.2 lab 渲染验证（同机位、同光照、同尺寸）

渲染地址（增强版）：`http://127.0.0.1:8899/lab/mmd-preview.html?base=/models/mmd/_tex-test/&file=ZeroTwo_TDA.pmx`
（原版：`?base=/models/mmd/TDA-ZeroTwo/&file=ZeroTwo_TDA.pmx`；`yaw` 单位是弧度，3/4 侧面用 `yaw=0.52`；脸特写 `ty=0.9&zoom=0.2`）

| 文件 | 内容 |
|---|---|
| `shots/tex-render-before-front.png` / `shots/tex-render-after-front.png` | 全身正面 before / after（480×860） |
| **`shots/tex-render-compare-front.png`** | **全身正面对比（左右并排，含标题）** |
| `shots/tex-render-before-3q.png` / `shots/tex-render-after-3q.png` | 全身 3/4 侧面 before / after（480×860，`yaw=0.52`） |
| **`shots/tex-render-compare-3q.png`** | **全身 3/4 侧面对比** |
| `shots/tex-render-before-face.png` / `shots/tex-render-after-face.png` | 脸部特写 before / after（700×800，`ty=0.9&zoom=0.2`） |
| **`shots/tex-render-compare-face.png`** | **脸部特写对比（可看腮红/红色眼线/发色）** |
| `shots/tex-render-after-3q-face.png` | 3/4 侧面脸部验证（增强版） |
| `shots/tex-hair-compare.png` 等 6 张 | 每张贴图的 before/after 纹理对比（§4） |

> “至少 2 张 lab 渲染验证图（用增强后贴图渲染整个人物）”：`tex-render-after-front.png`、`tex-render-after-3q.png`（另有对应 before 与并排 compare）。

### 5.3 渲染结论：是否更接近动画？

**是，明显更接近。** 按动画立绘的几个标志性特征逐项对照：

1. **头发**：before 是发灰的淡粉（贴图平均饱和度 0.16），after 是鲜艳粉（0.42）；脸特写里头顶发色采样从 (241,201,209) → (244,158,182)，已经落在目标 `#ff9ec4 (255,158,196)` 附近；发根亮、发梢暗的层次让头发不再像一块平色布；发丝经 2x 超采样锐化后边缘更清楚。
2. **皮肤**：脸/手/腿整体从冷白变成暖调（R +4~5%，B −3% 左右），接近动画里 02 的奶白偏暖肤色；腮红让脸有血色，不再是白板。
3. **眼睛/眼线**：青绿色大眼保留原样（不动虹膜），外眼角补上 02 标志性的红色眼尾线（特写里左右眼外眼角都能看到），这是“像 02”最关键的一笔。
4. **红大衣**：从偏灰砖红（S 0.58/V 0.64）变成高饱和鲜红（S 0.78/V 0.76），和白领/橙领带/黄领章的对比更强，整体更像动画制服。
5. **没有变差的地方**：模型轮廓、脸型、眼型、发型、扣子/领章/靴子等细节全部保持原样（只调色、不重绘），alpha 与文件尺寸不变，可视为“安全增强”。
6. **仍存在的差距（客观说明）**：TDA 模型本身的发丝几何偏“块状”、渲染用固定光照 + toon ramp，所以不会像手绘立绘那样有细致光线层次；眼睛虹膜依然是原贴图；这些属于模型/着色层面，不是本次贴图增强能解决的。

---

## 6. 产物清单

**贴图（`models/final/mmd-tex/`）**：`hair.png`、`hair_s.png`、`face.png`、`body.png`、`tex/socks.png`、`tex/aka.png`、`2x/hair.png`、`2x/hair_s.png`、`manifest.json`。

**脚本**：`tools/enhance-textures.py`（`--stage` 生成验证临时目录、`--render-compare` 拼渲染对比图、`--only` 单独重跑某几项）。

**对比/验证图（`shots/`）**：
- 纹理级：`tex-hair-compare.png`、`tex-hair-s-compare.png`、`tex-face-compare.png`、`tex-skin-compare.png`、`tex-socks-compare.png`、`tex-aka-compare.png`
- 渲染级：`tex-render-before-front.png`、`tex-render-after-front.png`、`tex-render-compare-front.png`、`tex-render-before-3q.png`、`tex-render-after-3q.png`、`tex-render-compare-3q.png`、`tex-render-before-face.png`、`tex-render-after-face.png`、`tex-render-compare-face.png`、`tex-render-after-3q-face.png`

**临时验证目录**：`models/mmd/_tex-test/`（完整模型副本 + 增强贴图，评测后已删除；`--stage` 可一键重建，不影响原模型）。

---

## 7. 后续可做（不在本任务范围）

1. 把 `models/final/mmd-tex/` 接入插件/构建流程（例如 `build.py` 或模型加载时替换贴图路径）——需要改 `src/` 或 `build.py`，本任务明确不碰。
2. 若今后允许改 PMX 材质参数：可微调 hair/face 材质的 diffuse、toon 色阶、env 强度，比纯贴图再进一步。
3. 眼睛虹膜（`eye1.png`）可以做更接近动画的高光/渐变，但需要先评估“改眼睛是否值得”，目前保守不动。

---

# 第 2 轮：脸部精修（2026-11-13）

> 目标：在第 1 轮增强贴图基础上专攻**脸部细节**，让 02 的脸更“动画”：唇线/下唇、眼下卧蚕、眉毛、发梢渐层。
> 范围：只改 `models/final/mmd-tex/` 下贴图（face.png / hair.png）、`tools/enhance-textures.py`、docs、shots；不改 `src/`、`build.py` 逻辑。
> 原则不变：**face.png 的 alpha 逐像素保持**（只改 RGB），文件名/尺寸不变；差分对比全部可复现。

## 8.1 本轮改了什么

| 项目 | 贴图 / UV 区域 | 改法 | 对比图 |
|---|---|---|---|
| **嘴唇** | `face.png` 嘴部 UV 条带：u≈9 为嘴中心（该条带左右镜像），嘴角 u≈86；v：上唇 632-666 / 唇线 666-684（自带唇线画在 668-679）/ 下唇 684-718 | ① 原有唇线像素重涂为深玫瑰 `#7e3846`（保持原形状、加深加粗一点）；② 上唇淡阴影（`#c88c98`，≤0.07）；③ 下唇浅粉 `#f6a8b6`（≤0.11）+ 中央小高光 `#ffe8eb`（≤0.10）+ 下缘细阴影，整体低透明度、椭圆剖面（中央厚、嘴角薄） | [`shots/tex2-lips-compare.png`](../shots/tex2-lips-compare.png) |
| **下唇贴片**（桌宠管线可见） | `face.png` (176..336, 790..922) 的大嘴唇画（mmd-char 管线会把右段压成下唇） | 原图偏灰白（mean≈241,205,200）→ 调成动画浅粉 `#f9acbe`（0.42 强度），底缘压深保留厚度 | [`shots/tex2-lipcard-compare.png`](../shots/tex2-lipcard-compare.png) |
| **下眼睑 / 卧蚕** | `face.png` 眼下皮肤 UV 区：u 90-245, v 470-522（左右眼镜像共用一块） | 三道很淡的横向渐变：眼下淡粉阴影 `#d47684`（≤0.23）→ 柔和提亮 `#ffe9e4`（≤0.26）→ 下缘淡粉（≤0.10）；幅度刻意压小，不做黑眼圈 | [`shots/tex2-undereye-compare.png`](../shots/tex2-undereye-compare.png) |
| **眉毛** | `face.png` (586..792, 0..96) 的眉毛卡片（属于 `材質1` 睫毛材质；正常视角被刘海盖住） | 把卡片上的深色像素改为**深粉棕 `#663a46`**（0.68 强度），刘海间隙/甩头时眉毛不再发黑，呈深粉棕“若隐若现” | [`shots/tex2-brow-compare.png`](../shots/tex2-brow-compare.png) |
| **发梢渐层**（可选） | `hair.png` 底部 21%（v ≥ 0.78） | 在**现有 hair.png 基础上**追加：降饱和 45% + 提亮 10%，并向 `#ffcee0` 混合（最大 0.42），模拟动画发梢末端变浅/半透；不改尺寸、不动上半部分。实测底部 21% 平均亮度 **146.9 → 172.3（+17%）** | [`shots/tex2-hair-tips-compare.png`](../shots/tex2-hair-tips-compare.png) |

- 整张 face.png 前后对比：[`shots/tex2-face-texture-compare.png`](../shots/tex2-face-texture-compare.png)
- 渲染对比（mmd-preview 700×800，同机位同光照）：[`shots/tex2-face-render-compare.png`](../shots/tex2-face-render-compare.png)
- 渲染对比（**桌宠真实管线** lab/mmd-char.html 700×800）：[`shots/tex2-char-render-compare.png`](../shots/tex2-char-render-compare.png)
- 发梢渲染对比（桌宠管线背面）：[`shots/tex2-hair-tips-render-compare.png`](../shots/tex2-hair-tips-render-compare.png)

单帧验证图：`shots/tex2-face-render-before.png` / `tex2-face-render-after.png`（mmd-preview），`tex2-char-render-before.png` / `tex2-char-render-after.png`（mmd-char）。

## 8.2 坐标是怎么定位的（避免画错）

本轮所有 UV 坐标都不是“看着像”估的，而是用 lab 页把**屏幕坐标反投影到贴图 UV** 逐点校准，再用“色块/分格测试贴图 -> 渲染 -> 对照”确认：

1. 用 `lab/mmd-preview.html?base=…&ty=0.9&zoom=0.2`（700×800）固定机位，在页面里对每个三角形做屏幕空间重心插值，把嘴/眼下/眉毛的屏幕点反投影成 face.png 像素坐标；
2. 把候选区域涂成高饱和色块渲染，确认它落在“嘴巴/眼下/眉毛卡片”上，再逐格细分到具体条带（例如嘴唇条带确定了 u 是镜像的：u=9 是嘴中心，两只嘴角都在 u≈86；v 从上唇 632 到下巴 718）；
3. 区分材质：实测发现 **可视唇线来自 `材質0`（脸部皮肤）**，`材質3/材質6` 是嘴内/旧件（被皮肤挡住不可见）；桌宠 char 管线额外可见的“下唇贴片”来自 (190..320, 800..910) 的大嘴唇画；眉毛卡片在 `材質1` 睫毛材质的 (620..760, 0..70)；
4. 双管线验证：`mmd-preview`（MMDLoader 直出）和 `mmd-char`（桌宠真实渲染管线，含 cel 着色/头发物理）都截图对照，避免只在一个管线里对。

## 8.3 alpha / 尺寸保证

- 第 2 轮只改 face.png 的 RGB：`alpha` 与前一轮逐像素一致（脚本输出 `第 2 轮 face.png alpha 与第 1 轮一致: OK`），也与源贴图一致；透明区仍是 0。
- 文件名/尺寸不变：`face.png` 1024×1024 RGBA；`hair.png` 保持现有 512×512 RGB（发梢渐层不改变尺寸）。
- 自动校验（`python3 tools/enhance-textures.py`）：
  ```
  [verify] face.png   (1024, 1024) RGBA size=OK mode=OK alpha=OK
  [verify] face.png 的 alpha 与源贴图逐像素一致（第 1+2 轮全程不改 alpha）
  [verify] 第 2 轮 face.png alpha 与第 1 轮一致: OK
  ```

## 8.4 脚本用法（第 2 轮后）

```bash
python3 tools/enhance-textures.py            # 默认只重建 face.png（第1+2轮脸部），并出 tex2-* 对比图
python3 tools/enhance-textures.py --all      # 从源贴图全量重建 6 张（会覆盖 hair.png，慎用）
python3 tools/enhance-textures.py --no-v2    # 只做第1轮脸部（生成第2轮 before 基准）
python3 tools/enhance-textures.py --hair-tips  # 在现有 hair.png 上追加发梢渐层（可选项）
python3 tools/enhance-textures.py --stage    # 生成 models/mmd/_tex-test/ 验证目录
python3 tools/enhance-textures.py --render-compare  # 拼渲染对比图
```

> 默认**不再**从源贴图重建 `hair.png`：该图已被并行的头发优化线更新为 512×512 版本（含更细发丝），
> 覆盖会回退别人的成果。`--all` 仅用于“从零重建”场景。`--hair-tips` 操作的是当前 hair.png（原地追加），
> 若头发线重新生成了 hair.png，需要再跑一次 `--hair-tips`。

验证方式与第 1 轮一致：`models/mmd/_tex-test/` = 完整模型副本 + `models/final/mmd-tex/` 全部贴图覆盖（与 build.py 行为一致），
不覆盖 `models/mmd` 原文件；评测后已删除，`--stage` 可一键重建。

## 8.5 渲染验证结论：建议保持

- **嘴唇：建议保持。** mmd-preview 里原来只是一条很淡的线，现在是“深一度唇线 + 下唇浅粉”，特写下能看出嘴型；mmd-char（桌宠）里下唇贴片从灰白变浅粉，嘴部更有“画上去”的感觉。幅度克制（低透明度渐变），近看不会像涂了口红。
- **眼下卧蚕：建议保持。** 很淡的粉影+提亮，让眼睛下方不再一片平坦，正面看有轻微“有神/带点害羞”的红润；如果后续觉得重，把脚本里 `V2_EYE_*` 三个 alpha（0.23/0.26/0.10）各减半即可。
- **眉毛：建议保持（低风险）。** 眉毛卡片本来就被刘海盖住，只在甩头/刘海缝隙可见；改成深粉棕后不会在缝隙处露出死黑块，和粉发更协调。若不需要可直接删除脚本里第 3 段（眉毛）代码，不影响其它项。
- **发梢渐层：建议保持（可选）。** 背面/侧面发梢末端变浅，接近动画“发梢末端透亮”的观感；改动只作用于 hair.png 底部 21%，风险低。注意与头发优化线的联动（见 8.4）。
- **没有变差的地方**：脸型、眼型、腮红、红眼线、肤色、发色（上半部分）全部保持第 1 轮效果；alpha、尺寸、材质映射都没动；贴图改动全部可复现（第 2 轮 before 由脚本从源贴图重建）。

**客观差距（仍存在）**：模型本身没有独立可动的“嘴唇几何”，嘴部是画在脸部皮肤 UV 上的一条窄条带，能做的只是“加唇线/加下唇颜色”，做不到动画里张嘴、唇形变化；眼睛虹膜仍未改动；眉毛几何被刘海长期遮挡，只有特定角度可见。这些属于模型/骨骼层面的限制。

## 8.6 本轮产物

- 贴图：`models/final/mmd-tex/face.png`（第 1+2 轮）、`models/final/mmd-tex/hair.png`（发梢渐层）。
- 脚本：`tools/enhance-textures.py`（新增第 2 轮脸部精修、发梢渐层、tex2 对比图生成、`--all/--no-v2/--hair-tips` 参数）。
- 截图：`shots/tex2-*.png` 共 10 张（4 张分项纹理对比 + 1 张整脸纹理对比 + 2 张渲染对比 + 1 张发梢纹理对比 + 1 张发梢渲染对比；另有 before/after 单帧 4 张）。
- 构建：已执行 `python3 build.py` 刷新 `zero02-pet/assets/mmd/TDA-ZeroTwo/`（face.png / hair.png 等 11 张增强贴图已同步，md5 一致）。

---

# 第 3 轮：动画感细节（2026-11-13）

> 目标：在上一轮脸部精修基础上，加 2~3 个「动画感」加分项：**刘海在额头/上眼睑的投影**（最重要）、**眼睛高光强化**、**鼻部柔和阴影**（下颌阴影因 UV 风险跳过）。
> 范围：只改 `models/final/mmd-tex/`（face.png / eye1.png）、`tools/enhance-textures.py`、docs、shots；不动 `src/`、`build.py` 逻辑。
> 贴图 alpha 逐像素保持（face.png 全程只改 RGB；eye1.png 只叠加高光、alpha 通道原样保留）。

## 9.1 每项改了什么

### ① 刘海投影（face.png，暖紫棕柔和阴影）——最重要

- **UV 定位**（lab 反投影校准）：额头区域在 face.png 的 **u≈9 → 200**（u=9 是脸中线，条带左右镜像；u 越大=离中线越远）、**v≈196 → 400**；其中 v≈228 对应发际线附近，v≈345-390 是眉毛/上眼睑，**v≥400 就是眼睛卡片区域（不能压过去）**。
- 实现：`V3_BANG_ALPHA = 0.14`（任务要求 0.06~0.14）的暖紫棕 `#986e7a` 柔和渐变：
  - v 196→232 渐入（发际线）；
  - 下缘用 `fade_end = 356 + 14·sin(0.09u) + 6·sin(0.037u+1.5)` 做出**随发绺起伏的波浪形渐出边界**（柔化 44px），保证不过界到眼睛；
  - 横向在 u>180 处收边（太阳穴），u≈2-12 处渐变，避免接缝；
  - 附加轻微强度起伏（`0.86+0.14·sin`），模拟发绺间隙。
- **实测效果**（渲染可见皮肤像素，对比同机位 before）：
  - mmd-preview 头部特写：额头平均 RGB 变化 **Δ(-0.4, -3.3, -2.5)**（变暖压深，肉眼可见“被头发压出的层次”）；
  - 桌宠 mmd-char 管线：额头 meanDiff **0.97**，而同机位重复渲染噪声基线 0.43 → 信号约为噪声 2.3 倍；脸颊/下颌 meanDiff 0.43 ≈ 噪声 0.36（**没有溢出到脸颊**）。

### ② 上眼睑眼影（face.png，极淡暖紫）

- UV：眉毛/上眼睑一带 **v 344→398、u 86→306**（v≥400 避开眼睛卡片，避免把眼周画脏）。
- 参数：暖紫 `#ac7a80`，最大透明度 **0.08**（任务 0.05~0.1），上下各 16px/14px 软渐变，横向收边。
- 效果：眼睑/眉骨处多一层很淡的暖色，与刘海投影衔接，让眼窝有“被刘海遮住”的层次；眼睛本身（虹膜/眼白）不受影响。

### ③ 眼睛高光强化（eye1.png，原地增强）

- 背景：eye1.png 由并行眼睛优化线生成（已有左上主高光 + 右下小点 + 虹膜环）。
- 本步骤只做动画感加成：
  1. **左上主高光加大加亮一点点**：在原高光位置扩一圈 0.60 强度、Gaussian blur 2.2 的柔光（半径约为虹膜 27%×42%），再把原高光核心提亮 22%（只作用在 lum>205 的高光像素，不碰瞳孔）；
  2. **右下次级高光/反光条**：沿虹膜右下方向补一条半径 0.70、角度 12°~74° 的细弧（`#f0fffa`，alpha≈175，宽约 4-5px，blur 1.3），并把原右下小点稍微提亮；只画在虹膜内（d 0.42~0.95），**瞳孔区域完全不动**。
- alpha 通道逐像素保留（实测 `np.array_equal` = True）；尺寸 300×300 不变。
- **幂等**：`manifest.json` 记录输入/输出 md5，重复运行 `--eye-anim` 会自动跳过；用 `--eye-anim-force` 可强制重跑。眼睛线若重新生成 eye1.png，重跑一次即可。
- 对比图里能看到：左上主高光更大更亮，右下方多一条细反光弧，虹膜层次更像动画。

### ④ 鼻部柔和阴影（face.png，可选）

- UV：鼻侧 **u 16→68、v 500→600**；鼻底 **u 9→54、v 564→614**。
- 参数：鼻侧暖棕 `#a87c76`，最大 0.075；鼻底 0.06，全部柔和渐变。
- 效果：鼻梁左右各一道极淡阴影 + 鼻底一点暗，鼻子的体积感/立体度提升；嘴角/嘴唇不受影响（验证过区域不重叠）。
- **下颌阴影跳过**：反投影发现下颌屏幕像素多数落在 `首`/颈部材质区域，face.png 上没有干净的对应 UV，风险大于收益（按任务允许跳过）。

## 9.2 对比图 / 渲染验证（shots/）

**纹理级 before/after**（before = 第 2 轮在内存中重建，可复现）：
- [`shots/tex3-forehead-compare.png`](../shots/tex3-forehead-compare.png) — 刘海投影
- [`shots/tex3-lid-compare.png`](../shots/tex3-lid-compare.png) — 上眼睑眼影
- [`shots/tex3-nose-compare.png`](../shots/tex3-nose-compare.png) — 鼻侧/鼻底阴影
- [`shots/tex3-eye-compare.png`](../shots/tex3-eye-compare.png) — eye1.png 高光（主高光加大 + 右下反光弧）
- [`shots/tex3-face-texture-compare.png`](../shots/tex3-face-texture-compare.png) — face.png 整张对比

**桌宠真实管线渲染对比**（lab/mmd-char.html，700×800，同机位）：
- **头特写**：[`shots/tex3-char-render-compare.png`](../shots/tex3-char-render-compare.png)（before/after 单帧：`tex3-char-render-before.png` / `tex3-char-render-after.png`）
- **眼睛特写**（zoom=0.09&camY=17.8）：[`shots/tex3-eye-render-compare.png`](../shots/tex3-eye-render-compare.png)
- 另外附 mmd-preview 头特写对比：[`shots/tex3-face-render-compare.png`](../shots/tex3-face-render-compare.png)（纹理细节更清楚）

> 注：mmd-char 管线本身有轻微逐帧 AA/发丝抖动，两次同贴图渲染的边缘也会有 ~0.4 的平均差异，所以“阴影效果”不是靠肉眼单看边缘，而是用皮肤区域的平均 RGB 变化/噪声倍数验证（见 9.1）。

## 9.3 alpha / 尺寸 / 副作用检查

- `face.png`：1024×1024 RGBA，第 3 轮只改 RGB，`alpha` 与第 2 轮逐像素一致（脚本输出 `第 3 轮 face.png alpha 与第 2 轮一致: OK`），也与源文件一致。
- `eye1.png`：300×300 RGBA，alpha 逐像素保留（`np.array_equal` = True），瞳孔区域未改动。
- `hair.png`/其它贴图：本轮未动（发梢渐层是第 2 轮成果，保持）。
- **无溢出**：刘海投影在 v≥400（眼睛卡片）之前就渐出，实测眼白/虹膜无染色；脸颊/下颌差异 ≈ 渲染噪声；上眼睑眼影只在皮肤区 <0.08。
- **可回滚**：
  - 脸部：`python3 tools/enhance-textures.py --no-v3` 可生成第 2 轮版本覆盖回来；
  - 眼睛：`python3 tools/enhance-eyes.py` 会从源贴图重新生成基础 eye1.png（并行线的脚本），之后要不要再跑 `--eye-anim` 由你决定；
  - 发梢：第 2 轮可选，`--hair-tips` 逻辑不变。
- 已执行 `python3 build.py` 刷新 `zero02-pet/assets/mmd/TDA-ZeroTwo/`（face.png / eye1.png 等已同步）。

## 9.4 脚本用法（第 3 轮新增）

```bash
python3 tools/enhance-textures.py            # 默认重建 face.png（第1+2+3轮）并输出 tex2/tex3 对比图
python3 tools/enhance-textures.py --eye-anim # eye1.png 高光强化（已加强过会自动跳过；--eye-anim-force 强制）
python3 tools/enhance-textures.py --no-v3    # 只到第 2 轮（生成第 3 轮 before 基准）
python3 tools/enhance-textures.py --stage    # 生成 models/mmd/_tex-test/ 验证目录
python3 tools/enhance-textures.py --render-compare  # 拼渲染对比图（含 tex3-char/eye/face 三组）
```

## 9.5 结论：建议保持

- **刘海投影：达到效果，建议保持。** 额头/眉骨处有暖紫棕的柔和投影，阴影下缘随发绺起伏，移动/甩头时不会出现硬边；最深处 0.14 在任务范围内，mmd-preview 里肉眼明显，mmd-char 里是“淡但存在”的层次（信号≈2.3× 渲染噪声）。
- **上眼睑眼影：达到效果，建议保持。** 很淡的暖色让眼窝更立体，与刘海投影连成一片；不会看起来像眼影妆画重（≤0.08）。
- **眼睛高光：达到效果，建议保持。** 左上主高光变大变亮，右下多一条小反光弧，眼特写下“闪”的感觉更像动画；瞳孔/虹膜形状未动、alpha 未动。
- **鼻部阴影：达到效果，建议保持。** 鼻梁两侧/鼻底极淡阴影，鼻子不再是一块平白；≤0.075 无脏感。
- **副作用/风险**：无溢出到眼睛或脸颊；mmd-char 渲染本身有 AA 噪声，对比图看边缘会有细微差别（非贴图问题）；阴影属于“很淡”级别，如果后续想要更重，只需把 `V3_BANG_ALPHA` / `V3_LID_ALPHA` 各 +0.02~0.04（仍建议 ≤0.16，避免“脸脏”）。
