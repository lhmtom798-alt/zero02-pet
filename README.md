# zero02-pet · 02 桌宠

> 一只住在 DeepSeek Harness（DSH）右下角的 02：会呼吸、会看着你、会记得你、会写日记、会吃醋。
> 四个形象：**02·御姐 / 02·元气 / 02·Q版 / 鲸鲸（大肥鱼）**，支持 2D 立绘与 3D 实时渲染。
> 当前版本：**4.81.0**

## 这是什么

一个挂在 DSH Web 界面右下角的悬浮桌宠插件。不占面板、不改界面结构，只在你屏幕角落放一只会动的 02。

- **形象**：御姐 / 元气（白贝雷帽）/ Q版（大头）/ 鲸鲸，随时切换
- **形态**：2D 立绘（省资源，带呼吸/浮动动画）与 **3D** 实时 WebGL（可转视角、视线跟随、头发/裙摆物理、说话口型）
- **双 3D 模型**（设置里可切）：
  - **经典 TDA 军装 02**（默认）：绯红军装 + 白领橙领带 + 金饰边 + 黑丝 + 白靴
  - **游戏风 Darling 02**（实验）：脸/贴图更精细，红裙 + 白鞋
- **真的会聊天**：DeepSeek 云端（走宿主已配置的端点）或本地 Ollama 降级
- **真的有人格**：02 的语气、毒舌、占有欲、非人类的不安；长期记忆 + 共同记忆 + 日记 + 心情 + 好感度关系阶段

## 交互

| 操作 | 效果 |
| --- | --- |
| 单击 | 拍一拍：跳一下 + 爱心粒子 + 02 式台词 + 好感度 |
| 悬停 | 头顶浮出快捷按钮：💬 聊天 / 🤚 摸摸 / 🍬 投喂 |
| 双击 | 按设置执行：转圈 / 换视角 / 聊天 / 设置 / 收起 |
| 右键单击 | 快捷菜单（聊天 / 拍照 / 摸摸 / 投喂 / 切 2D-3D / 玩法 / 设置 / 收起） |
| 左键拖动 | 移动位置（自动吸附屏幕内） |
| 右键拖动（3D） | 旋转视角，松手后慢慢回正 |
| 滚轮（3D） | 缩放桌宠大小 |
| 拖右下角 | 自由缩放窗口；设置里另有小/中/大预设 |

快捷键：`Alt+Shift+H` 收起/召回、`Alt+Shift+D` 切 2D/3D、`Alt+Shift+1~4` 换形象。

## 她的「灵魂」里有什么

| 层 | 内容 |
| --- | --- |
| 人格 | 02 的身份设定 + 22 组 few-shot + 负面清单 + 关系阶段语气 + 11 种心情 |
| 台词库 | 184 句专属台词（selfTalk / possessive / tease / soft / comfort / food / sleepy / jealous / proud / curious / guilt / deep / names） |
| 记忆（11 层） | 事实 / 心里话 / 认识天数 / 共同经历 / 昨日情绪 / 日记 / 周记 / 最近话题 / 约定 / 夸奖 / 生日与纪念日 |
| 日常 | 每日心情（影响行为）、今日小结、LLM 日记（跨天）、LLM 周记、节日台词、连续天数、时段感 |
| 主动性 | 主动开口（心情影响频率）、小请求、记忆回访、接话题追问、「今天在想的事」、久别模型开场白 |
| 关系 | 好感 Lv1~8、关系阶段、升级心里话（Lv5 告白）、吃醋、称呼变体、习惯观察 |
| 声音 | 系统 TTS（默认关）：声线/语速/音调/预设；分句朗读、朗读范围、深夜轻声、口型同步（02 与鲸鲸） |

## 3D 渲染

- **three.js + MMDLoader**：TDA Zero Two PMX（骨架重建 322 骨）+ 程序化物理（头发弹簧 47 骨 / 裙摆 150 骨）
- **自定义赛璐璐着色**（`src/3d/mmd-shade.js`）：分层 toon ramp、边光、反向外壳描边（线宽按材质分级）、贴图分级
- **贴图增强**（`models/final/mmd-tex/`）：发丝 alpha 渐隐、脸部唇形/眉毛/刘海投影/眼影、虹膜高光
- **程序化发束**（`src/3d/mmd-hair.js`）：叠加蒙皮发片，跟随头发物理
- **运行时头型微调**（`char.sculptFace`）：脸宽 / 纵向 / 下巴 / 下颌，不动物理、不改 PMX
- **取景**：全身 / 半身 / 自动（小窗半身）；尺寸预设与自由缩放
- **画面风格**：动画滤镜（调色 + 柔光暗角）+ 心情色调

技术细节见 [`docs/3D-ARCHITECTURE.md`](docs/3D-ARCHITECTURE.md)、[`docs/02-SHADING.md`](docs/02-SHADING.md)、[`docs/02-TEXTURES.md`](docs/02-TEXTURES.md)、[`docs/02-HAIR-GEO.md`](docs/02-HAIR-GEO.md)。

## ⚠️ 素材要求（仓库不含版权素材）

本仓库**只有代码**。3D 模型、2D 立绘需要你自备并按目录放好，否则只能显示占位/2D 回退。

- 需要放什么、为什么不能随仓库分发：见 [`ASSETS.md`](ASSETS.md)
- 3D 模型目录：`models/final/*.pmx`、`models/final/whale.vrm`、`models/mmd/TDA-ZeroTwo/…`
- 2D 立绘目录：`_assets/*.webp`
- 没有素材也能 `python3 build.py`，打出的包只是没有 3D

## 从源码构建

```bash
python3 build.py                 # 生成 zero02-pet/lib/client.js + assets，打印版本
python3 tools/pack.py            # 打包 dist/zero02-pet-<version>.tgz（自用安装包）
```

安装：在 DSH 的插件管理里安装生成的 `.tgz`（或使用 `plugin_manager` 安装本地包）。

## 开发 / 测试

```bash
python3 tools/serve.py &         # 本地预览服务 http://127.0.0.1:8899/preview/
node tools/shot.mjs --url "…" --out shots/x.png --size 1200x1000   # 无头截图
node tools/smoke.mjs              # 基础冒烟 14 项（加载/交互/记忆/请求/晚安/模型切换/导出/TTS）
node tools/smoke.mjs --fast       # 只跑核心 2 组
node tools/soul-smoke.mjs         # 灵魂冒烟 16 项（话题/约定/夸奖/心情/时段/上限/周记/生日）
node tools/render-smoke.mjs       # 渲染冒烟 16 项（造型/发丝/姿势/表情/取景/皮肤切换/2D/鲸鲸/拍照）
```

说明见 [`docs/TESTING.md`](docs/TESTING.md)。测试依赖本机 Chrome 与 macOS 路径，其他平台需改 `tools/shot.mjs` 里的 Chrome 路径。

## 目录结构

```
src/client/     桌宠引擎、2D 立绘、人格、声音、台词库
src/3d/         kit / fig / stage / pet3d / fx / sfx / chars
                mmdchar(MMD 适配) / mmd-shade(赛璐璐着色) / mmd-hair(发束) / vrmchar(鲸鲸)
_pkg 入口       build.py（组装）、_host-template.js（DSH 客户端宿主）
tools/          构建/打包/测试/MMD 修复/贴图增强/截图/预览服务
models/         3D 模型（需自备，见 models/README.md）
_assets/        2D 立绘（需自备，见 _assets/README.md）
lab/            预览页面（模型 / 发丝 / 着色调试）
pkg/            插件描述 / 图标 / 中英文文案
docs/           技术文档（着色/贴图/动画/人格/声音/差距清单/测试/发布说明…）
vendor/         three.js + three-vrm（MIT）
```

## 文档索引

- [`docs/PROJECT-STATUS.md`](docs/PROJECT-STATUS.md) —— 项目现状总览 / 已知差距 / 需要用户参与的项
- [`docs/PUBLISH.md`](docs/PUBLISH.md) —— **发布到 GitHub 前必读**（哪些能传、哪些不能、检查清单）
- [`docs/02-FIDELITY-GAPS.md`](docs/02-FIDELITY-GAPS.md) —— 「和动画相差无异」完成度审计
- [`docs/02-PERSONA.md`](docs/02-PERSONA.md) / [`docs/02-PERSONA-EXTRA.md`](docs/02-PERSONA-EXTRA.md) —— 人格与台词库
- [`docs/02-SOUL.md`](docs/02-SOUL.md) —— 记忆 / 日常感 / 好感度系统
- [`docs/02-VOICE.md`](docs/02-VOICE.md) —— TTS 设计与调参
- [`docs/TESTING.md`](docs/TESTING.md) —— 三套自动化验收
- [`CHANGELOG.md`](CHANGELOG.md) —— 逐版本改动

## 许可 / 素材 / 免责

- **代码 MIT**（见 [`LICENSE`](LICENSE)）。
- **素材不随仓库分发**：TDA Zero Two / Darling02 为同人模型，版权归《DARLING in the FRANXX》权利方，**仅限个人使用、禁止再分发/商用**；鲸鲸 VRM 作者木子恶魔，个人非商用；2D 立绘版权归原画作者。
- 本项目仅用于个人学习与技术研究，与作品权利方无关；请勿将含素材的安装包公开分发。
