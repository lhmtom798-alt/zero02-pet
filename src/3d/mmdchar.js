/**
 * mmdchar —— MMD（PMX）模型角色适配层：真·骨骼动画 + 程序化头发/裙摆物理。
 *
 * 模型来源说明：模之屋公开预览 payload 里的骨骼 parentIndex 是乱序的（position 是对的），
 * 所以先用 tools/mmd-fix-skeleton.py 重建骨骼树并重打包 PMX（坐标转成相对父骨骼偏移），
 * 之后就能像正常 MMD 模型一样做骨骼动画了。
 *
 * 对外契约与 chars/* 一致：
 *   { root, height, camera, update(dt,t), setState(name), setLook(x,y), pat(), dispose() }
 *
 * 骨骼名（MMD 日文命名）：
 *   頭 / 首 / 上半身 / 上半身2 / 下半身 / 左腕 / 右腕 / 左ひじ / 右ひじ / 左足 ... 
 *   头发：cf_J_hair*，裙摆：スカート_r_c
 */
module.exports.create = function (o) {
  o = o || {};
  var THREE = o.THREE || window.THREE;
  var stage = o.stage || null;
  var MODELS = {};
  var cache = Object.create(null);
  var DEFAULT_HEIGHT = 5.0;

  if (!THREE) throw new Error("[mmdchar] 缺少 THREE");

  function defaults() {
    return {
      url: "",
      textureBase: "",
      label: "",
      height: DEFAULT_HEIGHT,
      glowColor: 0xff8fb0,
      headScale: 0,
      armAngle: 72,
      camera: { margin: 1.04, elevation: 0.05 },
    };
  }
  function mergeCfg(base, extra) {
    var out = {}, k;
    for (k in base) out[k] = base[k];
    if (extra) for (k in extra) if (extra[k] !== undefined) out[k] = extra[k];
    if (base.camera && extra && extra.camera) {
      var c = {}, ck;
      for (ck in base.camera) c[ck] = base.camera[ck];
      for (ck in extra.camera) c[ck] = extra.camera[ck];
      out.camera = c;
    }
    return out;
  }
  function addModel(id, cfg) {
    if (id && cfg) MODELS[id] = mergeCfg(defaults(), cfg);
    return api;
  }
  function modelCfg(idOrUrl) {
    return MODELS[idOrUrl] || mergeCfg(defaults(), { url: String(idOrUrl || "") });
  }
  if (o.models) for (var id0 in o.models) addModel(id0, o.models[id0]);

  /* ------------------------------ 加载 ------------------------------ */
  function preload(idOrUrl) {
    var cfg = modelCfg(idOrUrl);
    var url = cfg.url;
    if (!url) return Promise.reject(new Error("[mmdchar] 空模型 URL"));
    var entry = cache[url];
    if (entry && entry.promise) return entry.promise;
    entry = cache[url] = { url: url };
    var loader = new THREE_VRM.MMDLoader();
    if (cfg.textureBase) {
      if (typeof loader.setResourcePath === "function") loader.setResourcePath(cfg.textureBase);
      else loader.setTexturePath(cfg.textureBase);
    }
    entry.promise = new Promise(function (resolve, reject) {
      loader.load(url, function (mesh) { entry.mesh = mesh; resolve(mesh); }, function () {}, reject);
    });
    entry.promise.catch(function () { delete cache[url]; });
    return entry.promise;
  }

  /* ------------------------------ 弹簧 ------------------------------ */
  function spring(k, d) {
    var s = { v: 0, x: 0 };
    s.step = function (target, dt, drive) {
      var a = (target - s.x) * k - s.v * d + (drive || 0);
      s.v += a * dt;
      s.x += s.v * dt;
      return s.x;
    };
    return s;
  }

  /* --------------------------- 小工具（无分配） --------------------------- */
  function clampNum(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function smoothstep(a, b, x) {
    var t = (x - a) / (b - a);
    if (t < 0) t = 0; else if (t > 1) t = 1;
    return t * t * (3 - 2 * t);
  }
  // 平滑的单峰包络：u 在 c±w 区间里 0→1→0（用来做"舔一下"这种脉冲）
  function bumpAt(u, c, w) {
    var t = (u - c) / w;
    if (t <= -1 || t >= 1) return 0;
    var c2 = Math.cos(t * Math.PI * 0.5);
    return c2 * c2;
  }


  /* ---------------------------- 手臂烘焙 ---------------------------- */
  // MMD 的衣袖有一部分权重挂在肩/上身骨上，单靠骨骼旋转会拉出三角形"翅膀"。
  // 这里直接把手臂用蒙皮权重烘进顶点（连 56 个表情 morph 一起烘），
  // 骨架保留给头/上身/头发/裙摆做动画。
  function bakeArms(mesh, angleDeg) {
    var geo = mesh.geometry;
    var pos = geo.attributes.position, si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight;
    if (!si || !sw || !mesh.skeleton) return { moved: 0 };
    mesh.updateMatrixWorld(true);
    var bones = mesh.skeleton.bones;
    var boneMap = {};
    bones.forEach(function (b) { boneMap[b.name] = b; });
    function boneWorld(name) {
      var b = boneMap[name];
      return b ? new THREE.Matrix4().copy(b.matrixWorld) : null;
    }
    var wL = boneWorld("左肩"), wR = boneWorld("右肩");
    if (!wL || !wR) return { moved: 0 };
    var pL = new THREE.Vector3().setFromMatrixPosition(wL);
    var pR = new THREE.Vector3().setFromMatrixPosition(wR);
    var mw = mesh.matrixWorld.clone();
    var mwInv = new THREE.Matrix4().copy(mw).invert();
    function rotAbout(p, ang) {
      return new THREE.Matrix4().makeTranslation(p.x, p.y, p.z)
        .multiply(new THREE.Matrix4().makeRotationZ(ang))
        .multiply(new THREE.Matrix4().makeTranslation(-p.x, -p.y, -p.z));
    }
    var ang = angleDeg * Math.PI / 180;
    var L = rotAbout(pL, ang), R = rotAbout(pR, -ang);
    var armL = /^左(肩|腕|ひじ|手首|手先|親指|小指|薬指|中指|人指|人差指|ひじ補助|ダミー)/;
    var armR = /^右(肩|腕|ひじ|手首|手先|親指|小指|薬指|中指|人指|人差指|ひじ補助|ダミー)/;
    var n = pos.count, xf = new Array(n);
    for (var i = 0; i < n; i++) {
      var items = [], total = 0;
      for (var k = 0; k < 4; k++) {
        var bi = si.getComponent(i, k), w = sw.getComponent(i, k);
        if (!w) continue;
        total += w;
        var nm = bones[bi] ? bones[bi].name : "";
        items.push([armL.test(nm) ? L : (armR.test(nm) ? R : null), w]);
      }
      xf[i] = total > 0.0001 ? { items: items, total: total } : null;
    }
    var v = new THREE.Vector3(), wv = new THREE.Vector3(), acc = new THREE.Vector3(), t = new THREE.Vector3();
    function bakeVert(attr, i) {
      var rec = xf[i];
      if (!rec) return;
      v.fromBufferAttribute(attr, i);
      wv.copy(v).applyMatrix4(mw);
      acc.set(0, 0, 0);
      for (var j = 0; j < rec.items.length; j++) {
        t.copy(wv);
        if (rec.items[j][0]) t.applyMatrix4(rec.items[j][0]);
        acc.addScaledVector(t, rec.items[j][1]);
      }
      acc.divideScalar(rec.total).applyMatrix4(mwInv);
      attr.setXYZ(i, acc.x, acc.y, acc.z);
    }
    var moved = 0;
    for (var i2 = 0; i2 < n; i2++) bakeVert(pos, i2);
    pos.needsUpdate = true;
    var morphs = geo.morphAttributes && geo.morphAttributes.position;
    if (morphs) {
      for (var mi = 0; mi < morphs.length; mi++) {
        var attr = morphs[mi];
        if (!attr || attr.count !== n) continue;
        for (var mj = 0; mj < n; mj++) bakeVert(attr, mj);
        attr.needsUpdate = true;
      }
    }
    geo.computeVertexNormals();
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    return { moved: moved, morphs: morphs ? morphs.length : 0 };
  }

  /* ------------------------------ 角色实例 ------------------------------ */
  var EXPR = {
    blink: "まばたき", smile: "笑い", winkR: "ウィンク右", wink: "ウィンク",
    shy: "照れ", surprise: "びっくり", calm: "なごみ", sad: "困る",
    mouthA: "あ", mouthI: "い", mouthU: "う", mouthE: "え", mouthO: "お",
    heartEyes: "はぁと", horns: "horns +", blush: "照れ",
    tongue: "ぺろっ", tease: "にやり", jito: "じと目", nicon: "にこり",
  };

  function build(idOrUrl) {
    var cfg = modelCfg(idOrUrl);
    var url = cfg.url;
    var targetH = cfg.height || DEFAULT_HEIGHT;
    var root = new THREE.Group();
    root.name = "mmd-char";
    var inner = new THREE.Group();
    root.add(inner);

    var char = {
      type: "mmd", root: root, height: targetH, camera: cfg.camera,
      mountPromise: null, isMounted: function () { return mounted; },
    };
    var mounted = false, mesh = null, baseScale = 1, baseY = 0;
    char._cfg = cfg;
    var SHADE = null;
    try {
      var shadeMod = __req("mmd-shade");
      if (shadeMod && shadeMod.create) SHADE = shadeMod.create(THREE);
    } catch (e) { console.warn("[mmdchar] mmd-shade 未就绪", e); }
    var bones = {}, boneList = [];
    var hairBones = [], skirtBones = [];
    var exprTgt = {}, exprCur = {};
    var state = "idle", stateT = 0, tAcc = 0;
    var look = { x: 0, y: 0, tx: 0, ty: 0 };
    var lookStill = 0;                       // 鼠标静止了多久（秒）
    var mouthT = 0;
    var lamps = null;

    /* --------------------- 待机微动作状态（每帧计算量很小） --------------------- */
    // 眨眼：kind 0=普通 1=连眨两次 2=慢眨
    var blink = { at: 1.7 + Math.random() * 2.6, t: 0, dur: 0.14, kind: 0 };
    // 头部跟随鼠标的二阶弹簧（带延迟、不抖动）
    var gaze = { yaw: spring(34, 12), pitch: spring(34, 12) };
    // 待机环视 / 偷看：缓慢随机的小幅转头，偶尔瞥一眼鼠标再转开
    var drift = {
      yawT: 0, pitchT: 0, rollT: 0, yaw: 0, pitch: 0, roll: 0, side: Math.random() < 0.5 ? 1 : -1,
      at: 1.2, peekT: 0, peekAt: 5.5 + Math.random() * 3.5,
    };
    // 眼球微扫视（让眼神不呆）
    var sacc = { x: 0, y: 0, tx: 0, ty: 0, at: 0.6 };
    // 被摸跳跃：蓄力 → 起跳 → 阻尼弹簧落地回弹
    var hop = { phase: 0, t: 0, y: 0, vy: 0, v: 0 };
    // 姿势切换时的柔和小下沉（避免瞬间切换的生硬感）
    var settle = { x: 0, v: 0 };
    var headPrev = { y: 0, x: 0 }, headVel = { y: 0, x: 0 }, headReady = false;
    // 撩头发的小动作
    var tuck = { at: 26 + Math.random() * 28, t: 0, dur: 2.0 };
    // 棒棒糖小演出：20~40 秒在 idle 时随机演一次
    var CANDY_DUR = 3.2;                  // 一次演出时长（抬手→送到嘴边→舔两下→放下）
    var candyT = 0, candyDur = CANDY_DUR, candyNext = 20 + Math.random() * 20;
    var _ui = { busy: false, t: 0 };

    function B(name) { return bones[name] || null; }

    /* ---------- 02 的棒棒糖（2D 立绘里的标志性道具） ---------- */
    // 尺寸要按"模型单位"来：模型高约 19.7，头高约 2.5。
    // 球半径 0.12、棒长 0.46 在正常站姿的取景里刚好能看清（演出时整体再放大 1.6~2.2 倍）。
    function makeCandy() {
      var g = new THREE.Group();
      g.name = "z02-candy";
      // 糖球
      var ball = new THREE.Mesh(
        new THREE.SphereGeometry(0.12, 20, 14),
        new THREE.MeshToonMaterial({ color: 0x3fd8c8 })
      );
      ball.position.y = 0.48;
      // 糖纸高光（小一圈的浅色球，伪造动画高光）
      var shine = new THREE.Mesh(
        new THREE.SphereGeometry(0.042, 10, 8),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 })
      );
      shine.position.set(-0.042, 0.52, 0.072);
      // 棒
      var stick = new THREE.Mesh(
        new THREE.CylinderGeometry(0.028, 0.022, 0.46, 8),
        new THREE.MeshToonMaterial({ color: 0xf2eadf })
      );
      stick.position.y = 0.23;
      g.add(ball, shine, stick);
      g.userData.shine = shine;
      g.userData.ball = ball;
      return g;
    }

    function attachCandy() {
      var hand = B("左手首") || B("左手先");
      if (!hand) return null;
      try {
        var candy = makeCandy();
        candy.scale.setScalar(1.0);        // 骨骼空间是模型单位（模型高 ~19.7）
        candy.position.set(0, 0, 0); // 掌心里
        candy.rotation.set(0.2, 0, 0.25);
        hand.add(candy);
        return candy;
      } catch (e) { return null; }
    }
    var _restQuat = Object.create(null);
    var _tmpQuat = new THREE.Quaternion();
    var _tmpEuler = new THREE.Euler();
    function restOf(b) {
      if (!_restQuat[b.name]) _restQuat[b.name] = b.quaternion.clone();
      return _restQuat[b.name];
    }
    // MMDLoader 会把模型转成 three 的坐标系，骨骼 rest 四元数不是单位阵；
    // 所以姿势要按 rest * delta 叠加，不能直接 rotation.set（会丢掉 rest 朝向）。
    function setRot(name, x, y, z) {
      var b = bones[name];
      if (!b) return;
      _tmpEuler.set(x || 0, y || 0, z || 0);
      _tmpQuat.setFromEuler(_tmpEuler);
      b.quaternion.copy(restOf(b)).multiply(_tmpQuat);
    }

    // 嘴在世界里的位置（棒棒糖要"送到嘴边"）：从「あ」口型 morph 的位移重心反推，
    // 再换算到「頭」骨骼的局部坐标缓存起来（之后每帧只要乘一次头骨矩阵）。
    function cacheMouthLocal() {
      var fallback = new THREE.Vector3(0, -0.06, 0.68);
      try {
        if (!mesh || !mesh.morphTargetDictionary) return fallback;
        var dict = mesh.morphTargetDictionary;
        var idx = dict["あ"] != null ? dict["あ"] : dict["ぺろっ"];
        var mAttr = mesh.geometry.morphAttributes;
        if (idx == null || !mAttr || !mAttr.position) return fallback;
        var a = mAttr.position[idx], p = mesh.geometry.attributes.position;
        var n = p.count, i, maxd = 0, sx = 0, sy = 0, sz = 0, hits = 0;
        if (!_morphDist || _morphDist.length !== n) _morphDist = new Float32Array(n);
        for (i = 0; i < n; i++) {
          var dx = a.getX(i) - p.getX(i), dy = a.getY(i) - p.getY(i), dz = a.getZ(i) - p.getZ(i);
          var dd = dx * dx + dy * dy + dz * dz;
          _morphDist[i] = dd;
          if (dd > maxd) maxd = dd;
        }
        if (!(maxd > 1e-6)) return fallback;
        var thr = maxd * 0.12;
        for (i = 0; i < n; i++) {
          if (_morphDist[i] >= thr) { sx += p.getX(i); sy += p.getY(i); sz += p.getZ(i); hits++; }
        }
        if (!hits) return fallback;
        var head = B("頭");
        if (!head) return fallback;
        inner.updateMatrixWorld(true);
        var inv = new THREE.Matrix4().copy(head.matrixWorld).invert();
        return new THREE.Vector3(sx / hits, sy / hits, sz / hits)
          .applyMatrix4(mesh.matrixWorld).applyMatrix4(inv);
      } catch (e) { return fallback; }
    }
    var _morphDist = null;

    char.mountPromise = new Promise(function (res, rej) {
      preload(idOrUrl).then(function (loaded) {
        if (char.disposed) return;
        mesh = loaded;
        mesh.frustumCulled = false;
        inner.add(mesh);
        inner.updateMatrixWorld(true);
        // 骨骼索引
        if (mesh.skeleton && mesh.skeleton.bones) {
          boneList = mesh.skeleton.bones;
          for (var i = 0; i < boneList.length; i++) {
            var b = boneList[i];
            bones[b.name] = b;
            if (/^cf_J_hair/.test(b.name)) hairBones.push(b);
          }
          // 裙摆骨骼（スカート_r_c），按圈层深度算权重
          var reS = /^スカート_(\d+)_(\d+)$/;
          for (var j = 0; j < boneList.length; j++) {
            var bj = boneList[j];
            var m = reS.exec(bj.name);
            if (m) skirtBones.push({ bone: bj, ring: parseInt(m[1], 10), col: parseInt(m[2], 10) });
          }
        }
        // Q 版：放大头骨（头发/五官都挂在頭下面，会跟着放大）
        // 注意：build 会复用模型缓存，必须先**无条件**复位/设置缩放，再量包围盒，否则身高会被上一次的缩放污染
        var headBone = B("頭");
        var neckBone = B("首");
        var hs = (cfg.headScale && cfg.headScale > 1) ? cfg.headScale : 1;
        if (headBone) headBone.scale.setScalar(hs);
        if (neckBone) neckBone.scale.setScalar(1 + (hs - 1) * 0.4);

        // 不做整体缩放（SkinnedMesh 的父级缩放会与 bindMatrix 双重变换），
        // 保留模型原生尺寸，让舞台按包围盒取景。模型原点已在脚底。
        var box = new THREE.Box3().setFromObject(mesh);
        var size = new THREE.Vector3(); box.getSize(size);
        baseScale = 1;
        baseY = 0;
        inner.position.y = 0;


        // 动画质感：赛璐璐边光 + 高光 + 描边
        // 贴图是异步 decode 的，材质分类要看宽高，所以等它们就绪再套（最多等 1.6s）
        var shadeStart = Date.now();
        (function applyShadeWhenReady() {
          var ready = true;
          try {
            var mats0 = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
            for (var mi = 0; mi < mats0.length; mi++) {
              var mm = mats0[mi];
              if (mm && mm.map && (!mm.map.image || !mm.map.image.width)) { ready = false; break; }
            }
          } catch (e) { ready = true; }
          if (!ready && Date.now() - shadeStart < 1600) { setTimeout(applyShadeWhenReady, 90); return; }
          if (!SHADE) return;
          try {
            SHADE.apply(mesh, cfg.shade || "anime", Object.assign({ outlineWidth: cfg.outlineWidth || 0.028 }, cfg.shadeOpts || {}));
          } catch (e) { console.warn("[mmdchar] 动画质感应用失败", e); }
        })();

        char._candy = attachCandy();
        if (char._candy) char._candy.visible = false;

        // 程序化发束：在原有发片外叠一层 ribbon 发丝（可 cfg.hairStrands=false 关闭）
        if (cfg.hairStrands !== false) {
          try {
            var hairMod = __req("mmd-hair");
            if (hairMod && hairMod.create) {
              var hp = Object.assign({
                density: 2, radius: 0.08, len: 1.25, shine: 1, softEdge: 0.9,
                lift: 0.045, variation: 0.8,
              }, cfg.hairStrands || {});
              char._hairStrands = hairMod.create(THREE).attach(mesh, hp);
            }
          } catch (e) { console.warn("[mmdchar] 发束生成失败", e); }
        }

        // 中心骨骼（跳跃/重心用）与腰部（压扁用）
        char._centerBone = B("センター");
        char._centerRestY = char._centerBone ? char._centerBone.position.y : 0;
        char._centerRestX = char._centerBone ? char._centerBone.position.x : 0;
        char._waistBone = B("腰");
        char._waistScale = 1;
        // 待机微动作 / 棒棒糖演出用到的骨骼缓存
        char._headBone = B("頭");
        char._handBone = B("左手首") || B("左手先");
        char._eyeL = B("左目");
        char._eyeR = B("右目");
        char._mouthLocal = cacheMouthLocal();
        candyNext = 20 + Math.random() * 20;   // 20~40 秒后演一次

        // 灯
        lamps = new THREE.Group();
        lamps.add(new THREE.AmbientLight(0xfff6f2, 0.66));
        var d1 = new THREE.DirectionalLight(0xfff4ec, 0.88); d1.position.set(2.2, 5.2, 3.6);
        var d2 = new THREE.DirectionalLight(0xc8dcff, 0.3); d2.position.set(-3.2, 2.2, 2.4);
        var d3 = new THREE.DirectionalLight(0xffc8dc, 0.32); d3.position.set(-0.8, 3.4, -4.2);
        lamps.add(d1, d2, d3);
        inner.add(lamps);

        // 头发弹簧（每根骨骼两个方向）
        for (var hi = 0; hi < hairBones.length; hi++) {
          var hb = hairBones[hi];
          var depth = 0, p = hb;
          while (p && /^cf_J_hair/.test(p.name) && depth < 12) { depth++; p = p.parent; }
          var spread = 0;
          if (/^cf_J_hairFL_/.test(hb.name)) spread = 0.13;
          else if (/^cf_J_hairFR_/.test(hb.name)) spread = -0.13;
          else if (/^cf_J_hairF_/.test(hb.name)) spread = 0;   // 刘海不动
          hb.userData.pet = {
            spread: spread,
            depth: depth,
            rx: spring(34, 7), rz: spring(30, 6),
            restX: hb.rotation.x, restZ: hb.rotation.z,
            phase: Math.random() * Math.PI * 2,
          };
        }
        // 裙摆弹簧
        for (var si = 0; si < skirtBones.length; si++) {
          var sb = skirtBones[si];
          sb.spring = spring(22, 6);
          sb.restX = sb.bone.rotation.x;
          sb.phase = (sb.col / 15) * Math.PI * 2;
        }

        /* ---------------- 头型微调（贴向动画比例：脸略圆、下巴略短） ---------------- */
        function sculptFace(opt) {
          opt = opt || {};
          var kx = Number(opt.x || 0), ky = Number(opt.y || 0), chin = Number(opt.chin || 0);
          var jaw = Number(opt.jaw || 0), jawStart = Number(opt.jawStart || 0.25);
          if (!kx && !ky && !chin && !jaw) return false;
          try {
            var geo = mesh.geometry;
            var pos = geo.attributes.position, si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight;
            if (!pos || !si || !sw) return false;
            // 幂等：模型 mesh 会在切皮肤时复用，先恢复原始顶点再变形，避免多次叠加把脸/身高越改越大
            if (!mesh.userData.__sculptBase) mesh.userData.__sculptBase = new Float32Array(pos.array);
            else pos.array.set(mesh.userData.__sculptBase);
            var headBone = char._headBone;
            if (!headBone) {
              for (var bi0 = 0; bi0 < bones.length; bi0++) {
                if (/頭|head/i.test(bones[bi0].name)) { headBone = bones[bi0]; break; }
              }
            }
            if (!headBone) return false;
            mesh.updateMatrixWorld(true);
            var hw = new THREE.Vector3();
            headBone.getWorldPosition(hw);
            var hl = mesh.worldToLocal(hw.clone());
            var skelBones = (mesh.skeleton && mesh.skeleton.bones) || [];
            var headIdx = skelBones.indexOf(headBone);
            if (headIdx < 0) return false;
            var arr = pos.array;
            for (var i = 0; i < pos.count; i++) {
              var w = 0;
              for (var k = 0; k < 4; k++) {
                var idx = k === 0 ? si.getX(i) : k === 1 ? si.getY(i) : k === 2 ? si.getZ(i) : si.getW(i);
                if (idx !== headIdx) continue;
                var bw = k === 0 ? sw.getX(i) : k === 1 ? sw.getY(i) : k === 2 ? sw.getZ(i) : sw.getW(i);
                if (bw > 0) w += bw;
              }
              if (w <= 0.001) continue;
              var vx = arr[i * 3], vy = arr[i * 3 + 1];
              var nx = hl.x + (vx - hl.x) * (1 + kx * w);
              // 下颌收窄：低于"眼睛高度"的脸部顶点向中线收
              if (jaw && vy < hl.y - jawStart) {
                var jt = Math.min(1, (hl.y - jawStart - vy) / Math.max(0.2, Math.abs(hl.y) * 0.3));
                nx = hl.x + (nx - hl.x) * (1 - jaw * jt * w);
              }
              arr[i * 3] = nx;
              var nvy = hl.y + (vy - hl.y) * (1 + ky * w);
              if (chin && vy < hl.y) {
                var t = Math.min(1, (hl.y - vy) / Math.max(0.2, Math.abs(hl.y) * 0.45));
                nvy += t * chin * w;
              }
              arr[i * 3 + 1] = nvy;
            }
            pos.needsUpdate = true;
            geo.computeBoundingBox();
            geo.computeBoundingSphere();
            return true;
          } catch (e) { console.warn("[mmdchar] sculptFace 失败", e); return false; }
        }
        char.sculptFace = sculptFace;
        char.resetFace = function () {
          try {
            var base = mesh.userData && mesh.userData.__sculptBase;
            if (base && mesh.geometry && mesh.geometry.attributes && mesh.geometry.attributes.position) {
              mesh.geometry.attributes.position.array.set(base);
              mesh.geometry.attributes.position.needsUpdate = true;
              mesh.geometry.computeBoundingBox();
              mesh.geometry.computeBoundingSphere();
              return true;
            }
          } catch (e) {}
          return false;
        };
        char.resetFace();
        if (cfg.faceSculpt) sculptFace(cfg.faceSculpt);

        char._bones = bones;
        char._hair = hairBones;
        if (cfg.hairVolume) { try { char.hairVolume(cfg.hairVolume); } catch (e) {} }
        if (cfg.beret) { try { char.beret(true, cfg.beret === true ? {} : cfg.beret); } catch (e) {} }
        char._skirt = skirtBones;
        mounted = true;
        // 注意：SkinnedMesh 的 Box3 取的是 bind pose（T-pose），手臂展开会让宽度虚大 13，
        // 导致相机拉太远。取景按"身高"为准，宽度用站姿的经验比例。
        // 身高用**原始顶点**算（bind pose），不要用 Box3.setFromObject：
        // three 的 SkinnedMesh 盒体会吃到骨骼缩放（Q 版放大头骨会把它撑大，切回御姐还残留）。
        var posAttr = mesh.geometry.attributes.position;
        var hh = 19.7;
        if (posAttr && posAttr.count) {
          var pa = posAttr.array, minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity;
          for (var pi = 0; pi < posAttr.count; pi++) {
            var py = pa[pi * 3 + 1], px = pa[pi * 3];
            if (py < minY) minY = py;
            if (py > maxY) maxY = py;
            if (px < minX) minX = px;
            if (px > maxX) maxX = px;
          }
          if (isFinite(minY) && isFinite(maxY) && maxY > minY) hh = maxY - minY;
          mesh.userData.__bindW = (isFinite(minX) && isFinite(maxX)) ? (maxX - minX) : 0;
        }
        char.height = hh;
        if (stage && stage.frame) {
          try {
            stage.frame({
              height: hh, bboxW: hh * 0.30, bboxH: hh * 1.10,
              bboxMinY: 0, bboxMaxY: hh,
              margin: (cfg.camera && cfg.camera.margin) || 1.06,
              elevation: (cfg.camera && cfg.camera.elevation) || 0.05,
              glowColor: cfg.glowColor,
            });
          } catch (e) {}
        }
        exprsBlend(0.016);
        res(char);
      }).catch(function (e) {
        console.warn("[mmdchar] 模型加载失败: " + url, e);
        rej(e);
      });
    });
    char.mountPromise.catch(function () {});

    function setMorph(name, w) { exprTgt[name] = w; }
    function applyExprStatic(map, stateName) {
      for (var n in EXPR) exprTgt[EXPR[n]] = 0;
      for (var k in map) { var mn = EXPR[k]; if (mn) exprTgt[mn] = map[k]; }
      var ovs = cfg.exprOverrides && stateName && cfg.exprOverrides[stateName];
      if (ovs) {
        for (var k2 in ovs) {
          var mn2 = EXPR[k2] || k2;
          exprTgt[mn2] = ovs[k2];
        }
      }
    }
    function exprsBlend(dt) {
      if (!mesh || !mesh.morphTargetDictionary) return;
      var dict = mesh.morphTargetDictionary, inf = mesh.morphTargetInfluences;
      for (var nm in exprTgt) {
        var idx = dict[nm];
        if (idx == null) continue;
        exprCur[nm] = exprCur[nm] == null ? inf[idx] : exprCur[nm];
        exprCur[nm] += (exprTgt[nm] - exprCur[nm]) * Math.min(1, dt * 12);
        inf[idx] = exprCur[nm];
      }
    }

    // 骨骼基础姿势（弧度）
    var BASE = {
      "上半身": [0.01, 0, 0], "上半身2": [0.01, 0, 0],
      "首": [0.02, 0, 0], "頭": [0, 0, 0],
      // 手臂自然下垂（z 负=放向身体两侧）
      // armForwardX < 0 让手臂微微向前，手能露在裙子前面（不做就会整只手藏进裙子里）
      "左腕": [(cfg.armForwardX || 0), 0, (cfg.idleWave ? 1.15 : -(cfg.armIdle || 1.16))],
      "右腕": [(cfg.armForwardX || 0), 0, (cfg.idleWave ? (cfg.armIdle || 0.55) : (cfg.armIdle || 1.16))],
      "左ひじ": [0, 0, -0.14], "右ひじ": [0, 0, 0.14],
      "左肩": [0, 0, cfg.idleWave ? 0.3 : -0.06], "右肩": [0, 0, 0.06],
      "左ひじ": [0, 0, cfg.idleWave ? 0.5 : -0.14], "右ひじ": [0, 0, 0.14],
    };
    var POSES = {
      idle: {},
      // 双手举到脸侧（实测最好看的"开心/被摸"姿势）
      pat: {
        // 肩膀轻缩 + 手腕微收（大角度屈肘会被袖管模型拉长，实测难看）
        "左肩": [0, 0, 0.06], "右肩": [0, 0, -0.06],
        "左腕": [0, 0.05, -0.6], "右腕": [0, -0.05, 0.6],
        "左ひじ": [0, 0, 0.55], "右ひじ": [0, 0, -0.55],
        "頭": [-0.05, 0, 0.05], "首": [-0.02, 0, 0],
      },
      happy: {
        // 小幅度抬手（大幅抬肘会把 TDA 单片袖管拉成橡皮管，实测难看）
        "左肩": [0, 0, 0.08], "右肩": [0, 0, -0.08],
        "左腕": [0, 0.05, -0.55], "右腕": [0, -0.05, 0.55],
        "左ひじ": [0, 0, 0.45], "右ひじ": [0, 0, -0.45],
        "上半身": [-0.04, 0, 0], "頭": [-0.06, 0, 0.05],
      },
      talk: {
        "左腕": [0, 0.06, -0.95], "右腕": [0, -0.06, 0.95],
        "左ひじ": [0, 0, 0.35], "右ひじ": [0, 0, -0.35],
        "首": [0.05, 0, 0],
      },
      sleep: {
        "頭": [0.24, 0, 0.26], "首": [0.13, 0, 0.1],
        "左腕": [0, 0, -1.2], "右腕": [0, 0, 1.2],
        "上半身": [0.05, 0, 0],
      },
      shy: {
        // 低头 + 肩膀内收（手臂小角度，避免袖管拉长）
        "左肩": [0, 0, 0.05], "右肩": [0, 0, -0.05],
        "左腕": [0, 0.05, -0.6], "右腕": [0, -0.05, 0.6],
        "左ひじ": [0, 0, 0.65], "右ひじ": [0, 0, -0.65],
        "頭": [0.14, 0.08, 0.05], "首": [0.05, 0, 0],
      },
      stretch: {
        // 伸懒腰：双手举高
        "左肩": [0, 0, 0.38], "右肩": [0, 0, -0.38],
        "左腕": [0, 0, 1.05], "右腕": [0, 0, -1.05],
        "左ひじ": [0, 0, 1.05], "右ひじ": [0, 0, -1.05],
        "上半身": [-0.09, 0, 0], "頭": [-0.13, 0, 0],
      },
      wink: {
        "左腕": [0, 0, -1.22], "右腕": [0, 0, 1.22],
        "頭": [0.02, 0.12, 0.1], "首": [0, 0.05, 0.02],
      },
      eat: {
        // 右手抬到脸边做"吃东西"，左手自然下垂
        "右肩": [0, 0, -0.18], "右腕": [0, 0, -0.15],
        "右ひじ": [0, 0, -1.55],
        "左腕": [-(cfg.armForwardX || 0.28), 0, -(cfg.armIdle || 1.16)],
        "頭": [0.03, 0, 0],
      },
    };
    var poseCur = {};
    var EXPR_POSES = {
      happy: { smile: 1, blush: 0.4 },
      talk: {},
      sleep: { blink: 1, calm: 0.8 },
      shy: { shy: 1 },
      stretch: { surprise: 0.5, smile: 0.6 },
      wink: { winkR: 1, smile: 0.5, nicon: 0.6 },
      eat: { mouthA: 0.85, smile: 0.3, tongue: 0.35 },
      pat: { smile: 0.9, blush: 0.85, blink: 0.35 },
      idle: {},
    };

    /* ---------------- 待机小演出用的姿势片段（只覆盖手臂，其它骨骼沿用 idle） ---------------- */
    // 棒棒糖：抬手把糖送到嘴边（数值用 FK 反解 + 截图校准过）
    var CANDY_ARM = {
      "左肩": [0, 0, -0.06],
      "左腕": [-0.70, -1.20, -0.40],
      "左ひじ": [0.40, 0.20, 2.90],
    };
    // 撩头发：左手抬到鬓角附近，小幅拨一下再放下（FK 反解 + 截图校准）
    var TUCK_ARM = {
      "左肩": [0, 0, 0.06],
      "左腕": [-0.80, -0.90, -0.30],
      "左ひじ": [-0.20, 0.50, 3.00],
    };
    // 参与弹簧过渡的骨骼（构建时算一次，运行时不再新建对象）
    var poseNames = [];
    (function () {
      var seen = {};
      function addAll(map) { for (var k in map) if (!seen[k]) { seen[k] = 1; poseNames.push(k); } }
      addAll(BASE);
      for (var pn in POSES) addAll(POSES[pn]);
      addAll(CANDY_ARM); addAll(TUCK_ARM);
      addAll({ "下半身": 1, "腰": 1, "首": 1, "頭": 1, "上半身": 1, "上半身2": 1 });
    })();
    var poseVel = {};
    var ZERO3 = [0, 0, 0];
    var _hE = new THREE.Euler();
    var _mHand = new THREE.Matrix4();
    var _qHand = new THREE.Quaternion();
    var _qAim = new THREE.Quaternion();
    var _vMouth = new THREE.Vector3(), _vBall = new THREE.Vector3();
    var _vHand = new THREE.Vector3(), _vOff = new THREE.Vector3();
    var _UP = new THREE.Vector3(0, 1, 0);

    // 聊天/设置面板打开时不要演待机小动作（0.5s 检查一次 DOM，开销可忽略）
    function uiBusy(dt) {
      _ui.t -= dt;
      if (_ui.t <= 0) {
        _ui.t = 0.5;
        try {
          _ui.busy = !!(document.querySelector(".z02-panel.on") || document.querySelector(".z02-menu.on"));
        } catch (e) { _ui.busy = false; }
      }
      return _ui.busy;
    }

    function startHop() {
      hop.phase = 1; hop.t = 0; hop.y = 0; hop.vy = 0; hop.v = 0;
    }

    function mergedTarget(name) {
      var base = POSES[name] || POSES.idle;
      var ov = cfg.poseOverrides && cfg.poseOverrides[name];
      if (!ov) return base;
      var out = {};
      for (var k in base) out[k] = base[k].slice();
      for (var k2 in ov) out[k2] = ov[k2];
      return out;
    }
    /** 发量/发型体积：放大头发根骨骼（整条链继承），让头发更蓬松更长（scale=1 还原） */
    char.hairVolume = function (scale) {
      try {
        var k = Math.max(0.9, Math.min(1.25, Number(scale == null ? 1.06 : scale)));
        var roots = (char._hairRoots || []).slice();
        if (!roots.length) {
          roots = hairBones.filter(function (b) {
            return !b.parent || !/^cf_J_hair/.test(b.parent.name);
          });
          char._hairRoots = roots;
        }
        for (var i = 0; i < roots.length; i++) {
          roots[i].scale.set(k, 1 + (k - 1) * 0.45, k);
        }
        return k;
      } catch (e) { return 0; }
    };

    /** 贝雷帽道具（实验）：挂在頭骨上的白色帽子，用于 02·元气 的 3D 区分 */
    char.beret = function (on, opts) {
      try {
        if (char._beret) {
          try { char._beret.parent && char._beret.parent.remove(char._beret); } catch (e) {}
          try { char._beret.traverse(function (o) { if (o.geometry) o.geometry.dispose(); }); } catch (e) {}
          char._beret = null;
        }
        if (!on) return false;
        opts = opts || {};
        var head = char._bones && char._bones["頭"];
        if (!head) return false;
        var THREE_ = THREE;
        var group = new THREE_.Group();
        var main = new THREE_.Mesh(
          new THREE_.SphereGeometry(Number(opts.radius || 1.08), 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.62),
          new THREE_.MeshToonMaterial({ color: new THREE_.Color(Number(opts.color || 0xf6f2f4)) })
        );
        main.scale.set(1, Number(opts.flat || 0.62), 1);
        group.add(main);
        var rim = new THREE_.Mesh(
          new THREE_.TorusGeometry(Number(opts.radius || 1.08), 0.05, 6, 26),
          new THREE_.MeshToonMaterial({ color: new THREE_.Color(0xe8dfe6) })
        );
        rim.rotation.x = Math.PI / 2;
        group.add(rim);
        group.position.set(0, Number(opts.y || 1.82), Number(opts.z || -0.06));
        group.rotation.x = Number(opts.tilt || -0.1);
        group.rotation.z = Number(opts.roll || 0.06);
        head.add(group);
        char._beret = group;
        return true;
      } catch (e) { return false; }
    };

    /** 调试：按语义名设置表情 morph（smile/shy/blush/tease/sad/surprise/heartEyes/jito…） */
    char.setExpr = function (map) {
      try {
        for (var k in map || {}) {
          var mn = EXPR[k] || k;
          if (mn) setMorph(mn, Math.max(0, Math.min(1, Number(map[k]) || 0)));
        }
        return true;
      } catch (e) { return false; }
    };
    /** 调试：读取某语义表情当前权重（smile/shy/blush/tease/sad/jito…） */
    char.getExpr = function (name) {
      try {
        var mn = EXPR[name] || name;
        if (!mesh || !mesh.morphTargetDictionary) return 0;
        var idx = mesh.morphTargetDictionary[mn];
        if (idx == null) return -1;
        return +(mesh.morphTargetInfluences[idx] || 0).toFixed(3);
      } catch (e) { return -2; }
    };
    char.clearExprs = function () {
      try { for (var n in EXPR) setMorph(EXPR[n], 0); return true; } catch (e) { return false; }
    };

    /** 口型：说话时由引擎驱动（vowel: a/i/u/e/o 或直接权重表） */
    char.talkMouth = function (vowel, weight) {
      try {
        var w = Math.max(0, Math.min(1, Number(weight == null ? 0.45 : weight)));
        var names = ["mouthA", "mouthI", "mouthU", "mouthE", "mouthO"];
        for (var i = 0; i < names.length; i++) setMorph(EXPR[names[i]], 0);
        var key = EXPR["mouth" + String(vowel || "A").toUpperCase()];
        if (key) setMorph(key, w);
        return true;
      } catch (e) { return false; }
    };
    char.closeMouth = function () {
      try {
        ["mouthA", "mouthI", "mouthU", "mouthE", "mouthO"].forEach(function (k) { if (EXPR[k]) setMorph(EXPR[k], 0); });
        return true;
      } catch (e) { return false; }
    };

    char.setState = function (name) {
      if (!POSES[name]) name = "idle";
      var changed = name !== state;
      state = name; stateT = 0;
      applyExprStatic(EXPR_POSES[name] || {}, name);
      if (name !== "idle") {
        // 其它姿势独占身体：取消待机小演出，避免动作打架
        if (candyT > 0) { candyT = 0; if (char._candy) char._candy.visible = false; }
        tuck.t = 0;
      }
      if (changed) settle.v += 0.55;      // 姿势切换时柔和下沉一下
    };
    // 调试：临时改基础姿势（不重建模型）
    char.debugOverride = function (name, map) {
      cfg.poseOverrides = cfg.poseOverrides || {};
      cfg.poseOverrides[name] = map;
      setState(name);
      return cfg.poseOverrides[name];
    };
    char.debugState = function (name, map) {
      if (!POSES[name]) POSES[name] = {};
      for (var k in map) POSES[name][k] = map[k];
      setState(name);
      return POSES[name];
    };
    char.debugPose = function (map) {
      for (var k in map) BASE[k] = map[k];
      for (var n in BASE) {
        poseCur[n] = [BASE[n][0], BASE[n][1], BASE[n][2]];
        if (poseVel[n]) poseVel[n] = [0, 0, 0];
      }
      return BASE;
    };
    char.setLook = function (x, y) {
      var nx = Math.max(-1, Math.min(1, x || 0));
      var ny = Math.max(-1, Math.min(1, y || 0));
      if (Math.abs(nx - look.tx) + Math.abs(ny - look.ty) > 0.002) lookStill = 0;
      look.tx = nx; look.ty = ny;
    };
    char.pat = function () {
      startHop();
      char.setState("pat");
      applyExprStatic({ smile: 0.9, blush: 0.85, blink: 0.35 });
      setTimeout(function () { if (state === "pat") char.setState("idle"); }, 1400);
    };

    char.update = function (dt, t) {
      if (!mounted || !mesh) return;
      if (!(dt > 0)) dt = 0.016;
      if (dt > 0.1) dt = 0.1;
      tAcc += dt; stateT += dt;
      lookStill += dt;
      look.x += (look.tx - look.x) * Math.min(1, dt * 10);
      look.y += (look.ty - look.y) * Math.min(1, dt * 10);

      /* ---------------- 眨眼：随机节奏 + 偶尔连眨两次 / 慢眨 ---------------- */
      var canBlink = state === "idle" || state === "talk" || state === "eat";
      if (blink.t > 0) {
        blink.t += dt;
        var bp = blink.t / blink.dur, bw = 0;
        if (blink.kind === 1) {
          // 连眨两次
          if (bp < 0.32) bw = Math.sin(Math.PI * bp / 0.32);
          else if (bp > 0.42 && bp < 0.74) bw = Math.sin(Math.PI * (bp - 0.42) / 0.32);
        } else if (blink.kind === 2) {
          // 慢眨：闭得慢、睁得也慢
          bw = Math.pow(Math.sin(Math.PI * Math.min(1, bp)), 0.55);
        } else {
          bw = Math.sin(Math.PI * Math.min(1, bp));
        }
        if (bp >= 1) { blink.t = 0; bw = 0; }
        setMorph(EXPR.blink, bw);
      } else if (canBlink) {
        blink.at -= dt;
        if (blink.at <= 0) {
          var br = Math.random();
          blink.kind = br < 0.66 ? 0 : (br < 0.84 ? 1 : 2);
          blink.dur = blink.kind === 1 ? 0.34 : (blink.kind === 2 ? 0.38 : 0.14);
          blink.t = 0.0001;
          blink.at = 1.7 + Math.random() * 3.3 + (blink.kind === 1 ? 0.5 : 0);
        }
      } else if (blink.at <= 0) {
        blink.at = 1.2 + Math.random() * 1.5;
      }

      /* ---------------- 说话口型 ---------------- */
      if (state === "talk") {
        mouthT += dt;
        var seq = ["あ", "い", "う", "え", "お"];
        var midx = Math.floor(mouthT * 7) % seq.length;
        for (var i2 = 0; i2 < seq.length; i2++) setMorph(EXPR[["mouthA", "mouthI", "mouthU", "mouthE", "mouthO"][i2]], i2 === midx ? 0.85 : 0);
      }

      /* -------- 视线：鼠标跟随时头部带弹簧延迟；手不动时缓慢环视 + 偷看后转开 -------- */
      var idleGaze = state === "idle" || state === "talk";
      if (idleGaze) {
        if (lookStill > 2.2) {
          drift.at -= dt;
          if (drift.at <= 0) {
            // 左右交替慢速环视：幅度 0.16~0.32 rad，偶尔回正，然后停顿 2.4~5.2s
            drift.side = -drift.side;
            drift.yawT = Math.random() < 0.22 ? 0 : drift.side * (0.16 + Math.random() * 0.16);
            drift.pitchT = (Math.random() * 2 - 1) * 0.06;
            drift.rollT = (Math.random() * 2 - 1) * 0.05;
            drift.at = 2.4 + Math.random() * 2.8;       // 看几秒再停一会儿
          }
          drift.peekAt -= dt;
          if (drift.peekAt <= 0) { drift.peekT = 0.55; drift.peekAt = 5.0 + Math.random() * 4.5; }
          if (drift.peekT > 0) {
            drift.peekT -= dt;                          // 飞快偷瞄一眼鼠标（此时头会追过去）
            drift.yawT = look.x * 0.24;
            drift.pitchT = look.y * 0.09;
            if (drift.peekT <= 0) drift.at = 0.5;       // 看完马上转开
          }
        } else {
          drift.yawT *= Math.max(0, 1 - dt * 3.5);
          drift.pitchT *= Math.max(0, 1 - dt * 3.5);
          drift.rollT *= Math.max(0, 1 - dt * 3.5);
          drift.at = Math.max(drift.at, 1.4);
        }
      } else {
        drift.yawT = 0; drift.pitchT = 0; drift.rollT = 0; drift.peekT = 0;
      }
      drift.yaw += (drift.yawT - drift.yaw) * Math.min(1, dt * 2.0);
      drift.pitch += (drift.pitchT - drift.pitch) * Math.min(1, dt * 2.0);
      drift.roll += (drift.rollT - drift.roll) * Math.min(1, dt * 2.0);

      // 眼球微扫视：让眼神不呆
      sacc.at -= dt;
      if (sacc.at <= 0) {
        sacc.at = 0.35 + Math.random() * 1.1;
        sacc.tx = (Math.random() * 2 - 1) * 0.03;
        sacc.ty = (Math.random() * 2 - 1) * 0.018;
      }
      sacc.x += (sacc.tx - sacc.x) * Math.min(1, dt * 18);
      sacc.y += (sacc.ty - sacc.y) * Math.min(1, dt * 18);

      var lookK = state === "sleep" ? 0.25 : 1;
      var gazeYawT = clampNum(look.x * 0.30 * lookK + drift.yaw, -0.40, 0.40);      // 最大转头角度限制
      var gazePitchT = clampNum(look.y * 0.17 * lookK + drift.pitch, -0.19, 0.19);
      var gazeYaw = gaze.yaw.step(gazeYawT, dt);      // 二阶弹簧：头部跟随自然带一点延迟
      var gazePitch = gaze.pitch.step(gazePitchT, dt);

      /* ---------------- 棒棒糖待机小演出（抬手 → 送到嘴边 → 舔两下 → 放下） ---------------- */
      var candyOn = false, candyLick = 0, candyBallW = 0, candyP = 0;
      if (candyT > 0 && state !== "idle") { candyT = 0; if (char._candy) char._candy.visible = false; }
      if (state === "idle" && candyT <= 0) {
        if (tuck.t <= 0 && hop.phase === 0 && stateT > 1.6 && !uiBusy(dt)) {
          candyNext -= dt;
          if (candyNext <= 0 && char._candy) {
            candyT = CANDY_DUR; candyDur = CANDY_DUR;
            candyNext = 20 + Math.random() * 20;        // 20~40 秒一次
            char._candy.visible = true;
          }
        } else {
          uiBusy(dt);                                   // 面板开着 / 其它动作时刷新缓存但不演
        }
      }
      if (candyT > 0) {
        candyT = Math.max(0, candyT - dt);
        candyP = 1 - candyT / candyDur;
        candyOn = candyP > 0.02 && candyP < 0.93;
        candyLick = Math.min(1, bumpAt(candyP, 0.31, 0.13) + bumpAt(candyP, 0.51, 0.13));
        candyBallW = smoothstep(0.02, 0.14, candyP) * (1 - smoothstep(0.80, 0.92, candyP));
        if (candyT <= 0) {
          if (char._candy) char._candy.visible = false;
          setMorph(EXPR.tongue, 0);
          setMorph(EXPR.smile, 0);
          setMorph(EXPR.mouthA, 0);
        } else {
          setMorph(EXPR.tongue, candyLick * 0.9);
          setMorph(EXPR.smile, 0.30 + candyLick * 0.22);
          setMorph(EXPR.mouthA, Math.max(0, candyLick - 0.45) * 0.6);
        }
      }

      /* ---------------- 偶尔撩一下头发（左手小幅抬放） ---------------- */
      var tuckQ = 0;
      if (state === "idle" && candyT <= 0 && tuck.t <= 0 && stateT > 6 && !uiBusy(dt)) {
        tuck.at -= dt;
        if (tuck.at <= 0) { tuck.t = tuck.dur; tuck.at = 30 + Math.random() * 35; }
      }
      if (tuck.t > 0) {
        if (state !== "idle" || candyT > 0) {
          tuck.t = 0;
        } else {
          tuck.t = Math.max(0, tuck.t - dt);
          tuckQ = 1 - tuck.t / tuck.dur;
        }
      }
      var tuckLean = tuckQ > 0 ? Math.sin(Math.min(1, tuckQ) * Math.PI) : 0;

      /* ---------------- 姿势目标 + 弹簧过渡 ---------------- */
      var target = mergedTarget(state);
      if (state === "idle") {
        if (candyT > 0 && candyP < 0.82) target = CANDY_ARM;
        else if (tuckQ > 0 && tuckQ < 0.84) target = TUCK_ARM;
      }
      for (var pi = 0; pi < poseNames.length; pi++) {
        var pnm = poseNames[pi];
        var pb = BASE[pnm] || ZERO3;
        var pt = target[pnm] || pb;
        var pc = poseCur[pnm] || (poseCur[pnm] = [pb[0], pb[1], pb[2]]);
        var pv = poseVel[pnm] || (poseVel[pnm] = [0, 0, 0]);
        pv[0] += ((pt[0] - pc[0]) * 96 - pv[0] * 17) * dt; pc[0] += pv[0] * dt;
        pv[1] += ((pt[1] - pc[1]) * 96 - pv[1] * 17) * dt; pc[1] += pv[1] * dt;
        pv[2] += ((pt[2] - pc[2]) * 96 - pv[2] * 17) * dt; pc[2] += pv[2] * dt;
      }

      /* ---------------- 呼吸 / 重心转移 / 骨骼写入 ---------------- */
      var breathe = Math.sin(tAcc * (state === "sleep" ? 0.92 : 1.65));
      var shift = Math.sin(tAcc * 0.34);              // 约 18s 一次的重心左右转移
      var sway = Math.sin(tAcc * 0.8);
      var neckYaw = gazeYaw * 0.30, headYaw = gazeYaw * 0.70;
      var neckPitch = gazePitch * 0.27, headPitch = gazePitch * 0.73;
      var roll = drift.roll * 0.7 - shift * 0.012 + sway * 0.006 - tuckLean * 0.05;

      setRot("下半身", poseCur["下半身"][0] + breathe * 0.002,
        poseCur["下半身"][1] - shift * 0.006, poseCur["下半身"][2] - shift * 0.012);
      setRot("腰", poseCur["腰"][0], poseCur["腰"][1] + shift * 0.004, poseCur["腰"][2] + shift * 0.010);
      setRot("上半身", poseCur["上半身"][0] + breathe * 0.012 - gazePitch * 0.04,
        poseCur["上半身"][1] + gazeYaw * 0.10 + sway * 0.008,
        poseCur["上半身"][2] + shift * 0.016 + roll * 0.35);
      setRot("上半身2", poseCur["上半身2"][0] + breathe * 0.008 - gazePitch * 0.03,
        poseCur["上半身2"][1] + gazeYaw * 0.05, 0);
      // 肩：呼吸时轻轻抬起（胸腔起伏）
      setRot("左肩", poseCur["左肩"][0], poseCur["左肩"][1], poseCur["左肩"][2] + breathe * 0.018);
      setRot("右肩", poseCur["右肩"][0], poseCur["右肩"][1], poseCur["右肩"][2] - breathe * 0.018);
      // 头：视线跟随（弹簧延迟）+ 环视/偷看 + 舔糖时低头
      setRot("首", poseCur["首"][0] + neckPitch - breathe * 0.003,
        poseCur["首"][1] + neckYaw + shift * 0.004 + tuckLean * 0.03,
        poseCur["首"][2] + neckYaw * 0.06);
      setRot("頭", poseCur["頭"][0] + headPitch + candyLick * 0.10 + (state === "sleep" ? Math.sin(tAcc * 0.55) * 0.035 : 0),
        poseCur["頭"][1] + headYaw + candyLick * 0.03 + tuckLean * 0.05,
        poseCur["頭"][2] + roll);
      // 眼睛：比头更快看向目标（+ 微扫视），限制最大偏角
      if (char._eyeL || char._eyeR) {
        var eyeYaw = clampNum(gazeYawT * 0.62 + sacc.x + candyLick * 0.05, -0.24, 0.24);
        var eyePitch = clampNum(gazePitchT * 0.60 + sacc.y + candyLick * 0.06, -0.15, 0.15);
        setRot("左目", eyePitch, eyeYaw, 0);
        setRot("右目", eyePitch, eyeYaw, 0);
      }
      // 手臂：待机微摆；撩头发时手腕再轻拨一下
      var armSwing = Math.sin(tAcc * 1.45) * 0.028;
      var busyArm = candyT > 0 || tuckQ > 0;
      var waveOff = cfg.idleWave && state === "idle" && !busyArm ? Math.sin(tAcc * 5.2) * 0.18 : 0;
      var tuckSwing = tuckQ > 0 ? Math.sin(Math.min(1, tuckQ) * Math.PI * 2.2) * 0.12 : 0;
      setRot("左腕", poseCur["左腕"][0] + breathe * 0.006, poseCur["左腕"][1], poseCur["左腕"][2] - armSwing + waveOff);
      setRot("右腕", poseCur["右腕"][0], poseCur["右腕"][1], poseCur["右腕"][2] + armSwing);
      setRot("左ひじ", poseCur["左ひじ"][0], poseCur["左ひじ"][1], poseCur["左ひじ"][2] + tuckSwing);
      setRot("右ひじ", poseCur["右ひじ"][0], poseCur["右ひじ"][1], poseCur["右ひじ"][2]);

      // 头的角速度（驱动物理）：从四元数取欧拉，不能用 .rotation（它和 quaternion 不同步）
      var headBone = char._headBone;
      if (headBone) {
        _hE.setFromQuaternion(headBone.quaternion);
        if (!headReady) { headPrev.y = _hE.y; headPrev.x = _hE.x; headReady = true; }
        headVel.y = (_hE.y - headPrev.y) / dt;
        headVel.x = (_hE.x - headPrev.x) / dt;
        headPrev.y = _hE.y; headPrev.x = _hE.x;
      }
      var shiftVel = Math.cos(tAcc * 0.34) * 0.034;
      var bodyDy = char._centerBone ? (char._centerBone.position.y - char._centerRestY) : 0;

      // 头发弹簧（程序化物理）
      if (!char._noPhys) for (var hi = 0; hi < hairBones.length; hi++) {
        var hb = hairBones[hi];
        var pd = hb.userData.pet;
        if (!pd) continue;
        var f = Math.min(1.6, pd.depth / 6);
        // 头部转动带来的惯性 + 轻微自然摆动 + 重心转移的带动
        var driveX = clampNum(-headVel.x * 0.5, -6, 6) * f - Math.sin(tAcc * 1.6 + pd.phase) * 0.085 * f;
        var driveZ = clampNum(-headVel.y * 0.5, -6, 6) * f + Math.sin(tAcc * 1.2 + pd.phase) * 0.065 * f + shiftVel * 0.9 * f;
        driveX += bodyDy * 0.6 * f;
        pd.rx.step(0, dt, driveX);
        pd.rz.step(0, dt, driveZ);
        _tmpEuler.set(pd.rx.x, 0, pd.rz.x);
        _tmpQuat.setFromEuler(_tmpEuler);
        hb.quaternion.copy(restOf(hb)).multiply(_tmpQuat);
        // 前侧长发放到耳后/肩后：让手臂和袖子露出来（02 立绘里也是把前发拨开的）
        if (pd.spread) {
          _tmpEuler.set(0, 0, pd.spread);
          _tmpQuat.setFromEuler(_tmpEuler);
          hb.quaternion.multiply(_tmpQuat);
        }
      }
      // 裙摆：随身体左右轻微摆
      if (!char._noPhys) for (var si = 0; si < skirtBones.length; si++) {
        var sb = skirtBones[si];
        var kf = Math.min(1.4, sb.ring / 6);
        var driveS = -headVel.y * 0.12 * kf + Math.sin(tAcc * 1.3 + sb.phase) * 0.05 * kf + shiftVel * 0.5 * kf;
        sb.spring.step(0, dt, driveS);
        _tmpEuler.set(sb.spring.x * 0.6, 0, 0);
        _tmpQuat.setFromEuler(_tmpEuler);
        sb.bone.quaternion.copy(restOf(sb.bone)).multiply(_tmpQuat);
      }

      /* ---------------- 被摸：蓄力 → 跳 → 阻尼弹簧落地回弹（不再硬切） ---------------- */
      var yOff = 0, sq = 0;
      if (hop.phase === 1) {
        hop.t += dt;
        var hq = Math.min(1, hop.t / 0.12);
        yOff = -0.40 * Math.sin(hq * Math.PI * 0.5);
        sq = 0.045 * hq;
        if (hq >= 1) { hop.phase = 2; hop.vy = 7.0; }
      } else if (hop.phase === 2) {
        hop.vy -= 25 * dt;
        hop.y += hop.vy * dt;
        yOff = hop.y;
        sq = clampNum(-hop.vy * 0.0022, -0.02, 0.02);
        if (hop.y <= 0 && hop.vy < 0) {
          hop.y = 0; hop.phase = 3; hop.v = hop.vy * 0.62; sq = 0.055;
        }
      } else if (hop.phase === 3) {
        // 落地：欠阻尼弹簧（先沉一下再软回弹），比原来的硬切曲线柔和
        hop.v += (-180 * hop.y - 13 * hop.v) * dt;
        hop.y += hop.v * dt;
        yOff = hop.y;
        sq = Math.max(0, -hop.y) * 0.45;
        if (Math.abs(hop.y) < 0.004 && Math.abs(hop.v) < 0.05) {
          hop.phase = 0; hop.y = 0; hop.v = 0; yOff = 0; sq = 0;
        }
      }
      // 状态切换时的柔和小下沉（弹簧回正）
      settle.v += (-140 * settle.x - 16 * settle.v) * dt;
      settle.x += settle.v * dt;
      settle.x = clampNum(settle.x, -0.06, 0.06);
      sq += settle.x;

      if (char._centerBone) {
        char._centerBone.position.x = char._centerRestX + shift * 0.10;
        char._centerBone.position.y = char._centerRestY + yOff;
      }
      if (char._waistBone) char._waistBone.scale.set(1 + sq * 0.6, 1 - sq, 1 + sq * 0.6);

      /* -------- 棒棒糖：每帧把糖球瞄到嘴边（1 帧延迟，肉眼不可见） -------- */
      if (char._candy && char._handBone && char._mouthLocal && char._headBone) {
        if (candyOn) {
          char._candy.visible = true;
          char._handBone.updateWorldMatrix(true, false);
          _vHand.setFromMatrixPosition(char._handBone.matrixWorld);
          _mHand.extractRotation(char._handBone.matrixWorld);
          _qHand.setFromRotationMatrix(_mHand);
          char._headBone.updateWorldMatrix(true, false);
          _vMouth.copy(char._mouthLocal).applyMatrix4(char._headBone.matrixWorld);
          // 糖球目标 = 嘴唇前上方；"舔"的时候更贴近嘴唇
          var bx = 0.20, by = -0.05, bz = 0.36;
          var lk = Math.min(1, candyLick);
          bx += (0.10 - bx) * lk * 0.85;
          by += (0.02 - by) * lk * 0.85;
          bz += (0.24 - bz) * lk * 0.85;
          var bob = Math.sin(tAcc * 2.2) * 0.018 * (1 - lk);
          _vBall.set(_vMouth.x + bx, _vMouth.y + by + bob, _vMouth.z + bz);
          _vOff.subVectors(_vBall, _vHand);
          var bdist = _vOff.length();
          if (bdist > 0.001) {
            _vOff.divideScalar(bdist);
            char._candy.scale.setScalar(clampNum(bdist / 0.48, 1.2, 2.6) * candyBallW);
            _qAim.copy(_qHand).invert();
            _vOff.applyQuaternion(_qAim);               // 变换到手骨局部
            _qAim.setFromUnitVectors(_UP, _vOff);       // 糖的 +Y（棒→球）对准目标
            char._candy.quaternion.slerp(_qAim, Math.min(1, dt * 14));
          }
        } else if (char._candy.visible) {
          char._candy.visible = false;
        }
      }

      exprsBlend(dt);
    }

    // 手动触发棒棒糖小演出（默认 3.2s：抬手 → 糖到嘴边 → 舔两下 → 放下）
    char.candyPose = function (seconds) {
      if (!char._candy || state !== "idle") return false;
      _ui.t = 0;                                  // 强制刷新面板状态
      if (uiBusy(0)) return false;
      candyDur = clampNum(Number(seconds) || CANDY_DUR, 2.5, 5.0);
      candyT = candyDur;
      tuck.t = 0;
      char._candy.visible = true;
      return true;
    };
    // 动画状态读数（验收 / 调试用，不参与正常逻辑）
    char.animState = function () {
      if (!mounted) return { mounted: false };
      return {
        mounted: mounted, state: state,
        boneCount: boneList.length, hairBones: hairBones.length, skirtBones: skirtBones.length,
        blinkKind: blink.kind, blinkT: +blink.t.toFixed(3), blinkNext: +blink.at.toFixed(2),
        gazeYaw: +gaze.yaw.x.toFixed(4), gazePitch: +gaze.pitch.x.toFixed(4),
        driftYaw: +drift.yaw.toFixed(4), driftYawT: +drift.yawT.toFixed(4), driftAt: +drift.at.toFixed(2), peekT: +drift.peekT.toFixed(2), eyeSacc: +sacc.x.toFixed(4),
        candyT: +candyT.toFixed(2), candyNext: +candyNext.toFixed(1),
        candyVisible: !!(char._candy && char._candy.visible),
        candyGate: { stateT: +stateT.toFixed(2), tuckT: +tuck.t.toFixed(2), hopPhase: hop.phase,
          uiBusy: _ui.busy, hasCandy: !!char._candy },
        tuckT: +tuck.t.toFixed(2), tuckNext: +tuck.at.toFixed(1),
        hopPhase: hop.phase, hopY: +hop.y.toFixed(3), settle: +settle.x.toFixed(4),
        breathe: +Math.sin(tAcc * 1.65).toFixed(3), shift: +Math.sin(tAcc * 0.34).toFixed(3),
        uiBusy: _ui.busy, lookStill: +lookStill.toFixed(2),
      };
    };
    // 验收用的小钩子（可手动把定时器拨快，不参与正常逻辑）
    char._anim = {
      forceCandy: function (delay) { candyNext = typeof delay === "number" ? delay : 0.05; return candyNext; },
      forceTuck: function () { tuck.t = tuck.dur; tuck.at = 30; return tuck.t; },
      forceBlink: function (kind) {
        blink.kind = kind == null ? 1 : kind;
        blink.dur = blink.kind === 1 ? 0.34 : (blink.kind === 2 ? 0.38 : 0.14);
        blink.t = 0.0001;
        return blink.kind;
      },
      set: function (k, v) {
        if (k === "candyNext") candyNext = v;
        else if (k === "candyT") { candyT = v; candyDur = Math.max(candyDur, v); }
        else if (k === "tuckAt") tuck.at = v;
        else if (k === "driftAt") drift.at = v;
        else if (k === "driftYawT") drift.yawT = v;
        else if (k === "peekAt") drift.peekAt = v;
        else return false;
        return true;
      },
      read: null,
    };
    char._anim.read = char.animState;
    char.setShade = function (preset, opts) {
      if (!SHADE) return null;
      SHADE.set(preset, opts);
      return SHADE;
    };
    char.dispose = function () {
      char.disposed = true;
      if (SHADE) { try { SHADE.dispose(); } catch (e) {} }
      try {
        inner.traverse(function (ob) {
          if (ob.geometry) ob.geometry.dispose();
          if (ob.material) {
            var ms = Array.isArray(ob.material) ? ob.material : [ob.material];
            ms.forEach(function (m) { if (m.map) m.map.dispose(); m.dispose(); });
          }
        });
      } catch (e) {}
    };
    return char;
  }

  var api = {
    addModel: addModel,
    setModels: function (map) { for (var i in map || {}) addModel(i, map[i]); return api; },
    listModels: function () { return Object.keys(MODELS); },
    ready: function (idOrUrl) {
      var e = cache[modelCfg(idOrUrl).url];
      return !!(e && e.mesh);
    },
    preload: function (idOrUrl) { return preload(idOrUrl); },
    preloadAll: function () {
      var list = [];
      for (var id in MODELS) list.push(preload(id).catch(function () {}));
      return Promise.all(list);
    },
    build: build,
    makeVariants: function () {
      var out = {};
      for (var id in MODELS) {
        (function (iid) {
          out[iid] = {
            meta: { id: iid, label: MODELS[iid].label || iid, height: MODELS[iid].height || DEFAULT_HEIGHT, camera: MODELS[iid].camera || {} },
            build: function () { return build(iid); },
          };
        })(id);
      }
      return out;
    },
    dispose: function () {
      for (var u in cache) cache[u] = null;
      cache = Object.create(null);
    },
  };
  return api;
};
