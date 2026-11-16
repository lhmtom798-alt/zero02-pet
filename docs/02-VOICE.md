# 02 的声音（VOICE / TTS）

> 目标：给 02 加一个「像少女的声音」——用浏览器自带的 Web Speech API（系统 TTS）读中文，
> 选最像 02 的中文女声，按情绪调语速/音高，默认关闭、可试听、可降级；
> 鲸鲸皮肤用更高更奶的声线，保持宠物语气。
>
> 改动范围：**新增** `src/client/voice.js`（RAW 模块）、`src/client/engine2d.js`（接线 + 设置面板）、
> `build.py`（RAW 数组加一行）。`persona.js` / `mmdchar.js` / `mmd-shade.js`
> / `skins2d.js` 均未改动；语音开关与音效开关（`S.sound`）完全独立。
> 持久化只走现有 `S` + `saveStore()`（`localStorage["z02-pet:zero02-pet"]` 里的 `S.voice`）。

---

## 1. 一张图看懂

```
聊天回复 / 摸头 / 投喂 / 主动开口 / 事件台词 / 开场
        │
        ▼
say(text, ms, { kind })            ← engine2d.js
        │  kind 非空 = 「这是她真正在说的话」
        ▼
voiceForLine(text, opts)           ← 带上 skin / S.mood / 原文本
        │
        ▼
VOICE.speak(text, opts)            ← src/client/voice.js（RAW，在 engine2d 之前拼接）
   ├─ 开关检查：S.voice.on（默认 false；试听/调试可 force）
   ├─ 能力检查：window.speechSynthesis + SpeechSynthesisUtterance
   ├─ 中文语音检查：getVoices() 里挑分最高的 zh-CN/zh-TW 女声（异步加载，轮询 + onvoiceschanged）
   ├─ 文本清洗：去（动作）括号 / emoji / URL / markdown / HTML → 截断 ~60 字
   ├─ 情绪识别：S.mood 文案 或 回复原文 → happy / shy / sleepy / soft / sad / normal
   ├─ 参数计算：base rate/pitch + 情绪偏移 → clamp
   ├─ 竞态：先 speechSynthesis.cancel() 旧句，再 speak 新句（token 防旧回调覆盖状态）
   └─ 降级：没中文语音就静默跳过（不报错、不卡 UI），设置面板里提示
```

设置面板（`renderSettings()` 的「🗣 02 的声音（系统 TTS）」区块）：

- 「🔊 让她说话 / 🔇 不出声」开关 —— 写 `S.voice.on`，默认 **关**；
- 「试听一句」按钮 —— 无视开关立即试听（用户点了就是明确要听，失败也会在面板里说明原因）；
- 状态提示 —— 当前选中的语音名、语言、rate/pitch、降级原因（自动等语音列表异步加载完再刷新）。

---

## 2. 参数

### 2.1 基准声线（`src/client/voice.js` 顶部 `CFG`）

| 常量 | 值 | 说明 |
| --- | --- | --- |
| `baseRate` | **1.08** | 02 的少女基准语速（任务要求区间 1.05~1.15） |
| `basePitch` | **1.22** | 02 的少女基音（任务要求区间 1.15~1.35） |
| `baseVolume` | 1 | 系统音量交给 OS，不改 |
| `whaleRate` | **1.12** | 鲸鲸：rate 稍快 |
| `whalePitch` | **1.45** | 鲸鲸：更高更奶（任务要求 1.4+） |
| `maxChars` | **60** | 单句最多读 ~60 字（长回复截断，尽量在最后一个句读收尾） |
| `rateClamp` | 0.85 ~ 1.3 | 情绪偏移后的安全范围 |
| `pitchClamp` | 1.0 ~ 1.6 | 情绪偏移后的安全范围 |

### 2.2 情绪 → 语调（`moodScale`，叠加在基准值上）

情绪来源：02 用 `S.mood`（`PERSONA.moodFromReply` 刚生成的情绪文案）优先，没有就用回复原文猜；
鲸鲸不用 02 的 `S.mood`（那是 02 的情绪），只按自己的台词猜，且偏移量 ×0.6 保持奶声。

| 情绪 id | 识别关键词（节选） | rate 偏移 | pitch 偏移 | 实际 02 参数（base 1.08/1.22） |
| --- | --- | --- | --- | --- |
| `happy` 开心 | 开心 / 心情很好 / 喜欢 / 高兴 / 嘿嘿 / 撒娇 / 黏 | **+0.10** | +0.02 | **rate 1.18 / pitch 1.24** |
| `shy` 害羞 | 害羞 / 脸红 / 笨蛋 / 谁准 / 才不是 / 哼 / 嘴硬 / 耳朵尖 / 抱 | **−0.05** | **+0.08** | **rate 1.03 / pitch 1.30** |
| `sleepy` 困 | 困 / 睡觉 / 晚安 / 好累 / 打哈欠 / 懒 / 眯 | **−0.15** | −0.04 | **rate 0.93 / pitch 1.18** |
| `soft` 危险地温柔 / 占有欲 | 危险 / 不许 / 占有 / 圈在 / 护着 / 只能 / 吃醋 | −0.06 | +0.02 | rate 1.02 / pitch 1.24 |
| `sad` 心疼 / 低落 | 难过 / 委屈 / 心疼 / 哭 / 撑不住 | −0.08 | −0.02 | rate 1.00 / pitch 1.20 |
| `normal` 其它 | — | 0 | 0 | rate 1.08 / pitch 1.22 |

鲸鲸（base 1.12 / 1.45）叠加同样的偏移但 ×0.6：例如台词「（蹭了蹭）最喜欢 darling 了！」→ `happy` →
**rate 1.18 / pitch 1.46**（仍满足 pitch ≥ 1.4）。

> 任务里的三个必需映射（开心 rate+0.1、害羞 pitch+0.08/rate−0.05、困 rate−0.15）都在上表，
> 实测见第 6 节 JSON。

---

## 3. 选中文少女语音的逻辑

`voice.js` 每次 `refresh()` 都做三件事：

1. **筛中文**：`lang` 以 `zh` 开头，或名字含 `中文 / 普通话 / 國語 / 粤语 / chinese / mandarin / cantonese`；
2. **打分**（名字命中加权 + 语言加权 + 男声降权 + 本机语音加分）：

| 关键词 | 加分 | 备注 |
| --- | --- | --- |
| `Tingting` / `婷婷` | +120 | macOS 婷婷（zh-CN，本机）——最推荐 |
| `Meijia` / `美佳` | +110 | macOS 美佳（zh-TW，本机） |
| `Xiaoxiao` / `晓晓` | +104 | Windows 晓晓 |
| `Xiaoyi` / `晓伊` | +100 | Windows 晓伊 |
| `Huihui` / `慧慧`、`Yaoyao` / `瑶瑶`、`Lili` / `丽丽` | +96 / +92 / +88 | Windows 其它女声 |
| `female` / `女` | +46 / +40 | 兜底女声线索 |
| 名字含 `Google 普通话` / `Google 國語` | +64 / +52 | Chrome 内置（网络语音） |
| 语言 `zh-CN` / `zh-TW` / `zh` | +20 / +12 / +10 | 简中优先 |
| 名字含 `male` / `男` | −50 | 男声直接压下去 |
| `localService === true` | +6 | 本机语音更稳，不依赖网络 |

3. **异步加载处理**：`getVoices()` 第一次经常返回空数组（Chrome/Safari 都有这个问题），所以：
   - `speechSynthesis.addEventListener("voiceschanged")` + `onvoiceschanged` 双保险；
   - 兜底轮询：`0 / 250 / 700 / 1500 / 2800 / 4500 / 7000 / 10000 ms`；
   - `speak()` 里也会 `refresh(false)` 惰性重扫一次（4 秒节流），保证「用户点开关那一刻」一定能拿到列表；
   - 设置面板开着时每 500ms 刷新一次提示文案，直到拿到中文语音。

实测（本机 headless Chrome，macOS）：`voiceCount=199 / zhCount=21`，挑中 **「婷婷」(zh-CN, local)** ——
因为 macOS 本机婷婷同时吃到 `Tingting` +120、`zh-CN` +20、`localService` +6，压过 Chrome 的 Google 网络语音。

---

## 4. 文本清洗（读出来的东西 ≠ 气泡里看到的东西）

`VOICE.cleanText()` 按顺序处理（示例都是实测值）：

| 规则 | 例子 | 结果 |
| --- | --- | --- |
| 去 markdown 图片/链接地址 | `![x](a.png)`、`[02](https://a.b)` | 链接保留文字、地址丢弃 |
| 去 URL | `我们在 https://example.com 见` | `我们在见` |
| 去（动作/旁白/表情）括号（中英方圆，跑 3 遍处理嵌套） | `（凑近）darling` | `darling` |
| 去方括号注解/标签 | `【动作】你好` | `你好` |
| 引号/书名号只留内容 | `「darling，今天也一起吧」` | `darling，今天也一起吧` |
| 去 markdown 标记 / HTML | `**好**<br>` | `好` |
| 去 emoji / 图形符号 / 零宽字符 | `💗✨♪` | 空 |
| 省略号/波浪号 → 逗号停顿 | `我在……等你～` | `我在，等你` |
| 叠标点收成一个 | `。，`、`！！！` | `。`、`！` |
| 截断 ~60 字（优先句读收尾） | 长回复 | `……话，……话…`（≤61 含省略号） |

**触发朗读的范围**（`kind` 白名单，见 `engine2d.js` 里各 `say()` 调用）：

| kind | 场景 | 读不读 |
| --- | --- | --- |
| `chat` | 聊天回复（`sendMessage`） | ✅ 读 |
| `pet` / `feed` | 点一下摸头 / 菜单投喂 | ✅ 读 |
| `proactive` | 她主动开口（4~8 分钟一次） | ✅ 读 |
| `event` | 久别重逢 / 里程碑 / 连聊太久 / 新一天 | ✅ 读 |
| `greet` | 启动开场白 | ✅ 读（页面还没交互时可能被浏览器 autoplay 策略拦下，静默跳过） |
| `toggle` / `preview` | 打开语音时的确认句 / 试听按钮 | ✅ 读（试听无视开关） |
| 无 opts | 切 2D/3D、好感度升级、报错、每 22 秒的 idle 碎碎念 | ❌ 不读（避免像系统通知一样吵） |

---

## 5. 竞态 / 降级 / 生命周期

| 情况 | 行为 |
| --- | --- |
| 新一句要读，上一句还没读完 | 先 `speechSynthesis.cancel()` 再 `speak()`；`token` 自增让旧句的 `onend/onerror` 不覆盖新状态 |
| 面板关闭（`closePanel()`） | `VOICE.cancel()`，正在读的这句立即停 |
| 收起桌宠（`hidePet()`） | `VOICE.cancel()` |
| 页面切到后台 / `pagehide` | `visibilitychange` 时 `cancel()`；回来不自动续读 |
| 关闭语音开关 | `VOICE.cancel()`，状态持久化 `S.voice.on=false` |
| 浏览器不支持 Web Speech API | `supported=false`，所有调用直接返回 false；设置面板提示「已静默降级：只显示气泡，不会有任何报错」 |
| 没有中文语音（只有英文/日文等） | **静默降级**：不构造 utterance、不调用 `speak()`（绝不用英文嗓音硬念中文），状态 `degraded=true, reason="no-zh-voice"`，设置面板提示 macOS 去哪下载婷婷/美佳；`errors=0` |
| 语音列表还没加载完 | `degraded=true, reason="voices-loading"`，设置面板提示「稍等 1~2 秒会自动刷新」；加载完自动恢复 |
| 文本清洗后为空（整句都是动作/链接） | 不读，`skipped++`，不影响气泡 |
| 任何异常 | 全部 `try/catch` 吞掉，语音问题绝不冒泡到界面 |

`VOICE.status()` 里几个计数用于验收：

- `speakCalls` —— 引擎请求朗读的次数（含降级跳过）；
- `synthCalls` —— 真正调用 `window.speechSynthesis.speak()` 的次数；
- `cancels` / `skipped` / `plays`（`onstart`）/ `ended`（`onend`）/ `errors` / `lastError`。

---

## 6. 验证（2026-11-13，macOS，headless Chrome + 本地 8899 dev server）

### 6.1 构建状态

```bash
cd .
python3 build.py
#   + 增强贴图 10 张
#   built v2.5.0: client.js 1,594,501 B / lab 426,596 B / assets 19
```

`build.py` 的 `check_syntax()` 用 node `--check` 校验 `zero02-pet/lib/client.js` 与 `lab/bundle.js`，均通过。
`build.py` 只改了 `RAW` 数组：在 `skins2d.js` 之后、`engine2d.js` 之前插入 `src/client/voice.js`。

### 6.2 截图（`shots/voice-*.png`）

| 文件 | 内容 |
| --- | --- |
| `shots/voice-01-settings-off.png` | 设置面板「🗣 02 的声音」区块：默认「🔇 不出声」、试听按钮、提示 `婷婷 (zh-CN) · rate 1.08 / pitch 1.22 · 默认关` |
| `shots/voice-02-settings-on.png` | 点开「🔊 让她说话」后：开关变红、提示变「已开启」、底部结果「已打开：她会用系统语音说话了 ✓」 |
| `shots/voice-03-chat.png` | 聊天面板：真实云端回复；语音 `lastKind=chat`，`shy` 情绪联动（rate 1.03 / pitch 1.30） |
| `shots/voice-04-degrade.png` | 模拟「系统里没有中文语音」：设置面板显示降级提示，调用被静默跳过、`errors=0`、无报错气泡 |
| `shots/voice-05-whale.png` | 鲸鲸皮肤：提示「鲸鲸用更高更奶的声线… rate 1.12 / pitch 1.45」，试听按钮显示 `rate 1.18 / pitch 1.46（情绪 happy）` |
| `shots/voice-06-persist.png` | 刷新页面后（`S.voice.on` 已持久化）：启动开场白被朗读，`lastKind=greet` |

截图命令（节选，`NODE=~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node`）：

```bash
$NODE tools/shot.mjs \
  --url "http://127.0.0.1:8899/preview/?pkg=zero02-pet&z02debug=1&skin=onee" \
  --out shots/voice-02-settings-on.png --size 1000x1000 --wait 1500 \
  --ready "window.__z02 && window.VOICE" \
  --eval "(async () => { for (var i=0;i<60;i++){ if (VOICE.status().zhCount) break; await new Promise(r=>setTimeout(r,150)); } __z02.openPanel('settings'); await new Promise(r=>setTimeout(r,250)); document.querySelector('[data-role=\\'voicesect\\']').scrollIntoView({block:'center'}); document.querySelector('[data-voice=\\'1\\']').click(); return 1; })()" \
  --info "JSON.stringify({enabled: __z02.voiceStatus().enabled, voice: __z02.voiceStatus().voice, lastText: __z02.voiceStatus().lastText, lastParams: __z02.voiceStatus().lastParams})"
```

### 6.3 实测 `window.VOICE.status()`（JSON 摘录，均为真实运行结果）

**① 默认关 + 选中声线**（`voice-01/02`）：

```json
{"supported":true,"enabled":false,"degraded":false,"voice":"婷婷","lang":"zh-CN","localService":true,
 "voiceCount":199,"zhCount":21,
 "lastText":"","lastParams":null,"speakCalls":0,"synthCalls":0,"skipped":1,"errors":0,
 "base":{"rate":1.08,"pitch":1.22,"maxChars":60},"whale":{"rate":1.12,"pitch":1.45}}
```

> `skipped:1` 是启动开场白：语音默认关，`say(hello, {kind:"greet"})` 被开关拦下——这就是「默认不吓人」的证据。

**② 点开开关（UI 点击 → 确认句）**：

```json
{"enabled":true,"lastKind":"toggle","lastText":"嗯，我在。darling，听见了吗？",
 "lastParams":{"rate":1.08,"pitch":1.22,"mood":"normal","skin":"onee","lang":"zh-CN","voice":"婷婷"},
 "speakCalls":1,"synthCalls":1,"plays":1,"cancels":0,"errors":0,"active":true}
```

`plays:1` = utterance 的 `onstart` 真实触发；`synthCalls:1` = `speechSynthesis.speak()` 真实调用（headless 虽然 `--mute-audio` 听不见，但调用链完整）。

**③ 聊天回复朗读 + 情绪联动**（`voice-03-chat.png`，真实云端回复）：

```json
{"chat":{"lastText":"过来吧。清早第一句话就是要抱，你还真不客气呢。",
         "lastParams":{"rate":1.03,"pitch":1.3,"mood":"shy","skin":"onee"},
         "lastKind":"chat","synthCalls":1,"plays":1},
 "sleepy":{"lastText":"唔，再让我靠一会儿嘛。",
           "lastParams":{"rate":0.93,"pitch":1.18,"mood":"sleepy"},
           "cancels":1,"synthCalls":2},
 "moodMap":{"happy":{"rate":1.18,"pitch":1.24},"shy":{"rate":1.03,"pitch":1.3},"sleepy":{"rate":0.93,"pitch":1.18}}}
```

> 回复里的「（张开手臂）」被清洗掉；`shy` 来自 `S.mood=想被抱住，又不好意思直说`；
> 第二条把 `S.mood` 改成「困得软趴趴…」→ rate 0.93，且 `cancels:1` 证明新句前取消了旧句。

**④ 鲸鲸高音 + 试听按钮 + 连续打断**（`voice-05-whale.png`）：

```json
{"whaleSpeak":{"ok":true,"lastText":"darling！鲸鲸来啦！",
               "lastParams":{"rate":1.12,"pitch":1.45,"mood":"normal","skin":"whale"},"plays":1},
 "race":{"cancels":2,"synthCalls":3,"lastText":"第二句，直接打断上一句。","active":true},
 "previewBtn":{"lastKind":"preview","lastParams":{"rate":1.18,"pitch":1.46,"mood":"happy","skin":"whale"},
               "result":"试听中……「婷婷」rate 1.18 / pitch 1.46（情绪 happy）"},
 "whaleHint":"鲸鲸用更高更奶的声线：「婷婷」（zh-CN）· 参数 rate 1.12 / pitch 1.45 · 已开启。…"}
```

**⑤ 无中文语音的静默降级**（`voice-04-degrade.png`，把 `getVoices()` 模拟成只有英文语音）：

```json
{"before":{"voice":"婷婷","zhCount":21,"synthCalls":0},
 "after":{"supported":true,"enabled":true,"degraded":true,"reason":"no-zh-voice",
          "voice":"","voiceCount":2,"zhCount":0,
          "lastText":"这句应该被静默降级，不出声也不报错。",
          "lastParams":{"rate":1.08,"pitch":1.22},
          "speakCalls":1,"synthCalls":0,"skipped":2,"errors":0,"lastError":""},
 "hint":"系统里没有中文语音，已静默降级（不会用英文嗓音硬念中文）。macOS：系统设置 → 辅助功能 → 朗读内容 → 系统声音 → 管理声音，下载「婷婷 / 美佳」后回来刷新。",
 "hasErrorBox":false}
```

**⑥ 持久化 + 开场朗读 + 摸头/投喂 + 与音效独立**（`voice-06-persist.png`）：

```json
{"afterReload":{"enabled":true,"voice":"婷婷","synthCalls":1,"lastKind":"greet",
                "lastText":"早。能一睁眼就看到你，还不错。","plays":1,"errors":0},
 "persistedL":{"on":true},
 "soundOffPet":{"lastKind":"pet","lastText":"谁准你摸的。再摸一下，也不是不行。","synthCalls":2,"enabled":true,"sound":false},
 "feed":{"lastKind":"feed","lastText":"巧克力，还行。下次，要亲手喂我。","synthCalls":3}}
```

> `S.voice.on` 写进 localStorage 后刷新仍生效；把 `S.sound` 关掉（静音）后，摸头/投喂照样朗读 —— 两个开关独立。

**⑦ 面板关闭 / 页面隐藏自动停口**：

```json
{"s1":{"synthCalls":1,"cancels":0,"active":true},
 "afterClosePanel":{"cancels":1,"active":false},
 "afterVisibilityHidden":{"cancels":2,"active":false,"errors":0,"lastError":""}}
```

### 6.4 手动验收步骤

1. 打开 <http://127.0.0.1:8899/preview/?pkg=zero02-pet&z02debug=1&skin=onee>；
2. 右键 02 → 设置 → 找到「🗣 02 的声音（系统 TTS）」，默认是「🔇 不出声」；
3. 点「试听一句」应能听到（本机声卡正常时）「哼，darling。……我的声音，你听见了吗？」；
4. 点「🔊 让她说话」→ 会先读一句「嗯，我在。darling，听见了吗？」；
5. 打开聊天说一句，回复会被朗读（括号里的动作、emoji 不读）；
6. 刷新页面，开关状态保持；摸头/投喂 / 她主动开口也会读出短句；
7. 切到鲸鲸皮肤，音高明显更高（pitch 1.45+）。

---

## 7. 调试 API（`?z02debug=1` 时可用）

| API | 作用 |
| --- | --- |
| `window.VOICE` | voice 模块本体：`status() / speak() / test() / plan() / cancel() / refresh() / cleanText() / classifyMood() / paramsFor()` |
| `__z02.voiceStatus()` | 同 `VOICE.status()`（设置面板里显示的信息都在这里） |
| `__z02.voiceHint()` | 设置面板当前会显示的提示文案 |
| `__z02.setVoice(true/false)` | 开/关语音（静默，不播放确认句；持久化） |
| `__z02.voiceSay(text, opts)` | 强制朗读一句（无视开关，用于验收） |
| `__z02.voiceTest(opts)` | 同设置面板「试听一句」 |
| `__z02.voicePlan(text, opts)` | 干跑：返回清洗后的文本 + 参数，不发声（无中文语音环境也能验证参数） |
| `__z02.voiceParams(text, opts)` | 只算参数（`{rate, pitch, mood, skin, …}`） |
| `__z02.voiceCancel()` | 停止当前朗读 |

例：

```js
// 打开开关并说一句
__z02.setVoice(true);
__z02.voiceSay("（凑近）darling，听见我的声音了吗？");
// 看状态
__z02.voiceStatus().lastText;    // "darling，听见我的声音了吗？"
__z02.voiceStatus().lastParams;  // { rate: 1.08, pitch: 1.22, ... }
```

---

## 8. 已知限制 / 后续可做

1. **不是 02 的原版声优**：系统 TTS 只能力求「少女感」，音色取决于用户系统装了哪些中文语音；
   macOS 建议装「婷婷 / 美佳」，Windows 自带「晓晓/慧慧」，效果都还行。想要更贴，后续可以换
   VITS/GPT-SoVITS 之类的本地声线模型（接口就在 `VOICE.speak` 这一层，换实现不影响引擎）。
2. **浏览器自动播放策略**：页面刚打开、用户还没点过任何东西时，部分浏览器会拒绝
   `speechSynthesis.speak()`（`onerror: not-allowed`）。本实现会静默吞掉；用户点一下开关/聊天后就正常。
3. **网络语音**：Chrome 的 `Google 普通话` 是网络语音，离线时可能无声；本机会优先选
   `localService` 的语音（婷婷/美佳），所以一般没问题。
4. **`--mute-audio` 的 headless 验收**：本次 headless Chrome 能拿到真实语音列表并触发
   `onstart`（`plays:1`），但截图工具默认静音，只能验证「调用链 + 参数 + 状态」，听感需要在真机浏览器点一次试听确认。
5. 未做「语音输入」（STT）—— 本轮只负责让她说话，听你说话是另一条链路。
