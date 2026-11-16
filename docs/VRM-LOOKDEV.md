# VRM 观感（LookDev）研究 —— 让 VRM 在 200×300 桌面小组件里像精修动漫手办

> 角色：**美术指导 / 参数 research**（不写渲染器主逻辑）
> 目标读者：`src/3d/vrmchar.js` 的集成方
> 版本基线：**three r166**（`vendor/three.global.js`）+ **@pixiv/three-vrm 3.5.5**（`vendor/vrm-src`，打包成 `vendor/three-vrm.global.js`）
> 证据来源：three-vrm 3.5.5 源码（逐文件核对，清单见 §6）+ 本仓库 `models/` 下 **10 个真实 VRM 模型**的实测数据
> 交付物：
> - 本文档 `docs/VRM-LOOKDEV.md`
> - 工具模块 `src/3d/vrm-style.js`（`module.exports.create(THREE, VRMT)`，已用 `node --check` + mock 单测验证，**尚未接进 build.py，需要集成方加一行**）
> 标注约定：**[已核实]** = 源码/实测确认；**[待验证]** = 有依据但需要真机看效果；**[推测]** = 经验值，必须截图确认。

---

## 0. TL;DR（赶时间只看这页）

### 0.1 六个最重要的结论

1. **颜色/对比度不用动渲染器**：`stage.js` 已经是 `outputColorSpace = SRGB`、three 默认 `NoToneMapping`。**MToon 的 fragment shader 自带 `<tonemapping_fragment>` + `<colorspace_fragment>`**（`mtoon.frag` L304-305），所以改 renderer 的 tone mapping 会全局影响 MToon。保持 **NoToneMapping** 最像动漫；ACES 只在想要"摄影感"时开（§2.6）。
2. **描边必须从"模型自带宽度 × gain"改成"按像素反算绝对宽度"**。按源码推导，当前 `outlineGain=4.2` 在 300px 窗口只有 **≈0.22 CSS px**（§2.5 有完整推导和校准方法），几乎不可见。目标 **1.0–1.4 px**：用 `screenCoordinates` 时 `outlineWidthFactor = 2·px/H ≈ 0.0067–0.0093`；用 `worldCoordinates` 时 `outlineWidthFactor = px·(stageHeight·margin)/H ≈ 0.0155–0.0217`。
3. **光照够用但环境光偏高**：现有 `ambient 0.5 + hemi 0.3` 会把 MToon 的两段阴影"抹平"（环境光照的是 `diffuseColor`，不参与 shade）。建议 **key 2.7–3.0 / fill 0.55–0.75 / rim 0.8–1.1 / ambient 0.30–0.40 / hemi 0.20–0.28**（§3.2）。MToon 的 `litColor = lightColor × (1/π) × mix(shade, base, shading)`，**DirectionalLight 强度 π（3.14）≈ 满亮基色**——这就是 three-vrm 官方 basic 示例用 `Math.PI` 的原因。
4. **Rim 用材质参数，不要靠灯光**：`parametricRimColorFactor × saturate(1-dot(V,N)+lift)^fresnel`，把 `rimLightingMixFactor = 0` 就得到不随灯光闪的稳定轮廓线，在深色/浅色 UI 上都成立（§2.4）。这比加一盏物理 rim 灯更可控（灯只影响 `rimMix=1` 的材质）。
5. **Q 版头身比必须改 raw 骨的 scale**：three-vrm 的归一化骨架每帧只把 **quaternion（+ hips.position）** 写回 raw 骨（`VRMHumanoidRig.update()` 源码），**不写 scale**。所以 `getNormalizedBoneNode('head').scale` 无效，要 `getRawBoneNode('head').scale.setScalar(1.3~1.45)`（§4.4）。
6. **200×300 下脸只有 ~38px 宽、眼睛（眼白）只有 ~24×7px、虹膜 ~19×5px、眉毛 ~1px**（用 `models/twist.vrm` 实测几何算出，§5.1）。所以"像精修手办"的核心不是贴图精度，而是：**大轮廓（描边/rim）+ 脸打平 + 眼睛放大/高光提亮 + 头身比 + 配件辨识度**。细节必须夸张，不要试图还原。

### 0.2 一页参数（可直接抄）

| 项 | 值（200–300px 窗口） | 说明 |
|---|---|---|
| 描边颜色 | `#2a2438` 或角色色相压暗 30% | 不要纯黑；深色 UI 上纯黑=消失 |
| 描边宽度 | **1.0–1.4 CSS px**（Q 版 1.4–1.6） | 换算见 §2.5 |
| 描边模式 | 优先 `screenCoordinates` | 像素恒定、与模型缩放无关 |
| 脸/眼/眉/嘴材质 | `shadingShiftFactor +0.7~0.95`、`shadingToonyFactor 0.95~1`、`rim=0` | 小窗口必须"打平" |
| 身体/衣服 | `shadingShift -0.04~-0.08`、`toony 0.92`、rim 0.12–0.16 | |
| 头发 | `shadingShift -0.12`、`toony 0.94`、`rim 0.22`、`fresnel 3.2`、`lift 0.12` | 发梢轮廓是辨识度来源 |
| 高光 | 头发加 matcap 天使环（`matcapFactor` 0.3–0.5，`rimLightingMix=0`） | VRM0 VRoid 自带 `MatcapWarp_01/02`，VRM1 需要自己补 |
| 灯 | key 2.8 / fill 0.65 / back 1.0 / ambient 0.35 / hemi 0.25 | 全为无阴影 Directional/Ambient/Hemisphere |
| tone mapping | `NoToneMapping` | 开 ACES 时 face/eye 材质 `toneMapped=false` |
| 头身比 | head raw scale **1.30–1.45**，neck 1.03–1.08 | Q 版/鲸鲸；一次性设置，勿每帧覆盖 |
| SpringBone | 按模型缩放 ×s 补偿后：stiffness ×1.1–1.25、drag 0.45–0.55、gravity 0.02–0.08 | 官方 guide 要求缩放后补偿（§5.4） |

---

## 1. 现有管线盘点（改之前先对齐）

### 1.1 已经做对的（不要重复造）

`src/3d/vrmchar.js` 已经解决：

| 已有实现 | 位置 | 评价 |
|---|---|---|
| VRM 加载（`GLTFLoader.parseAsync` + `VRMLoaderPlugin`） | `parseVRM()` | ✅ |
| VRM0 朝向修正 `VRMUtils.rotateVRM0(vrm)`（`vrm.meta.metaVersion === "0"`） | `parseVRM()` | ✅ 和官方 migration guide 一致 |
| 按包围盒等比归一化到舞台高度 4.4、脚底 y=0 | `attachModel()` | ✅ 推荐保持 |
| **姿态包围盒**测量（不用 T-pose 张开手臂的包围盒） | `measurePosed()` | ✅ 很关键 |
| 灯光（ambient/hemi/key/fill/rim 五件套） | `makeLights()` / `applyLight()` | 值需微调（§3） |
| MToon 描边 amplify / 缺失时补壳 | `setupMaterials()` | 宽度算法需要改成像素反算（§2.5） |
| 渲染器 tone mapping / outputColorSpace 管理 + dispose 还原 | `setupRenderer()` | ✅ 已用 NoToneMapping + SRGB |
| 归一化骨骼摆姿势（只写 rotation） | `setupRig()` / `applyPose()` | ✅ 与 three-vrm 设计一致 |
| 表情别名映射 + 平滑 + 眨眼 | `EXPR_ALIASES` / `applyExpressions()` | ✅ |
| LookAt（`vrm.lookAt.target`） | `setupLookAt()` | ✅ |
| `vrm.update(dt)` 每帧（humanoid/lookAt/expression/springBone/材质 UV 动画） | `update()` | ✅ 顺序正确 |

### 1.2 观感上还差的 6 件事（按收益排序）

1. **描边宽度没按像素算** → 现在可能 <0.3px。要按 §2.5 反算成 1.0–1.4px（最影响"手办感"）。
2. **脸没有打平** → VRM1 模型（如 `twist.vrm`）的 `Face_00_SKIN` 是 `shadingShift -0.05`，脸上的明暗分界在小窗口会变成"脏阴影"。脸/眼材质改成 `shift ≥ +0.7`。
3. **没有风格化 rim** → 模型自带的 rim 基本是 0（VRoid VRM0 `_RimColor 0.25` 但 `_RimFresnelPower=100` + `rimLightingMix=0`，10px 内看不见）。加 §2.4 的材质 rim，深色 UI 上立刻"出边"。
4. **眼睛在 200×300 下不可读**（虹膜 ~19×5px）→ 头身比 + 眼骨放大 + 高光 emissive（§4.4 / §5.2）。
5. **四个形象没有"形"** → 现在四个形象共用同一套衣服/发型；必须靠配色 + 配件（角/发带/贝雷帽/女仆头饰/鲸尾）+ 头身比区分（§4.3 / §4.6）。
6. **环境光偏高** → `ambient 0.5` 把阴影洗掉，导致 MToon 看起来像"糊掉的 PBR"。降到 0.30–0.40（§3.2）。

> 硬性约束提醒：本任务不允许改 `src/3d/` 其它文件。本文所有"建议改 vrmchar"的地方都写成**集成方操作清单**，参数值可直接作为 `char.setLight()` / `cfg` 传入，或由 `vrm-style.js` 在挂载后覆盖。

---

## 2. MToon 参数推荐

### 2.1 MToon 到底怎么算颜色（源码公式）[已核实]

以下全部来自 `packages/three-vrm-materials-mtoon/src/shaders/mtoon.frag`（v3.5.5）：

```glsl
// 1) 阴影因子：dotNL 加 shift，再用 toony 控软硬
float getShading(float dotNL, float shadow, float shadingShift) {
  float shading = dotNL + shadingShift;
  shading = linearstep(-1.0 + shadingToonyFactor, 1.0 - shadingToonyFactor, shading);
  return shading * shadow;
}
// 2) 漫反射 = 灯光颜色 × 1/π × mix( shadeColor, diffuseColor, shading )
vec3 col = lightColor * BRDF_Lambert( mix( material.shadeColor, material.diffuseColor, shading ) );
```

推论（本文大量用到）：

- `diffuseColor = litFactor × map`（`material.color` 就是 `litFactor`）；`shadeColor = shadeColorFactor × shadeMultiplyTexture`。
- **`shadingToonyFactor` 越大 = 明暗分界越硬**（1 = 硬切，0 = 线性）；默认 0.9。
- **`shadingShiftFactor` 越大 = 越偏亮**；`+0.7` 以上基本全亮 = "打平脸"。
- 灯光颜色是**乘算**：`DirectionalLight` 强度 π 时，全亮面的输出 ≈ `diffuseColor`。这是判断灯光强度是否"正确曝光"的基准（§3.2）。
- **环境光/半球光只乘 `diffuseColor`**（`RE_IndirectDiffuse_MToon`），不参与 `shadeColor` 混合 → 环境光越高，阴影对比越弱。小窗口不要给高 ambient。
- `giEqualizationFactor` 是"环境光按法线取 vs 按上下平均"的插值；MToon 里环境光本身是平的，所以这个值在 three.js 下的主要观感是**间接光颜色是否随法线变化**。桌面小组件场景基本可以把 skin/face 设 0.75–0.9（更平），cloth 0.85–0.9。
- **MToon 没有 envMap**（`mtoon.frag` 里 `#include <envmap_fragment>` 被注释掉）→ 想要"塑料手办反光"只能靠 **matcap + rim**，`scene.environment` 对它无效。这也是为什么 §2.3 的 matcap 很重要。

### 2.2 `shadingShiftFactor` / `shadingToonyFactor` / `giEqualizationFactor` 推荐值

先分类再套值（分类规则见 `vrm-style.js` 的 `classify()`；VRoid 命名见 §4.1）。

| 类别 | 匹配示例（实测模型里的名字） | shadingShift | shadingToony | giEqualization | rim |
|---|---|---|---|---|---|
| 脸皮肤 | `Face_00_SKIN`、`N00_000_00_Face_00_SKIN` | **+0.72** | 0.96 | 0.90 | 0 |
| 五官线条（嘴/眼线/睫毛/眉） | `FaceMouth_00_FACE`、`FaceEyeline_00_FACE`、`FaceBrow_00_FACE` | +0.90 | 1.00 | 1.00 | 0 |
| 眼白 | `EyeWhite_00_EYE` | +0.95 | 1.00 | 1.00 | 0 |
| 虹膜/瞳 | `EyeIris_00_EYE`、`eye`、`eye_trans` | +0.95 | 1.00 | 1.00 | 0 |
| 眼球高光 | `EyeHighlight_00_EYE` | +1.00 | 1.00 | 1.00 | 0 |
| 身体皮肤 | `Body_00_SKIN`、`N00_000_00_Body_00_SKIN` | +0.25 | 0.92 | 0.75 | 0.10 |
| 头发（前/侧） | `Hair_00_HAIR`、`F00_000_Hair_00_HAIR_01`、`hair` | **-0.12** | 0.94 | 0.90 | 0.22 |
| 后发 | `HairBack_00_HAIR`、`hair_tail` | -0.16 | 0.94 | 0.90 | 0.16 |
| 衣服 | `Tops_01_CLOTH`、`Bottoms_01_CLOTH`、`huku_bake` | -0.04 | 0.92 | 0.90 | 0.14 |
| 配饰（鞋/领结/腰带） | `Shoes_01_CLOTH`、`AccessoryNeck_01_CLOTH` | -0.04 | 0.92 | 0.90 | 0.18 |
| 其它/未分类 | `robo_face` 之外的非 VRoid 材质 | -0.05 | 0.92 | 0.90 | 0.10 |

> 为什么脸要 +0.72：VRoid VRM0 导出里脸材质的原始 `_ShadeShift = -0.8`（v0compat 换算后约 `shadingShiftFactor = +0.71`），这是原作者的意图——**脸永远不打阴影**。VRM1 转换模型（`twist.vrm`）里脸是 `-0.05`，在小组件上就会脏，必须手工改回来。

代码（`vrm-style.js` 的预设就是这张表）：

```js
// vrm-style.js 内部 applyLookdev(vrm, "figure")
STYLE.applyLookdev(vrm, "figure");
// 等价于逐材质：
var m = STYLE.findMaterial(vrm, /face.*skin/i);
m.shadingShiftFactor = 0.72;
m.shadingToonyFactor = 0.96;
m.giEqualizationFactor = 0.90;
m.parametricRimColorFactor.setRGB(0, 0, 0);
```

### 2.3 高光：matcap / sphericalMap（重点，决定"手办塑料感"）

#### 2.3.1 MToon 的 matcap 是什么 [已核实]

MToon 1.0 没有 PBR specular，`matcapTexture` 是**加在 rim 上**的：

```glsl
// mtoon.frag L769-795
vec3 rimMix = mix(vec3(1.0), reflectedLight.directSpecular, rimLightingMixFactor);
vec3 rim = parametricRimColorFactor * pow(saturate(1.0 - dot(viewDir, normal) + parametricRimLiftFactor),
                                          parametricRimFresnelPowerFactor);
#ifdef USE_MATCAPTEXTURE
  vec3 x = normalize(vec3(viewDir.z, 0.0, -viewDir.x));
  vec3 y = cross(viewDir, x);
  vec2 sphereUv = 0.5 + 0.5 * vec2(dot(x, normal), -dot(y, normal));
  rim += matcapFactor * texture2D(matcapTexture, sphereUv).rgb;
#endif
col += rimMix * rim;
```

- matcap 的 UV 来自**视空间法线**（屏幕固定），不是模型 UV —— 所以它像"贴在镜头前的反光"，非常适合手办塑料高光。
- **`rimLightingMixFactor = 0` 时 `rimMix = 1`**：matcap/rim 直接加上去，不受灯光方向影响 → **稳定、可预测**，深色 UI 上尤其重要。
- **`rimLightingMixFactor = 1` 时** `rimMix = 累加的直接光`（MToon 把 directSpecular 当"光照标量"用），只有受光面才出现 rim/matcap → 会随灯光闪，小窗口不建议（VRoid 默认是这个 1，但 rim 色为 0）。
- 官方示例与真实模型：
  - VRM1 示例 `models/twist.vrm` **没有** matcap（`matcapTexture` 字段不存在）。
  - VRM0 的 VRoid 模型（`VRoid_V110_Female_v1.1.3.vrm`）**默认带 matcap**：`_SphereAdd` = `MatcapWarp_01`（脸/身体/衣服/眼线）或 `MatcapWarp_02`（前发），经 three-vrm v0compat 转成 `matcapTexture`，`matcapFactor=[1,1,1]`、`rimLightingMix=0`。也就是说 **VRM0 的 VRoid 模型天然就有"插件化手办高光"**，只是强度靠贴图本身。
  - MToon 规范原文（`vrm-c/vrm-specification` `VRMC_materials_mtoon-1.0/README.md`）："The result of matcap is additive blended to the lighting result."、`matcapUv = Vector2(dot(worldViewX, N), dot(worldViewY, N)) * 0.495 + 0.5`。

#### 2.3.2 给 VRM1 / 无 matcap 模型补"天使环"

做法：**用 canvas 画一张横向亮带的 matcap 贴图**（`vrm-style.js` 已实现 `STYLE.matcapTexture()`），挂到头发材质：

```js
var mat = STYLE.findMaterial(vrm, /hair/i);
var tex = STYLE.matcapTexture();          // 无 document 时返回 null
if (tex) {
  mat.matcapTexture = tex;
  mat.matcapFactor.setRGB(0.35, 0.35, 0.35);   // 线性 RGB，0.3~0.5 比较像手办
  mat.rimLightingMixFactor = 0;                 // 关键：不受灯光调制，稳定出现
  mat.needsUpdate = true;                        // 关键：USE_MATCAPTEXTURE 是编译期 define
}
```

注意点（都踩过/源码确认）：

- **必须 `material.needsUpdate = true`**：matcap 有无会改变 shader 的 `#define USE_MATCAPTEXTURE`（`MToonMaterial._generateDefines()`），不重编译不生效。
- matcap 贴图必须设 `colorSpace = SRGBColorSpace`：`MToonMaterial.customProgramCacheKey()` 会把 matcap 的 colorSpace 编进程序缓存 key（`MToonMaterial.ts` L445-453），设错会导致同一材质在不同实例间串程序。
- 天使环的位置靠 `sphereUv` 的 v 分量（法线上下）。`vrm-style.js` 的贴图默认 **`flipY = false`、亮带在 v∈[0.16,0.30]**；如果实测环跑到头顶上方/下巴，把 `flipY` 反过来或改 `band` 区间。
- 小窗口不要给每根发丝都上 matcap（会闪、会花）；只给前发主材质即可，后发用 rim。
- **VRM0 的 `_SphereAdd` 已被 v0compat 转成 matcap**（`packages/three-vrm-materials-v0compat/src/VRMMaterialsV0CompatPlugin.ts` L170-180），不要再重复加第二层。

#### 2.3.3 不推荐的做法

- `MeshStandardMaterial` / `MeshPhysicalMaterial` 配件：小窗口下 PBR 又灰又糊，和 MToon 身体不统一（`docs/3D-ARCHITECTURE.md` 里已有同样结论）。
- `scene.environment` / PMREM：MToon 不采样 envMap，白费性能。
- 用 `emissiveMap` 当高光：会随 tone mapping/曝光走，且不随视角动，看起来"发光"而不是"反光"。

### 2.4 Rim lighting（轮廓光）—— 透明背景上的"分离线"

公式（同 §2.3.1 源码）：

```
rim = parametricRimColorFactor × saturate(1 - dot(V, N) + lift)^fresnel
col += mix(1, directSpecular, rimLightingMixFactor) × rim
```

- `parametricRimFresnelPowerFactor` 越**大** rim 越细（贴边）；默认 5 太细，200px 下几乎看不见。
- `parametricRimLiftFactor` 给一个"下限"，让 rim 不只出现在纯边缘，头发/肩膀会有一层薄光。
- `rimLightingMixFactor`：**0 = 稳定轮廓光（推荐）**；1 = 受光面才有 rim（物理正确但会闪）。

推荐值（按类别）：

| 类别 | `parametricRimColorFactor`（线性） | fresnel | lift | rimLightingMix | 观感 |
|---|---|---|---|---|---|
| 头发 | 基色提亮的 0.20–0.28（粉发用 `#ffd6e6`≈0.35 线性） | 3.0–3.6 | 0.10–0.14 | 0 | 发丝边缘一圈亮线，最出效果 |
| 衣服 | 0.12–0.18（偏角色主题色） | 3.4–4.0 | 0.08–0.12 | 0 | 肩膀/裙摆轮廓 |
| 身体皮肤 | 0.06–0.12（偏暖） | 4.0–5.0 | 0.06–0.10 | 0 | 轻，不要抢脸 |
| 脸/眼 | **0**（保持干净） | — | — | — | 脸上有 rim 会显脏 |
| 后发 | 0.14–0.20 | 3.2 | 0.10 | 0 | 和背景分开 |

代码：

```js
// 头发
var hair = STYLE.findMaterial(vrm, /hair/i);
hair.parametricRimColorFactor.copy(new THREE.Color(0xffd6e6)); // sRGB hex -> 线性
hair.parametricRimFresnelPowerFactor = 3.2;
hair.parametricRimLiftFactor = 0.12;
hair.rimLightingMixFactor = 0;
// 身体
var body = STYLE.findMaterial(vrm, /body.*skin/i);
body.parametricRimColorFactor.setRGB(0.10, 0.075, 0.085);      // 线性，偏暖灰
body.parametricRimFresnelPowerFactor = 4.2;
body.rimLightingMixFactor = 0;
```

> rim 的"加法"在深色 UI 上会把角色从背景里"抠"出来，是透明背景桌宠最划算的一招；在浅色 UI 上也不会过曝（因为 rim 是 add 到基色上，最多把边缘提亮到 1.0）。

### 2.5 Outline（描边）—— 小窗口第一观感参数

#### 2.5.1 两种 widthMode 的单位 [已核实]

MToon 规范（`VRMC_materials_mtoon-1.0/README.md` "Outline Width"）：

> The unit of `outlineWidthFactor` is **meters** when the mode is `worldCoordinates`, or a **ratio to the screen height** when `screenCoordinates`.

three-vrm 3.5.5 的顶点实现（`mtoon.vert` L95-112）：

```glsl
float worldNormalLength = length( transformedNormal );
vec3 outlineOffset = outlineWidthFactor * worldNormalLength * objectNormal;
#ifdef OUTLINE_WIDTH_SCREEN
  outlineOffset *= vViewPosition.z / projectionMatrix[ 1 ].y;
#endif
gl_Position = projectionMatrix * modelViewMatrix * vec4( outlineOffset + transformed, 1.0 );
```

由此可推出（注意：`objectNormal` 已被 `normalize()`，`normalMatrix` 对均匀缩放 s 的模长是 1/s）：

- **worldCoordinates**：屏幕像素宽度 `px ≈ outlineWidthFactor × H / (bboxH × margin)`。
  - `outlineWidthFactor` 是**世界单位（米）**，且**和模型 scene.scale 无关**（法线模长补偿把缩放抵消掉）。
  - 换成舞台的归一化高度（vrmchar 把角色归一到 4.4）：`px = w × H_px / (4.4 × 1.06)`。
- **screenCoordinates**：`px ≈ outlineWidthFactor × H_px / 2`（NDC 偏移量正好等于 `outlineWidthFactor`，NDC 全高 2 对应 H 像素）。
  - 与模型缩放、相机距离无关，**最推荐**。

> 说明：源码推导与规范文字"ratio to screen height"看起来差 2 倍，是因为规范描述的是"两侧总宽/整屏比例"，而 three-vrm 实现里 `w` 是单侧外扩在 NDC 的量，换算到单侧像素是 `w·H/2`。**以 three-vrm 实现为准**，首版按本文数值上真机、用截图数像素校准一次即可（见 §2.5.4）。

#### 2.5.2 换算表（直接抄）

在 300px 高的窗口、角色归一化高度 4.4、`margin=1.06`（`stage.frame` 默认）下：

| 目标像素 | screenCoordinates `w` | worldCoordinates `w` |
|---|---|---|
| 0.8 px | 0.0053 | 0.0124 |
| 1.0 px | 0.0067 | 0.0156 |
| **1.2 px（推荐）** | **0.0080** | **0.0187** |
| 1.4 px（Q 版） | 0.0093 | 0.0218 |
| 1.6 px（Q 版） | 0.0107 | 0.0249 |

公式（`vrm-style.js` 已实现 `STYLE.outlineFactorForPx()`）：

```js
// screen：w = 2 * px / viewportHeightPx
STYLE.outlineFactorForPx({ px: 1.2, mode: "screen", viewportHeightPx: 300 }); // 0.008
// world：w = px * stageHeight * margin / viewportHeightPx
STYLE.outlineFactorForPx({ px: 1.2, mode: "world", viewportHeightPx: 300,
                           stageHeightWorld: 4.4, margin: 1.06 });            // ≈0.0187
```

窗口尺寸不是 300 时按比例改 `viewportHeightPx`（例如 onee 的 172×360 → H=360）。

> **竖长窗口修正（world 模式）**：`stage.setSize()` 在 `aspect < 0.85` 时会额外拉远相机
> `k = 1 + (0.85 - aspect) * 0.55`（`src/3d/stage.js`），world 模式的像素宽度会再 ÷k。
> 四个真实窗口的 k：195×300 → 1.11；180×300 → 1.14；172×360（aspect 0.478）→ 1.20；215×285 → 1.05。
> 所以 world 模式完整公式：`w = px × charHeight × margin × k / H_px`。
> **screen 模式不受影响**（NDC 偏移与相机距离无关），这也是推荐 screen 模式的另一个原因；
> 若必须用 world 模式，把 `STYLE.outlineFactorForPx({mode:"world"})` 的结果再乘 k 即可。

#### 2.5.3 当前实现的问题 + 怎么改

`vrmchar.js` 现在是：模型自带描边就 `outlineWidthFactor *= outlineGain`（默认 4.2）；没有就把 `0.0016` 补上去。

- VRoid 模型原始描边宽度 = `0.0008`（`_OutlineWidth = 0.08cm × 0.01`，v0compat 源码 L193-195）→ 4.2 倍后 = `0.00336` → **300px 窗口 ≈ 0.22 px**（360px 窗口 ≈ 0.26 px）。几乎是"没有描边"。
- 模型间差异大（`Seed-san` 是 0.0011–0.0020）→ 乘 gain 无法统一观感，**必须改成绝对宽度**。

**建议改法（集成方二选一）**：

A. 不改 `vrmchar.js`，挂载后由 `vrm-style.js` 覆盖（推荐）：

```js
// vrmchar attachModel() 成功之后 / char.mountPromise.then(...) 里
var STYLE = __req("vrm-style").create(THREE, THREE_VRM);
STYLE.setOutline(vrm, {
  mode: "screen",          // 或 "world"
  px: 1.2,                 // 目标像素
  viewportHeightPx: host.clientHeight || 300,
  color: 0x2a2438,
});
```

B. 改 `cfg.outlineGain`：只能让所有模型"同倍率"，不建议；如果非要，`outlineGain ≈ 12–16` 更接近 1px（但仍会因模型原始宽度不同而不一致）。

> `setOutline` 默认只改**已存在**的描边材质（VRM1 loader 会按 `outlineWidthMode !== "none" && outlineWidthFactor > 0` 自动生成；`MToonMaterialLoaderPlugin._shouldGenerateOutline()` 源码）。给没有描边的模型补壳用 `{ createMissing: true }`（实验性，会自动跳过脸/眼/眉/嘴/高光）。

#### 2.5.4 真机校准（必须做一次）

1. `python3 build.py && python3 tools/serve.py`；
2. `lab/vrm-test.html?model=twist&view=front`（或现有 `lab/vrm-preview.html`）用 `tools/shot.mjs --size 195x300` 截图；
3. 把截图放大 400%，数角色轮廓上的深色像素宽度；目标 **1.0–1.4px**（Q 版 1.4–1.6）；
4. 用像素反算：`w_screen = 2 × (实测px) / 300`；或直接改 `px` 参数重截。
5. 检查三处：**头/发外轮廓、下巴-脖子交界、裙摆**。如果只有头发有描边，说明脸材质被 skip 了（正常，眼睛不要描边）。

#### 2.5.5 描边其它参数

| 参数 | 建议 | 说明 |
|---|---|---|
| `outlineWidthMode` | `screenCoordinates` | 像素恒定；`worldCoordinates` 也可，换算不同 |
| `outlineWidthFactor` | 见上表 | 绝对宽度，不要乘 gain |
| `outlineColorFactor` | 角色色相压暗 25–35% + 冷紫墨色（如 `#2a2438`） | 纯黑在深色 UI 会"融掉"；`#35222e`/`#2a2438` 实测更耐看 |
| `outlineLightingMixFactor` | 0（固定墨线）或 0.15–0.3（受光处稍亮） | 0 最像印刷线稿；不要用 1（会闪） |
| per-material 差异 | 后发/身体/衣服用同一宽度；**脸/眼/眉/嘴/高光必须无描边** | 脸部描边会让眼睛糊成一团 |
| 性能 | 描边 = 同 mesh 第二遍 draw call（同一 buffer 两个 group，`MToonMaterialLoaderPlugin._generateOutline()` 源码）；小窗口可接受，不建议再额外加反壳 | |

### 2.6 颜色空间与 Tone Mapping

#### 2.6.1 色彩管线现状（不要动）[已核实]

- `stage.js`：`renderer.outputColorSpace = THREE.SRGBColorSpace`，`toneMapping` 默认 `NoToneMapping`。
- MToon fragment 末尾：`#include <tonemapping_fragment>` + `#include <colorspace_fragment>`（`mtoon.frag` L304-305）→ **MToon 完全走 three 的 tone mapping / 输出色彩空间**。
- MToon 的材质 factor（`litFactor`/`shadeColorFactor`/`outlineColorFactor`/`parametricRimColorFactor`/`matcapFactor`）都是**线性值**：
  - glTF 里 `baseColorFactor` / MToon factor 本身就是 linear；loader 用 `new THREE.Color().fromArray(...)` 直接塞（`GLTFMToonMaterialParamsAssignHelper.assignColor()`）。
  - 贴图（`map`/`shadeMultiplyTexture`/`matcapTexture`…）由 loader `setTextureColorSpace(texture, 'srgb')` 设为 sRGB（`GLTFMToonMaterialParamsAssignHelper.assignTexture()`）。
- **在 JS 里给 factor 赋值**：`new THREE.Color(0xRRGGBB)` / `.setHex()` 在 three r152+ 默认按 **sRGB 解释并转成线性工作空间**（`vendor/three.global.js` 的 `Color.setHex(e,t=Ft)` → `toWorkingColorSpace`）。所以直接用 hex 是对的；**不要** `setRGB(r/255, g/255, b/255)` 把 sRGB 数值当线性塞进去（颜色会偏亮/发灰）。

#### 2.6.2 NoToneMapping vs ACES：对 MToon 的影响

| | NoToneMapping（现状，推荐） | ACESFilmicToneMapping |
|---|---|---|
| 优点 | 平涂颜色最准；肤色/发色所见即所得；对比干净 | 高光柔和、整体更"摄影"、和暗色 UI 融合更自然 |
| 对 MToon 的影响 | 无（线性颜色直出 sRGB） | **整体压暗 + 去饱和**（尤其粉/红/蓝高饱和色）；线性 0.18 中灰被映射到约 0.14–0.15；纯色会变"奶" |
| 何时用 | 四形象都是动漫/手办风 → 默认 | 想要"模型摆件摄影"或整体 UI 偏暗、要胶片感 |
| 补偿方式 | — | `renderer.toneMappingExposure ≈ 1.2–1.35`；材质颜色预先提高饱和/亮度；**face/eye/highlight 材质 `toneMapped = false`** 保住五官颜色 |

> **ACES 只开也行，但一定先看脸**：ACES 会把 `#ff8fb9` 粉发压成灰粉、把青绿瞳压暗。若开 ACES，建议只让身体/衣服走 ACES，脸和眼睛用 `material.toneMapped = false`（`THREE.Material.toneMapped` 默认 true；three 的 WebGLPrograms 用 `material.toneMapped ? renderer.toneMapping : NoToneMapping` 决定是否注入 `TONE_MAPPING` define，MToon 的 `<tonemapping_fragment>` 因此可被单材质关闭）。**[已核实：three r166 源码 + MToon shader chunk；真机效果待验证]**

#### 2.6.3 代码

```js
// 现状（保持）：stage.js 已设置
// renderer.outputColorSpace = THREE.SRGBColorSpace;
// renderer.toneMapping = THREE.NoToneMapping;

// 如果决定开 ACES（不推荐默认开）：
stage.renderer.toneMapping = THREE.ACESFilmicToneMapping;
stage.renderer.toneMappingExposure = 1.25;
// 单独保住五官颜色：
["Face", "EyeIris", "EyeWhite", "EyeHighlight", "FaceEyeline", "FaceBrow", "FaceMouth"]
  .forEach(function (key) {
    var m = STYLE.findMaterial(vrm, key);
    if (m) m.toneMapped = false;   // 注意：MToon 是 ShaderMaterial，但 toneMapped 是基类属性
  });
```

#### 2.6.4 自定义贴图/材质的色彩空间（配件必看）

- 配件用 `MeshBasicMaterial`/`MToonMaterial` + `CanvasTexture` 时：**`texture.colorSpace = THREE.SRGBColorSpace`**（画布是 sRGB 数据）。
- 配件的 factor/color 用 hex 赋值（自动转线性）。
- 不要给配件贴 `NoColorSpace` 的 canvas 贴图，会偏亮一档。

### 2.7 参数总表（贴给材质初始化用）

| 参数 | 脸/眼 | 头发 | 身体皮肤 | 衣服 | 配件 |
|---|---|---|---|---|---|
| `shadingShiftFactor` | +0.72~+1.0 | -0.12 | +0.25 | -0.04 | -0.05 |
| `shadingToonyFactor` | 0.96~1.0 | 0.94 | 0.92 | 0.92 | 0.92 |
| `giEqualizationFactor` | 0.90~1.0 | 0.90 | 0.75 | 0.90 | 0.90 |
| `parametricRimColorFactor` | 0 | 0.22（粉发偏粉） | 0.10（偏暖） | 0.14（主题色） | 0.16 |
| `parametricRimFresnelPowerFactor` | — | 3.2 | 4.2 | 3.6 | 3.5 |
| `parametricRimLiftFactor` | — | 0.12 | 0.08 | 0.10 | 0.10 |
| `rimLightingMixFactor` | — | 0 | 0 | 0 | 0 |
| matcap | 无 | 0.30–0.45 白（天使环） | 无 | 无 | 无 |
| outline | 无 | 有 | 有 | 有 | 有（小件可省） |
| `toneMapped`（若开 ACES） | false | true | true | true | true |

---

## 3. 光照方案（透明背景 + 桌面小组件）

### 3.1 MToon 的光照约束 [已核实]

- MToon 基于 three 的 `lights_pars_begin` + 自定义 `RE_Direct_MToon`：**DirectionalLight / PointLight / SpotLight / AmbientLight / HemisphereLight 都支持**，但：
  - **没有 envMap / IBL / light probe**（`Material_LightProbeLOD` 被 define 成 0，envmap 相关 chunk 注释掉）。
  - **不投射阴影**：`shadowmap` 的 chunk 在，但小组件里 `vrmchar` 已设 `castShadow = receiveShadow = false`；模型自带阴影贴图（VRoid 的 `_ReceiveShadowTexture`）在 three-vrm 里也会被忽略。**不要开 shadowMap**：透明背景 + 200px 尺寸下阴影只会糊、且增加成本。
  - `giEqualizationFactor` 存在的前提是环境光；three 里对应 Ambient/Hemisphere 的间接光，值高时更平。
- **不要用 `scene.environment` / `PMREMGenerator`**：对 MToon 完全无效。

### 3.2 推荐灯光（数值 + 推导）

MToon 全亮面输出 ≈ `(key × max(N·L,0) + ambient + hemi) / π × diffuseColor`。要让白灯下的"贴图原色"基本还原，**总光照 ≈ π**，所以：

| 灯 | 颜色 | 强度 | 位置（相对角色根节点，脚底原点） | 作用 |
|---|---|---|---|---|
| key（主光） | `#fff4ec`（暖白） | **2.7–3.0** | `(2.2, 5.2, 3.6)`（右上前，约 35° 高） | 唯一产生 MToon 明暗分界的光 → 决定头/衣服的阴影形状 |
| fill（补光） | `#cfdfff`（冷白） | **0.55–0.75** | `(-3.2, 2.2, 2.4)`（左侧前） | 抬暗面、给冷色，避免死黑 |
| back/rim（背光） | `#ffd9e8` 或角色主题色 | **0.8–1.1** | `(-0.8, 3.4, -4.2)`（后上方） | 勾发丝/肩膀边缘；配合材质 rim 用 |
| ambient | `#ffffff` | **0.30–0.40** | — | 底光。**高于 0.45 会把 toon 阴影洗平** |
| hemi | sky `#ffeef6` / ground `#3a2f46` | **0.20–0.28** | — | 给一点天空/地面色差；ground 色别太黑 |

对现状（`ambient 0.5 / hemi 0.3 / key 2.7 / fill 0.75 / rim 1.0`）的调整建议：

- `ambient 0.5 → 0.35`（最大收益：阴影对比回来）；
- `hemi 0.3 → 0.25`；
- `key 2.7 → 2.9`（补回一点总光量，总和 ≈ 2.9+0.35+0.25 = 3.5 ≈ π 略多，可接受；若脸发白再降到 2.7）；
- `fill 0.75 → 0.65`；`rim 1.0` 保留（它是"背光"，不是材质 rim；两者可叠加）。

> 方向建议：key 从**角色右上前方**（屏幕右上）打，阴影落在角色左脸/左侧身体——符合 2D 立绘的习惯；`stage.js` 默认相机在 +Z，所以 `z` 分量保持正。不要从正前方打（分界会在脸中间，像戴面具）。

### 3.3 要不要额外加 rim light / additive 边缘光？

- **材质 rim 为主**（§2.4）：稳定、逐材质可控、零额外 draw call。
- **背光 DirectionalLight 为辅**：强度 0.8–1.1、冷色或角色色，让 `rimLightingMixFactor > 0` 的材质（比如 VRoid 自带 rim）在受光面有反应；但我们的预设 rimLightingMix=0，所以这盏灯主要是给头发/衣服"背面打亮"，防止背光面死黑。
- **additive 边缘光 mesh（额外反壳）不推荐**：200px 下会加一条 >1px 的亮边，和描边打架，且多一遍 draw call；用 `stage.js` 已有的 additive 背景光晕 sprite 就够。
- 现有 `stage.glow`（背光晕）建议保留，颜色跟角色 `glowColor`（02 粉/鲸鲸蓝），不透明度 0.5 左右；它是"氛围"，不是轮廓。

### 3.4 深色 / 浅色 UI 的适配

| 问题 | 深色 UI | 浅色 UI |
|---|---|---|
| 轮廓消失 | 描边色不要纯黑，用**深主题色**（`#2a2438`、`#35222e`）；同时开材质 rim 提亮外缘；`stage.glow` 用角色色 → 剪影可读 | 深描边效果好；rim 别太强（会发白），rim 色用 0.12–0.18 就够 |
| 头发发灰 | rim + matcap 提亮发丝；描边稍细（1.0px） | 降低 matcap（0.2–0.3）；描边 1.2px 更"印刷" |
| 皮肤发脏 | 脸打平（shift +0.72）；ambient 不要高 | 阴影可以稍多（shift +0.6） |
| 眼睛 | 高光材质 emissive 提亮（§5.2）；黑白瞳对比要够 | 虹膜别太浅，否则睫毛/眼线糊 |

建议在集成层按 `stage` 背景/宿主主题给两套参数（`figure-dark` / `figure-light`），只差 rem/outline/ambient 三个值。

### 3.5 昼夜模式（现有 `stage.setNight`）

`K.setNight` 只影响程序化手办材质；VRM 的 MToon 需要自己处理。建议：

```js
// night: 0（白天）→ 0.55（深夜），由 engine2d 每帧传入
function applyNight(char, night) {
  var L = {
    key: 2.9 - 1.1 * night,
    ambient: 0.35 - 0.12 * night,
    rim: 1.0 + 0.2 * night,
    keyColor: night > 0.3 ? 0xd9e4ff : 0xfff4ec,
    rimColor: night > 0.3 ? 0x9fc4ff : 0xffd9e8
  };
  char.setLight(L);
}
```

夜里的 MToon rim 用冷蓝（`#9fc4ff`）比白天更"精灵"；描边颜色可以同时压暗（`outlineColorFactor × 0.8`）。

### 3.6 验收流程（灯光）

1. `lab/vrm-test.html?model=twist&view=front&bg=transparent`；
2. `tools/shot.mjs --size 195x300 --wait 1500` 出图；
3. 检查：脸有没有明暗分界（有=shift 不够）、暗面是否死黑（死黑=fill/ambient 不够）、头发边缘是否和背景分离（没分离=rim 不够）；
4. 深浅背景各截一张（lab 支持 `bg=`，或直接把截图叠到 `#171222` / `#f4f1f8` 两种底色上对比）。

---

## 4. 把模型改造成四个形象（重点）

### 4.0 改造顺序（流水线，严格按这个顺序）

```
load VRM
  → VRMUtils.rotateVRM0(vrm)                     // VRM0 转 +Z 朝向（vrmchar 已做）
  → VRMUtils.removeUnnecessaryVertices(scene)    // 官方示例的性能三连（建议加）
  → VRMUtils.combineSkeletons(scene)
  → VRMUtils.combineMorphs(vrm)                  // 见官方 basic.html
  → scene.scale = targetHeight / rawHeight       // vrmchar 已做
  → scaleSpringBones(scene.scale)                // ★ 官方 guide 要求（§5.4）
  → Q 版：raw head/neck 骨 scale（一次性）        // ★ 必须在 vrm.update 前（scale 不会被覆盖）
  → 材质分类 + 染色 + MToon 参数（applyLookdev / tintByMaterialName）
  → 描边绝对宽度（setOutline）
  → 配件挂 raw 骨（attachToBone，space:"world"）
  → 重新量包围盒 + stage.frame（带配件的 bbox）
  → 表情/视线/spring 调参
```

注意：

- **`combineSkeletons` 之后骨骼节点还在**（它合并 skin/geometry，不删 humanoid 骨），配件挂载顺序不受影响；但要在它之后再做 Q 版 scale/挂配件，避免合并时读到旧矩阵。
- **Q 版 head scale 必须在 `vrm.update()` 之前设好**：之后每帧 `VRMHumanoidRig.update()` 只写 quaternion，scale 保持；但如果从 normalized 骨去设 scale 是无效的（见 §4.4）。
- 配件挂完后再量 bbox（因为角/帽子/尾巴会超出模型原 bbox），`vrmchar` 的 `measurePosed()` 可以在挂载后重跑一次（集成方需要加一次 `stage.frame`）。

### 4.1 在 VRM 上找材质 / 网格 / 贴图（VRoid 命名规律 + 实测）

#### 4.1.1 VRM 文件结构速查

| 层面 | 说明 |
|---|---|
| `vrm.scene` | `THREE.Group`，整个模型（VRM0 经 `rotateVRM0` 后朝 +Z） |
| mesh | 通常 3 个：`Body` / `Face` / `Hair`（VRM1 VRoid），或 `Body.baked` / `Face.baked` / `Hair001.baked`（VRM0 VRoid）。非 VRoid 模型名字随便（`Seed-san` 是 `hair` / `head` / `robo_arm` / `wear`） |
| primitive / material | 一个 mesh 里按材质拆多个 primitive；VRM1 每个 primitive 是独立 `THREE.Mesh`（在 Group 里），**`mesh.material` 可能是数组**：`[表面MToon, 描边MToon]` |
| 材质 | `MToonMaterial`，带 `isMToonMaterial` / `isOutline` 标记；描边克隆名 = `原材质名 + " (Outline)"` |
| humanoid 骨 | `vrm.humanoid.getRawBoneNode("head")` 等；VRoid 骨骼节点名是 `J_Bip_C_Head` / `J_Sec_Hair1_01`，**不要按节点名找，用 humanoid API** |
| 贴图 | 内嵌 PNG/JPEG，`material.map.image` 可直接画到 canvas（需 `crossOrigin`/无跨域问题，内嵌图没这个问题） |

#### 4.1.2 VRoid 材质命名规律 [实测：`models/` 下 10 个 VRM]

| 版本 | 规律 | 实测例子 |
|---|---|---|
| **VRM1（VRoid 1.0 导出）** | `<Part>_<2位编号>_<CATEGORY>` | `Body_00_SKIN`、`Face_00_SKIN`、`Hair_00_HAIR`、`HairBack_00_HAIR`、`FaceMouth_00_FACE`、`FaceEyeline_00_FACE`、`FaceEyelash_00_FACE`、`FaceBrow_00_FACE`、`EyeIris_00_EYE`、`EyeWhite_00_EYE`、`EyeHighlight_00_EYE`、`EyeExtra_01_EYE`、`Tops_01_CLOTH`、`Bottoms_01_CLOTH`、`Shoes_01_CLOTH`、`AccessoryNeck_01_CLOTH` |
| **VRM0（VRoid 0.x 导出）** | `<N00/F00/M00>_<000=头/001=套装号>_<01=变体>_<Part>_<2位编号>_<CATEGORY>`；头发可能带 `_01.._04` 后缀拆多个材质 | `N00_000_00_FaceMouth_00_FACE`、`N00_000_00_Body_00_SKIN`、`N00_000_Hair_00_HAIR`、`N00_000_00_HairBack_00_HAIR`、`N00_001_01_Bottoms_01_CLOTH`、`N00_004_01_Tops_01_CLOTH`、`F00_000_00_EyeIris_00_EYE`、`F00_000_Hair_00_HAIR_01` |
| **非 VRoid** | 英文小写/下划线，如 `hair`、`hair_tail`、`huku_bake`（衣服）、`body_bake`、`eye`、`eye_trans`、`robo_face`、`arm_plastic`、`wear_metal`、`matcap` 等 | `Seed-san.vrm` |

**材质大类 → 匹配正则**（`vrm-style.js` 里 `classify()` 的实现，按优先级）：

```js
eyeWhite  : /eye[\s_-]*white|eyewhite/i
eyeHighlight: /eye[\s_-]*highlight|eyehighlight/i
iris      : /iris|pupil|eyeextra|^eye$|^eye[_-]/i
faceLine  : /face[\s_-]*(mouth|eyeline|eyelash|brow)|mouth|brow|lash|eyeline|tooth|tongue/i
face      : /face[\s_-]*\d*[\s_-]*skin|face_00|^face$|robo[\s_-]*face/i
hair      : /hair/i
skin      : /_skin$|body[\s_-]?skin|body_00/i
cloth     : /cloth|clothes|tops|bottoms|shoes|socks|huku|wear|dress|skirt|uniform|apron|accessory|ribbon|neck/i
other     : 兜底
```

> 关键点：**不要按"网格名"染色**。VRoid 的 `Body` mesh 同时装着皮肤 + 上衣 + 下装 + 鞋 + 后发（5 个 primitive），按 mesh 染色会一锅端。必须按**材质名**。

#### 4.1.3 贴图命名（实测）

- VRM1 VRoid：`Body_00`、`Body_00_nml`、`Face_00`、`Face_00_outline`、`Hair_00`、`Hair_00_nml`、`Hair_00_spe`、`EyeIris_00`、`EyeWhite_00`、`EyeHighlight_00`、`FaceEyeline_00`、`FaceBrow_00`、`FaceMouth_00`。其中 `*_outline` 是描边宽度遮罩（MToon `outlineWidthMultiplyTexture`，取 G 通道），`*_nml` 是法线贴图，`*_spe` 是球面高光/MatCap 类的辅助贴图。
- VRM0 VRoid：图片名是 `_01`…`_17` 这种序号（不是材质名！），还有 `MatcapWarp_01` / `MatcapWarp_02`（VRoid 默认 matcap）、`Shader_NoneBlack`（黑色占位，=关闭 matcap）、`Shader_NoneNormal`、`N00_000_00_Face_00_out`、`N00_000_Hair_00_nml`。**要按材质找贴图，不要按图片名找**。
- 想改贴图颜色：`material.map.image` → canvas 重绘（§4.2.3）。

#### 4.1.4 找材质的代码

```js
var STYLE = __req("vrm-style").create(THREE, THREE_VRM);

STYLE.listMaterials(vrm);                       // 调试：打印全部材质名/网格/描边/贴图/颜色
STYLE.findMaterial(vrm, /hair/i);               // 第一个匹配（自动跳过描边克隆）
STYLE.findMaterials(vrm, /_cloth$/i);           // 全部匹配
STYLE.findOutline(vrm, hairMat);                // 配对的描边材质
```

### 4.2 换发色 / 瞳色 / 衣服颜色（a 题）——三种方式与"不脏"规则

#### 4.2.1 三种染色方式对比

| 方式 | 做法 | 适合 | 不适合 | 风险 |
|---|---|---|---|---|
| **A. `material.color`（= `litFactor` 乘法）** | `mat.color.copy(new THREE.Color(hex))` | 头发（VRoid 发贴图多为灰白，乘色最干净）、白/浅色衣服、白高光 | 虹膜（本身有颜色，乘法会发灰发暗）、深色花纹衣服 | 颜色会被贴图明度调制；乘多次会叠脏 |
| **B. `shadeColorFactor` / `parametricRimColorFactor` / `outlineColorFactor`** | 与 A 配套，给阴影/高光/描边同色相 | 所有需要"同一色系阴影"的材质 | 单独用不能改主色 | 阴影色如果太黑会"脏"——用**色相压暗**而不是加黑 |
| **C. 贴图 canvas 重绘（`STYLE.recolorMap`）** | 把 `map.image` 画到 canvas，逐像素转 HSL，换色相/饱和度、保留明度 | 虹膜/瞳色、本身有颜色的发贴图、衣服换色相 | 需要保留多色花纹时（会整张变单色） | 需要 `document`、贴图分辨率高时一次性开销（VRoid 1024/2048，~10-30ms/张，加载时做一次即可）；跨域图会失败（内嵌图不会） |

**不脏的规则**（重要，按顺序执行）：

1. **同色系三件套**：主色（`color`）、暗面（`shadeColorFactor` = 主色 × 0.55–0.65，再往冷紫墨色偏 15–20%）、描边（主色 × 0.28–0.35，再往墨色偏 15%）。全用同一色相，否则会"脏"。
2. **不要用纯黑当阴影/描边**：用 `#2a2438`（冷紫黑）或 `#35222e`，在深色 UI 上更耐看。
3. **皮肤不要染主色**：只调 `shadingShiftFactor`（+0.2~0.3 提亮）和 `shadeColorFactor`（用 VRM 自带的），一旦把 `color` 染成别的色，肤色会变"塑料黄"。
4. **眼睛只染虹膜**：`EyeIris` 单独染；`EyeWhite`/`EyeHighlight`/`FaceEyeline`/`FaceEyeline` 保持原样（白要白、高光要亮、眼线要黑）。虹膜优先用 C 方式（保留明度），实在不行用 A 且把 `shadeColorFactor` 设成同一色相的暗色。
5. **乘法染色后如果发灰**：把 `material.color` 往目标色的**线性亮值**提（hex 选更亮的），或者改用 C 方式；不要靠 `emissive` 提亮（会发光）。
6. **批量染色后逐个检查 `outlineColorFactor`**：`STYLE.tintByMaterialName` 会自动同步配对描边的颜色；如果模型描边是分开的（VRM0/多材质），检查 `findOutline`。

#### 4.2.2 代码：02 粉发 + 青瞳（A/B 方式）

```js
var STYLE = __req("vrm-style").create(THREE, THREE_VRM);
var THREE_VRM = window.THREE_VRM;

// 头发：粉发（02 的 2D 配色：hair #f08fbc / shade #c76a9b / hi #ffc2dd）
STYLE.tintByMaterialName(vrm, /hair(?!back)/i, "#f08fbc", {
  shade: 0.58,          // shadeColorFactor = 主色 × 0.58，再向冷紫偏 18%
  rim: 0.22,            // parametricRimColorFactor = 主色 × 0.22
  rimFresnel: 3.2,
  rimLift: 0.12,
  rimLightingMix: 0,
  outlineMix: 0.30,     // 描边 = 主色 × 0.30
  outlineInk: 0x2a2438
});
// 后发稍暗（02 后发比前发深一档）
STYLE.tintByMaterialName(vrm, /hairback/i, "#c76a9b", { shade: 0.55, rim: 0.16, outlineMix: 0.32 });

// 眼睛：瞳色 #46b992（02 的青绿瞳），用 canvas 重绘保留明度；只动虹膜
var iris = STYLE.findMaterial(vrm, /iris/i);
if (iris) {
  if (!STYLE.recolorMap(iris, "#46b992", { satMul: 1.05, lightMul: 1.0 })) {
    // 没有 canvas 的降级：乘法 + 同色相暗面
    iris.color.set("#7fe8c8");
    iris.shadeColorFactor.set("#2c6f63");
  }
}
// 眼白提亮 + 打平
var white = STYLE.findMaterial(vrm, /eyewhite/i);
if (white) { white.shadingShiftFactor = 1; white.shadingToonyFactor = 1; }
// 高光提亮（MToon 有 emissive）
var hi = STYLE.findMaterial(vrm, /eyehighlight/i);
if (hi) {
  hi.emissive.setRGB(0.25, 0.25, 0.25);   // 线性
  hi.emissiveIntensity = 1.6;
  hi.shadingShiftFactor = 1; hi.shadingToonyFactor = 1;
}
```

#### 4.2.3 代码：C 方式（canvas 重绘贴图）的内部实现要点

`STYLE.recolorMap(material, color, opts)` 已经实现：

- 把 `map.image` 画到同尺寸 canvas → `getImageData` → 逐像素 sRGB→HSL；
- 只换**色相**（默认取目标色色相）、按 `satMul` 调整饱和度、`lightMul`/`lightness` 调整明度 → HSL 转回 RGB；
- 生成 `CanvasTexture`，复制原贴图的 `colorSpace/flipY/wrapS/wrapT/offset/repeat/center/rotation/channel/anisotropy`，`material.needsUpdate = true`；
- 原贴图不 dispose（可能被共享），`STYLE.restoreMap(material)` 可回滚。

**为什么眼睛必须用 C**：虹膜贴图自带高明度眼白/暗部渐变；A 方式乘一个青绿色会把白点也染绿，且暗部变成"脏青灰"。C 方式保留明度 → 虹膜还是"亮底 + 深边"。

#### 4.2.4 颜色速查（四个形象，取 `src/3d/chars/*.js` 的 2D 调色板，保证 2D/3D 一致）

| 形象 | 主色 | 暗面 | 高光/rim | 眼睛 | 描边 |
|---|---|---|---|---|---|
| 02 御姐/元气/Q 版 | 发 `#f08fbc`、衣 `#cf2b41`、领结 `#f28a2c`、角 `#f2485a`、皮肤 `#ffdcc4` | 发 `#c76a9b`、衣 `#8c1a31`、角 `#b02036` | 发 `#ffc2dd` | iris `#2c6f63 → #46b992 → #a9f0d3`、lash `#3d2130`、brow `#c97f9e` | 发/衣 `#3a2230`；角 `#7a1a2c` |
| 02 元气（贝雷帽） | 同上，整体饱和度 +5~8% | 同上 | 白帽 `#f9f8fd` / 阴影 `#dfe0ee` | 同上 | 同上 |
| 鲸鲸 | 发 `#5588ee` / 浅 `#7fadf8` / 后发 `#3f6bd0` / 深 `#2e55af`、尾 `#33559e`、裙 `#2f56a8`、白 `#f9f8fd`、海军 `#202c57`、金 `#d4b26a` | 发 `#2b52b8`、尾 `#1c3266`、裙 `#19336a` | 发 `#cfe8ff`、rim `#a8d4ff` | iris `#2a63cc → #4fa0f0 → #b8ecff`、lash `#1b2245`、brow `#7e97ce` | `#1e2140` |

### 4.3 加配件（b 题）——挂哪、怎么朝向、怎么不穿模

#### 4.3.1 通用规则（血泪）

1. **挂 raw 骨，不挂归一化骨**：`vrm.humanoid.getNormalizedBoneNode()` 是 loader 额外创建的独立 `Object3D` 树（`VRMHumanoidRig` 的 root），**不在 `vrm.scene` 里**，只负责把旋转写回 raw 骨；挂上去的配件不会跟着渲染/蒙皮。用 `getRawBoneNode()`（`vrm-style.js` 的 `attachToBone` 默认就是 raw）。
2. **朝向用 `space:"world"`**：VRM 骨骼的 rest 朝向因模型而异（VRoid 的 `J_Bip_C_Head` 节点 rest rotation 实测为 `[0.468, 0.530, 0.468, 0.530]`，不是世界轴对齐），直接用骨局部坐标摆配件会"歪得莫名其妙"。`attachToBone(vrm, bone, obj, offset, { space: "world" })` 的 `offset` 是**世界方向位移**（+Y 上、+Z 角色正前、-Z 背后），旋转也是世界朝向——`vrm-style.js` 内部会把 `q_boneWorld⁻¹ × q_world` 算好。
3. **`frustumCulled = false`**：骨骼动画后包围盒会过期（vrmchar 对 skinned mesh 也这么处理），配件默认关剔除。
4. **根部略嵌入 2–3mm 并加遮挡**：角/发带/帽子不要"贴"在头皮上，根部要插进头发里（或加一块底座圆盘），否则 200px 下会看到一条缝。
5. **Q 版 head 放大后配件自动放大**：配件挂在 head 骨下，继承 head.scale → 角/帽子跟着变大（通常正是想要的效果）。如果不想继承，在 `space:"world"` 下额外把 `scale` 除以 head 缩放值。
6. **z-fighting / 透明排序**：配件材质用 MToon（`STYLE.makeMToonMaterial`），和皮肤同套光照；半透明件（发带薄片）设 `transparent:true`、`depthWrite:false`、`renderOrder: 10`（比脸部贴片大）。
7. **配件也要量进 bbox**：挂完后重新 `stage.frame()`（vrmchar 的 `measurePosed` + `stage.frame`），否则角/帽子会被相机裁掉。

#### 4.3.2 五个配件的具体做法

尺寸单位：**1 世界单位 ≈ 角色高度 4.4 的 1/4.4**；在 300px 窗口里 **1 单位 ≈ 64px**（§5.1）。下面按"头宽"为单位给（`models/twist.vrm` 头宽 ≈ 0.6 世界单位 ≈ 38px）。

| 配件 | 挂骨 | 尺寸（世界单位） | 位置（world 偏移） | 朝向 | 材质 | 穿插处理 |
|---|---|---|---|---|---|---|
| **红角 ×2** | `head` | 长 0.38–0.45、根半径 0.05–0.07 | `(±0.17, +0.16, +0.02)` 从头顶两侧、额线上方伸出 | 向外 25–35°、略前倾 10° | MToon `#f2485a`，shade `#b02036`，rim `#ffc0c8` 0.28 | 根部插进头 0.03；用 `lathe`/`strand` 做微弯锥；左右镜像（+X 是屏幕右） |
| **白 hairband** | `head` | 环直径 ≈ 0.62、带宽 0.07、厚 0.02 | `(0, +0.10, -0.01)` 绕头一圈，前缘在额头上方 | 绕 Y 轴一圈，略后倾 8° | 白 `#fff3f0`、shade `#e3cdd3`、rim 白 0.2 | 半径比头壳大 0.01–0.02，压在头发上；用 `TorusGeometry` 或 ribbon |
| **白贝雷帽** | `head` | 帽体半径 0.34、高 0.16；帽檐半径 0.40、厚 0.03 | `(0.03, +0.24, -0.03)` 头顶偏右后 | 向右倾 18°、向前压 8° | 白 `#f9f8fd`、shade `#dfe0ee` | 帽底要低于头顶（插进头发）；前缘不得低于眉毛（否则挡眼） |
| **女仆头饰** | `head` | 两侧荷叶边扇形 0.18×0.10，中间窄发带 0.5 宽 | `(±0.16, +0.13, -0.02)` 头顶两侧偏后 | 向外上 20°，呈"蝴蝶结/荷叶" | 白 `#f9f8fd`、shade `#dfe0ee`，可加一点蓝边 | 用 ribbon/lathe 做荷叶边；贴着头壳，别飞出去 |
| **鲸鱼尾巴** | `hips`（或 `spine`） | 尾柄长 0.55、尾鳍宽 0.55、末端圆 | `(0, -0.05, -0.38)` 身后偏下（-Z 是背后） | 向后伸出 20–30° 下垂；动画绕 X 轴摆 ±0.25rad | 尾 `#33559e`、鳍 `#2f5299`、rim `#8fc6ff` 0.3、双面 | 和裙摆/后发互相穿模时：尾巴放低一点、或把后发 springbone 调硬；尾巴根部插进腰/裙里 |

配件几何建议（都在项目里已有对应能力）：

- **角**：`K.strand({pts, radii})` 的变体（微弯锥）或 `THREE.ConeGeometry` + 弯曲（3 段）。做两段：根部粗、中段细、尖端收 0.005。
- **发带**：`THREE.TorusGeometry(0.30, 0.012, 8, 32)` 或 `K.ribbon`；发带是 Zero Two 的辨识核心，**一定要有**。
- **贝雷帽**：`SphereGeometry` 压扁 + `CircleGeometry` 帽檐 + 小圆帽顶。
- **女仆头饰**：两个扇形荷叶边（`K.ribbon` 或 `LatheGeometry` 的弧段）+ 中间细带。
- **尾巴**：尾柄 `capsule` + 两个扁平尾鳍（`K.ribbon` / 压扁 `SphereGeometry`）+ 末端圆球；或用 `models/whale-quaternius.glb` 的尾鳍段（其整只鲸鱼 bbox 只有 0.041×0.102×0.032 单位，缩到尾巴尺寸需 ×10–12，且它自带骨骼 `Tail` 可做摆动；但整只鲸鱼挂屁股上会像"挂件"而不是尾巴，不推荐直接用整只，除非就要这种萌点）。

代码（`vrm-style.js` + 任意几何）：

```js
var STYLE = __req("vrm-style").create(THREE, THREE_VRM);

// 1) 红角 ×2（world 偏移）
var hornGeo = new THREE.ConeGeometry(0.06, 0.42, 10);   // 顶点朝 +Y
var hornMat = STYLE.makeMToonMaterial({
  color: "#f2485a", shadeColorFactor: "#b02036",
  rim: "#ffc0c8", rimFresnel: 3.0, rimLift: 0.15, rimLightingMix: 0
});
[-1, 1].forEach(function (side) {
  var horn = new THREE.Mesh(hornGeo, hornMat);
  horn.rotation.z = side * -0.45;          // world 空间：左右向外倾
  horn.rotation.x = -0.12;                  // 略前倾
  STYLE.attachToBone(vrm, "head", horn, {
    position: [side * 0.17, 0.16, 0.02],
    rotation: [0, 0, side * 0.45]           // 若同时给 rotation，和上面的 rotation 二选一
  }, { space: "world" });
});

// 2) 白色发带（torus 一圈）
var band = new THREE.Mesh(
  new THREE.TorusGeometry(0.30, 0.014, 8, 40),
  STYLE.makeMToonMaterial({ color: "#fff3f0", shadeColorFactor: "#e3cdd3", rim: "#ffffff", rimLightingMix: 0 })
);
band.rotation.x = Math.PI / 2;              // 平放成环
STYLE.attachToBone(vrm, "head", band, { position: [0, 0.10, -0.01] }, { space: "world" });

// 3) 白贝雷帽（压扁球 + 帽檐）
var beret = new THREE.Group();
var crown = new THREE.Mesh(new THREE.SphereGeometry(0.30, 16, 12), STYLE.makeMToonMaterial({ color: "#f9f8fd" }));
crown.scale.set(1.05, 0.5, 1.05);
var brim = new THREE.Mesh(new THREE.CircleGeometry(0.36, 24), STYLE.makeMToonMaterial({ color: "#f9f8fd" }));
brim.rotation.x = -Math.PI / 2; brim.position.y = -0.02;
beret.add(crown); beret.add(brim);
STYLE.attachToBone(vrm, "head", beret, {
  position: [0.03, 0.24, -0.03],
  rotation: [0.10, 0, -0.28]                // 右倾 + 前压
}, { space: "world" });

// 4) 鲸鱼尾巴（挂 hips，-Z 背后）
var tail = new THREE.Group();
var stem = new THREE.Mesh(new THREE.CapsuleGeometry(0.10, 0.35, 6, 12), STYLE.makeMToonMaterial({ color: "#33559e", rim: "#8fc6ff" }));
stem.rotation.x = Math.PI / 2;
tail.add(stem);
var flukeGeo = new THREE.SphereGeometry(0.22, 12, 8);
[-1, 1].forEach(function (s) {
  var fluke = new THREE.Mesh(flukeGeo, STYLE.makeMToonMaterial({ color: "#2f5299", rim: "#8fc6ff", rimLightingMix: 0 }));
  fluke.scale.set(1.0, 0.30, 0.55);
  fluke.position.set(s * 0.24, 0, -0.42);
  fluke.rotation.z = s * 0.25;
  tail.add(fluke);
});
STYLE.attachToBone(vrm, "hips", tail, { position: [0, -0.05, -0.38] }, { space: "world" });
// 尾巴摆动（在 char.update 里）
tail.rotation.x = Math.sin(t * 2.2) * 0.10;  // 注意 tail 是 group 的 local 轴
```

> `makeMToonMaterial` 创建的材质不在 `vrm.materials` 列表里，`vrm.update()` 不会替它调用 `material.update(delta)`（只有 UV 动画才需要），普通材质无需每帧更新。

#### 4.3.3 配件挂载的坑

| 坑 | 现象 | 解决 |
|---|---|---|
| 挂 normalized 骨 | 配件在原点/不跟动画 | 用 raw 骨（默认） |
| 骨 rest 朝向怪 | 角歪 90°/帽子扣在脸上 | `space:"world"` + 世界偏移/朝向 |
| 每帧被覆盖 | 配件 scale 回到 1 | 不要每帧写 scale；Q 版 scale 一次性设置 |
| 头部 springbone 穿模 | 头饰被头发顶穿 | 头饰半径比头壳大 0.01–0.02；或把该束头发 spring 调硬（stiffness ×1.3） |
| 透明件排序 | 发带/荷叶边和头发闪烁 | `transparent:true, depthWrite:false, renderOrder:10` |
| 相机裁切 | 帽子/角被上沿切掉 | 挂完配件后 `stage.frame`（margin 1.06→1.10），或 `cfg.camera.height` 加 5–8% |

### 4.4 Q 版化（c 题）——大头、身体缩小、接缝、相机

#### 4.4.1 原理：为什么必须改 raw 骨 scale [已核实]

`VRMHumanoidRig.update()`（`packages/three-vrm-core/src/humanoid/VRMHumanoidRig.ts` L118-158）：

```ts
boneNode.quaternion.copy(rigBoneNode.quaternion).multiply(parentWorldRotation).premultiply(invParentWorldRotation).multiply(boneRotation);
if (boneName === 'hips') { /* 只额外搬 hips.position */ }
```

**只写 quaternion（和 hips 的 position），不写 scale/position（其它骨）**。所以：

- ✅ `vrm.humanoid.getRawBoneNode("head").scale.setScalar(1.38)` → 永久生效（scale 不会被覆盖）。
- ❌ `vrm.humanoid.getNormalizedBoneNode("head").scale.setScalar(1.38)` → **完全无效**（归一化骨是独立树，scale 不参与写回）。

#### 4.4.2 推荐做法（一次性设置）

```js
function makeChibi(vrm, k) {
  k = k || 1.38;
  var head = vrm.humanoid.getRawBoneNode("head");
  var neck = vrm.humanoid.getRawBoneNode("neck");
  if (head) head.scale.setScalar(k);        // 必须 uniform：非均匀 scale + 骨骼 rest 旋转 = 斜切
  if (neck) neck.scale.setScalar(1 + (k - 1) * 0.22);  // 脖子吃 20% 左右，接缝更自然
  // 不要把肩膀/躯干一起放大：会变成"充气娃娃"
}
// 调用时机：vrmchar attachModel() 之后、第一次 vrm.update() 之前（之后也行，scale 不会被写回）
```

参数：

| 形象 | k（head） | neck | 说明 |
|---|---|---|---|
| 02 御姐（onee） | 1.00 | 1.00 | 保持模型原比例，靠妆/配件拉气质 |
| 02 元气（genki） | 1.06–1.10 | 1.02 | 稍微可爱一点，配贝雷帽 |
| 02 Q 版（chibi） | **1.35–1.45** | 1.06–1.08 | 2.2 头身左右；窗口 180×300 |
| 鲸鲸 | **1.30–1.38** | 1.06 | 215×285/226×300；圆润 |

#### 4.4.3 蒙皮权重与脖子接缝

- head 骨是"颈部关节"处的骨骼（`models/twist.vrm` 里 head 节点在 neck 之上），它的子节点有：脸 mesh 的权重区、眼骨、头发 spring 骨。**uniform scale 是绕 head 骨原点（脖子顶）放大** → 头往上、往外长，脖子长度不变，这是正确方向。
- **接缝**来自面部/颈部交界处顶点同时有 head 与 neck 权重：head 放大后这些顶点被"拉开"，会出现脖子变粗/拉长/锯齿。缓解顺序：
  1. neck 也放 1.05–1.08（分摊）；
  2. 让领口/衣领盖住接缝（VRoid 衣服 `AccessoryNeck_01_CLOTH` / `Tops` 高领）；
  3. 改权重（高级）：对该区域的顶点，把 head/neck 权重重新分配（需要读 `geometry.attributes.skinIndex/skinWeight`、`mesh.skeleton.bones.indexOf(headBone)`，完成后调用 `mesh.normalizeSkinWeights()`（three r166 有该方法））。**[待验证：不同模型的接缝区不同，需要先截图定位]**
  4. 最后手段：把 head 骨位置稍微下移/上移 0.01–0.02（`head.position.y`）找最自然的接缝。
- **不要**同时非均匀 scale（x/y/z 不同）——骨骼 rest 旋转会让网格斜切。
- **眼睛/牙齿/刘海**如果和脸不是同一权重，可能会"掉出来"：`twist.vrm` 里 Face mesh 是一整块（眼/眉/嘴都是 skin 到同一骨架），Q 版后一起放大，安全；VRM0 的 `.baked` 模型同样。非 VRoid 模型（`Seed-san` 的 `robo_face`）要单独检查。

#### 4.4.4 头发 SpringBone 与 head 放大

- head 的 spring 骨是 head 的子节点，**head.scale 会让它们的位置/长度一起放大**；spring 参数（stiffness/hitRadius）不会自动跟着变。
- 处理：
  1. `scaleSpringBones(vrm, sceneScale)` 按官方 guide 补一次（§5.4）；
  2. Q 版再对 head 区 spring 骨乘 `k` 的 hitRadius：`hitRadius *= k`（碰撞球要跟着头变大）**[待验证]**；
  3. 头发看起来"太重/太飘"时，stiffness ×0.9–1.0、drag 0.45–0.55（§5.4）。

#### 4.4.5 相机取景（Q 版最容易翻车）

- Q 版后 bbox 变高变宽 → 必须**重新量 bbox + `stage.frame`**（vrmchar 已在挂载时量，但 Q 版/配件要在量之前做完）。
- 推荐：`margin 1.06–1.10`（给角/帽子留顶）、`elevation 0.04–0.08`（Q 版头大，俯拍会更圆润）、`targetY = bboxMinY + bboxH × 0.50–0.53`（头大重心上移，别用 `height*0.52` 硬算）。
- 小窗口 `aspect` 竖长时 `stage.setSize` 会自动拉远（`1+(0.85-aspect)*0.55`），Q 版要确认侧发不被裁：`195×300` 下 `aspect=0.65` → 拉远系数 ~1.11。
- 想"脸更大"：先 Q 版 k，再 `camera.distK 0.94–0.97`（不要低于 0.9，会裁脚/角）。

#### 4.4.6 风险清单

| 风险 | 表现 | 处理 |
|---|---|---|
| 头太大压到肩膀/胸口 | 下巴穿进衣服 | k 降到 1.3–1.35；head 骨 rotation.x -0.03；领口配件遮挡 |
| 脖子接缝 | 一圈锯齿/拉长 | neck 1.05–1.08；衣领遮挡；改权重 |
| 侧发穿身体 | 长发卡进手臂 | 长发模型（`HairSample_Female`/`VRoid_V110`）Q 版后更容易；给侧发加 spring 或缩短发长（改 mesh 顶点重映射，不推荐） |
| 眼睛比例没变 | 头大了但眼睛还小 | 眼睛单独放大（§5.2）或 Q 版头骨 + 眼骨 scale |
| 帽子/角被裁 | 顶部切掉 | margin 1.10 + 重新 frame |
| 换角色残留 | 旧配件/旧 scale | 每个模型实例化后重新计算，不要跨模型复用 vrm 对象 |

### 4.5 鲸鲸（d 题）：从通用女性 VRM 改造成蓝发女仆

#### 4.5.1 选底模（`models/` 里已有）

| 模型 | 高度 | 特点 | 适合谁 |
|---|---|---|---|
| `Vivi.vrm` | 1.412 | 最矮、头相对大 | **鲸鲸首选**（Q 版底子好） |
| `AvatarSample_A.vrm` | 1.613 | 短发/标准 VRoid | 鲸鲸备选 |
| `twist.vrm` | 1.615 | pixiv 官方 VRM1 示例，材质最干净 | 通用首选（VRM1 管线验证） |
| `HairSample_Female.vrm` | 1.668 | 长女发 | 02 双马尾底模 |
| `VRoid_V110_Female_v1.1.3.vrm` | 1.618 | VRoid 官方示例，VRM0，配色朴素 | 鲸鲸/02 通用 |
| `Sendagaya_Shino.vrm` / `Vita.vrm` / `Sakurada_Fumiriya.vrm` | 1.6–1.9 | VRM0 带名角色 | 02 御姐（气质） |
| `Seed-san.vrm` | 1.58 | 非 VRoid（机器人），材质命名不规律 | 不建议做鲸鲸 |

> ⚠️ 授权：`models/` 里的 VRM 多数是「VRoid/第三方示例模型」，正式分发前必须核对每个模型的 license/meta（`vrm.meta.license` / `authors`）。当前 `ASSETS.md` 还写着"没有外部模型文件"，集成方补模型后要同步更新授权说明。`Sakurada_Fumiriya` / `Sendagaya_Shino` / `Vita` / `Vivi` 是 VRM 官方 sample（多为再分发受限），**只能本地验证，不能随插件分发**。**[待确认：具体每个模型的 license 字段]**

#### 4.5.2 改造步骤

```js
// 0) 底模 + Q 版（Vivi 1.412 高，归一化到 4.4 后头身比已经不错）
var STYLE = __req("vrm-style").create(THREE, THREE_VRM);
STYLE.scaleSpringBones(vrm, 4.4 / 1.412);           // 先按场景缩放补偿
makeChibi(vrm, 1.32);                                // Q 版 k=1.32，鲸鲸要圆

// 1) 蓝发：前发浅蓝、后发深蓝（VRoid 有独立 HairBack 材质，天然两色层次）
STYLE.tintByMaterialName(vrm, /hair(?!back)/i, "#7fadf8", { shade: 0.55, rim: 0.26, rimFresnel: 3.0 });
STYLE.tintByMaterialName(vrm, /hairback/i, "#3f6bd0", { shade: 0.50, rim: 0.16 });
// 发贴图如果本身有颜色（不是灰白），改用 recolorMap 保明度：
// STYLE.recolorMap(STYLE.findMaterial(vrm, /hair(?!back)/i), "#7fadf8", { satMul: 1.05 });

// 2) 眼睛：蓝瞳（#4fa0f0），只染虹膜；眼白/高光/睫毛不动
var iris = STYLE.findMaterial(vrm, /iris/i);
if (iris) STYLE.recolorMap(iris, "#4fa0f0", { satMul: 1.0 });
var hi = STYLE.findMaterial(vrm, /eyehighlight/i);
if (hi) { hi.emissive.setRGB(0.2, 0.22, 0.26); hi.emissiveIntensity = 1.5; }

// 3) 女仆装：上衣白、下装海军蓝、鞋深蓝（把 VRoid 自带衣服贴图染成两色）
STYLE.tintByMaterialName(vrm, /tops/i, "#f9f8fd", { shade: 0.72, rim: 0.14 });     // 白衬衫
STYLE.tintByMaterialName(vrm, /bottoms|skirt/i, "#2f56a8", { shade: 0.55, rim: 0.12 }); // 蓝裙
STYLE.tintByMaterialName(vrm, /shoes/i, "#1f2b58", { shade: 0.6, rim: 0.1 });
// 若模型没有围裙：用几何补一块白色围裙（attach 到 spine/hips）
// 4) 女仆头饰（白荷叶边，§4.3.2）
// 5) 鲸鱼尾巴（§4.3.2，挂 hips）
// 6) 小鲸鱼呆毛/水花：可选
// 7) 灯光：蓝色主题（glowColor 0x6fb7ff，rim 色偏青蓝）
// 8) 表情：happy/relaxed 为默认，眨眼稍慢（鲸鲸呆呆的）
```

蓝色系注意：

- 蓝发乘法染色容易偏灰 → 发贴图若本身有颜色，用 `recolorMap`（保明度、只换色相到 ~215°）比乘法好；后发单独染深 1–2 档做出层次。
- 白色衣服在 MToon 里如果 shade 太暗会发灰 → `shade: 0.75–0.8`，并且 `shadingShift` 用 +0.1（白衣偏亮）；`outline` 用海军蓝 `#1e2140` 而不是黑。
- 尾巴/头饰的白色与蓝发对比 = 鲸鲸辨识度；头饰一定要比头壳大 0.01–0.02。
- `stage.glowColor` 用 `0x6fb7ff`（现有 2D 皮肤设定是 `glowColor: 0x6fb7ff`）。

### 4.6 四形象配方总表（交给集成方直接抄）

| 参数 | 02 御姐（onee） | 02 元气（genki） | 02 Q 版（chibi） | 鲸鲸（whale） |
|---|---|---|---|---|
| 底模建议 | `Sakurada_Fumiriya` / `Vita` / `VRoid_V110` | `VRoid_V110` / `AvatarSample_A` | `Vivi` / `Vivi`+头放大 | `Vivi` / `AvatarSample_A` |
| head k | 1.00 | 1.08 | **1.38–1.42** | **1.32** |
| neck | 1.00 | 1.02 | 1.07 | 1.06 |
| 发色 | `#f08fbc`（后发 `#c76a9b`） | `#ff9ec8`（更亮） | `#f08fbc` | 前 `#7fadf8` / 后 `#3f6bd0` |
| 瞳色 | `#46b992` | `#3fd1a0` | `#46b992`（更大） | `#4fa0f0` |
| 衣服 | 红 `#cf2b41` + 白领 `#fff3f0` + 领结 `#f28a2c` | 同上 | 红 + 白 | 白 `#f9f8fd` + 海军蓝 `#202c57`/`#2f56a8` |
| 配件 | 红角 + 白 hairband | 红角 + 白贝雷帽 | 红角 + 白 hairband（放大 1.2×） | 女仆头饰 + 鲸鱼尾巴 |
| 描边 | 1.0–1.2px，`#3a2230` | 1.0–1.2px | **1.4–1.6px** | 1.2–1.4px，`#1e2140` |
| 窗口 | 172×360 | 175×360 | 180×300 | 215×285 / 226×300 |
| 相机 | margin 1.06、elevation 0.07、distK 1.0 | margin 1.06、elevation 0.07 | margin 1.10、elevation 0.05、distK 0.95 | margin 1.08、elevation 0.06、distK 0.97 |
| glow | `0xff6f96` | `0xff6f96` | `0xff6f96` | `0x6fb7ff` |
| spring | 标准（§5.4） | 标准 + 更活泼（stiffness ×0.95） | 稳一点（drag 0.5） | 软一点（drag 0.45、gravity 0.08） |
| 表情默认 | `relaxed 0.3` | `happy 0.4` | `relaxed 0.35` + 眨眼大 | `happy 0.35` + 眨眼慢 |

---

## 5. 小尺寸可读性（200×300）

### 5.1 像素预算（实测 `models/twist.vrm`）

假设：角色归一化到 4.4 舞台单位、窗口 300px 高、`margin 1.06` → **1 世界单位 ≈ 64.3 px**（`px = H_px / (bboxH × margin)`）。按几何 bbox 换算：

| 部位 | 实测几何尺寸（米） | 归一化后世界单位 | **300px 窗口实际像素** |
|---|---|---|---|
| 角色总高 | 1.615 | 4.40 | ≈283 px |
| 脸部（Face mesh 宽×高） | 0.218 × 0.232 | 0.594 × 0.632 | **≈38 × 41 px** |
| 眼白（双眼合计） | 0.091 × 0.026 | 0.248 × 0.071 | ≈16 × 4.6 px（每只 ~8×4.6） |
| 虹膜（双眼合计） | 0.070 × 0.017 | 0.191 × 0.047 | **≈12 × 3 px（每只 ~6×3）** |
| 眼球高光（双眼合计） | 0.067 × 0.009 | 0.183 × 0.025 | ≈11.8 × 1.6 px |
| 眼线（双眼合计） | 0.089 × 0.018 | 0.243 × 0.049 | ≈15.6 × 3.1 px |
| 眉毛（双眼合计） | 0.090 × 0.004 | 0.245 × 0.011 | ≈15.8 × **0.7 px** |
| 嘴 | 0.031 × 0.017 | 0.085 × 0.046 | ≈5.5 × 3 px |
| 前发 | 0.233 × 0.387 | 0.635 × 1.056 | ≈41 × 68 px |

> 数据来源：把 `models/twist.vrm` 的 glTF JSON 按 primitive 的 POSITION accessor min/max 取出，再按 `4.4 / 1.615` 归一化、按 300px 窗口换算。**结论：小窗口里脸只有 38px 宽，眉毛 1px、虹膜 3px 高——按原样渲染必然"糊成一张饼"。**
>
> 上面的像素数按"相机垂直取景高度 = bboxH × margin"算（aspect ≥ 0.85 时成立）。真实桌宠窗口都是竖长（aspect 0.48–0.75），`stage.setSize()` 会再拉远 5–20%，所以 195×300 下实际还要再小约 10%（≈58 px/单位，脸 ≈34px、虹膜 ≈2.7px 高）。量级不变，**结论只会更强：必须夸张**。

### 5.2 必须夸张的细节（按收益排序）

1. **轮廓**（描边 1.0–1.4px + rim）：这是"手办感"的全部。先做这个，再谈别的。
2. **眼睛**（最大短板，3px 高的虹膜读不出情绪）。三档方案，按风险从低到高：
   - ① **相机拉近**：`distK 0.94–0.97` + Q 版头 k 1.35–1.42 → 脸从 38px 到 52–57px，虹膜 4–4.2px；
   - ② **放大眼骨**（推荐，效果最直接）：`getRawBoneNode("leftEye"/"rightEye").scale.setScalar(1.2–1.35)`。VRoid 的眼睛几何权重在眼骨上（sample 有 `J_Adj_L/R_FaceEye`），放大后眼白/虹膜/高光一起变大，睫毛/眼线不动——会成为"大眼 Q 版"。**[待验证：不同模型的眼骨权重不同，可能露出眼窝边缘；先在 lab 里看]**
   - ③ **改脸贴图**（虹膜画大一圈、加深上眼线、把高光画大）：VRoid 的 face 贴图是固定 UV 布局，改起来要 UV 知识，风险高；**只在②不够时做**。
3. **脸打平**：`shadingShift +0.72`，否则脸上的明暗分界会像"脏印子"。
4. **头发大形**：小窗口只看剪影 → 双马尾/侧发/呆毛的体积要够大，发丝细节（碎发）会糊成噪点，**宁可少而粗**。
5. **高光**：眼球高光 emissive（不然眼睛像死鱼）；头发天使环 matcap（不然头发像塑料布）。
6. **配件**：红角/发带/贝雷帽/女仆头饰/尾巴是"一眼认出是谁"的关键；尺寸按头宽的 0.5–0.8 倍做，**不要做小**。
7. **衣服细节**：纽扣/蕾丝/印花在 200px 下全是噪点 → 减少、放大或删掉；MToon 的 `shadeMultiplyTexture` 可以保留大块明暗，但不要依赖高频纹理。

### 5.3 贴图与采样

- 200px 下 `map` 会被缩到很小的屏幕面积：确保 `minFilter` 是 mipmap 线性（GLTFLoader 默认 `LinearMipmapLinearFilter`），`anisotropy = min(4, renderer.capabilities.getMaxAnisotropy())` 可减少头发/眼睛的闪烁。
- 关掉 `alphaTest` 的边缘锯齿：VRoid 眼睛贴图 alpha 边缘细，`alphaTest` 保持 loader 默认即可；如果眼部出现黑边，把 `alphaTest` 降到 0.01–0.05。
- VRoid face 贴图分辨率 1024×1024 → 每只眼睛实际只有 ~60×20 像素数据，放大眼睛时**不要**指望贴图细节。
- `stage` 的 `dprCap`：高质量 2、中 1.5、低 1；200px 窗口建议 **dpr 至少 2**（否则 1px 描边会抖）。

### 5.4 SpringBone 参数（小窗口 + 缩放补偿 + 手办化）

#### 5.4.1 官方要求：模型缩放后必须补偿 [已核实]

three-vrm 官方 guide `guides/spring-bones-on-scaled-models.md`（v3.5.5）：

> This is the limitation of the current spring bone system. To use spring bones with scaled VRM models, you have to change the parameters of spring bones according to the scale... `joint.settings.stiffness *= scale; joint.settings.hitRadius *= scale;` ... colliders `shape.radius *= scale; shape.tail.multiplyScalar(scale);`

vrmchar 把 VRM 缩放到 4.4（VRoid 模型 scale ≈ 2.7），**必须调用一次**：

```js
STYLE.scaleSpringBones(vrm, modelScale, {
  gravityPower: 0.03,     // VRoid 原值常见 0（VRM1）或 0.1，小窗口压到 0.02–0.05
  dragForce: 0.5,         // 阻尼：0.45–0.55，越小越"飘"
  stiffnessMul: 1.15      // 额外刚度：1.1–1.25，小窗口要稳
});
```

> Q 版 head 放大 k 后，head 下 spring 骨的 hitRadius 建议再 ×k（§4.4.4）**[待验证]**。

#### 5.4.2 VRoid 实测基线（知道"原厂"是多少）

| 模型 | 头发 stiffness | dragForce | gravityPower | hitRadius | 衣服/配饰 |
|---|---|---|---|---|---|
| `VRoid_V110_Female`（VRM0） | 0.50–0.81 | 0.40 | **0**（VRoid 0.x 默认） | 0.02（VRM0 单位） | Tops/Bottoms 0.5–0.75 / drag 0.05 / gravity 0 |
| `twist.vrm`（VRM1） | 0.40–0.70 | 0.40 | 0 / 0.10 | 0.010–0.032 | TopsUpperLeg/Arm 0.5–0.75 / drag 0.05 |
| `VRoid_V110` 头发（前发） | 0.80–0.81 | 0.40 | 0 | 0.02 | — |

#### 5.4.3 小窗口"手办化"参数（在 scaleSpringBones 之后）

| 部位 | stiffness | dragForce | gravityPower | 说明 |
|---|---|---|---|---|
| 头发 | 原值 ×1.10–1.20 | 0.45–0.55 | 0.02–0.06 | 小窗口要"稳、不抖"；重力太大头发会垂到肩膀穿模 |
| 后发/长发 | ×1.15–1.25 | 0.50–0.60 | 0.02–0.05 | 长头发最容易抖 |
| 裙子/飘带 | ×1.05–1.15 | 0.35–0.45 | 0.0–0.03 | 裙摆要有一点飘 |
| 配饰（领结/头饰） | ×1.3 | 0.5–0.6 | 0 | 基本当刚性件 |

原则：

- **drag 越大越"跟手"**、越不抖；小窗口建议 0.45–0.6（VRoid 原厂 0.4 偏软）。
- **gravityPower 在小窗口降低**（0.02–0.06）：重力会把头发往下拽，200px 下看起来像"头发变长/穿模"。
- **stiffness 不要超过 2**（超过像棍子），也别忘了先按 scale 乘（2.7× 后 0.6→1.62 已经算软）。
- 调试时用 `STYLE.listSpringBones(vrm)` 打快照，改完再打一次对比。

### 5.5 动作幅度（小窗口要"收"）

- 呼吸：`spine/chest` ±0.015–0.02 rad（vrmchar 现在是 0.02/0.022，略大，建议 0.012–0.018）；`upperChest` ±0.01。
- 头部 idle 摆动：`head` ±0.012–0.018 rad（现在 0.012–0.018 可以），频率 1.1–1.7Hz。
- 眨眼：3–5s 一次，单次 0.12–0.16s；Q 版/鲸鲸可 2.5–4s。
- 摸头/开心：`root.scale` 挤压 2–3.5%（vrmchar 现在 3.5%，可以保留），不要超过 5%。
- 尾巴：±0.1–0.25 rad、2–3Hz。
- 眼睛 LookAt：`vrm.lookAt.target` 已在用；小窗口转头幅度要小（head yaw ±0.3 rad，再大就像摇头）。

### 5.6 验收清单（小尺寸）

- [ ] 195×300 截图：角色占到画布高度 90–95%，头顶（角/帽子）不裁
- [ ] 缩放到 50% 看：**还能一眼区分的剪影**（四个形象不同）
- [ ] 描边在截图放大 400% 后 1.0–1.4px（Q 版 1.4–1.6）
- [ ] 脸没有明暗分界（shift 够）；眼睛能看到虹膜+高光
- [ ] 深色背景（#171222）和浅色背景（#f4f1f8）各截一张，轮廓都可读
- [ ] 静置 10s：头发不抖/不穿肩；裙摆不穿腿
- [ ] 切角色 4 次：无残留、无内存暴涨（材质/贴图 dispose）
- [ ] `char.info()`：mtoon 材质数、outline 数、springBones 数与模型匹配

---

## 6. 参考与证据

### 6.1 three-vrm 3.5.5 API 清单（全部逐文件核对）

GitHub（v3.5.5 tag）：`https://github.com/pixiv/three-vrm/blob/v3.5.5/...`
raw 直链（本任务环境可达）：`https://raw.githubusercontent.com/pixiv/three-vrm/v3.5.5/...`

| API / 事实 | 源码路径 | 关键内容 |
|---|---|---|
| `MToonMaterial` 全部属性 | `packages/three-vrm-materials-mtoon/src/MToonMaterial.ts` | `color`(litFactor)/`shadeColorFactor`/`shadingShiftFactor`/`shadingToonyFactor`/`giEqualizationFactor`/`matcapFactor`/`matcapTexture`/`parametricRimColorFactor`/`rimLightingMixFactor`/`parametricRimFresnelPowerFactor`/`parametricRimLiftFactor`/`outlineWidthMode`/`outlineWidthFactor`/`outlineColorFactor`/`outlineLightingMixFactor`/`isOutline`/`isMToonMaterial`/`update(delta)`/`debugMode`；默认值见构造函数 L391-436 |
| `MToonMaterialOutlineWidthMode` | `.../MToonMaterialOutlineWidthMode.ts` | `None:'none'`、`WorldCoordinates:'worldCoordinates'`、`ScreenCoordinates:'screenCoordinates'` |
| MToon 描边生成规则 | `.../MToonMaterialLoaderPlugin.ts` `_shouldGenerateOutline()` / `_generateOutline()` | 只有 `outlineWidthMode !== 'none' && outlineWidthFactor > 0` 才生成；描边 = clone + `isOutline=true` + `side=BackSide` + 同 geometry 两个 group |
| MToon 颜色空间/重编译规则 | `.../MToonMaterial.ts` `_generateDefines()`、`customProgramCacheKey()` | `USE_MATCAPTEXTURE` 等 define；matcap/shadeMultiply/rimMultiply 的 colorSpace 进程序缓存 key |
| MToon 光照/rim/matcap/outline 公式 | `.../shaders/mtoon.frag` L102-198（shading/diffuse）、L769-795（rim/matcap/mix）、L304-305（tone mapping + colorspace chunk）；`.../shaders/mtoon.vert` L95-112（outline 外扩 + screen 补偿） | 见 §2 |
| MToon 参数赋值/色彩空间 | `.../GLTFMToonMaterialParamsAssignHelper.ts` | factor 线性直塞；贴图 `setTextureColorSpace(...,'srgb')` |
| MToon 1.0 规范 | `vrm-c/vrm-specification` `specification/VRMC_materials_mtoon-1.0/README.md` + `schema/VRMC_materials_mtoon.schema.json` | outline 单位：world=米 / screen=屏幕高度比例；matcap 加法混合；rim 公式；默认值 |
| `VRMHumanoid` / 归一化骨架 | `packages/three-vrm-core/src/humanoid/VRMHumanoid.ts`、`VRMHumanoidRig.ts`、`VRMRig.ts`、`VRMHumanBoneName.ts` | `getRawBoneNode`/`getNormalizedBoneNode`/`humanBones`；**update() 只写 quaternion + hips.position（不写 scale）** |
| 表情 | `.../expressions/VRMExpressionManager.ts`、`VRMExpressionPresetName.ts` | `getExpression(name)`/`setValue(name, weight)`/`expressions`；18 个预设名 |
| LookAt | `.../lookAt/VRMLookAt.ts` | `target`(Object3D)/`autoUpdate`/`faceFront`/`applier` |
| Meta | `.../meta/VRM0Meta.d.ts` / `VRM1Meta.d.ts` | `metaVersion: '0' \| '1'` |
| SpringBone | `packages/three-vrm-springbone/src/VRMSpringBoneManager.ts`、`VRMSpringBoneJoint.ts`、`VRMSpringBoneJointSettings.ts`、`VRMSpringBoneColliderShapeCapsule.ts`、`...Sphere.ts` | `manager.joints`(Set)/`colliders`/`colliderGroups`；`joint.settings = {hitRadius, stiffness, gravityPower, gravityDir, dragForce}`；capsule `{radius, tail, offset, inside}`、sphere `{radius, offset, inside}` |
| VRM 主类 | `packages/three-vrm/src/VRM.ts`（`VRM extends VRMCore`）、`VRMCore.ts` | `scene/meta/humanoid/expressionManager/lookAt/firstPerson/materials/springBoneManager/nodeConstraintManager`；`update(delta)` 顺序：humanoid → lookAt → expression → nodeConstraint → springBone → materials |
| VRM0→1.0 材质转换 | `packages/three-vrm-materials-v0compat/src/VRMMaterialsV0CompatPlugin.ts` | `_OutlineWidth`（cm）× 0.01；`_ShadeShift/_ShadeToony` 换算；`_SphereAdd` → matcapTexture；`_RimColor`/`_RimFresnelPower`/`_RimLift` → parametric rim |
| 性能三连 | `packages/three-vrm/src/VRMUtils/`（`removeUnnecessaryVertices`/`combineSkeletons`/`combineMorphs`/`deepDispose`/`rotateVRM0`） | 官方 basic.html 用法见 §6.2 |
| 缩放 springbone 指南 | `guides/spring-bones-on-scaled-models.md` | 缩放后 stiffness/hitRadius/collider radius/tail 都要 ×scale |
| 版本 | `@pixiv/three-vrm@3.5.5`（npm registry 实测 `version: 3.5.5`，peer `three >= 0.137`） | 本仓库 `vendor/vrm-src` 内安装的也是 3.5.5 + three 0.166.1 |

### 6.2 three-vrm 官方示例参数（v3.5.5 `packages/three-vrm/examples/`）

- `basic.html`：`DirectionalLight(0xffffff, Math.PI)`、位置 `(1,1,1)` 归一化；`PerspectiveCamera(30, aspect, 0.1, 20)`、位置 `(0,1,5)`；加载后 `VRMUtils.removeUnnecessaryVertices(gltf.scene)` / `combineSkeletons` / `combineMorphs`；`vrm.scene.traverse(o => o.frustumCulled = false)`；每帧 `vrm.update(clock.getDelta())`。
- `humanoidAnimation/main.js`：同样 `DirectionalLight(0xffffff, Math.PI)`；`VRMUtils.rotateVRM0(vrm)`；`currentVrm.update(deltaTime)`。
- `expressions.html`：`currentVrm.expressionManager.setValue('aa', 0.5 + 0.5*s)`、`setValue('blinkLeft', 0.5 - 0.5*s)` —— 表情直接按名字设权重，和 `vrm-style.js setExpression` 一致。

### 6.3 MToon 规范摘录（原文）

- **Outline**："The unit of `outlineWidthFactor` is meters when the `outlineWidthMode` is `"worldCoordinates"`, or a ratio to the screen height when the `"screenCoordinates"`."
- **MatCap**："The result of matcap is additive blended to the lighting result."；`matcapUv = Vector2(dot(worldViewX, N), dot(worldViewY, N)) * 0.495 + 0.5`。
- **Rim**：`rim = matcapFactor * texture(...)`、`rim = rim * lerp(white, lighting, rimLightingMixFactor)`（规范里的伪代码，和 three-vrm 实现等价）。
- **GI**：`gi = lerp(rawGi(normal), uniformedGi, giEqualizationFactor)`，默认 0.9。

### 6.4 本仓库实测数据（`models/`，2026-11-12 扫描）

| 文件 | VRM 版本 | 高度（米） | 材质数 | 材质命名风格 |
|---|---|---|---|---|
| `twist.vrm` | VRM1.0（pixiv 示例） | 1.615 | 13 | `Body_00_SKIN` 风格 |
| `VRoid_V110_Female_v1.1.3.vrm` | VRM0.0 | 1.618 | 14 | `N00_*` |
| `Vivi.vrm` | VRM0.0 | 1.412 | 16 | `F00_*` |
| `Vita.vrm` | VRM0.0 | 1.713 | 16 | `F00_*` |
| `AvatarSample_A.vrm` | VRM0.0 | 1.613 | 17 | `F00_*` |
| `HairSample_Female.vrm` | VRM0.0 | 1.668 | 14 | `F00_*` |
| `Sendagaya_Shino.vrm` | VRM0.0 | 1.645 | 17 | `F00_*` |
| `Sakurada_Fumiriya.vrm` | VRM0.0 | 1.921 | 17 | `M00_*` |
| `Seed-san.vrm` | VRM1.0-beta | 1.580 | 17 | 非 VRoid（`hair`/`huku_bake`/`robo_face`…） |
| `whale-quaternius.glb` | 非 VRM（GLB） | 0.102（长） | 2 | `Top`/`Bottom`，有 `Tail` 骨，可做尾巴素材 |

VRM0 VRoid 实测 MToon 参数（`VRoid_V110_Female`）：

| 材质 | `_OutlineWidth`(cm) | mode | `_OutlineColor` | `_ShadeShift` | `_ShadeToony` | `_SphereAdd` |
|---|---|---|---|---|---|---|
| 脸/眼/眉/嘴 | 0.08 | 0（关） | 0.275 灰 | -0.8（脸打平） | 0.9 | `Shader_NoneBlack`（无 matcap） |
| 身体皮肤 | 0.08 | 1（world） | 0.275 | 0 | 0.9 | `MatcapWarp_01` |
| 衣服/鞋 | 0.08 | 1 | 0.275 | 0 | 0.9 | `MatcapWarp_01` |
| 前发 | 0.05 | 1 | 0.534 灰 | 0 | **0.6** | `MatcapWarp_02` |
| 后发 | 0.05 | 0（关） | 0.475 灰 | 0 | 0.6 | `Shader_NoneBlack` |
| 全体 rim | `_RimColor` 0.25 | — | — | — | — | `_RimFresnelPower=100`、`_RimLightingMix=0` |

VRM1 `twist.vrm`：

| 材质 | outlineWidthFactor | mode | outlineColor | shadingShift | toony | shadeColorFactor | rim |
|---|---|---|---|---|---|---|---|
| Face/Body SKIN | 0.0008 | world | `[0.061,0.0086,0.0144]` | -0.05 | 0.9 | 皮肤 `[0.930,0.624,0.708]` | 0 |
| Hair / HairBack | 0.0008 | world | `[0.061,0.0086,0.0144]` | -0.05 | 0.9 | `[1,1,1]` | 0 |
| Tops/Bottoms/Shoes | 0.0008 | world | 同上 | -0.05 | 0.9 | 蓝 `[0.624,0.672,0.930]` | 0 |
| 眼/嘴/眉/高光 | 无 | none | — | -0.05 | 0.9 | `[1,1,1]` | 0 |

### 6.5 待验证清单（按风险）

1. **描边像素换算**（§2.5）：公式从 shader 推导，但"1.2px 到底好不好看"必须真机截图校准；尤其 `worldCoordinates` 与 `screenCoordinates` 两种模式的观感差异。
2. **Q 版接缝**（§4.4.3）：不同模型（VRoid vs 非 VRoid）的 neck 权重区不同，需要截图定位后再决定改权重。
3. **眼睛放大方案②**（眼骨 scale）：需要确认各模型眼骨权重；可能出现眼窝/睫毛错位。
4. **matcap 天使环位置**：`flipY`/`band` 需要在 lab 里目视调一次。
5. **ACES + face `toneMapped=false`**：颜色是否和身体一致，需要对比截图。
6. **head scale 后 spring hitRadius ×k**：官方 guide 没有覆盖"局部骨骼缩放"，需要运动测试确认。
7. **配件与 spring 头发穿插**：头饰/帽子与 VRoid 头发 spring 的碰撞需要逐模型看。

---

## 7. 工具 `src/3d/vrm-style.js` 用法

### 7.1 集成方式（给集成方）

1. 在 `build.py` 的 `MODULES` 里加一行（本 agent 按规则**没有**改 build.py）：
   ```python
   ("vrm-style", "src/3d/vrm-style.js"),
   ```
2. 在 `vrmchar.js` 的 `attachModel()` 末尾（`setupMaterials()` / `char.height` 量完之后）调用：
   ```js
   var STYLE = __req("vrm-style").create(THREE, window.THREE_VRM);
   // ... 染色 / Q版 / 配件 ...
   STYLE.applyLookdev(vrm, "figure");
   STYLE.setOutline(vrm, { mode: "screen", px: 1.2, viewportHeightPx: host.clientHeight || 300 });
   ```
3. 与 `vrmchar` 现有逻辑的关系：
   - `setupMaterials()` 已经处理"模型自带描边 amplify / 缺描边补壳"；**用 `setOutline()` 覆盖绝对宽度**（推荐），或把 `cfg.outlineGain` 调到新值（不推荐，见 §2.5.3）。
   - `applyLookdev()` 会覆盖 MToon 的 shading/rim 参数；`vrmchar` 不碰这些，安全。
   - 配件挂载要在 `vrmchar` 的 `stage.frame()` **之前或之后重新 frame**（配件会改变 bbox）。
4. 每个 `vrm` 实例调用一次 `STYLE.dispose()`（释放共享 matcap 贴图）。

### 7.2 API 一览

| 函数 | 说明 |
|---|---|
| `create(THREE, VRMT)` | `VRMT` = `window.THREE_VRM`（可省略，省略时靠鸭子类型识别 MToon） |
| `collectMaterials(vrmOrScene)` | 遍历 scene 收集 `{material, mesh, name, isOutline, isMToon}`（含描边克隆） |
| `listMaterials(vrmOrScene)` | 调试清单：名字/网格/描边/贴图/颜色 |
| `findMaterial(vrm, matcher, opts?)` | 第一个匹配材质；`matcher` = 字符串（子串）/正则/函数/数组；默认跳过描边 |
| `findMaterials(vrm, matcher, opts?)` | 全部匹配 |
| `findOutline(vrm, materialOrName)` | 找配对描边材质 |
| `tintByMaterialName(vrm, matcher, color, opts?)` | 批量染色（主色/shade/rim/描边一起配），返回数量 |
| `recolorMap(material, color, opts?)` | canvas 逐像素 HSL 重绘贴图（瞳色/彩发），返回 bool |
| `restoreMap(material)` | 还原 recolorMap 的贴图 |
| `outlineFactorForPx(opts)` | 像素 → `outlineWidthFactor`（screen/world 两种模式） |
| `setOutline(vrm, opts?)` | 设置已有描边（宽度/颜色/模式），可选补壳 |
| `attachToBone(vrm, boneName, object3D, offset?, opts?)` | 挂 raw 骨；`space:"world"` 时 offset 是世界位移/朝向 |
| `detach(obj)` / `detachAll(vrm)` | 摘配件 |
| `getBone(vrm, name, {normalized})` | 取骨节点 |
| `setExpression(vrm, name, weight)` | 表情权重（clamp 0–1，不存在返回 false） |
| `setExpressions(vrm, map)` | 批量设表情 |
| `listExpressions(vrm)` | 模型实际表情名 |
| `listHumanoidBones(vrm)` | 字符串数组（有节点的骨骼名） |
| `listHumanoidBoneNodes(vrm)` | `[{name, raw, normalized}]` |
| `scaleSpringBones(vrm, scale, opts?)` | **模型缩放后必须调**（官方 guide 补偿） |
| `setSpringStyle(vrm, opts?)` | 手办化弹簧调参 |
| `listSpringBones(vrm)` | 弹簧快照（调试） |
| `applyLookdev(vrm, presetName?, opts?)` | 套 §2 预设（`figure`），可按类别染色 |
| `classify(name)` | 材质名 → 类别（调试/自定义规则用） |
| `makeMToonMaterial(opts)` | 给配件造 MToon 材质（无 VRMT 时退回 MeshBasicMaterial） |
| `matcapTexture(opts?)` | 生成天使环 matcap（无 document 返回 null） |
| `PRESETS` / `TINT_MATCHERS` / `version` / `dispose()` | 预设表 / 染色匹配表 / 版本 / 释放共享贴图 |

### 7.3 最短可用示例（集成方拷走）

```js
var STYLE = __req("vrm-style").create(THREE, window.THREE_VRM);

// 1) 调 MToon（分类预设；可再叠 tint）
STYLE.applyLookdev(vrm, "figure", {
  tint: { hair: "#f08fbc", cloth: "#cf2b41", iris: "#46b992" },
  recolor: { iris: true }        // 虹膜走 canvas 重绘，干净
});

// 2) 描边：像素反算（195×300 / 180×300 都适用）
STYLE.setOutline(vrm, { mode: "screen", px: 1.2, viewportHeightPx: 300, color: 0x2a2438 });

// 3) Q 版
var head = vrm.humanoid.getRawBoneNode("head");
if (head) head.scale.setScalar(1.38);
var neck = vrm.humanoid.getRawBoneNode("neck");
if (neck) neck.scale.setScalar(1.06);

// 4) 缩放补偿 springbone（vrmchar 里 scale = targetHeight / rawHeight）
STYLE.scaleSpringBones(vrm, 4.4 / 1.615, { gravityPower: 0.03, dragForce: 0.5 });

// 5) 配件
STYLE.attachToBone(vrm, "head", horn, { position: [0.17, 0.16, 0.02], rotation: [0, 0, 0.45] }, { space: "world" });

// 6) 表情
STYLE.setExpression(vrm, "happy", 0.8);
```

---

## 8. 最影响观感的 5 个参数（排序）

| 排名 | 参数 | 为什么最重要 | 推荐值（200–300px） | 改动位置 |
|---|---|---|---|---|
| 1 | **描边宽度 + 模式**（`outlineWidthMode` / `outlineWidthFactor`） | 决定"是不是画出来的手办"；现在实测 <0.3px，等于没有 | `screenCoordinates`，`w = 2·px/H`，px 1.0–1.4（Q 版 1.4–1.6） | `vrm-style.setOutline()` |
| 2 | **Rim**（`parametricRimColorFactor` + `fresnel` + `rimLightingMix=0`） | 透明背景上把角色从深/浅 UI 里"抠"出来；头发/肩膀一圈亮线是手办感来源 | 头发 0.22/3.2/0.12；衣服 0.14/3.6/0.10；脸 0 | `applyLookdev` / 手改 |
| 3 | **Key 光强度 + 环境光比例**（key / ambient / hemi） | MToon 的明暗分界只由 key 产生，环境光只会洗平；`key≈π` 是"满亮基色"基准 | key 2.7–3.0、fill 0.65、ambient 0.35、hemi 0.25 | `vrmchar.makeLights`/`applyLight` |
| 4 | **脸的 shadingShift / toony**（+ 眼/嘴同族） | 小窗口上脸上的明暗分界 = "脏"；打平后五官才干净 | shift +0.72~+1.0，toony 0.96–1.0 | `applyLookdev` |
| 5 | **头身比 + 眼睛可读性**（raw head scale / 眼骨 scale / 高光 emissive） | 200px 下脸 38px、虹膜 3px；不大头/不放大眼睛就"没有表情" | head raw scale 1.30–1.45；眼骨 1.2–1.35；高光 emissive 1.5 | §4.4 / §5.2 |

> 第 0 位（不算参数）：**素材**。10 个模型里，VRoid 系（`twist` / `VRoid_V110` / `Vivi` / `HairSample_Female`）的材质命名、UV、MToon 参数最干净，改造效率高；`Seed-san` 这类非 VRoid 模型材质命名随意、matcap/rim 自定义，做四形象会非常费劲——**优先选 VRoid 系底模**。

---

## 9. 附：给集成方的 todo（本次未做/不能做）

- [ ] `build.py` `MODULES` 加 `("vrm-style", "src/3d/vrm-style.js")`（本 agent 规则不允许改）
- [ ] `vrmchar.js` `attachModel()` 里接 `applyLookdev` / `setOutline` / `makeChibi` / `scaleSpringBones`
- [ ] `models/` 里的 VRM **授权/来源**核对，同步更新 `ASSETS.md`（现在还写着"没有外部模型文件"）
- [ ] `lab/vrm-test.html` / `lab/vrm-preview.html` 增加"四形象 + 描边 px + 深/浅背景"对照截图
- [ ] 真机 195×300 截图验收（§2.5.4 / §5.6）
- [ ] 待验证项（§6.5）逐项打勾

---

## 10. 集成速查（给集成方，可直接粘）

> 本节是应集成方要求补的"抄作业区"。`vrm-style.js` 的大结构已冻结，本节只补文档。

### 10.1 Q 版化到底缩哪个骨？（一句话）

**只缩 raw head 骨，raw neck 骨吃 20% 左右；归一化骨（normalized）缩了没有任何效果。**

```js
vrm.humanoid.getRawBoneNode("head").scale.setScalar(1.38);   // ★ Q版大头：raw head，uniform scale
vrm.humanoid.getRawBoneNode("neck").scale.setScalar(1.06);   // 分摊接缝（可选）
```

原因（源码）：`VRMHumanoidRig.update()` 每帧只把 quaternion（+ hips.position）写回 raw 骨，**不写 scale**；而 `getNormalizedBoneNode()` 返回的是 loader 额外建的、不在 `vrm.scene` 里的独立 Object3D 树。所以：

- ✅ `getRawBoneNode("head").scale` → 永久生效、且会带动脸/眼/头发 spring 骨一起放大。
- ❌ `getNormalizedBoneNode("head").scale` → 无效（每帧被忽略）。
- **必须 uniform scale**（`setScalar`），非均匀 scale 遇到骨骼 rest 旋转会斜切网格。

### 10.2 鲸鱼尾巴 / 红角 / 发带 / 贝雷帽 / 女仆头饰挂哪个骨？

**一律挂 raw 骨**（`getRawBoneNode`），永远不要挂 normalized 骨（不在场景里、不跟动画）。

| 配件 | 挂载骨（raw） | 一行代码（`space:"world"` 时 offset 是世界方向位移） |
|---|---|---|
| 红角 ×2 | `head` | `STYLE.attachToBone(vrm, "head", horn, { position: [±0.17, 0.16, 0.02], rotation: [0, 0, ±0.45] }, { space: "world" })` |
| 白 hairband | `head` | `STYLE.attachToBone(vrm, "head", band, { position: [0, 0.10, -0.01] }, { space: "world" })` |
| 白贝雷帽 | `head` | `STYLE.attachToBone(vrm, "head", beret, { position: [0.03, 0.24, -0.03], rotation: [0.10, 0, -0.28] }, { space: "world" })` |
| 女仆头饰 | `head` | `STYLE.attachToBone(vrm, "head", headdress, { position: [0, 0.13, -0.02] }, { space: "world" })` |
| 鲸鱼尾巴 | `hips` | `STYLE.attachToBone(vrm, "hips", tail, { position: [0, -0.05, -0.38] }, { space: "world" })` |

为什么 `space:"world"`：VRoid 的 head 骨 rest 旋转实测是 `[0.468, 0.530, 0.468, 0.530]`（不是世界轴对齐），用骨局部坐标摆配件会歪；`space:"world"` 下 offset 的 +Y=上、+Z=角色正前、-Z=背后，rotation 也是世界朝向，内部已换算成 `q_boneWorld⁻¹ × q_world`。

配件材质用 `STYLE.makeMToonMaterial({...})`（**可被配件模块直接复用**，不依赖 vrm 实例，也不依赖 VRMT——没有 `THREE_VRM` 时退回 `MeshBasicMaterial`）：

```js
var mat = STYLE.makeMToonMaterial({
  color: "#f2485a", shadeColorFactor: "#b02036",
  rim: "#ffc0c8", rimFresnel: 3.0, rimLift: 0.15, rimLightingMix: 0
});
```

### 10.3 四皮肤 style 配置（可直接粘的代码）

先用统一入口（`SKIN_STYLE` 表 + `applySkinStyle()`），再按皮肤调 `headK / 颜色 / 描边 / rim / matcap`。

```js
var STYLE = __req("vrm-style").create(THREE, window.THREE_VRM);

// 四皮肤配置（颜色取 src/3d/chars/*.js 的 2D 调色板，保证 2D/3D 一致）
var SKIN_STYLE = {
  onee: {                    // 02 · 御姐
    headK: 1.00, neckK: 1.00,
    outlinePx: 1.10, outlineColor: 0x3a2230,
    hair: "#f08fbc", hairBack: "#c76a9b",          // 粉发；后发暗一档
    iris: "#46b992",                               // 02 青绿瞳
    eyeScale: 1.00, highlightEmissive: 1.3,
    cloth: { tops: "#cf2b41", bottoms: "#8c1a31", shoes: "#fff3f0" }, // 红外套 + 白靴
    rim: { hair: 0.22, cloth: 0.14, skin: 0.10 },
    matcap: 0.30,
    glow: 0xff6f96,
    spring: { gravityPower: 0.03, dragForce: 0.50, stiffnessMul: 1.10 },
    camera: { margin: 1.06, elevation: 0.07, distK: 1.00 }
  },
  genki: {                   // 02 · 元气（贝雷帽）
    headK: 1.08, neckK: 1.02,
    outlinePx: 1.15, outlineColor: 0x3a2230,
    hair: "#ff9ec8", hairBack: "#c76a9b",
    iris: "#3fd1a0",
    eyeScale: 1.05, highlightEmissive: 1.4,
    cloth: { tops: "#d42f47", bottoms: "#8c1a31", shoes: "#fff3f0" },
    rim: { hair: 0.24, cloth: 0.16, skin: 0.10 },
    matcap: 0.32,
    glow: 0xff8fb0,
    spring: { gravityPower: 0.04, dragForce: 0.48, stiffnessMul: 1.05 },
    camera: { margin: 1.08, elevation: 0.07, distK: 0.98 }
  },
  chibi: {                   // 02 · Q 版（大头）
    headK: 1.40, neckK: 1.07,
    outlinePx: 1.50, outlineColor: 0x3a2230,
    hair: "#f08fbc", hairBack: "#c76a9b",
    iris: "#46b992",
    eyeScale: 1.25, highlightEmissive: 1.6,
    cloth: { tops: "#cf2b41", bottoms: "#8c1a31", shoes: "#fff3f0" },
    rim: { hair: 0.26, cloth: 0.18, skin: 0.10 },
    matcap: 0.35,
    glow: 0xff6f96,
    spring: { gravityPower: 0.02, dragForce: 0.52, stiffnessMul: 1.15 },
    camera: { margin: 1.10, elevation: 0.05, distK: 0.95 }
  },
  whale: {                   // 鲸鲸（蓝发女仆）
    headK: 1.32, neckK: 1.06,
    outlinePx: 1.25, outlineColor: 0x1e2140,
    hair: "#7fadf8", hairBack: "#3f6bd0",
    iris: "#4fa0f0",
    eyeScale: 1.12, highlightEmissive: 1.5,
    cloth: { tops: "#f9f8fd", bottoms: "#2f56a8", shoes: "#1f2b58" }, // 白衬衫 + 蓝裙
    rim: { hair: 0.26, cloth: 0.14, skin: 0.08 },
    matcap: 0.30,
    glow: 0x6fb7ff,
    spring: { gravityPower: 0.06, dragForce: 0.45, stiffnessMul: 1.08 },
    camera: { margin: 1.08, elevation: 0.06, distK: 0.97 }
  }
};

/**
 * 一个皮肤 = 一套 style；在 vrmchar attachModel() 之后调用。
 * @param vrm      three-vrm 的 VRM 实例
 * @param style    SKIN_STYLE[skinId]
 * @param sceneScale  vrmchar 归一化用的 scene.scale（= targetHeight / rawHeight）
 * @param viewportHeightPx  宿主窗口高度（像素）
 */
function applySkinStyle(vrm, style, sceneScale, viewportHeightPx) {
  // 1) 材质分类预设 + 首轮染色（发/衣/瞳；虹膜用 canvas 重绘保明度）
  STYLE.applyLookdev(vrm, "figure", {
    tint: { hair: style.hair, cloth: style.cloth.tops, iris: style.iris },
    recolor: { iris: true }
  });

  // 2) 两色头发：前发上面已染，后发单独压暗（VRoid 有独立 HairBack 材质）
  STYLE.tintByMaterialName(vrm, /hairback/i, style.hairBack, { shade: 0.55, rim: 0.16, outlineMix: 0.32 });

  // 3) 衣服分区：tops/bottoms/shoes 分别染（VRoid 各自独立材质）
  STYLE.tintByMaterialName(vrm, /tops|huku/i, style.cloth.tops, { shade: 0.62, rim: style.rim.cloth });
  STYLE.tintByMaterialName(vrm, /bottoms|skirt/i, style.cloth.bottoms, { shade: 0.55, rim: style.rim.cloth });
  STYLE.tintByMaterialName(vrm, /shoes/i, style.cloth.shoes, { shade: 0.72, rim: 0.10 });

  // 4) rim / matcap（applyLookdev 已按预设贴过；这里按皮肤强度覆写）
  var list = STYLE.collectMaterials(vrm);
  for (var i = 0; i < list.length; i++) {
    var m = list[i];
    if (m.isOutline) continue;
    var cat = STYLE.classify(m.name);
    if (cat === "hair") {
      // rim = 发色提亮（线性空间里乘 0.6~0.8），matcap 由上面的 applyLookdev 预设负责
      m.parametricRimColorFactor.copy(new THREE.Color(style.hair)).multiplyScalar(0.7);
      m.parametricRimFresnelPowerFactor = 3.2;
      m.parametricRimLiftFactor = 0.12;
      m.rimLightingMixFactor = 0;
    } else if (cat === "cloth" || cat === "skin") {
      var base = new THREE.Color(cat === "skin" ? 0xffdcc4 : style.cloth.tops);
      m.parametricRimColorFactor.copy(base).multiplyScalar(style.rim[cat] * 2.2);
      m.parametricRimFresnelPowerFactor = 3.8;
      m.parametricRimLiftFactor = 0.10;
      m.rimLightingMixFactor = 0;
    }
  }

  // 5) 描边：按像素反算（推荐 screenCoordinates）
  STYLE.setOutline(vrm, {
    mode: "screen",
    px: style.outlinePx,
    viewportHeightPx: viewportHeightPx || 300,
    color: style.outlineColor
  });

  // 6) Q 版：raw head / neck（uniform scale；normalized 无效）
  var head = vrm.humanoid.getRawBoneNode("head");
  if (head) head.scale.setScalar(style.headK);
  var neck = vrm.humanoid.getRawBoneNode("neck");
  if (neck) neck.scale.setScalar(style.neckK);

  // 7) 眼睛可读性：眼骨放大 + 高光提亮（脸/眼已由 applyLookdev 打平）
  if (style.eyeScale && style.eyeScale !== 1) {
    ["leftEye", "rightEye"].forEach(function (n) {
      var b = vrm.humanoid.getRawBoneNode(n);
      if (b) b.scale.setScalar(style.eyeScale);
    });
  }
  var hi = STYLE.findMaterial(vrm, /eyehighlight/i);
  if (hi) {
    hi.emissive.setRGB(0.22, 0.22, 0.24);          // 线性
    hi.emissiveIntensity = style.highlightEmissive;
    hi.shadingShiftFactor = 1; hi.shadingToonyFactor = 1;
  }

  // 8) SpringBone：先按 scene 缩放补偿（官方 guide），再按皮肤风格调
  if (sceneScale > 0) STYLE.scaleSpringBones(vrm, sceneScale, style.spring);

  return vrm;
}
```

> `applyLookdev` 已经会自动给 hair 材质挂天使环 matcap（预设 `hair.matcap = 0.30`，只在 `matcapTexture == null` 时挂；VRM0 VRoid 自带 `MatcapWarp` 的不会覆盖）。上面第 4 步只覆写 rim；**matcap 强度想按皮肤单独调**就显式写：

```js
// 想把鲸鲸的 matcap 调弱/调强：
var hairMat = STYLE.findMaterial(vrm, /hair(?!back)/i);
if (hairMat && hairMat.matcapTexture) {
  hairMat.matcapFactor.setRGB(0.5, 0.5, 0.5);   // 线性，0.2–0.5
  hairMat.rimLightingMixFactor = 0;             // 必须：否则 matcap 受灯光调制
}
```

> 每个皮肤的 `outlinePx` 依据（300px 窗口）：onee 1.10、genki 1.15、chibi 1.50、whale 1.25（Q 版头大、窗口 285–300，描边按比例加粗到 1.4–1.6 才"有线条感"）。窗口高度不是 300 时不用改公式：`setOutline({ px, viewportHeightPx: host.clientHeight })` 内部会按 `w = 2·px/H` 重算。

### 10.4 最小接入代码（3 行，build 完 VRM 之后）

```js
var STYLE = __req("vrm-style").create(THREE, window.THREE_VRM);
STYLE.applyLookdev(vrm, "figure", { tint: SKIN_STYLE[skinId].hair, recolor: { iris: true } });
STYLE.setOutline(vrm, { mode: "screen", px: SKIN_STYLE[skinId].outlinePx, viewportHeightPx: host.clientHeight || 300 });
```

再补 2 行推荐（Q 版和缩放补偿，缺一不可）：

```js
vrm.humanoid.getRawBoneNode("head").scale.setScalar(SKIN_STYLE[skinId].headK);
STYLE.scaleSpringBones(vrm, sceneScale, SKIN_STYLE[skinId].spring);
```

### 10.5 `PRESETS.figure` 说明 + 推荐调用

`api.PRESETS.figure` 已内置（`vrm-style.js` §7），结构：

```js
STYLE.PRESETS.figure = {
  skin:  { shadingShift: 0.30, shadingToony: 0.92, giEqualization: 0.75, rim: 0.10, rimFresnel: 4.0 },
  face:  { shadingShift: 0.72, shadingToony: 0.96, giEqualization: 0.90, rim: 0.00 },
  iris:  { shadingShift: 0.95, shadingToony: 1.00, giEqualization: 1.00, rim: 0.00 },
  hair:  { shadingShift: -0.12, shadingToony: 0.94, giEqualization: 0.90, rim: 0.22, rimFresnel: 3.2, rimLift: 0.12, matcap: 0.30 },
  cloth: { shadingShift: -0.04, shadingToony: 0.92, giEqualization: 0.90, rim: 0.14, rimFresnel: 3.6 },
  other: { shadingShift: -0.05, shadingToony: 0.92, giEqualization: 0.90, rim: 0.10 },
  rimLightingMix: 0,
  outline: { px: 1.2 }
};
```

推荐调用（一行 + 可选染色）：

```js
// 只套参数（不改颜色）：
STYLE.applyLookdev(vrm, "figure");
// 套参数 + 按类别染色（虹膜走 canvas 重绘，最干净）：
STYLE.applyLookdev(vrm, "figure", {
  tint: { hair: "#f08fbc", cloth: "#cf2b41", iris: "#46b992" },
  recolor: { iris: true }
});
```

- `tint` 支持的 key：`hair` / `cloth` / `skin` / `iris`（匹配规则见 `STYLE.TINT_MATCHERS`）；**皮肤建议不传 `skin`**（VRM 原肤色最好，染了会"塑料黄"）。
- `opts.recolor.iris = true` 时虹膜走 `recolorMap`（canvas HSL，保明度），否则走乘法染色（会把眼白/高光染脏）。
- 预设是**参数**不是颜色；四皮肤的颜色差异用 `tint` + 两色头发（`/hairback/`）+ 衣服分区染色覆盖，见 §10.3。
- `makeMToonMaterial(opts)` 与 `applyLookdev` 完全解耦，配件模块直接 `STYLE.makeMToonMaterial({...})` 即可复用（不需要 vrm 实例）。
