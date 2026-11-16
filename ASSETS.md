# 素材说明（重要）

本仓库**只包含代码**，不包含任何第三方版权素材。要让 2D/3D 形象正常显示，需要自备素材并按下面的目录放好。

## 1. 3D 模型（`models/`，需自备）

| 路径 | 用途 | 授权 |
| --- | --- | --- |
| `models/final/ZeroTwo_TDA.pmx` | 经典 TDA 军装 02（PMX） | 同人模型，**仅限个人使用，禁止再分发** |
| `models/mmd/TDA-ZeroTwo/` | 上述模型的贴图目录（`tex/ toon/ sph/ tga/ *.png/*.bmp/*.tga`） | 同上 |
| `models/final/Darling02_fixed.pmx`（可选） | 游戏风 Darling 02 | 同上 |
| `models/mmd/Darling02/tex/`（可选） | Darling 贴图 | 同上 |
| `models/final/whale.vrm` | 鲸鲸（VRM） | DeepSeek-WhaleGirl，作者：木子恶魔，个人非商用 |
| `models/final/mmd-tex/`（可选） | 本项目增强贴图（发丝/脸/眼，覆盖原贴图） | 本项目生成，可随仓库分发（但为避免和原贴图混淆，默认不打包） |

> 没有素材时：`python3 build.py` 仍可成功，只是打出来的包没有 3D 模型，桌宠会显示 2D 立绘/占位。

## 2. 2D 立绘（`_assets/`，需自备）

| 文件 | 用途 | 授权 |
| --- | --- | --- |
| `onee.webp` | 02·御姐 立绘 | 同人画作，版权归原作者 / 作品权利方 |
| `v2.webp` | 02·元气 立绘 | 同上 |
| `automatic/campus/dorm/hotspot/journal/celebrate.webp` | 02·Q版 六姿态 | 自制/AI 生成素材，可自行替换 |
| `whale-idle/happy/eat/sleep/stretch/talk/wink.webp` | 鲸鲸各姿态 | 来源同鲸鲸 VRM 授权 |

## 3. 字体 / 图标

- `pkg/icon.svg`：自制，无外部字体。`pkg/docs/preview.svg` 为本机生成的角色截图，源码包会排除它。
- 插件界面无外部字体依赖（系统字体）。

## 4. 如果你要发布

- **不要提交**以上素材，也不要发布含模型的安装包（`dist/*.tgz`），它们会包含版权素材。
- 详情见 `docs/PUBLISH.md`。
