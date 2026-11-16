/* ============================================================================
 * 02 的声音 —— 系统 TTS（Web Speech API）少女声线 + 情绪语调联动
 * ----------------------------------------------------------------------------
 * RAW 模块（和 engine2d / persona / skins2d 共享作用域），必须在 engine2d 之前
 * 拼接，但在引擎启动（boot）前不会碰 S / SKIN 等后面才声明的变量。
 *
 * 只做一件事：把一段中文「说得像 02」——
 *   1) 从 speechSynthesis.getVoices() 里挑最像少女的中文女声
 *      （Tingting / Meijia / 婷婷 / 美佳 / 晓晓 … 优先，zh-CN 优先）；
 *   2) 清洗文本：去掉（动作）括号、emoji、URL、markdown，截断到 ~60 字；
 *   3) 按情绪调 rate / pitch（开心快一点、害羞软一点、困了慢一点），
 *      鲸鲸皮肤用更高更奶的声线；
 *   4) 竞态：开口前先 cancel 旧句；页面隐藏自动停；voices 异步加载（轮询 +
 *      onvoiceschanged）；没有中文语音时静默降级，绝不报错、绝不卡 UI。
 *
 * 开关与持久化在 engine2d（S.voice.on，默认关），本模块只负责「发声」。
 * 调试入口：window.VOICE.status() / speak() / test() / cleanText() / paramsFor()
 * ========================================================================== */
var VOICE = (function () {
  "use strict";

  /* ------------------------------ 参数表 ------------------------------ */
  var CFG = {
    baseRate: 1.08,          // 02 的少女基准语速（1.05~1.15 区间）
    basePitch: 1.22,         // 02 的少女基音（1.15~1.35 区间）
    baseVolume: 1,
    whaleRate: 1.12,         // 鲸鲸：rate 稍快
    whalePitch: 1.45,        // 鲸鲸：更高更奶（1.4+）
    maxChars: 60,            // 单句最多读 ~60 字，长回复截断
    rateClamp: [0.8, 1.4],
    pitchClamp: [0.9, 1.7],
    // 情绪 → rate / pitch 偏移（叠加在基准值上）
    moodScale: {
      happy: { rate: 0.1, pitch: 0.02 },    // 开心 → 语速 +0.1
      shy: { rate: -0.05, pitch: 0.08 },    // 害羞 → 更软更高、稍慢
      sleepy: { rate: -0.15, pitch: -0.04 },// 困 → 慢 0.15
      soft: { rate: -0.06, pitch: 0.02 },   // 危险地温柔 / 占有欲：轻而慢
      sad: { rate: -0.08, pitch: -0.02 },   // 心疼 / 低落：更慢更低
      normal: { rate: 0, pitch: 0 },
    },
  };

  /* ------------------------------ 状态 ------------------------------ */
  var synth = null;
  var Utter = null;
  try {
    if (typeof window !== "undefined") {
      synth = window.speechSynthesis || null;
      Utter = window.SpeechSynthesisUtterance || null;
    }
  } catch (error) {
    synth = null;
    Utter = null;
  }

  var state = {
    supported: !!(synth && Utter),
    voices: [],
    zhVoices: [],
    picked: null,
    lastText: "",
    lastParams: null,
    lastKind: "",
    lastAt: 0,
    speakCalls: 0,   // 引擎请求朗读次数（含降级跳过）
    synthCalls: 0,   // 真正调用 speechSynthesis.speak 的次数
    cancels: 0,
    skipped: 0,
    plays: 0,
    ends: 0,
    errors: 0,
    lastError: "",
    token: 0,        // 朗读代号：旧句的回调不覆盖新状态
    active: false,
    degraded: !(synth && Utter),
    reason: (synth && Utter) ? "voices-loading" : "unsupported",
    listening: false,
    lastRefreshAt: 0,
  };

  function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }
  function round2(n) { return Math.round(n * 100) / 100; }

  /* --------------------------- 挑中文少女声线 --------------------------- */
  // 按「最像 02 的少女中文声线」打分：macOS 婷婷/美佳 > Windows 晓晓/慧慧 > 其它中文女声
  var VOICE_WANTS = [
    ["tingting", 120], ["婷婷", 120],
    ["meijia", 110], ["美佳", 110],
    ["xiaoxiao", 104], ["晓晓", 104],
    ["xiaoyi", 100], ["晓伊", 100],
    ["huihui", 96], ["慧慧", 96],
    ["yaoyao", 92], ["瑶瑶", 92],
    ["lili", 88], ["丽丽", 88],
    ["female", 46], ["女", 40],
    ["google 普通话", 64], ["google 國語", 52],
  ];

  function isChineseVoice(v) {
    if (!v) return false;
    var lang = String(v.lang || "").toLowerCase();
    if (lang.indexOf("zh") === 0) return true;
    return /中文|普通话|國語|国语|粤语|粵語|chinese|mandarin|cantonese/i.test(String(v.name || ""));
  }

  function scoreVoice(v) {
    var name = String(v.name || "").toLowerCase();
    var lang = String(v.lang || "").toLowerCase();
    var score = 0;
    for (var i = 0; i < VOICE_WANTS.length; i++) {
      var key = VOICE_WANTS[i][0];
      if (name.indexOf(key.toLowerCase()) >= 0) score += VOICE_WANTS[i][1];
    }
    if (lang.indexOf("zh-cn") === 0 || lang.indexOf("zh_cn") === 0) score += 20;
    else if (lang.indexOf("zh-tw") === 0 || lang.indexOf("zh_tw") === 0) score += 12;
    else if (lang === "zh") score += 10;
    if (/male|男/.test(name)) score -= 50;      // 男声直接降权
    if (v.localService) score += 6;             // 本机语音更稳（不依赖网络）
    return score;
  }

  /** 重新扫描系统语音。voices 是异步给的，所以会被轮询多次调用。 */
  function refresh(force) {
    if (!state.supported) return state.zhVoices;
    var now = Date.now();
    if (!force && state.picked && now - state.lastRefreshAt < 4000) return state.zhVoices;
    state.lastRefreshAt = now;
    var list = [];
    try { list = synth.getVoices() || []; } catch (error) { list = []; }
    state.voices = list;
    var zh = [];
    for (var i = 0; i < list.length; i++) {
      if (isChineseVoice(list[i])) zh.push(list[i]);
    }
    state.zhVoices = zh;
    var best = null;
    var bestScore = -1000;
    if (state.forcedVoice) {
      for (var f = 0; f < zh.length; f++) {
        if (String(zh[f].name) === state.forcedVoice) { best = zh[f]; break; }
      }
    }
    for (var j = 0; !best && j < zh.length; j++) {
      var s = scoreVoice(zh[j]);
      if (s > bestScore) { bestScore = s; best = zh[j]; }
    }
    if (best) {
      state.picked = best;
      state.degraded = false;
      state.reason = "";
    } else {
      state.picked = null;
      state.degraded = true;
      state.reason = list.length ? "no-zh-voice" : "voices-loading";
    }
    return zh;
  }

  /** voices 异步加载：onvoiceschanged + 定时轮询（Chrome 有时既不触发事件也返回空） */
  function initVoices() {
    if (!state.supported || state.listening) return;
    state.listening = true;
    try {
      if (typeof synth.addEventListener === "function") {
        synth.addEventListener("voiceschanged", function () { refresh(true); });
      }
    } catch (error) {}
    try {
      synth.onvoiceschanged = function () { refresh(true); };
    } catch (error) {}
    var delays = [0, 250, 700, 1500, 2800, 4500, 7000, 10000];
    for (var i = 0; i < delays.length; i++) {
      (function (delay) {
        setTimeout(function () { try { refresh(true); } catch (error) {} }, delay);
      })(delays[i]);
    }
  }

  /* ----------------------------- 文本清洗 ----------------------------- */
  var RE_URL = /https?:\/\/[^\s）)】\]，。！？；、]+/gi;
  var RE_EMOJI = /[\u{1F000}-\u{1FAFF}]/gu;
  var RE_SYMBOLS = /[\u{2600}-\u{27BF}]/gu;
  var RE_MISC = /[\u{2B00}-\u{2BFF}]/gu;
  var RE_MARKS = /[\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{200B}-\u{200F}]/gu;

  /**
   * 把回复变成适合朗读的一句话：
   * 去掉（动作/旁白/表情）、emoji、URL、markdown、HTML、装饰符号；
   * 重复省略号/波浪号换成逗号停顿。
   */
  function cleanText(text) {
    var t = String(text == null ? "" : text);
    if (!t) return "";
    // markdown 图片/链接：保留文字，去掉地址
    t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
    t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
    // URL
    t = t.replace(RE_URL, " ");
    t = t.replace(/www\.[^\s）)】\]，。！？；、]+/gi, " ");
    // 括号里的动作/旁白：中英文圆括号、方括号、书名号式注解（跑几遍处理嵌套）
    for (var i = 0; i < 3; i++) {
      t = t.replace(/（[^（）]*）/g, " ");
      t = t.replace(/\([^()]*\)/g, " ");
      t = t.replace(/【[^【】]*】/g, " ");
      t = t.replace(/\[[^\[\]]*\]/g, " ");
      t = t.replace(/〔[^〔〕]*〕/g, " ");
      t = t.replace(/｛[^｛｝]*｝/g, " ");
    }
    // 引号/书名号只保留内容
    t = t.replace(/[「」『』《》〈〉“”‘’]/g, "");
    // markdown 标记 / HTML 标签
    t = t.replace(/[*_`#>~|\\]+/g, " ");
    t = t.replace(/<[^>]{1,40}>/g, " ");
    // emoji 与图形符号
    t = t.replace(RE_EMOJI, "");
    t = t.replace(RE_SYMBOLS, "");
    t = t.replace(RE_MISC, "");
    t = t.replace(RE_MARKS, "");
    t = t.replace(/[★☆♪♫♡♥►▶●○◆◇]/g, "");
    // 省略号/波浪号 → 逗号停顿，TTS 更自然
    t = t.replace(/[…]{2,}|\.{3,}/g, "，");
    t = t.replace(/[~〜～]+/g, "，");
    // 标点叠在一起（比如「。，」「？！～」）收成一个，避免 TTS 读出怪停顿
    t = t.replace(/[，。！？；：、]{2,}/g, function (run) {
      var strong = run.match(/[。！？]/);
      return strong ? strong[0] : run.charAt(0);
    });
    // 空白与首尾标点
    t = t.replace(/\s+/g, " ").trim();
    t = t.replace(/^[\s，,、。；;：:！!？?…—\-·]+/, "");
    t = t.replace(/[\s，,、；;：:—\-·]+$/, "");
    // 中文之间、标点两侧不用空格（TTS 读起来更连贯）
    t = t.replace(/\s*([，。！？；：、])\s*/g, "$1");
    t = t.replace(/([\u4e00-\u9fa5])\s+(?=[\u4e00-\u9fa5])/g, "$1");
    t = t.replace(/([\u4e00-\u9fa5])\s+([，。！？；：、])/g, "$1$2");
    return t;
  }

  /** 长文本截断到 maxChars，尽量在最后一个句读处收尾 */
  function truncate(text, maxChars) {
    var t = String(text || "");
    var max = Number(maxChars) || CFG.maxChars;
    if (t.length <= max) return t;
    var cut = t.slice(0, max);
    var m = cut.match(/^[\s\S]*[。！？!?；;，,、…]/);
    if (m && m[0].length >= max * 0.5) cut = m[0];
    cut = cut.replace(/[\s，,、；;：:]+$/, "");
    return cut + "…";
  }

  /* ----------------------------- 情绪识别 ----------------------------- */
  /** 从 mood 文案 / 回复原文猜情绪，只用于调 rate/pitch */
  function classifyMood(text) {
    var t = String(text || "");
    if (!t) return "normal";
    if (/(困|睡觉|晚安|好累|打哈欠|懒懒|犯困|眯)/.test(t)) return "sleepy";
    if (/(害羞|脸红|别这样|讨厌啦|笨蛋|谁准|才不是|哼|嘴硬|耳朵尖|不好意思|心跳|脸红红)/.test(t)) return "shy";
    if (/(危险|不许|占有|圈在|护着|只能|吃醋|不准)/.test(t)) return "soft";
    if (/(开心|心情很好|高兴|喜欢|太好了|真棒|嘿嘿|哈哈|ふふ|想见你|撒娇|黏)/.test(t)) return "happy";
    if (/(难过|委屈|心疼|哭|撑不住)/.test(t)) return "sad";
    return "normal";
  }

  /**
   * 算这一句的朗读参数。
   * opts: { skin:"onee|genki|chibi|whale", mood:"S.mood 文案", moodText:"回复原文", moodId:"强制情绪" }
   */
  function paramsFor(opts) {
    opts = opts || {};
    var whale = opts.skin === "whale";
    var baseRate = whale ? CFG.whaleRate : CFG.baseRate;
    var basePitch = whale ? CFG.whalePitch : CFG.basePitch;
    // 鲸鲸不吃 02 的 S.mood（那是 02 的情绪），只按自己的台词猜
    var moodText = whale ? (opts.moodText || "") : (opts.mood || opts.moodText || "");
    var mood = opts.moodId || classifyMood(moodText);
    var delta = CFG.moodScale[mood] || CFG.moodScale.normal;
    // 用户自定义（设置面板滑杆）：直接覆盖基准值
    try {
      if (typeof S !== "undefined" && S && S.voice) {
        if (typeof S.voice.rate === "number") baseRate = S.voice.rate;
        if (typeof S.voice.pitch === "number") basePitch = S.voice.pitch;
      }
    } catch (error) {}
    var scale = whale ? 0.6 : 1;   // 鲸鲸的情绪起伏收一点，保持奶声
    var rate = clamp(round2(baseRate + delta.rate * scale), CFG.rateClamp[0], CFG.rateClamp[1]);
    var pitch = clamp(round2(basePitch + delta.pitch * scale), CFG.pitchClamp[0], CFG.pitchClamp[1]);
    return {
      rate: rate,
      pitch: pitch,
      volume: CFG.baseVolume,
      mood: mood,
      skin: opts.skin || "",
      base: { rate: baseRate, pitch: basePitch },
      lang: state.picked ? String(state.picked.lang || "") : "zh-CN",
      voice: state.picked ? String(state.picked.name || "") : "",
    };
  }

  /* ------------------------------ 朗读 ------------------------------ */
  function voiceEnabled() {
    try {
      return !!(typeof S !== "undefined" && S && S.voice && S.voice.on);
    } catch (error) {
      return false;
    }
  }

  function cancelCurrent() {
    if (!state.supported) return 0;
    var wasActive = false;
    try { wasActive = !!(synth.speaking || synth.pending || state.active); } catch (error) { wasActive = state.active; }
    state.active = false;
    if (!wasActive) return 0;
    state.cancels++;
    try { synth.cancel(); } catch (error) {}
    return 1;
  }

  /** 停止当前朗读（关闭开关、关面板、收起桌宠、页面隐藏时调用） */
  function cancel() {
    state.token++;
    return cancelCurrent() > 0;
  }

  /**
   * 朗读一句。返回 true = 已交给 speechSynthesis；false = 被开关/能力/中文语音拦下。
   * opts: { force, kind, skin, mood, moodText, maxChars }
   *   force=true 时无视 S.voice.on（试听按钮 / 调试 API 用）。
   */
  function speak(text, opts) {
    opts = opts || {};
    if (!voiceEnabled() && !opts.force) { state.skipped++; return false; }
    if (!state.supported) {
      state.skipped++;
      state.degraded = true;
      state.reason = "unsupported";
      return false;
    }
    refresh(false);
    var clean = truncate(cleanText(text), opts.maxChars || CFG.maxChars);
    if (!clean) { cancelCurrent(); state.token++; state.skipped++; return false; }
    var params = paramsFor(Object.assign({}, opts, { clean: clean }));
    state.speakCalls++;
    state.lastText = clean;
    state.lastParams = params;
    state.lastKind = opts.kind || "";
    state.lastAt = Date.now();
    if (!clean) {
      state.skipped++;
      return false;
    }
    if (!state.picked) {
      // 没有中文系统语音：静默降级（绝不用英文嗓音硬念中文），设置面板里提示
      cancelCurrent();
      state.skipped++;
      state.degraded = true;
      state.reason = state.voices.length ? "no-zh-voice" : "voices-loading";
      return false;
    }
    // 竞态：新一句开始前先取消旧句
    cancelCurrent();
    var u;
    try {
      u = new Utter(clean);
    } catch (error) {
      state.errors++;
      state.lastError = "utterance-failed";
      return false;
    }
    var token = ++state.token;
    try {
      u.lang = state.picked.lang || "zh-CN";
      u.voice = state.picked;
      u.rate = params.rate;
      u.pitch = params.pitch;
      u.volume = params.volume;
    } catch (error) {}
    u.onstart = function () { if (token === state.token) { state.plays++; state.active = true; } };
    u.onend = function () { if (token === state.token) { state.ends++; state.active = false; } };
    u.onerror = function (event) {
      if (token !== state.token) return;
      state.active = false;
      var code = (event && event.error) || "speech-error";
      if (code === "canceled" || code === "interrupted") return;   // 主动打断不算错误
      state.errors++;
      state.lastError = String(code);
    };
    try {
      synth.speak(u);
    } catch (error) {
      state.errors++;
      state.lastError = "speak-failed";
      return false;
    }
    state.synthCalls++;
    state.active = true;
    return true;
  }

  /** 按标点切句，让朗读有自然的停顿与语气起伏（合并过短的片段） */
  function splitSegments(clean) {
    var parts = String(clean || "").split(/(?<=[，。！？…；、!?,;\n])/u).filter(function (x) { return x && x.trim(); });
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var t = parts[i].trim();
      if (!t) continue;
      if (out.length && (out[out.length - 1].length < 6 || t.length < 4)) out[out.length - 1] += t;
      else out.push(t);
    }
    if (out.length > 6) {
      var merged = [out[0]];
      for (var j = 1; j < out.length; j++) {
        if (j >= 5) merged[merged.length - 1] += out[j];
        else merged.push(out[j]);
      }
      out = merged;
    }
    return out.length ? out : [clean];
  }

  /**
   * 分段朗读：句与句之间留 60~160ms 停顿、每句音调/语速轻微起伏，听起来更像"在说话"而不是念稿。
   * 返回 true = 已开始。
   */
  function speakSequence(text, opts) {
    opts = opts || {};
    if (!voiceEnabled() && !opts.force) { state.skipped++; return false; }
    if (!state.supported) { state.skipped++; state.degraded = true; state.reason = "unsupported"; return false; }
    refresh(false);
    var clean = truncate(cleanText(text), opts.maxChars || CFG.maxChars);
    if (!clean) { cancelCurrent(); state.token++; state.skipped++; return false; }
    if (!state.picked) {
      cancelCurrent();
      state.skipped++; state.degraded = true;
      state.reason = state.voices.length ? "no-zh-voice" : "voices-loading";
      return false;
    }
    var segs = splitSegments(clean);
    var base = paramsFor(Object.assign({}, opts, { clean: clean }));
    state.speakCalls++;
    state.lastText = clean;
    state.lastParams = base;
    state.lastKind = opts.kind || "";
    state.lastAt = Date.now();
    cancelCurrent();
    var token = ++state.token;
    var idx = 0;
    function speakNext() {
      if (token !== state.token) return false;
      if (idx >= segs.length) { state.active = false; return false; }
      var seg = segs[idx++];
      var u;
      try { u = new Utter(seg); } catch (error) { state.errors++; state.lastError = "utterance-failed"; return false; }
      // 每句做一点语气起伏：中间句略低/略快，末句回落
      var jitter = idx % 3 === 1 ? -0.02 : idx % 3 === 2 ? 0.03 : 0;
      try {
        u.lang = base.lang || "zh-CN";
        u.voice = state.picked;
        u.rate = Math.min(CFG.rateClamp[1], Math.max(CFG.rateClamp[0], base.rate + jitter * 0.5));
        u.pitch = Math.min(CFG.pitchClamp[1], Math.max(CFG.pitchClamp[0], base.pitch + jitter));
        u.volume = base.volume;
      } catch (error) {}
      u.onstart = function () {
        if (token !== state.token) return;
        state.plays++;
        state.active = true;
      };
      u.onend = function () {
        if (token !== state.token) return;
        state.ends++;
        if (idx >= segs.length) { state.active = false; return; }
        var gap = 60 + Math.random() * 100 + (seg.charAt(seg.length - 1) === "。" ? 60 : 0);
        setTimeout(function () { if (token === state.token) speakNext(); }, gap);
      };
      u.onerror = function (event) {
        if (token !== state.token) return;
        var code = (event && event.error) || "speech-error";
        if (code === "canceled" || code === "interrupted") return;
        state.errors++;
        state.lastError = String(code);
        // 出错就跳过这一句继续
        setTimeout(function () { if (token === state.token) speakNext(); }, 40);
      };
      try { synth.speak(u); } catch (error) { state.errors++; state.lastError = "speak-failed"; return false; }
      state.synthCalls++;
      state.active = true;
      return true;
    }
    return speakNext();
  }

  /** 试听一句（无视开关，用户点了按钮就是明确要听） */
  var PREVIEW_TEXT = "哼，darling。……我的声音，你听见了吗？";
  function test(opts) {
    var o = Object.assign({ kind: "preview", force: true, moodId: "happy" }, opts || {});
    return speak(PREVIEW_TEXT, o);
  }

  /** 干跑：只算清洗结果和参数，不发声（无中文语音的环境里也能验证调用链） */
  function plan(text, opts) {
    opts = opts || {};
    var clean = truncate(cleanText(text), opts.maxChars || CFG.maxChars);
    var params = paramsFor(Object.assign({}, opts, { clean: clean }));
    return {
      clean: clean,
      params: params,
      voice: state.picked ? String(state.picked.name || "") : "",
      wouldSpeak: !!(state.picked && clean),
      degraded: state.degraded,
      reason: state.reason,
    };
  }

  /* ------------------------------ 状态 ------------------------------ */
  function status() {
    var zhNames = [];
    for (var i = 0; i < state.zhVoices.length && i < 8; i++) {
      var v = state.zhVoices[i];
      zhNames.push(String(v.name || "?") + "|" + String(v.lang || "?") + (v.localService ? "|local" : ""));
    }
    return {
      supported: state.supported,
      enabled: voiceEnabled(),
      degraded: state.degraded,
      reason: state.reason,
      // 选中的语音
      voice: state.picked ? String(state.picked.name || "") : "",
      lang: state.picked ? String(state.picked.lang || "") : "",
      localService: state.picked ? !!state.picked.localService : false,
      voiceCount: state.voices.length,
      zhCount: state.zhVoices.length,
      zhVoices: zhNames,
      // 最近一次朗读
      lastText: state.lastText,
      lastParams: state.lastParams,
      lastKind: state.lastKind,
      lastAt: state.lastAt,
      // 调用计数（speakCalls = VOICE.speak 被请求次数；synthCalls = 真正 Web Speech API 调用次数）
      speakCalls: state.speakCalls,
      synthCalls: state.synthCalls,
      cancels: state.cancels,
      skipped: state.skipped,
      plays: state.plays,
      ended: state.ends,
      errors: state.errors,
      lastError: state.lastError,
      active: !!state.active,
      base: { rate: CFG.baseRate, pitch: CFG.basePitch, volume: CFG.baseVolume, maxChars: CFG.maxChars },
      whale: { rate: CFG.whaleRate, pitch: CFG.whalePitch },
      moods: CFG.moodScale,
    };
  }

  /* --------------------------- 初始化与暴露 --------------------------- */
  try { initVoices(); refresh(true); } catch (error) {}

  // 页面切到后台就闭嘴（回来不自动续读，避免打扰）
  try {
    if (typeof document !== "undefined" && document.addEventListener) {
      document.addEventListener("visibilitychange", function () {
        if (document.hidden) cancel();
      });
      window.addEventListener("pagehide", function () { cancel(); });
    }
  } catch (error) {}

  var API = {
    supported: state.supported,
    cfg: CFG,
    status: status,
    speak: speak,
    speakSequence: speakSequence,
    splitSegments: splitSegments,
    cancel: cancel,
    test: test,
    plan: plan,
    refresh: function () { return refresh(true); },
    cleanText: cleanText,
    truncate: truncate,
    classifyMood: classifyMood,
    paramsFor: paramsFor,
    listVoices: function () {
      refresh(false);
      var out = [];
      try {
        var list = synth.getVoices() || [];
        for (var i = 0; i < list.length; i++) {
          var v = list[i];
          var lang = String(v.lang || "");
          if (!/^zh/i.test(lang)) continue;
          out.push({ name: v.name, lang: lang, local: !!v.localService });
        }
      } catch (error) {}
      return out;
    },
    setVoice: function (name) {
      try {
        var want = String(name || "");
        if (!want) { state.forcedVoice = ""; state.picked = null; refresh(false); return true; }
        var list = synth.getVoices() || [];
        var found = null;
        for (var i = 0; i < list.length; i++) {
          if (list[i].name === want) { found = list[i]; break; }
        }
        if (!found) return false;          // 没找到：不假装成功，也不改当前声线
        state.forcedVoice = want;
        state.picked = found;
        return true;
      } catch (error) { return false; }
    },
    previewText: PREVIEW_TEXT,
  };
  try { if (typeof window !== "undefined") window.VOICE = API; } catch (error) {}
  return API;
})();
