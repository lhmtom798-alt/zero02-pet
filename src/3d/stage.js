/**
 * stage —— 3D 舞台：渲染器 / 相机 / 灯光共享 uniform / 地面阴影 / 背光晕 / 缩放适配。
 * 透明背景，直接浮在 DSH 界面右下角；角色高度由各角色 meta.height 决定。
 */
module.exports.create = function (o) {
  var THREE = o.THREE, K = o.K;
  var host = o.host;
  var quality = o.quality || "high";

  var renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x000000, 0);
  var dprCap = quality === "low" ? 1 : quality === "medium" ? 1.5 : 2;
  renderer.setPixelRatio(Math.min(dprCap, window.devicePixelRatio || 1));
  renderer.domElement.style.cssText = "width:100%;height:100%;display:block;pointer-events:none;";
  host.appendChild(renderer.domElement);

  var scene = new THREE.Scene();
  var camera = new THREE.PerspectiveCamera(26, 1, 0.05, 200);

  // 背光晕
  var glowTex = K.radialTex([
    [0, "rgba(255,255,255,0.55)"],
    [0.35, "rgba(255,255,255,0.20)"],
    [0.72, "rgba(255,255,255,0.035)"],
    [1, "rgba(255,255,255,0)"],
  ]);
  var glowMat = new THREE.SpriteMaterial({ map: glowTex, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, opacity: 0.32 });
  var glow = new THREE.Sprite(glowMat);
  glow.renderOrder = -10;
  scene.add(glow);

  // 地面接触阴影
  var shadowTex = K.shadowTex();
  var shadowMat = new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, opacity: 0.6, color: 0x33202a });
  var shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), shadowMat);
  shadow.rotation.x = -Math.PI / 2;
  shadow.renderOrder = -5;
  scene.add(shadow);

  var charRoot = new THREE.Group();
  scene.add(charRoot);

  // 精确取景：按包围盒算"竖着装得下、横着也装得下"的相机距离
  function fitDist(aspect) {
    var halfTan = Math.tan((camera.fov * Math.PI) / 360);
    var dv = ((state.bboxH || state.height) * (state.margin || 1.06) * 0.5) / halfTan;
    var dh = ((state.bboxW || state.height * 0.6) * (state.margin || 1.06) * 0.5) / (halfTan * Math.max(0.2, aspect));
    return Math.max(dv, dh) * (state.distK || 1);
  }

  var state = {
    height: 4.4,
    targetY: 2.2,
    azimuth: 0,
    elevation: 0.1,
    width: 200,
    heightPx: 200,
    dist: 10,
    glowColor: 0xff6f96,
    autoRotate: true,
  };
  var camSpring = {
    az: K.springer(0, { k: 90, d: 16 }),
    el: K.springer(0.1, { k: 90, d: 16 }),
    dist: K.springer(10, { k: 90, d: 16 }),
    targetY: K.springer(2.2, { k: 90, d: 16 }),
  };

  function updateCamera(instant) {
    var az = camSpring.az.value, el = camSpring.el.value, d = camSpring.dist.value, ty = camSpring.targetY.value;
    var x = Math.sin(az) * Math.cos(el) * d;
    var y = ty + Math.sin(el) * d;
    var z = Math.cos(az) * Math.cos(el) * d;
    camera.position.set(x, y, z);
    camera.lookAt(0, ty, 0);
  }

  var api = {
    renderer: renderer,

    scene: scene,
    camera: camera,
    root: charRoot,
    state: state,
    host: host,

    /** 按角色尺寸/包围盒调整相机与地面装饰 */
    frame: function (cfg) {
      cfg = cfg || {};
      var fin = function (v, d) { return Number.isFinite(Number(v)) ? Number(v) : d; };
      state.height = fin(cfg.height, state.height) || state.height;
      var bw0 = Number.isFinite(Number(cfg.bboxW)) && Number(cfg.bboxW) > 0 ? Number(cfg.bboxW) : state.height * 0.6;
      var bh0 = Number.isFinite(Number(cfg.bboxH)) && Number(cfg.bboxH) > 0 ? Number(cfg.bboxH) : state.height;
      state.bboxW = bw0;
      state.bboxH = bh0;
      state.margin = fin(cfg.margin, 1.06);
      state.distK = Number.isFinite(Number(cfg.distK)) && Number(cfg.distK) > 0 ? Number(cfg.distK) : 1;
      var minY = Number(cfg.bboxMinY), maxY = Number(cfg.bboxMaxY);
      if (Number.isFinite(minY) && Number.isFinite(maxY) && maxY > minY) {
        state.targetY = fin(cfg.targetY, (minY + maxY) * 0.5);
      } else {
        state.targetY = fin(cfg.targetY, state.height * 0.52) || state.height * 0.52;
      }
      state.dist = fitDist(camera.aspect || 1);
      camSpring.dist.jump(state.dist);
      camSpring.targetY.jump(state.targetY);
      camSpring.el.jump(cfg.elevation == null ? 0.09 : cfg.elevation);
      camSpring.az.jump(cfg.azimuth == null ? 0 : cfg.azimuth);
      var h = state.height;
      var bw = state.bboxW || h * 0.6;
      shadow.scale.set(Math.max(bw * 1.18, h * 0.5), Math.max(bw * 0.5, h * 0.26), 1);
      shadow.position.set(0, 0.004, 0);
      glow.position.set(0, h * 0.58, -h * 0.55);
      glow.scale.set(h * 1.0, h * 1.2, 1);
      api.setGlow(cfg.glowColor);
      updateCamera(true);
      return api;
    },

    setGlow: function (hex) {
      if (hex == null) return api;
      var c = new THREE.Color(hex);
      glowMat.color.copy(c);
      shadowMat.color.copy(c).multiplyScalar(0.55).lerp(new THREE.Color(0x241820), 0.55);
      state.glowColor = hex;
      return api;
    },

    setSize: function (w, h) {
      state.width = Math.max(1, Number.isFinite(Number(w)) ? Number(w) : 1);
      state.heightPx = Math.max(1, Number.isFinite(Number(h)) ? Number(h) : 1);
      renderer.setSize(state.width, state.heightPx, false);
      camera.aspect = state.width / state.heightPx;
      camera.updateProjectionMatrix();
      state.dist = fitDist(camera.aspect);
      camSpring.dist.jump(state.dist);
      if (state.bustOn) api.applyBust();
      else camSpring.targetY.jump(state.targetY);
      updateCamera(true);
      return api;
    },

    setOrbit: function (az, el) {
      if (az != null) camSpring.az.set(K.clamp(az, -1.35, 1.35));
      if (el != null) camSpring.el.set(K.clamp(el, -0.05, 0.55));
      return api;
    },
    orbitTo: function (az, el) { return api.setOrbit(az, el); },
    /** 半身取景：拉近相机 + 目标上移到上半身（小窗口脸更大）；幂等：off 恢复全身 */
    bust: function (on) {
      state.bustOn = !!on;
      api.applyBust();
      return api;
    },
    applyBust: function () {
      if (state.bustOn) {
        camSpring.dist.set(state.dist * 0.62);
        camSpring.targetY.set(state.targetY + (state.bboxH || state.height) * 0.22);
      } else {
        camSpring.dist.set(state.dist);
        camSpring.targetY.set(state.targetY);
      }
      return api;
    },
    /** 直接摆位（实验室做多视角图用，不做角度限制） */
    hard: function (az, el, dist, targetY) {
      if (az != null) camSpring.az.jump(az);
      if (el != null) camSpring.el.jump(el);
      if (dist != null) { camSpring.dist.jump(dist); state.dist = dist; }
      if (targetY != null) { camSpring.targetY.jump(targetY); state.targetY = targetY; }
      updateCamera(true);
      return api;
    },
    getOrbit: function () { return { az: camSpring.az.target, el: camSpring.el.target }; },
    getCam: function () {
      return {
        dist: +camSpring.dist.value.toFixed(2), distT: +camSpring.dist.target.toFixed(2),
        ty: +camSpring.targetY.value.toFixed(2), tyT: +camSpring.targetY.target.toFixed(2),
        stateDist: +state.dist.toFixed(2), stateTy: +state.targetY.toFixed(2), stateH: state.height, bboxH: state.bboxH,
      };
    },

    setNight: function (v) { K.setNight(v); return api; },
    setQuality: function (q) {
      quality = q || "high";
      dprCap = quality === "low" ? 1 : quality === "medium" ? 1.5 : 2;
      renderer.setPixelRatio(Math.min(dprCap, window.devicePixelRatio || 1));
      renderer.setSize(state.width, state.heightPx, false);
      return api;
    },
    setLight: function (x, y, z) { K.setLightDir(x, y, z); return api; },

    tick: function (dt) {
      camSpring.az.update(dt);
      camSpring.el.update(dt);
      camSpring.dist.update(dt);
      camSpring.targetY.update(dt);
      updateCamera();
      return api;
    },

    render: function () {
      renderer.render(scene, camera);
      return api;
    },

    /** 导出画面为 dataURL（同一 task 内先渲染，否则 drawing buffer 已被清空 → 全透明图） */
    snapshot: function () {
      try {
        renderer.render(scene, camera);
        return renderer.domElement.toDataURL("image/png");
      } catch (e) { return ""; }
    },

    dispose: function () {
      try { scene.traverse(function (obj) { if (obj.isMesh || obj.isSprite) { if (obj.geometry) obj.geometry.dispose(); if (obj.material) obj.material.dispose(); } }); } catch (e) {}
      try { renderer.dispose(); } catch (e) {}
      try { renderer.domElement.remove(); } catch (e) {}
      try { glowTex.dispose(); shadowTex.dispose(); } catch (e) {}
    },
  };
  api.setGlow(0xff6f96);
  return api;
};
