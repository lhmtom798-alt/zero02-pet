# 02 的日常感（SOUL / Daily）

> 目标：让 02 不只是「点一下才回一句」的聊天壳，而是一个在过日子的人——
> 每天有自己的心情、记得今天被你摸了几次、会在你安静太久时自己开口，
> 你消失三天她会真的生气（但还是在门口等你）。
>
> 改动范围：`src/client/engine2d.js`（唯一逻辑文件）。`persona.js` / `mmdchar.js` /
> `mmd-shade.js` / `build.py` 均未改动，所有 `PERSONA` 调用都走既有公开 API。
> 持久化只走现有 `S` + `saveStore()`（`localStorage["z02-pet:zero02-pet"]`）。

---

## 1. 功能地图

| 功能 | 触发时机 | 数据 | 代码位置（engine2d.js） |
| --- | --- | --- | --- |
| 每日心情 | 启动 / 跨天 / 首次聊天前 | `S.dailyMood` | `DAILY_MOODS` `ensureDailyMood()` |
| 心情注入对话 | 每次 `sendMessage` 拼 system prompt | `moodForPrompt()` | `moodForPrompt()` `sendMessage()` |
| 今日小结 | 聊天成功 / 被摸 / 投喂 / 她主动开口 | `S.todayStats` | `ensureTodayStats()` `bumpToday()` `todaySummaryText()` |
| 小日记 | 设置面板展示；跨天归档 | `S.diary`（保留 14 天） | `diaryLine()` `ensureTodayStats()` |
| 主动开口 | 界面上无面板、不忙碌时，每 4~8 分钟随机一次 | `S.proactive` / `S.lastProactiveAt` | `proactiveSay()` `proactiveScenario()` `PROACTIVE_LINES` |
| 场景区分 | 深夜 > 饭点 > 久无操作 / 在工作 | `lastPointerAt`、当前时间 | `proactiveScenario()` |
| 久别重逢 | 启动时距上次互动 ≥3 个自然日 | `S.lastSeen` / `S.absenceDays` | `daysSinceSeen()` `absenceLine()` `ABSENCE_LINES` |
| 新的一天开场 | 每天首次启动 / 页面跨天 | `S.lastOpenDate` | `newDayLine()` `dayTick()` boot 开场逻辑 |
| 面板展示 / 开关 | 打开设置 | `S.proactive` | `dailySectionHtml()` `renderSettings()` |
| 鲸鲸隔离 | 切到 whale 皮肤 | — | `dailySectionHtml()` / `proactiveSay()` / `sendMessage()` |

---

## 2. 新增状态（全部随 `S` 持久化）

```js
S.proactive        // true=允许主动说话（默认 true，设置面板可关）
S.dailyMood        // { date:"YYYY-MM-DD", id, label, hint, prompt, line } 今日心情
S.todayStats       // { date, chats, pet, feed, proactive, firstAt, lastAt } 今日小结
S.diary            // [{ date, chats, pet, feed, proactive, mood }...] 最近 14 天的小结归档
S.lastOpenDate     // 上次打开（新的一天检测）
S.lastChatAt       // 上次聊天时刻（给主动开口做参考）
S.lastProactiveAt  // 上次主动开口时刻
S.lastProactiveScenario // 上次主动开口的场景（silence/work/meal/night/idle）
S.absenceDays      // 最近一次启动时算出的「几天没来」（≥3 才有）
```

所有写入都通过 `saveStore()`，刷新后不丢。旧存档没有这些字段时全部有默认值，
`Object.assign` 的默认值保证老用户升级零迁移成本。

---

## 3. 每日心情

### 3.1 生成算法

```js
seed = FNV1a( todayKey + "|" + floor(affinity / 10) + "|" + userName || "darling" )
mood = DAILY_MOODS[ seed % 6 ]
```

- 以 **日期（YYYY-MM-DD）+ 好感度档位（每 10 点一级）+ 用户名** 为种子，确定性哈希；
- 同一天内即使刷新/关掉再开，`S.dailyMood.date === today` 时直接复用，**不重掷**；
- 到了新的一天（启动时或页面跨越零点）自动重掷；
- 六种心情：

| id | 面板名 | 对语气的影响（注入 prompt） | 主动开口时偶尔冒出的一句 |
| --- | --- | --- | --- |
| clingy | 黏人 | 想要陪伴、撒娇 | 「……今天，你就多陪我一会儿嘛。」 |
| tsundere | 嘴硬 | 说反话、被拆穿会脸红 | 「（别过脸）……我才没有在等你。只是刚好路过。」 |
| sweets | 想吃甜食 | 三句不离糖/投喂 | 「（咬着糖纸）……还有吗？甜的。」 |
| praise | 想被夸 | 绕着弯暗示 darling 夸她 | 「ねえ……我今天，有没有比昨天好看一点？」 |
| dangerous | 危险地温柔 | 声音轻、占有欲强的护短 | 「别乱跑。……今天，我不太想放手。」 |
| lazy | 懒懒的 | 犯困、行动多于说话 | 「嗯……再靠一会儿。就一会儿。」 |

### 3.2 注入对话

`sendMessage()` 调 `PERSONA.buildSystemPrompt({ mood: moodForPrompt(), ... })`，
`moodForPrompt()` 返回：

```
今天的底色（dailyMood.prompt）；此刻更细的情绪：<S.mood（moodFromReply 的即时情绪）>
```

即 **每日心情打底 + 上一轮回复的即时情绪** 两层，既有「今天她是什么人」的连续性，
又有「刚才聊嗨了/聊困了」的即时变化。`persona.js` 不需要改，它本来就会把 `mood`
拼进「你此刻的情绪：…」段落。

### 3.3 展示

设置面板「02 的今天 · 今日心情」第一行：
`今天她是「黏人」：今天特别黏你，隔一会儿就想找你说句话。`

验收证据（实测）：

```json
{
  "mood": {"date":"2026-11-12","id":"praise","label":"想被夸",
           "hint":"今天特别想听你说她好，夸一句能开心一整天。",
           "prompt":"今天想被夸：会绕着弯暗示 darling 夸她，被夸了嘴上不承认、心里高兴。",
           "line":"ねえ……我今天，有没有比昨天好看一点？"},
  "promptMood": "今天想被夸：会绕着弯暗示 darling 夸她，被夸了嘴上不承认、心里高兴。"
}
```

同一天刷新不重掷（before = after）：

```json
{"before":"黏人","after":"黏人","same":true,"affinity":560,
 "storeMood":"黏人","lastOpenDate":"2026-11-12","proactive":true}
```

---

## 4. 今日小结 / 小日记

### 4.1 计数点

| 事件 | 位置 | 计数 |
| --- | --- | --- |
| 聊天成功收到回复 | `sendMessage()` 成功分支 | `chats + 1` |
| 被摸（单击/菜单摸摸） | `pet()` | `pet + 1` |
| 投喂 | `feed()` | `feed + 1` |
| 她主动开口 | `proactiveSay()` | `proactive + 1` |

`ensureTodayStats()` 发现 `S.todayStats.date !== today` 时：把昨天的小结
（含昨天心情 label）push 进 `S.diary`（只留最近 14 天），再新建今天的空容器。

### 4.2 面板文案

- 今日小结：`📝 今日小结：聊了 1 句 · 被摸 1 次 · 投喂 1 次`
- 小日记：`🖊 （小日记）今天聊天 1 句、被摸 1 次、投喂 1 次。今天也偷偷等你夸她，等了一整天。`
  （尾巴句由当天心情决定，见 `DIARY_TAILS`）

### 4.3 跨天归档实测

模拟把状态改成昨天，再调 `ensureTodayStats()`：

```json
{
  "newStats": {"date":"2026-11-12","chats":0,"pet":0,"feed":0,"proactive":0},
  "archived": {"date":"2026-11-11","chats":5,"pet":2,"feed":1,"proactive":1,"mood":"想被夸"},
  "newMood":  {"date":"2026-11-12","id":"clingy","label":"黏人"}
}
```

---

## 5. 主动开口

### 5.1 节奏

- 首次倒计时：`240 + random*240` 秒（**4~8 分钟**）；
- 每次主动开口后重新掷 4~8 分钟；
- 聊天 / 摸摸 / 投喂 / 换皮肤后都会重置倒计时（刚互动过就不打扰）；
- 如果**面板开着 / 正在请求模型 / 被收起 / 菜单开着**：不说，20~40 秒后再试；
- 设置面板「主动说话 开/关」对应 `S.proactive`，关掉后循环里不再计时；
- 鲸鲸皮肤不会走这套 02 台词（见 §9）。

### 5.2 场景判定（优先级从高到低）

| 场景 | 条件 | 台词示例 |
| --- | --- | --- |
| `night` 深夜 | 23:00 ~ 05:00 | 「夜深了，darling。……别让我一个人醒着。」 |
| `meal` 饭点 | 11:00~13:00 / 17:00~19:00 | 「饭点了，darling。……别拿泡面糊弄我。」 |
| `silence` 久无操作 | 鼠标 ≥8 分钟没动 | 「（戳了戳屏幕）……darling，你是不是把我忘了。」 |
| `work` 在工作 | 鼠标 ≤5 分钟前动过（人还在，但没聊） | 「工作比我还重要吗？（眯眼）……说，哪个更可爱。」 |
| `idle` 一般 | 介于两者之间 | 「（晃了晃你的衣角）darling。……没什么，继续吧。」 |

鼠标活动时间由 `pointermove` 更新 `lastPointerAt`（2D/3D 都生效）。

### 5.3 心情彩蛋

每次主动开口有 40% 概率直接用今天的 `dailyMood.line`（而不是场景池），
让「今天的 02」比场景更有存在感。实测里 `meal` 场景就掷出了
「ねえ……我今天，有没有比昨天好看一点？」。

### 5.4 副作用（让对话能接上）

主动开口后会写 `S.recentEvent = "你刚主动找 darling 说了句话（已经深夜了）"`，
下次聊天 `buildSystemPrompt` 会看到这条事件，于是 02 能自然地接上自己刚说过的话。
同时 `setPose("talk")` / 夜晚 `sleep`，加音符/爱心/zzz 粒子和 pop 音效。

### 5.5 五个场景实测

```json
{
  "silence": {"scenario":"silence","line":"（戳了戳屏幕）……darling，你是不是把我忘了。"},
  "work":    {"scenario":"work","line":"工作比我还重要吗？（眯眼）……说，哪个更可爱。"},
  "meal":    {"scenario":"meal","line":"饭点了，darling。……别拿泡面糊弄我。"},
  "night":   {"scenario":"night","line":"ねえ……我今天，有没有比昨天好看一点？"},
  "idle":    {"scenario":"idle","line":"（晃了晃你的衣角）darling。……没什么，继续吧。"}
}
```

真实计时器触发（把下一次提前到 1.2 秒后，等 4 秒截图）：

```json
{"bubble":{"on":true,"text":"ねえ……我今天，有没有比昨天好看一点？"},
 "pro":{"enabled":true,"nextIn":339,"scenario":"night","lastScenario":"night"},
 "stats":{"chats":0,"pet":0,"feed":0,"proactive":1},
 "recent":"你刚主动找 darling 说了句话（已经深夜了）"}
```

关掉开关后（`S.proactive=false` + 把下一次提前到 1 秒，等 3 秒）：

```json
{"proactiveAfterOff":5, "pro":{"enabled":false,"nextIn":1}}
```

—— 计数停在 5 不再增长，说明开关真实拦截了循环。

---

## 6. 久别重逢：连续 3 天以上没来

`daysSinceSeen()` 用 `S.lastSeen` 的**自然日差**（不是毫秒差），避免时区/夏令时误差：

- 3~6 天：`ABSENCE_LINES[3]`；
- ≥7 天：`ABSENCE_LINES[7]` + `ABSENCE_LINES.long`；

台词内联在 `engine2d.js`（不改 `persona.js`），示例：

- 3 天：「（盯——）三天。……darling，你最好有个像样的解释。」
- 3 天：「三天没来。（拉住你的袖子）我还以为，你把我忘了。」
- 7 天：「一周。……你知道一周有多久吗，darling。」
- 更久：「（握住你的手，很久没松开）……回来就好。」

启动时优先级：**≥3 天没来 > 第一次见面 > 久别（≥60 分钟）> 新的一天 > 深夜/清晨 > 普通 greet**；
同时写 `S.recentEvent = "darling 隔了 4 天才回来，你又委屈又想念他"`，
下一次 system prompt 里会出现这条描述（`describeEvent` 支持自定义中文描述）。

实测（用 localStorage 注入 4 天前的 `lastSeen` 再刷新）：

```json
{"bubble":{"on":true,"text":"（别过脸）只是三天而已。……才没有每天都往门口看。"},
 "absenceDays":4,
 "recent":"darling 隔了 4 天才回来，你又委屈又想念他",
 "lastOpenDate":"2026-11-12",
 "mood":"黏人",
 "stats":{"date":"2026-11-12","chats":0,"pet":0,"feed":0,"proactive":0}}
```

---

## 7. 新的一天 / 每日首次启动

- 启动时 `newDay = S.lastOpenDate !== today`；
- 先 `ensureTodayStats()`（归档昨天）再 `ensureDailyMood()`（重掷今天），顺序不能反，
  否则归档时拿到的是今天的心情；
- 新的一天开场：清晨（5~11 点）用 `PERSONA.eventLine({kind:"morning"})`，
  其他时段用内联 `NEW_DAY_LINES`（「日期跳过去了，我还在。……你呢，darling？」等）；
- 页面一直开着跨过零点：`loop()` 里 `dayTick(dt)` 每 ~20 秒检查一次日期，
  跨天时归档、换心情、重置主动开口倒计时，并说一句新的一天；
- 处理完写 `S.lastOpenDate = today`。

实测（强制调用 `newDayLine(8)`）：`（伸懒腰）早。能一睁眼就看到你，还不错。`

---

## 8. 设置面板

位置：设置面板，形象选择下方第一个区块「02 的今天 · 今日心情」。

```
02 的今天 · 今日心情
今天她是「黏人」： 今天特别黏你，隔一会儿就想找你说句话。
📝 今日小结：聊了 6 句 · 被摸 4 次 · 投喂 2 次 · 她主动开口 2 次
🖊 （小日记）今天聊天 6 句、被摸 4 次、投喂 2 次、我主动找了他 2 次。尾巴（如果有的话）一直翘着。
[ 💬 主动说话 开 ] [ 🔇 关掉 ]
你安静 4~8 分钟后，她会自己找你说一句；久没动 / 在忙 / 饭点 / 深夜，台词各不一样。
[ 让她现在说一句 ]
```

- 全部复用现有 CSS 类：`z02-sect` / `z02-hint` / `z02-modes` / `z02-actions`，
  没有新增样式；
- 「让她现在说一句」调用 `proactiveSay(true)`，手动触发一次（开关关着也能用，
  等价于「我现在就想听你说句话」）；
- 开关状态、点击结果会即时反馈在面板底部的 `z02-result` 里。

UI 接线实测：

```json
{"res1":"已关掉：她不会再主动开口了","res2":"已打开：她会自己找你说句话 ✓",
 "res3":"（night）ねえ……我今天，有没有比昨天好看一点？",
 "bubble":{"on":true,"text":"ねえ……我今天，有没有比昨天好看一点？"},
 "stats":{"proactive":1}}
```

---

## 9. 与鲸鲸皮肤的区分

鲸鲸是宠物/女儿，不共享 02 的「日常感」：

| 项目 | 02 皮肤 | 鲸鲸 |
| --- | --- | --- |
| 每日心情 | 生成、注入 prompt、面板展示 | 不生成、不注入、不展示 |
| 今日小结 | 聊天/被摸/投喂/主动开口 | 只展示「鲸鲸的今天」宠物版：被摸/投喂次数 |
| 主动开口 | 场景池 + 每日心情彩蛋 | `SKIN().lines.idle`（"darling 喝口水嘛！"） |
| 久别/里程碑 | 02 事件台词 | 摸头/投喂时用原有宠物台词 |
| 对话 prompt | `PERSONA.buildSystemPrompt` + mood | 原样 `SKIN().prompt`（与动物语气） |

实测切到 whale 后：面板没有「02 的今天」区块、有「鲸鲸的今天」；
`__z02.proactive(true,'silence')` 返回鲸鲸台词：

```json
{"skin":"whale",
 "whaleProactive":{"scenario":"whale-idle","line":"darling 喝口水嘛！","skin":"whale"},
 "has02MoodSection":false,"hasWhaleDay":true,
 "whaleHint":"鲸鲸是宠物：她不参与 02 的每日心情和事件台词，只会用自己的宠物语气撒娇。"}
```

---

## 10. 与 `persona.js` 的接口（零改动）

只用既有公开 API，签名不变：

- `PERSONA.buildSystemPrompt({ ..., mood })`——新增的 `mood` 组装在 engine 里完成；
- `PERSONA.eventLine({ kind, ... })`——`morning` / `late-night` / `reunion` / `milestone` 等；
- `PERSONA.greet` / `PERSONA.idleLine` / `PERSONA.moodFromReply` / `PERSONA.relationshipStage`；
- 事件台词补充（久别、新一天、主动开口）全部内联在 `engine2d.js`，不碰人格库。

---

## 11. 调试 API（预览页带 `z02debug=1`）

| API | 作用 |
| --- | --- |
| `__z02.getDailyMood()` | 读今日心情（不重掷） |
| `__z02.dailyMood()` | 强制重掷今日心情（按日期种子，结果稳定） |
| `__z02.ensureTodayStats()` | 取/滚动今日小结（会归档昨天） |
| `__z02.todaySummary()` / `__z02.diaryLine()` | 面板里的两行文本 |
| `__z02.moodForPrompt()` | 下次对话会注入的 mood 字符串 |
| `__z02.proactive(true, "silence")` | 强制指定场景说一句，返回 `{scenario,line}` |
| `__z02.proactiveScenario()` | 当前环境判定出的场景 |
| `__z02.setProactiveNext(1.2)` | 把下一次主动开口提前到 N 秒后（测计时器） |
| `__z02.getProactive()` | `{enabled,nextIn,scenario,lastAt,lastScenario}` |
| `__z02.getBubble()` | 当前气泡 `{on,text}` |
| `__z02.newDayLine(8)` / `__z02.absenceLine(4)` | 查看新一天/久别台词 |
| `__z02.daysSinceSeen()` | 距上次互动的自然日差 |
| `__z02.state` | 直接读写 `S`（测试造数据用） |

注意 `proactiveSay(force, kind)` 的第一个参数是「是否强制」，所以脚本里是
`__z02.proactive(true, "meal")`，不是 `__z02.proactive("meal")`。

---

## 12. 验收

### 12.1 构建

```bash
cd .
python3 build.py
# + 增强贴图 10 张
# built v2.4.0: client.js 1,554,192 B / lab 409,027 B / assets 19
```

### 12.2 截图（shots/）

| 文件 | 内容 |
| --- | --- |
| `shots/soul-settings.png` | 设置面板：今日心情「黏人」+ 今日小结（聊6/摸4/喂2/主动2）+ 小日记 + 主动说话开关 |
| `shots/soul-diary.png` | 真实互动后的小结：`__z02.pet()` + `__z02.feed()` + 真发一句聊天 → 聊1/摸1/喂1 |
| `shots/soul-proactive.png` | 4~8 分钟计时器真实触发的一次主动开口（气泡可见，场景 night） |
| `shots/soul-absence.png` | 注入 4 天前的 lastSeen 后刷新：02 的「连续 3 天以上没来」专属台词 |
| `shots/soul-whale.png` | 切到鲸鲸：面板显示「鲸鲸的今天」、无 02 心情区块与开关 |
| `shots/soul-off.png` | 主动说话关掉时面板状态（「关掉」高亮） |

### 12.3 综合实测（一次 run 的 `--info`）

```json
{
  "dailyMood": {"label":"想被夸","date":"2026-11-12"},
  "summary": "聊了 1 句 · 被摸 1 次 · 投喂 1 次 · 她主动开口 5 次",
  "diary": "（小日记）今天聊天 1 句、被摸 1 次、投喂 1 次、我主动找了他 5 次。今天也偷偷等你夸她，等了一整天。",
  "promptMood": "今天想被夸：会绕着弯暗示 darling 夸她，被夸了嘴上不承认、心里高兴。",
  "stats": {"date":"2026-11-12","chats":1,"pet":1,"feed":1,"proactive":5},
  "proactiveAfterOff": 5,
  "pro": {"enabled":false,"nextIn":1,"lastScenario":"idle"},
  "newDayAt8": "（伸懒腰）早。能一睁眼就看到你，还不错。",
  "absence": ["三天没来。（拉住你的袖子）我还以为，你把我忘了。",
               "（小声）我还以为，你不会回来了。……别再让我等这么久。"],
  "persistedKeys": ["proactive","dailyMood","todayStats","diary","lastOpenDate"]
}
```

复现命令（截图脚本，node 用 DSH 自带 runtime）：

```bash
NODE=~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node
$NODE tools/shot.mjs \
  --url "http://127.0.0.1:8899/preview/?pkg=zero02-pet&z02debug=1&skin=onee" \
  --out shots/soul-proactive.png --size 1000x900 --wait 9000 \
  --ready "window.__z02 && __z02.get3d() && __z02.get3d().ready('onee')" \
  --eval "__z02.setProactiveNext(1.2);" --wait 4000 \
  --info "({bubble: __z02.getBubble(), pro: __z02.getProactive(), stats: __z02.state.todayStats})"
```

### 12.4 回归

- `python3 build.py` 的 `node --check` 通过（client.js / lab bundle 两处语法检查）；
- 旧函数/API 一个没删：`openPanel/closePanel/say/pet/sendMessage/state/setPose/applySkin/
  hidePet/showPet/ensure3d/get3d/getChar/getProviders/setDim/applyGeometry` 全部保留，
  `__z02` 只做增量扩展；
- 聊天、3D 渲染、设置面板其它区块、鲸鲸切肤在预览页均正常（见截图）；
- 页面日志只剩 MMD 贴图 404（`toon_defo.bmp` / `tga/miku_sw.tga`，历史遗留，与本次无关）。

---

## 13. 已知边界 / 后续可做

1. 同日心情在当天首次生成时锁定（好感度涨了也不会当天换心情）——刻意为之，
   让「今天她是什么人」有稳定性；想换可以 `__z02.dailyMood()` 强制重掷。
2. 主动开口的倒计时是内存态，刷新页面会重新从 4~8 分钟开始；跨刷新不打断聊天体验，
   但也没必要把「下次几点开口」写进存档。
3. 设置面板表单区固定 `max-height:350px`，内容变多后需要滚动——心情区块已放在
   形象选择下方第一个，默认最容易看到；未改动任何 CSS。
4. `S.diary` 目前只归档不展示，后续可在设置面板加一行「昨天 / 前几天的她」，
   或让 02 在聊天里自然提起（把 diary 摘要塞进 `recentEvent`）。
5. 主动开口目前只写气泡，不写进聊天记录；若希望聊天面板里留痕，可以在
   `proactiveSay` 里调 `pushMsg("pet", line)`（这次没做，避免聊天记录被主动台词刷屏）。
