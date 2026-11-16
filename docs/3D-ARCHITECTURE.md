# 3D 子系统架构

> 面向以后维护本项目的人：讲清 `dsh-pets` 里 3D 手办子系统是怎么分层的、每层能做什么/不能做什么、
> 怎么加一个新角色、以及那些"看起来能跑但一改就炸"的坑。
>
> 相关文件：`src/3d/kit.js`、`fig.js`、`stage.js`、`registry.js`、`pet3d.js`、`chars/*.js`、`fx.js`、`sfx.js`，
> 以及宿主侧 `src/client/engine2d.js`（3D 适配与事件接线）和 `build.py`（模块打包）。

---

## 0. 一句话版本

引擎（2D 老代码）只认 `{ setPose, tick }` 两个方法；`pet3d` 把 3D 适配成这个接口；
3D 内部再分成 **kit（材质/几何）→ fig（手办装配）→ chars（角色）** 的建造链、
**stage（相机/渲染/灯光）** 的舞台层、**registry（角色注册表）** 的分发层，
以及 **fx（粒子）**、**sfx（合成音效）** 两个独立表达层。
所有模块都是浏览器里的 `__def/__req` CommonJS 风格模块，由 `build.py` 内联进插件单文件。

```
                        ┌─────────────────────────────────────────────┐
宿主 UI / 交互            │ src/client/engine2d.js  (2D 引擎 + 3D 适配)   │
（点击/拖动/聊天/设置）    │  setPose/tick · ensure3d · playSfx · timeline│
                        └───────┬──────────────────────┬──────────────┘
                                │ renderer 契约          │ burst/play
                                ▼                        ▼
                        ┌──────────────┐        ┌────────────────────┐
                        │ pet3d (适配层)│        │ fx / sfx (表达层)   │
                        │ tick/load    │        │ 粒子 / WebAudio    │
                        └──┬───────┬───┘        └────────────────────┘
                           │       │
                  ┌────────▼──┐ ┌──▼─────────┐
                  │ stage     │ │ registry   │
                  │ 舞台/相机  │ │ 角色注册表  │
                  └───────────┘ └──┬─────────┘
                                   │ build()
                             ┌─────▼──────┐
                             │ chars/*    │  角色层：比例/颜色/部件/姿势
                             └─────┬──────┘
                                   │ 使用
                             ┌─────▼──────┐        ┌──────────────┐
                             │ fig        │        │ kit          │
                             │ 手办装配层  │───────▶│ 材质/几何/贴图│
                             └────────────┘        └──────────────┘
```

依赖方向永远自上而下：**chars → fig → kit**，舞台与注册表横向调用；
`fx` 只依赖 `K + THREE`，`sfx` 谁都不依赖（连 K 都不用）。
反向依赖（kit 里 import 角色、fig 里碰 renderer）是禁止的。

---

## 1. 分层职责

### 1.1 kit —— 3D 底层工具箱（`src/3d/kit.js`）

- **职责**：卡通材质 `K.cel`、贴片材质 `K.decal`、反壳描边 `K.outline/outlineAll`、
  程序化几何（`sphere/capsule/lathe/ring/plane/box/cylinder/tube/strand/ribbon/heart/star/drop`）、
  Canvas 贴图（`canvas/canvasTex/canvasTexWH/tex/radialTex/shadowTex`）、弹簧（`springer`）、
  数学与颜色工具、`K.dispose`。
- **接口**：`module.exports.create = function (THREE) { ... return K; }`。
- **不负责**：角色设定、DOM、事件、渲染器、相机。
- **关键约定**：所有卡通材质共享同一组光照 uniform（`K.shared.uLight/uLight2/uNight`），
  `K.setLightDir / K.setNight` 改一次全局生效——这是昼夜模式的实现方式。

### 1.2 fig —— 手办装配层（`src/3d/fig.js`）

- **职责**：把"脸/头发/四肢/衣服/骨架"这类可复用手办零件做出来：
  - 曲面贴片：`FIG.patch / FIG.patchMesh`（把平面贴图贴到球面上，五官都用它）
  - 五官贴图：`FIG.eyeTexture / FIG.mouthTexture / FIG.blushTexture / FIG.hairShineTexture`
  - 头：`FIG.head()`（球体 + 削下巴 + 眼睛/嘴/腮红/鼻子贴片 + `face` 控制对象）
  - 头发：`FIG.hairCap / FIG.clump`
  - 四肢：`FIG.arm / FIG.leg / FIG.joint`
  - 衣服：`FIG.flare`（车削裙摆）、`FIG.frill`（荷叶边）
  - 骨架：`FIG.rig()`（命名关节 + 弹簧 pose + 每帧 motion 叠加）
- **接口**：`module.exports.create = function (K, THREE) { ... return FIG; }`。
- **不负责**：具体角色比例和配色、相机、渲染器。
- **约定**：fig 里所有零件都按"头半径 1、脚底 y=0"的参考尺度做，
  角色层用 `scale` / 参数把它拉高或压扁。

### 1.3 chars/* —— 角色层（`src/3d/chars/*.js`）

- **职责**：一个文件一个角色（或一组共用构建函数的变体），定义比例、颜色、发型/服装部件、
  姿势集与程序化小动画。
- **接口**（必须遵守）：

  ```js
  module.exports.create = function (K, FIG, THREE) {
    var variants = {
      chibi: {
        meta: {
          id: "chibi",            // 必须与 skins2d 的皮肤 id 一致
          label: "Q版",
          height: 4.42,           // 角色世界高度（脚底到头顶），用于 fx/相机参考
          camera: {               // 交给 stage.frame() 用
            height: 4.95, targetY: 2.32, margin: 1.06,
            elevation: 0.07, glowColor: 0xff6f96,
          },
        },
        build: function (o) {     // o = { THREE, K, FIG, stage }
          return char;            // 见下面的 char 对象契约
        },
      },
    };
    return { variants: variants };
  };
  ```

- **char 对象契约**（引擎只认这些）：

  | 字段/方法 | 说明 |
  | --- | --- |
  | `root` | `THREE.Group`，脚底 y=0、面朝 **+Z**，由 pet3d 加进 `stage.root` |
  | `height` | 世界高度（同 `meta.height`） |
  | `camera` | 同 `meta.camera`，备查 |
  | `setState(name)` | 切换姿势/表情：`idle happy talk sleep shy stretch wink eat`；未知名字退回 `idle` |
  | `setLook(nx, ny)` | 视线跟随，`[-1,1]`，内部平滑，不要瞬移 |
  | `pat()` | 被拍一下的反馈（可选；Q版会挤压 + 脸红 + 短时 happy） |
  | `update(dt, t)` | 每帧：呼吸、眨眼、头发摆动、嘴型、rig 更新 |
  | `stateName()` | 当前状态名（调试用，可选） |
  | `dispose()` | 释放本角色自建资源（贴图等），然后 `K.dispose(root)` |

- **现有角色**：
  - `chars.zerotwo` → `chibi`（Q版，`height 4.42`）
  - `chars.zerotwo-tall` → `onee`（御姐，`6.40`）、`genki`（元气，`6.20`）
  - `chars.whale` → `whale`（鲸鲸，`3.60`）
- **约定**：一律用 `K.cel` 卡通材质 + `K.outline` 描边；五官/花纹用 `FIG.patchMesh`
  （`userData.noOutline = true`）；根节点由角色自己创建，**不要碰 renderer / camera / DOM**。

### 1.4 registry —— 角色注册表（`src/3d/registry.js`）

- **职责**：把各角色模块汇总成 `皮肤 id → { meta, build }` 的表；单个角色模块抛异常时
  `try/catch` 掉并 `console.warn`，不影响其它角色。
- **接口**：`module.exports.create = function (K, FIG, THREE) { ... }`
  → `{ map, ids(), get(id), has(id) }`。
- **新增角色要改这里**：`MODULES` 数组加一行 `"chars.xxx"`（模块名必须与 build.py 一致）。
- 已知临时状态：文件里有 `// TEMP-TEST` 把 `onee`/`genki` 临时指到 `chibi`（真机验证 3D 链路用），
  **发版前删掉**。

### 1.5 stage —— 舞台层（`src/3d/stage.js`）

- **职责**：`WebGLRenderer`（透明背景、dpr 按画质封顶）、`PerspectiveCamera(26°)`、
  场景、角色根节点 `stage.root`、背光晕 Sprite、地面接触阴影、相机弹簧（方位/俯仰/距离/目标点）、
  按角色尺寸取景 `frame()`、窗口缩放 `setSize()`、轨道 `setOrbit()`、昼夜 `setNight()`、`render()`、`dispose()`。
- **接口**：`module.exports.create({ THREE, K, host, quality })`。
- **关键约定**：
  - `stage.root` 是**挂角色和 fx 的父节点**；角色根节点不要直接加到 `scene`。
  - `frame(meta.camera)` 必须在角色加入后调用；换角色要重新 `frame + setSize`。
  - `setSize` 会在竖长画布（`aspect < 0.85`）时自动把相机拉远，避免侧发被裁。
  - 渲染器 `domElement` 是 `pointer-events:none`，交互由宿主 DOM 处理。
- **不负责**：知道具体角色是谁（只认 `height/targetY/margin/...` 这几个数）。

### 1.6 pet3d —— 宿主适配层（`src/3d/pet3d.js`）

- **职责**：把 3D 子系统伪装成 2D 引擎认识的 renderer：
  `{ type:"3d", setPose(name), tick(dt) }`，外加切角色、尺寸、画质、视线、拖拽视角、
  空闲回正、昼夜、释放。
- **接口**：`module.exports.create({ THREE, K, FIG, registry, host, quality })` →
  `load(skinId) / setPose / has() / skin() / height() / setSize(w,h) / setQuality(q) /
  setNight(v) / setLook(nx,ny) / pat() / orbit(dx,dy) / resetView() / lookAt(clientX,clientY) /
  tick(dt) / dispose() / stage / host`。
- **注意**：
  - `tick()` 里若宿主 `getBoundingClientRect()` 尺寸 < 2px（被收起/折叠）就跳过渲染省电；
  - `load()` 失败（角色模块坏了）返回 `false`，引擎会退回 2D 立绘；
  - `dispose()` 会清角色 + 释放 stage；**fx emitter 不归 pet3d 管**，见 1.7 与 engine2d 的释放顺序。

### 1.7 fx —— 3D 粒子特效层（`src/3d/fx.js`）

- **职责**：在角色身上撒一簇一簇的小特效（爱心/星星/音符/Z/水泡/惊吓爆点），
  自带对象池、数量上限与资源释放，不依赖引擎状态机。
- **接口**：

  ```js
  var FX = __req("fx").create(K, THREE);
  var emitter = FX.createEmitter(parent);   // parent: THREE.Object3D，一般传 stage.root
  emitter.burst(kind, opts);                // 立刻发射一簇，返回实际粒子数
  emitter.update(dt);                       // 每帧推进，自动回收
  emitter.clear();                          // 清屏（保留几何/贴图缓存）
  emitter.dispose();                        // 卸载（释放全部共享几何/贴图，摘掉特效组）
  emitter.count();                          // 当前粒子数（调试）
  emitter.stats();                          // 池/缓存/锚点快照（验收/调参）
  ```

- **kind**：`hearts / sparkles / notes / zzz / bubbles / shock`（内部另有 `bang`）。
- **opts**：`{ x, y, z, n, scale, spread, duration, color }`。
- **自动锚点**：不传坐标时，第一次 `burst` 量 `parent` 包围盒：
  `y = 包围盒顶部 - oy*H`，`x/z` 加 `ox/oz*H`，粒子尺寸按 `H/4.4` 缩放（H 是包围盒高度）。
  各 kind 的锚点比例、环形/放射发射方式都在 `KINDS` 表里；改视觉先改那张表。
- **资源模型**：
  - 每颗粒子 = 一个 Mesh/Sprite 壳（对象池复用）+ 一份**独立材质**（淡出就是 `material.opacity`）；
  - 几何/Canvas 贴图按 kind 缓存在 emitter 内，反复 burst 不新建；
  - 粒子死亡 → 出场景 + `material.dispose()`，壳进池；`dispose()` 再统一释放共享几何/贴图和池；
  - 同屏硬上限 `MAX = 72`，超出先回收最老的。
- **和 engine2d 的接线**（已实现）：`ensure3d()` 建完 pet3d 后
  `fx.create(K, THREE).createEmitter(pet3d.stage.root)`；主循环里 `fxEmitter.update(dt)`；
  `sleep` 每 1.4s `burst("zzz", {n:1})`，鲸鲸 `talk/happy` 时 `burst("bubbles", ...)`；
  聊天/拍一拍/升级等事件由 `playSfx` 同点位调用 `burst(...)`。
- **文档**：文件头注释有完整参数表和调参说明。

### 1.8 sfx —— WebAudio 合成音效层（`src/3d/sfx.js`）

- **职责**：无音频文件、实时合成短促可爱的音效；懒创建 AudioContext，出错静默降级。
- **接口**：

  ```js
  var SFX = __req("sfx").create();
  SFX.play(name);          // 'pat'|'pop'|'chime'|'levelup'|'error'|'wake'|'hide'|'show'|'nom'|'spin'
  SFX.setEnabled(on); SFX.isEnabled();
  SFX.setVolume(0..1); SFX.getVolume();
  SFX.names(); SFX.stats(); SFX.dispose();
  ```

- **音色设计**（详见文件头）：pat = A5→E6 上行两音；pop = 420→170Hz 正弦下滑；
  chime = C6/G6 泛音铃；levelup = C5-E5-G5-C6 琶音；error = G4→C4 下行方波；
  wake = 330→990Hz 上扬 + 揉弦；hide = 700→220Hz 下滑；show = 440→880Hz 上扬；
  nom = 两声低通三角"吧唧"；spin = 200→1200Hz 锯齿扫频。
- **资源模型**：每次播放创建若干 `Oscillator/Gain/（可选）BiquadFilter`，`stop()` 后
  `onended` 里逐个 `disconnect()`；主 Gain 即全局音量（默认 0.35）。
- **浏览器策略**：`AudioContext` 第一次 `play()` 才创建并尝试 `resume()`；
  处于用户手势链之外时可能保持 `suspended`，但**绝不抛异常**、不阻塞页面；
  `dispose()` 关掉 context，之后 `play()` 返回 `false`。
- **配置归属**：音效开关/音量由 `engine2d` 的 `S.sound` / 设置面板负责持久化，
  sfx 模块本身不读写 localStorage、不读用户配置。

### 1.9 宿主/引擎层（`src/client/engine2d.js`，3D 部分）

虽然不在 `src/3d`，但改 3D 前必须知道它怎么用 3D：

- `S.dim`（默认 `"3d"`）决定用 3D 还是 2D；`ensure3d()` 懒建 `kit/fig/registry/pet3d/fx`，
  失败就 `console.warn` 并回退 2D。
- 2D/3D 统一 renderer 契约：`renderer.setPose(name)` + `renderer.tick(dt, t)`。
- 交互事件 → 3D/音效/粒子：
  
  | 事件 | sfx | fx |
  | --- | --- | --- |
  | 收到回复 | `chime` | `notes` ×4（含关键词时 `sparkles` ×6） |
  | 请求失败 | `error` | — |
  | 好感升级 | `levelup` | `sparkles` ×10 |
  | 单击拍一拍 | `pat` | `hearts` ×5（另有 2D 飘心 DOM） |
  | 切到 3D / 切到 2D | `wake` / `pop` | — |
  | 右键菜单→转视角 | `spin` | — |
  | 收起 / 展开 | `hide` / `show` | — |
  | 音效开关 | `pop` | — |
  | timeline：睡 / 鲸鲸说话 / 鲸鲸开心 | — | `zzz` / `bubbles` / `bubbles` |
  
- 释放顺序：`drop3d()` 先 `fxEmitter.dispose()`，再 `pet3d.dispose()`（防止 fx 组挂在已销毁的 stage 上）。
- 3D 窗口尺寸在 `skins2d.js` 的 `size3d`：onee/genki 200×340、chibi 195×300、whale 215×285，
  用户可拖到 90~420。

### 1.10 构建层（`build.py`）

- 两个产物：
  1. `zero02-pet/lib/client.js` —— 插件单文件（three.js 内联 + 2D 引擎 + 3D 模块 + boot）；
  2. `lab/bundle.js` —— 实验室 bundle（`/vendor/three.global.js` 外部提供 THREE）。
- 模块机制：每个 `src/3d/*.js` 被包成
  `__def("<name>", function (module, exports, require) { ... })`，
  运行时 `__req("<name>")` 取 `module.exports`。文件里**直接写 CommonJS**：
  `module.exports.create = function (...) {...}`，**不能 import/export**。
- `MODULES` 顺序 = 定义顺序（不代表实例化顺序，`__req` 是懒执行）：
  `kit, fig, fx, stage, chars.zerotwo, chars.zerotwo-tall, chars.whale, sfx, registry, pet3d`。
  **新增模块必须加进 `MODULES`，新增角色还要加进 `registry.MODULES`**，两处都改。
- `build.py` 会 `node --check` 两个产物做语法检查；改完 src 必须重跑，不要手改产物。
- lab 入口 `src/lab/boot-lab.js` 被拼在 bundle 尾部（`window.__LAB_START`），
  lab 页面是 `lab/index.html` / `lab/test.html` / `lab/fx-test.html`。

---

## 2. 一帧是怎么跑的

```
engine2d.loop(now)
  dt = clamp((now-last)/1000, 0, 0.05)
  renderer.tick(dt, now/1000)          // renderer 可能是 pet3d 或 2D 渲染器
    └─ pet3d.tick(dt)
        ├─ host 尺寸 <2px ? return   // 收起时省电
        ├─ char.update(dt, t)        // 呼吸/眨眼/rig/表情
        ├─ stage.tick(dt)            // 相机弹簧
        └─ stage.render()            // WebGL 绘制
  fxEmitter.update(dt)                 // 粒子推进 + 回收
  fxTimer 每 1.4s → burst("zzz"/"bubbles")   // timeline 小特效
```

动画时间 `t` 由引擎累加传入；所有 springer（`K.springer`）内部对 `dt` 有上限，
但角色层仍应假定 `dt ∈ (0, 0.05]`。

---

## 3. 坐标、比例与尺寸约定

### 3.1 坐标系

- **脚底 y = 0**，向上 **+Y**。角色根节点不要自己 y 偏移；pet3d 直接加到 `stage.root`。
- **面朝 +Z**：脸、眼睛、刘海在 +Z；后发、屁股、尾巴在 -Z。
- **+X 是屏幕右侧**（相机默认在 +Z 看原点，`azimuth=0`）。
  注意 `FIG.arm / FIG.leg` 里 **`side:"L"` 是 `+X` → 渲染在屏幕右侧**；
  `side:"R"` 是 `-X` → 屏幕左侧，也是角色自己的右手（角色面朝 +Z）。
  `fig.js` 里那句「L 是屏幕左边」的注释与实际相反，以坐标为准，写姿势时别被带偏。
- 相机：`azimuth` 方位角（0=正面，±1.35 上限），`elevation` 俯仰（默认 0.09，范围 -0.05~0.55），
  `dist` 由 `stage.frame()` 算；`targetY` 默认 `height*0.52`。

### 3.2 尺寸基线

| 角色 | 头半径 R | 世界高度 | 头身比 | `meta.camera.height` |
| --- | --- | --- | --- | --- |
| chibi（Q版） | ≈1.0 | 4.42 | ≈2.2 | 4.95 |
| onee（御姐） | 0.80 | 6.40 | ≈4.0 | 6.40 |
| genki（元气） | 0.80 | 6.20 | ≈3.9 | 6.20 |
| whale（鲸鲸） | 0.82 | 3.60 | ≈2.2 | 3.60 |

- `meta.height` 是**角色本体高度**；`camera.height` 是**取景高度**（可以略大于身高，给呆毛/角留余量）。
- `stage.frame` 里：
  `dist = height / (2·tan(fov/2)) · margin · distK`，`targetY` 默认 `height*0.52`；
  竖长窗口 `aspect<0.85` 时 `setSize` 再乘 `1+(0.85-aspect)*0.55`。
- **世界单位 ↔ 像素**（调特效/描边尺寸用）：窗口里角色实际占高约 `画布高 / (margin·竖窗系数)`；
  chibi 在 195×300 窗口约 `51px / 世界单位`，在 900×700 的大窗口约 `130px / 世界单位`。
  所以"20px 的爱心"在 `size≈0.38` 左右，描边厚度 `0.008` 在 195 窗口约 0.4px（会糊），
  这也是为什么小窗口要把描边厚度按角色尺寸放大（见 4.3）。
- 3D 窗口真实尺寸见 `skins2d.js` 的 `size3d`：**195×300 / 200×340 / 215×285**，
  用户可拖大小 90~420px，所以特效/描边都要按比例缩放，不能写死像素。

### 3.3 fx 的坐标与锚点

- fx 粒子是 `parent` 的**局部坐标**；engine2d 传的是 `stage.root`（角色脚底原点），
  所以锚点可以用包围盒高度比例描述。
- 自动锚点（不带 x/y/z 时）：`anchorH = 包围盒高度`，
  `unit = clamp(anchorH/4.4, 0.6, 1.5)`，各 kind 的 `oy/ox/oz` 是 `anchorH` 的比例：
  - `hearts`：约 0.78~0.80 高度（脸/下巴），围脸一圈向上飘；
  - `notes`：约 0.86 高度（额前/发梢），脸前偏右；
  - `zzz`：头顶偏右上方，慢慢往右上飘；
  - `bubbles`：0.30 高度左右（胸/腰），上升到胸口；
  - `sparkles/shock`：头部轮廓外圈向外炸。
- 小窗安全线：相机只给包围盒顶部留约 5~10% 余量，**特效超过"包围盒顶部 + 0.09H"就会被画布上沿裁掉**。
  改特效高度时先用 195×300 小窗截图确认（`lab/fx-test.html?mode=small`）。
- 显式坐标：`burst("notes", { x:0, y:3.6, z:0.5 })` 是 `parent` 局部坐标，传了就不再自动锚定。

### 3.4 光照与昼夜

- `K.shared.uLight`（主光方向，默认 (0.45,0.82,0.62) 归一化）、`uLight2`（补光）、`uNight`（0~1）。
- `stage.setNight(v)` → `K.setNight(v)`；`stage.setLight(x,y,z)` → `K.setLightDir`。
- engine2d 会按本地时间算 `night`（0：白天，0.55：深夜）并每帧传给 pet3d。
- 所有 `K.cel` 材质自动生效，**新角色不需要自己处理昼夜**。

---

## 4. 卡通材质与描边原理

### 4.1 两段式卡通风（`K.cel`）

`K.cel` 是一个自定义 `ShaderMaterial`，不是 PBR。片元着色器大致做：

1. `ndl = dot(N, L)`，用 `smoothstep(-0.10, 0.34, ndl)` 把光照切成"暗面→亮面"两段；
2. 暗面颜色 = `uShade`，亮面 = `uBase`，`uLift` 控制暗面抬亮（皮肤用大 lift，让脸不脏）；
3. `uHi` 高光带 + 背光补色（`uLight2`）+ 边缘光 `uRim` + 可选高光 `uSpec`；
4. `uNight` 把颜色向冷蓝压暗；
5. `#include <colorspace_fragment>` 保证输出到 SRGB 色彩空间正确。

**关键点**：

- **不要给 3D 手办用 MeshPhongMaterial/MeshStandardMaterial**：小窗口里 PBR 会又灰又糊，
  而且四套角色风格不统一。要新质感就扩展 `K.cel` 的 uniform。
- 所有角色材质**共享** `K.shared` 的 uniform 对象（`uLight/uLight2/uNight` 引用同一个 `{value}`），
  所以切昼夜只改一次，不需要遍历场景。
- 默认 `FrontSide`；需要双面（薄片、飘带）显式传 `side: THREE.DoubleSide`，但会增加填充率。

### 4.2 贴片（`K.decal` / `FIG.patchMesh`）

- 五官、腮红、衣服印花这类"画上去"的东西不用几何，用 **贴图贴片**：
  `FIG.patch(R, dir, w, h, out)` 把 `PlaneGeometry` 的每个顶点归一化到球面半径 `R+out` 上，
  `FIG.patchMesh` 再配 `K.decal` 材质（`MeshBasicMaterial`，不吃光，颜色最准）。
- `out` 默认 0.002，一般给 0.002~0.006，防止和皮肤 z-fighting。
- 贴片需要 `renderOrder` 排序（腮红 2 < 眼 3 < 嘴 4），`depthWrite:false`，并 `userData.noOutline = true`。
- **不要**直接用 `PlaneGeometry` 当五官——会浮在脸外面/穿模，五官必须用 patch 贴球面。

### 4.3 反壳描边（`K.outline`）

- 原理：复制一份几何体，用 `BackSide` + 顶点沿法线外扩 `uT` 的 ShaderMaterial 渲染，
  在模型外面形成一圈墨线。
- 实现：`K.outline(mesh, { thickness, color, opacity })` 会创建一个子 Mesh（`mesh.add(outline)`），
  所以描边**跟着父 Mesh 的动画一起动**，不需要每帧更新。
- 厚度是**世界单位**：chibi 躯干 `0.0085`、头 `R*0.012`、四肢 `r*0.12~0.13`；
  高个角色用更大的绝对值。小窗口下要保证约 0.5~1px 以上，否则会糊成灰边。
- 透明/贴片不要描边：`userData.noOutline = true` 或 `K.outlineAll`（会自动跳过）；
  给整棵树加描边后再单独处理例外。
- `outline.raycast = noop`，描边不会干扰鼠标拾取（宿主本来也没用 raycast）。
- `K.dispose` 会遍历到 outline 子节点，它和父节点共用 `geometry`，会 dispose 两次——
  three 的 `dispose()` 是幂等的，无害，但要知道这件事。

---

## 5. 如何新增一个角色

以 `chars.mychar` → 皮肤 id `mychar` 为例。

### 5.1 步骤

1. **建文件** `src/3d/chars/mychar.js`，照下面的骨架写（模块格式必须一致）：

   ```js
   /**
    * chars.mychar —— 我的角色（一句话形象说明）
    * 只依赖注入的 K / FIG / THREE。
    */
   module.exports.create = function (K, FIG, THREE) {
     var PI = Math.PI, TAU = PI * 2;

     var PRESET = {
       height: 5.0,
       camera: { height: 5.0, targetY: 2.6, margin: 1.06, elevation: 0.07, glowColor: 0xffaa88 },
       colors: { skin: 0xffe0cc, hair: 0x8a6ad8, outline: 0x2a1f3a },
       eye: { iris: ["#4a2f7a", "#8e6ad8", "#d0b8ff"], lash: "#2a1f3a", round: 0.8 },
     };

     function build(P) {
       var root = new THREE.Group();      // 脚底 y=0，面朝 +Z
       var C = P.colors;
       var matSkin = K.cel({ color: C.skin, shade: K.shadeOf(C.skin, 0.8), lift: 0.7 });
       var matHair = K.cel({ color: C.hair, shade: K.shadeOf(C.hair, 0.6), spec: 0.06 });

       // ... 用 K.capsule / K.lathe / FRibbon / FIG.head / FIG.hairCap / FIG.arm / FIG.leg 拼 ...

       var headGroup = K.group(root, [0, P.height - 1.3, 0]);
       var head = FIG.head({ R: 1.0, skin: C.skin, eye: P.eye, blush: true });
       headGroup.add(head.group);

       var rig = FIG.rig();
       rig.add("head", headGroup, { k: 150, d: 17 });
       // ... rig.add 每个关节 ...

       var char = {
         root: root,
         height: P.height,
         camera: P.camera,
         stateName: function () { return state; },
         setState: function (name) { /* 切姿势 + 表情 */ },
         setLook: function (nx, ny) { /* 视线 */ },
         pat: function () { /* 被拍反馈，可选 */ },
         update: function (dt, t) { /* 呼吸/眨眼/rig */ },
         dispose: function () { K.dispose(root); },
       };
       return char;
     }

     return {
       variants: {
         mychar: {
           meta: { id: "mychar", label: "我的角色", height: PRESET.height, camera: PRESET.camera },
           build: function () { return build(PRESET); },
         },
       },
     };
   };
   ```

2. **登记模块**：
   - `build.py` 的 `MODULES` 加 `("chars.mychar", "src/3d/chars/mychar.js"),`
   - `src/3d/registry.js` 的 `MODULES` 数组加 `"chars.mychar"`
3. **对齐皮肤 id**：`meta.id` 必须等于 `src/client/skins2d.js` 里的皮肤 id，
   否则 `registry.get(skinId)` 拿不到、引擎一直用 2D。
4. **在 lab 里看**：`python3 build.py` → `/lab/?char=mychar&mode=single`、`?mode=sheet` 多视角截图；
   再用真实窗口尺寸截图（195×300 起）确认头和脚没被裁。
5. **接进插件**：`engine2d.ensure3d()` 会自动按 registry 的 map 找角色，不用改；
   如果角色需要自定义 3D 窗口尺寸，在 `skins2d.js` 对应皮肤的 `size3d` 里配。

### 5.2 契约检查清单

- [ ] 根节点在脚底 `y=0`，面朝 `+Z`，没有全局偏移/缩放残留
- [ ] 所有不透明部件有 `K.outline`；贴片/花纹 `noOutline` 且用 `FIG.patchMesh`
- [ ] 头/身体/四肢比例是"头半径 → 身高"推出来的，不靠手动魔数硬拼
- [ ] `setState` 覆盖全部 8 个状态名，未知名字退回 `idle`
- [ ] `update(dt,t)` 里没有每帧 new 材质/几何（动画只改 transform / uniform）
- [ ] `dispose()` 释放自己额外创建的贴图/材质后再 `K.dispose(root)`
- [ ] `meta.camera` 能框住全身（`margin≥1.05`），195×300 竖窗不裁头
- [ ] `stage.root` 里只有一个 root，不重复 add
- [ ] `python3 build.py` 通过；lab 单图/多视角都正常；2D 回退不受影响

### 5.3 角色内部推荐结构

```
build(P)
  ├─ 材质表（matSkin/matHair/matCoat/... 全部 K.cel）
  ├─ body（重心组：呼吸/整体位移）
  │   ├─ torso（衣服/领子/扣子/腰带，细节用 coatR(y)+frontZ(y) 贴表面）
  │   ├─ legs（髋→膝→踝，胶囊 + 靴子）
  │   ├─ arms（肩→肘→腕，胶囊 + 手）
  │   └─ headGroup（头、五官 patch、hairGroup/hairBack）
  ├─ FIG.rig() 注册命名关节
  ├─ POSES 表（8 个状态 → rig.pose 目标）
  └─ char 对象（state/look/pat/update/dispose）
```

---

## 6. 常见坑（按踩坑频率排序）

### 6.1 车削（lathe）的顶点顺序与端盖

- `K.lathe(profile, seg)` 的 `profile = [[r,y], ...]` **必须从下往 y 递增地给**。
  给反了（或 y 不单调）→ 生成的三角面绕向翻转，从外面看是黑的/直接消失（背面剔除）。
- `LatheGeometry` **不封端盖**：裙底/衣摆要自己补 `CircleGeometry`（参考 `zerotwo.js` 的 `cap`）
  或再加一圈 `ring` 收边；否则从下往上看会穿帮。
- 半径不能为 0 或负数：`kit.lathe` 会 clamp 到 `1e-5`，结果是尖点，看起来像破洞。
  需要封闭顶端时在 profile 末尾给 `[0.0001, y]` 并接受一个极细尖，或单独补盖。
- `phiStart/phiLen` 可以只削一段弧（半裙、披风）；但只削一段时侧边是开口的，
  要么补面，要么用双面材质兜底。
- 不要用负 scale 镜像角色（会翻转三角形绕向 → 描边/光照全乱）；左右对称就复制部件改参数。

### 6.2 strand / ribbon 的绕向与参考系

- `K.strand`（发丝/触角）和 `K.ribbon`（发片/布条）内部是固定三角索引顺序
  （`a, b, a+1, b, b+1, a+1`）。在某些曲线走向下**法线会朝内**，看起来像"黑条/透光"。
  `whale.js` 顶部注释里明确提到这个坑，并在角色文件内用 `flipWinding()` 本地修正，
  **没有改 kit**（改 kit 会同时影响四套角色）。
- `K.strand` 用 Frenet 帧：**点位不能共线**（至少 3 个不共线的点，曲线要有弯），
  否则法线/副法线退化，发丝会扭成麻花或塌成一根线。
- `K.ribbon` 的 `ref` 是"宽面朝哪边"的参考方向，**不能与曲线切线平行**：
  平行时宽度方向退化，发片会消失。参考：侧发 `ref:[cosφ,0,-sinφ]`（径向朝外），
  发带 `ref:[0,1,0]`（横向一圈）。
- `widths` 最后一个尽量接近 0（发梢收尖）；`flat` 控制扁平度（0.5~0.85）；
  `tension` 太大容易过冲打结。
- 头发高光/发带要"浮在发壳外"：半径比发壳大 0.004~0.01，否则会闪 z-fighting。
- 验证绕向的土办法：临时把材质换成 `side: THREE.BackSide` 看是不是"正面"，或加 `DoubleSide` 排查。

### 6.3 贴片（五官/花纹）必须用 patch

- 直接用 `PlaneGeometry` 贴到球面上 = 穿模/浮空/边缘折断。用 `FIG.patch / FIG.patchMesh`。
- `dir` 会归一化，`w/h` 是**弧长**（世界单位），不是像素；`out` 2~6‰ 防 z-fighting。
- UV 与 Plane 一致（左下 0,0）；贴图要由 canvas 生成时注意 y 轴方向。
- `renderOrder` 决定五官叠放：腮红 2、眼 3、嘴/鼻 4；
  `depthWrite:false` + `alphaTest` 让透明边缘不打架。
- 贴片别加描边（`userData.noOutline = true`），否则会得到一圈黑边。

### 6.4 衣服细节必须"贴表面"

- 扣子、腰带、领带、印花、飘带**不能写死 z 坐标**，要在对应 y 处查衣服表面半径：
  - `zerotwo.js` 的模板：`prof` + `coatR(y)` + `frontZ(y)`；
  - 用 `K.ring` 做腰带时把半径设成 `coatR(y)+0.02`，并 `scale` 压扁；
  - 用 `K.ribbon` 沿表面生成飘带（点列用 `sqrt(r²-x²)` 算 z）。
- 固定 z 的后果：角色换姿势/呼吸缩放后扣子陷进衣服或浮在空中。
- 领口/袖口这类圆环：`rotation.x = PI/2`，位置按肩/脖高度给，半径略大于皮肤。

### 6.5 换五官/表情时的贴图泄漏

- `FIG.head` 的 `setMood / setMouth` 每次调用都会 **重新生成 CanvasTexture**
  （`K.eyeTexture` 两张 512² + 嘴 256²）。不 dispose 旧 `material.map` 就会持续涨内存。
  - `zerotwo.js` 目前直接替换 map（依赖 GC/浏览器回收显存慢，长会话会涨）；
  - `zerotwo-tall.js` 的 `eyeCache` 做了 dispose 旧贴图，是推荐写法。
  新角色/改表情系统时参考后者。
- `face.look(nx,ny)` 每帧都会 `geometry.dispose()` + 新建 `FIG.patch(...)`：
  功能正确但 GC 压力大。高频跟随可以加阈值（角度变化 > 0.01 才重建）或缓存几档。
- 贴图切换后 `material.needsUpdate = true`；共享贴图（例如多个角色共用一张高光图）
  要 `map.userData.keep = true` 或引用计数，别让 `K.dispose` 把别人还在用的图释放了。

### 6.6 相机 / 尺寸

- **顺序**：角色 `root` 加进 `stage.root` → `stage.frame(meta.camera)` → `stage.setSize(w,h)`。
  先 `setSize` 再换角色会让相机按旧身高取景。
- `frame()` 的 `height` 用 `meta.camera.height`（不是 `char.height`），它决定 dist 和阴影/光晕尺寸。
- `setSize` 会在竖长窗口自动拉远相机；不要自己再乘一遍。
- 切换角色时先 `stage.root.remove(char.root)` + `char.dispose()`，再建新的，避免旧角色留在场景里。
- `pet3d.tick` 里 host 尺寸 <2px 会跳过渲染（窗口收起时省电），别在这时候做资源重建。

### 6.7 粒子（fx）相关

- 粒子挂在 `stage.root` 而不是 `char.root` 上是有意的：`pat()` 会给 `char.root` 加挤压动画，
  挂在角色上粒子会一起被压扁。换挂载点时想清楚这一点。
- 自动锚点只在第一次 burst 时量包围盒；如果 emitter 建得比角色加载还早（engine2d 顺序如此，
  但第一次 burst 一定在角色加载之后），量到空盒子会自动在下次重试，不用手动处理。
- 改特效位置先改 `KINDS` 表里的 `oy/ox/oz/ringR/spread`，不要改 `spawnOne` 里的通用逻辑。
- 小窗口安全线见 3.3：超过包围盒顶部 + ~0.09H 会被裁。
- 不要为了"更华丽"把上限 `MAX` 盲目调大：72 个粒子 = 72 个 draw call，
  在低画质（dpr=1）的小窗里已经够满；要更密请改纹理/几何而不是堆数量。
- 粒子材质是**每颗独立**的（为了独立淡出），死亡时必须 dispose；
  共享几何/贴图只在 `emitter.dispose()` 释放，`clear()` 不要释放缓存。

### 6.8 音频（sfx）相关

- `AudioContext` 必须懒创建：模块加载/`create()` 时不要 new。`play()` 里创建并尝试 `resume()`。
- 首次播放如果不在用户手势里，浏览器可能让 context 保持 `suspended`；
  不要在此时抛错或反复 `resume()` 打日志——等下一次用户手势后自然恢复。
- 每个音结束后要 `disconnect()`，否则节点泄漏；本实现用 `onended` 统一断开。
- 静音时不要 suspend/close context 再重开（部分浏览器 `close` 后不可复用）；
  音效开关只把主 Gain 拉到 0，`dispose()` 才真正 close。
- 不要在 sfx 里读 `localStorage` —— 配置归属 `engine2d` 的 `S.sound`。

### 6.9 模块与构建

- 文件里**不能有 import/export**；必须 `module.exports.create = ...`。
- `require(...)` 只能在 `create()` 内部调用（模块是懒执行的，`__def` 阶段不能 `__req`）。
- 模块名必须与 `build.py MODULES` 的 key 一致；角色模块还要加进 `registry.MODULES`。
- `lab/bundle.js` 是 IIFE，**外部拿不到 `__req`**：想在 lab 页面里单独调模块，
  要么用 `lab/index.html`（`window.__LAB_START`），要么像 `lab/fx-test.html` 那样
  `fetch("/src/3d/xxx.js")` 后用 `new Function(module, exports, require)` 装一个 10 行 loader，
  不要复制实现。
- 改完 `src/` 必须 `python3 build.py`；产物 `zero02-pet/lib/client.js`、`lab/bundle.js` 不要手改。
- `build.py` 用 `node --check` 检查产物语法；单文件也可用
  `node -e "new Function(require('fs').readFileSync('src/3d/fx.js','utf8'))"` 先查语法。

### 6.10 其他

- `kit.js` 是四套角色共用的底层，**不要为了一个角色改 kit 的默认行为**；
  局部特例放角色文件里（`whale.js` 的 flipWinding 就是范例）。
- 角色根节点不要 `scale` 到 0 或负数；`pat()` 的挤压是 `char.root.scale`，动画结束要复位。
- `stage.dispose()` 会 dispose 场景里的几何/材质；先 `char.dispose()` 再 `stage.dispose()`，
  重复 dispose 无害但顺序错会让角色资源多留一份。
- `fig.js` 的 `// L 是屏幕左边（角色右手）` 注释写反了（`L` 是 `+X`，即屏幕右侧）；
  写姿势/镜像部件时以 3.1 节为准。
- `docs/` 里没有图片依赖，截图都在 `shots/`（生成物，不提交也可）。
- registry 的 `TEMP-TEST` 别忘删（见 1.4）。

---

## 7. 调参与验收工具

| 工具 | 用途 |
| --- | --- |
| `python3 build.py` | 生成插件 + lab bundle，并做语法检查 |
| `python3 tools/serve.py` | 本地开发服务器（`http://127.0.0.1:8899`），伺候 `/lab /vendor /src /shots` |
| `/lab/?char=chibi&mode=single&state=idle` | 单角色单视角 |
| `/lab/?char=chibi&mode=sheet` | 正面/3/4/侧/背/近景五连图 |
| `/lab/fx-test.html?kind=hearts` | fx 真实源码验收（自动锚点、195×300、池上限/泄漏压力测试） |
| `/lab/fx-test.html?mode=small&kind=hearts` | 模拟桌宠真实尺寸（配合 `--size 195x300`） |
| `/lab/fx-test.html?mode=sfx` | WebAudio 冒烟：10 个音全部调度、AudioContext 状态、dispose 后行为 |
| `tools/shot.mjs --url ... --out ... --size 195x300 --wait 1200 --ready "window.__FX_READY" --info "..."` | headless Chrome 截图 + 页面内状态回读 |

调 fx 的推荐流程：改 `KINDS` → `python3 build.py` → `lab/fx-test.html?mode=small&kind=xxx`
用 195×300 截图看裁切/大小 → 需要的话再看大图看形体。

调 sfx 的推荐流程：改 `SOUNDS` → 语法检查 → `?mode=sfx` 看 `window.__SFX_TEST` 的
`played/stats` → 真机听感（headless 只能验证不报错和状态，音色必须人耳听）。

---

## 8. 快速 API 参考

### kit（`K`）

```js
K.cel({ color, shade, hi, rim, rimStr, rimPow, spec, specPow, hiStr, emissive,
        opacity, side, lift, shadeAmt, tint, transparent })
K.decal(tex, { opacity, side, alphaTest })
K.outline(mesh, { thickness, color, opacity })      // 返回 mesh
K.outlineAll(obj, opts)
K.sphere(r, sx, sy, sz, seg) · K.capsule(r, len, seg) · K.lathe(profile, seg, phiStart, phiLen)
K.ring(r, tube, arc, seg) · K.plane(w,h) · K.box(w,h,d) · K.cylinder(rt,rb,h,seg,open)
K.tube(points, radius, seg, radial, closed)
K.strand({ pts, radii, flat, seg, radial, twist, tension })
K.ribbon({ pts, widths, thick, ref, seg, radial, tension })
K.heartShape(s) · K.heart(s, depth) · K.starShape(s, points, inner) · K.star(s, depth) · K.drop(r)
K.canvas(w,h) · K.tex(canvas) · K.canvasTex(size, draw) · K.canvasTexWH(w,h,draw)
K.radialTex(stops, size) · K.shadowTex()
K.springer(initial, {k,d,eps})  → { value, target, set/jump/update }
K.clamp/lerp/smooth/easeOut/easeInOut/easeBack/rand/pick
K.mesh(geo,mat,parent,pos) · K.group(parent,pos) · K.flat(mesh) · K.dispose(obj)
K.shared · K.setLightDir(x,y,z) · K.setNight(v)
```

### fig（`FIG`）

```js
FIG.patch(R, dir, w, h, out) · FIG.patchMesh(R, dir, w, h, tex, opts)
FIG.eyeTexture({ mood, mirror, iris, lash, brow, sclera, round, high })
FIG.mouthTexture({ kind, lip, inner }) · FIG.blushTexture(color) · FIG.hairShineTexture(color)
FIG.head({ R, skin, skinShade, eye, mouth, blush, faceY, eyeX, eyeY, eyeW, eyeH,
           mouthY, jaw, outline, scale }) → { group, face, mesh, R }
FIG.hairCap(R, { scale, thetaFront, thetaBack })
FIG.clump({ pts, radii, mat, flat, seg, radial, twist })
FIG.joint(parent, pos) · FIG.arm({...}) · FIG.leg({...})
FIG.flare({ profile, mat, seg, parent, ... }) · FIG.frill({...})
FIG.rig() → { add(name,obj,cfg), pose(map), poseOne, snap, motion(name,x,y,z), resetMotion, update(dt) }
```

### stage

```js
var stage = __req("stage").create({ THREE, K, host, quality });
stage.root / stage.scene / stage.camera / stage.renderer / stage.state / stage.host
stage.frame({ height, targetY, margin, distK, elevation, azimuth, glowColor })
stage.setSize(w,h) · stage.setGlow(hex) · stage.setOrbit(az,el) · stage.hard(az,el,dist,targetY)
stage.getOrbit() · stage.setQuality(q) · stage.setNight(v) · stage.setLight(x,y,z)
stage.tick(dt) · stage.render() · stage.snapshot() · stage.dispose()
```

### pet3d

```js
var pet = __req("pet3d").create({ THREE, K, FIG, registry, host, quality });
pet.load(skinId) → bool · pet.setPose(name) · pet.tick(dt) · pet.setSize(w,h)
pet.setQuality(q) · pet.setNight(v) · pet.setLook(nx,ny) · pet.pat()
pet.orbit(dx,dy) · pet.resetView() · pet.lookAt(clientX, clientY)
pet.has() · pet.skin() · pet.height() · pet.dispose() · pet.stage
```

### fx

```js
var FX = __req("fx").create(K, THREE);
var e = FX.createEmitter(parentObject3D);
e.burst("hearts"|"sparkles"|"notes"|"zzz"|"bubbles"|"shock",
        { x, y, z, n, scale, spread, duration, color }) → 粒子数
e.update(dt) · e.clear() · e.dispose() · e.count() · e.stats()
```

### sfx

```js
var SFX = __req("sfx").create();
SFX.play("pat"|"pop"|"chime"|"levelup"|"error"|"wake"|"hide"|"show"|"nom"|"spin")
SFX.setEnabled(on) · SFX.isEnabled() · SFX.setVolume(0..1) · SFX.getVolume()
SFX.names() · SFX.stats() · SFX.dispose()
```

---

## 9. 已知遗留 / 后续可做

- `registry.js` 里的 `TEMP-TEST` 别名（onee/genki → chibi）需在发版前移除。
- `fig.head` 的 `setMood/setMouth` 每次重建贴图、`face.look` 每帧重建几何：
  长会话下建议加贴图缓存/阈值节流（参考 `zerotwo-tall.js` 的 `eyeCache`）。
- `kit.strand/ribbon` 的绕向问题靠各角色文件自己修（`flipWinding`）；
  如果未来统一修 kit，要回归四套角色的头发/飘带，不能只改一处。
- `fx` 的调参目前靠改 `KINDS` 表 + 截图；如果特效种类继续增加，
  可以考虑把参数外置成数据文件（仍要遵守 `module.exports.create` 的模块格式）。
- `sfx` 的听感需要真机人耳验收；headless 只能验证"不抛错、节点会回收、状态正确"。
- `shots/` 里的验收图是生成物，仓库里可保留最新几张方便 review，历史图按需清理。
