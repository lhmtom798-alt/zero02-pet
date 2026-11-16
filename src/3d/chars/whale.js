/**
 * chars.whale —— 鲸鲸：DeepSeek 鲸鱼娘 3D 手办（Q 版 · 约 2.2 头身）
 *
 * 形象要点（对照 _assets/whale-*.webp）：
 *   蓝色渐层长发（过腰、波浪外扩）/ 白色荷叶边女仆头饰 + 侧边蓝蝴蝶结 /
 *   鳍状耳 / 鲸鱼尾巴（贴身盘起、可摆动）/ 深蓝长款女仆裙 +
 *   白色荷叶边围裙（小鲸鱼印花）/ 蓝眼睛 / 双手在胸前交握 / 白袜小鞋 / 呆毛。
 *
 * 只依赖注入的 K / FIG / THREE；不修改底层工具。kit 里 K.ribbon / K.strand 的
 * 三角形绕向是反的（法线朝内），本文件用 flipWinding() 在本地修正，不触碰 kit.js。
 */
module.exports.create = function (K, FIG, THREE) {
  var PI = Math.PI, TAU = PI * 2, D = PI / 180;
  var V3 = THREE.Vector3;
  var DOWN = new V3(0, -1, 0);

  /* ============================== 参数 ============================== */
  var P = {
    height: 3.6,
    camera: { height: 3.6, targetY: 1.9, margin: 1.05, elevation: 0.08, glowColor: 0x6fb7ff },
    R: 0.82,              // 头半径（约 2.2 头身）
    headY: 2.45,          // 头心高度（下巴约 1.69）
    neckY: 1.72,          // 头部旋转枢轴
    shoulderY: 1.50,
    shoulderX: 0.30,
    armL1: 0.33,          // 肩 -> 肘
    armL2: 0.35,          // 肘 -> 手心
    colors: {
      skin: 0xffd2b6, skinShade: 0xeb9c84,
      hair: 0x5588ee, hairLight: 0x7fadf8, hairBack: 0x3f6bd0, hairDark: 0x2e55af,
      hairShade: 0x2b52b8, hairShadeLight: 0x4a76d0, hairShadeBack: 0x24479c, hairShadeDark: 0x1c3a7c,
      hairHi: 0xcfe8ff, hairRim: 0xa8d4ff,
      white: 0xf9f8fd, whiteShade: 0xdfe0ee,
      apron: 0xfbfaff, apronShade: 0xdeddec,
      navy: 0x202c57, navyShade: 0x0f1738,
      skirt: 0x2f56a8, skirtShade: 0x19336a,
      band: 0x3f6fc8, bandShade: 0x24488c,
      gold: 0xd4b26a, goldShade: 0x8a7138,
      tail: 0x33559e, tailShade: 0x1c3266,
      fluke: 0x2f5299, flukeShade: 0x1b3568,
      shoe: 0x1f2b58, shoeShade: 0x0f1633, shoeHi: 0x4266b8,
      bowBlue: 0x4a9be8, bowBlueShade: 0x2266b0,
      dark: 0x161c38,
      fin: 0x2a3b6e, finShade: 0x172447, finWhite: 0xf4f3f9,
      cookie: 0xd9a45c, cookieShade: 0x9c6b32, choco: 0x5a3520,
      heart: 0xff8fb0,
      outline: 0x1e2140,
    },
    eye: {
      iris: ["#2a63cc", "#4fa0f0", "#b8ecff"],
      lash: "#1b2245",
      brow: "#7e97ce",
      round: 0.94,
      sclera: "#fbfbff",
    },
    mouth: { lip: "#c0607c", inner: "#9a3b55" },
  };

  /* ============================ 通用几何工具 ============================ */
  /** 头部球面坐标（theta 自头顶 0°，phi 0° 朝 +Z 正前），k = 头半径倍数 -> 世界坐标 */
  function hp(thDeg, phDeg, k) {
    var th = thDeg * D, ph = phDeg * D;
    var r = P.R * (k == null ? 1 : k);
    return [r * Math.sin(th) * Math.sin(ph), r * Math.cos(th), r * Math.sin(th) * Math.cos(ph)];
  }

  function pseudo(i) {
    var v = Math.sin(i * 127.1 + 311.7) * 43758.5453;
    return v - Math.floor(v);
  }

  /**
   * kit 的 K.ribbon / K.strand 三角形绕向是反的（法线朝内）。
   * 本地翻转索引并重算法线，让它们成为正常实体，卡通材质 / 反壳描边都正常。
   */
  function flipWinding(geo) { return geo; /* kit 已修正绕向，这里不再翻转 */ }

  function damp(cur, target, dt, k) {
    return cur + (target - cur) * (1 - Math.exp(-k * dt));
  }

  /** 沿发丝宽度：根部宽、中段最宽、尖端收成点（柔和的收尖） */
  function wArr(w, n) {
    var out = [];
    for (var i = 0; i < n; i++) {
      var t = i / (n - 1);
      out.push(w * (0.78 + 0.22 * Math.sin(PI * t)) * (1 - Math.pow(t, 1.9)));
    }
    out[n - 1] = Math.max(0.0045, out[n - 1]);
    return out;
  }

  /* ============================== 构建 ============================== */
  function build() {
    var C = P.colors, R = P.R;
    var root = new THREE.Group();
    var OL = { thickness: 0.0092, color: C.outline };   // 主体厚描边
    var OL2 = { thickness: 0.0050, color: C.outline };  // 头发 / 小件
    var OL3 = { thickness: 0.0034, color: C.outline };  // 荷叶边
    var extraTex = [];

    /* -------------------- 头发渐层贴图（发根亮 -> 发梢深） -------------------- */
    var hairGrad = K.canvasTexWH(4, 256, function (x, w, h) {
      var g = x.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0.0, "rgb(64,118,198)");     // 发梢（画布顶部 = v=1）
      g.addColorStop(0.30, "rgb(130,168,230)");
      g.addColorStop(0.60, "rgb(210,226,250)");
      g.addColorStop(1.0, "rgb(255,255,255)");    // 发根
      x.fillStyle = g;
      x.fillRect(0, 0, w, h);
    });
    extraTex.push(hairGrad);

    /** 头发专用：在 K.cel 上挂一张沿 uv.y 的渐层贴图 */
    function gradMat(opts) {
      var m = K.cel(opts);
      var fs = m.fragmentShader;
      if (fs.indexOf("uniform float uNight;") >= 0 &&
        fs.indexOf("c = mix(c, uHi, hi * uHiStr);") >= 0) {
        fs = fs.replace("uniform float uNight;", "uniform float uNight;\nuniform sampler2D uGradTex;");
        fs = fs.replace("c = mix(c, uHi, hi * uHiStr);",
          "c = mix(c, uHi, hi * uHiStr);\n  c *= texture2D(uGradTex, vec2(0.5, clamp(vUv.y, 0.0, 1.0))).rgb;");
        m.fragmentShader = fs;
        m.uniforms.uGradTex = { value: hairGrad };
        m.needsUpdate = true;
      }
      return m;
    }

    /* ------------------------------ 材质 ------------------------------ */
    var M = {};
    M.skin = K.cel({ color: C.skin, shade: C.skinShade, rim: 0xffd8e4, rimStr: 0.14, hiStr: 0.05, lift: 0.40, shadeAmt: 0.88 });
    M.white = K.cel({ color: C.white, shade: C.whiteShade, rim: 0xffffff, rimStr: 0.22, hiStr: 0.14, lift: 0.55 });
    M.whiteFrill = K.cel({ color: 0xfdfcff, shade: 0xe7e8f4, rim: 0xffffff, rimStr: 0.18, hiStr: 0.10, lift: 0.6, shadeAmt: 0.9, side: THREE.DoubleSide });
    M.apron = K.cel({ color: C.apron, shade: C.apronShade, rim: 0xffffff, rimStr: 0.20, hiStr: 0.12, lift: 0.55 });
    M.navy = K.cel({ color: C.navy, shade: C.navyShade, rim: 0x7fa8ff, rimStr: 0.26, hiStr: 0.32 });
    M.skirt = K.cel({ color: C.skirt, shade: C.skirtShade, rim: 0x8fc6ff, rimStr: 0.26, hiStr: 0.32 });
    M.band = K.cel({ color: C.band, shade: C.bandShade, rim: 0x9cc6ff, rimStr: 0.20, hiStr: 0.26 });
    M.gold = K.cel({ color: C.gold, shade: C.goldShade, rim: 0xffe6a8, rimStr: 0.20, hiStr: 0.35, spec: 0.10, specPow: 24 });
    M.tail = K.cel({ color: C.tail, shade: C.tailShade, rim: 0x8fc6ff, rimStr: 0.26, hiStr: 0.30, spec: 0.05, specPow: 18, side: THREE.DoubleSide });
    M.fluke = K.cel({ color: C.fluke, shade: C.flukeShade, rim: 0x8fc6ff, rimStr: 0.24, hiStr: 0.28, side: THREE.DoubleSide });
    M.shoe = K.cel({ color: C.shoe, shade: C.shoeShade, hi: C.shoeHi, rim: 0x8fb8ff, rimStr: 0.30, hiStr: 0.35, spec: 0.12, specPow: 30 });
    M.dark = K.cel({ color: C.dark, shade: 0x0b1024, rim: 0x7f9fe8, rimStr: 0.18, lift: 0.2 });
    M.bow = K.cel({ color: C.bowBlue, shade: C.bowBlueShade, rim: 0xb8e4ff, rimStr: 0.24, hiStr: 0.30 });
    M.fin = K.cel({ color: C.fin, shade: C.finShade, rim: 0x9cc6ff, rimStr: 0.25, hiStr: 0.25, side: THREE.DoubleSide });
    M.finWhite = K.cel({ color: C.finWhite, shade: 0xd9dbe8, rim: 0xffffff, rimStr: 0.20, side: THREE.DoubleSide });
    M.cookie = K.cel({ color: C.cookie, shade: C.cookieShade, rim: 0xf5d9a0, rimStr: 0.2, hiStr: 0.25 });
    M.choco = K.cel({ color: C.choco, shade: 0x2e190c, rim: 0xa07850, rimStr: 0.15 });
    M.heart = K.cel({ color: C.heart, shade: 0xd85a80, hi: 0xffc9dc, rim: 0xffd0e0, rimStr: 0.3, hiStr: 0.3 });
    M.hair = gradMat({ color: C.hair, shade: C.hairShade, hi: C.hairHi, rim: C.hairRim, rimStr: 0.26, hiStr: 0.34, spec: 0.05, specPow: 16, side: THREE.DoubleSide });
    M.hairLight = gradMat({ color: C.hairLight, shade: C.hairShadeLight, hi: C.hairHi, rim: C.hairRim, rimStr: 0.28, hiStr: 0.36, side: THREE.DoubleSide });
    M.hairBack = gradMat({ color: C.hairBack, shade: C.hairShadeBack, hi: C.hairHi, rim: C.hairRim, rimStr: 0.24, hiStr: 0.28, side: THREE.DoubleSide });
    M.hairDark = gradMat({ color: C.hairDark, shade: C.hairShadeDark, hi: C.hairHi, rim: C.hairRim, rimStr: 0.20, hiStr: 0.22, side: THREE.DoubleSide });
    M.shine = new THREE.MeshBasicMaterial({ color: 0xb2d8ff, transparent: true, opacity: 0.32, depthWrite: false, side: THREE.DoubleSide });

    /** 建一个 mesh 的小工具 */
    function mesh(geo, mat, parent, pos, outline) {
      var m = new THREE.Mesh(geo, mat);
      if (pos) m.position.set(pos[0] || 0, pos[1] || 0, pos[2] || 0);
      if (parent) parent.add(m);
      if (outline) K.outline(m, outline);
      return m;
    }

    /** 发片 / 布条：K.ribbon + 局部修正绕向 */
    function ribbon(parent, opts, mat, outline) {
      var g = flipWinding(K.ribbon(opts));
      var m = new THREE.Mesh(g, mat);
      if (!outline) m.userData.noOutline = true;
      parent.add(m);
      if (outline) K.outline(m, outline);
      return m;
    }

    /** 圆管（尾巴）：K.strand + 局部修正绕向 */
    function strand(parent, opts, mat, outline) {
      var g = flipWinding(K.strand(opts));
      var m = new THREE.Mesh(g, mat);
      parent.add(m);
      if (outline) K.outline(m, outline);
      return m;
    }

    /* ============================== 身体 ============================== */
    var body = K.group(root);        // 整体上下弹跳
    var torso = K.group(body);       // 呼吸缩放
    var legsG = K.group(root);       // 腿不跟着上半身弹

    // 裙子车削剖面（从下往上！长裙，裙摆接近脚踝）
    var PROF = [
      [0.760, 0.400], [0.778, 0.432], [0.762, 0.474], [0.716, 0.540],
      [0.656, 0.624], [0.592, 0.712], [0.528, 0.808], [0.470, 0.900],
      [0.421, 0.994], [0.382, 1.084], [0.352, 1.165], [0.332, 1.237],
      [0.322, 1.300],
    ];
    function profR(y) {
      if (y <= PROF[0][1]) return PROF[0][0];
      for (var i = 0; i < PROF.length - 1; i++) {
        var a = PROF[i], b = PROF[i + 1];
        if (y >= a[1] && y <= b[1]) {
          var t = (y - a[1]) / Math.max(0.0001, b[1] - a[1]);
          return a[0] + (b[0] - a[0]) * t;
        }
      }
      return PROF[PROF.length - 1][0];
    }
    function surfPt(y, phi, off) {
      var r = profR(y) + (off || 0);
      return [r * Math.sin(phi), y, r * Math.cos(phi)];
    }

    /* ---------------- 裙子（宝蓝，长款） ---------------- */
    var skirt = mesh(K.lathe(PROF, 48), M.skirt, torso, null, OL);
    skirt.name = "skirt";
    var skirtCap = mesh(new THREE.CircleGeometry(0.756, 32), M.navy, torso, [0, 0.404, 0]);
    skirtCap.rotation.x = PI / 2;

    // 裙摆浅蓝装饰带 + 金色滚边
    var bandProf = [
      [profR(0.470) + 0.016, 0.470], [profR(0.506) + 0.014, 0.506],
      [profR(0.542) + 0.011, 0.542], [profR(0.552) + 0.008, 0.552],
    ];
    mesh(K.lathe(bandProf, 48), M.band, torso, null, OL3);
    var bandTop = new THREE.Mesh(K.ring(profR(0.552) + 0.012, 0.008, TAU, 8), M.gold);
    bandTop.rotation.x = PI / 2; bandTop.scale.set(1, 1, 0.8);
    bandTop.position.y = 0.552; torso.add(bandTop);
    var bandBot = new THREE.Mesh(K.ring(profR(0.472) + 0.022, 0.007, TAU, 8), M.gold);
    bandBot.rotation.x = PI / 2; bandBot.scale.set(1, 1, 0.8);
    bandBot.position.y = 0.472; torso.add(bandBot);

    // 裙侧金色刺绣（S 形细线 + 金点，主要露在围裙两侧）
    [1, -1].forEach(function (sd) {
      var pts = [];
      for (var i = 0; i <= 7; i++) {
        var yy = 0.58 + i * 0.075;
        var ph = sd * (0.66 + Math.sin(i * 0.85) * 0.14);
        pts.push(surfPt(yy, ph, 0.010));
      }
      ribbon(torso, { pts: pts, widths: [0.020, 0.014], thick: 0.010, ref: [0, 1, 0], seg: 14, radial: 4 }, M.gold, null);
      for (var k = 0; k < 4; k++) {
        var yy2 = 0.62 + k * 0.14;
        mesh(K.sphere(0.015, 1, 1, 0.7, 8), M.gold, torso, surfPt(yy2, sd * (0.92 + k * 0.02), 0.012));
      }
    });

    /* ---------------- 白色衬裙荷叶边（裙摆下露一圈） ---------------- */
    var petProf = [[0.754, 0.360], [0.762, 0.384], [0.766, 0.408], [0.762, 0.438]];
    mesh(K.lathe(petProf, 40), M.whiteFrill, torso, null, OL3);
    (function () {
      var n = 28, rr = 0.754;
      for (var i = 0; i < n; i++) {
        var ph = (i / n) * TAU;
        var p = [rr * Math.sin(ph), 0.368, rr * Math.cos(ph)];
        var fr = mesh(K.sphere(0.056, 1.28, 0.62, 0.72, 10), M.whiteFrill, torso, p, OL3);
        fr.rotation.y = ph;
      }
    })();

    /* ---------------- 上身（深藏青） ---------------- */
    var bodiceProf = PROF.filter(function (p) { return p[1] >= 1.18; }).map(function (p) {
      return [p[0] + 0.014, p[1]];
    });
    mesh(K.lathe(bodiceProf, 40), M.navy, torso, null, OL);
    // 腰封
    var beltY = 1.255;
    var belt = new THREE.Mesh(K.ring(profR(beltY) + 0.022, 0.038, TAU, 10), M.dark);
    belt.rotation.x = PI / 2; belt.scale.set(1, 1, 0.62);
    belt.position.y = beltY; torso.add(belt);
    mesh(K.sphere(0.028, 1.3, 0.9, 0.8, 10), M.gold, torso, [0, beltY, profR(beltY) + 0.040]);

    // 领口白边 + 荷叶（贴着下巴，遮住脖子）
    var collar = new THREE.Mesh(K.ring(0.225, 0.044, TAU, 12), M.white);
    collar.rotation.x = PI / 2; collar.scale.set(1, 1, 0.62);
    collar.position.y = 1.662; torso.add(collar);
    for (var ci = 0; ci < 11; ci++) {
      var caph = (ci / 11) * TAU;
      mesh(K.sphere(0.034, 1.20, 0.62, 0.8, 8), M.whiteFrill, torso,
        [0.225 * Math.sin(caph), 1.684, 0.225 * Math.cos(caph)], OL3);
    }
    // 黑色小蝴蝶结（领口）
    var neckBow = K.group(torso, [0, 1.592, 0.245]);
    neckBow.rotation.x = -0.22;
    [1, -1].forEach(function (sd) {
      var lp = mesh(K.sphere(0.064, 1.45, 0.9, 0.62, 10), M.dark, neckBow, [sd * 0.058, 0, 0], OL3);
      lp.rotation.z = sd * 0.28;
    });
    mesh(K.sphere(0.031, 1, 1, 0.9, 10), M.dark, neckBow, [0, 0, 0.012], OL3);
    [-1, 1].forEach(function (sd) {
      ribbon(neckBow, {
        pts: [[sd * 0.02, -0.01, 0], [sd * 0.05, -0.08, 0.01], [sd * 0.065, -0.15, 0.02]],
        widths: [0.044, 0.030], thick: 0.012, ref: [1, 0, 0], seg: 8, radial: 4,
      }, M.dark, null);
    });

    /* ---------------- 白色围裙 ---------------- */
    var bibProf = [];
    for (var by = 1.24; by <= 1.640; by += 0.05) bibProf.push([profR(by) + 0.024, by]);
    mesh(K.lathe(bibProf, 32, -0.46, 0.92), M.apron, torso, null, OL3);
    var apronProf = [];
    for (var ay = 0.470; ay <= 1.285; ay += 0.045) apronProf.push([profR(ay) + 0.028, ay]);
    var apron = mesh(K.lathe(apronProf, 44, -0.74, 1.48), M.apron, torso, null, OL3);
    apron.name = "apron";

    // 围裙荷叶边（压扁的荷叶，不要像珍珠）
    (function () {
      var i, n;
      n = 15;
      for (i = 0; i < n; i++) {
        var ph = -0.74 + (i / (n - 1)) * 1.48;
        var p = surfPt(0.476, ph, 0.040);
        var fr = mesh(K.sphere(0.050, 1.25, 0.62, 0.75, 10), M.whiteFrill, torso, p, OL3);
        fr.rotation.y = ph;
      }
      [-0.74, 0.74].forEach(function (ph) {
        for (var j = 0; j < 8; j++) {
          var yy = 0.540 + j * 0.098;
          mesh(K.sphere(0.038, 1.1, 0.62, 0.72, 10), M.whiteFrill, torso, surfPt(yy, ph, 0.038), OL3);
        }
      });
      [-0.46, 0.46].forEach(function (ph) {
        for (var j = 0; j < 4; j++) {
          var yy = 1.265 + j * 0.100;
          mesh(K.sphere(0.032, 1.05, 0.62, 0.72, 10), M.whiteFrill, torso, surfPt(yy, ph, 0.036), OL3);
        }
      });
      for (var q = 0; q < 5; q++) {
        var ph2 = -0.46 + (q / 4) * 0.92;
        mesh(K.sphere(0.030, 1.05, 0.62, 0.72, 10), M.whiteFrill, torso, surfPt(1.648, ph2, 0.034), OL3);
      }
    })();

    // 围裙上的小鲸鱼印花
    var whaleTex = K.canvasTexWH(256, 256, function (x, w, h) {
      x.clearRect(0, 0, w, h);
      x.save();
      x.translate(w / 2, h / 2 + 6);
      x.strokeStyle = "#2c447e";
      x.lineWidth = 7;
      x.lineCap = "round";
      x.beginPath(); x.moveTo(-6, -36); x.quadraticCurveTo(-24, -58, -8, -70); x.stroke();
      x.beginPath(); x.moveTo(12, -36); x.quadraticCurveTo(30, -52, 18, -66); x.stroke();
      x.fillStyle = "#2c447e";
      x.beginPath();
      x.moveTo(44, -6);
      x.bezierCurveTo(70, -40, 96, -44, 106, -30);
      x.bezierCurveTo(94, -22, 82, -8, 78, 4);
      x.bezierCurveTo(92, 6, 100, 16, 104, 28);
      x.bezierCurveTo(84, 22, 62, 14, 46, 8);
      x.closePath();
      x.fill();
      x.beginPath();
      x.ellipse(-4, 2, 64, 42, -0.10, 0, TAU);
      x.fill();
      x.fillStyle = "#ffffff";
      x.beginPath(); x.ellipse(-36, -10, 9, 10, 0, 0, TAU); x.fill();
      x.fillStyle = "#2c447e";
      x.beginPath(); x.ellipse(-34, -8, 4.5, 5.5, 0, 0, TAU); x.fill();
      x.fillStyle = "rgba(255,255,255,0.80)";
      x.beginPath(); x.ellipse(-12, 18, 40, 22, -0.10, 0, TAU); x.fill();
      x.restore();
    });
    extraTex.push(whaleTex);
    var whaleDecal = new THREE.Mesh(new THREE.PlaneGeometry(0.30, 0.30), K.decal(whaleTex));
    whaleDecal.userData.noOutline = true;
    whaleDecal.position.set(0, 1.00, profR(1.00) + 0.040);
    whaleDecal.rotation.x = -0.42;
    whaleDecal.renderOrder = 2;
    torso.add(whaleDecal);

    // 背后围裙蝴蝶结
    var backBow = K.group(torso, [0, 1.265, -(profR(1.265) + 0.03)]);
    [1, -1].forEach(function (sd) {
      var lp = mesh(K.sphere(0.088, 1.5, 0.95, 0.6, 12), M.white, backBow, [sd * 0.078, 0.02, -0.01], OL3);
      lp.rotation.z = sd * 0.3;
    });
    mesh(K.sphere(0.038, 1, 1, 0.9, 10), M.white, backBow, [0, 0.01, 0.01], OL3);
    [-1, 1].forEach(function (sd) {
      ribbon(backBow, {
        pts: [[sd * 0.03, 0, 0], [sd * 0.065, -0.15, -0.02], [sd * 0.055, -0.30, -0.04]],
        widths: [0.078, 0.056], thick: 0.018, ref: [1, 0, 0], seg: 10, radial: 5,
      }, M.white, OL3);
    });

    /* ============================== 腿脚 ============================== */
    [1, -1].forEach(function (side) {
      var leg = K.group(legsG, [side * 0.145, 0, 0]);
      mesh(K.capsule(0.082, 0.28, 8), M.white, leg, [0, 0.32, 0], OL2);
      var sockCuff = new THREE.Mesh(K.ring(0.088, 0.018, TAU, 8), M.whiteFrill);
      sockCuff.rotation.x = PI / 2; sockCuff.scale.set(1, 1, 0.72);
      sockCuff.position.y = 0.435; leg.add(sockCuff);
      var shoe = K.group(leg, [0, 0.108, 0.052]);
      var sMesh = mesh(K.sphere(0.102, 1.14, 0.98, 1.48, 16), M.shoe, shoe, [0, 0.010, 0], OL2);
      sMesh.rotation.x = -0.06;
      mesh(K.sphere(0.112, 1.02, 0.40, 1.42, 14), M.shoe, shoe, [0, -0.046, 0.008], OL2);
      mesh(K.sphere(0.030, 1.5, 0.6, 1.0, 8), M.shoe, shoe, [side * 0.032, 0.090, 0.052]);
      var strap = new THREE.Mesh(K.ring(0.096, 0.014, TAU, 8), M.dark);
      strap.rotation.x = PI / 2; strap.scale.set(1, 1, 0.62);
      strap.position.y = 0.080; shoe.add(strap);
      mesh(K.sphere(0.018, 1, 1, 1, 8), M.gold, shoe, [side * 0.088, 0.080, 0.0], OL3);
    });

    /* ============================== 手臂 ============================== */
    function armMesh(side) {
      var L1 = P.armL1, L2 = P.armL2;
      var g = K.group(torso, [side * P.shoulderX, P.shoulderY, 0.01]);
      mesh(K.sphere(0.118, 1.06, 0.96, 1.02, 16), M.navy, g, [side * 0.006, -0.012, 0], OL2);
      mesh(K.capsule(0.066, L1 - 0.132, 8), M.navy, g, [0, -L1 / 2, 0], OL2);
      var elbow = K.group(g, [0, -L1, 0]);
      mesh(K.capsule(0.059, L2 - 0.118, 8), M.navy, elbow, [0, -L2 / 2, 0], OL2);
      // 白袖口 + 荷叶
      mesh(K.cylinder(0.072, 0.078, 0.060, 14), M.white, elbow, [0, -L2 + 0.048, 0]);
      var cuffFrill = new THREE.Mesh(K.ring(0.077, 0.016, TAU, 8), M.whiteFrill);
      cuffFrill.rotation.x = PI / 2; cuffFrill.scale.set(1, 1, 0.7);
      cuffFrill.position.y = -L2 + 0.016; elbow.add(cuffFrill);
      var goldCuff = new THREE.Mesh(K.ring(0.073, 0.007, TAU, 8), M.gold);
      goldCuff.rotation.x = PI / 2; goldCuff.scale.set(1, 1, 0.8);
      goldCuff.position.y = -L2 + 0.080; elbow.add(goldCuff);
      var wrist = K.group(elbow, [0, -L2, 0]);
      mesh(K.sphere(0.074, 1.0, 1.06, 0.88, 16), M.skin, wrist, [0, -0.044, 0.008], OL3);
      mesh(K.sphere(0.028, 1.0, 1.25, 0.9, 8), M.skin, wrist, [side * 0.045, -0.028, 0.032], OL3);
      return { root: g, elbow: elbow, wrist: wrist, hand: wrist.children[0], side: side };
    }
    var arms = { "1": armMesh(1), "-1": armMesh(-1) };

    /* ---------------- 交握的双手（跟随躯干，在胸前） ---------------- */
    var claspedG = K.group(torso, [0, 1.512, 0.455]);
    claspedG.scale.setScalar(1.12);
    claspedG.rotation.set(-0.18, 0, 0.0);
    [1, -1].forEach(function (sd) {
      var palm = mesh(K.sphere(0.064, 1.0, 1.30, 0.85, 14), M.skin, claspedG, [sd * 0.056, 0.0, 0.0]);
      palm.rotation.z = sd * 0.12;
      // 手指（向上并拢）
      for (var f = 0; f < 4; f++) {
        var fx = sd * (0.028 + f * 0.015);
        var fy = 0.070 - f * 0.004;
        var fg = mesh(K.sphere(0.020, 0.85, 1.9, 0.85, 8), M.skin, claspedG,
          [fx, fy, 0.004 - f * 0.002], OL3);
        fg.rotation.z = sd * (0.10 + f * 0.03);
      }
      // 拇指
      mesh(K.sphere(0.024, 0.9, 1.5, 0.9, 8), M.skin, claspedG, [sd * 0.012, 0.028, 0.040], OL3);
    });
    // 手腕上的白色荷叶袖口
    [1, -1].forEach(function (sd) {
      var cf = new THREE.Mesh(K.ring(0.058, 0.017, TAU, 10), M.whiteFrill);
      cf.rotation.x = PI / 2; cf.scale.set(1, 1, 0.75);
      cf.position.set(sd * 0.098, -0.062, -0.020);
      claspedG.add(cf);
      K.outline(cf, OL3);
    });

    /* ============================== 脖子 + 头 ============================== */
    mesh(K.cylinder(0.098, 0.110, 0.16, 16), M.skin, torso, [0, P.neckY - 0.03, 0], OL2);

    var headPivot = K.group(torso, [0, P.neckY, 0.0]);
    var headRoot = K.group(headPivot, [0, P.headY - P.neckY, 0.0]);

    /* ---------------- 五官（fig.head） ---------------- */
    var head = FIG.head({
      R: R,
      scale: [1.02, 0.975, 0.99],
      skin: C.skin, skinShade: C.skinShade,
      eye: P.eye,
      eyeX: 0.42, eyeY: -0.09, eyeW: 0.585, eyeH: 0.595,
      mouth: { kind: "smile", lip: P.mouth.lip, inner: P.mouth.inner },
      mouthY: -0.475,
      blush: true, blushColor: "rgba(255,120,150,0.55)", blushOpacity: 0.62,
      outline: C.outline,
      jaw: 0.17,
    });
    headRoot.add(head.group);

    // 两只眼睛独立控制（wink / 睡姿等）
    var eyeTexCache = {};
    function eyeTexture(mood, mirror) {
      var key = mood + (mirror ? "R" : "L");
      if (!eyeTexCache[key]) {
        eyeTexCache[key] = FIG.eyeTexture({
          iris: P.eye.iris, lash: P.eye.lash, brow: P.eye.brow,
          round: P.eye.round, sclera: P.eye.sclera, high: 1,
          mood: mood, mirror: mirror,
        });
      }
      return eyeTexCache[key];
    }
    var curEye = ["open", "open"];
    function setEyes(l, r) {
      if (curEye[0] === l && curEye[1] === r) return;
      curEye[0] = l; curEye[1] = r;
      head.face.eyeL.material.map = eyeTexture(l, false);
      head.face.eyeR.material.map = eyeTexture(r, true);
      head.face.eyeL.material.needsUpdate = true;
      head.face.eyeR.material.needsUpdate = true;
    }

    // 嘴型缓存
    var mouthTex = {};
    ["smile", "open", "grin", "cat", "shy", "o", "wavy"].forEach(function (k) {
      mouthTex[k] = FIG.mouthTexture({ kind: k, lip: P.mouth.lip, inner: P.mouth.inner });
    });
    var curMouth = "smile";
    function setMouth(kind) {
      if (curMouth === kind || !mouthTex[kind]) return;
      curMouth = kind;
      head.face.mouth.material.map = mouthTex[kind];
      head.face.mouth.material.needsUpdate = true;
    }

    /* ============================== 头发 ============================== */
    var hairGroup = K.group(headRoot);   // 刘海 / 头顶
    var backHairG = K.group(headRoot);   // 后发（整体轻摆）
    var crownG = K.group(headRoot);      // 女仆头饰
    var finG = K.group(headRoot);        // 鳍状耳
    var ahogeG = K.group(headRoot);      // 呆毛

    // 基础发壳
    var capMesh = new THREE.Mesh(FIG.hairCap(R, { scale: 1.04, thetaFront: 0.33, thetaBack: 0.94 }), M.hair);
    K.outline(capMesh, OL2);
    hairGroup.add(capMesh);

    /** 垂落发束：head 球面起笔 -> 外扩波浪 -> 收尖（尾端带小钩） */
    function fallPts(phDeg, drop, flare, wave, phase, rad0) {
      var ph = phDeg * D, s = Math.sin(ph), c = Math.cos(ph);
      var r0 = rad0 == null ? 1.0 : rad0;
      var pts = [hp(10, phDeg, r0), hp(32, phDeg, r0 + 0.035), hp(56, phDeg, r0 + 0.055), hp(80, phDeg, r0 + 0.042)];
      var n = 6;
      var radLast = 0, wobLast = 0, yLast = 0;
      for (var i = 1; i <= n; i++) {
        var t = i / n;
        var y = 0.185 - (0.185 + drop) * t;
        var rad = (r0 + 0.045) + flare * Math.sin(t * PI * 0.92) + 0.05 * t +
          0.045 * Math.sin(t * 5.2 + phase) * t;
        var wob = (Math.sin(t * 2.8 + phase) * 0.66 + Math.sin(t * 5.4 + phase * 1.6) * 0.34) * wave * t;
        pts.push([(s * rad + c * wob) * R, y * R, (c * rad - s * wob) * R]);
        radLast = rad; wobLast = wob; yLast = y;
      }
      // 发梢小钩（向外/向后卷）
      pts.push([(s * (radLast + 0.07) + c * (wobLast + 0.07)) * R, (yLast - 0.09) * R, (c * (radLast + 0.07) - s * (wobLast + 0.07)) * R]);
      return pts;
    }

    // 后发外层（18 束，波浪起伏、长度参差）
    (function () {
      var phis = [92, 102, 112, 122, 132, 142, 152, 162, 172, 182, 192, 202, 212, 222, 232, 242, 252, 262];
      for (var i = 0; i < phis.length; i++) {
        var ph = phis[i];
        var shortSide = (ph > 78 && ph < 128) ? 0.32 : 0;   // 右侧留出尾巴位置
        var drop = 1.62 + pseudo(i) * 0.95 - shortSide;
        var w = (0.245 + pseudo(i + 7) * 0.050) * R;
        var flare = 0.20 + pseudo(i + 3) * 0.18;
        var pts = fallPts(ph, drop, flare, 0.15 + pseudo(i + 9) * 0.11, i * 1.7, 1.0);
        ribbon(backHairG, {
          pts: pts, widths: wArr(w, pts.length), thick: 0.042,
          ref: [Math.cos(ph * D), 0, -Math.sin(ph * D)], seg: 24, radial: 8, tension: 0.34,
        }, i % 3 === 0 ? M.hair : M.hairBack, OL2);
      }
      // 后发内层（10 束，深一点、更短，填补间隙）
      var phis2 = [98, 114, 130, 146, 162, 178, 194, 210, 226, 242];
      for (var j = 0; j < phis2.length; j++) {
        var ph2 = phis2[j];
        var drop2 = 1.25 + pseudo(j + 20) * 0.45;
        var w2 = (0.17 + pseudo(j + 30) * 0.035) * R;
        var pts2 = fallPts(ph2, drop2, 0.10 + pseudo(j + 4) * 0.12, 0.11, j * 2.3 + 1, 0.98);
        ribbon(backHairG, {
          pts: pts2, widths: wArr(w2, pts2.length), thick: 0.036,
          ref: [Math.cos(ph2 * D), 0, -Math.sin(ph2 * D)], seg: 22, radial: 8, tension: 0.34,
        }, M.hairDark, OL2);
      }
    })();

    // 侧发（每边 4 束：贴脸短、中长、长、外扩）
    [1, -1].forEach(function (side) {
      var defs = [
        { phi: 58, drop: 0.95, w: 0.20, flare: 0.08, wave: 0.09, mat: M.hairDark },
        { phi: 69, drop: 1.65, w: 0.24, flare: 0.16, wave: 0.13, mat: M.hair },
        { phi: 81, drop: 2.00, w: 0.26, flare: 0.22, wave: 0.16, mat: M.hairBack },
        { phi: 93, drop: 2.10, w: 0.25, flare: 0.26, wave: 0.18, mat: M.hairBack },
      ];
      for (var i = 0; i < defs.length; i++) {
        var d = defs[i];
        var ph = side * d.phi;
        var pts = fallPts(ph, d.drop, d.flare, d.wave, side * 1.3 + i * 1.9, 1.0);
        ribbon(backHairG, {
          pts: pts, widths: wArr(d.w * R, pts.length), thick: 0.044,
          ref: [Math.cos(ph * D), 0, -Math.sin(ph * D)], seg: 24, radial: 8, tension: 0.35,
        }, d.mat, OL2);
      }
      // 脸侧碎发
      var ptsS = [hp(36, side * 44, 1.005), hp(54, side * 52, 1.035), hp(72, side * 56, 1.05),
        [(side * 0.90) * R, -0.30 * R, 0.42 * R], [(side * 0.86) * R, -0.66 * R, 0.34 * R]];
      ribbon(backHairG, {
        pts: ptsS, widths: wArr(0.14 * R, ptsS.length), thick: 0.034,
        ref: [Math.cos(side * 56 * D), 0, -Math.sin(side * 56 * D)], seg: 16, radial: 6, tension: 0.34,
      }, M.hair, OL2);
    });

    // 刘海（13 束 + 侧扫 2 束；柔和圆尖，不呈锯齿）
    (function () {
      for (var i = 0; i < 17; i++) {
        var t = (i - 8) / 8;
        var odd = i % 2;
        var phi = t * 76;
        var tip = 64 + (1 - Math.abs(t)) * 8 + odd * 5;
        var w = (0.255 - Math.abs(t) * 0.035) * R;
        var ws = wArr(w, 6);
        ws[5] = w * 0.16;
        var pts = [
          hp(4, phi * 0.24, 1.00),
          hp(20, phi * 0.56, 1.024),
          hp(37, phi * 0.80, 1.050),
          hp(50, phi * 0.92, 1.064),
          hp(tip, phi, 1.069),
          hp(tip + 4, phi, 1.071),
        ];
        ribbon(hairGroup, {
          pts: pts, widths: ws, thick: 0.042,
          ref: [Math.cos(phi * D), 0, -Math.sin(phi * D)], seg: 18, radial: 8, tension: 0.36,
        }, M.hair, OL2);
      }
      // 两侧斜扫的刘海（长一点，包住脸颊）
      [1, -1].forEach(function (side) {
        var pts = [
          hp(8, side * 30, 1.005), hp(28, side * 52, 1.032), hp(48, side * 64, 1.056),
          hp(66, side * 70, 1.066), hp(78, side * 74, 1.07), hp(84, side * 76, 1.072),
        ];
        ribbon(hairGroup, {
          pts: pts, widths: wArr(0.20 * R, pts.length), thick: 0.042,
          ref: [Math.cos(side * 60 * D), 0, -Math.sin(side * 60 * D)], seg: 20, radial: 8, tension: 0.36,
        }, M.hairBack, OL2);
      });
      // 亮色发绺点缀
      [-54, -22, 12, 46].forEach(function (ph, i) {
        var pts = [
          hp(9, ph * 0.5, 1.012), hp(27, ph * 0.78, 1.043),
          hp(44, ph * 0.95, 1.064), hp(57 + i * 3, ph, 1.072),
        ];
        ribbon(hairGroup, {
          pts: pts, widths: wArr(0.070 * R, pts.length), thick: 0.022,
          ref: [Math.cos(ph * D), 0, -Math.sin(ph * D)], seg: 14, radial: 6, tension: 0.35,
        }, M.hairLight, null);
      });
    })();

    // 呆毛（长弧 + 卷）
    var ahogePts = [
      [0.02 * R, 1.00 * R, 0.09 * R],
      [-0.01 * R, 1.19 * R, 0.13 * R],
      [-0.13 * R, 1.32 * R, 0.13 * R],
      [-0.31 * R, 1.36 * R, 0.09 * R],
      [-0.47 * R, 1.27 * R, 0.05 * R],
      [-0.53 * R, 1.12 * R, 0.02 * R],
      [-0.43 * R, 1.03 * R, 0.02 * R],
      [-0.29 * R, 1.08 * R, 0.045 * R],
      [-0.23 * R, 1.20 * R, 0.06 * R],
      [-0.26 * R, 1.28 * R, 0.07 * R],
    ];
    ribbon(ahogeG, {
      pts: ahogePts, widths: [0.066 * R, 0.064 * R, 0.060 * R, 0.054 * R, 0.048 * R, 0.044 * R, 0.041 * R, 0.035 * R, 0.024 * R, 0.004 * R],
      thick: 0.020, ref: [0, 0, 1], seg: 24, radial: 6, tension: 0.4,
    }, M.hairLight, OL2);

    /* ---------------------- 女仆头饰（白荷叶边冠） ---------------------- */
    (function () {
      // 白色细头带（贴着发面，不描边避免摩尔纹）
      var bandPts = [];
      for (var a = -18; a <= 378; a += 9) bandPts.push(hp(47, a, 1.112));
      ribbon(crownG, {
        pts: bandPts, widths: [0.052 * R], thick: 0.016,
        ref: [0, 1, 0], seg: 44, radial: 5, tension: 0.3,
      }, M.whiteFrill, null);
      // 五圈荷叶边：从额前发际一直包到头顶，形成蓬松的 bonnet
      var rows = [
        { th: 40, rad: 1.076, n: 22, r: 0.086, sx: 1.52, sy: 0.94, sz: 0.66 },
        { th: 31, rad: 1.064, n: 18, r: 0.080, sx: 1.46, sy: 0.94, sz: 0.64 },
        { th: 22, rad: 1.048, n: 14, r: 0.072, sx: 1.36, sy: 0.94, sz: 0.60 },
      ];
      rows.forEach(function (row, ri) {
        for (var i = 0; i < row.n; i++) {
          var ph = (i / row.n) * TAU + (ri % 2) * 0.16;
          var p = hp(row.th, ph / D, row.rad);
          var puff = new THREE.Mesh(K.sphere(row.r, row.sx, row.sy, row.sz, 12), M.whiteFrill);
          puff.position.set(p[0], p[1], p[2]);
          puff.rotation.y = ph;
          crownG.add(puff);
        }
      });
    })();

    // 侧边蓝蝴蝶结
    (function () {
      var bow = K.group(crownG, [0.68, 0.36, 0.34]);
      bow.rotation.set(-0.12, 1.02, 0.22);
      [1, -1].forEach(function (sd) {
        var lp = mesh(K.sphere(0.068, 1.5, 0.95, 0.55, 10), M.bow, bow, [sd * 0.068, 0, 0], OL3);
        lp.rotation.z = sd * 0.38;
      });
      mesh(K.sphere(0.031, 1.0, 1.0, 0.85, 10), M.bow, bow, [0, 0, 0.012], OL3);
      [-1, 1].forEach(function (sd) {
        ribbon(bow, {
          pts: [[sd * 0.02, -0.02, 0], [sd * 0.055, -0.11, 0.01], [sd * 0.075, -0.20, 0.02]],
          widths: [0.040, 0.028], thick: 0.012, ref: [1, 0, 0], seg: 8, radial: 4,
        }, M.bow, OL3);
      });
    })();

    /* ---------------------- 鳍状耳（挤出形状，白色下鳍） ---------------------- */
    (function () {
      function finShape(scale, sd) {
        var sh = new THREE.Shape();
        function X(v) { return v * scale * sd; }
        var Y = scale;
        sh.moveTo(X(-0.02), 0.082 * Y);
        sh.bezierCurveTo(X(0.15), 0.108 * Y, X(0.31), 0.056 * Y, X(0.43), -0.036 * Y);
        sh.quadraticCurveTo(X(0.320), -0.054 * Y, X(0.258), -0.018 * Y);
        sh.quadraticCurveTo(X(0.208), -0.064 * Y, X(0.142), -0.026 * Y);
        sh.quadraticCurveTo(X(0.082), -0.070 * Y, X(0.016), -0.028 * Y);
        sh.lineTo(X(-0.040), 0.006 * Y);
        sh.closePath();
        return sh;
      }
      [1, -1].forEach(function (side) {
        var g = new THREE.Group();
        g.position.set(side * 0.700, -0.255, 0.300);
        g.rotation.set(0, side * 0.26, -side * 0.88);
        finG.add(g);
        // 白色鳍身（主体，下缘有荷叶边）
        var whiteGeo = new THREE.ExtrudeGeometry(finShape(1.24, side), {
          depth: 0.046, bevelEnabled: true, bevelSize: 0.014, bevelThickness: 0.014,
          bevelSegments: 2, curveSegments: 14,
        });
        var wf = new THREE.Mesh(whiteGeo, M.finWhite);
        wf.rotation.z = -side * 0.03;
        wf.position.set(0, -0.020, 0.030);
        g.add(wf);
        K.outline(wf, OL3);
        // 深蓝上缘（压在白色鳍身上缘）
        var finGeo = new THREE.ExtrudeGeometry(finShape(0.96, side), {
          depth: 0.054, bevelEnabled: true, bevelSize: 0.016, bevelThickness: 0.016,
          bevelSegments: 2, curveSegments: 14,
        });
        var f = new THREE.Mesh(finGeo, M.fin);
        f.rotation.z = -side * 0.05;
        f.position.set(side * 0.010, 0.048, 0.002);
        g.add(f);
        K.outline(f, { thickness: 0.0052, color: C.outline });
      });
    })();

    // 刘海中间的小小 X 发饰（对照参考图）
    (function () {
      var x = new THREE.Group();
      x.position.set(0, 0.300, 0.800);
      x.rotation.x = -0.32;
      [-1, 1].forEach(function (sd) {
        var bar = mesh(K.capsule(0.008, 0.075, 4), M.hairLight, x, [0, 0, 0]);
        bar.rotation.z = sd * 0.85;
      });
      hairGroup.add(x);
    })();

    /* ============================== 鲸鱼尾巴（贴身盘起） ============================== */
    var tailG = K.group(body, [0.16, 0.30, -0.36]);
    tailG.name = "tail";
    var tailPts = [
      [0.00, 0.00, 0.00],
      [0.22, 0.00, 0.06],
      [0.44, 0.10, 0.18],
      [0.62, 0.30, 0.36],
      [0.72, 0.54, 0.58],
      [0.76, 0.78, 0.80],
      [0.76, 0.96, 0.94],
    ];
    strand(tailG, {
      pts: tailPts,
      radii: [0.098, 0.094, 0.084, 0.072, 0.060, 0.048, 0.034],
      flat: 0.92, seg: 26, radial: 10, tension: 0.44,
    }, M.tail, { thickness: 0.0072, color: C.outline });

    // 尾鳍（两叶，朝前可见）
    var flukeG = K.group(tailG, [0.84, 1.12, 0.92]);
    flukeG.rotation.set(-0.28, 0.52, 0.60);
    (function () {
      var sh = new THREE.Shape();
      sh.moveTo(0, 0.10);
      sh.bezierCurveTo(-0.18, 0.14, -0.40, 0.06, -0.56, -0.20);
      sh.bezierCurveTo(-0.36, -0.16, -0.18, -0.14, 0, -0.10);
      sh.bezierCurveTo(0.18, -0.14, 0.36, -0.16, 0.56, -0.20);
      sh.bezierCurveTo(0.40, 0.06, 0.18, 0.14, 0, 0.10);
      var g = new THREE.ExtrudeGeometry(sh, {
        depth: 0.055, bevelEnabled: true, bevelSize: 0.020, bevelThickness: 0.020,
        bevelSegments: 2, curveSegments: 14,
      });
      g.center();
      var fl = new THREE.Mesh(g, M.fluke);
      fl.scale.set(0.50, 0.50, 0.50);
      flukeG.add(fl);
      K.outline(fl, { thickness: 0.0062, color: C.outline });
    })();

    /* ============================== 小道具 ============================== */
    // 吃点心用的饼干
    var cookieG = K.group(torso, [0, 1.98, 0.52]);
    var cookie = mesh(K.cylinder(0.090, 0.084, 0.032, 18), M.cookie, cookieG, [0, 0, 0], OL3);
    cookie.rotation.x = 1.1;
    for (var chi = 0; chi < 5; chi++) {
      var ca = (chi / 5) * TAU + 0.4;
      mesh(K.sphere(0.014, 1, 1, 0.7, 6), M.choco, cookieG,
        [Math.cos(ca) * 0.048, 0.010, 0.026 + Math.sin(ca) * 0.030]);
    }
    cookieG.visible = false;

    // 睡姿 Zzz
    var zTex = K.canvasTexWH(128, 128, function (x, w, h) {
      x.clearRect(0, 0, w, h);
      x.font = "italic 900 92px ui-sans-serif, -apple-system, sans-serif";
      x.textAlign = "center";
      x.textBaseline = "middle";
      x.lineWidth = 10;
      x.strokeStyle = "rgba(30,60,120,0.85)";
      x.strokeText("Z", w / 2, h / 2 + 4);
      x.fillStyle = "#bfe3ff";
      x.fillText("Z", w / 2, h / 2 + 4);
    });
    extraTex.push(zTex);
    var zzz = [];
    for (var zi = 0; zi < 3; zi++) {
      var sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: zTex, transparent: true, depthWrite: false, opacity: 0 }));
      sp.scale.set(0.001, 0.001, 1);
      body.add(sp);
      zzz.push(sp);
    }

    // 被摸头时冒出的爱心
    var heartG = K.group(body, [0, 3.02, 0.2]);
    [0.0, 0.55, -0.5].forEach(function (ox, i) {
      var hb = new THREE.Mesh(K.heart(0.058, 0.05), M.heart);
      hb.position.set(ox, i * 0.10, 0);
      hb.rotation.z = ox * 0.7;
      heartG.add(hb);
      K.outline(hb, { thickness: 0.0035, color: 0xb0405e });
    });
    heartG.visible = false;

    // 气泡
    var bubbleTex = K.radialTex([
      [0, "rgba(230,248,255,0.95)"],
      [0.45, "rgba(190,230,255,0.35)"],
      [0.8, "rgba(160,210,255,0.10)"],
      [1, "rgba(150,200,255,0)"],
    ], 128);
    extraTex.push(bubbleTex);
    var bubbles = [];
    for (var bi = 0; bi < 4; bi++) {
      var bs = new THREE.Sprite(new THREE.SpriteMaterial({
        map: bubbleTex, transparent: true, depthWrite: false,
        opacity: 0, color: 0xd8f0ff,
      }));
      body.add(bs);
      bubbles.push(bs);
    }

    /* ============================== 姿态 ============================== */
    // 手目标（torso 局部坐标） + 肘部极点（torso 局部）
    var POSES = {
      idle: {
        head: [0.02, 0.0, 0.0],
        L: [0.068, 1.50, 0.435], R: [-0.068, 1.50, 0.435],
        poleL: [0.74, 1.16, 0.24], poleR: [-0.74, 1.16, 0.24],
        eyes: ["open", "open"], mouth: "smile", blush: 0.55,
        tail: { y: 0.06, x: 0.0, z: 0.0, sp: 1.5, amp: 0.10 }, bodyY: 0.0,
      },
      happy: {
        head: [-0.10, 0.0, 0.0],
        L: [0.44, 1.98, 0.24], R: [-0.44, 1.98, 0.24],
        poleL: [0.80, 1.44, 0.16], poleR: [-0.80, 1.44, 0.16],
        eyes: ["happy", "happy"], mouth: "open", blush: 1,
        tail: { y: 0.16, x: -0.08, z: 0.0, sp: 5.0, amp: 0.26 }, bodyY: 0.0,
      },
      talk: {
        head: [0.02, 0.06, 0.05],
        L: [0.060, 1.48, 0.430], R: [-0.26, 1.60, 0.45],
        poleL: [0.74, 1.16, 0.24], poleR: [-0.76, 1.18, 0.30],
        eyes: ["open", "open"], mouth: "smile", blush: 0.60,
        tail: { y: 0.04, x: 0.0, z: 0.0, sp: 1.8, amp: 0.12 }, bodyY: 0.0,
      },
      sleep: {
        head: [0.22, 0.18, 0.14],
        L: [0.10, 1.26, 0.40], R: [-0.10, 1.26, 0.40],
        poleL: [0.68, 1.02, 0.30], poleR: [-0.68, 1.02, 0.30],
        eyes: ["closed", "closed"], mouth: "smile", blush: 0.35,
        tail: { y: 0.02, x: 0.02, z: 0.0, sp: 0.55, amp: 0.05 }, bodyY: -0.040,
      },
      shy: {
        head: [0.12, 0.14, 0.12],
        L: [0.068, 1.52, 0.445], R: [-0.068, 1.52, 0.445],
        poleL: [0.64, 1.18, 0.32], poleR: [-0.64, 1.18, 0.32],
        eyes: ["half", "half"], mouth: "shy", blush: 1,
        tail: { y: 0.10, x: 0.02, z: 0.02, sp: 1.0, amp: 0.06 }, bodyY: -0.014,
      },
      stretch: {
        head: [-0.16, 0.0, 0.0],
        L: [0.28, 2.22, 0.16], R: [-0.28, 2.22, 0.16],
        poleL: [0.74, 1.60, 0.10], poleR: [-0.74, 1.60, 0.10],
        eyes: ["happy", "happy"], mouth: "open", blush: 0.85,
        tail: { y: 0.18, x: -0.12, z: 0.0, sp: 2.0, amp: 0.16 }, bodyY: 0.0,
      },
      wink: {
        head: [0.01, 0.05, 0.10],
        L: [0.068, 1.50, 0.435], R: [-0.38, 1.84, 0.42],
        poleL: [0.74, 1.16, 0.24], poleR: [-0.80, 1.36, 0.28],
        eyes: ["open", "happy"], mouth: "cat", blush: 0.95,
        tail: { y: 0.10, x: -0.02, z: 0.0, sp: 2.4, amp: 0.16 }, bodyY: 0.0,
      },
      eat: {
        head: [0.10, 0.0, 0.03],
        L: [0.11, 1.88, 0.46], R: [-0.11, 1.88, 0.46],
        poleL: [0.60, 1.36, 0.36], poleR: [-0.60, 1.36, 0.36],
        eyes: ["happy", "happy"], mouth: "o", blush: 1,
        tail: { y: 0.08, x: 0.0, z: 0.0, sp: 2.0, amp: 0.10 }, bodyY: 0.0,
      },
    };

    var state = "idle";
    var stateT = 0;
    var look = { x: 0, y: 0, tx: 0, ty: 0 };
    var blinkT = 0, blinkNext = 2.5, blinkRestore = ["open", "open"];
    var mouthT = 0;
    var patT = 0, patHold = 0;
    var curBodyY = 0;
    var armQ = {
      "1": { sh: new THREE.Quaternion(), el: new THREE.Quaternion() },
      "-1": { sh: new THREE.Quaternion(), el: new THREE.Quaternion() },
    };

    /** 两段手臂 IK：返回肩 / 肘的目标四元数 */
    function solveArm(side, hand, pole) {
      var L1 = P.armL1, L2 = P.armL2;
      var S = new V3(side * P.shoulderX, P.shoulderY, 0.01);
      var to = new V3(hand[0], hand[1], hand[2]).sub(S);
      var d = to.length();
      if (d < 1e-5) to.set(0, -1, 0);
      var dir = to.clone().normalize();
      d = K.clamp(d, Math.abs(L1 - L2) + 0.03, L1 + L2 - 0.012);
      var pv = new V3(pole[0], pole[1], pole[2]).sub(S);
      var perp = pv.clone().addScaledVector(dir, -pv.dot(dir));
      if (perp.lengthSq() < 1e-6) {
        perp.set(side * 0.7, 0.2, 0.3);
        perp.addScaledVector(dir, -perp.dot(dir));
      }
      perp.normalize();
      var cosA = K.clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1);
      var sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
      var eDir = dir.clone().multiplyScalar(cosA).addScaledVector(perp, sinA).normalize();
      var E = S.clone().addScaledVector(eDir, L1);
      var fDir = S.clone().addScaledVector(dir, d).sub(E).normalize();
      var q1 = new THREE.Quaternion().setFromUnitVectors(DOWN, eDir);
      var fLocal = fDir.clone().applyQuaternion(q1.clone().invert()).normalize();
      var q2 = new THREE.Quaternion().setFromUnitVectors(DOWN, fLocal);
      return { q1: q1, q2: q2 };
    }

    function applyArms(handL, handR, pose, instant, dt) {
      var solL = solveArm(1, handL, pose.poleL);
      var solR = solveArm(-1, handR, pose.poleR);
      var k = instant ? 1 : (1 - Math.exp(-11 * dt));
      armQ["1"].sh.slerp(solL.q1, k);
      armQ["1"].el.slerp(solL.q2, k);
      armQ["-1"].sh.slerp(solR.q1, k);
      armQ["-1"].el.slerp(solR.q2, k);
      arms["1"].root.quaternion.copy(armQ["1"].sh);
      arms["1"].elbow.quaternion.copy(armQ["1"].el);
      arms["-1"].root.quaternion.copy(armQ["-1"].sh);
      arms["-1"].elbow.quaternion.copy(armQ["-1"].el);
    }

    function setState(name) {
      if (!POSES[name]) name = "idle";
      state = name;
      stateT = 0;
      mouthT = 0;
      var p = POSES[name];
      setEyes(p.eyes[0], p.eyes[1]);
      blinkRestore = p.eyes.slice();
      blinkT = 0;
      blinkNext = 2.2 + Math.random() * 2.6;
      setMouth(p.mouth);
      head.face.setBlush(p.blush);
      cookieG.visible = (name === "eat");
      if (name === "eat") cookieG.scale.set(1, 1, 1);
      heartG.visible = patT > 0.05;
      // 双手交握的造型只在"手在胸前"的状态显示；抬手状态用袖口里的手
      var clasp = (name === "idle" || name === "talk" || name === "sleep" || name === "shy");
      claspedG.visible = clasp;
      arms["1"].wrist.children.forEach(function (c) { if (!c.userData.noHandToggle) c.visible = !clasp; });
      arms["-1"].wrist.children.forEach(function (c) { if (!c.userData.noHandToggle) c.visible = !clasp; });
      applyArms(p.L, p.R, p, true, 0);
    }

    function setLook(nx, ny) {
      look.tx = K.clamp(nx, -1, 1);
      look.ty = K.clamp(ny, -1, 1);
    }

    function pat() {
      patT = 1;
      patHold = 1.9;
      setState("happy");
      head.face.setBlush(1);
      heartG.visible = true;
    }

    function update(dt, t) {
      if (!(dt > 0)) dt = 0.016;
      if (dt > 0.05) dt = 0.05;
      stateT += dt;

      /* ---------- 视线 ---------- */
      look.x = damp(look.x, look.tx, dt, 7);
      look.y = damp(look.y, look.ty, dt, 7);
      head.face.look(look.x, look.y);

      /* ---------- 眨眼 ---------- */
      var closedState = (state === "sleep" || state === "happy" || state === "stretch" ||
        state === "eat" || state === "wink" || state === "shy");
      if (!closedState) {
        blinkNext -= dt;
        if (blinkNext <= 0 && blinkT <= 0) {
          blinkNext = 2.4 + Math.random() * 3.2;
          blinkT = 0.14;
          setEyes("closed", "closed");
        }
      }
      if (blinkT > 0) {
        blinkT -= dt;
        if (blinkT <= 0) setEyes(blinkRestore[0], blinkRestore[1]);
      }

      var pose = POSES[state] || POSES.idle;

      /* ---------- 身体弹跳 / 呼吸 ---------- */
      var breathe = Math.sin(t * 2.2);
      var sleepy = state === "sleep" ? 0.45 : 1;
      torso.scale.set(
        1 + breathe * 0.006 * sleepy,
        1 + breathe * 0.012 * sleepy,
        1 + breathe * 0.006 * sleepy
      );
      var bounce = 0;
      if (state === "happy") bounce = Math.abs(Math.sin(stateT * 6.4)) * 0.045 * Math.min(1, stateT * 2);
      if (state === "stretch") bounce = -0.02 + Math.sin(stateT * 3.1) * 0.012;
      curBodyY = damp(curBodyY, pose.bodyY + bounce, dt, 10);
      body.position.y = curBodyY + Math.sin(t * 2.1) * 0.012 * sleepy;

      /* ---------- 头部 ---------- */
      var hx = pose.head[0], hy = pose.head[1], hz = pose.head[2];
      if (state === "idle") {
        hx += Math.sin(t * 1.7) * 0.012;
        hy += Math.sin(t * 0.53) * 0.045 + look.x * 0.16;
        hz += Math.sin(t * 0.9) * 0.018 + look.x * 0.04;
      } else if (state === "talk") {
        hx += Math.sin(stateT * 5.0) * 0.03;
        hy += Math.sin(t * 0.7) * 0.05 + look.x * 0.10;
        hz += Math.sin(stateT * 3.1) * 0.02;
      } else if (state === "happy") {
        hx += Math.sin(stateT * 6.4) * 0.015;
        hz += Math.sin(stateT * 3.2) * 0.02;
      } else if (state === "sleep") {
        hx += Math.sin(t * 0.8) * 0.01;
      } else if (state === "eat") {
        hx += Math.sin(stateT * 7.0) * 0.025;
      } else if (state === "wink") {
        hz += Math.sin(t * 0.9) * 0.02;
        hy += look.x * 0.10;
      } else if (state === "shy") {
        hx += Math.sin(t * 1.4) * 0.012;
      }
      hy += look.x * 0.10;
      hx += -look.y * 0.05;
      headPivot.rotation.x = damp(headPivot.rotation.x, hx, dt, 9);
      headPivot.rotation.y = damp(headPivot.rotation.y, hy, dt, 9);
      headPivot.rotation.z = damp(headPivot.rotation.z, hz, dt, 9);

      /* ---------- 手臂 ---------- */
      var hL = pose.L.slice(), hR = pose.R.slice();
      if (state === "idle" || state === "talk") {
        hL[1] += Math.sin(t * 2.2) * 0.006;
        hR[1] += Math.sin(t * 2.2 + 0.4) * 0.006;
      } else if (state === "happy") {
        hL[1] += Math.sin(stateT * 6.4) * 0.018;
        hR[1] += Math.sin(stateT * 6.4 + 0.5) * 0.018;
      } else if (state === "sleep") {
        hL[1] += Math.sin(t * 1.1) * 0.006;
        hR[1] += Math.sin(t * 1.1) * 0.006;
      } else if (state === "wink") {
        hL[0] += Math.sin(t * 1.4) * 0.006;
      } else if (state === "eat") {
        hL[1] += Math.sin(stateT * 7.0) * 0.012;
        hR[1] += Math.sin(stateT * 7.0) * 0.012;
      }
      applyArms(hL, hR, pose, false, dt);

      /* ---------- 尾巴 ---------- */
      var tp = pose.tail;
      var wag = Math.sin(t * tp.sp) * tp.amp + Math.sin(t * tp.sp * 2.3 + 0.7) * tp.amp * 0.35;
      tailG.rotation.y = tp.y + wag + look.x * 0.06;
      tailG.rotation.x = tp.x + Math.sin(t * tp.sp * 0.8 + 0.4) * tp.amp * 0.5;
      tailG.rotation.z = tp.z;
      flukeG.rotation.z = 0.46 + Math.sin(t * tp.sp * 1.3 + 0.8) * tp.amp * 0.8;
      flukeG.rotation.x = -0.32 + Math.sin(t * tp.sp * 1.1) * tp.amp * 0.4;

      /* ---------- 头发 / 呆毛 / 鳍耳 / 头饰 ---------- */
      var hairSway = Math.sin(t * 1.15) * 0.5 + Math.sin(t * 0.63) * 0.5;
      backHairG.rotation.x = Math.sin(t * 1.3 + 0.4) * 0.012 - look.y * 0.02;
      backHairG.rotation.z = hairSway * 0.014 + look.x * 0.02;
      backHairG.rotation.y = Math.sin(t * 0.9) * 0.012;
      hairGroup.rotation.x = Math.sin(t * 1.7) * 0.008;
      hairGroup.rotation.z = Math.sin(t * 1.1 + 0.8) * 0.008;
      ahogeG.rotation.z = Math.sin(t * 1.9) * 0.10 + (patT > 0 ? Math.sin(patT * 20) * 0.10 * patT : 0);
      ahogeG.rotation.x = Math.sin(t * 1.3 + 0.5) * 0.05;
      finG.rotation.z = Math.sin(t * 1.4) * 0.012;
      crownG.rotation.z = Math.sin(t * 1.05) * 0.008;

      /* ---------- 嘴型动画 ---------- */
      if (state === "talk") {
        mouthT += dt;
        setMouth(Math.sin(mouthT * 11) > 0.15 ? "open" : "smile");
      } else if (state === "eat") {
        mouthT += dt;
        setMouth(Math.sin(mouthT * 9) > 0 ? "o" : "smile");
      } else if (state === "stretch" && stateT > 1.1) {
        setMouth("smile");
      }

      /* ---------- 被摸头：压扁回弹 + 爱心 ---------- */
      if (state === "happy" && patT > 0) {
        patT = Math.max(0, patT - dt * 2.4);
        var sq = Math.sin(patT * PI) * 0.085;
        root.scale.set(1 + sq * 0.7, 1 - sq, 1 + sq * 0.7);
      } else {
        root.scale.set(1, 1, 1);
      }
      if (patT > 0) {
        heartG.visible = true;
        var hp2 = 1 - patT;
        heartG.position.y = 3.00 + hp2 * 0.42;
        heartG.rotation.y = Math.sin(t * 3) * 0.3;
        heartG.children.forEach(function (c, i) {
          c.position.x = (i === 0 ? 0 : i === 1 ? 0.16 : -0.15) * (0.6 + hp2);
          c.scale.setScalar((0.7 + Math.sin(t * 6 + i) * 0.15) * (0.6 + 0.6 * Math.min(1, patT * 2)));
        });
      } else {
        heartG.visible = false;
      }
      if (patHold > 0) {
        patHold -= dt;
        if (patHold <= 0 && state === "happy") setState("idle");
      }
      if (state === "eat") {
        var cs = damp(cookieG.scale.x, 1, dt, 12);
        cookieG.scale.setScalar(cs);
        cookieG.position.set(0, 1.98 + Math.sin(stateT * 3.2) * 0.012, 0.52);
        cookieG.rotation.z = Math.sin(stateT * 2.4) * 0.12;
      }

      /* ---------- Zzz ---------- */
      var zfade = state === "sleep" ? 1 : 0;
      for (var zi = 0; zi < zzz.length; zi++) {
        var sp = zzz[zi];
        var ph2 = (t * 0.34 + zi * 0.34) % 1;
        sp.position.set(0.95 + ph2 * 0.34, 3.00 + ph2 * 0.62, 0.95 + ph2 * 0.10);
        var sc = 0.24 + ph2 * 0.20;
        sp.scale.set(sc, sc, 1);
        sp.material.opacity = zfade * Math.sin(ph2 * PI) * 0.85;
        sp.visible = zfade > 0.05;
      }

      /* ---------- 气泡 ---------- */
      var bfade = (state === "idle" || state === "talk" || state === "wink") ? 1 : 0;
      for (var bj = 0; bj < bubbles.length; bj++) {
        var b = bubbles[bj];
        var bp = (t * 0.22 + bj * 0.27) % 1;
        b.position.set(0.95 + Math.sin(bp * 6 + bj) * 0.10, 0.90 + bp * 1.35, -0.34 - Math.sin(bp * 3) * 0.10);
        var bs2 = 0.055 + bp * 0.075;
        b.scale.set(bs2, bs2, 1);
        b.material.opacity = bfade * Math.sin(bp * PI) * 0.55;
        b.visible = bfade > 0.05;
      }

      return char;
    }

    var char = {
      root: root,
      height: P.height,
      camera: P.camera,
      stateName: function () { return state; },
      setState: setState,
      setLook: setLook,
      pat: pat,
      update: update,
      dispose: function () {
        for (var i = 0; i < extraTex.length; i++) { try { extraTex[i].dispose(); } catch (e) {} }
        K.dispose(root);
      },
    };

    setState("idle");
    char.update(0.016, 0);
    return char;
  }

  var variants = {
    whale: {
      meta: { id: "whale", label: "鲸鲸", height: P.height, camera: P.camera },
      build: build,
    },
  };
  return { variants: variants };
};
