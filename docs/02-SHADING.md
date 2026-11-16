# 02 的动画质感着色（mmd-shade）

入口：`src/3d/mmd-shade.js`，由 `src/3d/mmdchar.js` 在模型加载后调用
`SHADE.apply(mesh, preset, opts)`；预设：`anime`（默认）/ `soft` / `off`。
运行时切换：`__z02.getChar().setShade('soft', { rimStrength: 0.4 })`。

## 做了什么

1. **边缘光 rim**：`pow(1 - dot(N, V), rimPower)` 叠加，头发/肩膀边缘提亮，动画感的关键。
2. **高光带 specular**：`smoothstep` 阈值高光（不是 pow），避免法线噪声造成闪点。
3. **赛璐璐阶梯 toon ramp**：替换 MMD 自带 toon 贴图，用 canvas 生成 3-4 段阶梯：
   - 皮肤：几乎平涂（`flat=1`，直接输出贴图色 → 白里透红）
   - 头发：两段（暗粉/亮粉）
   - 衣服：三段（暗红/中间调/亮红）
   - 配饰：两段
4. **反向外壳描边**：每个材质一根描边材质，按类型给宽度：
   衣服 1.35×、皮肤 0.9×、头发 0.28×、透明层 0× —— 避免脸/睫毛/发片糊出黑斑。
5. **贴图调色（可选兜底）**：`gradeTextures` 默认开启（canvas 饱和度/对比/色温）；
   项目已用离线增强贴图（`models/final/mmd-tex/`），所以 02 皮肤通过 `shadeOpts: { gradeTextures: false }` 关掉，
   避免双份饱和变荧光。
6. **按材质分类缩放**：`skin / hair / cloth / accent` 各自的 rim/spec/flat 强度。

## 调参速查

| 想要的效果 | 改哪里 |
|---|---|
| 头发更亮/更暗 | `SCALE.hair.flat`（0.8）、`hairTint` |
| 脸更白/更粉 | `skinTint`（RGB 乘子）、`SCALE.skin.flat=1.0` |
| 描边更重 | `outlineWidth`（模型单位，模型高 19.7，0.03≈1.5px@480） |
| 描边颜色 | `outlineColor` |
| 边缘光强弱 | `rimStrength / rimPower` |
| 衣服明暗层次 | `cloth.flat`（0.5=更平，0.2=更强明暗） |

## 与贴图的关系

渲染 = 贴图（离线增强） × 材质色（tint） + ramp 明暗 + rim/spec。
改贴图优先（`tools/enhance-textures.py`），着色器只负责"动画化的光"。
