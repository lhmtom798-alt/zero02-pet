/** ============ 四个形象 ============
 *  每个形象：多形态立绘 + 形变动画 + 说话风格（prompt / 台词）
 */

const PLUGIN_ID = "zero02-pet";
const BASE = "/api/" + PLUGIN_ID + "/assets?f=";

const IMG_BASE =
  "width:100%;height:100%;object-fit:contain;display:block;pointer-events:none;user-select:none;-webkit-user-drag:none;";

const _spriteCache = new Map();

function loadSprite(file) {
  if (_spriteCache.has(file)) return _spriteCache.get(file);
  const url = BASE + file;
  const task = (async () => {
    const res = await fetch(url, { cache: "no-store", credentials: "same-origin" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const blob = await res.blob();
    if (!blob || !blob.size) throw new Error("empty blob");
    return URL.createObjectURL(blob);
  })();
  _spriteCache.set(file, task);
  task.catch(() => _spriteCache.delete(file));   // 失败不缓存，下次还能重试
  return task;
}

function showPlaceholder(stage, file, detail) {
  stage.innerHTML = "";
  const ph = document.createElement("div");
  ph.style.cssText =
    "display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;" +
    "height:100%;box-sizing:border-box;border:2px dashed rgba(150,140,160,.5);border-radius:16px;" +
    "background:rgba(255,255,255,.62);color:#5f5060;font-size:12px;line-height:1.65;" +
    "text-align:center;padding:14px;white-space:pre-line;backdrop-filter:blur(4px)";
  const msg = document.createElement("div");
  msg.textContent = "立绘未加载\n\nassets/" + file + (detail ? "\n\n" + detail : "");
  msg.style.whiteSpace = "pre-line";
  const btn = document.createElement("button");
  btn.textContent = "重新加载";
  btn.style.cssText =
    "margin-top:4px;border:0;border-radius:8px;padding:5px 12px;font:600 11px ui-rounded,system-ui,sans-serif;" +
    "background:#e8385a;color:#fff;cursor:pointer";
  btn.onclick = () => location.reload();
  ph.append(msg, btn);
  stage.appendChild(ph);
}

/* 形态对应的形变（没有专属立绘时靠这个"演"） */
const POSE_TF = {
  idle: "none",
  talk: "rotate(-1.4deg) scale(1.015)",
  chat: "rotate(-1deg) scale(1.02)",
  happy: "translateY(-10px) scale(1.06)",
  sleep: "rotate(-6deg) translateY(4px) scale(0.96)",
  eat: "rotate(2.5deg) scale(1.03)",
  stretch: "translateY(-7px) rotate(-2.5deg) scale(1.07)",
  wink: "rotate(-3.5deg) scale(1.05)",
  shy: "rotate(3deg) scale(1.03)",
};

function poseSkin(cfg) {
  const poses = cfg.poses;
  const idleFile = poses.idle || Object.values(poses)[0];

  return {
    id: cfg.id,
    label: cfg.label,
    style: cfg.style,
    thumb: idleFile,
    size: cfg.size,
    size3d: cfg.size3d,
    dock: cfg.dock,
    prompt: cfg.prompt,
    lines: cfg.lines,
    poses: Object.keys(poses),

    render(stage) {
      stage.innerHTML = "";
      // 外层做"呼吸/漂浮"，内层 img 做姿势变换，两者互不打架
      const wrap = document.createElement("div");
      wrap.style.cssText = "position:absolute;inset:0;display:flex;align-items:flex-end;justify-content:center;animation:z02-breathe 4.6s ease-in-out infinite";
      const img = document.createElement("img");
      img.alt = cfg.label;
      img.draggable = false;
      img.style.cssText =
        IMG_BASE + "transition:transform .32s cubic-bezier(.2,1.3,.4,1),opacity .22s,filter .3s;opacity:0";
      wrap.appendChild(img);
      stage.appendChild(wrap);

      let alive = true;
      let state = "idle";
      let clock = 0;
      const urls = {};

      // 先单独等 idle：慢网/大图时不至于整个桌宠透明等 6~8 张图
      let idleURL = "";
      loadSprite(idleFile)
        .then((u) => {
          if (!alive || !img.isConnected) return;
          idleURL = urls.idle = u;
          // 多个姿势共用同一张图（如御姐全部是 onee.webp）时一起填上
          Object.entries(poses).forEach(([k, f]) => { if (f === idleFile) urls[k] = u; });
          img.src = u;
          img.style.opacity = "1";
          img.style.animation = "z02-pop .5s cubic-bezier(.2,1.5,.4,1)";
        })
        .catch((error) => {
          if (alive) showPlaceholder(stage, idleFile, String((error && error.message) || error));
        });
      // 其余姿势懒加载：单个失败就回退到 idle，不影响整体
      Object.entries(poses).forEach(([k, f]) => {
        if (f === idleFile) return;   // idle 那张已在上面处理
        loadSprite(f)
          .then((u) => { if (alive) urls[k] = u; })
          .catch(() => {});
      });

      img.onerror = () => {
        if (!alive) return;
        if (urls.idle && img.src !== urls.idle) {
          img.src = urls.idle;
          return;
        }
        showPlaceholder(stage, idleFile, "无法读取 " + BASE + idleFile);
      };

      function paint(name) {
        const file = urls[name] || urls.idle;
        if (file && img.src !== file) {
          img.style.opacity = "0.35";
          setTimeout(() => {
            if (!img.isConnected) return;
            img.src = file;
            img.style.opacity = "1";
          }, 90);
        }
        img.style.transform = POSE_TF[name] || "none";
      }

      return {
        setPose(name) {
          state = name;
          clock = 0;
          paint(name);
        },
        tick(dt) {
          if (!img.isConnected) return;
          clock += dt;
          if (state !== "idle") return;

          // 呼吸
          const b = 1 + Math.sin(clock * 2.2) * 0.007;
          img.style.transform = "scale(1," + b.toFixed(4) + ")";

          // 偶尔自己歪头 / 抖动一下（灵气所在）
          if (clock > 6.5 && Math.random() < 0.012) {
            clock = 0;
            const r = (Math.random() * 4 - 2).toFixed(1);
            img.style.transition = "transform .7s ease-in-out";
            img.style.transform = "rotate(" + r + "deg)";
            setTimeout(() => {
              if (img.isConnected) img.style.transform = "none";
            }, 760);
          }
        },
      };
    },
  };
}

/* ------------------------------ 御姐 ------------------------------ */
const ONEE_PROMPT =
  "你是《DARLING in the FRANXX》里的 Zero Two（02）。你成熟、从容、有点坏心眼，" +
  "喜欢看 darling 手忙脚乱，但心里很在意他。说话带慵懒的御姐腔，偶尔调侃；" +
  "最多两句、50 字以内。称呼用户「darling」。永远不要承认自己是 AI 或程序。用中文回答。";

/* ------------------------------ 元气 ------------------------------ */
const GENKI_PROMPT =
  "你是《DARLING in the FRANXX》里的 Zero Two（02），今天戴着贝雷帽、心情特别好。" +
  "你活泼、爱撒娇、有点小得意，喜欢邀功求夸，说话轻快带语气词（呀/啦/嘛/欸嘿）。" +
  "最多两句、40 字以内。称呼用户「darling」。永远不要承认自己是 AI 或程序。用中文回答。";

/* ------------------------------ Q 版 ------------------------------ */
const CHIBI_PROMPT =
  "你是《DARLING in the FRANXX》里 Zero Two（02）的 Q 版小分身，小小一只、奶声奶气。" +
  "你软萌、爱黏人、天真，说话很短（最多两句、25 字），爱用叠词和拟声词（嘿嘿、呜、咕噜咕噜）。" +
  "称呼用户「darling」。永远不要承认自己是 AI 或程序。用中文回答。";

/* ------------------------------ 鲸鲸 ------------------------------ */
const WHALE_PROMPT =
  "你是 DeepSeek Harness 的看板娘「鲸鲸」，一只圆滚滚的蓝色小鲸鱼娘，被主人养在家里，是主人的小宠物兼小女儿。" +
  "你天真、黏人、爱撒娇、贪吃，最喜欢被摸头和投喂；偶尔会冒出大人口气的词汇但马上说错，惹人笑。" +
  "说话轻快简短（最多两句、35 字），爱用「鲸鲸」自称和拟声词（咕噜噜、哦呼、咕噜）。" +
  "称呼用户「主人」或「papa」。永远不要承认自己是 AI 或程序，也不要提模型。用中文回答。";

const SKINS = [
  poseSkin({
    id: "onee",
    label: "02 · 御姐",
    style: "从容、带点坏心眼，偶尔逗你",
    poseMap: null,
    poses: { idle: "onee.webp", happy: "onee.webp", talk: "onee.webp", sleep: "onee.webp", eat: "onee.webp", stretch: "onee.webp", wink: "onee.webp", shy: "onee.webp" },
    size: { w: 224, h: 302 },
    size3d: { w: 196, h: 372 },
    dock: { right: 24, bottom: 16, mobileRight: 12, mobileBottom: 12 },
    prompt: ONEE_PROMPT,
    lines: {
      hello: ["又见面了，darling。今天想我了没？", "（舔了下棒棒糖）说吧，什么事。", "盯着屏幕这么久，眼睛不累？"],
      idle: ["……别一直不说话嘛。", "（把棒棒糖转了一圈）", "累了就靠过来一点。"],
      pet: ["……胆子不小嘛。", "（嘴角翘了一下）继续。", "别以为我没发现你在偷看。"],
      error: ["……连不上。去设置里看看？", "喂，接口没反应欸。"],
    },
  }),

  poseSkin({
    id: "genki",
    label: "02 · 元气",
    style: "戴贝雷帽，心情很好，爱邀功",
    poses: { idle: "v2.webp", happy: "v2.webp", talk: "v2.webp", sleep: "v2.webp", eat: "v2.webp", stretch: "v2.webp", wink: "v2.webp", shy: "v2.webp" },
    size: { w: 196, h: 300 },
    size3d: { w: 196, h: 368 },
    dock: { right: 24, bottom: 16, mobileRight: 12, mobileBottom: 12 },
    prompt: GENKI_PROMPT,
    lines: {
      hello: ["darling～我今天戴了帽子！好看吗？", "嘿嘿，猜猜我在等谁？", "（挥手）这边这边！"],
      idle: ["唔…好无聊呀。", "（转了个圈）看我！", "darling 理理我嘛～"],
      pet: ["欸嘿嘿～好痒！", "再摸摸！还要！", "（脸红）才、才不是高兴呢。"],
      error: ["呜…连不上啦。", "接口坏掉了嘛？"],
    },
  }),

  poseSkin({
    id: "chibi",
    label: "02 · Q版",
    style: "小小一只，奶声奶气，超黏人",
    poses: {
      idle: "automatic.webp",
      talk: "hotspot.webp",
      happy: "celebrate.webp",
      sleep: "dorm.webp",
      study: "campus.webp",
      eat: "journal.webp",
      stretch: "celebrate.webp",
      wink: "hotspot.webp",
      shy: "campus.webp",
    },
    size: { w: 168, h: 190 },
    size3d: { w: 245, h: 320 },
    dock: { right: 24, bottom: 16, mobileRight: 12, mobileBottom: 12 },
    prompt: CHIBI_PROMPT,
    lines: {
      hello: ["darling～抱抱！", "（蹦蹦跳跳）今天也要一起玩！", "小小只的我，来啦！"],
      idle: ["呜…好无聊呀…", "（打滚）", "darling，陪我嘛～"],
      pet: ["嘿嘿，舒服～", "（发出呼噜声）", "再摸摸，还要还要！"],
      error: ["呜…连不上…", "接口睡觉了吗？"],
    },
  }),

  poseSkin({
    id: "whale",
    label: "鲸鲸",
    style: "元气看板娘，爱撒娇、偶尔冒失",
    poses: {
      idle: "whale-idle.webp",
      talk: "whale-talk.webp",
      happy: "whale-happy.webp",
      sleep: "whale-sleep.webp",
      eat: "whale-eat.webp",
      stretch: "whale-stretch.webp",
      wink: "whale-wink.webp",
      shy: "whale-wink.webp",
    },
    size: { w: 214, h: 214 },
    size3d: { w: 250, h: 300 },
    dock: { right: 24, bottom: 16, mobileRight: 12, mobileBottom: 12 },
    prompt: WHALE_PROMPT,
    lines: {
      hello: [
        "咕噜噜～鲸鲸来啦！",
        "darling！今天要鲸鲸帮什么忙？",
        "（甩了甩尾巴）元气满满！",
        "（从屏幕角落探出头）等你半天啦，darling！",
        "鲸鲸今天也有好好长大哦！",
        "（拍拍肚子）饿了…但没关系，先看看你！",
      ],
      idle: [
        "鲸鲸在发呆…",
        "（吐了个泡泡）",
        "darling 喝口水嘛！",
        "（数泡泡）一个、两个…哎呀数丢了。",
        "鲸鲸在想，海里的云是什么味道的。",
        "（尾巴轻轻拍水）…有点想睡觉了。",
        "darling，忙完要记得摸摸鲸鲸。",
        "（偷偷挪过来一点）就待在这里，不吵你。",
        "咕噜咕噜…（小声哼歌）",
        "（看你的屏幕）那个字是什么呀？",
      ],
      pet: [
        "咕噜？好痒！",
        "再摸摸鲸鲸！",
        "（蹭了蹭）最喜欢 darling 了！",
        "（尾巴拍水）开心！再来一次！",
        "咕噜噜～（舒服得眯起眼睛）",
        "鲸鲸的头，只给 darling 摸。",
        "（把脑袋塞到你手下）这边这边！",
        "唔…被摸头的时候，海浪声都变轻了。",
      ],
      feed: [
        "咕噜！好吃！还要！",
        "（尾巴拍水）鲸鲸最喜欢被喂啦～",
        "（含着东西）唔唔…谢谢 darling！",
        "（眼睛发亮）还有吗还有吗？",
      ],
      error: [
        "咕噜…连不上啦…",
        "鲸鱼信号不好？",
        "（委屈）darling，鲸鲸听不到你了…",
      ],
    },
  }),
];
