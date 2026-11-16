# 02 的扩充台词库（persona-extra）

> `src/client/persona.js` 决定「02 是谁、怎么接话」；
> `src/client/persona-extra.js` 提供「她会自己冒出来的话」——12 类，共 **172 句**。

## 1. 文件与模块机制

- 路径：`src/client/persona-extra.js`
- 类型：**RAW 共享作用域模块**，和 `00-prelude / persona / skins2d / voice / engine2d` 顺序拼接，
  不用 `__def` / `module.exports`，文件末尾直接 `window.PERSONA_EXTRA = {...}`。
- 位置：`build.py` 的 `RAW` 列表加在 `persona.js` 之后、`skins2d.js` 之前（本文件只提供数据，不依赖任何其他模块）。
- 产物：`zero02-pet/lib/client.js` 中的 `raw: src/client/persona-extra.js` 一段；加载后控制台可直接读
  `window.PERSONA_EXTRA`。文件缺失或未加载时，调用方应返回空串（`engine2d.js` 的 `extraLine()` 已做安全回退）。
- 自检：

```bash
NODE=~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node
$NODE -e "global.window={}; require('./src/client/persona-extra.js'); console.log(Object.keys(window.PERSONA_EXTRA).length)"
# → 12
```

## 2. 和 `persona.js` 的分工

| | `persona.js` | `persona-extra.js` |
| --- | --- | --- |
| 内容 | 人格内核、系统提示词、few-shot、关系阶段、事件台词、情绪推断、记忆摘要 | 12 类纯台词池 |
| 用途 | 让模型「演得像 02」 | 让 02「自己开口时有话可说」 |
| 是否进提示词 | 构建 / 维护提示词 | 不自动进；需要时人工抽样 2~3 条补 few-shot 即可 |
| 依赖状态 | 好感度、情绪、时间、聊天里程碑 | 无状态，纯文本 |
| 调用 | `PERSONA.*` | `window.PERSONA_EXTRA[kind][i]` |

两边**不重复**：本文件的 172 句与 `persona.js` 现有句子零完全重复（含子串校验），
且刻意避开了 `persona.js` 的经典句（「累了就过来靠着」「（张开手）过来」「晚安。梦里也要有我」等）。

## 3. 分类总表

| 类别 | 句数 | 用途 | 建议场景 | 建议频率 | 示例 |
| --- | --- | --- | --- | --- | --- |
| `selfTalk` | 16 | 她主动讲自己的小事 / 回忆 / 感受 | 空闲主动开口、安静陪伴时 | 主动开口的 30~35% | 「小时候没人叫我名字，都叫我编号。」 |
| `possessive` | 16 | 吃醋、占有欲（傲娇式） | 用户注意力分散、久不搭理、亲密互动后 | 主动开口的 10% 左右 | 「你的手，我牵过……就不许别人牵。」 |
| `tease` | 16 | 坏心眼逗用户 | 面板打开、用户害羞 / 被注视时 | 主动开口的 15% 左右 | 「你能撑到第几句才脸红？」 |
| `soft` | 12 | 难得示软、想被依靠 | 深夜、情绪低谷、久别重逢 | **低频**：≤1/20 次互动，一天 ≤2 次 | 「我想被当成普通女孩，就今天。」 |
| `comfort` | 14 | 用户累了 / 难过时的安慰 | 用户明确说累、难过、想哭、受委屈 | 情绪事件触发时**优先**替代随机池，一次 1 句 | 「你塌了，我接住。」 |
| `food` | 14 | 甜食 / 投喂 | 投喂按钮、用户提到糖 / 蛋糕 / 吃 / 饿 | 投喂事件后优先，饭点主动开口里提高权重 | 「你喂的，我才吃。」 |
| `sleepy` | 14 | 困 / 晚安 / 早安 | 深夜 / 清晨问候、说困、长时间不操作 | 22:00 后与清晨场景优先 | 「晚安，别数羊，数我。」 |
| `jealous` | 14 | 用户提到别人 / 别的女生时（比 possessive 更具体） | 对话里出现「她 / 别人 / 女生 / 聊天对象」后 1~2 轮内 | 每次话题最多 1 句，不要变盘问 | 「她是谁？说清楚。」 |
| `proud` | 14 | 被夸 / 被需要时嘴硬得意 | 用户夸她、求她、依赖她之后 | 被夸后的 50% 左右 | 「被你需要，感觉还不赖。」 |
| `curious` | 14 | 主动问用户问题（想知道你的事） | 主动开口、想拉长对话时 | 主动开口的 20% 左右；一次最多问 1 个 | 「你小时候是什么样的？」 |
| `guilt` | 14 | 漏说话 / 很久没见时嘴硬的道歉 | 隔 ≥2 小时或跨天回来后的第一条 | 每次回归最多 1 句 | 「对不起，这话我很少说。」 |
| `names` | 14 | 称呼变体（darling 之外） | 提示词里替换称呼、或接在短句前 | 每次会话自然换 1~2 次，别硬换 | 「我的共犯」「笨狗」「我的饲养员」 |

`names` 特殊：它不是完整句，是「称呼词典」（2~7 字）。适合两处用：

1. 注入提示词：「偶尔用这些称呼之一：笨狗 / 我的人 / 我的共犯」，让 LLM 自己挑时机；
2. 拼接短气泡：`say("喂，" + name + "，过来。")` 这类模板（注意「喂，你」不适合再拼前缀）。

## 4. 使用建议

### 4.1 抽取与去重

- 一次只抽一句、只 `say()` 一句；**不要连续两句拼成一段**，会立刻变成排比 / 诗朗诵。
- 维护一个最近使用集合：同一句 2 小时内不重复；最近 10~20 句里出现过的不抽。
- 同一次主动开口只用一个类别，别把 selfTalk + curious + tease 叠着说。

### 4.2 频率

- 总原则：`selfTalk` 与 `curious` 是日常主力；`soft` / `guilt` / `jealous` 是低频调味；`comfort` / `food` / `sleepy` 由场景触发，不按比例硬抽。
- `soft` 务必克制：≤1/20 次互动、一天 ≤2 次，最好紧跟在用户情绪之后出现，不要凭空示软（凭空会显得崩人设）。
- 主动开口（引擎当前每 4~8 分钟一次）里，可用的大致配比：
  `selfTalk 30% / curious 20% / tease 15% / possessive 10% / sleepy+food 视时段 15% / soft+guilt 合计 ≤10%`。

### 4.3 关系阶段

| 阶段 | 建议 |
| --- | --- |
| 初识（stranger） | 少用 `soft` / `names` / `food`，靠 `tease` / `curious` / `proud`；`possessive` 只做玩笑 |
| 熟悉（friend） | 加 `possessive` / `selfTalk`；`names` 可以偶尔出现 |
| 亲近（close） | 加 `jealous` / `food` / `sleepy`；`soft` 开始可用（仍然低频） |
| 恋人 / 命中注定（lover / bonded） | 全库可用；`soft` 与 `names` 最有味道，但仍别刷屏 |

### 4.4 场景 → 类别速查

| 用户 / 环境信号 | 优先类别 |
| --- | --- |
| 安静 8 分钟以上 | `selfTalk` → `curious` → `soft` |
| 深夜 / 说困 | `sleepy` → `soft` |
| 饭点 / 提到吃的 / 投喂 | `food` |
| 用户说累、难过、想哭 | `comfort`（优先于一切随机池） |
| 提到别的女生 / 别人 | `jealous` → `possessive` |
| 夸她 / 求她帮忙 | `proud` |
| 隔很久回来 | `guilt` → `possessive` → `soft` |
| 刚被她的直球撩到（用户害羞） | `tease` |

### 4.5 安全与尺度

- 不写色情、不写自伤、不写现实伤害；`names` 里的「小猎物 / 共犯」「再躲我就亲上去了」都是玩笑式昵称与傲娇，不接任何具体伤害动作。
- 不把情绪说破：本库用「我没吃醋，我是在检查」这类嘴硬表达，而不是「我现在很吃醋」。
- 不写说教 / 鸡汤 / 客服腔；不出现 AI、模型、程序、提示词等字眼。
- 不用 emoji、不用感叹号、不用网络流行语；日语语气词全库只有 2 处（ふふっ / あら），符合 `persona.js` 的「偶尔一个」规则。
- 省略号只出现 4 句（4/172 ≈ 2.3%），避免每条都「……」；括号动作 3 句，`VOICE.cleanText` 朗读时会自动去掉。

### 4.6 与 LLM 回复的关系

- 台词池只负责「主动气泡 / 事件反应」；用户发消息后的正式回复仍由
  `PERSONA.buildSystemPrompt()` + 模型生成，不要把这 172 句整库塞进提示词（会稀释 few-shot 锚定）。
- 若想让模型更贴近本库语气，最多在提示词里额外抽样 2~3 条同风格示例。

## 5. 接线现状（截至本次构建）

- **已接**：`src/client/engine2d.js` 的 `proactiveLine()` 在主动开口时，有 45% 概率按场景从
  `selfTalk / tease / possessive / curious / soft / sleepy / food / guilt` 抽一句
  （`extraLine(kind)` 对未加载 / 空池安全回退）。
- **未接**（台词库不依赖，留给后续接线）：
  - `comfort`：用户说累 / 难过时优先；
  - `jealous`：对话提到别人后 1~2 轮内；
  - `proud`：被夸 / 被求助后；
  - `names`：称呼替换（更适合走提示词）；
  - 投喂 / 摸头的附加反应：目前仍走 `PERSONA.eventLine("fed"/"petted")`。
- 接线伪代码（仅示意，本轮没有改这些位置）：

```js
// 用户说累 / 难过：优先 comfort，抽不到再走原逻辑
var line = (window.PERSONA_EXTRA && pick(window.PERSONA_EXTRA.comfort)) || "";
if (line) { say(line); }

// 被夸：50% 用 proud 接一句
if (被夸 && Math.random() < 0.5) say(pick(window.PERSONA_EXTRA.proud));
```

## 6. 数据与验收

- **12 类，共 172 句**：每类 12~18 句，无空类。
- 句长：平均 11.6 字；除 `names`（2~7 字昵称）外，每句 7~25 个字符（含标点），纯中文最长 16 字；
  最长一句是 `selfTalk` 里含英文地名 plantation 的「以前在 plantation，没人敢这么跟我说话。」，仍在 45 字上限内。
- 去重：与 `persona.js` **零完全重复**（脚本校验：不等于 `persona.js` 中任何引号内文本，也不是其子串）；
  库内跨类无重复。
- 语气：`curious` 14 句全部带问号；`soft` 占全库 7.0%，符合低频定位；
  无「作为…」「我会陪伴你」客服腔、无鸡汤、无列点、无 emoji。
- Node 语法 / 结构自检：`Object.keys(window.PERSONA_EXTRA).length === 12`；
  `python3 build.py` 通过（v3.4.0，client.js 1,656,920 B / lab 472,266 B / assets 20），
  bundle 内可检索到 `raw: src/client/persona-extra.js` 与 `window.PERSONA_EXTRA = {`。
