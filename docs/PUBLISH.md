# 发布到 GitHub 前必读

这个仓库是 **zero02-pet 桌宠插件的源码**。为了能公开分享，仓库里**不包含任何第三方版权素材**（3D 模型、2D 立绘）。

## 1. 打包内容

| 包含 | 不包含（需自备） |
| --- | --- |
| `src/` 插件源码（人格 / 记忆 / 声音 / 3D 着色 / MMD/VRM 适配） | `models/` 3D 模型（TDA 军装 02、Darling02、鲸鲸 VRM） |
| `tools/` 构建、测试、MMD 修复、贴图增强脚本 | `_assets/` 2D 立绘（02 同人图 / 鲸鲸图） |
| `docs/` 技术文档 | `zero02-pet/` 构建产物、`dist/` 安装包 |
| `pkg/` 插件描述/图标/多语言 | `shots/` 验收截图 |
| `vendor/` three.js + three-vrm（MIT） | 任何 `node_modules`、缓存文件 |

## 2. 为什么不含素材

- **TDA Zero Two / Darling02 同人模型**：版权归《DARLING in the FRANXX》权利方，模型作者标注为个人使用，**禁止再分发**。
- **鲸鲸 VRM**（DeepSeek-WhaleGirl，作者：木子恶魔）：个人非商用授权，不能随仓库分发。
- **2D 立绘**：同人画作，版权归原画作者。

代码（MIT）可以公开；素材必须由使用者自行准备、仅限本机使用。仓库里的 `models/README.md`、`_assets/README.md` 写明了需要放置的文件名与目录结构。

## 3. 发布清单

```bash
# 1) 确认源码可构建（没有素材时会打出缺少 3D 的包，属正常）
python3 build.py

# 2) 语法与测试（测试需要先放好素材 + 本地预览服务）
python3 tools/serve.py &          # :8899
node tools/smoke.mjs --fast       # 基础
node tools/soul-smoke.mjs         # 灵魂
node tools/render-smoke.mjs       # 渲染（无素材时相关项会失败，属预期）

# 3) 打包安装包（自用）
python3 tools/pack.py             # dist/zero02-pet-<version>.tgz
```

发布到 GitHub 时建议：

- [ ] 用 `tools/make-source-package.py` 生成的干净源码包作为仓库内容（已剔除素材/产物/截图）
- [ ] README 里保留「素材需自备 + 版权说明」
- [ ] 确认 `.gitignore` 已屏蔽 `models/`、`_assets/`、`zero02-pet/`、`dist/`、`shots/`
- [ ] 不要上传角色截图（截图里含角色形象/模型，公开前自行判断）
- [ ] Release 里**不要**附带预打包 tgz（内含模型）
- [ ] 如需演示图，用自己截取、不含角色版权的界面截图，或只放插件 UI/图标

## 4. 使用者如何安装（README 已写明）

1. 按 `models/README.md`、`_assets/README.md` 准备素材；
2. `python3 build.py && python3 tools/pack.py`；
3. 在 DSH 的插件管理里安装 `dist/zero02-pet-<version>.tgz`（或使用 `plugin_manager`）。

## 5. 已知限制

- 无头（headless）测试环境里，「切到游戏风 Darling 再切回 TDA」偶发一次模型挂载超时，重跑即过；真实浏览器未复现。
- 3D 与动画原片仍有差距，完整清单见 `docs/02-FIDELITY-GAPS.md`。
