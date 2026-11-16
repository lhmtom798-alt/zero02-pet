/**
 * vrmchar —— three-vrm（VRM 动漫模型）角色适配层。
 *
 * 把 VRM 模型接成和 src/3d/chars/* 一样的角色契约：
 *   { root, height, camera, update(dt,t), setState(name), setLook(x,y), pat(), dispose() }
 * 状态名沿用桌宠引擎的：idle / happy / talk / sleep / shy / stretch / wink / eat。
 *
 * 依赖 window.THREE + window.THREE_VRM（vendor/three-vrm.global.js 一个文件搞定）。
 * 不依赖 kit/fig —— VRM 自带网格、骨架、材质、表情、SpringBone，
 * MToon 材质由 three-vrm 的 GLTFLoader 插件直接生成。
 *
 * 典型用法（插件侧，异步）：
 *
 *   var VRMCHAR = __req("vrmchar").create({ THREE: THREE, K: K, stage: stage });
 *   VRMCHAR.addModel("seed", { url: "models/Seed-san.vrm", height: 4.4 });
 *   VRMCHAR.preload("seed");                       // 后台预热（fetch + 解析 + 测量）
 *   var char = VRMCHAR.build("seed");              // 同步返回，已预热时立即挂载
 *   stage.root.add(char.root);
 *   char.update(dt, t); stage.tick(dt); stage.render();
 *
 * 未预热时 build 会先返回一个等高的占位 root（空），模型解析完再异步挂载，
 * 挂载时自己调用 stage.frame() 重新取景，所以宿主不需要感知加载状态。
 */
module.exports.create = function (o) {
  o = o || {};
  var THREE = o.THREE || (typeof window !== "undefined" ? window.THREE : null);
  var K = o.K || {};
  var stage = o.stage || null;
  var THREE_VRM = o.THREE_VRM || (typeof window !== "undefined" ? window.THREE_VRM : null);

  if (!THREE) throw new Error("[vrmchar] 缺少 THREE —— 需要先加载 vendor/three-vrm.global.js");
  if (!THREE_VRM || !THREE_VRM.GLTFLoader || !THREE_VRM.VRMLoaderPlugin) {
    throw new Error("[vrmchar] 缺少 THREE_VRM —— 需要先加载 vendor/three-vrm.global.js（含 GLTFLoader + VRMLoaderPlugin）");
  }

  var GLTFLoader = THREE_VRM.GLTFLoader;
  var VRMLoaderPlugin = THREE_VRM.VRMLoaderPlugin;
  var VRMUtils = THREE_VRM.VRMLoaderPlugin ? THREE_VRM.VRMUtils : null;
  var clamp = K.clamp || function (v, a, b) { return v < a ? a : v > b ? b : v; };
  var PI = Math.PI;

  // VRM0 模型加载后会被 VRMUtils.rotateVRM0 整体旋转 180°（面朝 +Z）。
  // three-vrm 的归一化骨骼 rig 是在旋转之前建立的，所以 VRM0 的归一化骨骼
  // 旋转要在这个"旋转前坐标系"里表达：q_norm = S^-1 · q_world · S（S = Ry(π)）。
  var YAW_PI = new THREE.Quaternion(0, 1, 0, 0);
  var YAW_PI_INV = new THREE.Quaternion(0, -1, 0, 0);

  /* ============================ 模型清单（可配置） ============================ */
  // { skinId: { url, label, height, glowColor, camera:{...}, turnY, offsetY, ... } }
  // height 是"归一化后的角色高度"（和程序化手办一样用 ~4.4 的舞台单位），
  // 模型原始尺寸（通常是 1.4~1.8 米）会自动按包围盒缩放。
  var MODELS = Object.create(null);
  var DEFAULT_HEIGHT = o.height || 4.4;

  // 外观风格（换发色/瞳色/衣服染色/挂件/Q版头身比…）由 "vrm-style" 模块实现，
  // 这里是 { skinId: styleCfg } 的清单；模块不存在时自动跳过（构建不会挂）。
  var STYLES = Object.create(null);
  var STYLE_MODULE = o.styleModule || "vrm-style";

  function defaults() {
    return {
      url: "",
      label: "",
      height: DEFAULT_HEIGHT,
      glowColor: 0xff8fb0,
      camera: { margin: 1.06, elevation: 0.06, azimuth: 0, distK: 1 },
      turnY: 0,
      offsetY: 0,
      outline: true,
      outlineGain: 4.2,
      state: "idle",
    };
  }

  function mergeCfg(base, extra) {
    var out = {}, k;
    for (k in base) out[k] = base[k];
    if (extra) for (k in extra) if (extra[k] !== undefined) out[k] = extra[k];
    if (base && base.camera && extra && extra.camera) {
      var cam = {}, ck;
      for (ck in base.camera) cam[ck] = base.camera[ck];
      for (ck in extra.camera) cam[ck] = extra.camera[ck];
      out.camera = cam;
    }
    return out;
  }

  function addModel(id, cfg) {
    if (!id || !cfg) return api;
    MODELS[id] = mergeCfg(MODELS[id] || defaults(), cfg);
    return api;
  }
  function setModels(map) {
    for (var id in map || {}) addModel(id, map[id]);
    return api;
  }
  if (o.models) setModels(o.models);
  if (o.styles) setStyles(o.styles);

  function setStyles(map) {
    for (var id in map || {}) STYLES[id] = map[id];
    return api;
  }
  function addStyle(id, cfg) {
    if (id && cfg) STYLES[id] = cfg;
    return api;
  }
  function styleFor(skinOrUrl, buildCfg) {
    if (buildCfg && buildCfg.style) return buildCfg.style;
    if (STYLES[skinOrUrl]) return STYLES[skinOrUrl];
    var m = MODELS[skinOrUrl];
    return m && m.style ? m.style : null;
  }

  function modelCfg(skinOrUrl) {
    if (MODELS[skinOrUrl]) return MODELS[skinOrUrl];
    // 也允许直接传 URL / 相对路径
    return mergeCfg(defaults(), { url: String(skinOrUrl || "") });
  }

  /* ============================ 工具 ============================ */
  function nowMs() {
    return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
  }
  function baseDir(url) {
    var i = url.lastIndexOf("/");
    return i >= 0 ? url.slice(0, i + 1) : "";
  }
  function once(fn) {
    var done = false;
    return function () {
      if (done) return;
      done = true;
      return fn.apply(null, arguments);
    };
  }

  /* ============================ 预加载缓存 ============================ */
  // URL -> { state, promise, arrayBuffer, vrm, measure, bytes, loadMs, claimed, error, progress }
  var cache = Object.create(null);

  function getEntry(url) {
    var e = cache[url];
    if (!e) {
      e = cache[url] = {
        url: url,
        state: "idle", // idle | loading | ready | error
        promise: null,
        arrayBuffer: null,
        vrm: null,
        measure: null,
        bytes: 0,
        loadMs: 0,
        claimed: false,
        parsed: 0,
        progress: 0,
        error: null,
      };
    }
    return e;
  }

  /** 把 ArrayBuffer 解析成 VRM 实例（GLTFLoader.parseAsync + VRMLoaderPlugin） */
  function parseVRM(buffer, url) {
    return new Promise(function (resolve, reject) {
      var loader = new GLTFLoader();
      loader.register(function (parser) { return new VRMLoaderPlugin(parser); });
      var done = function (gltf) {
        var vrm = gltf && gltf.userData ? gltf.userData.vrm : null;
        if (!vrm) {
          reject(new Error("[vrmchar] 不是 VRM 文件: " + url));
          return;
        }
        try {
          // VRM0 的模型正面朝 -Z，统一转成 VRM1 的 +Z 朝向前
          if (vrm.meta && vrm.meta.metaVersion === "0") VRMUtils.rotateVRM0(vrm);
        } catch (error) { /* 老版本没有 rotateVRM0 也不致命 */ }
        resolve(vrm);
      };
      try {
        if (typeof loader.parseAsync === "function") {
          loader.parseAsync(buffer, baseDir(url)).then(done, reject);
        } else {
          loader.parse(buffer, baseDir(url), done, reject);
        }
      } catch (error) {
        reject(error);
      }
    });
  }

  /** 读包围盒（会先把矩阵刷一遍，避免 setFromObject 拿到过期变换） */
  function measureObject(obj) {
    obj.updateMatrixWorld(true);
    var box = new THREE.Box3().setFromObject(obj);
    var size = new THREE.Vector3();
    box.getSize(size);
    return {
      box: box,
      width: size.x,
      height: size.y,
      depth: size.z,
      minY: box.min.y,
      maxY: box.max.y,
      cx: (box.min.x + box.max.x) * 0.5,
      cz: (box.min.z + box.max.z) * 0.5,
    };
  }

  /**
   * 量"当前姿势"下的包围盒。
   *
   * Box3.setFromObject 对 SkinnedMesh 用的是 geometry.boundingBox（绑定姿势 = T-pose），
   * 直接量会把手臂张开也算进去，取景会远一倍、角色显得很小。
   * 这里对蒙皮网格按骨骼变换采样顶点，得到真实姿势的包围盒；
   * 同时把结果写回 geometry.boundingBox —— 这样 pet3d / stage 之后再
   * Box3.setFromObject(char.root) 量到的也是真实尺寸（宿主不需要专门适配）。
   */
  function measurePosed(root, opts) {
    opts = opts || {};
    var perMeshCap = opts.samplesPerMesh || 3000;
    var worldBox = new THREE.Box3();
    var tmp = new THREE.Vector3();
    var sampled = 0;
    root.updateMatrixWorld(true);
    root.traverse(function (obj) {
      if (!obj.isMesh) return;
      var geo = obj.geometry;
      if (!geo) return;
      if (obj.isSkinnedMesh && typeof obj.getVertexPosition === "function") {
        try {
          if (obj.skeleton && obj.skeleton.update) obj.skeleton.update();
          var posAttr = geo.attributes && geo.attributes.position;
          if (!posAttr) return;
          var count = posAttr.count;
          var stride = Math.max(1, Math.floor(count / perMeshCap));
          var local = new THREE.Box3();
          for (var i = 0; i < count; i += stride) {
            obj.getVertexPosition(i, tmp);
            local.expandByPoint(tmp);
            sampled++;
          }
          if (local.isEmpty()) return;
          // 写回包围盒：three r166 的 Box3.setFromObject 对 SkinnedMesh 优先读
          // object.boundingBox（若为 null 会用绑定姿势算一次并缓存住），
          // 所以这里把"当前姿势"的盒子塞给 object/geometry，宿主之后量到的就是真实尺寸。
          // （frustumCulled 已关，不影响渲染裁剪）
          geo.boundingBox = local;
          if (obj.boundingBox === undefined || obj.boundingBox === null || obj.boundingBox.isBox3) {
            obj.boundingBox = local.clone();
          }
          worldBox.union(local.clone().applyMatrix4(obj.matrixWorld));
          return;
        } catch (error) {
          // 老版本 three 没有 getVertexPosition -> 落回绑定盒
        }
      }
      if (!geo.boundingBox) geo.computeBoundingBox();
      if (geo.boundingBox) worldBox.union(geo.boundingBox.clone().applyMatrix4(obj.matrixWorld));
    });
    var size = new THREE.Vector3();
    worldBox.getSize(size);
    return {
      box: worldBox,
      width: size.x,
      height: size.y,
      depth: size.z,
      minY: worldBox.min.y,
      maxY: worldBox.max.y,
      cx: (worldBox.min.x + worldBox.max.x) * 0.5,
      cz: (worldBox.min.z + worldBox.max.z) * 0.5,
      sampled: sampled,
    };
  }


  /** 下载流水线：fetch -> ArrayBuffer -> 解析 -> 缓存 */
  function preload(skinOrUrl, opts) {
    opts = opts || {};
    var cfg = modelCfg(skinOrUrl);
    var url = cfg.url;
    if (!url) return Promise.reject(new Error("[vrmchar] 空的模型 URL: " + skinOrUrl));

    var entry = getEntry(url);
    if (entry.state === "ready") {
      return Promise.resolve({ vrm: entry.vrm, arrayBuffer: entry.arrayBuffer, meta: entry.measure, url: url, cached: true });
    }
    if (entry.promise) return entry.promise;

    var t0 = nowMs();
    entry.state = "loading";
    entry.error = null;
    entry.progress = 0;

    var p = Promise.resolve()
      .then(function () {
        var fetchUrl = url;
        if (opts.bust) fetchUrl += (url.indexOf("?") >= 0 ? "&" : "?") + "v=" + Date.now();
        return fetch(fetchUrl, { credentials: "same-origin" });
      })
      .then(function (res) {
        if (!res || !res.ok) throw new Error("[vrmchar] VRM 下载失败 HTTP " + (res ? res.status : "?") + " · " + url);
        var total = Number(res.headers.get("content-length")) || 0;
        // 能拿到流就报进度；拿不到就一把梭
        if (opts.onProgress && res.body && typeof res.body.getReader === "function") {
          var reader = res.body.getReader();
          var chunks = [], loaded = 0;
          return (function readLoop() {
            return reader.read().then(function (r) {
              if (r.done) {
                var out = new Uint8Array(loaded);
                var off = 0;
                for (var i = 0; i < chunks.length; i++) { out.set(chunks[i], off); off += chunks[i].byteLength; }
                return out.buffer;
              }
              chunks.push(r.value);
              loaded += r.value.byteLength;
              entry.progress = total ? loaded / total : 0;
              try { opts.onProgress(loaded, total); } catch (error) { /* ignore */ }
              return readLoop();
            });
          })();
        }
        return res.arrayBuffer();
      })
      .then(function (buffer) {
        entry.arrayBuffer = buffer;
        entry.bytes = buffer.byteLength;
        entry.progress = 1;
        return parseVRM(buffer, url);
      })
      .then(function (vrm) {
        entry.vrm = vrm;
        entry.measure = measureObject(vrm.scene);
        entry.state = "ready";
        entry.loadMs = Math.round(nowMs() - t0);
        entry.promise = null;
        return { vrm: vrm, arrayBuffer: entry.arrayBuffer, meta: entry.measure, url: url, cached: false };
      })
      .catch(function (error) {
        entry.state = "error";
        entry.error = error;
        entry.promise = null;
        throw error;
      });

    // 包装成共享 promise：并发 preload 只下载一次
    entry.promise = p.then(function (res) {
      return res;
    }, function (error) {
      entry.promise = null;
      throw error;
    });
    return entry.promise;
  }

  function ready(skinOrUrl) {
    var cfg = modelCfg(skinOrUrl);
    var e = cache[cfg.url];
    return !!(e && e.state === "ready" && (e.vrm || e.arrayBuffer));
  }

  function modelInfo(skinOrUrl) {
    var cfg = modelCfg(skinOrUrl);
    var e = cache[cfg.url];
    if (!e) return { url: cfg.url, state: "idle" };
    return {
      url: cfg.url,
      state: e.state,
      bytes: e.bytes,
      loadMs: e.loadMs,
      progress: e.progress,
      claimed: e.claimed,
      parsed: e.parsed,
      meta: e.measure
        ? {
            width: +e.measure.width.toFixed(3),
            height: +e.measure.height.toFixed(3),
            depth: +e.measure.depth.toFixed(3),
            minY: +e.measure.minY.toFixed(3),
            maxY: +e.measure.maxY.toFixed(3),
          }
        : null,
      error: e.error ? String(e.error.message || e.error) : null,
    };
  }

  /* ============================ 骨架 / 姿势 ============================ */
  var BONE_NAMES = [
    "hips", "spine", "chest", "upperChest", "neck", "head",
    "leftShoulder", "rightShoulder",
    "leftUpperArm", "rightUpperArm", "leftLowerArm", "rightLowerArm",
    "leftHand", "rightHand",
    "leftUpperLeg", "rightUpperLeg", "leftLowerLeg", "rightLowerLeg",
  ];

  // 基础站姿：VRM 的 rest pose 是 T-pose，手臂必须自己放下来（单位：弧度）。
  // 归一化 humanoid 骨骼的 rotation 是"相对 T-pose 的增量"，手臂沿 ±X 展开：
  //   leftUpperArm.z 负值 = 左臂放下；rightUpperArm.z 正值 = 右臂放下。
  var BASE_POSE = {
    hips: [0, 0, 0],
    spine: [0, 0, 0],
    chest: [0.01, 0, 0],
    upperChest: [0.01, 0, 0],
    neck: [0, 0, 0],
    head: [0, 0, 0],
    leftShoulder: [0, 0, -0.03],
    rightShoulder: [0, 0, 0.03],
    leftUpperArm: [-0.03, 0.06, -1.30],
    rightUpperArm: [-0.03, -0.06, 1.30],
    leftLowerArm: [0.04, -0.14, -0.16],
    rightLowerArm: [0.04, 0.14, 0.16],
    leftHand: [0, 0, 0.05],
    rightHand: [0, 0, -0.05],
    leftUpperLeg: [0, 0, 0],
    rightUpperLeg: [0, 0, 0],
    leftLowerLeg: [0, 0, 0],
    rightLowerLeg: [0, 0, 0],
  };

  var POSE_KEYS = Object.keys(BASE_POSE);

  function copyPose(dst) {
    for (var i = 0; i < POSE_KEYS.length; i++) {
      var k = POSE_KEYS[i];
      var b = BASE_POSE[k];
      dst[k][0] = b[0]; dst[k][1] = b[1]; dst[k][2] = b[2];
    }
  }

  function newPose() {
    var p = {};
    for (var i = 0; i < POSE_KEYS.length; i++) p[POSE_KEYS[i]] = [0, 0, 0];
    return p;
  }

  /* ============================ 表情 ============================ */
  var EXPR_ALIASES = {
    happy: ["happy", "joy"],
    angry: ["angry"],
    sad: ["sad", "sorrow"],
    relaxed: ["relaxed", "fun"],
    surprised: ["surprised", "surprise"],
    blink: ["blink"],
    blinkLeft: ["blinkLeft"],
    blinkRight: ["blinkRight"],
    aa: ["aa", "A"],
    ih: ["ih", "I"],
    ou: ["ou", "U"],
    ee: ["ee", "E"],
    oh: ["oh", "O"],
  };

  /* ============================ 角色实例 ============================ */
  function build(skinOrUrl, buildCfg) {
    buildCfg = buildCfg || {};
    var cfg = mergeCfg(modelCfg(skinOrUrl), buildCfg.model || {});
    if (buildCfg.height) cfg.height = buildCfg.height;
    if (buildCfg.camera) cfg = mergeCfg(cfg, { camera: buildCfg.camera });

    var url = cfg.url;
    if (!url) throw new Error("[vrmchar] build() 缺少模型 URL: " + skinOrUrl);
    var targetH = cfg.height || DEFAULT_HEIGHT;

    var root = new THREE.Group();
    root.name = "vrm-char";
    var inner = new THREE.Group(); // 模型 + 灯光挂这里，root 留给宿主做整体缩放
    inner.name = "vrm-inner";
    root.add(inner);

    var char = {
      type: "vrm",
      root: root,
      height: targetH,
      camera: cfg.camera,
      bbox: null,
      loadError: null,
      mountPromise: null,
      isMounted: function () { return mounted; },
    };

    var disposed = false;
    var mounted = false;
    var vrm = null;
    var rig = {};          // boneName -> Object3D（归一化骨骼）
    var restCorr = Object.create(null); // boneName -> Quaternion：把模型的 rest 姿势校正成标准 T-pose
    var tmpQuat = new THREE.Quaternion();
    var tmpEuler = new THREE.Euler();
    var restDebug = [];
    var rot0 = false; // VRM0: 归一化 rig 建在旋转前坐标系
    var poseCur = newPose();
    var poseTgt = newPose();
    var exprCur = Object.create(null);
    var exprTgt = Object.create(null);
    var exprMap = Object.create(null); // preset -> 实际表情名 或 null
    var state = cfg.state || "idle";
    var stateT = 0;
    var tAcc = 0;
    var look = { x: 0, y: 0, tx: 0, ty: 0 };
    var blinkAt = 1.6 + Math.random() * 3.2;
    var blinkT = -1;
    var patT = 0;
    var mouthT = 0;
    var lookTarget = null;
    var lightRefs = null;
    var rendererPrev = null;
    var styleApi = null; // vrm-style 的单例（create(THREE, THREE_VRM) 产物）
    var exprOverride = Object.create(null); // 调试用：真实表情名 -> 权重
    var boneOverride = Object.create(null); // 调试用：骨骼名 -> [x,y,z]
    var mountResolve = null, mountReject = null;
    char.mountPromise = new Promise(function (res, rej) { mountResolve = res; mountReject = rej; });
    // 别让未处理的拒绝炸出来（宿主不关心时也要安静）
    if (char.mountPromise && char.mountPromise.catch) char.mountPromise.catch(function () {});

    /* ---------- 占位：让宿主在模型未解析完时也能拿到合法包围盒 ---------- */
    var placeholder = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false })
    );
    placeholder.name = "vrm-placeholder";
    placeholder.scale.set(targetH * 0.44, targetH, targetH * 0.3);
    placeholder.position.y = targetH * 0.5;
    placeholder.visible = false; // 不显示，但 Box3.setFromObject 仍会算它
    inner.add(placeholder);

    function killPlaceholder() {
      if (!placeholder) return;
      inner.remove(placeholder);
      try { placeholder.geometry.dispose(); } catch (e) {}
      try { placeholder.material.dispose(); } catch (e) {}
      placeholder = null;
    }

    /* ---------- 灯光：MToon 是标准 PBR 管线，没有灯就是黑的 ---------- */
    function makeLights(cfgLight) {
      var lc = cfgLight || o.light || {};
      lightRefs = { group: new THREE.Group() };
      lightRefs.group.name = "vrm-lights";
      lightRefs.ambient = new THREE.AmbientLight(0xffffff, lc.ambient == null ? 0.5 : lc.ambient);
      lightRefs.hemi = new THREE.HemisphereLight(0xffeef6, 0x3a2f46, lc.hemi == null ? 0.3 : lc.hemi);
      lightRefs.key = new THREE.DirectionalLight(0xfff6f0, lc.key == null ? 2.7 : lc.key);
      lightRefs.fill = new THREE.DirectionalLight(0xcfe0ff, lc.fill == null ? 0.75 : lc.fill);
      lightRefs.rim = new THREE.DirectionalLight(0xffd9e8, lc.rim == null ? 1.0 : lc.rim);
      lightRefs.key.position.set(2.2, 5.2, 3.6);
      lightRefs.fill.position.set(-3.2, 2.2, 2.4);
      lightRefs.rim.position.set(-0.8, 3.4, -4.2);
      lightRefs.group.add(lightRefs.ambient, lightRefs.hemi, lightRefs.key, lightRefs.fill, lightRefs.rim);
      inner.add(lightRefs.group);
      applyLight(lc);
    }

    /** 调灯：{ ambient, hemi, key, fill, rim, keyPos:[x,y,z], fillPos, rimPos, keyColor, fillColor, rimColor } */
    function applyLight(lc) {
      if (!lightRefs) return;
      lc = lc || {};
      var L = lightRefs;
      if (lc.ambient != null) L.ambient.intensity = lc.ambient;
      if (lc.hemi != null) L.hemi.intensity = lc.hemi;
      if (lc.key != null) L.key.intensity = lc.key;
      if (lc.fill != null) L.fill.intensity = lc.fill;
      if (lc.rim != null) L.rim.intensity = lc.rim;
      if (lc.keyPos) L.key.position.fromArray(lc.keyPos);
      if (lc.fillPos) L.fill.position.fromArray(lc.fillPos);
      if (lc.rimPos) L.rim.position.fromArray(lc.rimPos);
      if (lc.keyColor != null) L.key.color.set(lc.keyColor);
      if (lc.fillColor != null) L.fill.color.set(lc.fillColor);
      if (lc.rimColor != null) L.rim.color.set(lc.rimColor);
      if (lc.hemiSky != null) L.hemi.color.set(lc.hemiSky);
      if (lc.hemiGround != null) L.hemi.groundColor.set(lc.hemiGround);
    }

    /* ---------- 材质：MToon 描边 + 渲染器色彩管理 ---------- */
    function setupMaterials() {
      var outlineEnabled = cfg.outline !== false;
      var gain = cfg.outlineGain == null ? 4.2 : cfg.outlineGain;
      var skip = cfg.outlineSkip || /face|eye|mouth|brow|lash|highlight|tear|iris|pupil|tongue/i;
      var stats = { mtoon: 0, meshes: 0, outlines: 0, made: 0, amplified: 0 };

      // 先把所有网格的基础设置做掉，并统计模型自带描边
      var surfaces = [];
      vrm.scene.traverse(function (obj) {
        if (!obj.isMesh) return;
        stats.meshes++;
        obj.frustumCulled = obj.isSkinnedMesh ? false : obj.frustumCulled;
        obj.castShadow = false;
        obj.receiveShadow = false;
        var mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (var i = 0; i < mats.length; i++) {
          var m = mats[i];
          if (!m || !m.isMToonMaterial) continue;
          stats.mtoon++;
          if (m.isOutline) stats.outlines++;
          else surfaces.push({ mesh: obj, mat: m });
        }
      });

      // 模型自带描边（VRM 作者的意图）：尊重它，只做适度加粗
      if (stats.outlines > 0) {
        if (outlineEnabled && gain !== 1) {
          vrm.scene.traverse(function (obj) {
            if (!obj.isMesh) return;
            var mats = Array.isArray(obj.material) ? obj.material : [obj.material];
            for (var i = 0; i < mats.length; i++) {
              var m = mats[i];
              if (m && m.isMToonMaterial && m.isOutline) { m.outlineWidthFactor *= gain; stats.amplified++; }
            }
          });
        }
        return stats;
      }

      // 模型完全没有描边：给"非脸部"材质补一条背面壳。
      // 脸部（眼/眉/嘴/高光）不加，否则眼睛会糊成一团。
      if (!outlineEnabled) return stats;
      var seen = [];
      for (var s = 0; s < surfaces.length; s++) {
        var item = surfaces[s];
        var obj = item.mesh, m = item.mat;
        if (seen.indexOf(obj) >= 0) continue; // 一个网格只处理一次
        if (Array.isArray(obj.material)) continue;
        if (skip.test(m.name || "") || skip.test(obj.name || "")) continue;
        seen.push(obj);
        try {
          var om = m.clone();
          om.name = (m.name || "mtoon") + " (Outline)";
          om.isOutline = true;
          om.side = THREE.BackSide;
          om.outlineWidthMode = "worldCoordinates";
          // 模型原始高度约 1.4~1.8，缩放到 4.4 后 world 描边会被放大，这里用较小的值
          om.outlineWidthFactor = cfg.outlineWidth == null ? 0.0016 : cfg.outlineWidth;
          om.outlineColorFactor = new THREE.Color(cfg.outlineColor == null ? 0x35222e : cfg.outlineColor);
          om.outlineLightingMixFactor = 0;
          obj.material = [m, om];
          var geo = obj.geometry;
          var count = geo.index ? geo.index.count : geo.attributes.position.count;
          geo.clearGroups();
          geo.addGroup(0, count, 0);
          geo.addGroup(0, count, 1);
          stats.made++;
        } catch (error) { /* 克隆失败就保持原样 */ }
      }
      return stats;
    }

    function setupRenderer() {
      if (!stage || !stage.renderer) return;
      var r = stage.renderer;
      rendererPrev = { toneMapping: r.toneMapping, exposure: r.toneMappingExposure, colorSpace: r.outputColorSpace };
      r.outputColorSpace = THREE.SRGBColorSpace;
      // 动漫平涂：NoToneMapping 颜色最准；cfg.toneMapping = "aces" 可以更"摄影感"
      r.toneMapping = cfg.toneMapping === "aces" ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
      r.toneMappingExposure = cfg.exposure == null ? 1 : cfg.exposure;
    }

    /* ---------- 表情 / 骨骼初始化 ---------- */
    function setupExpressions() {
      var mgr = vrm.expressionManager;
      if (!mgr) return;
      for (var preset in EXPR_ALIASES) {
        var names = EXPR_ALIASES[preset];
        var found = null;
        for (var i = 0; i < names.length; i++) {
          try {
            if (mgr.getExpression(names[i])) { found = names[i]; break; }
          } catch (error) { /* ignore */ }
        }
        exprMap[preset] = found;
        exprCur[preset] = 0;
        exprTgt[preset] = 0;
      }
    }

    function setupRig() {
      rig = {};
      for (var i = 0; i < BONE_NAMES.length; i++) {
        var n = BONE_NAMES[i];
        try { rig[n] = vrm.humanoid ? vrm.humanoid.getNormalizedBoneNode(n) : null; } catch (error) { rig[n] = null; }
      }
      // 归一化骨骼的真实 rest 姿态全在原始模型里（T-pose），这里用 0 增量即可；
      // 但手臂要放下来，所以直接给 poseCur 填基础站姿，避免第一帧甩手。
      copyPose(poseCur);
      copyPose(poseTgt);
    }

    /**
     * 归一化骨骼的 0 旋转 = 模型自己的 rest 姿势。VRM 规范要求 rest 是 T-pose，
     * 但很多 VRoid 模型实际是 A-pose（手臂斜向下 45°），直接套 T-pose 的姿势
     * 会把手臂抬起来。这里先量出每根手臂/腿的 rest 朝向，算一个"rest -> 标准 T-pose"
     * 的四元数校正，动画时用 q_anim * q_corr 叠加，这样 T-pose / A-pose 模型都能摆对。
     */
    function setupRestCorrection() {
      restCorr = Object.create(null);
      restDebug = [];
      // 归一化 rig 节点本身就是"旋转前的标准 T-pose 位置"，
      // 用它们的局部位置差量 rest 朝向最稳（不受 scene 旋转 / 模型缩放影响）。
      var lx = rot0 ? -1 : 1;
      var pairs = [
        ["leftUpperArm", "leftLowerArm", [lx, 0, 0]],
        ["leftLowerArm", "leftHand", [lx, 0, 0]],
        ["rightUpperArm", "rightLowerArm", [-lx, 0, 0]],
        ["rightLowerArm", "rightHand", [-lx, 0, 0]],
        ["leftUpperLeg", "leftLowerLeg", [0, -1, 0]],
        ["leftLowerLeg", "leftFoot", [0, -1, 0]],
        ["rightUpperLeg", "rightLowerLeg", [0, -1, 0]],
        ["rightLowerLeg", "rightFoot", [0, -1, 0]],
      ];
      try {
        var dir = new THREE.Vector3();
        var canonical = new THREE.Vector3();
        for (var i = 0; i < pairs.length; i++) {
          var name = pairs[i][0], childName = pairs[i][1];
          var child = rig[childName];
          if (!child) continue;
          dir.copy(child.position);
          if (dir.lengthSq() < 1e-10) continue;
          dir.normalize();
          canonical.fromArray(pairs[i][2]);
          var q = new THREE.Quaternion().setFromUnitVectors(dir, canonical);
          restCorr[name] = q;
          restDebug.push({
            bone: name,
            restDir: [+dir.x.toFixed(3), +dir.y.toFixed(3), +dir.z.toFixed(3)],
            canonical: pairs[i][2],
            q: [+q.x.toFixed(3), +q.y.toFixed(3), +q.z.toFixed(3), +q.w.toFixed(3)],
          });
        }
      } catch (error) { /* 没有 humanoid 就跳过 */ }
    }

    function setupLookAt() {
      var headBone = rig.head || (vrm.humanoid ? vrm.humanoid.getRawBoneNode("head") : null);
      lookTarget = new THREE.Object3D();
      lookTarget.name = "vrm-look-target";
      var headY = targetH * 0.82;
      try {
        if (headBone) {
          root.updateMatrixWorld(true);
          var wp = new THREE.Vector3();
          headBone.getWorldPosition(wp);
          headY = wp.y;
        }
      } catch (error) { /* ignore */ }
      look.headY = headY;
      lookTarget.position.set(0, headY, targetH * 0.62);
      root.add(lookTarget);
      if (vrm.lookAt) {
        vrm.lookAt.target = lookTarget;
        vrm.lookAt.autoUpdate = true;
      }
    }

    /* ---------- 外观风格钩子（可选模块 vrm-style） ---------- */
    /**
     * 外观风格钩子。兼容两种模块形态：
     *   ① require("vrm-style").apply(vrm, styleCfg)                —— 一行直调
     *   ② require("vrm-style").create(THREE, THREE_VRM) -> api      —— vrm-style 实际 API
     *      结构化配置桥接：{ preset|lookdev, tint, outline, spring } 或直接传函数
     * 模块不存在 / 版本不匹配时静默跳过（只 warn 一次），不阻塞角色加载。
     */
    function applyStyle(styleCfg) {
      if (!styleCfg) return null;
      try {
        var mod = require(STYLE_MODULE);
        if (mod && typeof mod.apply === "function") return mod.apply(vrm, styleCfg) || null;
        if (!styleApi) {
          if (!mod || typeof mod.create !== "function") throw new Error("模块没有 apply() / create()");
          styleApi = mod.create(THREE, THREE_VRM);
        }
        if (typeof styleApi.apply === "function") return styleApi.apply(vrm, styleCfg) || null;
        if (typeof styleCfg === "function") return styleCfg(vrm, styleApi) || null;
        var out = { ops: [] };
        var lookdev = styleCfg.lookdev != null ? styleCfg.lookdev : (styleCfg.look != null ? styleCfg.look : styleCfg.preset);
        if (lookdev != null && typeof styleApi.applyLookdev === "function") {
          out.lookdev = styleApi.applyLookdev(vrm, lookdev, styleCfg.lookOpts || styleCfg.opts || {});
          out.ops.push("lookdev");
        }
        if (styleCfg.tint && typeof styleApi.tintByMaterialName === "function") {
          var matchers = styleApi.TINT_MATCHERS || {};
          for (var tk in styleCfg.tint) {
            var matcher = matchers[tk] || (styleCfg.matchers && styleCfg.matchers[tk]);
            if (!matcher) continue;
            styleApi.tintByMaterialName(vrm, matcher, styleCfg.tint[tk], styleCfg.tintOpts && styleCfg.tintOpts[tk]);
            out.ops.push("tint:" + tk);
          }
        }
        if (styleCfg.outline && typeof styleApi.setOutline === "function") {
          out.outline = styleApi.setOutline(vrm, styleCfg.outline);
          out.ops.push("outline");
        }
        if (styleCfg.spring && typeof styleApi.setSpringStyle === "function") {
          out.spring = styleApi.setSpringStyle(vrm, styleCfg.spring);
          out.ops.push("spring");
        }
        return out;
      } catch (error) {
        if (!char._warnedStyle) {
          char._warnedStyle = true;
          if (typeof console !== "undefined") console.warn("[vrmchar] 风格模块 " + STYLE_MODULE + " 未就绪，已跳过", error);
        }
        return null;
      }
    }

    /* ---------- 挂载模型 ---------- */
    function attachModel(parsed) {
      if (disposed) {
        try { VRMUtils.deepDispose(parsed.scene); } catch (e) {}
        return;
      }
      vrm = parsed;
      mounted = true;
      killPlaceholder();
      var scene = vrm.scene;

      rot0 = !!(vrm.meta && vrm.meta.metaVersion === "0");
      var raw = measureObject(scene);
      var targetHeight = cfg.height || DEFAULT_HEIGHT;
      var scale = raw.height > 0.0001 ? targetHeight / raw.height : 1;

      scene.scale.setScalar(scale);
      // 脚底落在 y=0，水平方向保持模型自身原点（VRM 的标准是两脚中间）
      scene.position.set(0, -raw.minY * scale + (cfg.offsetY || 0), 0);
      if (cfg.turnY) scene.rotation.y += cfg.turnY;
      inner.add(scene);

      makeLights(o.light);
      setupMaterials();
      setupRenderer();
      setupRig();
      setupRestCorrection();
      setupExpressions();
      setupLookAt();

      // 外观风格（换色/挂角/Q版比例）要在量尺寸之前应用，取景才会连挂件一起算
      char.style = applyStyle(styleFor(skinOrUrl, buildCfg));

      // 先套一次基础站姿再量尺寸：VRM rest 是 T-pose，直接量会把张开的手臂算进去
      applyPose(1);
      // 预热 SpringBone：模型从 T-pose 切到 idle 会让头发/裙摆先甩一下。
      // 挂载时预模拟 ~0.7s，用户看到的第一帧就是稳定状态（截图也不用等）。
      try {
        vrm.update(0);
        for (var warm = 0; warm < 42; warm++) vrm.update(1 / 60);
      } catch (error) { /* 还没有表情/spring 也不影响 */ }

      // 用量"当前姿势"的包围盒（同时把蒙皮网格的 boundingBox 校正成站姿，
      // 这样宿主之后 Box3.setFromObject(char.root) 也能量对）
      var size = new THREE.Vector3();
      var box = null;
      try {
        var posed = measurePosed(root);
        box = posed.box;
        size.set(posed.width, posed.height, posed.depth);
      } catch (error) {
        // 兜底：绑定姿势包围盒
        box = new THREE.Box3().setFromObject(root);
        box.getSize(size);
      }
      char.height = size.y || targetHeight;
      // 脚底贴地修正：绑定姿势和 idle 站姿的包围盒可能差几毫米
      if (box && Math.abs(box.min.y) > 0.004) {
        var dy = -box.min.y;
        scene.position.y += dy;
        box.min.y += dy;
        box.max.y += dy;
        if (stage && stage.root) stage.root.updateMatrixWorld(true);
      }
      char.bbox = { minY: box.min.y, maxY: box.max.y, width: size.x, height: size.y, depth: size.z };

      // 取景：交给舞台按包围盒算相机距离
      var cam = cfg.camera || {};
      if (stage && stage.frame) {
        try {
          stage.frame({
            height: char.height,
            bboxW: size.x,
            bboxH: size.y,
            bboxMinY: box.min.y,
            bboxMaxY: box.max.y,
            margin: cam.margin == null ? 1.06 : cam.margin,
            distK: cam.distK || 1,
            elevation: cam.elevation == null ? 0.06 : cam.elevation,
            azimuth: cam.azimuth == null ? 0 : cam.azimuth,
            glowColor: cfg.glowColor,
          });
        } catch (error) {
          if (typeof console !== "undefined") console.warn("[vrmchar] stage.frame 失败", error);
        }
      }
      if (mountResolve) mountResolve(char);
      mountResolve = null;
      mountReject = null;
    }

    function onMountError(error) {
      char.loadError = error;
      if (typeof console !== "undefined") console.warn("[vrmchar] 模型加载失败: " + url, error);
      if (mountReject) mountReject(error);
      mountResolve = null;
      mountReject = null;
    }

    /** 异步路径：等预热完成 -> 接管已解析实例，或从缓存 ArrayBuffer 重新解析一份 */
    function mountAsync() {
      var entry = cache[url];
      var p = entry && entry.promise ? entry.promise : preload(url);
      p.then(function () {
        if (disposed) return;
        var e = cache[url];
        if (e && e.vrm && !e.claimed) {
          e.claimed = true;
          e.parsed++;
          attachModel(e.vrm);
          return;
        }
        if (!e || !e.arrayBuffer) throw new Error("[vrmchar] 缓存里没有模型数据: " + url);
        return parseVRM(e.arrayBuffer, url).then(function (parsed) {
          e.parsed++;
          attachModel(parsed);
        });
      }).catch(function (error) {
        if (disposed) return;
        onMountError(error);
      });
    }

    // 已预热：同步接管实例，宿主拿到 char 时模型已经挂好（没有闪烁 / 首帧延迟）
    var entry0 = cache[url];
    if (entry0 && entry0.state === "ready" && entry0.vrm && !entry0.claimed) {
      entry0.claimed = true;
      entry0.parsed++;
      attachModel(entry0.vrm);
    } else {
      mountAsync();
    }

    /* ---------- 每帧：姿势 ---------- */
    function statePose(name, t) {
      copyPose(poseTgt);
      var sway = Math.sin(t * 1.1) * 0.5 + Math.sin(t * 0.63) * 0.5;
      // 呼吸
      var breathe = Math.sin(t * 2.05);
      poseTgt.spine[0] += breathe * 0.02;
      poseTgt.chest[0] += Math.sin(t * 2.05 + 0.35) * 0.022;
      poseTgt.upperChest[0] += Math.sin(t * 2.05 + 0.7) * 0.014;
      poseTgt.head[0] += Math.sin(t * 1.7) * 0.012;
      poseTgt.head[2] += Math.sin(t * 0.9) * 0.018;
      poseTgt.hips[1] += sway * 0.022;
      // 视线跟随（鼠标输入）
      poseTgt.head[1] += look.x * 0.3;
      poseTgt.head[0] += look.y * 0.14;
      poseTgt.neck[1] += look.x * 0.08;
      poseTgt.neck[0] += look.y * 0.05;
      poseTgt.chest[1] += look.x * 0.04;

      if (name === "happy") {
        // 双手举起来欢呼（手臂向上外张 ~55°，手腕跟着轻轻摆）
        var hop = Math.abs(Math.sin(t * 4.6));
        poseTgt.leftUpperArm = [-0.2, 0.15, 0.6 + hop * 0.08];
        poseTgt.rightUpperArm = [-0.2, -0.15, -0.6 - hop * 0.08];
        poseTgt.leftLowerArm = [0, -0.4, 0.15];
        poseTgt.rightLowerArm = [0, 0.4, -0.15];
        poseTgt.head[0] -= 0.08;
        poseTgt.head[2] += 0.05;
        poseTgt.upperChest[0] -= 0.02;
        poseTgt.leftHand[2] += Math.sin(t * 6.2) * 0.2;
        poseTgt.rightHand[2] -= Math.sin(t * 6.2) * 0.2;
      } else if (name === "talk") {
        // 右手在身前比划，左手自然下垂
        poseTgt.rightUpperArm = [-0.45 + Math.sin(t * 1.9) * 0.08, -0.1, 0.95 + Math.sin(t * 1.7) * 0.06];
        poseTgt.rightLowerArm = [0, 1.15 + Math.sin(t * 2.3) * 0.14, 0];
        poseTgt.rightHand[2] -= 0.12;
        poseTgt.leftUpperArm = [-0.08, 0.1, -1.22];
        poseTgt.leftLowerArm = [0, -0.5, 0];
        poseTgt.head[0] += Math.sin(t * 5.2) * 0.035;
        poseTgt.head[1] += Math.sin(t * 2.4) * 0.03;
        poseTgt.head[2] += Math.sin(t * 3.1) * 0.02;
      } else if (name === "sleep") {
        // 大头 Q 版模型低头多了会显得脸埋下去，允许按模型缩放
        var sleepK = cfg.sleepTilt == null ? 1 : cfg.sleepTilt;
        poseTgt.head[0] += 0.38 * sleepK;
        poseTgt.head[2] += 0.18 * sleepK;
        poseTgt.neck[0] += 0.14 * sleepK;
        poseTgt.spine[0] += 0.04;
        poseTgt.hips[1] += Math.sin(t * 0.55) * 0.03;
        poseTgt.leftUpperArm = [-0.18, 0.15, -1.18];
        poseTgt.rightUpperArm = [-0.18, -0.15, 1.18];
        poseTgt.leftLowerArm = [0, -0.45, 0];
        poseTgt.rightLowerArm = [0, 0.45, 0];
        poseTgt.chest[0] += Math.sin(t * 1.15) * 0.022;
      } else if (name === "shy") {
        // 双手抬到脸边（捂脸状），低头 + 歪头
        poseTgt.head[0] += 0.26;
        poseTgt.head[2] -= 0.12;
        poseTgt.head[1] -= 0.08;
        poseTgt.leftUpperArm = [-0.35, 0.1, -1.25];
        poseTgt.rightUpperArm = [-0.35, -0.1, 1.25];
        poseTgt.leftLowerArm = [0, -1.6, 0];
        poseTgt.rightLowerArm = [0, 1.6, 0];
        poseTgt.leftHand[2] -= Math.sin(t * 3.4) * 0.12;
        poseTgt.rightHand[2] += Math.sin(t * 3.4) * 0.12;
        poseTgt.hips[1] += Math.sin(t * 1.7) * 0.03;
      } else if (name === "stretch") {
        var st = Math.sin(t * 1.6) * 0.06;
        poseTgt.leftUpperArm = [-0.1, 0.02, 1.15 + st];
        poseTgt.rightUpperArm = [-0.1, -0.02, -1.15 - st];
        poseTgt.leftLowerArm = [0, 0.06, 0.12];
        poseTgt.rightLowerArm = [0, -0.06, -0.12];
        poseTgt.head[0] -= 0.2;
        poseTgt.spine[0] -= 0.05;
        poseTgt.chest[0] -= 0.03;
        poseTgt.hips[1] += Math.sin(t * 1.6) * 0.02;
      } else if (name === "wink") {
        // 右手抬起在脸侧比个剪刀手（眨眼交给表情）
        poseTgt.head[2] += 0.1;
        poseTgt.head[1] += 0.06;
        poseTgt.rightUpperArm = [-0.75, -0.1, 0.55];
        poseTgt.rightLowerArm = [0, 1.9, 0];
        poseTgt.rightHand[2] -= 0.12;
        poseTgt.leftUpperArm = [-0.08, 0.1, -1.22];
        poseTgt.leftLowerArm = [0, -0.45, 0];
      } else if (name === "eat") {
        // 右手举到嘴边，随着咀嚼节奏上下小动
        var bite = Math.abs(Math.sin(t * 3.4));
        poseTgt.rightUpperArm = [-0.6, -0.1, 0.85 - bite * 0.06];
        poseTgt.rightLowerArm = [0, 1.75 + bite * 0.08, 0];
        poseTgt.rightHand[2] -= 0.15;
        poseTgt.head[0] += 0.06 + bite * 0.04;
        poseTgt.leftUpperArm = [-0.1, 0.12, -1.2];
        poseTgt.leftLowerArm = [0, -0.45, 0];
      }

      // 摸头：整个身体轻微"压扁-弹回"
      if (patT > 0) {
        poseTgt.head[0] += Math.sin(patT * PI) * 0.06;
        poseTgt.leftUpperArm[2] += Math.sin(patT * PI) * 0.12;
        poseTgt.rightUpperArm[2] -= Math.sin(patT * PI) * 0.12;
      }
    }

    var POSE_ADJUST = cfg.poseAdjust || {};
    function applyPose(dt) {
      var k = Math.min(1, dt * 12);
      for (var i = 0; i < POSE_KEYS.length; i++) {
        var name = POSE_KEYS[i];
        var node = rig[name];
        if (!node) continue;
        var c = poseCur[name], g = poseTgt[name];
        c[0] += (g[0] - c[0]) * k;
        c[1] += (g[1] - c[1]) * k;
        c[2] += (g[2] - c[2]) * k;
        // 每个模型可选的额外姿势偏移（VRM1 的手臂轴向与 VRM0 相反，需要补正）
        var adj = POSE_ADJUST[name];
        var rx = c[0] + (adj ? (adj[0] || 0) : 0);
        var ry = c[1] + (adj ? (adj[1] || 0) : 0);
        var rz = c[2] + (adj ? (adj[2] || 0) : 0);
        // VRM1（未做 yaw 补偿）的归一化骨骼手臂 z 轴与 VRM0 相反，翻转手臂类骨骼的 z
        if (!rot0 && (name === "leftUpperArm" || name === "rightUpperArm" || name === "leftLowerArm" || name === "rightLowerArm" || name === "leftHand" || name === "rightHand" || name === "leftShoulder" || name === "rightShoulder")) {
          rz = -rz;
        }
        if (rot0) {
          // VRM0：把世界坐标系的姿势转到归一化 rig 的旋转前坐标系
          tmpQuat.setFromEuler(tmpEuler.set(rx, ry, rz));
          node.quaternion.copy(YAW_PI_INV).multiply(tmpQuat).multiply(YAW_PI);
        } else {
          node.rotation.set(rx, ry, rz);
        }
        if (restCorr[name]) {
          // 模型 rest 不在 T-pose（如 A-pose 模型）时，先套一层朝向校正
          node.quaternion.multiply(restCorr[name]);
        }
      }
      // 调试覆盖：手动摆骨骼（不进平滑，便于定位轴向）
      for (var boneName in boneOverride) {
        var bn = rig[boneName];
        if (!bn) continue;
        var bo = boneOverride[boneName];
        if (rot0) {
          tmpQuat.setFromEuler(tmpEuler.set(bo[0], bo[1], bo[2]));
          bn.quaternion.copy(YAW_PI_INV).multiply(tmpQuat).multiply(YAW_PI);
        } else {
          bn.rotation.set(bo[0], bo[1], bo[2]);
        }
      }
    }

    /* ---------- 每帧：表情 ---------- */
    function stateExpr(name, dt) {
      var relaxK = (cfg.relaxedFactor == null) ? 1 : cfg.relaxedFactor;
      for (var n in exprTgt) exprTgt[n] = 0;
      var mouth = 0;
      var blink = 0;
      var blinkLeft = 0;
      var blinkRight = 0;

      if (name === "happy") {
        exprTgt.happy = 0.9;
        exprTgt.relaxed = 0.15 * relaxK;
        exprTgt.blink = 0.18;
      } else if (name === "talk") {
        exprTgt.happy = 0.3;
        exprTgt.relaxed = 0.2 * relaxK;
        mouthT += dt;
        var m = Math.sin(mouthT * 9.5);
        mouth = m > 0 ? 0.25 + m * 0.45 : 0.08;
      } else if (name === "sleep") {
        blink = 1;
        exprTgt.relaxed = 0.1 * relaxK;
      } else if (name === "shy") {
        exprTgt.happy = 0.5;
        blink = 0.45;
        exprTgt.blinkLeft = 0.18;
      } else if (name === "wink") {
        exprTgt.happy = 0.55;
        blinkLeft = 1;
      } else if (name === "stretch") {
        exprTgt.happy = 0.5;
        blink = 0.5;
        exprTgt.relaxed = 0.2 * relaxK;
      } else if (name === "eat") {
        exprTgt.happy = 0.35;
        mouthT += dt;
        mouth = 0.18 + Math.abs(Math.sin(mouthT * 5.2)) * 0.55;
      } else {
        // idle / 未知状态
        exprTgt.relaxed = (cfg.idleRelaxed == null ? 0.22 : cfg.idleRelaxed) * relaxK;
      }

      // 自动眨眼（sleep / wink 时让位给状态表情）
      if (name !== "sleep" && name !== "wink") {
        blinkAt -= dt;
        if (blinkAt <= 0) { blinkAt = 2.1 + Math.random() * 3.4; blinkT = 0.14; }
        if (blinkT > 0) {
          blinkT -= dt;
          var phase = blinkT > 0.07 ? (0.14 - blinkT) / 0.07 : blinkT / 0.07;
          blink = Math.max(blink, Math.min(1, phase));
        }
      }

      if (exprMap.blink) exprTgt.blink = Math.max(exprTgt.blink, blink);
      if (exprMap.blinkLeft) exprTgt.blinkLeft = Math.max(exprTgt.blinkLeft, blinkLeft);
      if (exprMap.blinkRight) exprTgt.blinkRight = Math.max(exprTgt.blinkRight, blinkRight);
      if (exprMap.aa) {
        exprTgt.aa = mouth ? mouth : exprTgt.aa;
        if (exprMap.oh) exprTgt.oh = mouth * 0.25;
      }
    }

    function applyExpressions(dt) {
      var mgr = vrm && vrm.expressionManager;
      if (!mgr) return;
      var k = Math.min(1, dt * 14);
      for (var preset in exprMap) {
        var real = exprMap[preset];
        if (!real) continue;
        var target = exprTgt[preset] || 0;
        exprCur[preset] = (exprCur[preset] || 0) + (target - (exprCur[preset] || 0)) * k;
        try { mgr.setValue(real, exprCur[preset]); } catch (error) { /* ignore */ }
      }
      // 调试覆盖：直接按真实表情名设置权重
      for (var rawName in exprOverride) {
        try { mgr.setValue(rawName, exprOverride[rawName]); } catch (error) { /* ignore */ }
      }
    }

    /* ---------- 对外：状态控制 ---------- */
    var STATES = { idle: 1, happy: 1, talk: 1, sleep: 1, shy: 1, stretch: 1, wink: 1, eat: 1 };

    function setState(name) {
      if (!STATES[name]) name = "idle";
      if (state === name) { stateT = 0; return; }
      state = name;
      stateT = 0;
      mouthT = 0;
    }

    function setLook(x, y) {
      look.tx = clamp(x, -1, 1);
      look.ty = clamp(y, -1, 1);
    }

    function pat() {
      patT = 1;
      setState("happy");
      if (patTimer) clearTimeout(patTimer);
      patTimer = setTimeout(function () {
        patTimer = null;
        if (state === "happy") setState("idle");
      }, 1700);
    }
    var patTimer = null;

    function updateLookTarget() {
      if (!lookTarget) return;
      var h = look.headY || targetH * 0.82;
      lookTarget.position.set(look.x * targetH * 0.28, h - look.y * targetH * 0.22, targetH * 0.62);
      lookTarget.updateMatrixWorld(true);
    }

    function update(dt, t) {
      if (disposed) return;
      dt = Math.min(0.1, Math.max(0, dt || 0));
      tAcc += dt;
      stateT += dt;
      var tt = t == null ? tAcc : t;

      // 视线输入平滑
      var k = Math.min(1, dt * 8);
      look.x += (look.tx - look.x) * k;
      look.y += (look.ty - look.y) * k;

      if (patT > 0) patT = Math.max(0, patT - dt * 2.2);

      if (mounted) {
        updateLookTarget();
        statePose(state, tt);
        applyPose(dt);
        stateExpr(state, dt);
        applyExpressions(dt);
        // 这一步会做：normalized -> raw 骨骼同步、lookAt、表情、约束、SpringBone
        try { vrm.update(dt); } catch (error) {
          if (!char._warnedUpdate) { char._warnedUpdate = true; console.warn("[vrmchar] vrm.update 失败", error); }
        }
      }

      // 摸头回弹 + 状态整体轻微起伏（放在 root 上，不影响 vrm 内部矩阵）
      if (patT > 0) {
        var sq = Math.sin(patT * PI) * 0.035;
        root.scale.set(1 + sq * 0.6, 1 - sq, 1 + sq * 0.6);
      } else if (root.scale.x !== 1) {
        root.scale.set(1, 1, 1);
      }
      if (mounted && state === "happy") {
        root.position.y = Math.abs(Math.sin(tt * 4.6)) * char.height * 0.012;
      } else if (root.position.y !== 0) {
        root.position.y = 0;
      }
      // 浮动/游动感：轻微上下呼吸 + 左右摇摆（鲸鲸这类"漂浮"角色用）
      var floatY = cfg.floatY || 0;
      var swayZ = cfg.swayZ || 0;
      if (mounted && (floatY || swayZ)) {
        var bob = Math.sin(tt * 1.35) * char.height * floatY;
        var sway = Math.sin(tt * 0.72 + 0.6) * swayZ;
        if (state !== "happy") root.position.y = bob;
        root.rotation.z = sway;
        root.rotation.y = sway * 0.6;
      }
    }

    /* ---------- 释放 ---------- */
    function dispose() {
      if (disposed) return;
      disposed = true;
      if (patTimer) { clearTimeout(patTimer); patTimer = null; }
      if (rendererPrev && stage && stage.renderer) {
        try {
          stage.renderer.toneMapping = rendererPrev.toneMapping;
          stage.renderer.toneMappingExposure = rendererPrev.exposure;
          stage.renderer.outputColorSpace = rendererPrev.colorSpace;
        } catch (error) { /* ignore */ }
        rendererPrev = null;
      }
      if (vrm) {
        try { VRMUtils.deepDispose(vrm.scene); } catch (error) { /* ignore */ }
        // 材质数组里可能还有我们补的描边壳（deepDispose 会遍历到，但保险起见再清一次）
        vrm = null;
      }
      if (lookTarget) {
        try { root.remove(lookTarget); } catch (e) {}
        lookTarget = null;
      }
      try { killPlaceholder(); } catch (e) {}
      try { root.clear ? root.clear() : null; } catch (e) {}
      rig = {};
      exprMap = Object.create(null);
    }

    char.setState = setState;
    char.setLook = setLook;
    char.pat = pat;
    /** 口型（TTS 唇形同步）：A/I/U/E/O -> VRM aa/ih/ou/ee/oh */
    // 注意：applyExpressions 每帧会把 aa/ih/ou/ee/oh 的 exprTgt 写回 manager，
    // 所以口型必须走 exprTgt（直接 mgr.setValue 会被下一帧清零）。
    char.talkMouth = function (vowel, weight) {
      try {
        var key = { A: "aa", I: "ih", U: "ou", E: "ee", O: "oh" }[String(vowel || "A").toUpperCase()] || "aa";
        var w = Math.max(0, Math.min(1, Number(weight == null ? 0.45 : weight)));
        ["aa", "ih", "ou", "ee", "oh"].forEach(function (k) {
          if (exprTgt[k] != null) exprTgt[k] = 0;
        });
        if (exprTgt[key] != null) { exprTgt[key] = w; exprCur[key] = w; }
        return true;
      } catch (e) { return false; }
    };
    char.closeMouth = function () {
      try {
        ["aa", "ih", "ou", "ee", "oh"].forEach(function (k) {
          if (exprTgt[k] != null) exprTgt[k] = 0;
          if (exprCur[k] != null) exprCur[k] = 0;
        });
        return true;
      } catch (e) { return false; }
    };
    char.update = update;
    char.dispose = dispose;
    char.stateName = function () { return state; };
    /** 调试：动态调灯（强度/方向/颜色） */
    char.setLight = function (lc) { applyLight(lc); return char; };
    char.getVRM = function () { return vrm; };
    /** 调试：直接给某个表情设置权重（每帧生效，优先级高于状态表情） */
    char.debugExpression = function (name, value) {
      if (!name) return;
      if (value == null) delete exprOverride[name];
      else exprOverride[name] = value;
    };
    /** 调试：手动摆某根归一化骨骼（欧拉角，弧度）；传 null 清除 */
    char.debugBone = function (name, x, y, z) {
      if (!name) return;
      if (x == null) delete boneOverride[name];
      else boneOverride[name] = [x, y || 0, z || 0];
    };
    char.debugRest = function () { return restDebug; };
    char.debugReset = function () {
      exprOverride = Object.create(null);
      boneOverride = Object.create(null);
    };
    char.boneNames = function () {
      var out = [];
      for (var n in rig) if (rig[n]) out.push(n);
      return out;
    };

    char.info = function () {
      if (!vrm) return { mounted: false, error: char.loadError ? String(char.loadError.message || char.loadError) : null };
      var bones = 0, meshes = 0, mats = [], expressions = [];
      try {
        vrm.scene.traverse(function (obj) {
          if (obj.isMesh) {
            meshes++;
            var ms = Array.isArray(obj.material) ? obj.material : [obj.material];
            for (var i = 0; i < ms.length; i++) if (ms[i] && mats.indexOf(ms[i]) < 0) mats.push(ms[i]);
          }
          if (obj.isBone) bones++;
        });
      } catch (error) { /* ignore */ }
      try {
        var mgr = vrm.expressionManager;
        if (mgr) for (var name in exprMap) if (exprMap[name]) expressions.push(name + "->" + exprMap[name]);
      } catch (error) { /* ignore */ }
      return {
        mounted: true,
        height: +char.height.toFixed(3),
        bbox: char.bbox,
        meshes: meshes,
        bones: bones,
        materials: mats.length,
        mtoon: mats.filter(function (m) { return m.isMToonMaterial; }).length,
        outlines: mats.filter(function (m) { return m.isMToonMaterial && m.isOutline; }).length,
        expressions: expressions,
        springBones: vrm.springBoneManager ? vrm.springBoneManager.joints ? vrm.springBoneManager.joints.size : "?" : 0,
        metaVersion: vrm.meta ? vrm.meta.metaVersion : null,
        name: vrm.meta ? vrm.meta.name : null,
        state: state,
      };
    };

    return char;
  }

  /* ============================ 对外 API ============================ */
  var api = {
    version: "1.0.0",
    models: MODELS,
    addModel: addModel,
    setModels: setModels,
    addStyle: addStyle,
    setStyles: setStyles,
    listStyles: function () { return Object.keys(STYLES); },
    listModels: function () { return Object.keys(MODELS); },
    preload: preload,
    preloadSkin: function (id, opts) { return preload(id, opts); },
    preloadAll: function () {
      var list = [], ids = Object.keys(MODELS);
      for (var i = 0; i < ids.length; i++) list.push(preload(ids[i]).catch(function () {}));
      return Promise.all(list);
    },
    ready: ready,
    modelInfo: modelInfo,
    build: build,
    /** 生成 registry 片段：{ skinId: { meta, build } }，方便直接并进 registry.map */
    makeVariants: function (extra) {
      var out = {};
      var ids = Object.keys(MODELS);
      for (var i = 0; i < ids.length; i++) {
        (function (id) {
          var cfg = MODELS[id];
          out[id] = {
            meta: {
              id: id,
              label: cfg.label || id,
              height: cfg.height || DEFAULT_HEIGHT,
              camera: cfg.camera || {},
            },
            build: function () { return build(id, extra); },
          };
        })(ids[i]);
      }
      return out;
    },
    /** 释放所有缓存（ArrayBuffer / 预热 VRM 实例） */
    dispose: function () {
      for (var url in cache) {
        var e = cache[url];
        if (e && e.vrm) {
          try { VRMUtils.deepDispose(e.vrm.scene); } catch (error) { /* ignore */ }
        }
        e.vrm = null;
        e.arrayBuffer = null;
        e.promise = null;
        e.state = "idle";
      }
    },
    info: function () {
      var out = {};
      for (var url in cache) out[url] = modelInfo(url);
      return out;
    },
  };

  return api;
};
