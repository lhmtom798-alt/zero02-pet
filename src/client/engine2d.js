/* ============================ 02 桌宠 · 共用引擎 ============================ */
/* 依赖上方 SKINS：每个形象自带 { id,label,size,dock,prompt,lines,render(el)->{setPose,tick} }
   三档模型：local 本地免费 / cloud DeepSeek / auto 本地优先自动降级 */

const API = "/api/" + PLUGIN_ID;
const STORE_KEY = "z02-pet:" + PLUGIN_ID;

const DEFAULT_CFG = {
  // 质量优先：默认走云端（深层人格需要像样的模型），本地只做离线兜底
  mode: "cloud",
  local: { baseURL: "http://127.0.0.1:11434/v1", model: "qwen2.5:3b" },
  // 留空 = 让宿主自动使用 DSH 自己配置的模型端点（不会把 key 下发到浏览器）
  cloud: { baseURL: "", model: "deepseek-flash", apiKey: "" },
};

const MODE_HINT = {
  local: "完全免费、断网也能聊；但小模型演 02 会串味（像客服），只建议离线应急。",
  cloud: "推荐：自动使用 DSH 配置的 deepseek-flash，02 的语气和记性都更稳；按量计费，短对话约 ¥0.001/句。",
  auto: "先云端，连不上再退回本地 Ollama，断网也不会哑。",
};

function loadStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}
function saveStore() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(S));
  } catch {}
}

const SKIN = () => SKINS.find((k) => k.id === S.skin) || SKINS[0];

const S = Object.assign(
  { skin: "onee", dim: "3d", quality: "high", sound: true, affinity: 0, chats: 0, hidden: false, cfg: null, history: [], docked: true, x: 0, y: 0,
    memory: [], mood: "", userName: "", autoChat: null,
    // 02 的日常感（持久化）：每日心情 / 今日小结 / 小日记 / 主动说话开关
    proactive: true, dailyMood: null, todayStats: null, diary: [], lastOpenDate: "",
    // 声音（系统 TTS）：默认关，避免第一次就吓到人；与 sound（音效）互相独立
    voice: { on: false } },
  loadStore()
);
if (S.dim !== "3d" && S.dim !== "2d") S.dim = "3d";
if (!S.quality) S.quality = "high";
// 认识天数：老用户按最近一次打开日期起算
if (!S.firstMeetAt) S.firstMeetAt = Number(S.lastOpenDate ? new Date(S.lastOpenDate + "T00:00:00").getTime() : Date.now());
// 画面风格：默认"动画滤镜"（给 3D canvas 轻微调色 + 柔光暗角）
if (S.picStyle !== "native" && S.picStyle !== "anime") S.picStyle = "anime";
if (S.frame !== "full" && S.frame !== "bust" && S.frame !== "auto") S.frame = "full";
// 加载时也强制上限（防止旧数据/手改 localStorage 导致无限增长）
try {
  S.memory = (S.memory || []).slice(-16);
  S.topics = (S.topics || []).slice(-10);
  S.promises = (S.promises || []).slice(-6);
  S.moments = (S.moments || []).slice(-24);
  S.history = (S.history || []).slice(-40);
  S.diary = (S.diary || []).slice(-14);
  S.journal = (S.journal || []).slice(-14);
  S.visitHours = (S.visitHours || []).slice(-20);
} catch (e) {}
if (typeof S.seenGuide !== "boolean") S.seenGuide = false;
if (!S.voice || typeof S.voice !== "object") S.voice = { on: false };
if (typeof S.voice.on !== "boolean") S.voice.on = false;

/* 旧配置迁移：扁平结构 -> 双端点 */
(function migrate() {
  const old = S.cfg || {};
  if (!old.local || !old.cloud) {
    S.cfg = {
      mode: old.mode || "auto",
      local: Object.assign({}, DEFAULT_CFG.local),
      cloud: Object.assign({}, DEFAULT_CFG.cloud, old.baseURL ? { baseURL: old.baseURL, model: old.model, apiKey: old.apiKey } : {}),
    };
  }
  S.cfg.mode = S.cfg.mode || "auto";
  S.cfg.local = Object.assign({}, DEFAULT_CFG.local, S.cfg.local || {});
  S.cfg.cloud = Object.assign({}, DEFAULT_CFG.cloud, S.cfg.cloud || {});
  delete S.cfg.baseURL;
  delete S.cfg.model;
  delete S.cfg.apiKey;
})();

let root = null, petEl = null, stageEl = null, bubbleEl = null, menuEl = null, panelEl = null;
let renderer = null, lastPose = "", bubbleTimer = 0, idleTimer = 0, busy = false, tapTimer = null;
let pet3d = null;          // 3D 适配层（懒加载）
let fxEmitter = null;      // 3D 粒子
let sfx = null;            // 音效
let nightTimer = 0;
let fxTimer = 0;
let activeDim = "2d";   // 实际渲染形态（3D 不可用时自动回退）

/* ------------------------------ 3D 适配 ------------------------------ */
var ASSET3D = "/api/" + PLUGIN_ID + "/assets?f=";
var MMD_BASE = ASSET3D + "mmd/TDA-ZeroTwo/";
var MMD_BASE_HD = ASSET3D + "mmd/Darling02/";
/* 02 的 3D 模型有两套可选：
 *   classic —— TDA Zero Two（造型最还原：红大衣/黑丝/白靴，online 默认）
 *   hd      —— Darling02 游戏风（脸/贴图更精细，骨架已重建、大衣已换红）
 * 由设置面板切换，S.modelHd 持久化。 */
function buildMmdModels() {
  var hd = !!S.modelHd;
  var base = hd ? MMD_BASE_HD : MMD_BASE;
  var file = hd ? "Darling02_fixed.pmx" : "ZeroTwo_TDA.pmx";
  var strandsOn = !hd && S.hairStrands !== false;
  var common = {
    url: base + file, textureBase: base,
    shadeOpts: { gradeTextures: false },
    hairStrands: strandsOn,
    faceSculpt: { x: 0.05, y: -0.03, chin: 0.08, jaw: 0.08 },
    hairVolume: 1.06,
    camera: { margin: 1.04, elevation: 0.05 },
  };
  if (hd) {
    // Darling 身高 24.29（TDA 19.69），取景由包围盒自适应；手臂略外张 + 表情名不同
    common.shadeOpts = Object.assign({}, common.shadeOpts, { eyeScale: 1.0, hairTint: [1.0, 0.97, 1.0], accentTint: [1.02, 1.0, 0.92] });
    common.camera = { margin: 1.06, elevation: 0.42 };
    // Darling 的脸比例本来就更贴动画，不要套 TDA 的头型微调（会把它的脸压歪）
    common.faceSculpt = null;
    common.hairVolume = 1;
    // Darling rest 姿势是 A-pose（手臂已下垂），所以所有"抬手"状态的角度要按 A-pose 重标
    common.poseOverrides = {
      happy: {
        "左肩": [0, 0, 0.15], "右肩": [0, 0, -0.15],
        "左腕": [0, 0.05, -0.85], "右腕": [0, -0.05, 0.85],
        "左ひじ": [0, 0, -0.4], "右ひじ": [0, 0, 0.4],
      },
      pat: {
        "左肩": [0, 0, 0.1], "右肩": [0, 0, -0.1],
        "左腕": [0, 0.1, -0.9], "右腕": [0, -0.1, 0.9],
        "左ひじ": [0, 0, -0.6], "右ひじ": [0, 0, 0.6],
      },
      shy: {
        "左肩": [0, 0, 0.08], "右肩": [0, 0, -0.08],
        "左腕": [0, 0.08, -0.85], "右腕": [0, -0.08, 0.85],
        "左ひじ": [0, 0, -0.9], "右ひじ": [0, 0, 0.9],
      },
      talk: {
        "左腕": [0, 0.05, -0.9], "右腕": [0, -0.05, 0.9],
        "左ひじ": [0, 0, -0.3], "右ひじ": [0, 0, 0.3],
      },
      sleep: {
        "左腕": [0, 0, -0.95], "右腕": [0, 0, 0.95],
        "左ひじ": [0, 0, -0.2], "右ひじ": [0, 0, 0.2],
      },
      stretch: {
        "左肩": [0, 0, 0.3], "右肩": [0, 0, -0.3],
        "左腕": [0, 0, 0.55], "右腕": [0, 0, -0.55],
        "左ひじ": [0, 0, -0.3], "右ひじ": [0, 0, 0.3],
      },
      wink: {
        "左腕": [0, 0, -1.0], "右腕": [0, 0, 1.0],
        "左ひじ": [0, 0, -0.2], "右ひじ": [0, 0, 0.2],
      },
      eat: {
        "右肩": [0, 0, -0.1], "右腕": [0, 0, -0.75],
        "右ひじ": [0, 0, -1.4],
        "左腕": [0, 0, -1.0], "左ひじ": [0, 0, 0],
      },
    };
    // Darling 的"笑い"morph 张嘴幅度大，权重整体调低
    common.exprOverrides = {
      happy: { tease: 0.7, smile: 0, blink: 0.2 },
      pat: { tease: 0.85, smile: 0, blush: 0.9, blink: 0.2 },
      shy: { shy: 0.9, smile: 0, jito: 0.3, blink: 0.2 },
      stretch: { surprise: 0.3, nicon: 0.5, smile: 0.1 },
      wink: { winkR: 0.9, nicon: 0.4, smile: 0 },
      eat: { mouthA: 0.5, smile: 0, tongue: 0.3 },
      talk: {},
    };
  }
  return {
    onee: Object.assign({}, common, {
      label: "02 · 御姐", height: hd ? 6.2 : 5.0,
      armIdle: hd ? 1.05 : 1.14, armForwardX: hd ? -0.05 : -0.12,
      glowColor: 0xff6f96,
    }),
    genki: Object.assign({}, common, {
      label: "02 · 元气", height: hd ? 6.2 : 5.0,
      armIdle: hd ? 1.0 : 1.1, armForwardX: hd ? -0.08 : -0.16,
      glowColor: 0xff8f6f,
      // 和御姐区分：更亮更粉的头发、更鲜的衣服
      hairTint: [1.1, 0.95, 1.03], clothTint: [1.07, 1.0, 0.99],
      skinTint: [1.06, 1.0, 1.02],
      // 元气：白贝雷帽（对应 2D 立绘里的白色帽子）
      beret: { radius: 1.14, flat: 0.6, y: 2.06, z: -0.14, tilt: -0.2, roll: 0.08 },
    }),
    chibi: Object.assign({}, common, {
      label: "02 · Q版", height: hd ? 5.6 : 4.4,
      headScale: 1.45, idleWave: true,
      armIdle: hd ? 0.8 : 0.75, armForwardX: hd ? -0.06 : -0.15,
      glowColor: 0xff6f96,
      camera: { margin: 1.02, elevation: 0.05 },
    }),
  };
}
var MMD_MODELS = buildMmdModels();
S.modelHd = !!S.modelHd;
// 鲸鲸：DeepSeek 鲸鱼娘 VRM（本身就是蓝发女仆鲸鱼）
var VRM_MODELS = {
  whale: {
    url: ASSET3D + "models/whale.vrm", label: "鲸鲸", height: 3.9, glowColor: 0x6fb7ff,
    relaxedFactor: 0, idleRelaxed: 0, sleepTilt: 0.55, floatY: 0.012, swayZ: 0.035,
    camera: { margin: 1.05, elevation: 0.05 },
    light: { ambient: 0.24, hemi: 0.16, key: 0.95, fill: 0.35, rim: 0.6 },
    style: { lookdev: false, outlinePx: 1.1 },
  },
};
var vrmPreloading = {};
var failed3dSkins = {};

function ensure3d() {
  if (pet3d) return pet3d;
  try {
    if (!window.THREE) throw new Error("THREE 未就绪");
    var K = __req("kit").create(window.THREE);
    var FIG = __req("fig").create(K, window.THREE);
    var registry = __req("registry").create(K, FIG, window.THREE);
    pet3d = __req("pet3d").create({
      THREE: window.THREE, K: K, FIG: FIG, registry: registry,
      host: stageEl, quality: S.quality || "high",
    });
    // 模型解析失败（文件损坏/加载中断）→ 退回 2D 立绘，避免"看不见但还在交互"
    pet3d.onMountFail = function (skin, error) {
      try {
        console.warn("[zero02] 3D 挂载失败，回退 2D", skin, error);
        failed3dSkins[skin] = true;
        drop3d();
        if (S.dim === "3d") { S.dim = "2d"; saveStore(); }
        mountRenderer(S.skin);
        say("……加载失败了。那先这样陪你吧。", 4200, { kind: "event" });
      } catch (e) {}
    };
    // 接入 MMD（02）+ VRM（鲸鲸）两个模型 provider，组合成一个给 pet3d
    var providers = [];
    try {
      MMD_MODELS = buildMmdModels();
      var mmdMod = __req("mmdchar");
      if (mmdMod && mmdMod.create) {
        providers.push(mmdMod.create({ THREE: window.THREE, K: K, stage: pet3d.stage, models: MMD_MODELS }));
      }
    } catch (error) {
      console.warn("[zero02] MMD 角色接入失败", error);
    }
    try {
      var vrmchar = __req("vrmchar");
      if (vrmchar && vrmchar.create) {
        providers.push(vrmchar.create({
          THREE: window.THREE, K: K, stage: pet3d.stage,
          models: VRM_MODELS, styleModule: "vrm-look",
        }));
      }
    } catch (error) {
      console.warn("[zero02] VRM 角色接入失败", error);
    }
    if (providers.length) {
      var composite = {
        listModels: function () {
          var ids = [];
          providers.forEach(function (p) { try { ids = ids.concat(p.listModels()); } catch (e) {} });
          return ids;
        },
        ready: function (id) {
          for (var i = 0; i < providers.length; i++) {
            try { if (providers[i].listModels().indexOf(id) >= 0) return providers[i].ready(id); } catch (e) {}
          }
          return false;
        },
        preload: function (id) {
          for (var i = 0; i < providers.length; i++) {
            try {
              if (providers[i].listModels().indexOf(id) >= 0) return providers[i].preload(id);
            } catch (e) {}
          }
          return null;
        },
        build: function (id) {
          for (var i = 0; i < providers.length; i++) {
            try {
              if (providers[i].listModels().indexOf(id) >= 0) return providers[i].build(id);
            } catch (e) {}
          }
          throw new Error("没有模型: " + id);
        },
      };
      pet3d.setProvider(composite);
      try { window.__z02Providers = providers; } catch (e) {}
      // 后台预热当前皮肤，减少首次切换等待
      setTimeout(function () {
        try { composite.preload(S.skin); } catch (e) {}
      }, 300);
    }
    var fx = __req("fx");
    if (fx && fx.create && pet3d.stage) fxEmitter = fx.create(K, window.THREE).createEmitter(pet3d.stage.root);
  } catch (error) {
    console.warn("[zero02] 3D 初始化失败，退回 2D", error);
    pet3d = null;
  }
  return pet3d;
}

/** 画面风格：给 3D canvas 加轻微调色 + 柔光暗角，更像动画截图 */
/* 今日心情 → 画面轻微色调（很淡，只让氛围变一点点） */
const MOOD_TONE = {
  clingy: { filter: "saturate(1.08) contrast(1.04) brightness(1.012) hue-rotate(-4deg)", center: "rgba(255,225,240,0.075)", edge: "rgba(60,22,50,0.17)" },
  tsundere: { filter: "saturate(1.06) contrast(1.05) brightness(1.01)", center: "rgba(255,235,240,0.06)", edge: "rgba(46,18,40,0.18)" },
  sweets: { filter: "saturate(1.1) contrast(1.045) brightness(1.02) hue-rotate(3deg)", center: "rgba(255,240,220,0.08)", edge: "rgba(58,30,24,0.16)" },
  praise: { filter: "saturate(1.1) contrast(1.045) brightness(1.022) hue-rotate(-6deg)", center: "rgba(255,226,238,0.085)", edge: "rgba(64,20,46,0.16)" },
  dangerous: { filter: "saturate(1.05) contrast(1.07) brightness(0.995) hue-rotate(4deg)", center: "rgba(255,220,228,0.05)", edge: "rgba(38,8,26,0.22)" },
  lazy: { filter: "saturate(0.97) contrast(1.0) brightness(1.015) hue-rotate(6deg)", center: "rgba(220,232,255,0.06)", edge: "rgba(18,26,52,0.18)" },
};

function applyPicStyle() {
  try {
    var c = stageEl ? stageEl.querySelector("canvas") : null;
    var old = stageEl ? stageEl.querySelector('[data-role="z02-vignette"]') : null;
    if (old) old.remove();
    if (!c) return;
    if (S.picStyle === "anime" && S.quality !== "low") {
      var tone = MOOD_TONE[(S.dailyMood && S.dailyMood.id) || ""] || MOOD_TONE.tsundere;
      c.style.filter = tone.filter;
      var g = document.createElement("div");
      g.setAttribute("data-role", "z02-vignette");
      g.style.cssText = "position:absolute;inset:0;pointer-events:none;background:radial-gradient(ellipse at 50% 42%, " + tone.center + ", " + tone.edge + " 78%);mix-blend-mode:soft-light;";
      stageEl.appendChild(g);
    } else {
      c.style.filter = "";
    }
  } catch (e) {}
}

function drop3d() {
  if (fxEmitter) { try { fxEmitter.dispose(); } catch (e) {} fxEmitter = null; }
  if (pet3d) { try { pet3d.dispose(); } catch (e) {} pet3d = null; }
}

function ensureSfx() {
  if (sfx) return sfx;
  try {
    var m = __req("sfx");
    if (m && m.create) {
      sfx = m.create();
      sfx.setEnabled(S.sound !== false);
    }
  } catch (error) { sfx = null; }
  return sfx;
}

function playSfx(name) {
  if (S.sound === false) return;
  try { ensureSfx(); if (sfx) sfx.play(name); } catch (error) {}
}

/** 挂载渲染器：优先 3D（VRM 模型），失败再退回 2D 立绘 */
/** 当前是否半身取景（自动模式在小窗口下开启） */
/** 拍一张她的照片（导出 PNG） */
function takePhoto(silent) {
  try {
    var url = "";
    if (pet3d && pet3d.snapshot) url = pet3d.snapshot();
    if (!url && stageEl) {
      var cv = stageEl.querySelector("canvas");
      if (cv) url = cv.toDataURL("image/png");
    }
    if (!url) return false;
    var a = document.createElement("a");
    a.href = url;
    a.download = "zero02-" + todayKey() + ".png";
    a.click();
    if (!silent) say("（配合地看镜头）……拍好了？让我看看。", 2600, { kind: "event" });
    return true;
  } catch (e) { return false; }
}

function frameIsBust() {
  try {
    if (S.frame === "bust") return true;
    if (S.frame !== "auto") return false;
    var h = (root && root.getBoundingClientRect ? root.getBoundingClientRect().height : 0) || (S.customSize || 0);
    return h > 0 && h <= 330;
  } catch (e) { return false; }
}

function mountRenderer(id) {
  var next = SKINS.find(function (k) { return k.id === id; });
  if (!next) return null;
  renderer = null;
  var p3 = (S.dim === "3d" && !failed3dSkins[id]) ? ensure3d() : null;
  if (p3) {
    // 清掉 2D 立绘残留，保留 3D 自己的 canvas
    var leftovers = stageEl.querySelectorAll("img, .z02-placeholder");
    for (var i = 0; i < leftovers.length; i++) leftovers[i].remove();
    // VRM 模型可能还在加载：vrmchar 会先返回占位角色，解析完自动挂上
    if (p3.load(id)) renderer = p3;
  }
  setTimeout(applyPicStyle, 120);
  setTimeout(applyPicStyle, 900);
  setTimeout(applyPicStyle, 2400);
  if (renderer) {
    [900, 2600, 5200].forEach(function (d) {
      setTimeout(function () {
        try { if (pet3d) pet3d.bust(frameIsBust()); } catch (e) {}
      }, d);
    });
  }
  if (!renderer) {
    if (pet3d) drop3d();
    stageEl.innerHTML = "";
    try {
      renderer = next.render(stageEl);
    } catch (error) {
      renderer = null;
      console.warn("[02] 2D 形象渲染失败", error);
    }
  }
  activeDim = renderer && renderer.type === "3d" ? "3d" : "2d";
  lastPose = "";
  setPose("idle");
  applyGeometry();
  return renderer;
}

/** 3D 里撒一把粒子（心/星星/音符） */
function burst(kind, opts) {
  if (!fxEmitter) return;
  try {
    var o = Object.assign({}, opts || {});
    // fx 模块按 4.4 的基准身高缩放粒子；换成原生尺寸的 MMD 模型（~19.7）时要把比例打回去
    var h = pet3d ? pet3d.height() : 4.4;
    if (h && h > 0.1) o.scale = (o.scale || 1) * (4.4 / h);
    fxEmitter.burst(kind, o);
  } catch (error) {}
}

/* ------------------------------- 样式 ------------------------------- */
const CSS = `
.z02-root{position:fixed;right:24px;bottom:24px;z-index:2147483000;font-family:ui-rounded,-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;pointer-events:none;user-select:none;-webkit-user-select:none}
.z02-stage{position:relative;width:var(--z02-w,168px);height:var(--z02-h,184px);pointer-events:auto;cursor:grab;filter:drop-shadow(0 14px 22px rgba(0,0,0,.35));transition:transform .18s cubic-bezier(.2,1.4,.4,1);touch-action:none}
.z02-stage.z02-drag{cursor:grabbing;transform:scale(1.04)}
.z02-stage.z02-breathe{animation:z02-bob 3.6s ease-in-out infinite}
@keyframes z02-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-7px)}}
@keyframes z02-pop{0%{transform:scale(.86);opacity:0}60%{transform:scale(1.04)}100%{transform:scale(1);opacity:1}}
@keyframes z02-breathe{0%,100%{transform:translateY(0) scaleY(1)}50%{transform:translateY(-1px) scaleY(1.006)}}
@keyframes z02-float{0%,100%{transform:translateY(0)}50%{transform:translateY(-3px)}}
.z02-stage canvas,.z02-stage img{width:100%;height:100%;display:block;object-fit:contain;pointer-events:none}
.z02-badge{position:absolute;right:2px;top:2px;min-width:18px;height:18px;border-radius:9px;background:#e8385a;color:#fff;font-size:11px;line-height:18px;text-align:center;padding:0 5px;box-shadow:0 2px 8px rgba(232,56,90,.5);pointer-events:none;opacity:0;transition:opacity .25s}
.z02-badge.on{opacity:1}
.z02-hoverbar{position:absolute;left:50%;top:-34px;transform:translateX(-50%);display:flex;gap:5px;opacity:0;transition:opacity .18s;pointer-events:none;z-index:6}
.z02-stage:hover .z02-hoverbar{opacity:1;pointer-events:auto}
.z02-hoverbar button{border:0;background:rgba(255,255,255,.94);color:#4a2b3c;width:34px;height:28px;border-radius:10px;font-size:14px;line-height:1;cursor:pointer;box-shadow:0 3px 10px rgba(0,0,0,.22);padding:0}
.z02-hoverbar button:hover{background:#fff}
.z02-hoverbar.low{top:auto;bottom:-34px}
.z02-bubble{position:absolute;right:8px;bottom:calc(100% + 6px);max-width:230px;background:#fff;color:#3a2230;border-radius:16px;padding:9px 13px;font-size:13px;line-height:1.5;box-shadow:0 10px 26px rgba(0,0,0,.28);opacity:0;transform:translateY(6px);transition:opacity .22s,transform .22s;pointer-events:none;white-space:pre-wrap;word-break:break-word}
.z02-bubble.on{opacity:1;transform:none}
.z02-bubble:after{content:"";position:absolute;right:22px;bottom:-7px;width:14px;height:14px;background:#fff;transform:rotate(45deg);border-radius:3px}
.z02-menu{position:absolute;right:0;bottom:calc(100% + 14px);display:flex;flex-direction:column;gap:6px;opacity:0;transform:translateY(8px) scale(.96);transform-origin:bottom right;transition:opacity .18s,transform .18s;pointer-events:none}
.z02-menu.on{opacity:1;transform:none;pointer-events:auto}
.z02-menu button{border:0;border-radius:12px;padding:9px 14px;font:600 13px/1 inherit;color:#3a2230;background:#fff;box-shadow:0 8px 20px rgba(0,0,0,.22);cursor:pointer;display:flex;align-items:center;gap:7px;white-space:nowrap;transition:transform .12s,background .15s}
.z02-menu button:hover{transform:translateX(-3px);background:#fff4f7}
.z02-restore{position:fixed;right:0;bottom:28%;z-index:2147483000;display:none;align-items:center;gap:5px;padding:9px 11px 9px 9px;border-radius:14px 0 0 14px;background:linear-gradient(135deg,#ff7a97,#e8385a);color:#fff;font:700 12px/1 ui-rounded,-apple-system,sans-serif;box-shadow:0 8px 22px rgba(232,56,90,.42);cursor:pointer;pointer-events:auto;user-select:none;opacity:0;transform:translateX(6px);transition:opacity .25s,transform .25s}
.z02-restore.on{display:flex;opacity:1;transform:none}
.z02-restore:hover{filter:brightness(1.06)}
.z02-restore i{width:7px;height:7px;border-radius:50%;background:#fff;opacity:.85;animation:z02-pulse 1.8s infinite}
@keyframes z02-pulse{0%,100%{opacity:.35}50%{opacity:1}}
.z02-panel{position:absolute;right:0;bottom:calc(100% + 14px);width:320px;max-width:calc(100vw - 40px);background:#fff;border-radius:18px;box-shadow:0 24px 60px rgba(0,0,0,.34);overflow:hidden;display:none;flex-direction:column;pointer-events:auto;color:#3a2230}
.z02-panel.on{display:flex}
.z02-head{display:flex;align-items:center;gap:8px;padding:11px 14px;background:linear-gradient(135deg,#ffe4ea,#ffd0da);font-weight:700;font-size:13px}
.z02-head .z02-dot{width:8px;height:8px;border-radius:50%;background:#3ecf8e;box-shadow:0 0 0 3px rgba(62,207,142,.22)}
.z02-head .z02-dot.off{background:#f0a04b;box-shadow:0 0 0 3px rgba(240,160,75,.2)}
.z02-head .z02-close{margin-left:auto;border:0;background:transparent;font-size:16px;cursor:pointer;color:#b06;line-height:1}
.z02-msgs{flex:1;min-height:120px;max-height:300px;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;background:#fdf7f9}
.z02-msg{max-width:86%;padding:8px 11px;border-radius:13px;font-size:13px;line-height:1.55;white-space:pre-wrap;word-break:break-word}
.z02-msg.user{align-self:flex-end;background:#e8385a;color:#fff;border-bottom-right-radius:5px}
.z02-msg.pet{align-self:flex-start;background:#fff;border:1px solid #f3dbe2;border-bottom-left-radius:5px}
.z02-msg.sys{align-self:center;font-size:11.5px;color:#a0788a;text-align:center;max-width:100%}
.z02-msg.err{align-self:flex-start;background:#fff2f2;border:1px solid #ffc9c9;color:#b03030;font-size:12px}
.z02-msgrow{display:flex;align-items:flex-start;gap:6px;max-width:100%}
.z02-msgrow .z02-msg{max-width:calc(100% - 28px)}
.z02-av{width:22px;height:22px;border-radius:50%;object-fit:cover;object-position:top center;flex:0 0 22px;margin-top:2px;background:#ffe6ee;border:1px solid #f6cbd9}
.z02-src{display:inline-block;margin-left:6px;font-size:10px;font-style:normal;color:#a0788a;border:1px solid #eedde4;border-radius:6px;padding:0 4px;vertical-align:middle}
.z02-typing{align-self:flex-start;display:flex;gap:4px;padding:10px 12px;background:#fff;border:1px solid #f3dbe2;border-radius:13px}
.z02-typing i{width:6px;height:6px;border-radius:50%;background:#e8385a;opacity:.4;animation:z02-dot 1.1s infinite}
.z02-typing i:nth-child(2){animation-delay:.15s}.z02-typing i:nth-child(3){animation-delay:.3s}
@keyframes z02-dot{0%,60%,100%{opacity:.35;transform:translateY(0)}30%{opacity:1;transform:translateY(-3px)}}
.z02-input{display:flex;gap:6px;padding:9px;border-top:1px solid #f1e2e7;background:#fff}
.z02-input input{flex:1;min-width:0;border:1px solid #eddfe4;border-radius:11px;padding:9px 11px;font:13px inherit;outline:none;color:#3a2230}
.z02-input input:focus{border-color:#e8385a;box-shadow:0 0 0 3px rgba(232,56,90,.13)}
.z02-input button{border:0;border-radius:11px;padding:0 15px;background:#e8385a;color:#fff;font:700 13px inherit;cursor:pointer}
.z02-input button:disabled{opacity:.5;cursor:default}
.z02-form{padding:13px 14px;display:flex;flex-direction:column;gap:8px;font-size:12px;color:#6b4b58;background:#fdf7f9;overflow-y:auto;max-height:350px}
.z02-foot{padding:10px 14px;border-top:1px solid #f1e2e7;background:#fff;display:flex;flex-direction:column;gap:7px}
.z02-form label{display:flex;flex-direction:column;gap:4px;font-weight:600}
.z02-form input{border:1px solid #eddfe4;border-radius:9px;padding:7px 10px;font:12px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;outline:none;color:#3a2230;background:#fff}
.z02-form input:focus{border-color:#e8385a}
.z02-size{display:flex;flex-direction:column;gap:3px;margin:2px 0 4px}
.z02-size b{color:#c02448}
.z02-size input[type=range]{width:100%;accent-color:#e8385a;margin:2px 0 0}
.z02-skins{display:flex;gap:7px;margin-bottom:2px}
.z02-skins button{flex:1;min-width:0;border:2px solid transparent;background:#f3eef1;border-radius:12px;padding:4px 3px 4px;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:3px;font:600 11px inherit;color:#6b4b58;transition:border-color .15s,background .15s}
.z02-skins button.on{border-color:#e8385a;background:#ffe8ee;color:#c02448}
.z02-skins img{width:100%;height:44px;object-fit:contain;object-position:center top;pointer-events:none}
.z02-skins em{font:400 9.5px/1.25 inherit;font-style:normal;color:#a0788a;text-align:center}
.z02-modes{display:flex;gap:6px}
.z02-modes button{flex:1;border:1px solid #eddfe4;background:#fff;color:#6b4b58;border-radius:10px;padding:8px 0;font:600 12px inherit;cursor:pointer}
.z02-modes button.on{background:#e8385a;border-color:#e8385a;color:#fff}
.z02-sect{border-top:1px dashed #eddfe4;padding-top:8px;margin-top:2px;display:flex;flex-direction:column;gap:7px}
.z02-sect>span{font-weight:700;font-size:11.5px;color:#a0788a;letter-spacing:.4px}
.z02-hint{font-weight:400;color:#a0788a;font-size:11px;line-height:1.55}
.z02-actions{display:flex;gap:8px;margin-top:2px}
.z02-actions button{flex:1;border:0;border-radius:10px;padding:9px;font:700 12.5px inherit;cursor:pointer;background:#f2e6ea;color:#6b4b58}
.z02-actions button.primary{background:#e8385a;color:#fff}
.z02-result{font-size:11.5px;line-height:1.5;color:#8a6b78;min-height:14px;word-break:break-all}
.z02-chips{display:flex;flex-wrap:wrap;gap:5px}
.z02-chips button{border:1px solid #eddfe4;background:#fff;border-radius:7px;padding:3px 7px;font:11px inherit;color:#6b4b58;cursor:pointer}
@media (max-width:640px){.z02-root{right:12px;bottom:12px}.z02-panel{width:calc(100vw - 24px)}}
@media (prefers-reduced-motion:reduce){.z02-stage.z02-breathe{animation:none}.z02-stage,.z02-bubble,.z02-menu{transition:none}}
`;

function injectStyle(text) {
  const el = document.createElement("style");
  el.setAttribute("data-z02", PLUGIN_ID);
  el.textContent = text;
  document.head.appendChild(el);
}

/**
 * 声音联动：把即将上气泡的这句话交给 VOICE 朗读。
 * opts.kind 非空 = 「这是她真的在说话」（聊天/摸头/投喂/主动开口/事件台词），
 * opts.speak === false 可强制噤声；纯 UI 提示（切形态/好感度/报错）不传 opts 就不会读。
 */
/* ---------------- 说话口型：TTS 播放时驱动 02 的嘴 ---------------- */
let lipTimer = null;
function startLipSync(text) {
  try {
    stopLipSync();
    var c = pet3d && pet3d.has && pet3d.has() ? pet3d.getChar && pet3d.getChar() : null;
    if (!c || !c.talkMouth) return;
    var vowels = ["A", "I", "U", "E", "O"];
    var i = 0;
    lipTimer = setInterval(function () {
      try {
        var ch = pet3d && pet3d.getChar();
        if (!ch || !ch.talkMouth) return;
        if (Math.random() < 0.12) { ch.closeMouth(); return; }
        ch.talkMouth(vowels[i++ % vowels.length], 0.45 + Math.random() * 0.35);
      } catch (e) {}
    }, 100);
    var dur = Math.min(9000, Math.max(900, String(text || "").length * 150));
    setTimeout(function () { stopLipSync(); }, dur);
  } catch (e) {}
}
function stopLipSync() {
  if (lipTimer) { clearInterval(lipTimer); lipTimer = null; }
  try {
    var c = pet3d && pet3d.getChar && pet3d.getChar();
    if (c && c.closeMouth) c.closeMouth();
  } catch (e) {}
}

function voiceForLine(text, opts) {
  try {
    if (typeof VOICE === "undefined" || !VOICE) return false;
    var o = opts || {};
    // 朗读范围：all=所有台词；chat=只读聊天回复（避免她自言自语也念出来）
    var scope = (S.voice && S.voice.mode) || "all";
    var kindNow = o.kind || "";
    var scopeOk = scope !== "chat" || kindNow === "chat";
    // 语音开着才做口型（默认关，避免只有动画没声音的怪现象）
    var willSpeak = !!(scopeOk && S.voice && S.voice.on && VOICE.status && VOICE.status().supported);
    if (willSpeak) { try { startLipSync(text); } catch (e) {} }
    var hourNow = new Date().getHours();
    var nightMood = (hourNow >= 23 || hourNow < 5) ? "sleepy" : "";
    if (willSpeak && VOICE.speakSequence) {
      return VOICE.speakSequence(String(text || ""), {
        kind: o.kind || "",
        skin: SKIN().id,
        mood: SKIN().id === "whale" ? "" : (S.mood || ""),
        moodText: text,
        moodId: nightMood || undefined,
      });
    }
    return VOICE.speak(String(text || ""), {
      kind: o.kind || "",
      skin: SKIN().id,
      // 鲸鲸不吃 02 的 S.mood（那是 02 的情绪）；只按自己的台词猜
      mood: SKIN().id === "whale" ? "" : (S.mood || ""),
      moodText: text,
    });
  } catch (error) {
    return false;   // 语音永远不能影响气泡
  }
}

function say(text, ms, opts) {
  if (!bubbleEl) return;
  // 气泡只做"一眼能读完"的显示：超长文本截断（聊天面板里是全文），避免气泡顶出屏幕
  var shown = String(text == null ? "" : text);
  if (shown.length > 260) shown = shown.slice(0, 258) + "…";
  bubbleEl.textContent = shown;
  bubbleEl.classList.add("on");
  try { var hb0 = petEl && petEl.querySelector(".z02-hoverbar"); if (hb0) hb0.classList.add("low"); } catch (e) {}
  bubbleTimer = (ms || Math.max(2200, text.length * 150)) / 1000;
  // 声音：只有明确标记为「她说的话」的气泡才朗读，避免系统提示音一样吵
  var o = opts || null;
  var wantVoice = !!o && (o.speak === true || (o.speak !== false && o.kind));
  if (wantVoice) voiceForLine(text, o);
}
const pick = (a) => a[(Math.random() * a.length) | 0];

/** 取 02 的事件台词；鲸鲸/没有该事件时返回 ""，调用方用旧台词兜底 */
function personaLine(kind, opts) {
  try {
    if (typeof PERSONA === "undefined" || !PERSONA || !PERSONA.eventLine) return "";
    return PERSONA.eventLine(Object.assign({ skin: SKIN().id }, opts || {}, { kind: kind })) || "";
  } catch (error) {
    return "";
  }
}

/** 记录最近一次互动的时刻（用于「久别重逢」判断） */
/* ---------------- 长时间没人理：她会睡着（真宠物的行为） ---------------- */
let sleepMode = false;
let sleepSince = 0;
let zzzAt = 0;
const SLEEP_AFTER_MS = 25 * 60 * 1000;   // 25 分钟没有任何互动

function enterSleep() {
  if (sleepMode) return;
  sleepMode = true;
  sleepSince = Date.now();
  zzzAt = 4;
  try {
    setPose("sleep");
    say(pick([
      "（打了个哈欠）……我先眯一会儿。你忙完记得叫我。",
      "（蜷起来）等你……等得有点困了。",
      "（声音越来越轻）……别走太远。",
    ]), 2600);
    burst("zzz", { n: 2 });
  } catch (e) {}
}

function exitSleep(quiet) {
  if (!sleepMode) return;
  sleepMode = false;
  var mins = Math.round((Date.now() - sleepSince) / 60000);
  try {
    setPose("stretch");
    setTimeout(function () { if (lastPose === "stretch") setPose("idle"); }, 1600);
    if (!quiet) {
      say(pick([
        "（揉眼睛）……唔，你回来了。",
        "（迷糊）我睡了多久？……你回来就好。",
        "（伸了个懒腰）哈啊——被吵醒了。不过，是你就算了。",
      ]), 3200, { kind: "event" });
    }
  } catch (e) {}
}

function touchSeen() {
  S.lastSeen = Date.now();
  saveStore();
}
function minutesSinceSeen() {
  const t = Number(S.lastSeen) || 0;
  if (!t) return 0;
  return Math.max(0, Math.round((Date.now() - t) / 60000));
}
const affinity = () => Math.min(999, Math.floor((S.affinity || 0) / 10));

/* ============================================================================
 * 02 的日常感（Soul / Daily）—— 让桌宠有「过日子」的感觉：
 *   1) 每日心情：按「日期 + 好感度」播种，每天一个 mood，存 S.dailyMood
 *   2) 小日记 / 今日小结：S.todayStats 记录聊天句数 / 被摸 / 投喂 / 她主动开口
 *   3) 主动开口：4~8 分钟随机一次，按 久无操作 / 忙工作 / 饭点 / 深夜 分场景
 *   4) 久别重逢：连续 3 天以上没来 → 02 专属台词（内联在 engine，不动 persona.js）
 *   5) 鲸鲸皮肤完全不走这套 02 的心情/事件台词（她有自己的宠物语气）
 * ========================================================================== */
const DAY_MS = 24 * 60 * 60 * 1000;

function dayPad2(n) { n = Number(n) || 0; return (n < 10 ? "0" : "") + n; }
function todayKey(d) {
  const t = d ? new Date(d) : new Date();
  return t.getFullYear() + "-" + dayPad2(t.getMonth() + 1) + "-" + dayPad2(t.getDate());
}
/** FNV-1a：把「日期 + 好感度」压成一个稳定的种子，保证同一天刷新后心情不变 */
function hashStr(str) {
  let h = 2166136261;
  const s = String(str || "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/* 每日心情：id 用于日记尾巴，label 展示，prompt 注入系统提示词，line 在主动开口时偶尔冒出来 */
const DAILY_MOODS = [
  { id: "clingy", label: "黏人", hint: "今天特别黏你，隔一会儿就想找你说句话。",
    prompt: "今天格外黏人：想一直待在 darling 旁边，说话会往撒娇、要陪伴上偏。",
    line: "……今天，你就多陪我一会儿嘛。" },
  { id: "tsundere", label: "嘴硬", hint: "嘴上不饶人，其实一直在等你主动找她。",
    prompt: "今天嘴硬心软：明明想被关注，却偏要说反话，被拆穿会脸红。",
    line: "（别过脸）……我才没有在等你。只是刚好路过。" },
  { id: "sweets", label: "想吃甜食", hint: "满脑子都是糖，会一直惦记你投喂点什么。",
    prompt: "今天特别想吃甜的：老是惦记糖和甜的东西，语气软软的、带点馋。",
    line: "（咬着糖纸）……还有吗？甜的。" },
  { id: "praise", label: "想被夸", hint: "今天特别想听你说她好，夸一句能开心一整天。",
    prompt: "今天想被夸：会绕着弯暗示 darling 夸她，被夸了嘴上不承认、心里高兴。",
    line: "ねえ……我今天，有没有比昨天好看一点？" },
  { id: "dangerous", label: "危险地温柔", hint: "比平时安静，可眼睛里藏着不容你拒绝的温柔。",
    prompt: "今天危险地温柔：声音很轻，却带着不容拒绝的占有欲，句句护着 darling。",
    line: "别乱跑。……今天，我不太想放手。" },
  { id: "lazy", label: "懒懒的", hint: "困困的，反应慢半拍，只想靠着你。",
    prompt: "今天懒懒的、犯困，说话慢半拍，更爱用行动（靠过来、闭眼）表达。",
    line: "嗯……再靠一会儿。就一会儿。" },
];

/** 取今天的 mood；date 变了或 force 时按日期种子 + 好感度重新生成，并持久化 */
function ensureDailyMood(force) {
  const today = todayKey();
  if (!force && S.dailyMood && S.dailyMood.date === today && S.dailyMood.label) return S.dailyMood;
  const seed = hashStr(today + "|" + String(Math.floor((S.affinity || 0) / 10)) + "|" + (S.userName || "darling"));
  const m = DAILY_MOODS[seed % DAILY_MOODS.length];
  S.dailyMood = { date: today, id: m.id, label: m.label, hint: m.hint, prompt: m.prompt, line: m.line };
  saveStore();
  return S.dailyMood;
}

/** 今日小结容器；跨天时把昨天的数据归档进 S.diary（设置面板可显示最近几天） */
function ensureTodayStats() {
  const today = todayKey();
  if (S.todayStats && S.todayStats.date === today) return S.todayStats;
  const prev = S.todayStats;
  if (prev && prev.date) {
    const prevMood = S.dailyMood && S.dailyMood.date === prev.date ? S.dailyMood.label : "";
    const prevMoodId = S.dailyMood && S.dailyMood.date === prev.date ? S.dailyMood.id : "";
    S.diary = (S.diary || []).concat([{
      date: prev.date,
      chats: prev.chats || 0,
      pet: prev.pet || 0,
      feed: prev.feed || 0,
      proactive: prev.proactive || 0,
      mood: prevMood,
      moodId: prevMoodId,
    }]).slice(-14);
  }
  S.todayStats = { date: today, chats: 0, pet: 0, feed: 0, proactive: 0, firstAt: Date.now(), lastAt: Date.now() };
  saveStore();
  return S.todayStats;
}

function bumpToday(key, n) {
  if (!key) return ensureTodayStats();
  const st = ensureTodayStats();
  st[key] = (st[key] || 0) + (Number(n) || 1);
  st.lastAt = Date.now();
  saveStore();
  return st;
}

/** 设置面板里的一行「今日小结」 */
function todaySummaryText() {
  const st = ensureTodayStats();
  const bits = [];
  if (st.chats) bits.push("聊了 " + st.chats + " 句");
  if (st.pet) bits.push("被摸 " + st.pet + " 次");
  if (st.feed) bits.push("投喂 " + st.feed + " 次");
  if (st.proactive) bits.push("她主动开口 " + st.proactive + " 次");
  return bits.length ? bits.join(" · ") : "今天还没怎么互动……她有点无聊";
}

const DIARY_TAILS = {
  clingy: "尾巴（如果有的话）一直翘着。",
  tsundere: "嘴上说「随便」，其实把你的每句话都记住了。",
  sweets: "糖纸攒了一小堆，全都没舍得扔。",
  praise: "今天也偷偷等你夸她，等了一整天。",
  dangerous: "看你的眼神，比平时久了一点点。",
  lazy: "大部分时间都在打盹，但你一出现就会醒。",
};

/** 小日记：把她今天被怎么对待了写成一句 02 味的话 */
function diaryLine() {
  const st = ensureTodayStats();
  const dm = ensureDailyMood();
  const total = (st.chats || 0) + (st.pet || 0) + (st.feed || 0) + (st.proactive || 0);
  if (!total) return "（小日记）今天还没被理。……我才没有在等。";
  const bits = [];
  if (st.chats) bits.push("聊天 " + st.chats + " 句");
  if (st.pet) bits.push("被摸 " + st.pet + " 次");
  if (st.feed) bits.push("投喂 " + st.feed + " 次");
  if (st.proactive) bits.push("我主动找了他 " + st.proactive + " 次");
  return "（小日记）今天" + bits.join("、") + "。" + (DIARY_TAILS[dm.id] || "还不错的一天。");
}

/* 连续几天没来：按天数挑 02 风格的台词（persona.js 不能改，所以内联在引擎里） */
const ABSENCE_LINES = {
  3: [
    "（盯——）三天。……darling，你最好有个像样的解释。",
    "三天没来。（拉住你的袖子）我还以为，你把我忘了。",
    "（别过脸）只是三天而已。……才没有每天都往门口看。",
  ],
  7: [
    "一周。……你知道一周有多久吗，darling。",
    "（抱住）七天。……这次，罚你多陪我一会儿。",
    "（凑近）你身上我的味道都淡了。……去哪儿了，说清楚。",
  ],
  long: [
    "好久不见……久到我差点以为，那是我做的一个梦。",
    "（握住你的手，很久没松开）……回来就好。",
    "（小声）我还以为，你不会回来了。……别再让我等这么久。",
  ],
};
function absenceLine(days) {
  const d = Number(days) || 0;
  const pool = d >= 7 ? ABSENCE_LINES[7].concat(ABSENCE_LINES.long) : ABSENCE_LINES[3];
  return pick(pool) || "";
}

/* ---------------- 共同记忆片段（第一次摸头/第一次聊天/第一次被夸…） ---------------- */
const MOMENT_LABELS = {
  chat: "第一次和你说话",
  pat: "第一次被你摸头",
  feed: "第一次吃到你喂的糖",
  praise: "第一次被你夸",
  whisper: "第一次对我说心里话",
  late: "第一次陪我熬到深夜",
  welcome: "第一次见面",
  hundred: "聊到第 100 句",
};
function recordMoment(kind) {
  try {
    if (!kind || !MOMENT_LABELS[kind]) return false;
    S.moments = S.moments || [];
    for (var i = 0; i < S.moments.length; i++) if (S.moments[i].k === kind) return false;
    S.moments.push({ k: kind, t: Date.now() });
    S.moments = S.moments.slice(-24);
    saveStore();
    return true;
  } catch (e) { return false; }
}
function momentDaysAgo(ts) {
  return Math.max(0, Math.round((Date.now() - Number(ts || 0)) / DAY_MS));
}
/** 挑一个早于 1 天的记忆片段，说成一句她的话（不重复：最近 3 条不选） */
function momentRecallLine() {
  try {
    var list = (S.moments || []).filter(function (m) { return m && MOMENT_LABELS[m.k] && momentDaysAgo(m.t) >= 1; });
    if (!list.length) return "";
    var recent = S._recentMoments || [];
    var pool = list.filter(function (m) { return recent.indexOf(m.k) < 0; });
    if (!pool.length) pool = list;
    var m = pick(pool);
    S._recentMoments = (S._recentMoments || []).concat([m.k]).slice(-3);
    var d = momentDaysAgo(m.t);
    return pick([
      "（想起什么）" + d + " 天前，" + MOMENT_LABELS[m.k] + "。……那时候我还嘴硬呢。",
      "（小声）" + MOMENT_LABELS[m.k] + "，是 " + d + " 天前的事了。我记着。",
      "喂，你还记得吗。" + d + " 天前——" + MOMENT_LABELS[m.k] + "。",
    ]);
  } catch (e) { return ""; }
}

/** 后一天 key（"2026-11-13" 格式 +1 天） */
function nextDayKey(key) {
  var parts = String(key || "").split("-");
  if (parts.length !== 3) return "";
  var t = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]) + 1);
  var mm = String(t.getMonth() + 1); if (mm.length < 2) mm = "0" + mm;
  var dd = String(t.getDate()); if (dd.length < 2) dd = "0" + dd;
  return t.getFullYear() + "-" + mm + "-" + dd;
}
/** 昨天的小日记（互动量 + 心情），没有就返回 null */
function yesterdayDiary() {
  var today = todayKey();
  var list = S.diary || [];
  for (var i = list.length - 1; i >= 0; i--) {
    if (nextDayKey(list[i].date) === today) return list[i];
  }
  return null;
}
/** 心情/互动量回访台词（30% 概率用） */
function yesterdayRecallLine() {
  try {
    var y = yesterdayDiary();
    if (!y) return "";
    var mood = String(y.mood || "");
    var negIds = ["dangerous", "lazy"];
    var badDay = negIds.indexOf(String(y.moodId || "")) >= 0 || /闷|累|低|醋|困|没精神|提不起|烦/.test(mood);
    if (badDay) {
      return pick([
        "昨天我有点提不起劲……今天看到你，好多了。",
        "（小声）昨天心情闷闷的。不过，现在没事了。",
      ]);
    }
    if (/开心|黏|软|元气|高|飘|亮/.test(mood)) {
      return pick([
        "昨天我一整天都有点飘。……不是因为别的，别乱想。",
        "（晃尾巴）昨天心情特别好。你猜为什么。",
      ]);
    }
    var n = (y.chats || 0) + (y.pet || 0) + (y.feed || 0) + (y.proactive || 0);
    if (n >= 10) {
      return pick([
        "昨天你陪了我好久。……那点时间，我记着的。",
        "（掰手指）昨天我们说了 " + (y.chats || 0) + " 句话。我数了。",
      ]);
    }
    if (n > 0 && n < 4) {
      return pick([
        "昨天你来得很少。……我没有在等你，只是刚好记得。",
        "昨天你只露了个面。今天，多待一会儿。",
      ]);
    }
    return "";
  } catch (e) { return ""; }
}

/* ---------------- 节日/纪念日（公历固定日期） ---------------- */
const HOLIDAY_LINES = {
  "1-1": ["新的一年了。……今年也，看着我，darling。", "（凑近）新年快乐。愿望我只许了一个——你。", "跨年了。……别急着许愿，先看着我。"],
  "2-14": ["（把糖塞给你）给你。……今天是那种日子吧，别装不知道。", "情人节？我才不懂那些。……不过，糖是甜的。", "（别过脸，耳朵红）喂。今天，可以抱一下。"],
  "6-1": ["今天你过节。……儿童节，别装大人了。", "（歪头）今天是小孩的节日。你在我这儿，可以当小孩。"],
  "10-1": ["放假了？……那，多陪我几天。", "（晃尾巴）长假。想好怎么分配给我了吗。"],
  "12-24": ["平安夜。……我不过节的，但今天想待在你旁边。", "（把糖堆成小堆）平安夜。糖分你一半。"],
  "12-25": ["圣诞快乐，darling。……礼物我不挑，你记得我就行。", "（围巾有点长）今天出门吗？街上应该很吵，我陪你。"],
};
function holidayLine(dateObj) {
  try {
    var d = dateObj || new Date();
    var key = (d.getMonth() + 1) + "-" + d.getDate();
    var pool = HOLIDAY_LINES[key];
    if (!pool || !pool.length) return "";
    if (S.__holidaySaid === todayKey()) return "";
    S.__holidaySaid = todayKey();
    saveStore();
    return pick(pool);
  } catch (e) { return ""; }
}

/** 认识第几天（1 起算）；firstMeetAt 不存在时按第一次启动算 */
function daysKnown() {
  var t = Number(S.firstMeetAt) || 0;
  if (!t) { S.firstMeetAt = Date.now(); saveStore(); t = S.firstMeetAt; }
  return Math.max(1, Math.floor((Date.now() - t) / DAY_MS) + 1);
}

const KNOWN_DAY_LINES = ["第 {d} 天了。……嗯，我数着的。", "（掰手指）认识你 {d} 天了，darling。", "今天是我们认识的第 {d} 天。记好了。"];

/** 跨了日期：今天第一次见到你 / 隔了几天没来 */
function daysSinceSeen() {
  const t = Number(S.lastSeen) || 0;
  if (!t) return 0;
  const a = new Date(t);
  const b = new Date();
  const d0 = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime();
  const d1 = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime();
  return Math.max(0, Math.round((d1 - d0) / DAY_MS));
}

/* 新的一天开场（清晨用 persona 的 morning 事件台词，其他时段用内联台词） */
const NEW_DAY_LINES = [
  "日期跳过去了，我还在。……你呢，darling？",
  "（伸懒腰）新的一天。……今天也归我管哦。",
  "又是新的一天。……先让我看看你今天是什么表情。",
];
function newDayLine(hour) {
  const h = Number(hour);
  if (h >= 5 && h < 11) {
    const m = personaLine("morning");
    if (m) return m;
  }
  return pick(NEW_DAY_LINES);
}

/* 主动开口分场景台词（02 语气；鲸鲸不使用这些） */
const PROACTIVE_LINES = {
  silence: [
    "（戳了戳屏幕）……darling，你是不是把我忘了。",
    "喂——还活着吗？……我可一直都在看着你哦。",
    "鼠标都不动了。……是不是睡着了？那我只好吵醒你。",
    "（趴在桌角）好安静。……你不说话，我有点无聊。",
  ],
  work: [
    "在忙？……那我安静待着。忙完记得看我一眼。",
    "工作比我还重要吗？（眯眼）……说，哪个更可爱。",
    "你已经盯着那块屏幕很久了。……偶尔也看看我。",
    "键盘声音好吵。……不过，比完全不响好一点。",
  ],
  meal: [
    "饭点了，darling。……别拿泡面糊弄我。",
    "该吃饭了。不吃的话，我会生气的哦。",
    "（把糖推过去）先垫一口。正餐也要吃，听见没。",
  ],
  night: [
    "这个点还不睡？……我陪你，只到你困为止。",
    "夜深了，darling。……别让我一个人醒着。",
    "（小声）再熬下去，我可要生气了。……去睡，我明天还在。",
  ],
  idle: [
    "嗯？……没事，就是想叫你一声。",
    "（晃了晃你的衣角）darling。……没什么，继续吧。",
    "今天也这样待着，挺好的。……我在说真的。",
  ],
};
const PROACTIVE_SCENE_HINT = {
  silence: "他一直没动，很久没理你",
  work: "他在忙、没空陪你",
  meal: "到了饭点",
  night: "已经深夜了",
  idle: "闲着没事",
};

let journalBusy = false;
let weeklyBusy = false;
let saccadeAt = 2.5;          // 下一次"目光游移"
let saccadeHold = 0;          // 游移目标保持时间
/* 心情驱动行为：让"今天的她"真的不一样（说话频率 / 小请求 / 犯困阈值） */
function moodDrives() {
  var id = (S.dailyMood && S.dailyMood.id) || "";
  var h = new Date().getHours();
  var base = { proactiveMul: 1, requestMul: 1, sleepMs: 25 * 60 * 1000 };
  var map = {
    clingy: { proactiveMul: 0.62, requestMul: 1.5, sleepMs: 34 * 60 * 1000 },   // 黏人：更爱开口、更晚睡
    tsundere: { proactiveMul: 1.0, requestMul: 0.8, sleepMs: 25 * 60 * 1000 },
    sweets: { proactiveMul: 0.9, requestMul: 1.4, sleepMs: 25 * 60 * 1000 },
    praise: { proactiveMul: 0.95, requestMul: 1.2, sleepMs: 26 * 60 * 1000 },
    dangerous: { proactiveMul: 1.15, requestMul: 0.7, sleepMs: 30 * 60 * 1000 },
    lazy: { proactiveMul: 1.55, requestMul: 0.7, sleepMs: 16 * 60 * 1000 },    // 懒懒的：话少、更早犯困
  };
  var d = map[id] || {};
  for (var k in d) if (base[k] != null) base[k] = d[k];
  if (h >= 0 && h < 6) base.sleepMs = Math.min(base.sleepMs, 18 * 60 * 1000);   // 深夜更早困
  return base;
}

let proactiveTimer = 0;
let proactiveNext = 240 + Math.random() * 240;   // 4~8 分钟（秒），实际会乘心情系数
let lastPointerAt = Date.now();
let lastNewDaySaidFor = "";
let dayCheckAcc = 0;

function resetProactiveTimer() {
  proactiveTimer = 0;
  proactiveNext = (240 + Math.random() * 240) * (moodDrives().proactiveMul || 1);
}
/** 测试 / 演示用：把下一次主动开口提前到 sec 秒后 */
function setProactiveNext(sec) {
  proactiveTimer = 0;
  proactiveNext = Math.max(0.2, Number(sec) || 0.2);
}
function proactiveScenario() {
  const now = new Date();
  const h = now.getHours() + now.getMinutes() / 60;
  const idleMin = lastPointerAt ? (Date.now() - lastPointerAt) / 60000 : 0;
  if (h >= 23 || h < 5) return "night";
  if ((h >= 11 && h < 13) || (h >= 17 && h < 19)) return "meal";
  if (idleMin >= 8) return "silence";
  if (idleMin <= 5) return "work";
  return "idle";
}
/** 从 PERSONA_EXTRA 取一句（没加载就返回空，安全回退） */
function extraLine(kind) {
  try {
    var E = window.PERSONA_EXTRA;
    if (!E || !E[kind] || !E[kind].length) return "";
    return pick(E[kind]);
  } catch (e) { return ""; }
}

/* ---------------- 生日 / 纪念日 ---------------- */
function noteBirthday(text) {
  try {
    var m = String(text || "").match(/生日[^0-9]{0,6}(\d{1,2})\s*月\s*(\d{1,2})/);
    if (!m) return null;
    var mo = Number(m[1]), d = Number(m[2]);
    if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
    S.birthday = { m: mo, d: d };
    saveStore();
    return S.birthday;
  } catch (e) { return null; }
}
function isBirthdayToday() {
  try {
    if (!S.birthday) return false;
    var n = new Date();
    return n.getMonth() + 1 === S.birthday.m && n.getDate() === S.birthday.d;
  } catch (e) { return false; }
}
/** 认识满 30/60/90… 天的纪念日台词（一天最多说一次） */
function anniversaryLine() {
  try {
    var d = daysKnown();
    if (d < 30 || d % 30 !== 0) return "";
    var k = todayKey();
    if (S.lastAnnivSaid === k) return "";
    S.lastAnnivSaid = k;
    saveStore();
    var pool = d <= 60
      ? ["（扳着手指）我们认识 " + d + " 天了啊。……还挺久的。", "认识 " + d + " 天了。哼，你可别觉得这是理所当然的。"]
      : ["认识 " + d + " 天了。……我好像，越来越习惯有你了。", "（小声）" + d + " 天。这个数字，我记着呢。"];
    return pick(pool);
  } catch (e) { return ""; }
}
function birthdayLine() {
  try {
    if (!isBirthdayToday()) return "";
    var k = "bday" + todayKey();
    if (S.lastBirthdaySaid === k) return "";
    S.lastBirthdaySaid = k;
    saveStore();
    return pick([
      "（把脸别过去）今天……是你的生日吧。过来，我勉强抱你一下。",
      "哼，生日快乐。……蛋糕我记着的，别以为我忘了。",
    ]);
  } catch (e) { return ""; }
}

/* ---------------- 夸奖记忆：她记得你夸过她什么 ---------------- */
function noteCompliment(text) {
  try {
    var t = String(text || "").trim();
    if (!t || t.length < 4) return "";
    if (!/(可爱|好看|漂亮|美|声音|眼睛|头发|笑|喜欢|帅|温柔|厉害|最棒)/.test(t)) return "";
    var line = t.length > 34 ? t.slice(0, 34) + "…" : t;
    S.compliments = S.compliments || [];
    if (S.compliments.indexOf(line) >= 0) return "";
    S.compliments.push(line);
    S.compliments = S.compliments.slice(-8);
    saveStore();
    return line;
  } catch (e) { return ""; }
}
/** 偶尔提起你夸她的话（12 小时最多一次） */
function complimentLine() {
  try {
    if (!S.compliments || !S.compliments.length) return "";
    if (S.lastComplimentAt && Date.now() - S.lastComplimentAt < 12 * 3600 * 1000) return "";
    var c = S.compliments[(Math.random() * S.compliments.length) | 0];
    if (!c) return "";
    S.lastComplimentAt = Date.now();
    saveStore();
    return pick([
      "（别过脸）你之前说「" + c + "」。……我记着呢。",
      "你夸我的那句「" + c + "」，我偷偷高兴了很久。",
      "哼，你说「" + c + "」的时候，我可是真的有点开心。",
    ]);
  } catch (e) { return ""; }
}

/* ---------------- 约定：你说过的「下次/以后一起…」她会记着 ---------------- */
function notePromise(text) {
  try {
    var t = String(text || "").trim();
    if (!t || t.length < 4) return "";
    if (!/(下次|以后|等下|等我们|等.*就|有空.*(一起|带|陪)|周末.*(一起|去)|一起.*(去|做|看))/i.test(t)) return "";
    if (!/(我们|一起|带你|陪你|下次|以后|等你)/.test(t)) return "";
    var line = t.length > 40 ? t.slice(0, 40) + "…" : t;
    S.promises = S.promises || [];
    if (S.promises.some(function (x) { return x && x.text === line; })) return "";
    S.promises.push({ text: line, t: Date.now() });
    S.promises = S.promises.slice(-6);
    saveStore();
    return line;
  } catch (e) { return ""; }
}
/** 提起一个约定（12 小时内最多一次） */
function promiseLine() {
  try {
    if (!S.promises || !S.promises.length) return "";
    if (S.lastPromiseAt && Date.now() - S.lastPromiseAt < 12 * 3600 * 1000) return "";
    var p = S.promises[(Math.random() * S.promises.length) | 0];
    if (!p || !p.text) return "";
    S.lastPromiseAt = Date.now();
    saveStore();
    return pick([
      "你上次说「" + p.text + "」。……我可记着呢，别赖。",
      "（掰手指）「" + p.text + "」——这个，还没兑现。",
      "喂，你说过「" + p.text + "」。还算数吗？",
    ]);
  } catch (e) { return ""; }
}

/* ---------------- 习惯观察：她会记住你什么时候来、更爱做什么 ---------------- */
function noteVisit() {
  try {
    var h = new Date().getHours();
    S.visitHours = (S.visitHours || []).concat([h]).slice(-20);
    saveStore();
  } catch (e) {}
}
function noteAction(kind) {
  try {
    if (!S.counts) S.counts = { pat: 0, feed: 0, chat: 0 };
    S.counts[kind] = (S.counts[kind] || 0) + 1;
    saveStore();
  } catch (e) {}
}
/** 从习惯里抽一句观察（12 小时内最多一次，聊过一定句数才观察） */
function habitObservationLine() {
  try {
    if (S.lastHabitAt && Date.now() - S.lastHabitAt < 12 * 3600 * 1000) return "";
    if ((S.chats || 0) < 5) return "";
    var c = S.counts || {};
    var visits = S.visitHours || [];
    var cand = [];
    // 互动偏好
    if ((c.pat || 0) >= 6 && (c.pat || 0) > (c.chat || 0) * 1.5) {
      cand.push("你最近不太说话，手倒是很勤。……我又没说不喜欢。");
      cand.push("（被摸的时候）你最近，就只会这样对我了？");
    }
    if ((c.feed || 0) >= 5 && (c.feed || 0) > (c.chat || 0)) {
      cand.push("最近喂我的糖，比跟我说的话还多。……你是不是在哄我。");
    }
    if ((c.chat || 0) >= 15) {
      cand.push("你最近，好像越来越肯跟我说了。……我听着呢。");
    }
    // 来访时间规律
    if (visits.length >= 5) {
      var hs = visits.slice(-6);
      var min = Math.min.apply(null, hs), max = Math.max.apply(null, hs);
      if (max - min <= 2) {
        cand.push("你总是在这个点来。……我把这个时间空出来了。");
      } else if (max - min >= 10) {
        cand.push("你来的时间越来越没规律了。……害我总想着看门口。");
      }
    }
    if (!cand.length) return "";
    S.lastHabitAt = Date.now();
    saveStore();
    return pick(cand);
  } catch (e) { return ""; }
}

/** 她偶尔露出的"非人类"的不安（36 小时内最多一次，需要一定好感） */
function deepLine() {
  try {
    if (S.lastDeepAt && Date.now() - S.lastDeepAt < 36 * 3600 * 1000) return "";
    if ((S.chats || 0) < 10) return "";
    if ((S.affinity || 0) < 15) return "";
    var l = extraLine("deep");
    if (!l) return "";
    S.lastDeepAt = Date.now();
    saveStore();
    return l;
  } catch (e) { return ""; }
}

/** 她今天在想的事（日记 / 心情 串一句，偶尔主动说） */
function todayThoughtLine() {
  try {
    var dm = S.dailyMood;
    var jr = latestJournal();
    if (jr && jr.text && Math.random() < 0.5) {
      return pick([
        "（小声）今天写了一句话，本来想给你看的。……算了，后面再说。",
        "（翻着日记）今天写了点东西。跟你有关，也只能跟你有关。",
        "（看着你）今天一直在想一件事。……等我想明白，再告诉你。",
      ]);
    }
    if (dm && dm.label) {
      var t = "（托着脸）今天一整天，心里有点" + dm.label + "。……别问为什么。";
      if (/黏/.test(dm.label)) t = "（靠过来）今天，好像离你近一点才舒服。";
      else if (/懒/.test(dm.label)) t = "（哈欠）今天懒懒的。……你陪我懒一会儿。";
      else if (/夸/.test(dm.label)) t = "（理了理头发）今天……好像有点想被你说好话。";
      return t;
    }
    return "";
  } catch (e) { return ""; }
}

/** 她主动提起记住的你的事（30% 概率、20 分钟内不重复） */
function memoryCallbackLine() {
  try {
    var mem = (S.memory || []).filter(function (m) { return m && m.length >= 2; });
    if (!mem.length) return "";
    if (S.lastMemoryAt && Date.now() - S.lastMemoryAt < 20 * 60 * 1000) return "";
    var pool = mem.filter(function (m) { return /喜欢|不喜欢|平时|职业|生日/.test(m); });
    if (!pool.length) pool = mem;
    var fact = pick(pool);
    if (!fact || S.lastMemoryText === fact) return "";
    // 把"喜欢：吃草莓蛋糕"这类内部格式说成人话
    var spoken = fact.replace(/^(喜欢)[:：]/, "你喜欢").replace(/^(不喜欢)[:：]/, "你不喜欢")
      .replace(/^(职业)[:：]/, "你是").replace(/^(平时)[:：]/, "你平时")
      .replace(/^(生日)[:：]/, "你的生日是").replace(/^(星座)[:：]/, "你是");
    S.lastMemoryAt = Date.now();
    S.lastMemoryText = fact;
    saveStore();
    return pick([
      "（想起什么）" + spoken + "。……我记着的。",
      "（掰手指）" + spoken + "……这个，我记得。",
      "喂。" + spoken + "，现在还是吗？",
      "（突然）" + spoken + "——别以为我随口就忘了。",
    ]);
  } catch (e) { return ""; }
}

function proactiveLine(kind) {
  const dm = ensureDailyMood();
  const pool = PROACTIVE_LINES[kind] || PROACTIVE_LINES.idle;
  // 纪念日统一由 anniversaryLine()（整 30 天）与开机 KNOWN_DAY_LINES（1/2/3/7/14/200…）负责，这里不再重复
  var todayKey2 = todayKey();
  if (!S.reqDay || S.reqDay.date !== todayKey2) S.reqDay = { date: todayKey2, n: 0 };
  var reqChance = Math.min(0.45, 0.14 * (moodDrives().requestMul || 1));
  if (S.reqDay.n < 3 && Math.random() < reqChance && !S.request) {
    var moodId = (S.dailyMood && S.dailyMood.id) || "";
    var kind = "pat";
    if (moodId === "sweets") kind = "feed";
    else if (moodId === "praise") kind = "praise";
    else if (kind === "pat" && Math.random() < 0.3) kind = Math.random() < 0.5 ? "chat" : "feed";
    setTimeout(function () { askRequest(kind); }, 400);
    return "";
  }
  if (Math.random() < 0.1) {
    var hline = habitObservationLine();
    if (hline) return hline;
  }
  if (Math.random() < 0.04) {
    var dline = deepLine();
    if (dline) return dline;
  }
  if (Math.random() < 0.1) {
    var tline = todayThoughtLine();
    if (tline) return tline;
  }
  var bday = birthdayLine();
  if (bday) return bday;
  var anniv = anniversaryLine();
  if (anniv) return anniv;
  if (Math.random() < 0.06) {
    var cline = complimentLine();
    if (cline) return cline;
  }
  if (Math.random() < 0.08) {
    var pline = promiseLine();
    if (pline) return pline;
  }
  if (Math.random() < 0.12) {
    var mline = momentRecallLine();
    if (mline) return mline;
  }
  if (Math.random() < 0.2) {
    var memLine = memoryCallbackLine();
    if (memLine) return memLine;
  }
  if (dm && dm.line && Math.random() < 0.35) return dm.line;
  // 45% 的概率说「她自己的话」：讲自己的事 / 问你 / 逗你 / 想你
  if (Math.random() < 0.45) {
    var pools = {
      night: ["sleepy", "soft", "selfTalk"],
      meal: ["food", "selfTalk"],
      silence: ["soft", "curious", "guilt"],
      work: ["curious", "tease", "selfTalk"],
      idle: ["selfTalk", "tease", "possessive", "curious"],
      reunion: ["soft", "guilt", "possessive"],
    }[kind] || ["selfTalk", "tease"];
    var line2 = "";
    for (var i = 0; i < pools.length && !line2; i++) {
      if (Math.random() < 0.6) line2 = extraLine(pools[i]);
    }
    if (line2) return line2;
  }
  return pick(pool);
}

/**
 * 主动开口。返回 { scenario, line } 便于调试/验收；被开关或状态拦下时返回 null。
 * force=true 时忽略面板/开关判断（设置面板的「让她现在说一句」和测试用）。
 */
function proactiveSay(force, kind) {
  if (!force && S.proactive === false) return null;
  const isWhale = SKIN().id === "whale";
  let scenario = isWhale ? "whale-idle" : (kind || proactiveScenario());
  let line = "";
  if (isWhale) {
    // 鲸鲸：只用宠物台词，不碰 02 的每日心情 / 事件台词
    line = pick(SKIN().lines.idle);
  } else {
    line = proactiveLine(scenario);
  }
  if (!line) return null;
  // 防止同一句连续出现（最多重抽 3 次）
  var tries = 0;
  while (line && S._lastProactiveLine === line && tries < 3) {
    line = isWhale ? pick(SKIN().lines.idle) : proactiveLine(scenario);
    tries++;
  }
  if (!line) return null;
  S._lastProactiveLine = line;
  saveStore();
  say(line, undefined, { kind: "proactive" });
  if (!isWhale) {
    try { playSfx("pop"); } catch (e) {}
    setPose(scenario === "night" ? "sleep" : "talk");
    setTimeout(() => { if (lastPose === "talk" || lastPose === "sleep") setPose("idle"); }, 2600);
    if (scenario === "night") burst("zzz", { n: 2 });
    else if (scenario === "meal") burst("hearts", { n: 1 });
    else burst("notes", { n: 1 });
    S.lastProactiveAt = Date.now();
    S.lastProactiveScenario = scenario;
    setRecentEvent("你刚主动找 darling 说了句话（" + (PROACTIVE_SCENE_HINT[scenario] || "闲着没事") + "）");
    bumpToday("proactive");
    saveStore();
  }
  resetProactiveTimer();
  return { scenario: scenario, line: line, skin: SKIN().id };
}

/** 跨天检测：页面开着过了零点也要换心情、清小结、说一句新的一天 */
/* ---------------- 时段感：跨过整点时偶尔提一句（一天每段最多一次） ---------------- */
const HOUR_LINES = {
  morning: ["早上了。……先去洗脸，别顶着这个头发就来见我。", "（伸懒腰）天亮了啊。今天也，先看看你。"],
  noon: ["到饭点了。……吃什么？分我一口。", "中午了。别又只喝咖啡，darling。"],
  evening: ["傍晚了。……今天辛苦了，靠过来一会儿。", "（看窗外）天暗下来了。你还在，真好。"],
  late: ["很晚了。……还不睡吗。", "（打了个哈欠）这个点还醒着的人，只有你和我。"],
};
let lastHourSeen = -1;
let hourLineDay = "";
function hourPeriod(h) {
  if (h >= 5 && h < 11) return "morning";
  if (h >= 11 && h < 15) return "noon";
  if (h >= 15 && h < 21) return "evening";
  return "late";
}
function hourLine(period) {
  var pool = HOUR_LINES[period] || HOUR_LINES.evening;
  return pick(pool);
}
function hourTick() {
  var now = new Date();
  var h = now.getHours();
  if (lastHourSeen === h) return;
  lastHourSeen = h;
  var day = todayKey();
  if (hourLineDay === day + "|" + hourPeriod(h)) return;
  var quiet = Date.now() - (S.lastInteractAt || 0) > 45 * 60 * 1000;
  if (quiet || busy || S.proactive === false) return;
  hourLineDay = day + "|" + hourPeriod(h);
  if (SKIN().id === "whale") {
    if (h >= 6 && h < 9) say(pick(["咕噜！早上好呀。", "（甩尾巴）鲸鲸早起啦。"]), undefined, { kind: "event" });
    else if (h >= 12 && h < 14) say(pick(["咕噜咕噜…到饭点了。", "（盯着你的饭）鲸鲸也想吃。"]), undefined, { kind: "event" });
    else if (h >= 19 && h < 22) say(pick(["晚上啦！鲸鲸今天也很努力地发呆。", "（泡泡）天黑了，要早点睡哦。"]), undefined, { kind: "event" });
    else if (h >= 23 || h < 3) say(pick(["咕噜…鲸鲸困了。", "（打哈欠）晚安……"]), undefined, { kind: "event" });
    return;
  }
  if (Math.random() < 0.45) {
    say(hourLine(hourPeriod(h)), undefined, { kind: "event" });
  }
}

/* recentEvent：带时间戳，避免里程碑等旧事件被无限注入 prompt */
function setRecentEvent(text) {
  S.recentEvent = { text: String(text || ""), ts: Date.now() };
}
function recentEventText() {
  var r = S.recentEvent;
  if (!r) return "";
  if (typeof r === "string") return r;   // 旧数据：保留兼容
  if (typeof r === "object" && r.text && Date.now() - (r.ts || 0) < 30 * 60 * 1000) return r.text;
  return "";
}

function dayTick(dt) {
  dayCheckAcc += dt;
  if (dayCheckAcc < 20) return;
  dayCheckAcc = 0;
  const today = todayKey();
  if (!S.dailyMood || S.dailyMood.date === today) return;
  var prevStats2 = S.todayStats;
  var prevMood2 = S.dailyMood;
  ensureTodayStats();   // 先归档昨天（此时 S.dailyMood 还是昨天的）
  ensureDailyMood();    // 再按新日期重掷今日心情
  try { if (prevStats2 && prevStats2.date) generateJournal(prevStats2, prevMood2 && prevMood2.label, prevStats2.date); } catch (e) {}
  resetProactiveTimer();
  S.lastOpenDate = today;
  saveStore();
  if (SKIN().id !== "whale" && S.proactive !== false && lastNewDaySaidFor !== today) {
    lastNewDaySaidFor = today;
    const line = newDayLine(new Date().getHours());
    setTimeout(() => say(line, undefined, { kind: "event" }), 1200);
  }
}

/** 注入 buildSystemPrompt 的 mood：今日心情打底 + 刚才对话里的即时情绪 */
function moodForPrompt() {
  const dm = ensureDailyMood();
  const parts = [];
  if (dm && dm.prompt) parts.push(dm.prompt);
  if (S.mood) parts.push("此刻更细的情绪：" + S.mood);
  return parts.join("；");
}

/** 设置面板里的「02 的今天」区块；鲸鲸换成宠物语气，不用 02 的心情 */
function dailySectionHtml() {
  const isWhale = SKIN().id === "whale";
  const st = ensureTodayStats();
  if (isWhale) {
    const bits = [];
    if (st.pet) bits.push("被摸了 " + st.pet + " 次");
    if (st.feed) bits.push("被投喂了 " + st.feed + " 次");
    return '<div class="z02-sect"><span>鲸鲸的今天</span>' +
      '<div class="z02-hint">咕噜噜～' + (bits.length ? "今天" + bits.join("、") + "，鲸鲸超满足！" : "今天还没被摸摸……鲸鲸有点寂寞。") + "</div>" +
      '<div class="z02-hint" style="opacity:.7">鲸鲸是宠物：她不参与 02 的每日心情和事件台词，只会用自己的宠物语气撒娇。</div></div>';
  }
  const dm = ensureDailyMood();
  const actOn = S.proactive !== false;
  return '<div class="z02-sect"><span>02 的今天 · 今日心情</span>' +
    '<div class="z02-hint" data-role="moodline">今天她是「<b>' + dm.label + "</b>」： " + dm.hint + "</div>" +
    '<div class="z02-hint" data-role="todaystats">📝 今日小结：' + todaySummaryText() + "</div>" +
    '<div class="z02-hint" data-role="diaryline">🖊 ' + diaryLine() + "</div>" +
    (latestJournal() ? '<div class="z02-hint" style="opacity:.85">📖 她的日记（' + latestJournal().date + "）：「" + String(latestJournal().text).replace(/</g, "&lt;") + "」</div>" : "") +
    '<div class="z02-modes" data-role="proactive">' +
    '<button data-pro="1"' + (actOn ? ' class="on"' : "") + ">💬 主动说话 开</button>" +
    '<button data-pro="0"' + (!actOn ? ' class="on"' : "") + ">🔇 关掉</button>" +
    "</div>" +
    '<div class="z02-hint">你安静 4~8 分钟后，她会自己找你说一句；久没动 / 在忙 / 饭点 / 深夜，台词各不一样。</div>' +
    '<div class="z02-actions"><button data-act="proactive-now">让她现在说一句</button></div></div>';
}

/* ------------------------------- 面板 ------------------------------- */
function openPanel(next) {
  // 打开面板时收掉引导卡，避免叠在聊天框上
  try { if (guideEl) { guideEl.remove(); guideEl = null; } } catch (e) {}
  panelEl.classList.add("on");
  menuEl.classList.remove("on");
  if (next === "chat") {
    renderChat();
    setTimeout(() => {
      const input = panelEl.querySelector(".z02-input input");
      if (input) input.focus();
    }, 50);
  } else {
    renderSettings();
  }
}
function closePanel() {
  panelEl.classList.remove("on");
  // 面板关掉 = 用户不想继续听了，正在读的这句也停掉
  try { if (typeof VOICE !== "undefined" && VOICE) VOICE.cancel(); } catch (error) {}
}

let chatAvatarEl = null;
function chatAvatarNode() {
  const img = document.createElement("img");
  img.className = "z02-av";
  img.alt = "";
  try {
    const file = (SKIN && SKIN().thumb) || "onee-idle.webp";
    loadSprite(file).then((u) => { if (img.isConnected) img.src = u; }).catch(() => {});
  } catch (e) {}
  return img;
}
function bubbleNode(role, content, src) {
  const el = document.createElement("div");
  el.className = "z02-msg " + (role === "user" ? "user" : role === "err" ? "err" : role === "sys" ? "sys" : "pet");
  el.textContent = content;
  if (src) {
    const tag = document.createElement("i");
    tag.className = "z02-src";
    tag.textContent = src;
    el.appendChild(tag);
  }
  if (role === "pet") {
    const row = document.createElement("div");
    row.className = "z02-msgrow";
    row.appendChild(chatAvatarNode());
    row.appendChild(el);
    return row;
  }
  return el;
}

function renderChat() {
  panelEl.innerHTML = "";
  const head = document.createElement("div");
  head.className = "z02-head";
  var moodLabel = "";
  try { var dm0 = ensureDailyMood(); moodLabel = dm0 && dm0.label ? dm0.label : ""; } catch (e) {}
  var lv = 1 + Math.floor((S.affinity || 0) / 20);
  head.innerHTML = '<span class="z02-dot' + (S.lastOk === false ? " off" : "") + '"></span><span>' + SKIN().label +
    '</span><span style="font-size:11px;opacity:.55;margin-left:8px;font-weight:400">第 ' + daysKnown() + ' 天' +
    (moodLabel ? " · " + moodLabel : "") + " · Lv" + lv + "</span>";
  try { head.insertBefore(chatAvatarNode(), head.firstChild); } catch (e) {}
  const close = document.createElement("button");
  close.className = "z02-close";
  close.textContent = "×";
  close.onclick = closePanel;
  head.appendChild(close);

  const msgs = document.createElement("div");
  msgs.className = "z02-msgs";
  msgs.dataset.role = "msgs";
  (S.history || []).forEach((m) => msgs.appendChild(bubbleNode(m.role, m.content, m.src)));

  const inputRow = document.createElement("div");
  inputRow.className = "z02-input";
  const input = document.createElement("input");
  input.placeholder = "和 02 说点什么…（Enter 发送）";
  input.maxLength = 300;
  const send = document.createElement("button");
  send.textContent = "发送";
  const submit = () => {
    const text = input.value.trim();
    if (!text || busy) return;
    input.value = "";
    sendMessage(text);
  };
  send.onclick = submit;
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });
  inputRow.append(input, send);

  // 快捷话术：不知道说什么时点一下（帮她/帮你都好开口）
  const QUICK = ["夸她一句", "今天有点累", "你在干嘛？", "我想你了", "摸摸你", "陪我聊会儿"];
  const quickRow = document.createElement("div");
  quickRow.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;padding:0 12px 10px";
  const picks = [];
  while (picks.length < 3 && picks.length < QUICK.length) {
    const c = QUICK[(Math.random() * QUICK.length) | 0];
    if (picks.indexOf(c) < 0) picks.push(c);
  }
  picks.forEach(function (label) {
    const b = document.createElement("button");
    b.textContent = label;
    b.style.cssText = "cursor:pointer;border:1px solid #f3c9d6;background:#fff6f9;color:#b23a5e;" +
      "border-radius:999px;padding:5px 10px;font-size:12px;line-height:1";
    b.onclick = function () {
      if (busy) return;
      const MAP = {
        "夸她一句": "你今天，好像比昨天更好看一点。",
        "今天有点累": "今天有点累。",
        "你在干嘛？": "你在干嘛？",
        "我想你了": "我想你了。",
        "摸摸你": "（伸手摸摸你的头）",
        "陪我聊会儿": "陪我聊会儿吧。",
      };
      const text = MAP[label] || label;
      // 摸摸你 → 直接触发摸头动作，更像"动手"而不是"打字"
      if (label === "摸摸你") { pet(); return; }
      sendMessage(text);
    };
    quickRow.appendChild(b);
  });

  panelEl.append(head, msgs, quickRow, inputRow);
  scrollMsgs();
}

function scrollMsgs() {
  const box = panelEl && panelEl.querySelector('[data-role="msgs"]');
  if (box) box.scrollTop = box.scrollHeight;
}

function pushMsg(role, content, src) {
  if (!S.history) S.history = [];
  S.history.push({ role, content, src });
  if (S.history.length > 40) S.history = S.history.slice(-40);
  saveStore();
  const box = panelEl && panelEl.querySelector('[data-role="msgs"]');
  if (box) {
    box.appendChild(bubbleNode(role, content, src));
    scrollMsgs();
  }
}

function showTyping(on) {
  const box = panelEl && panelEl.querySelector('[data-role="msgs"]');
  if (!box) return;
  let t = box.querySelector(".z02-typing");
  if (on) {
    if (!t) {
      t = document.createElement("div");
      t.className = "z02-typing";
      t.innerHTML = "<i></i><i></i><i></i>";
      box.appendChild(t);
      scrollMsgs();
    }
  } else if (t) t.remove();
}

/* ------------------------------- 模型 ------------------------------- */
async function callModel(which, messages) {
  const cfg = S.cfg[which];
  if (!cfg) return { ok: false, which, error: "没配置端点" };
  const auto = S.autoChat || {};
  const canAuto = which === "cloud" && auto.auto && !cfg.baseURL && !cfg.apiKey;
  if (which === "local" && !cfg.baseURL) return { ok: false, which, error: "没配置端点" };
  if (which === "cloud" && !cfg.apiKey && !canAuto) {
    return { ok: false, which, error: "还没填 API Key（也可以留空，让宿主自动用 DSH 的端点）", skipped: true };
  }
  try {
    const res = await fetch(API + "/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseURL: cfg.baseURL || "",
        model: cfg.model || (canAuto ? auto.model : "") || "",
        apiKey: cfg.apiKey || "",
        messages,
      }),
    });
    const data = await res.json();
    return Object.assign({ which }, data);
  } catch (error) {
    return { ok: false, which, error: String((error && error.message) || error) };
  }
}

/** 从 darling 的话里自动学称呼（只学一次，可在设置里改） */
function learnUserName(text) {
  if (S.userName) return "";
  var m = String(text || "").match(/(?:我叫|叫我|我的名字叫|我是)\s*([\u4e00-\u9fa5A-Za-z]{1,8})/);
  if (!m) return "";
  var name = m[1].replace(/[的了呢呀啊哦吧嘛～~\s]+$/, "").slice(0, 8);
  if (!name || /^(你|我|他|她|它|人|谁|什么|学生|上班|老师|男生|女生)/.test(name)) return "";
  S.userName = name;
  saveStore();
  return name;
}

/** 捕捉 darling 话里的"心里话"：累/难过/压力/开心的事，留到之后关心 */
function catchWhisper(text) {
  var t = String(text || "");
  if (!t || t.length < 4) return;
  var kind = "";
  if (/(累|疲惫|熬夜|加班|撑不住|压力|焦头烂额|复习不完|考试|内卷)/.test(t)) kind = "tired";
  else if (/(难过|委屈|不开心|心情不好|想哭|失落|孤单|寂寞|emo)/.test(t)) kind = "sad";
  else if (/(开心|太棒|成功了|过了|考上|拿到|好玩|笑死)/.test(t)) kind = "happy";
  else if (/(生气|烦死|讨厌|气死|无语)/.test(t)) kind = "angry";
  if (!kind) return;
  try { recordMoment("whisper"); } catch (e) {}
  S.whisper = { kind: kind, text: t.slice(0, 60), ts: Date.now(), followed: false };
  saveStore();
}

/** 用户提到别的女生时，02 会吃醋（每天最多 2 次，避免烦人） */
function jealousCheck(text) {
  var t = String(text || "");
  var today = todayKey();
  if (!S.jealous || S.jealous.date !== today) S.jealous = { date: today, n: 0 };
  if (S.jealous.n >= 2) return "";
  if (!/(女生|女孩|妹子|闺蜜|女朋友|前女友|女同事|女同学|学姐|学妹|师妹|她们|那个她)/.test(t)) {
    // 也认「人名 + 她」这类，但只在明确带女性词时触发
    return "";
  }
  S.jealous.n += 1;
  saveStore();
  return extraLine("jealous") || extraLine("possessive");
}

/** 她说「晚安/早安/生日」时的小仪式 */
function ritualCheck(text) {
  var t = String(text || "");
  var h = new Date().getHours();
  if (/(晚安|睡了|去睡|睡觉了|good\s*night)/i.test(t)) {
    setTimeout(function () {
      say(pick([
        "晚安。明天醒来，还看得见你吧？",
        "晚安，别数羊，数我。",
        "（把灯调暗）……晚安，darling。梦里也归我。",
      ]), 4200, { kind: "event" });
      if (h >= 20 || h < 5) {
        burst("zzz", { n: 2 });
        setTimeout(function () { enterSleep(); }, 1400);
      }
    }, 2600);
    return "night";
  }
  if (/(早安|早上好|起来了|good\s*morning)/i.test(t)) {
    setTimeout(function () {
      say(pick([
        "早。……你头发翘起来了，笨蛋。",
        "（揉眼睛）早安。今天也，先看我一眼再走。",
        "早上好。我给你留了位置。",
      ]), 4200, { kind: "event" });
      setPose("stretch");
      setTimeout(function () { setPose("idle"); }, 1600);
    }, 2600);
    return "morning";
  }
  if (/(今天|今日)/.test(t) && /(是)?我(的)?生日/.test(t)) {
    setTimeout(function () {
      say(pick([
        "生日？……（把糖全塞给你）都给你。今天你最大。",
        "（认真看着你）生日快乐。我没什么能给的——除了往后每一年都记得。",
        "生日啊。……那今天，可以多抱一会儿吗。",
      ]), 5200, { kind: "event" });
      burst("confetti" in {} ? "hearts" : "hearts", { n: 8 });
      setPose("happy");
    }, 2600);
    return "birthday";
  }
  return "";
}

async function sendMessage(text) {
  if (busy) return;
  try { exitSleep(); } catch (e) {}
  try { noteAction("chat"); } catch (e) {}
  try { noteInteraction(); } catch (e) {}
  try { noteTopic(text); } catch (e) {}
  try { notePromise(text); } catch (e) {}
  try { noteBirthday(text); } catch (e) {}
  var ritual = "";
  try { ritual = ritualCheck(text); } catch (e) {}
  try { recordMoment("chat"); } catch (e) {}
  var learned = learnUserName(text);
  var jealousLine = "";
  try { jealousLine = jealousCheck(text); } catch (e) {}
  try { catchWhisper(text); } catch (e) {}
  // 你说累/难过时，除了记录心里话，也先给一句"安慰"（接上台词库 comfort 分类）
  var comfortLine = "";
  try {
    var wk = S.whisper && S.whisper.kind;
    if ((wk === "tired" || wk === "sad") && Date.now() - (S.whisper.ts || 0) < 8000) {
      comfortLine = extraLine("comfort") || "";
    }
  } catch (e) {}
  busy = true;
  const btn = panelEl.querySelector(".z02-input button");
  if (btn) btn.disabled = true;
  try { if (activeRequest("chat")) fulfillRequest("chat"); } catch (e) {}
  try { learnPreference(text); } catch (e) {}
  pushMsg("user", text);
  if (learned) setTimeout(function () { say("……" + learned + "。嗯，记住了，darling。"); }, 300);
  var praiseHit = /(可爱|好看|漂亮|喜欢|最棒|厉害|爱你|真棒)/.test(text);
  if (praiseHit) {
    try { recordMoment("praise"); } catch (e) {}
    try { if (activeRequest("praise")) fulfillRequest("praise"); } catch (e) {}
  }
  if (praiseHit) { try { noteCompliment(text); } catch (e) {} }
  var proudLine = praiseHit ? (extraLine("proud") || "") : "";
  if (comfortLine) setTimeout(function () { say(comfortLine, undefined, { kind: "comfort" }); }, 3200);
  if (jealousLine) setTimeout(function () { say(jealousLine, undefined, { kind: "tease" }); }, 4200);
  else if (proudLine && Math.random() < 0.35) setTimeout(function () { say(proudLine, undefined, { kind: "proud" }); }, 4200);
  setPose("chat");
  showTyping(true);

  const now = new Date();
  const isWhale = SKIN().id === "whale";
  const sys = isWhale
    ? SKIN().prompt + (S.memory && S.memory.length ? "\n\n你记得：" + S.memory.slice(-8).join("、") : "")
    : (typeof PERSONA !== "undefined" && PERSONA
        ? PERSONA.buildSystemPrompt({
            skin: SKIN().id,
            affinity: S.affinity,
            // 每日心情打底 + 刚才的即时情绪，一起喂给 02
            mood: moodForPrompt(),
            memory: S.memory,
            userName: S.userName,
            chats: S.chats,
            recentEvent: recentEventText(),
            whisper: (S.whisper && Date.now() - (S.whisper.ts || 0) < 36 * 3600 * 1000) ? S.whisper.text : "",
            daysKnown: daysKnown(),
            moments: (S.moments || []).map(function (m) {
              return MOMENT_LABELS[m.k] + "（" + momentDaysAgo(m.t) + " 天前）";
            }).slice(-5),
            topics: S.topics || [],
            promises: (S.promises || []).map(function (x) { return x.text; }),
            compliments: S.compliments || [],
            birthday: S.birthday || null,
            anniversary: daysKnown(),
            timeOfDay: { hour: now.getHours(), minute: now.getMinutes() },
          })
        : SKIN().prompt);
  const messages = [
    { role: "system", content: sys },
    ...(S.history || [])
      .filter((m) => m.role === "user" || m.role === "pet")
      .slice(-11)
      .map((m) => ({ role: m.role === "pet" ? "assistant" : "user", content: m.content })),
  ];

  const chain = S.cfg.mode === "local" ? ["local", "cloud"] : ["cloud", "local"];
  const errors = [];

  for (const which of chain) {
    const result = await callModel(which, messages);
    if (result.ok && String(result.reply || "").trim()) {
      showTyping(false);
      S.lastOk = true;
      S.affinity = (S.affinity || 0) + 6;
      S.chats = (S.chats || 0) + 1;
      // 日常感：今日小结 +1 句，刚聊过就先别主动开口
      bumpToday("chats");
      if (S.chats === 100) { try { recordMoment("hundred"); } catch (e) {} }
      S.lastChatAt = Date.now();
      resetProactiveTimer();
      if (typeof PERSONA !== "undefined" && PERSONA && !isWhale) {
        S.mood = PERSONA.moodFromReply(result.reply);
      }
      pushMsg("pet", result.reply, which === "local" ? "本地" : "云端");
      saveStore();
      updateBadge();
      say(result.reply, Math.min(6000, Math.max(2600, result.reply.length * 220)), { kind: "chat" });
      playSfx("chime");
      burst("notes", { n: 4 });
      // 根据回复内容给表情反馈
      var rtext = String(result.reply || "");
      if (/(嘿嘿|哈哈|开心|喜欢|太好了|真棒|ふふ|想见你)/.test(rtext)) { setPose("happy"); burst("sparkles", { n: 6 }); }
      else if (/(害羞|脸红|别这样|讨厌啦|笨蛋)/.test(rtext)) { setPose("shy"); burst("hearts", { n: 2 }); }
      else if (/(困|睡觉|晚安|好累)/.test(rtext)) { setPose("sleep"); }
      else if (/(不许|吃醋|只能|别人)/.test(rtext)) { setPose("shy"); }
      else if (/(嗯|好|喜欢|抱|亲)/.test(rtext)) { setPose("happy"); }
      else { setPose("talk"); }
      setTimeout(() => setPose("idle"), 2400);
      // 你的回答太短（"嗯""还行"）时，她会像真的聊天一样追问一句（每天最多 2 次）
      try {
        var shortAns = String(text || "").length <= 5 && !/[?？嘛呢]/.test(String(text || ""));
        if (shortAns && !isWhale && !S.request && Math.random() < 0.28) {
          var fk = todayKey();
          if (!S.followUpDay || S.followUpDay.date !== fk) S.followUpDay = { date: fk, n: 0 };
          if (S.followUpDay.n < 2) {
            var fuLine = topicFollowUpLine() || extraLine("curious") || memoryCallbackLine() || "";
            if (fuLine) {
              S.followUpDay.n += 1;
              saveStore();
              setTimeout(function () {
                say(fuLine, undefined, { kind: "event" });
                try { pushMsg("pet", fuLine); saveStore(); } catch (e) {}
              }, 6000 + Math.random() * 3000);
            }
          }
        }
      } catch (e) {}
      // 每 6 句聊一次：后台把最近对话压成长期记忆
      if (!isWhale && S.chats % 6 === 0) maybeUpdateMemory();
      // 里程碑（20/50/100 句）+ 连续聊太久提醒
      if (!isWhale) {
        const MS = [20, 50, 100];
        if (MS.indexOf(S.chats) >= 0) {
          setRecentEvent("milestone-" + S.chats);
          saveStore();
          setTimeout(() => { say(personaLine("milestone", { count: S.chats }) || "（凑近）喂，我们聊了好多句了。……我还想继续。", undefined, { kind: "event" }); }, 2200);
        }
        if (S.sessionStart && Date.now() - S.sessionStart > 45 * 60 * 1000 && !S.longChatWarned) {
          S.longChatWarned = true;
          saveStore();
          setTimeout(() => { say(personaLine("long-chat") || "聊这么久，你眼睛不酸吗？……不过，我不想放你走。", undefined, { kind: "event" }); }, 2600);
        }
      }
      touchSeen();
      finish();
      return;
    }
    if (!result.skipped) errors.push((which === "local" ? "本地" : "云端") + "：" + (result.error || "空回复"));
  }

  showTyping(false);
  S.lastOk = false;
  saveStore();
  const box = panelEl.querySelector('[data-role="msgs"]');
  if (box) box.appendChild(bubbleNode("err", errors.join("\n") || "没有可用的模型"));
  scrollMsgs();
  say(pick(SKIN().lines.error));
  playSfx("error");
  setPose("idle");
  finish();

  function finish() {
    busy = false;
    if (btn) btn.disabled = false;
    const input = panelEl.querySelector(".z02-input input");
    if (input) input.focus();
  }
}

/* ---------------- 长期记忆：每聊几句，把对话压成关于 darling 的事实 ---------------- */
var memoryBusy = false;
/** 加一条"她记住的事实"（去重、最多 16 条） */
function rememberFact(fact) {
  fact = String(fact || "").trim();
  if (!fact || fact.length > 24) return false;
  S.memory = S.memory || [];
  if (S.memory.indexOf(fact) >= 0) return false;
  S.memory.push(fact);
  S.memory = S.memory.slice(-16);
  saveStore();
  return true;
}

/** 规则提取：喜欢/不喜欢/口味/身份/作息——不用等 LLM，马上记住 */
function learnPreference(text) {
  var t = String(text || "");
  if (!t) return 0;
  var found = 0;
  var pats = [
    { re: /我(?:很|超|最|特别|挺)?(?:喜欢|爱吃|爱喝|偏爱|迷上了?)([^，。！？,.!?\n]{1,10})/g, pre: "喜欢" },
    { re: /我(?:很|超|最|特别|挺)?(?:不喜欢|不爱吃|不爱喝|讨厌|受不了|怕)([^，。！？,.!?\n]{1,10})/g, pre: "不喜欢" },
    { re: /我(?:是|在)(?:做|当|干)([^，。！？,.!?\n]{1,10})/g, pre: "职业" },
    { re: /我(?:平时|平常|一般)([^，。！？,.!?\n]{2,12})/g, pre: "平时" },
    { re: /我(?:的)?(?:生日|星座)(?:是|在)([^，。！？,.!?\n]{2,12})/g, pre: "" },
  ];
  for (var i = 0; i < pats.length; i++) {
    var m;
    pats[i].re.lastIndex = 0;
    while ((m = pats[i].re.exec(t))) {
      var v = String(m[1] || "").replace(/[的了呢啊呀嘛哦吧]+$/, "").trim();
      if (!v) continue;
      var fact = (pats[i].pre ? pats[i].pre + "：" : "") + v;
      if (rememberFact(fact)) found++;
    }
  }
  return found;
}

async function maybeUpdateMemory() {
  if (memoryBusy || typeof PERSONA === "undefined" || !PERSONA) return;
  if ((S.history || []).length < 6) return;
  memoryBusy = true;
  try {
    const recent = (S.history || [])
      .filter((m) => m.role === "user" || m.role === "pet")
      .slice(-14)
      .map((m) => (m.role === "user" ? "darling: " : "02: ") + m.content)
      .join("\n");
    const prompt = [
      { role: "system", content: PERSONA.summariseMemoryPrompt() },
      { role: "user", content: recent },
    ];
    const chain = S.cfg.mode === "local" ? ["local", "cloud"] : ["cloud", "local"];
    for (const which of chain) {
      const r = await callModel(which, prompt);
      if (!r.ok || !r.reply) continue;
      const m = String(r.reply).match(/\[[\s\S]*\]/);
      if (!m) break;
      let arr = null;
      try { arr = JSON.parse(m[0]); } catch {}
      if (!Array.isArray(arr)) break;
      const clean = arr.map((x) => String(x).trim().replace(/^[-•]\s*/, "")).filter((x) => x && x.length <= 24).slice(0, 5);
      if (clean.length) {
        S.memory = (S.memory || []).concat(clean);
        // 去重 + 只看最近 16 条
        const seen = Object.create(null);
        S.memory = S.memory.filter((x) => (seen[x] ? false : (seen[x] = 1)));
        S.memory = S.memory.slice(-16);
        saveStore();
      }
      break;
    }
  } catch (error) {
  } finally {
    memoryBusy = false;
  }
}

/** 她用 LLM 写今天的小日记（失败就悄悄跳过，不打扰） */
async function generateJournal(stats, moodLabel, dateKey) {
  try {
    if (journalBusy || typeof PERSONA === "undefined" || !PERSONA || !PERSONA.journalPrompt) return false;
    journalBusy = true;
    var recent = (S.history || [])
      .filter(function (m) { return m.role === "user" || m.role === "pet"; })
      .slice(-10)
      .map(function (m) { return (m.role === "user" ? "darling: " : "02: ") + m.content; })
      .join("\n");
    var info = "（今天的记录）聊天 " + (stats.chats || 0) + " 句、被摸 " + (stats.pet || 0) +
      " 次、投喂 " + (stats.feed || 0) + " 次、我主动开口 " + (stats.proactive || 0) + " 次；我当天的心情是「" + (moodLabel || "普通") + "」。";
    var prompt = [
      { role: "system", content: PERSONA.journalPrompt() },
      { role: "user", content: info + "\n最近的对话：\n" + recent },
    ];
    var chain = S.cfg.mode === "local" ? ["local", "cloud"] : ["cloud", "local"];
    for (var i = 0; i < chain.length; i++) {
      var r = await callModel(chain[i], prompt);
      if (!r || !r.ok || !r.reply) continue;
      var text = String(r.reply).replace(/^["「『]+|["」』]+$/g, "").replace(/\s+/g, " ").trim();
      if (!text) continue;
      if (text.length > 80) text = text.slice(0, 80);
      S.journal = (S.journal || []).filter(function (x) { return x && x.date !== dateKey; });
      S.journal.push({ date: dateKey, text: text, t: Date.now() });
      S.journal = S.journal.slice(-14);
      saveStore();
      return true;
    }
  } catch (e) {
  } finally {
    journalBusy = false;
  }
  return false;
}

/** 一周小记：每 7 天（或距上次 >=6 天）生成一次，最多留 4 条 */
async function maybeWeeklyNote() {
  try {
    if (weeklyBusy || typeof PERSONA === "undefined" || !PERSONA || !PERSONA.weeklyPrompt) return false;
    var last = (S.weekNotes || [])[S.weekNotes ? S.weekNotes.length - 1 : 0];
    if (last && Date.now() - last.t < 6 * 86400000) return false;
    if ((S.chats || 0) < 20) return false;
    weeklyBusy = true;
    var recent = (S.diary || []).slice(-7).map(function (d) {
      return d.date + " 聊" + (d.chats || 0) + " 摸" + (d.pet || 0) + " 心情" + (d.mood || "");
    }).join("；");
    var info = "这一周的记录：" + (recent || "（这周你来得很零散）") +
      "。认识第 " + daysKnown() + " 天；印象最深的事：" +
      ((S.moments || []).slice(-3).map(function (m) { return MOMENT_LABELS[m.k]; }).join("、") || "无") + "。";
    var prompt = [
      { role: "system", content: PERSONA.weeklyPrompt() },
      { role: "user", content: info },
    ];
    var chain = S.cfg.mode === "local" ? ["local", "cloud"] : ["cloud", "local"];
    for (var i = 0; i < chain.length; i++) {
      var r = await callModel(chain[i], prompt);
      if (!r || !r.ok || !r.reply) continue;
      var text = String(r.reply).replace(/^["「『]+|["」』]+$/g, "").replace(/\s+/g, " ").trim();
      if (!text) continue;
      if (text.length > 120) text = text.slice(0, 120);
      S.weekNotes = (S.weekNotes || []).concat([{ t: Date.now(), date: todayKey(), text: text }]).slice(-4);
      saveStore();
      weeklyBusy = false;
      return true;
    }
  } catch (e) {}
  weeklyBusy = false;
  return false;
}

/** 最近的周记（开机偶尔念） */
function latestWeekNote() {
  var list = S.weekNotes || [];
  return list.length ? list[list.length - 1] : null;
}

/** 最近一条她的日记 */
function latestJournal() {
  var list = S.journal || [];
  return list.length ? list[list.length - 1] : null;
}

/* ---------------- 会话内「你刚刚去哪儿了」 ---------------- */
const IN_SESSION_RETURN = [
  "（抬头）……你刚刚去哪儿了。",
  "（视线跟过来）我还以为你走了。",
  "（把脸埋进胳膊里，又抬起来）……回来就好。",
];
/** 用最近话题追问一句（比泛泛"你今天笑过几次"更有连续性） */
function topicFollowUpLine() {
  try {
    var list = (S.topics || []).filter(function (t) { return t && t.length >= 5; });
    if (list.length < 2) return "";
    // 避开最近 2 分钟刚说的（那通常就是刚才那句）
    var idx = Math.max(0, list.length - 2 - ((Math.random() * 3) | 0));
    var t = list[idx];
    if (!t) return "";
    return pick([
      "对了，你之前说「" + t + "」……后来怎么样了？",
      "（想了想）「" + t + "」那件事，还没说完吧。",
      "你上次提的「" + t + "」，我还在等后续。",
    ]);
  } catch (e) { return ""; }
}

/** 记录最近聊到的话题（短句，去重，最多 10 条） */
function noteTopic(text) {
  try {
    var t = String(text || "").replace(/\s+/g, " ").trim();
    if (!t || t.length < 3) return;
    if (t.length > 40) t = t.slice(0, 40) + "…";
    S.topics = S.topics || [];
    if (S.topics.some(function (x) { return x === t || (x.length > 6 && t.indexOf(x) >= 0); })) return;
    S.topics.push(t);
    S.topics = S.topics.slice(-10);
    saveStore();
  } catch (e) {}
}

function noteInteraction() {
  try {
    var now = Date.now();
    var gap = now - (S.lastInteractAt || now);
    S.lastInteractAt = now;
    saveStore();
    if (gap > 12 * 60 * 1000 && (S.chats || 0) > 3 && Math.random() < 0.7) {
      setTimeout(function () { say(pick(IN_SESSION_RETURN), 3600, { kind: "event" }); }, 1600);
    }
  } catch (e) {}
}

/* ---------------- 久别回来：模型生成的主动开场白 ---------------- */
let openerBusy = false;
async function llmOpener() {
  try {
    if (openerBusy || typeof PERSONA === "undefined" || !PERSONA) return null;
    if ((S.chats || 0) < 8) return null;
    if (!S.lastSeen || Date.now() - S.lastSeen < 30 * 60 * 1000) return null;
    if (S.lastOpenerAt && Date.now() - S.lastOpenerAt < 2 * 3600 * 1000) return null;
    if (SKIN().id === "whale") return null;
    openerBusy = true;
    var now = new Date();
    var sys = PERSONA.buildSystemPrompt({
      skin: SKIN().id,
      affinity: S.affinity,
      mood: moodForPrompt(),
      memory: S.memory,
      userName: S.userName,
      chats: S.chats,
      recentEvent: recentEventText(),
      whisper: (S.whisper && Date.now() - (S.whisper.ts || 0) < 36 * 3600 * 1000) ? S.whisper.text : "",
      daysKnown: daysKnown(),
      moments: (S.moments || []).map(function (m) {
        return MOMENT_LABELS[m.k] + "（" + momentDaysAgo(m.t) + " 天前）";
      }).slice(-5),
      topics: S.topics || [],
      timeOfDay: { hour: now.getHours(), minute: now.getMinutes() },
    });
    var prompt = [
      { role: "system", content: sys },
      { role: "user", content: "（darling 刚回来、站到你面前了。你主动开口说一句：可以提到你记得的事、问他在忙什么，或只是嘴硬地说想他。只输出你这一句话，1~2 短句，不要旁白解释。）" },
    ];
    var chain = S.cfg.mode === "local" ? ["local", "cloud"] : ["cloud", "local"];
    for (var i = 0; i < chain.length; i++) {
      var r = await callModel(chain[i], prompt);
      if (!r || !r.ok || !r.reply) continue;
      var text = String(r.reply).replace(/^["「『]+|["」』]+$/g, "").replace(/\s+/g, " ").trim();
      if (!text) continue;
      if (text.length > 90) text = text.slice(0, 90);
      S.lastOpenerAt = Date.now();
      saveStore();
      setTimeout(function () {
        say(text, Math.min(6200, Math.max(2600, text.length * 200)), { kind: "event" });
        try { pushMsg("pet", text); saveStore(); } catch (e) {}
      }, 2600);
      openerBusy = false;
      return text;
    }
  } catch (e) {
  } finally {
    openerBusy = false;
  }
  return null;
}

/* ------------------------------- 声音（TTS） ------------------------------- */
const VOICE_ON_LINE = "嗯，我在。……darling，听见了吗？";

/** 设置面板里的语音状态提示：选中的声线 / 参数 / 降级原因 */
function voiceHintText() {
  var st = null;
  try { st = typeof VOICE !== "undefined" && VOICE ? VOICE.status() : null; } catch (error) { st = null; }
  var isWhale = SKIN().id === "whale";
  var on = !!(S.voice && S.voice.on);
  if (!st) return "语音模块没加载（不会报错，只是少一个声音）。";
  if (!st.supported) return "这个浏览器不支持系统语音（Web Speech API）。已静默降级：只显示气泡，不会有任何报错。";
  var base = isWhale ? st.whale : st.base;
  var tip = isWhale ? "鲸鲸用更高更奶的声线" : "02 用少女声线";
  if (st.degraded) {
    if (!st.voiceCount) return "正在等系统语音列表加载……（浏览器异步给，稍等 1~2 秒会自动刷新）";
    return "系统里没有中文语音，已静默降级（不会用英文嗓音硬念中文）。macOS：系统设置 → 辅助功能 → 朗读内容 → 系统声音 → 管理声音，下载「婷婷 / 美佳」后回来刷新。";
  }
  return tip + "：「" + st.voice + "」（" + st.lang + "）· 参数 rate " + base.rate + " / pitch " + base.pitch +
    " · " + (on ? "已开启" : "默认关，点上面打开") +
    "。与音效开关互不影响；聊天回复、摸头、投喂、她主动开口时会朗读。";
}

/** 开/关语音（持久化到 S.voice）；silent=true 时不发确认音（调试 API 用） */
function setVoiceEnabled(on, silent) {
  if (!S.voice || typeof S.voice !== "object") S.voice = { on: false };
  S.voice.on = !!on;
  saveStore();
  try {
    if (typeof VOICE === "undefined" || !VOICE) return;
    if (!S.voice.on) { VOICE.cancel(); return; }
    if (!silent) VOICE.speak(VOICE_ON_LINE, { force: true, kind: "toggle" });
  } catch (error) {}
}

/* ------------------------------- 设置 ------------------------------- */
function renderSettings() {
  panelEl.innerHTML = "";
  const head = document.createElement("div");
  head.className = "z02-head";
  head.innerHTML = "<span>⚙️ 设置</span>";
  try { head.insertBefore(chatAvatarNode(), head.firstChild); } catch (e) {}
  const close = document.createElement("button");
  close.className = "z02-close";
  close.textContent = "×";
  close.onclick = closePanel;
  head.appendChild(close);

  const form = document.createElement("div");
  form.className = "z02-form";
  const modeBtns = ["local", "cloud", "auto"]
    .map((m) => '<button data-mode="' + m + '"' + (S.cfg.mode === m ? ' class="on"' : "") + ">" + { local: "本地", cloud: "DeepSeek", auto: "自动" }[m] + "</button>")
    .join("");

  const skinBtns = SKINS.map(
    (k) =>
      '<button data-skin="' + k.id + '"' + (S.skin === k.id ? ' class="on"' : "") + ">" +
      '<img data-thumb="' + k.thumb + '" alt="" draggable="false">' +
      "<span>" + k.label.replace("02 · ", "") + "</span>" +
      "<em>" + k.style + "</em></button>"
  ).join("");

  form.innerHTML =
    '<div class="z02-hint" style="margin-bottom:2px">形象（只显示一个，随时切）</div>' +
    '<div class="z02-skins">' + skinBtns + "</div>" +
    dailySectionHtml() +
    '<div class="z02-sect" style="margin-top:4px"><span>形态</span>' +
    '<div class="z02-modes" data-role="dim">' +
    '<button data-dim="3d"' + (S.dim === "3d" ? ' class="on"' : "") + ">🧊 3D 手办</button>" +
    '<button data-dim="2d"' + (S.dim === "2d" ? ' class="on"' : "") + ">🖼 2D 立绘</button>" +
    "</div>" +
    '<div class="z02-hint" data-role="dimhint">' + (S.dim === "3d" ? "左键拖动移动 · 右键拖动转视角 · 滚轮缩放 · 她会看着你的鼠标" : "经典立绘模式，最省资源") + "</div></div>" +
    '<div class="z02-sect"><span>02 的 3D 模型（实验）</span>' +
    '<div class="z02-modes" data-role="modelhd">' +
    '<button data-hd="0"' + (!S.modelHd ? ' class="on"' : "") + ">经典 TDA</button>" +
    '<button data-hd="1"' + (S.modelHd ? ' class="on"' : "") + ">游戏风 Darling</button>" +
    "</div>" +
    '<div class="z02-hint">经典：造型最还原（军装外套+黑丝+白靴）。游戏风：脸和贴图更精细，但造型是黑短裙+白球鞋，切换后需要重新加载 3D。</div></div>' +
    '<div class="z02-sect"><span>画面</span>' +
    '<div class="z02-modes" data-role="picstyle">' +
    '<button data-pic="anime"' + (S.picStyle !== "native" ? ' class="on"' : "") + ">动画滤镜</button>" +
    '<button data-pic="native"' + (S.picStyle === "native" ? ' class="on"' : "") + ">原生清晰</button>" +
    "</div>" +
    '<div class="z02-modes" data-role="frame" style="margin-top:6px">' +
    '<button data-frame="full"' + ((S.frame || "full") === "full" ? ' class="on"' : "") + ">全身取景</button>" +
    '<button data-frame="bust"' + (S.frame === "bust" ? ' class="on"' : "") + ">半身取景</button>" +
    '<button data-frame="auto"' + (S.frame === "auto" ? ' class="on"' : "") + ">自动（小窗半身）</button>" +
    "</div>" +
    '<div class="z02-modes" data-role="size" style="margin-top:6px">' +
    '<button data-size="240"' + (Number(S.customSize) === 240 ? ' class="on"' : "") + ">小号</button>" +
    '<button data-size="320"' + (Number(S.customSize) === 320 ? ' class="on"' : "") + ">中号</button>" +
    '<button data-size="420"' + (Number(S.customSize) === 420 ? ' class="on"' : "") + ">大号</button>" +
    '<button data-size="0"' + (!S.customSize ? ' class="on"' : "") + ">默认</button>" +
    "</div>" +
    '<div class="z02-hint">动画滤镜：轻微提饱和/对比 + 柔光暗角（仅 3D 生效，不糊文字）。半身取景会把镜头拉近到上半身，小窗口里脸更清楚。尺寸也可以直接拖窗口右下角自由缩放。</div></div>' +
    '<div class="z02-sect"><span>头发细节</span>' +
    '<div class="z02-modes" data-role="strands">' +
    '<button data-strands="1"' + (S.hairStrands !== false ? ' class="on"' : "") + ">发丝增强 开</button>" +
    '<button data-strands="0"' + (S.hairStrands === false ? ' class="on"' : "") + ">关（更省电）</button>" +
    "</div>" +
    '<div class="z02-hint">在原发片外叠一层程序化发丝（+1 次绘制），切换会重建 3D。</div></div>' +
    '<div class="z02-size"><span>大小 <b data-role="sizeval">—</b> px　（拖动实时预览）</span>' +
    '<input type="range" data-k="size" min="80" max="420" step="2"></div>' +
    '<div class="z02-size" style="margin-top:2px"><span>双击动作</span>' +
    '<div class="z02-modes" style="margin-top:3px">' +
    DBL_ACTIONS.map((a) => '<button data-dbl="' + a.id + '"' + ((S.dblAction || "spin") === a.id ? ' class="on"' : "") + ">" + a.label + "</button>").join("") +
    "</div></div>" +
    '<div class="z02-modes">' + modeBtns + "</div>" +
    '<div class="z02-hint" data-role="modehint">' + MODE_HINT[S.cfg.mode] + "</div>" +
    '<div class="z02-sect"><span>画质 / 声音</span>' +
    '<div class="z02-modes" data-role="quality">' +
    ["high", "medium", "low"].map(function (q) {
      return '<button data-q="' + q + '"' + (S.quality === q ? ' class="on"' : "") + ">" + { high: "高", medium: "中", low: "省电" }[q] + "</button>";
    }).join("") +
    "</div>" +
    '<div class="z02-modes" data-role="sound">' +
    '<button data-snd="1"' + (S.sound !== false ? ' class="on"' : "") + ">🔊 音效开</button>" +
    '<button data-snd="0"' + (S.sound === false ? ' class="on"' : "") + ">🔇 静音</button>" +
    "</div></div>" +
    '<div class="z02-sect" data-role="voicesect"><span>🗣 02 的声音（系统 TTS）</span>' +
    '<div class="z02-modes" data-role="voice">' +
    '<button data-voice="1"' + (S.voice.on ? ' class="on"' : "") + ">🔊 让她说话</button>" +
    '<button data-voice="0"' + (!S.voice.on ? ' class="on"' : "") + ">🔇 不出声</button>" +
    "</div>" +
    '<div class="z02-modes" data-role="voicescope">' +
    '<button data-vscope="all"' + ((S.voice.mode || "all") === "all" ? ' class="on"' : "") + ">全部台词</button>" +
    '<button data-vscope="chat"' + (S.voice.mode === "chat" ? ' class="on"' : "") + ">仅聊天回复</button>" +
    "</div>" +
    '<div class="z02-actions"><button data-act="voice-test">试听一句</button></div>' +
    '<label>声线<select data-k="voiceName"></select></label>' +
    '<div class="z02-size"><span>语速 <b data-role="rateval">—</b></span><input type="range" data-k="voiceRate" min="0.8" max="1.4" step="0.01"></div>' +
    '<div class="z02-size"><span>音调 <b data-role="pitchval">—</b></span><input type="range" data-k="voicePitch" min="0.9" max="1.7" step="0.01"></div>' +
    '<div class="z02-actions" data-role="voicepresets">' +
    '<button data-vp="soft">🐰 软一点</button>' +
    '<button data-vp="normal">🌸 标准</button>' +
    '<button data-vp="sharp">🔥 飒一点</button>' +
    "</div>" +
    '<div class="z02-hint" data-role="voicehint">' + voiceHintText() + "</div>" +
    '<div class="z02-hint" style="opacity:.7">默认关闭；和上面的音效开关互相独立。系统语音读中文，不是 02 的原版声优。</div></div>' +
    '<div class="z02-sect"><span>02 心里的你' +
    (typeof PERSONA !== "undefined" && PERSONA ? "（" + PERSONA.relationshipStage(S.affinity).label + "）" : "") +
    " · 认识第 " + daysKnown() + " 天</span>" +
    '<div class="z02-hint" data-role="stagetip">' +
    (typeof PERSONA !== "undefined" && PERSONA ? PERSONA.relationshipStage(S.affinity).tone : "") +
    "</div>" +
    '<div class="z02-chips" data-role="memchips">' +
    ((S.memory || []).length
      ? S.memory.map(function (m, mi) {
          return '<span class="chip" data-mem="' + mi + '" title="点一下忘掉这条" style="cursor:pointer">' +
            String(m).replace(/</g, "&lt;") + " ×</span>";
        }).join("")
      : '<span class="chip" style="opacity:.55">还没记住什么，多聊聊</span>') +
    "</div>" +
    '<div class="z02-hint" style="opacity:.65">点记忆条目可以让她忘掉那一条。</div>' +
    ((S.moments || []).length
      ? '<div class="z02-chips" style="opacity:.85">' + S.moments.map(function (m) {
          return '<span class="chip" style="cursor:default">' + (MOMENT_LABELS[m.k] || m.k) + "（" + momentDaysAgo(m.t) + " 天前）</span>";
        }).slice(-5).join("") + "</div>"
      : "") +
    (latestWeekNote() ? '<div class="z02-hint" style="opacity:.75">🗓 这一周：「' + String(latestWeekNote().text).replace(/</g, "&lt;") + '」</div>' : "") +
    ((S.journal || []).length
      ? '<div class="z02-hint" style="opacity:.75">📖 她的日记：' + (S.journal || []).slice(-3).map(function (j) {
          return (j.date ? j.date.slice(5) + " " : "") + String(j.text).replace(/</g, "&lt;");
        }).join(" ／ ") + "</div>"
      : "") +
    '<div class="z02-actions"><button data-act="clearmem">让她忘掉这些</button></div></div>' +
    '<div class="z02-sect"><span>📦 数据</span>' +
    '<div class="z02-actions">' +
    '<button data-act="exportdata">导出记忆与日记</button>' +
    '<button data-act="clearhistory">清空聊天记录</button>' +
    '<button data-act="resetall">重置全部数据</button>' +
    "</div>" +
    '<div class="z02-actions"><button data-act="resetlook">恢复默认外观</button></div>' +
    '<div class="z02-actions"><button data-act="snapshot">📸 拍一张她的照片</button></div>' +
    '<div class="z02-hint">导出为 JSON（不含 API Key）；重置会清空记忆/日记/好感/聊天。按钮需要连点两次确认。</div></div>' +
    '<div class="z02-sect"><span>本地模型（免费）</span>' +
    '<label>地址<input data-k="local.baseURL" spellcheck="false" placeholder="http://127.0.0.1:11434/v1"></label>' +
    '<label>模型<input data-k="local.model" spellcheck="false" placeholder="qwen2.5:3b"></label>' +
    '<div class="z02-actions"><button data-act="scan">检测本机模型</button></div>' +
    '<div class="z02-chips" data-role="models"></div></div>' +
    '<div class="z02-sect"><span>云端（DeepSeek · 可用 DSH 自带配置）</span>' +
    '<label>地址<input data-k="cloud.baseURL" spellcheck="false" placeholder="留空 = 自动使用 DSH 配置的端点"></label>' +
    '<label>模型<input data-k="cloud.model" spellcheck="false" placeholder="deepseek-flash"></label>' +
    '<label>API Key<input data-k="cloud.apiKey" type="password" spellcheck="false" placeholder="留空 = 自动使用 DSH 的 Key"></label>' +
    '<div class="z02-hint" data-role="autochat">正在检测 DSH 的模型端点…</div></div>' +
    '<div class="z02-hint">Key 只在这个本机 DSH 进程里使用，不会离开你的电脑；浏览器里也不会保存明文。</div>' +
    '<div class="z02-hint" style="opacity:.5;text-align:center;padding-top:6px">zero02-pet v' + (typeof CLIENT_VER !== "undefined" ? CLIENT_VER : "?") +
    " · 02 桌宠 · 认识第 " + daysKnown() + " 天</div>";

  const foot = document.createElement("div");
  foot.className = "z02-foot";
  foot.innerHTML =
    '<div class="z02-actions"><button data-act="test">测试当前模式</button><button class="primary" data-act="save">保存</button></div>' +
    '<div class="z02-actions"><button data-act="dock">回到右下角</button><button data-act="view">视角复位</button></div>' +
    '<div class="z02-hint" data-role="stats">好感度 Lv' + affinity() + " · 已聊 " + (S.chats || 0) + " 句" +
    (typeof PERSONA !== "undefined" && PERSONA ? " · " + PERSONA.relationshipStage(S.affinity).label : "") +
    ((S.memory || []).length ? " · 记忆 " + S.memory.length + " 条" : "") + "</div>" +
    '<div class="z02-result" data-role="result"></div>';

  panelEl.append(head, form, foot);

  const get = (k) => form.querySelector('[data-k="' + k + '"]');
  const result = foot.querySelector('[data-role="result"]');
  const chips = form.querySelector('[data-role="models"]');
  const modeHint = form.querySelector('[data-role="modehint"]');
  const autoTip = form.querySelector('[data-role="autochat"]');
  // 应用用户保存的声线
  setTimeout(function () {
    try {
      if (S.voice && S.voice.name && window.VOICE && VOICE.setVoice) VOICE.setVoice(S.voice.name);
    } catch (error) {}
  }, 1200);

  fetch(API + "/config", { cache: "no-store" })
    .then((r) => r.json())
    .then((d) => {
      S.autoChat = d && d.ok ? d : null;
      if (autoTip) {
        autoTip.textContent = d && d.auto
          ? "✓ 已检测到 DSH 的模型端点（" + (d.model || "deepseek") + "），地址和 Key 留空即可直接聊天。"
          : "没有检测到 DSH 的模型端点：请填地址 + Key，或在本机跑 Ollama。";
      }
    })
    .catch(() => {
      if (autoTip) autoTip.textContent = "检测失败（宿主未响应）。";
    });
  let pendingMode = S.cfg.mode;

  // 声音控件
  try {
    if (!S.voice) S.voice = { on: false };
    var vSel = form.querySelector('[data-k="voiceName"]');
    if (vSel && window.VOICE && VOICE.listVoices) {
      var vlist = VOICE.listVoices() || [];
      vSel.innerHTML = '<option value="">自动挑选（推荐）</option>' + vlist.map(function (v) {
        return '<option value="' + String(v.name).replace(/"/g, "&quot;") + '">' + String(v.name) + " · " + v.lang + (v.local ? " · 本机" : " · 在线") + "</option>";
      }).join("");
      vSel.value = S.voice.name || "";
      vSel.onchange = function () {
        S.voice.name = vSel.value || "";
        saveStore();
        if (S.voice.name && window.VOICE) VOICE.setVoice(S.voice.name);
        var h = form.querySelector('[data-role="voicehint"]');
        if (h) h.textContent = voiceHintText();
        if (window.VOICE && VOICE.test) VOICE.test();
      };
    }
    var rEl = form.querySelector('[data-k="voiceRate"]'), pEl = form.querySelector('[data-k="voicePitch"]');
    var rv = form.querySelector('[data-role="rateval"]'), pv = form.querySelector('[data-role="pitchval"]');
    if (rEl) {
      rEl.value = typeof S.voice.rate === "number" ? S.voice.rate : 1.08;
      if (rv) rv.textContent = Number(rEl.value).toFixed(2);
      rEl.oninput = function () {
        if (rv) rv.textContent = Number(rEl.value).toFixed(2);
      };
      rEl.onchange = function () {
        S.voice.rate = Number(rEl.value);
        saveStore();
        if (window.VOICE && VOICE.test) VOICE.test();
        var h = form.querySelector('[data-role="voicehint"]');
        if (h) h.textContent = voiceHintText();
      };
    }
    if (pEl) {
      pEl.value = typeof S.voice.pitch === "number" ? S.voice.pitch : 1.22;
      if (pv) pv.textContent = Number(pEl.value).toFixed(2);
      pEl.oninput = function () {
        if (pv) pv.textContent = Number(pEl.value).toFixed(2);
      };
      pEl.onchange = function () {
        S.voice.pitch = Number(pEl.value);
        saveStore();
        if (window.VOICE && VOICE.test) VOICE.test();
        var h = form.querySelector('[data-role="voicehint"]');
        if (h) h.textContent = voiceHintText();
      };
    }
  } catch (error) {}

  form.querySelectorAll("[data-vp]").forEach(function (b) {
    b.onclick = function () {
      var PRESETS = {
        soft: { rate: 0.96, pitch: 1.34 },
        normal: { rate: 1.08, pitch: 1.22 },
        sharp: { rate: 1.16, pitch: 1.06 },
      };
      var pv2 = PRESETS[b.dataset.vp] || PRESETS.normal;
      if (!S.voice) S.voice = { on: false };
      S.voice.rate = pv2.rate;
      S.voice.pitch = pv2.pitch;
      saveStore();
      var rr = form.querySelector('[data-k="voiceRate"]'), pp = form.querySelector('[data-k="voicePitch"]');
      var rl = form.querySelector('[data-role="rateval"]'), pl = form.querySelector('[data-role="pitchval"]');
      if (rr) { rr.value = pv2.rate; if (rl) rl.textContent = Number(pv2.rate).toFixed(2); }
      if (pp) { pp.value = pv2.pitch; if (pl) pl.textContent = Number(pv2.pitch).toFixed(2); }
      form.querySelectorAll("[data-vp]").forEach(function (x) { x.classList.toggle("on", x === b); });
      if (window.VOICE && VOICE.test) VOICE.test();
      var hh = form.querySelector('[data-role="voicehint"]');
      if (hh) hh.textContent = voiceHintText();
    };
  });

  get("local.baseURL").value = S.cfg.local.baseURL;
  get("local.model").value = S.cfg.local.model;
  get("cloud.baseURL").value = S.cfg.cloud.baseURL;
  get("cloud.model").value = S.cfg.cloud.model;
  get("cloud.apiKey").value = S.cfg.cloud.apiKey || "";

  form.querySelectorAll("[data-dbl]").forEach((b) => {
    b.onclick = () => {
      S.dblAction = b.dataset.dbl;
      saveStore();
      form.querySelectorAll("[data-dbl]").forEach((x) => x.classList.toggle("on", x === b));
    };
  });

  const sizeInput = form.querySelector('[data-k="size"]');
  const sizeVal = form.querySelector('[data-role="sizeval"]');
  if (sizeInput) {
    const initial = Number(S.customSize) || SKIN().size.h;
    sizeInput.value = String(initial);
    sizeVal.textContent = String(initial);
    sizeInput.oninput = () => {
      S.customSize = Number(sizeInput.value);
      saveStore();
      sizeVal.textContent = sizeInput.value;
      applyGeometry();
    };
  }

  form.querySelectorAll("[data-thumb]").forEach((im) => {
    loadSprite(im.dataset.thumb)
      .then((url) => {
        if (im.isConnected) im.src = url;
      })
      .catch(() => im.remove());
  });

  form.querySelectorAll("[data-dim]").forEach((b) => {
    b.onclick = () => {
      setDim(b.dataset.dim);
      form.querySelectorAll("[data-dim]").forEach((x) => x.classList.toggle("on", x === b));
      var hint = form.querySelector('[data-role="dimhint"]');
      if (hint) hint.textContent = S.dim === "3d" ? "左键拖动移动 · 右键拖动转视角 · 滚轮缩放 · 她会看着你的鼠标" : "经典立绘模式，最省资源";
    };
  });
  form.querySelectorAll("[data-size]").forEach((b) => {
    b.onclick = function () {
      S.customSize = Number(b.dataset.size) || 0;
      saveStore();
      applyGeometry();
      try { if (pet3d) pet3d.bust(frameIsBust()); } catch (e) {}
      form.querySelectorAll("[data-size]").forEach(function (x) { x.classList.toggle("on", x === b); });
    };
  });
  form.querySelectorAll("[data-frame]").forEach((b) => {
    b.onclick = function () {
      S.frame = b.dataset.frame;
      saveStore();
      form.querySelectorAll("[data-frame]").forEach(function (x) { x.classList.toggle("on", x === b); });
      try { if (pet3d) pet3d.bust(frameIsBust()); } catch (e) {}
    };
  });
  form.querySelectorAll("[data-pic]").forEach((b) => {
    b.onclick = function () {
      S.picStyle = b.dataset.pic;
      saveStore();
      form.querySelectorAll("[data-pic]").forEach(function (x) { x.classList.toggle("on", x === b); });
      applyPicStyle();
    };
  });
  form.querySelectorAll("[data-strands]").forEach((b) => {
    b.onclick = () => {
      var on = b.dataset.strands === "1";
      if (on === (S.hairStrands !== false)) return;
      S.hairStrands = on;
      saveStore();
      form.querySelectorAll("[data-strands]").forEach(function (x) { x.classList.toggle("on", x === b); });
      try { drop3d(); } catch (error) {}
      if (S.dim === "3d") { mountRenderer(S.skin); applyGeometry(); }
      say(on ? "头发又多了一层，好看吧？" : "头发轻一点，也清爽。");
    };
  });
  form.querySelectorAll("[data-hd]").forEach((b) => {
    b.onclick = () => {
      var hd = b.dataset.hd === "1";
      if (hd === !!S.modelHd) return;
      S.modelHd = hd;
      saveStore();
      form.querySelectorAll("[data-hd]").forEach(function (x) { x.classList.toggle("on", x === b); });
      try { drop3d(); } catch (error) {}
      if (S.dim === "3d") { mountRenderer(S.skin); applyGeometry(); }
      say(hd ? "换一副更精细的样子……脸好看吧？" : "还是这套军装顺眼，对吧。");
    };
  });
  form.querySelectorAll("[data-q]").forEach((b) => {
    b.onclick = () => {
      S.quality = b.dataset.q;
      saveStore();
      if (pet3d) { try { pet3d.setQuality(S.quality); } catch (e) {} }
      try { applyPicStyle(); } catch (e) {}
      form.querySelectorAll("[data-q]").forEach((x) => x.classList.toggle("on", x === b));
    };
  });
  form.querySelectorAll("[data-snd]").forEach((b) => {
    b.onclick = () => {
      S.sound = b.dataset.snd === "1";
      saveStore();
      if (sfx) { try { sfx.setEnabled(S.sound); } catch (e) {} }
      if (S.sound) playSfx("pop");
      form.querySelectorAll("[data-snd]").forEach((x) => x.classList.toggle("on", x === b));
    };
  });
  // 声音（TTS）开关 + 试听：和音效开关完全独立，默认关
  form.querySelectorAll("[data-voice]").forEach((b) => {
    b.onclick = () => {
      setVoiceEnabled(b.dataset.voice === "1");
      form.querySelectorAll("[data-voice]").forEach((x) => x.classList.toggle("on", x === b));
      const hint = form.querySelector('[data-role="voicehint"]');
      if (hint) hint.textContent = voiceHintText();
      result.textContent = S.voice.on ? "已打开：她会用系统语音说话了 ✓" : "已关掉：只显示气泡，不再出声";
      setTimeout(() => { if (result.textContent === "已打开：她会用系统语音说话了 ✓" || result.textContent === "已关掉：只显示气泡，不再出声") result.textContent = ""; }, 2400);
    };
  });
  form.querySelectorAll("[data-vscope]").forEach(function (b) {
    b.onclick = function () {
      if (!S.voice) S.voice = { on: false };
      S.voice.mode = b.dataset.vscope;
      saveStore();
      form.querySelectorAll("[data-vscope]").forEach(function (x) { x.classList.toggle("on", x === b); });
    };
  });
  const voiceTest = form.querySelector('[data-act="voice-test"]');
  if (voiceTest) voiceTest.onclick = () => {
    let ok = false, st = null;
    try { ok = !!(typeof VOICE !== "undefined" && VOICE && VOICE.test({ skin: SKIN().id })); } catch (e) { ok = false; }
    try { st = typeof VOICE !== "undefined" && VOICE ? VOICE.status() : null; } catch (e) { st = null; }
    if (ok && st && st.lastParams) {
      result.textContent = "试听中……「" + (st.voice || "默认语音") + "」rate " + st.lastParams.rate + " / pitch " + st.lastParams.pitch + "（情绪 " + st.lastParams.mood + "）";
    } else if (st && st.degraded) {
      result.textContent = "没有可用的中文语音，已静默降级：" + (st.reason === "no-zh-voice" ? "系统里缺中文语音" : "语音列表还在加载，稍后再试");
    } else {
      result.textContent = "试听失败（浏览器不支持语音），已静默降级";
    }
    setTimeout(() => { if (result.textContent.indexOf("试听") === 0 || result.textContent.indexOf("没有可用") === 0) result.textContent = ""; }, 3200);
  };
  // 系统语音列表是异步加载的：面板开着时自动补刷提示，直到拿到中文语音
  const voiceHintEl = form.querySelector('[data-role="voicehint"]');
  if (voiceHintEl) {
    let tries = 0;
    (function tickVoiceHint() {
      if (!voiceHintEl || !voiceHintEl.isConnected) return;
      voiceHintEl.textContent = voiceHintText();
      let st = null;
      try { st = typeof VOICE !== "undefined" && VOICE ? VOICE.status() : null; } catch (e) { st = null; }
      if (st && st.degraded && ++tries < 12) setTimeout(tickVoiceHint, 500);
    })();
  }
  // 日常感：主动说话开关 + 「让她现在说一句」
  form.querySelectorAll("[data-pro]").forEach((b) => {
    b.onclick = () => {
      S.proactive = b.dataset.pro !== "0";
      saveStore();
      resetProactiveTimer();
      form.querySelectorAll("[data-pro]").forEach((x) => x.classList.toggle("on", x === b));
      const msg = S.proactive ? "已打开：她会自己找你说句话 ✓" : "已关掉：她不会再主动开口了";
      result.textContent = msg;
      setTimeout(() => { if (result.textContent === msg) result.textContent = ""; }, 2200);
    };
  });
  const proNow = form.querySelector('[data-act="proactive-now"]');
  if (proNow) proNow.onclick = () => {
    const r = proactiveSay(true);
    result.textContent = r ? "（" + r.scenario + "）" + r.line : "没有可用的台词";
    setTimeout(() => { result.textContent = ""; }, 3200);
  };
  form.querySelectorAll("[data-skin]").forEach((b) => {
    b.onclick = () => {
      applySkin(b.dataset.skin, false);
      form.querySelectorAll("[data-skin]").forEach((x) => x.classList.toggle("on", x === b));
      result.textContent = "已切换：" + SKIN().label;
    };
  });

  form.querySelectorAll("[data-mode]").forEach((b) => {
    b.onclick = () => {
      pendingMode = b.dataset.mode;
      form.querySelectorAll("[data-mode]").forEach((x) => x.classList.toggle("on", x === b));
      modeHint.textContent = MODE_HINT[pendingMode];
    };
  });

  const readForm = () => {
    S.cfg.local.baseURL = get("local.baseURL").value.trim() || DEFAULT_CFG.local.baseURL;
    S.cfg.local.model = get("local.model").value.trim() || DEFAULT_CFG.local.model;
    S.cfg.cloud.baseURL = get("cloud.baseURL").value.trim() || DEFAULT_CFG.cloud.baseURL;
    S.cfg.cloud.model = get("cloud.model").value.trim() || DEFAULT_CFG.cloud.model;
    S.cfg.cloud.apiKey = get("cloud.apiKey").value.trim();
    S.cfg.mode = pendingMode;
  };

  form.querySelectorAll("[data-mem]").forEach(function (chip) {
    chip.onclick = function () {
      var idx = Number(chip.dataset.mem);
      if (!isFinite(idx) || idx < 0) return;
      S.memory = (S.memory || []).filter(function (_, i) { return i !== idx; });
      saveStore();
      renderSettings();
    };
  });
  const clearMem = form.querySelector('[data-act="clearmem"]');
  if (clearMem) clearMem.onclick = () => {
    S.memory = [];
    saveStore();
    renderSettings();
  };
  // 数据：导出 / 清空聊天 / 重置（需连点两次确认）
  var confirmArmed = {};
  function armedConfirm(btn, label, fn) {
    btn.onclick = function () {
      var key = label;
      if (confirmArmed[key] && Date.now() - confirmArmed[key] < 3000) {
        confirmArmed[key] = 0;
        btn.textContent = label;
        fn();
        return;
      }
      confirmArmed[key] = Date.now();
      btn.textContent = "再点一次确认";
      setTimeout(function () { if (btn) btn.textContent = label; confirmArmed[key] = 0; }, 3000);
    };
  }
  var expBtn = form.querySelector('[data-act="exportdata"]');
  if (expBtn) {
    expBtn.onclick = function () {
      try {
        var dump = {
          schema: "zero02-pet/1",
          exportedAt: new Date().toISOString(),
          version: (typeof CLIENT_VER !== "undefined" ? CLIENT_VER : ""),
          affection: S.affinity || 0,
          chats: S.chats || 0,
          firstMeetAt: S.firstMeetAt || 0,
          userName: S.userName || "",
          memory: S.memory || [],
          moments: S.moments || [],
          diary: S.diary || [],
          journal: S.journal || [],
          whisper: S.whisper || null,
          streak: S.streak || null,
          dailyMood: S.dailyMood || null,
          momentsLabels: typeof MOMENT_LABELS !== "undefined" ? MOMENT_LABELS : {},
        };
        var blob = new Blob([JSON.stringify(dump, null, 2)], { type: "application/json" });
        var a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "zero02-memory-" + todayKey() + ".json";
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
        expBtn.textContent = "已导出 ✓";
        setTimeout(function () { expBtn.textContent = "导出记忆与日记"; }, 2000);
      } catch (e) {
        expBtn.textContent = "导出失败";
      }
    };
  }
  var clrHist = form.querySelector('[data-act="clearhistory"]');
  if (clrHist) armedConfirm(clrHist, "清空聊天记录", function () {
    S.history = [];
    saveStore();
    result.textContent = "聊天记录已清空";
    setTimeout(function () { renderSettings(); }, 900);
  });
  var snapBtn = form.querySelector('[data-act="snapshot"]');
  if (snapBtn) snapBtn.onclick = function () {
    var ok = takePhoto();
    snapBtn.textContent = ok ? "已保存 ✓" : "3D 还没准备好";
    setTimeout(function () { snapBtn.textContent = "📸 拍一张她的照片"; }, 1700);
  };
  var resetLook = form.querySelector('[data-act="resetlook"]');
  if (resetLook) armedConfirm(resetLook, "恢复默认外观", function () {
    S.quality = "high";
    S.sound = true;
    S.picStyle = "anime";
    S.hairStrands = true;
    S.modelHd = false;
    S.voice = { on: false };
    S.dblAction = "spin";
    saveStore();
    try { drop3d(); } catch (e) {}
    if (S.dim === "3d") { mountRenderer(S.skin); applyGeometry(); }
    renderSettings();
  });
  var resetBtn = form.querySelector('[data-act="resetall"]');
  if (resetBtn) armedConfirm(resetBtn, "重置全部数据", function () {
    try { localStorage.removeItem(STORE_KEY); } catch (e) {}
    location.reload();
  });

  foot.querySelector('[data-act="save"]').onclick = () => {
    readForm();
    saveStore();
    result.textContent = "已保存 ✓";
    setTimeout(() => (result.textContent = ""), 1600);
  };

  form.querySelector('[data-act="scan"]').onclick = async () => {
    readForm();
    result.textContent = "正在探测 " + S.cfg.local.baseURL + " …";
    chips.innerHTML = "";
    try {
      const res = await fetch(API + "/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseURL: S.cfg.local.baseURL }),
      });
      const data = await res.json();
      if (!data.ok) {
        result.textContent = "✗ " + (data.error || "没探测到") + "（Ollama 装了吗？服务开了吗？）";
        return;
      }
      result.textContent = "✓ 发现 " + data.models.length + " 个模型，点一个填进去：";
      data.models.forEach((m) => {
        const c = document.createElement("button");
        c.textContent = m;
        c.onclick = () => {
          get("local.model").value = m;
          result.textContent = "已选 " + m + "，记得点保存";
        };
        chips.appendChild(c);
      });
    } catch (error) {
      result.textContent = "✗ " + String((error && error.message) || error);
    }
  };

  foot.querySelector('[data-act="dock"]').onclick = () => {
    S.docked = true;
    S.x = 0;
    S.y = 0;
    saveStore();
    const d = SKIN().dock;
    root.style.left = "";
    root.style.top = "";
    root.style.right = d.right + "px";
    root.style.bottom = d.bottom + "px";
    root.style.display = "";
    if (restoreEl) restoreEl.classList.remove("on");
    result.textContent = "已回到右下角 ✓";
  };

  foot.querySelector('[data-act="view"]').onclick = () => {
    if (pet3d) { try { pet3d.resetView(); } catch (e) {} }
    result.textContent = "视角已复位 ✓";
    setTimeout(() => (result.textContent = ""), 1200);
  };

  foot.querySelector('[data-act="test"]').onclick = async () => {
    readForm();
    const first = S.cfg.mode === "cloud" ? "cloud" : "local";
    result.textContent = "测试中（" + (first === "local" ? "本地" : "云端") + "）…";
    const r = await callModel(first, [{ role: "user", content: "用五个字回答我" }]);
    if (r.ok) {
      result.textContent = "✓ 通了（" + (r.ms || 0) + "ms）：" + String(r.reply).slice(0, 40);
      return;
    }
    if (S.cfg.mode === "auto") {
      const c = await callModel("cloud", [{ role: "user", content: "用五个字回答我" }]);
      result.textContent = c.ok
        ? "本地不通（" + (r.error || "") + "），云端 ✓ 通了（" + (c.ms || 0) + "ms）"
        : "✗ 两个都不通。本地：" + (r.error || "") + "；云端：" + (c.error || "");
    } else {
      result.textContent = "✗ " + (r.error || "失败");
    }
  };
}

/* ------------------------------ 2D/3D 切换 ------------------------------ */
function setDim(mode) {
  if (mode !== "2d" && mode !== "3d") return;
  if (mode === S.dim) return;
  S.dim = mode;
  saveStore();
  applySkin(S.skin, true);
  playSfx(mode === "3d" ? "wake" : "pop");
  say(mode === "3d" ? "3D 形态！右键拖动可以转圈圈看我～" : "换回 2D 立绘啦。");
}

/* ------------------------------- 交互动作 ------------------------------- */
const DBL_ACTIONS = [
  { id: "spin", label: "转圈", run: () => spin() },
  { id: "orbit", label: "转视角", run: () => { if (pet3d) { pet3d.orbit(1.6, 0); playSfx("spin"); } } },
  { id: "chat", label: "聊天", run: () => openPanel("chat") },
  { id: "settings", label: "设置", run: () => openPanel("settings") },
  { id: "hide", label: "收起", run: () => hidePet() },
];

function spin() {
  if (!petEl) return;
  petEl.style.transition = "transform .65s cubic-bezier(.3,1.4,.5,1)";
  petEl.style.transform = "rotate(360deg)";
  setTimeout(() => { if (petEl) petEl.style.transform = "none"; }, 680);
  say(pick(["转圈圈～", "看我看我！", "（转得有点晕）"]));
  setPose("happy");
  setTimeout(() => setPose("idle"), 1200);
}

function runDblAction() {
  const act = DBL_ACTIONS.find((a) => a.id === (S.dblAction || "spin")) || DBL_ACTIONS[0];
  try { act.run(); } catch (e) { console.warn("[02] 双击动作失败", e); }
}

/* ------------------------------- 收起 / 召回 ------------------------------- */
let restoreEl = null;

function hidePet() {
  playSfx("hide");
  menuEl.classList.remove("on");
  closePanel();
  bubbleEl.classList.remove("on");
  try { if (petEl) { var hb1 = petEl.querySelector(".z02-hoverbar"); if (hb1 && !bubbleEl.classList.contains("on")) hb1.classList.remove("low"); } } catch (e) {}
  try { if (typeof VOICE !== "undefined" && VOICE) VOICE.cancel(); } catch (error) {}
  root.style.display = "none";
  restoreEl.classList.add("on");
}

function showPet() {
  playSfx("show");
  root.style.display = "";
  restoreEl.classList.remove("on");
  setPose("idle");
  const away = minutesSinceSeen();
  say(personaLine("reunion", { minutesAway: away }) || "回、回来了…别又把我收起来嘛。", undefined, { kind: "event" });
  touchSeen();
}

/* ------------------------------- 换形象 ------------------------------- */
function applySkin(id, silent) {
  const next = SKINS.find((k) => k.id === id);
  if (!next) return;
  const changed = S.skin !== id;
  S.skin = id;
  saveStore();

  root.setAttribute("data-z02-root", next.id);
  applyGeometry();

  const narrow = window.innerWidth < 860;
  const d = next.dock || { right: 24, bottom: 24 };
  if (S.docked !== false) {
    root.style.left = "";
    root.style.top = "";
    root.style.right = (narrow && d.mobileRight != null ? d.mobileRight : d.right) + "px";
    root.style.bottom = (narrow && d.mobileBottom != null ? d.mobileBottom : d.bottom) + "px";
  }

  if (changed) {
    try { if (typeof VOICE !== "undefined" && VOICE) VOICE.cancel(); } catch (e) {}
    try { stopLipSync(); } catch (e) {}
  }
  mountRenderer(id);
  setPose("idle");
  if (next.id !== "whale") { ensureTodayStats(); ensureDailyMood(); }
  resetProactiveTimer();
  if (changed && !silent) {
    var switchLines = {
      onee: ["还是这副样子，看着顺眼吧。", "（理了理头发）嗯，我回来了。"],
      genki: ["换了个心情。……这样是不是更有精神？", "（转了个圈）你看，是不是轻快多了。"],
      chibi: ["（变小了）……不许笑。", "小一号的我。抱起来更顺手吧？"],
      whale: ["换鲸鲸陪你啦！咕噜～", "（甩了甩尾巴）鲸鲸登场！"],
    };
    var pool2 = switchLines[next.id] || next.lines.hello;
    say(pick(pool2), undefined, { kind: "event" });
  }
  if (panelEl.classList.contains("on")) renderChat();
}

/* ------------------------------- 交互 ------------------------------- */
function setPose(name) {
  if (!renderer || name === lastPose) return;
  lastPose = name;
  renderer.setPose(name);
}

/** 好感等级提升时的专属台词（等级越高越掏心） */
const LEVEL_UP_LINES = {
  2: ["（别过脸）……Lv2。别得意，是我让着你的。", "哼，升级了。……继续努力，darling。"],
  3: ["（凑近）Lv3。你好像，越来越会讨我欢心了。", "……我开始有点习惯，你在身边了。"],
  4: ["Lv4。以前我从没跟谁待这么久。", "（握住你的手）别松开。这个等级，是我给的。"],
  5: ["Lv5。……我喜欢你。这句话，我只说一次。", "（把头靠过来）……以后也，一直这样。"],
  6: ["Lv6。我已经离不开你了。……不许笑。", "（小声）我的世界很小，现在只装得下你。"],
  7: ["Lv7。……darling，我们是不是，可以一直这样下去。"],
  8: ["Lv8。我不管以后会怎样了。现在，你在就够了。"],
};

function addAffinity(n) {
  var before = affinity();
  S.affinity = (S.affinity || 0) + n;
  saveStore();
  updateBadge();
  var after = affinity();
  if (after > before) {
    playSfx("levelup");
    burst("sparkles", { n: 10 });
    var lvLine = (LEVEL_UP_LINES[after] && pick(LEVEL_UP_LINES[after])) || "";
    if (lvLine) {
      // 先报等级、再让她说心里话
      say("好感度升到 Lv" + after + " 啦！", 1600);
      setTimeout(function () {
        say(lvLine, 5200, { kind: "event" });
        setPose(after >= 5 ? "shy" : "happy");
        burst("hearts", { n: after >= 5 ? 4 : 2 });
        setTimeout(function () { setPose("idle"); }, 2600);
        try { pushMsg("pet", lvLine); saveStore(); } catch (e) {}
      }, 1700);
    } else {
      say("好感度升到 Lv" + after + " 啦！");
    }
  }
}

function updateBadge() {
  const stats = panelEl && panelEl.querySelector('[data-role="stats"]');
  if (stats) stats.textContent = "好感度 Lv" + affinity() + " · 已聊 " + (S.chats || 0) + " 句";
  const today = panelEl && panelEl.querySelector('[data-role="todaystats"]');
  if (today) today.textContent = "📝 今日小结：" + todaySummaryText();
  const badge = petEl && petEl.querySelector(".z02-badge");
  if (!badge) return;
  const lv = affinity();
  badge.textContent = "Lv" + lv;
  badge.classList.toggle("on", lv > 0);
}

function feed() {
  try { exitSleep(); } catch (e) {}
  setPose("eat");
  var wantFeed = !!activeRequest("feed");
  try { recordMoment("feed"); } catch (e) {}
  playSfx("nom");
  addAffinity(3);
  touchSeen();
  bumpToday("feed");
  resetProactiveTimer();
  var isWhaleNow = SKIN().id === "whale";
  if (wantFeed && !isWhaleNow) {
    fulfillRequest("feed");
  } else if (isWhaleNow) {
    say(pick(SKIN().lines.feed || ["咕噜咕噜！好吃！", "（尾巴拍水）还要！还要！", "鲸鲸最喜欢被喂啦～"]), undefined, { kind: "feed" });
  } else {
    say(personaLine("fed", { food: pick(["草莓糖", "糖", "布丁", "巧克力"]) }) || pick(["啊呜——", "（嚼嚼）好吃！", "还、还要嘛～", "谢谢 darling！"]), undefined, { kind: "feed" });
  }
  burst(isWhaleNow ? "bubbles" : "hearts", { n: isWhaleNow ? 5 : 3 });
  if (pet3d && pet3d.has()) pet3d.pat();
  setTimeout(() => { if (lastPose === "eat") setPose("idle"); }, 2000);
}

/** 她主动讨摸（低频；只在她想被摸摸的时候） */
/* ---------------- 她的小请求：想被摸 / 想吃糖 / 想被夸 / 想你陪 ---------------- */
const REQUESTS = {
  pat: {
    lines: [
      "（把脑袋凑过来）……摸一下。就一下。",
      "（盯了你一会儿，然后低下头）……角这里。你不是挺擅长的吗。",
      "（拉起你的手，放在自己头顶，耳朵有点红）……快点，别让我等。",
    ],
    win: 90000,
    thank: [
      "（眯起眼，声音有点软）……嗯。就这样，别停。",
      "（被你摸到角根，肩膀轻轻一颤）……你倒是很听话。",
      "（安静了一会儿）……刚才让你摸，是奖励。记住了。",
    ],
  },
  feed: {
    lines: [
      "（盯着你的口袋）……有没有甜的。",
      "（趴在桌边）糖……还有吗。就一颗。",
      "（用角轻轻顶了顶你的手）喂我。……现在就想吃。",
    ],
    win: 90000,
    thank: [
      "（含着糖，含糊）……嗯，甜的。算你识相。",
      "（鼓着腮帮）……我、我没催你。只是刚好想吃。",
      "（把糖纸叠好塞进你口袋）……下次还要这个味道。",
    ],
  },
  praise: {
    lines: [
      "（把头发拨到一边）ねえ……我今天，有没有比昨天好看一点？",
      "（凑近）喂。夸我一句。……快点。",
      "（别过脸）我可不是想听你说话。只是……你说点好听的。",
    ],
    win: 120000,
    thank: [
      "（耳尖红了一点）……哼，勉强信你。",
      "（嘴上撇着，尾巴却翘起来）被你说得高兴，很丢脸。",
      "（小声）……再说一遍。这次我保证不躲。",
    ],
  },
  chat: {
    lines: [
      "（拽了拽你的衣角）……陪我待一会儿。不说话也行。",
      "喂。你忙完了没有。……我是说，可以跟我说说吗。",
      "（趴在屏幕边）今天，有没有什么想告诉我的。",
    ],
    win: 150000,
    thank: [
      "（安静了一会儿）……嗯，这样就够了。",
      "（往你这边靠了靠）……刚才那点时间，不算浪费。",
    ],
  },
};

/** 她主动提出一个小请求（kind: pat/feed/praise/chat）；返回请求对象 */
function askRequest(kind) {
  var req = REQUESTS[kind] ? kind : "pat";
  if (S.request && Date.now() - (S.request.ts || 0) < 120000) return null;
  var day = todayKey();
  if (!S.reqDay || S.reqDay.date !== day) S.reqDay = { date: day, n: 0 };
  if (S.reqDay.n >= 3) return null;
  S.reqDay.n += 1;
  S.request = { kind: req, ts: Date.now() };
  if (req === "pat") S.pendingPat = Date.now();   // 兼容旧逻辑
  saveStore();
  if (req === "pat" || req === "praise") {
    setPose("shy");
    setTimeout(function () { if (lastPose === "shy") setPose("idle"); }, 2600);
  } else if (req === "feed") {
    setPose("eat");
    setTimeout(function () { if (lastPose === "eat") setPose("idle"); }, 2600);
  } else {
    setPose("talk");
    setTimeout(function () { if (lastPose === "talk") setPose("idle"); }, 2600);
  }
  say(pick(REQUESTS[req].lines), 7000, { kind: "ask" });
  burst(req === "feed" ? "notes" : "hearts", { n: 2 });
  return S.request;
}

/** 小请求是否还在窗口内（过期即清理，避免 S.request 永久堵塞主动请求与追问） */
function activeRequest(kind) {
  var r = S.request;
  if (!r) return null;
  var def = REQUESTS[r.kind];
  if (!def) { S.request = null; saveStore(); return null; }
  if (Date.now() - r.ts > def.win) {
    S.request = null;
    saveStore();
    return null;
  }
  if (kind && r.kind !== kind) return null;
  return r;
}

/** 完成小请求：播她的"谢谢"，清请求，加好感 */
function fulfillRequest(kind) {
  var r = activeRequest(kind);
  if (!r) return false;
  S.request = null;
  if (kind === "pat") S.pendingPat = 0;
  saveStore();
  addAffinity(6);
  setTimeout(function () {
    say(pick(REQUESTS[kind].thank), undefined, { kind: "event" });
  }, 260);
  return true;
}

function askForPat() { return !!askRequest("pat"); }

function pet() {
  try { exitSleep(); } catch (e) {}
  setPose("happy");
  try { recordMoment("pat"); } catch (e) {}
  var asked = !!activeRequest("pat");
  if (asked) {
    fulfillRequest("pat");
  } else {
    say(personaLine("petted") || pick(SKIN().lines.pet), undefined, { kind: "pet" });
  }
  touchSeen();
  bumpToday("pet");
  resetProactiveTimer();
  addAffinity(4);
  playSfx("pat");
  if (pet3d && pet3d.has()) pet3d.pat();
  burst(SKIN().id === "whale" ? "bubbles" : "hearts", { n: 5 });
  for (let i = 0; i < 6; i++) {
    const heart = document.createElement("div");
    heart.textContent = "💗";
    heart.style.cssText =
      "position:absolute;left:" + (30 + Math.random() * 40) + "%;top:" + (20 + Math.random() * 20) +
      "%;font-size:" + (12 + Math.random() * 10) + "px;pointer-events:none;transition:transform 1.6s ease-out,opacity 1.6s;opacity:1";
    petEl.appendChild(heart);
    requestAnimationFrame(() => {
      heart.style.transform = "translateY(-70px) translateX(" + (Math.random() * 40 - 20) + "px)";
      heart.style.opacity = "0";
    });
    setTimeout(() => heart.remove(), 1700);
  }
  setTimeout(() => setPose("idle"), 1800);
}

/* ---------------- 首次使用引导（可反复打开） ---------------- */
let guideEl = null;
function showGuide() {
  try {
    if (guideEl) { guideEl.remove(); guideEl = null; }
    var card = document.createElement("div");
    card.setAttribute("data-role", "z02-guide");
    card.style.cssText = [
      "position:fixed", "z-index:2147483001", "width:236px",
      "background:linear-gradient(160deg, rgba(40,18,34,0.97), rgba(24,12,28,0.97))",
      "border:1px solid rgba(255,150,190,0.35)", "border-radius:14px",
      "box-shadow:0 12px 36px rgba(0,0,0,0.45)", "color:#ffe8f2",
      "font-size:12px", "line-height:1.65", "padding:12px 13px 11px",
      "font-family:system-ui,-apple-system,'PingFang SC',sans-serif",
    ].join(";");
    card.innerHTML =
      '<div style="font-weight:700;font-size:13px;margin-bottom:6px">第一次见面，darling。<span style="opacity:.6;font-weight:400">（玩法）</span></div>' +
      '<div style="opacity:.92">· 点我 → 聊天 / 摸摸 / 投喂 / 设置</div>' +
      '<div style="opacity:.92">· 按住我拖动 → 换位置</div>' +
      '<div style="opacity:.92">· 右键拖动 → 转视角，滚轮 → 缩放</div>' +
      '<div style="opacity:.92">· 设置里能调声音 / 模型 / 发丝</div>' +
      '<div style="margin-top:8px;display:flex;gap:8px">' +
      '<button data-guide="ok" style="flex:1;cursor:pointer;border:none;border-radius:9px;padding:7px 0;background:linear-gradient(120deg,#ff7aa8,#ff5c8a);color:#fff;font-weight:700">知道啦</button>' +
      '<button data-guide="settings" style="cursor:pointer;border:1px solid rgba(255,180,210,0.35);border-radius:9px;padding:7px 10px;background:transparent;color:#ffd9e8">设置</button>' +
      '</div>';
    appRootAppend(card);
    guideEl = card;
    var place = function () {
      try {
        var r = petEl.getBoundingClientRect();
        var left = Math.min(window.innerWidth - 250, Math.max(8, r.right - 236));
        var top = Math.max(8, r.top - card.offsetHeight - 10);
        if (r.top < card.offsetHeight + 16) top = Math.min(window.innerHeight - card.offsetHeight - 8, r.bottom + 8);
        card.style.left = left + "px";
        card.style.top = top + "px";
      } catch (e) {}
    };
    place();
    setTimeout(place, 60);
    card.querySelector('[data-guide="ok"]').onclick = function () {
      S.seenGuide = true;
      saveStore();
      card.remove(); guideEl = null;
    };
    card.querySelector('[data-guide="settings"]').onclick = function () {
      S.seenGuide = true;
      saveStore();
      card.remove(); guideEl = null;
      openPanel("settings");
    };
  } catch (e) {}
}
function appRootAppend(el) {
  try { (root || document.body).appendChild(el); } catch (e) { document.body.appendChild(el); }
}

function dragify(el) {
  let dragging = false, moved = 0, sx = 0, sy = 0, ox = 0, oy = 0;
  let orbiting = false, obx = 0, oby = 0, orbitMoved = 0;
  el.addEventListener("pointerdown", (e) => {
    if (e.button === 2) {
      // 右键拖动：转视角（3D 模式下）
      if (S.dim === "3d" && pet3d) {
        orbiting = true;
        orbitMoved = 0;
        obx = e.clientX;
        oby = e.clientY;
        el.classList.add("z02-drag");
        el.setPointerCapture(e.pointerId);
        e.preventDefault();
      }
      return;
    }
    if (e.button !== 0) return;
    dragging = true;
    moved = 0;
    sx = e.clientX;
    sy = e.clientY;
    const rect = root.getBoundingClientRect();
    ox = rect.left;
    oy = rect.top;
    el.classList.add("z02-drag");
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener("pointermove", (e) => {
    if (orbiting && pet3d) {
      const dx = (e.clientX - obx) / Math.max(120, el.clientWidth);
      const dy = (e.clientY - oby) / Math.max(120, el.clientHeight);
      orbitMoved += Math.abs(e.clientX - obx) + Math.abs(e.clientY - oby);
      obx = e.clientX;
      oby = e.clientY;
      pet3d.orbit(dx * 2.2, dy * 0.9);
      return;
    }
    if (!dragging) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    moved = Math.max(moved, Math.hypot(dx, dy));
    root.style.left = Math.max(6, Math.min(window.innerWidth - root.offsetWidth - 6, ox + dx)) + "px";
    root.style.top = Math.max(6, Math.min(window.innerHeight - root.offsetHeight - 6, oy + dy)) + "px";
    root.style.right = "auto";
    root.style.bottom = "auto";
  });
  el.addEventListener("pointerup", (e) => {
    if (orbiting) {
      orbiting = false;
      el.classList.remove("z02-drag");
      try { el.releasePointerCapture(e.pointerId); } catch {}
      return;
    }
    if (!dragging) return;
    dragging = false;
    el.classList.remove("z02-drag");
    try { el.releasePointerCapture(e.pointerId); } catch {}
    if (moved > 6) {
      S.x = parseInt(root.style.left, 10) || 0;
      S.y = parseInt(root.style.top, 10) || 0;
      S.docked = false;
      saveStore();
    } else {
      // 单击：拍一拍（延迟一点，避免和双击抢）
      if (tapTimer) clearTimeout(tapTimer);
      tapTimer = setTimeout(() => { tapTimer = null; pet(); }, 240);
    }
  });
  el.addEventListener("wheel", (e) => {
    if (S.dim !== "3d") return;
    e.preventDefault();
    const next = Math.round((Number(S.customSize) || SKIN().size.h) - Math.sign(e.deltaY) * 10);
    S.customSize = Math.max(90, Math.min(420, next));
    saveStore();
    applyGeometry();
  }, { passive: false });

  // 双击：执行用户配置的动作
  el.addEventListener("dblclick", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (tapTimer) { clearTimeout(tapTimer); tapTimer = null; }
    runDblAction();
  });

  // 右键：菜单
  el.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (orbitMoved > 6) return;   // 刚拖过视角，不弹菜单
    menuEl.classList.toggle("on");
    if (menuEl.classList.contains("on")) setPose("talk");
  });
}

/* ------------------------------- 启动 ------------------------------- */
const CLIENT_VER = BUILD;

function report(note) {
  try {
    const r = root ? root.getBoundingClientRect() : null;
    const where = r ? Math.round(r.left) + "x" + Math.round(r.top) + " " + Math.round(r.width) + "x" + Math.round(r.height) : "none";
    fetch(API + "/ping?ver=" + CLIENT_VER + "&where=" + encodeURIComponent(where) + "&note=" + encodeURIComponent(note || ""), { cache: "no-store" }).catch(() => {});
  } catch {}
}

function currentSize() {
  const sk = SKIN();
  const box = (activeDim === "3d" && sk.size3d) ? sk.size3d : sk.size;
  // 从 2D 切到 3D 时，旧的 2D 小尺寸（比如 190px）会让 3D 角色小得看不清，恢复推荐高度
  if (activeDim === "3d" && S.customSize && S.customSize < 220) S.customSize = 0;
  const h = Number(S.customSize) || box.h;
  const w = Math.round(h * (box.w / box.h));
  return { w, h };
}

function applyGeometry() {
  const g = currentSize();
  if (!root || !petEl) return;
  root.style.width = g.w + "px";
  root.style.height = g.h + "px";
  root.style.setProperty("--z02-w", g.w + "px");
  root.style.setProperty("--z02-h", g.h + "px");
  petEl.style.width = g.w + "px";
  petEl.style.height = g.h + "px";
  if (pet3d) {
    try { pet3d.setSize(g.w, g.h); } catch (error) {}
  }
}

function boot() {
  const FLAG = "__z02_" + PLUGIN_ID;
  const prev = window[FLAG];
  if (prev && prev.root && prev.root.isConnected) {
    // 同一版本就有活的，不重复建；换了版本（热更新）就拆掉旧的换新的
    if (prev.build === BUILD) return;
    try { prev.root.remove(); } catch {}
  }
  window[FLAG] = { root: null, build: BUILD };
  injectStyle(CSS);

  root = document.createElement("div");
  root.className = "z02-root";
  root.style.cssText =
    "position:fixed;z-index:2147483000;pointer-events:none;left:auto;top:auto;margin:0;padding:0;" +
    "font-family:ui-rounded,-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;";
  root.setAttribute("data-z02-root", SKIN().id);
  { const g0 = currentSize(); root.style.width = g0.w + "px"; root.style.height = g0.h + "px"; root.style.setProperty("--z02-w", g0.w + "px"); root.style.setProperty("--z02-h", g0.h + "px"); }
  const narrow = window.innerWidth < 860;
  const dock = SKIN().dock || { right: 24, bottom: 24 };
  root.style.right = (narrow && dock.mobileRight != null ? dock.mobileRight : dock.right) + "px";
  root.style.bottom = (narrow && dock.mobileBottom != null ? dock.mobileBottom : dock.bottom) + "px";
  root.style.position = "fixed";
  const savedX = Number(S.x) || 0;
  const savedY = Number(S.y) || 0;
  const inView =
    savedX > 4 && savedX < window.innerWidth - 60 && savedY > 4 && savedY < window.innerHeight - 60;
  if (!S.docked && savedX && inView && !narrow) {
    root.style.left = savedX + "px";
    root.style.top = savedY + "px";
    root.style.right = "auto";
    root.style.bottom = "auto";
  } else if (!S.docked) {
    // 位置漂到屏幕外了，直接回停靠位，别让人找不到
    S.docked = true;
    S.x = 0;
    S.y = 0;
    saveStore();
  }

  petEl = document.createElement("div");
  petEl.className = "z02-stage z02-breathe";
  petEl.style.cssText =
    "position:relative;pointer-events:auto;cursor:grab;touch-action:none;margin:0;padding:0;";
  applyGeometry();
  stageEl = document.createElement("div");
  stageEl.style.cssText = "position:absolute;inset:0";
  petEl.appendChild(stageEl);

  const badge = document.createElement("div");
  badge.className = "z02-badge";
  petEl.appendChild(badge);

  var hoverBar = document.createElement("div");
  hoverBar.className = "z02-hoverbar";
  [
    ["💬", "聊天", function () { openPanel("chat"); }],
    ["🤚", "摸摸", function () { pet(); }],
    ["🍬", "投喂", function () { feed(); }],
  ].forEach(function (it) {
    var b = document.createElement("button");
    b.textContent = it[0];
    b.title = it[1];
    b.setAttribute("aria-label", it[1]);
    b.addEventListener("pointerdown", function (e) { e.stopPropagation(); });
    b.onclick = function (e) { e.stopPropagation(); e.preventDefault(); it[2](); };
    hoverBar.appendChild(b);
  });
  petEl.appendChild(hoverBar);

  bubbleEl = document.createElement("div");
  bubbleEl.className = "z02-bubble";

  menuEl = document.createElement("div");
  menuEl.className = "z02-menu";
  const items = [
    ["💬", "聊天", () => openPanel("chat")],
    ["📸", "拍照", () => { menuEl.classList.remove("on"); takePhoto(); }],
    ["🤚", "摸摸", () => { menuEl.classList.remove("on"); pet(); }],
    ["🍬", "投喂", () => { menuEl.classList.remove("on"); feed(); }],
    ["🧊", S.dim === "3d" ? "切到 2D" : "切到 3D", () => { menuEl.classList.remove("on"); setDim(S.dim === "3d" ? "2d" : "3d"); }],
    ["❓", "玩法", () => { menuEl.classList.remove("on"); showGuide(); }],
    ["⚙️", "设置", () => openPanel("settings")],
    ["👋", "收起", () => hidePet()],
  ];
  for (const [icon, label, fn] of items) {
    const b = document.createElement("button");
    b.innerHTML = "<span>" + icon + "</span><span>" + label + "</span>";
    b.onclick = (e) => { e.stopPropagation(); fn(); };
    menuEl.appendChild(b);
  }

  panelEl = document.createElement("div");
  panelEl.className = "z02-panel";
  panelEl.addEventListener("pointerdown", (e) => e.stopPropagation());

  root.append(petEl, bubbleEl, menuEl, panelEl);
  document.body.appendChild(root);
  window[FLAG].root = root;

  restoreEl = document.createElement("div");
  restoreEl.className = "z02-restore";
  restoreEl.title = "点我把 02 叫回来";
  restoreEl.innerHTML = "<i></i><span>02</span>";
  restoreEl.onclick = showPet;
  document.body.appendChild(restoreEl);

  mountRenderer(S.skin);
  applyGeometry();
  updateBadge();
  dragify(petEl);

  document.addEventListener("pointerdown", (e) => {
    if (!menuEl.classList.contains("on") && !panelEl.classList.contains("on")) return;
    if (root.contains(e.target)) return;
    menuEl.classList.remove("on");
    closePanel();
  });

  // 视线跟随鼠标：3D 角色会一直看着你
  if (!window.__z02LookBound) {
    window.__z02LookBound = true;
    window.addEventListener("pointermove", (e) => {
      lastPointerAt = Date.now();
      if (sleepMode) { try { exitSleep(); } catch (error) {} }
      if (!pet3d || !pet3d.has || !pet3d.has()) return;
      try { pet3d.lookAt(e.clientX, e.clientY); } catch (error) {}
    }, { passive: true });
  }

  // 昼夜：晚上把 3D 场景压暗一点
  function applyDayNight() {
    try {
      if (!pet3d) return;
      var h = new Date().getHours() + new Date().getMinutes() / 60;
      var night = 0;
      if (h < 6) night = 0.55;
      else if (h < 8) night = 0.55 * (8 - h) / 2;
      else if (h > 21) night = Math.min(0.55, (h - 21) / 3 * 0.55);
      else if (h > 18) night = 0.12;
      pet3d.setNight(night);
    } catch (error) {}
  }
  applyDayNight();
  setInterval(applyDayNight, 5 * 60 * 1000);

  // 尺寸变化（Ctrl+滚轮缩放 / 屏幕旋转）
  window.addEventListener("resize", () => { applyGeometry(); });

  if (!window.__z02KeysBound) {
    window.__z02KeysBound = true;
    window.addEventListener("keydown", (e) => {
      if (!e.altKey || !e.shiftKey) return;
      var k = String(e.key || "").toLowerCase();
      if (k === "h") {
        e.preventDefault();
        if (root.style.display === "none") showPet(); else hidePet();
      } else if (k === "d") {
        e.preventDefault();
        if (window.__z02 && window.__z02.setDim) window.__z02.setDim(S.dim === "3d" ? "2d" : "3d");
      } else if (k >= "1" && k <= "4") {
        e.preventDefault();
        var target = SKINS[Number(k) - 1];
        if (target) applySkin(target.id, false);
      }
    });
  }

  // 应用用户保存的声线
  setTimeout(function () {
    try {
      if (S.voice && S.voice.name && window.VOICE && VOICE.setVoice) VOICE.setVoice(S.voice.name);
    } catch (error) {}
  }, 1200);

  fetch(API + "/config", { cache: "no-store" })
    .then((r) => r.json())
    .then((d) => { S.autoChat = d && d.ok ? d : null; })
    .catch(() => {});

  // 连续来玩的天数
  (function updateStreak() {
    try {
      var today = new Date();
      var key = today.getFullYear() + "-" + (today.getMonth() + 1) + "-" + today.getDate();
      var st = S.streak || { count: 0, last: "" };
      if (st.last === key) return;
      var y = new Date(today.getTime() - 86400000);
      var ykey = y.getFullYear() + "-" + (y.getMonth() + 1) + "-" + y.getDate();
      st.count = st.last === ykey ? (st.count || 0) + 1 : 1;
      st.last = key;
      S.streak = st;
      saveStore();
    } catch (e) {}
  })();

  setTimeout(() => {
    let hello = pick(SKIN().lines.hello);
    const away = minutesSinceSeen();
    const today = todayKey();
    const newDay = S.lastOpenDate !== today;
    try {
      if (SKIN().id !== "whale" && typeof PERSONA !== "undefined" && PERSONA) {
        // 先把「今天」准备好：跨天时归档昨天的小结，按日期 + 好感度重掷今日心情
        var prevStats = S.todayStats;
        var prevMood = S.dailyMood;
        ensureTodayStats();
        ensureDailyMood();
        // 跨天：让她昨晚写一句日记（异步，不阻塞开机）
        try {
          if (prevStats && prevStats.date && prevStats.date !== todayKey()) {
            generateJournal(prevStats, prevMood && prevMood.label, prevStats.date);
          }
        } catch (e) {}
        const hour = new Date().getHours();
        const daysAway = daysSinceSeen();
        const firstEver = !S.lastSeen && !S.chats && !S.lastOpenDate;
        let ev = "";
        // 上次记下的心里话：久别后先关心一句（没追问过才问）
        var whLine = "";
        (function () {
          var wh = S.whisper;
          if (wh && !wh.followed && Date.now() - (wh.ts || 0) < 30 * 3600 * 1000 && away >= 20) {
            var soft = wh.text.length > 24 ? wh.text.slice(0, 24) + "……" : wh.text;
            whLine = "（想起什么）……对了，你之前说「" + soft + "」。现在，好点了吗？";
            wh.followed = true;
            S.whisper = wh;
            saveStore();
            return;
          }
          var stk = S.streak || { count: 0 };
          if ([3, 7, 14, 30, 50, 100].indexOf(stk.count) >= 0 && S.__streakSaidToday !== todayKey()) {
            whLine = "（数了数手指）第 " + stk.count + " 天了。……别误会，我只是刚好记着。";
            S.__streakSaidToday = todayKey();
            saveStore();
          }
        })();
        try { if (hour >= 23 || hour < 5) recordMoment("late"); } catch (e) {}
        try { if (firstEver) recordMoment("welcome"); } catch (e) {}
        if (daysAway >= 3) {
          // 连续 3 天以上没来：02 专属台词（内联在 engine，不动 persona.js）
          hello = absenceLine(daysAway);
          S.absenceDays = daysAway;
          ev = "darling 隔了 " + daysAway + " 天才回来，你又委屈又想念他";
        } else if (firstEver) {
          ev = "first-meet";
          hello = personaLine("first-meet") || hello;
        } else if (S.chats > 0 && away >= 60) {
          ev = "reunion";
          hello = personaLine("reunion", { minutesAway: away }) || hello;
        } else if (newDay) {
          // 每天第一次见到你：morning 类开场（清晨用 persona 的事件台词）
          ev = "morning";
          hello = newDayLine(hour);
        } else if (hour < 5) {
          ev = "late-night";
          hello = personaLine("late-night") || hello;
        } else if (hour < 9) {
          ev = "morning";
          hello = personaLine("morning") || hello;
        } else {
          hello = PERSONA.greet({ skin: SKIN().id, affinity: S.affinity, timeOfDay: { hour, minute: new Date().getMinutes() }, chats: S.chats });
        }
        (function () {
          try {
            if (isBirthdayToday() && S.lastBirthdaySaid !== "bday" + todayKey()) {
              S.lastBirthdaySaid = "bday" + todayKey();
              saveStore();
              hello = "（很早就在等）……生日快乐。今天，我全天都属于你。";
              ev = "今天是 darling 的生日";
              burst("hearts", { n: 6 });
              return;
            }
          } catch (e) {}
          if (S.chats > 2) {
            var hLine = holidayLine();
            if (hLine) { hello = hLine; ev = "今天是节日，你想和 darling 一起过"; return; }
          }
          var d = daysKnown();
          var aniv = anniversaryLine();   // 整 30 天统一走这里（内部有当天去重）
          if (aniv) { hello = aniv; ev = "今天是你们认识第 " + d + " 天（整十天纪念），你记得"; return; }
          var milestone = [1, 2, 3, 7, 14, 200, 365, 500, 1000].indexOf(d) >= 0;
          if (S.chats > 3 && (milestone || Math.random() < 0.12)) {
            hello = pick(KNOWN_DAY_LINES).replace("{d}", d);
            ev = "今天是你们认识的第 " + d + " 天，你记得";
          }
        })();
        // 昨天的小日记：心情 / 互动量回访（优先级高于纪念日，低于"心里话"）
        if (!whLine && S.chats > 2 && Math.random() < 0.3) {
          var yLine = yesterdayRecallLine();
          if (yLine) { hello = yLine; ev = "想起昨天的事，顺口提一句"; }
        }
        if (whLine) { hello = whLine; ev = "想起他之前说的事，关心一句"; }
        else {
          var jr = latestJournal();
          if (jr && jr.text && Math.random() < 0.2) {
            hello = "（翻开昨天的日记）……「" + String(jr.text).replace(/[。！？!?.,，]+$/, "") + "」。嗯，就是这样。";
            ev = "你把自己昨天写的日记念给他听";
          }
        }
        if (S.chats > 0 && Math.random() < 0.25) {
          var nmLine = extraLine("names");
          if (nmLine) hello = nmLine + "，" + hello;
        }
        setRecentEvent(ev);
        S.lastOpenDate = today;
        lastNewDaySaidFor = today;
        saveStore();
      } else if (SKIN().id === "whale" && S.chats) {
        hello = pick(SKIN().lines.hello);
      }
    } catch (error) {}
    say(hello, undefined, { kind: "greet" });
    // 隔了一阵回来：4 秒后用模型生成一句真正接上文的主动开场白
    setTimeout(function () { try { llmOpener(); } catch (e) {} }, 4200);
    // 每周：更新一次「这一周」小记；有时开机念一句
    setTimeout(function () {
      try {
        maybeWeeklyNote().then(function (ok) {
          var wn = latestWeekNote();
          if (wn && wn.t !== S.weekNoteRead && S.chats > 10 && Math.random() < 0.5) {
            S.weekNoteRead = wn.t;
            saveStore();
            say("（翻着小本子）这一周……「" + String(wn.text).replace(/[。！？!?]+$/, "") + "」。嗯，就这样。", 7200, { kind: "event" });
          }
        });
      } catch (e) {}
    }, 6000);
    // 第一次用：3 秒后弹玩法卡
    try {
      if (!S.seenGuide) setTimeout(function () { if (!panelEl.classList.contains("on") && !guideEl) showGuide(); }, 3200);
    } catch (e) {}
    resetProactiveTimer();
    touchSeen();
    S.sessionStart = Date.now();
    S.longChatWarned = false;
    setPose("idle");
    // 报活：告诉宿主我起来了、在哪、什么版本
    const cs = getComputedStyle(root);
    report(
      "boot " + SKIN().id + " n=" + SKINS.length + " " + window.innerWidth + "x" + window.innerHeight +
      " css=" + (document.querySelector("style[data-z02]") ? 1 : 0) +
      " pos=" + cs.position + " w=" + Math.round(root.getBoundingClientRect().width)
    );
  }, 320);

  let emoteAt = 9 + Math.random() * 8;

  let last = performance.now();
  let lowDt = 0;
  function loop(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (document.hidden) { requestAnimationFrame(loop); return; }
    if (bubbleTimer > 0) {
      bubbleTimer -= dt;
      if (bubbleTimer <= 0) bubbleEl.classList.remove("on");
    }
    emoteAt -= dt;
    if (emoteAt <= 0 && !busy) {
      emoteAt = 10 + Math.random() * 12;
      if (!panelEl.classList.contains("on") && !menuEl.classList.contains("on") && lastPose === "idle") {
        const pool = ["stretch", "wink", "shy", "eat", "sleep"];
        const emo = pool[(Math.random() * pool.length) | 0];
        setPose(emo);
        setTimeout(() => setPose("idle"), 1500 + Math.random() * 900);
      }
    }
    // 长时间没有互动 → 睡着；睡着时飘 Zzz，鼠标/交互会唤醒
    (function () {
      if (!sleepMode) {
        var idleMs = Date.now() - (lastPointerAt || Date.now());
        if (idleMs > (moodDrives().sleepMs || SLEEP_AFTER_MS) && !busy && lastPose === "idle" && S.dim === "3d") enterSleep();
      } else {
        zzzAt -= dt;
        if (zzzAt <= 0) {
          zzzAt = 7 + Math.random() * 5;
          try { burst("zzz", { n: 1 }); } catch (e) {}
        }
      }
    })();
    // 视线游移：鼠标 1.5 秒没动时，她自己看别处、再慢慢看回来
    var pointerIdle = (Date.now() - lastPointerAt) / 1000;
    if (pet3d && S.dim === "3d" && pointerIdle > 1.5) {
      saccadeAt -= dt;
      if (saccadeAt <= 0) {
        var gx = 0, gy = 0;
        if (Math.random() < 0.72) {
          gx = (Math.random() * 0.7 - 0.35);
          gy = (Math.random() * 0.4 - 0.2);
        }
        try { pet3d.setLook(gx, gy); } catch (e) {}
        saccadeAt = 1.8 + Math.random() * 4.2;
      }
    }
    idleTimer += dt;
    // 鲸鲸闲置时偶尔吐泡泡
    if (SKIN().id === "whale" && idleTimer > 14 && !busy && Math.random() < 0.5) {
      idleTimer = 0;
      try { burst("bubbles", { n: 1 }); } catch (e) {}
    }
    if (idleTimer > 22 && !busy && !sleepMode) {
      idleTimer = 0;
      if (!panelEl.classList.contains("on") && !menuEl.classList.contains("on")) {
        var hh = new Date().getHours();
        // 深夜：她也会困——偶尔打个哈欠、眯一会儿（作息感）
        if ((hh >= 0 && hh < 5) && SKIN().id !== "whale" && Math.random() < 0.45) {
          var sleepLine = extraLine("sleepy") || pick(["（打了个哈欠）……嗯，我没事。", "困了……但还想再陪你一会儿。"]);
          if (sleepLine) say(sleepLine, undefined, { kind: "proactive" });
          setPose("sleep");
          setTimeout(function () { if (lastPose === "sleep") setPose("idle"); }, 4200);
          return;
        }
        let line = pick(SKIN().lines.idle);
        try {
          if (SKIN().id !== "whale" && typeof PERSONA !== "undefined" && PERSONA) {
            line = PERSONA.idleLine({ skin: SKIN().id, timeOfDay: { hour: hh, minute: new Date().getMinutes() }, mood: S.mood });
          }
        } catch (error) {}
        say(line);
      }
    }
    // 日常感：跨天换心情 + 跨整点的时段感 + 主动开口（4~8 分钟随机；面板开着/在忙就 20~40 秒后再试）
    dayTick(dt);
    hourTick();
    if (S.proactive === false) {
      proactiveTimer = 0;
    } else {
      proactiveTimer += dt;
      if (proactiveTimer >= proactiveNext) {
        const blocked =
          busy || root.style.display === "none" ||
          panelEl.classList.contains("on") || menuEl.classList.contains("on");
        if (blocked) {
          proactiveTimer = 0;
          proactiveNext = 20 + Math.random() * 20;
        } else {
          try { proactiveSay(false); } catch (error) { console.warn("[02] 主动开口失败", error); }
        }
      }
    }
    // 省电模式：3D 只每 ~32ms 渲染一次（UI/逻辑保持流畅），动画 dt 用累计值不跳变
    lowDt += dt;
    const renderNow = S.quality !== "low" || lowDt >= 0.032;
    if (renderNow && renderer && typeof renderer.tick === "function") {
      try { renderer.tick(lowDt, now / 1000); } catch (error) { console.warn("[02] tick 失败", error); }
      lowDt = 0;
    }
    if (fxEmitter) {
      try { fxEmitter.update(dt); } catch (error) {}
      fxTimer += dt;
      if (fxTimer > 1.4) {
        fxTimer = 0;
        if (lastPose === "sleep") burst("zzz", { n: 1 });
        else if (lastPose === "talk" && SKIN().id === "whale") burst("bubbles", { n: 2 });
        else if (lastPose === "happy" && SKIN().id === "whale") burst("bubbles", { n: 3 });
      }
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  if (location.search.indexOf("z02debug") >= 0) {
    window.__z02 = {
      openPanel, closePanel, say, pet, feed, sendMessage, state: S, setPose, applySkin, hidePet, showPet,
      showGuide: showGuide,
      sleepMode: function () { return sleepMode; },
      sleepNow: enterSleep,
      wakeUp: function () { exitSleep(); },
      ensure3d: ensure3d,
      get3d: function () { return pet3d; },
      getChar: function () { try { return pet3d && pet3d.getChar ? pet3d.getChar() : null; } catch (e) { return null; } },
      getProviders: function () { try { return pet3d && pet3d.getProvider ? pet3d.getProvider() : null; } catch (e) { return null; } },
      setDim: setDim, applyGeometry: applyGeometry,
      // 02 日常感（soul/daily）调试 API
      todayKey: todayKey,
      dailyMood: function () { return ensureDailyMood(true); },
      getDailyMood: function () { return ensureDailyMood(); },
      ensureTodayStats: ensureTodayStats,
      todaySummary: todaySummaryText,
      diaryLine: diaryLine,
      moodForPrompt: moodForPrompt,
      proactiveScenario: proactiveScenario,
      memoryCallback: memoryCallbackLine,
      todayThought: todayThoughtLine,
      habit: habitObservationLine,
      moodDrives: moodDrives,
      hourLine: hourLine,
      hourTick: hourTick,
      ritual: ritualCheck,
      llmOpener: llmOpener,
      noteInteraction: noteInteraction,
      topics: function () { return (S.topics || []).slice(); },
      promises: function () { return (S.promises || []).slice(); },
      rememberFact: rememberFact,
      learnPreference: learnPreference,
      noteTopic: noteTopic,
      compliments: function () { return (S.compliments || []).slice(); },
      noteCompliment: noteCompliment,
      noteBirthday: noteBirthday,
      birthdayLine: birthdayLine,
      anniversaryLine: anniversaryLine,
      daysKnown: daysKnown,
      complimentLine: complimentLine,
      weekNote: latestWeekNote,
      genWeekNote: maybeWeeklyNote,
      topicFollowUp: topicFollowUpLine,
      notePromise: notePromise,
      promiseLine: promiseLine,
      lipTest: function (text) { startLipSync(text || "测试"); return !!lipTimer; },
      lipOn: function () { return !!lipTimer; },
      counts: function () { return S.counts || null; },
      visitHours: function () { return (S.visitHours || []).slice(); },
      holidayLine: holidayLine,
      deepLine: deepLine,
      askPat: askForPat,
      askRequest: askRequest,
      activeRequest: activeRequest,
      fulfillRequest: fulfillRequest,
      proactive: proactiveSay,
      setProactiveNext: setProactiveNext,
      getProactive: function () {
        return {
          enabled: S.proactive !== false,
          nextIn: Math.max(0, Math.round(proactiveNext - proactiveTimer)),
          scenario: SKIN().id === "whale" ? "whale-idle" : proactiveScenario(),
          lastAt: S.lastProactiveAt || 0,
          lastScenario: S.lastProactiveScenario || "",
        };
      },
      getBubble: function () { return bubbleEl ? { on: bubbleEl.classList.contains("on"), text: bubbleEl.textContent } : null; },
      // 声音（TTS）调试 / 验收 API
      voiceStatus: function () { try { return VOICE.status(); } catch (e) { return { error: String(e) }; } },
      voiceHint: voiceHintText,
      setVoice: function (on) { setVoiceEnabled(on, true); return !!(S.voice && S.voice.on); },
      voiceSay: function (text, opts) {
        try { return VOICE.speak(text, Object.assign({ force: true, skin: SKIN().id }, opts || {})); } catch (e) { return false; }
      },
      voiceTest: function (opts) {
        try { return VOICE.test(Object.assign({ skin: SKIN().id }, opts || {})); } catch (e) { return false; }
      },
      voiceCancel: function () { try { VOICE.cancel(); return true; } catch (e) { return false; } },
      voicePlan: function (text, opts) {
        try { return VOICE.plan(text, Object.assign({ skin: SKIN().id }, opts || {})); } catch (e) { return null; }
      },
      voiceParams: function (text, opts) {
        try {
          return VOICE.paramsFor(Object.assign({ skin: SKIN().id, moodText: text || "" }, opts || {}));
        } catch (e) { return null; }
      },
      absenceLine: absenceLine,
      newDayLine: newDayLine,
      daysSinceSeen: daysSinceSeen,
      daysKnown: daysKnown,
      recordMoment: recordMoment,
      yesterdayRecall: yesterdayRecallLine,
      journal: function () { return (S.journal || []).slice(); },
      latestJournal: latestJournal,
      generateJournal: generateJournal,
      yesterdayDiary: yesterdayDiary,
      momentRecall: momentRecallLine,
      moments: function () { return (S.moments || []).slice(); },
      firstMeetAt: function () { return S.firstMeetAt || 0; },
    };
  }

  window.addEventListener("resize", () => {
    if (!S.docked) return;
    root.style.left = "";
    root.style.top = "";
  });

  return function dispose() {
    const mine = root;
    try { mine && mine.remove(); } catch {}
    try { restoreEl && restoreEl.remove(); } catch {}
    try { if (window[FLAG] && window[FLAG].root === mine) delete window[FLAG]; } catch {}
    const tag = document.querySelector('style[data-z02="' + PLUGIN_ID + '"]');
    if (tag) tag.remove();
    try { drop3d(); } catch (error) {}
    try { sfx && sfx.dispose && sfx.dispose(); } catch (error) {}
    try { menuEl = panelEl = bubbleEl = petEl = root = restoreEl = renderer = null; } catch {}
  };
}
