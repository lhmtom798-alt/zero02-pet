/**
 * pet3d —— 把 3D 角色接进桌宠窗口的适配层。
 * 负责：建舞台 / 换角色 / 尺寸 / 视线跟随 / 拖拽旋转视角 / 空闲自动回正 / 画质 / 释放。
 * 对外接口刻意做成和 2D 渲染器一样：{ setPose, tick }，引擎不用关心底下是 Canvas 还是 WebGL。
 */
module.exports.create = function (o) {
  var THREE = o.THREE, K = o.K, FIG = o.FIG;
  var host = o.host;
  var registry = o.registry;
  var stageMod = require("stage");
  var provider = null;   // VRM 角色提供者（vrmchar）；没接入时退回 registry 里的程序化角色

  var stage = stageMod.create({ THREE: THREE, K: K, host: host, quality: o.quality || "high" });
  var char = null, charId = null;
  var t = 0;
  var lastOrbitAt = 0;
  var lastPose = "";
  var disposed = false;
  var api = { type: "3d", stage: stage, host: host };

  function clearChar() {
    if (!char) return;
    try { stage.root.remove(char.root); } catch (e) {}
    try { if (char.dispose) char.dispose(); } catch (e) {}
    char = null;
    charId = null;
  }

  api.setProvider = function (p) { provider = p; return api; };
  api.hasProvider = function () { return !!provider; };
  /** 模型异步挂载失败时的回调（引擎用它回退 2D 立绘） */
  api.onMountFail = null;
  var mountWatchdog = null;
  var mountRetried = {};
  function watchMount(c) {
    try {
      if (!c || !c.mountPromise || !c.mountPromise.catch) return;
      if (mountWatchdog) { clearTimeout(mountWatchdog); mountWatchdog = null; }
      mountWatchdog = setTimeout(function () {
        if (disposed || char !== c) return;
        if (c.isMounted && c.isMounted()) return;
        // 加载卡住（弱网/渲染竞争）：重建一次；还不行就回退 2D，避免"隐身桌宠"
        var key = String(c.skin || charId || "?");
        if (!mountRetried[key]) {
          mountRetried[key] = true;
          console.warn("[pet3d] 模型挂载超时，重试一次: " + key);
          try { clearChar(); } catch (e) {}
          try { api.load(key); } catch (e) {}
          return;
        }
        console.warn("[pet3d] 模型挂载重试仍失败，回退 2D: " + key);
        try { clearChar(); } catch (e) {}
        try { if (typeof api.onMountFail === "function") api.onMountFail(key, new Error("mount-timeout")); } catch (e) {}
      }, 15000);
      c.mountPromise.then(function () {
        if (mountWatchdog) { clearTimeout(mountWatchdog); mountWatchdog = null; }
      }, function (error) {
        if (mountWatchdog) { clearTimeout(mountWatchdog); mountWatchdog = null; }
        if (disposed || char !== c) return;
        console.warn("[zero02] 3D 模型挂载失败，回退 2D: " + c.skin, error);
        try { clearChar(); } catch (e) {}
        try { if (typeof api.onMountFail === "function") api.onMountFail(c.skin, error); } catch (e) {}
      });
    } catch (e) {}
  }
  api.getProvider = function () { return provider; };
  api.getChar = function () { return char; };
  api.providerIds = function () {
    try { return provider && provider.listModels ? provider.listModels() : []; } catch (e) { return []; }
  };
  /** 模型是否已预热好（可以同步 build） */
  api.ready = function (skinId) {
    try { return !!(provider && provider.ready && provider.ready(skinId)); } catch (e) { return false; }
  };
  /** 触发预热，返回 Promise */
  api.preload = function (skinId) {
    try { return provider && provider.preload ? provider.preload(skinId) : null; } catch (e) { return null; }
  };

  /** 装载某个皮肤的 3D 版本；没有对应实现就返回 false（引擎会退回 2D 立绘） */
  function load(skinId) {
    if (disposed) return false;
    if (charId === skinId && char) return true;
    var useVrm = false;
    try { useVrm = !!(provider && provider.listModels && provider.listModels().indexOf(skinId) >= 0); } catch (e) {}
    var preset = useVrm ? null : registry.get(skinId);
    if (!useVrm && !preset) return false;
    clearChar();
    try {
      char = useVrm
        ? provider.build(skinId)
        : preset.build({ THREE: THREE, K: K, FIG: FIG, stage: stage });
    } catch (error) {
      console.warn("[zero02] 3D 形象构建失败: " + skinId, error);
      char = null;
      return false;
    }
    charId = skinId;
    stage.root.add(char.root);
    watchMount(char);
    if (useVrm) {
      // vrmchar 在模型解析完成后会自己调用 stage.frame；placeholder 阶段先按目标高度取景
      lastPose = "";
      setPose("idle");
      return true;
    }
    var box = null;
    try {
      box = new THREE.Box3().setFromObject(char.root);
    } catch (error) { box = null; }
    var cam = preset.meta && preset.meta.camera ? preset.meta.camera : {};
    stage.frame({
      bboxW: box ? (box.max.x - box.min.x) : null,
      bboxH: box ? (box.max.y - box.min.y) : null,
      bboxMinY: box ? box.min.y : null,
      bboxMaxY: box ? box.max.y : null,
      height: cam.height || char.height || 4.4,
      targetY: cam.targetY,
      margin: cam.margin,
      distK: cam.distK,
      elevation: cam.elevation,
      glowColor: cam.glowColor,
    });
    stage.setSize(host.clientWidth || 1, host.clientHeight || 1);
    lastPose = "";
    setPose("idle");
    return true;
  }

  function setPose(name) {
    if (!char || name === lastPose) return;
    lastPose = name;
    try { char.setState(name); } catch (error) { console.warn("[zero02] setState 失败", error); }
  }

  api.load = load;
  api.setPose = setPose;
  api.has = function () { return !!char; };
  api.skin = function () { return charId; };
  api.height = function () { return char ? char.height : 4; };
  api.setSize = function (w, h) {
    stage.setSize(w, h);
    return api;
  };
  api.bust = function (on) { try { stage.bust(on); } catch (e) {} return api; };
  api.snapshot = function () { try { return stage.snapshot(); } catch (e) { return ""; } };
  api.setQuality = function (q) {
    stage.setQuality(q);
    return api;
  };
  api.setNight = function (v) {
    stage.setNight(v);
    return api;
  };
  api.setLook = function (nx, ny) {
    if (char && char.setLook) char.setLook(nx, ny);
    return api;
  };
  api.pat = function () {
    if (char && char.pat) char.pat();
    return api;
  };
  api.orbit = function (dx, dy) {
    lastOrbitAt = t;
    var cur = stage.getOrbit();
    stage.setOrbit(cur.az + dx, cur.el + dy);
    return api;
  };
  api.resetView = function () {
    var cam = (registry.get(charId) || {}).meta || {};
    var c = cam.camera || {};
    stage.setOrbit(c.azimuth == null ? 0 : c.azimuth, c.elevation == null ? 0.08 : c.elevation);
    return api;
  };
  /** 鼠标/触控在窗口里移动 -> 角色视线跟随 */
  api.lookAt = function (clientX, clientY) {
    var r = host.getBoundingClientRect();
    if (!r.width) return api;
    var nx = ((clientX - (r.left + r.width * 0.5)) / (r.width * 0.62));
    var ny = ((clientY - (r.top + r.height * 0.42)) / (r.height * 0.5));
    api.setLook(clientX < 0 ? 0 : K.clamp(nx, -1, 1), clientY < 0 ? 0 : K.clamp(ny, -1, 1));
    return api;
  };
  api.tick = function (dt) {
    if (disposed) return;
    t += dt;
    var r0 = host.getBoundingClientRect();
    if (r0.width < 2 || r0.height < 2) return; // 被收起/折叠时不渲染，省电
    // 一段时间没碰视角就慢慢转回正面，看起来像"回过神来看着你"
    if (t - lastOrbitAt > 7) {
      var cur = stage.getOrbit();
      if (Math.abs(cur.az) > 0.02) stage.setOrbit(cur.az * 0.94, cur.el);
    }
    if (char) {
      try { char.update(dt, t); } catch (error) { console.warn("[zero02] 3D update 失败", error); }
    }
    stage.tick(dt);
    stage.render();
  };
  api.dispose = function () {
    disposed = true;
    clearChar();
    try { stage.dispose(); } catch (e) {}
    try { host.innerHTML = ""; } catch (e) {}
  };
  return api;
};
