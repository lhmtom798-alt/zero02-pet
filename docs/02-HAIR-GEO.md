# 02 头发叠加几何（mmd-hair）实验报告

> 日期：2026-11-13 · 实验产物：`src/3d/mmd-hair.js`、`lab/hair-test.html`、`docs/02-HAIR-GEO.md`、`shots/hair2-*.png`
> 验证模型：`models/mmd/TDA-ZeroTwo/test-fixed2.pmx`（与 `models/final/ZeroTwo_TDA.pmx` md5 相同 = build 打包进插件的线上模型）

## 0. 一句话结论

**值得接**：纯增量叠加，默认参数下只 **+1 draw call / +2,880 三角形**，**每帧 0 JS 开销**（发束直接蒙皮到模型原有 `cf_J_hair*` 骨骼，跟着 mmdchar 的头发物理一起摆）。视觉上是「发梢变长 + 发丝层次 + 发绺高光」的轻量增强：正面看得出层次，背面/侧后方提升最明显；不是质变，但也不破坏原模型。

- 推荐参数：`density=2, radius=0.08, len=1.25, shine=1, color=ff9fc4, softEdge=0.9`（即模块默认值）
- 接入成本：`build.py` 加 1 行 + `mmdchar.js` 加载完成后加 ~8 行（见 §5）
- 可随时用配置关掉（`hair=0` / 不调用 attach），失败只 warn 不影响主流程

![参数对比网格](../shots/hair2-grid.png)

*（A 对照组 / B 推荐 / C 细密 / D 粗显 / E 无高光 / F 背面；每格头部区域裁切）*

## 1. 效果截图

| 文件 | 内容 |
| --- | --- |
| [`shots/hair2-grid.png`](../shots/hair2-grid.png) | 6 宫格参数对比（含对照组与背面） |
| [`shots/hair2-01-nohair-head.png`](../shots/hair2-01-nohair-head.png) | 对照组 `hair=0`，头部特写 900×1125 |
| [`shots/hair2-02-recommended-head.png`](../shots/hair2-02-recommended-head.png) | **推荐参数**，同一机位头部特写 |
| [`shots/hair2-03-nohair-body.png`](../shots/hair2-03-nohair-body.png) | 对照组全身 |
| [`shots/hair2-04-recommended-body.png`](../shots/hair2-04-recommended-body.png) | **推荐参数**全身（可见发梢延长与脸侧发片） |
| [`shots/hair2-05-param-thin-dense.png`](../shots/hair2-05-param-thin-dense.png) | 细密：`density=3 radius=0.055`（24 条，发丝感更强） |
| [`shots/hair2-06-param-bold.png`](../shots/hair2-06-param-bold.png) | 粗显：`density=2 radius=0.13 lift=0.05`（层次明显但更像贴片） |
| [`shots/hair2-07-param-muted.png`](../shots/hair2-07-param-muted.png) | 无高光：`shine=0 color=ffc4dc`（更素、更像原材质） |
| [`shots/hair2-08-back.png`](../shots/hair2-08-back.png) | 背面（推荐参数）——层次提升最明显 |
| [`shots/hair2-09-pose.png`](../shots/hair2-09-pose.png) | `?pose=2.2` 扭头发骨 —— 验证发束跟随骨骼摆动 |
| [`shots/hair2-10-hd.png`](../shots/hair2-10-hd.png) | **推荐参数高清图** 1000×1400（3/4 视角） |
| [`shots/hair2-11-34.png`](../shots/hair2-11-34.png) | 推荐参数 3/4 全身 |
| [`shots/hair2-12-merged.png`](../shots/hair2-12-merged.png) | 合并成一个 SkinnedMesh 后的渲染（与未合并一致） |
| [`shots/hair2-13-hud.png`](../shots/hair2-13-hud.png) | lab HUD：`strands=16 chains=8 draws=1` |
| [`shots/hair2-14-timing.png`](../shots/hair2-14-timing.png) | attach 耗时测量现场 |
| [`shots/hair2-16-ring-experimental.png`](../shots/hair2-16-ring-experimental.png) | 可选「天使环」高光带实验（默认关，见 §8） |

## 2. 原理（不引入新物理，全部复用原骨架）

### 2.1 骨骼分组（8 条链、45 根骨骼）

模型里 `cf_J_hair*` 共 47 根，剔除 `cf_J_hairB_top` / `cf_J_hairF_top` 两根控制骨后，按名字前缀分成 8 组，
每组**按世界 Y 从高到低排序**成发根→发梢链（不能信 PMX 的 parentIndex：修复后的 PMX 里部分头发骨骼的
父级实际挂在裙摆骨上，按父链走会错）。

| 组 id | 骨骼前缀 | 骨骼数 | 位置 | 处理 |
| --- | --- | --- | --- | --- |
| `backC` | `cf_J_hairB_` | 7 | 后脑正中长发 | 贴后侧表面 |
| `backL` | `cf_J_hairBL_` | 7 | 后脑左侧长发 | 贴后侧表面 |
| `backR` | `cf_J_hairBR_` | 7 | 后脑右侧长发 | 贴后侧表面 |
| `sideL` | `cf_J_hairFL_02_` | 7 | 脸侧长发（左） | 浮起发片（`liftMul=6`） |
| `sideR` | `cf_J_hairFR_02_` | 7 | 脸侧长发（右） | 浮起发片 |
| `fringeL` | `cf_J_hairFL_01_` | 4 | 鬓发（左） | 小发片（`liftMul=2`） |
| `fringeR` | `cf_J_hairFR_01_` | 3 | 鬓发（右） | 小发片 |
| `bangs` | `cf_J_hairF_` | 3 | 刘海 | 小发片 |

### 2.2 头发表面：从顶点云里射线取「最外层」

1. 从 `hair.png / hair_s.png` 材质对应的三角形抽出头发顶点云（本模型 **55,581 顶点 / 18,527 三角形**），
   只保留模型局部坐标，不进场景；
2. 对每条链上的每根骨骼，从骨骼位置沿「朝外」方向打一条射线：
   - 后发组：方向 ≈ 水平径向外侧（`ray=1.0`）；
   - 前发组：方向 = 径向外侧 + `+Z` 混合（`ray=0.75~1.3`，侧长发更靠外，避免发片压到脸上）；
   - 取射线上**最远的交点** = 该方向最外层的头发面；交点沿法线再抬 `lift`（默认 0.032，浮起发片组 ×6）；
3. 射线打空时退回「高度 × 角度 → 半径」外轮廓表（`shell` 参数兜底）。

### 2.3 发片几何（ribbon）

- 控制点 = `[发根延长点] + 链上骨骼落点 + [发梢延长点]`，用 `CatmullRomCurve3` 串起来；
- 发根向上延长约 0.55 个链首段，藏进发团；发梢按 **链长 × 0.20 × len** 延长，方向逐渐向重力（向下）偏，
  并带确定性随机 yaw，避免所有发梢一个方向；
- 沿曲线采样 18 段，每段生成 6 个顶点（横向 5 细分）的带状截面：
  宽度曲线 = 发根窄（0.52r）→ 中段最宽（≈1.35r）→ 发梢收尖；
  截面沿法线方向鼓一点（`thickness`），给出圆润的横向明暗；
- 横向附加「发绺」感的细条纹顶点色、沿长度的轻微波浪（`wave`）与扭转（`twist`）。

### 2.4 蒙皮（关键：怎么跟着物理动）

发片是 `SkinnedMesh`：每个 ring 的顶点按曲线参数落在相邻两根头发骨骼之间，
`skinIndex/skinWeight` 两骨线性混合（发梢延长段 100% 挂最后一根骨骼）；
`bind(skeleton, mesh.bindMatrix)` 共享原模型骨骼与绑定矩阵，`bindMode` 与原模型一致（`attached`）。
所以 **发片就是原骨架的一部分**：mmdchar 每帧写的头发骨骼弹簧摆动会原样带动发片，**零额外每帧代码**。

### 2.5 颜色与材质

- `MeshBasicMaterial`（unlit）+ 顶点 RGBA；
- 顶点色 = `HSL(root 深粉) → HSL(tip 浅粉)` 渐变 × 烘焙明暗（固定光向的半兰伯特 + 横向边缘压暗）× 细条纹；
- 高光带：沿长度 0.28 与 0.55 两个高斯「天使环」亮带（`shine` 控制强度），读起来像发绺上的高光；
- 软边：横向 alpha 从中心 1 渐隐到边缘 `1-softEdge`（默认 0.9），发片融进原头发，避免「贴纸硬边」；
- 旋转/缩放/小幅度形变由 GPU skinning 完成，材质无需每帧更新。

### 2.6 合并与开销（实测）

| 项 | 数值 |
| --- | --- |
| 发束条数 | 16（8 链 × density 2） |
| 合并后几何 | 1,824 顶点 / 2,880 三角形 |
| draw call | **1**（`merge=1` 默认把 16 个 SkinnedMesh 合成一个；`merge=0` 仅调试用） |
| attach 一次性耗时 | **68~71 ms**（headless Chrome，含 45 条射线对 18,527 个三角形求交 + 几何生成） |
| 每帧 JS 开销 | **0**（全部由原 Skeleton 驱动） |
| 额外内存 | 临时射线云 ~0.6 MB，attach 结束即释放 |

## 3. 参数表

URL（lab）里同名参数直接透传；模块里也可以传对象。

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `density` | `2` | 每条骨骼链生成几条发片（1/2/3） |
| `radius` | `0.08` | 发片根部半宽（模型身高 19.69 单位） |
| `len` | `1.25` | 发梢延长系数：延长量 = 链长 × 0.20 × len |
| `shine` | `1` | 「天使环」高光强度，0 = 关 |
| `color` | `ff9fc4` | 主色（根部自动压暗、梢部自动提亮） |
| `rootColor` / `tipColor` | 空 | 可选：直接指定根/梢颜色 |
| `softEdge` | `0.9` | 两边 alpha 渐隐比例，0 = 硬边 |
| `groups` | 全开 | 只生成指定组，逗号分隔，`all` = 全开 |
| `lift` | `0.032` | 从表面外抬量（浮起发片组内部 ×6） |
| `wave` / `twist` | `1` / `1` | 沿长度的波浪 / 微扭转 |
| `variation` | `1` | 各发片宽度/长度/发梢方向的确定性差异 |
| `merge` | `1` | 合并成一个 SkinnedMesh（省 draw call） |
| `mat` | `basic` | `basic`（默认）/ `toon`（调试） |
| `segments` / `width` | `18` / `5` | 纵向采样段数 / 横向细分数 |
| `ring` / `ringY` / `ringH` / `ringIntensity` | `0` / 自动 / 0.52 / 1 | 可选「天使环」高光带（默认关，见 §8） |

## 4. 模块 API

```js
// build.py 的 __def 模块里
var MMDHair = require("mmd-hair");
var hair = MMDHair.create(THREE).attach(mesh, { density: 2, radius: 0.08 });
hair.stats;      // { strands, chains, bones, hullPoints, drawCalls, chainInfo, ring, params }
hair.detach();   // 移除并释放几何/材质

// 独立页（window.THREE 存在时）
var hair = window.MMDHAIR.attach(mesh, { shine: 0 });
```

`mmd-hair.js` 同时兼容两种加载方式：build.py 的 CommonJS 包装里走 `module.exports`；
独立 `<script src="/src/3d/mmd-hair.js">` 会自动挂到 `window.MMDHAIR`（lab 页就是这样跑的）。

## 5. 集成方式（最小改动，推荐）

> 本轮实验按约定**没有改** `build.py` / 任何 `src/` 文件。下面是接线所需的全部改动：

**① `build.py`：模块清单加一行**（否则 `__req("mmd-hair")` 找不到）

```python
MODULES = [
    ...
    ("mmd-shade", "src/3d/mmd-shade.js"),
    ("mmd-hair", "src/3d/mmd-hair.js"),      # ← 新增
    ...
]
```

**② `src/3d/mmdchar.js`：模型加载完成后 attach**（找 `char._candy = attachCandy();` 这一行，在它前面插入）

```js
// 发束几何叠加：失败只 warn，不影响主流程
try {
  var hairGeoMod = __req("mmd-hair");
  if (hairGeoMod && hairGeoMod.create) {
    char._hairGeo = hairGeoMod.create(THREE).attach(mesh, {
      density: 2, radius: 0.08, len: 1.25, shine: 1, softEdge: 0.9,
    });
  }
} catch (e) { console.warn("[mmdchar] 发束叠加失败", e); }
```

**③（可选）释放**：`mmdchar` 的 `dispose` 目前只清 cache、不销毁 mesh；如果以后加真正的 dispose，
顺手 `if (char._hairGeo) try { char._hairGeo.detach(); } catch (e) {}` 即可。

改完 `python3 build.py` 重新生成 `zero02-pet/lib/client.js` 与 `lab/bundle.js`。
注意：attach 必须在**模型加载完成、骨骼处于静止姿势时**调用一次（就是上面这个位置），之后不需要任何每帧更新。

## 6. 已知限制（诚实清单）

1. **发片自身不会再弯曲**：每个 ring 只在相邻 2 根骨骼之间线性混合，没有对发片做逐骨骼分段绑定；
   大幅甩头且相邻骨骼夹角很大时，发片可能出现折线感（当前 mmdchar 的物理幅度下不明显）。
2. **只在 attach 时贴合一次**：位置来自静止姿势的射线；头发/头大幅运动后，发片不会重新贴表面，
   极端姿势下可能与原发壳轻微穿插或飘离（发根已做下沉、边缘软 alpha，日常幅度看不出）。
3. **依赖 TDA 骨骼命名**（`cf_J_hairBL_ / cf_J_hairBR_ / cf_J_hairB_ / cf_J_hairF_ / cf_J_hairFL_ / cf_J_hairFR_`）。
   线上 `ZeroTwo_TDA.pmx` 与 lab 的 `test-fixed2.pmx` 是同一份（md5 相同），命名一致 → 可直接用；
   但 **HD 模型 `Darling02_fixed.pmx` 的头发骨名不同**（没有 `cf_J_hair*`），当前不会生效，
   需要给 `CHAINS` 加一套命名适配（按骨骼链 id + 位置排序）。
4. **原发壳穿插不可避免**：发片是外加的一层，个别角度会切进原发片或衣服；目前靠「浮起量/软边/宽度曲线」掩盖，
   没有做逐帧碰撞。
5. **unlit 颜色是烘焙的**：光照/环境变化发片不会跟着变（赛璐璐风格下可接受）；可切 `mat=toon` 对比。
6. **透明排序**：软边发片是 transparent，与场景其它透明物体（若有）的排序依赖 three 的默认规则；
   发片之间已合并成同一材质+同一 draw call，内部排序稳定，当前未发现明显问题。
7. **性能**：合并后 1 draw call / 1824 顶点，非常轻；但 attach 是一次性 ~70ms 的工作（射线求交），
   不要每帧/每次切状态重建。`merge=0` 仅调试用（16 draw calls）。
8. **ring 高光带（可选）**默认关闭：见 §8。

## 7. 复现 / 验收

lab 页可独立跑（只依赖 `/vendor/three-vrm.global.js` + `/src/3d/mmd-hair.js`）：

```bash
# 推荐参数（正面头部特写）
$NODE tools/shot.mjs \
  --url "http://127.0.0.1:8899/lab/hair-test.html?ty=0.9&zoom=0.33&hud=0" \
  --out shots/hair2-02-recommended-head.png --size 900x1125 --wait 3000 --ready "window.__HAIR_READY"

# 对照组
$NODE tools/shot.mjs \
  --url "http://127.0.0.1:8899/lab/hair-test.html?ty=0.68&zoom=0.78&hud=0&hair=0" \
  --out shots/hair2-03-nohair-body.png --size 520x760 --wait 3000 --ready "window.__HAIR_READY"

# 参数对比 / 背面 / 扭头演示
... &density=3&radius=0.055   ... &density=2&radius=0.13&lift=0.05
... &shine=0&color=ffc4dc     ... &yaw=3.1416     ... &pose=2.2
```

其中 `$NODE=~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node`。

lab 页可直接调的镜头/演示参数：

| URL 参数 | 说明 |
| --- | --- |
| `ty` / `zoom` | 取景中心（0~1 高度比例）/ 相机距离系数 |
| `yaw` / `pitch` | 模型水平/垂直旋转（`yaw=3.1416` 看背面） |
| `pose` | 把头发骨骼按深度做一个确定性旋转，演示「发束跟着物理动」 |
| `hair=0` | 关掉发束（对照组） |
| `hud=0` | 隐藏左上角参数 HUD |
| `pmx` | 换模型路径（默认 `/models/mmd/TDA-ZeroTwo/test-fixed2.pmx`） |

页面暴露：`window.MMDHAIR`（模块）、`window.__HAIR`（实例）、`window.__HAIR_INFO`（参数+统计）、`window.__HAIR_READY`（截图就绪标志）。

## 8. 可选：天使环高光带（`ring`，默认关）

代码里有沿头发表面绕一圈的「天使环」高光带（透明 RGBA 顶点色 + 蒙皮到 `頭` 骨骼），
`ring=1` 打开。实测：

![ring 实验](../shots/hair2-16-ring-experimental.png)

问题：在低模发片表面上它读起来更像一条**发光的扫描线/雾带**，而不是手绘高光（因为头发壳本身不是光滑曲面，
高光带无法像原画那样画在「整个发型轮廓」上）。**默认关闭**，保留代码方便以后换成贴图/更高层级的做法。

## 9. 如果还要做得更好（后续方向）

1. **逐骨骼分段绑定**：把每条发片按骨骼间距切成多段、每段刚性挂到对应骨骼，加关节处圆滑过渡 → 真正「二次弯曲」；
2. **按相机朝向/深度排序的发片层**：用少量发片 + 剪影形状做「分层」而不是大量细条；
3. **手绘感高光贴图**：给发片一条 4×64 的 alpha 渐变贴图做发梢/边缘，成本比顶点色更像插画；
4. **HD 模型命名适配**：Darling02_fixed 的头发骨如果确认命名规则，补一套 `CHAINS` 就能复用；
5. **自动参数**：根据模型身高/头围自动缩放 `radius/len`（当前按 TDA 19.69 身高调的，Darling 24.29 需要 ×1.23）。
