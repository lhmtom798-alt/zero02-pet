/**
 * chars.zerotwo —— 02 三套形象（Q版 / 元气 / 御姐）的 3D 手办
 * 共用"粉色长双马尾 + 红角 + 白色发带 + 红色大衣"部件，靠比例 / 服装 / 发型参数区分。
 */
module.exports.create = function (K, FIG, THREE) {
  var PI = Math.PI, TAU = PI * 2;
  var D = PI / 180;

  function hp(thetaDeg, phiDeg, rad) {
    var th = thetaDeg * D, ph = phiDeg * D;
    return [rad * Math.sin(th) * Math.sin(ph), rad * Math.cos(th), rad * Math.sin(th) * Math.cos(ph)];
  }

  var PRESETS = {
    chibi: {
      type: "chibi",
      height: 4.42,
      camera: { height: 4.95, targetY: 2.32, margin: 1.06, elevation: 0.07, glowColor: 0xff6f96 },
      colors: {
        skin: 0xffdcc4, skinShade: 0xf3b6a8,
        hair: 0xf08fbc, hairShade: 0xc76a9b, hairHi: 0xffc2dd,
        coat: 0xcf2b41, coatShade: 0x8c1a31, trim: 0xfff3f0,
        tie: 0xf28a2c, tieShade: 0xc25f12,
        tights: 0x372b42, tightsShade: 0x221a2b,
        boot: 0xfff7f3, bootShade: 0xe3cdd3,
        horn: 0xf2485a, hornShade: 0xb02036,
        eye: { iris: ["#2c6f63", "#46b992", "#a9f0d3"], lash: "#3d2130", brow: "#c97f9e", round: 0.95, sclera: "#fdf7fa" },
        outline: 0x3a2230,
      },
      shape: { headR: 1.0, headY: 3.42, neckY: 2.40, shoulderY: 2.12, hipY: 1.02, armLen: 0.92, armR: 0.135 },
    },
  };

  function buildChibi(P) {
    var C = P.colors;
    var S = P.shape;
    var root = new THREE.Group();
    var O = { thickness: 0.0085, color: C.outline };
    var OH = { thickness: 0.006, color: C.outline };

    var matSkin = K.cel({ color: C.skin, shade: C.skinShade, rim: 0xffd6e2, rimStr: 0.12, hiStr: 0.06, lift: 0.82, shadeAmt: 1.0 });
    var matHair = K.cel({ color: C.hair, shade: C.hairShade, hi: C.hairHi, rim: 0xffe6f2, rimStr: 0.1, hiStr: 0.22, spec: 0.05, specPow: 16 });
    var matHairBack = K.cel({ color: C.hair, shade: C.hairShade, hi: C.hairHi, rim: 0xffe6f2, rimStr: 0.08, hiStr: 0.16 });
    var matCoat = K.cel({ color: C.coat, shade: C.coatShade, rim: 0xff9db0, rimStr: 0.17, hiStr: 0.35 });
    var matTrim = K.cel({ color: C.trim, shade: 0xe0c4c9, rim: 0xffffff, rimStr: 0.2, hiStr: 0.2 });
    var matTie = K.cel({ color: C.tie, shade: C.tieShade, rim: 0xffd0a0, rimStr: 0.15 });
    var matTights = K.cel({ color: C.tights, shade: C.tightsShade, rim: 0xffb0d0, rimStr: 0.25, lift: 0.12 });
    var matBoot = K.cel({ color: C.boot, shade: C.bootShade, rim: 0xffffff, rimStr: 0.2 });
    var matHorn = K.cel({ color: 0xf2485a, shade: 0xc22238, hi: 0xff9aa8, rim: 0xffc0c8, rimStr: 0.25, hiStr: 0.3, lift: 0.35, side: THREE.DoubleSide });
    var matDark = K.cel({ color: 0x3a2a3e, shade: 0x241a29, rim: 0x8a6a80, rimStr: 0.08, lift: 0.1 });
    var matShine = new THREE.MeshBasicMaterial({ color: 0xffe6f2, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide });

    /* ---------------- 身体 ---------------- */
    var body = K.group(root);
    var torso = K.group(body);

    var prof = [
      [0.86, 1.00], [0.82, 1.08], [0.72, 1.22], [0.60, 1.38], [0.51, 1.54],
      [0.47, 1.66], [0.46, 1.78], [0.50, 1.94], [0.52, 2.10], [0.45, 2.24], [0.30, 2.32],
    ];
    // 大衣表面半径（用于把领带/纽扣/腰带贴到衣服上，而不是埋进衣服里）
    function coatR(y) {
      var p = prof;
      if (y <= p[0][1]) return p[0][0];
      for (var i2 = 0; i2 < p.length - 1; i2++) {
        var a = p[i2], b = p[i2 + 1];
        if (y >= a[1] && y <= b[1]) {
          var t2 = (y - a[1]) / Math.max(0.0001, b[1] - a[1]);
          return a[0] + (b[0] - a[0]) * t2;
        }
      }
      return p[p.length - 1][0];
    }
    function frontZ(y, off) { return coatR(y) * 0.98 + (off == null ? 0.012 : off); }

    var coat = new THREE.Mesh(K.lathe(prof, 44), matCoat);
    K.outline(coat, O);
    torso.add(coat);
    var cap = new THREE.Mesh(new THREE.CircleGeometry(0.855, 36), matCoat);
    cap.rotation.x = PI / 2;
    cap.position.y = 1.005;
    torso.add(cap);
    // 白色下摆滚边
    var hem = new THREE.Mesh(K.ring(0.845, 0.036, TAU, 10), matTrim);
    hem.rotation.x = PI / 2;
    hem.position.y = 1.02;
    torso.add(hem);
    // 双排白色前襟（沿衣面走的细线）
    [1, -1].forEach(function (sd) {
      var pts = [];
      for (var yy = 1.08; yy <= 2.24; yy += 0.10) {
        var rr = coatR(yy) * 0.995 + 0.008;
        pts.push([sd * 0.16 * rr / 0.5, yy, Math.sqrt(Math.max(0.0001, rr * rr - Math.pow(0.16 * rr / 0.5, 2)))]);
      }
      var strip = new THREE.Mesh(K.ribbon({ pts: pts, widths: [0.032, 0.026], thick: 0.012, ref: [1, 0, 0], seg: 12, radial: 5 }), matTrim);
      strip.userData.noOutline = true;
      torso.add(strip);
    });
    // 腰带（贴在衣面上）
    var beltY = 1.70;
    var belt = new THREE.Mesh(K.ring(coatR(beltY) + 0.022, 0.055, TAU, 8), matDark);
    belt.rotation.x = PI / 2;
    belt.position.y = beltY;
    belt.scale.set(1.0, 0.55, 1.02);
    belt.name = "belt";
    torso.add(belt);
    K.mesh(new THREE.BoxGeometry(0.115, 0.088, 0.05), K.cel({ color: 0xd8c9a8, shade: 0x9c8f74 }), torso, [0, beltY, frontZ(beltY, 0.035)]);
    // 两排扣子
    for (var bi = 0; bi < 3; bi++) {
      var by = 2.05 - bi * 0.16;
      var bz = frontZ(by, 0.01);
      K.mesh(K.sphere(0.024, 1, 1, 1, 10), matDark, torso, [0.10, by, bz]);
      K.mesh(K.sphere(0.024, 1, 1, 1, 10), matDark, torso, [-0.10, by, bz]);
    }
    // 白领
    var collar = new THREE.Mesh(K.ring(0.275, 0.05, TAU, 10), matTrim);
    collar.rotation.x = PI / 2;
    collar.position.y = 2.30;
    collar.scale.set(1, 0.62, 1);
    torso.add(collar);
    // 橙色领巾
    K.mesh(K.sphere(0.072, 1.1, 0.85, 0.7, 12), matTie, torso, [0, 2.21, frontZ(2.21, 0.012)]);
    var blade = new THREE.Mesh(new THREE.CylinderGeometry(0.072, 0.014, 0.30, 4), matTie);
    blade.position.set(0, 2.04, frontZ(2.04, 0.006));
    blade.scale.z = 0.45;
    torso.add(blade);
    K.outline(blade, OH);

    // 脖子
    var neck = K.mesh(K.cylinder(0.155, 0.175, 0.20, 16), matSkin, body, [0, 2.40, 0]);
    K.outline(neck, OH);

    /* ---------------- 腿 ---------------- */
    var legs = {};
    [1, -1].forEach(function (side) {
      var hip = K.group(body, [side * 0.22, 1.08, 0]);
      var thigh = K.mesh(K.capsule(0.16, 0.28, 8), matTights, hip, [0, -0.20, 0]);
      K.outline(thigh, O);
      var knee = K.group(hip, [0, -0.40, 0]);
      var shin = K.mesh(K.capsule(0.13, 0.24, 8), matTights, knee, [0, -0.16, 0]);
      K.outline(shin, O);
      var ankle = K.group(knee, [0, -0.34, 0]);
      var shaft = K.mesh(K.cylinder(0.145, 0.16, 0.20, 16), matBoot, ankle, [0, -0.01, 0]);
      K.outline(shaft, O);
      var foot = K.mesh(K.sphere(0.155, 1.05, 0.7, 1.5, 16), matBoot, ankle, [0, -0.12, 0.055]);
      K.outline(foot, O);
      var cuff = new THREE.Mesh(K.ring(0.148, 0.028, TAU, 8), matCoat);
      cuff.rotation.x = PI / 2;
      cuff.position.y = 0.09;
      ankle.add(cuff);
      legs[side] = { hip: hip, knee: knee, ankle: ankle };
    });

    /* ---------------- 手臂 ---------------- */
    var arms = {};
    [1, -1].forEach(function (side) {
      var sh = K.group(body, [side * 0.50, S.shoulderY, 0]);
      var upper = K.mesh(K.capsule(0.14, 0.32, 8), matCoat, sh, [0, -0.19, 0]);
      K.outline(upper, O);
      var puff = K.mesh(K.sphere(0.175, 1, 1.05, 1, 16), matCoat, sh, [0, -0.02, 0]);
      K.outline(puff, O);
      var elbow = K.group(sh, [0, -0.37, 0]);
      var fore = K.mesh(K.capsule(0.118, 0.28, 8), matCoat, elbow, [0, -0.16, 0]);
      K.outline(fore, O);
      var wrist = K.group(elbow, [0, -0.33, 0]);
      var cuff2 = new THREE.Mesh(K.ring(0.12, 0.03, TAU, 8), matTrim);
      cuff2.rotation.x = PI / 2;
      wrist.add(cuff2);
      var hand = K.mesh(K.sphere(0.112, 1, 1.12, 0.86, 16), matSkin, wrist, [0, -0.105, 0]);
      K.outline(hand, OH);
      arms[side] = { shoulder: sh, elbow: elbow, wrist: wrist, hand: hand };
    });

    /* ---------------- 头 ---------------- */
    var headGroup = K.group(body, [0, S.headY, 0]);
    var head = FIG.head({
      R: S.headR,
      scale: [1.03, 0.98, 1.0],
      skin: C.skin, skinShade: C.skinShade,
      eye: C.eye,
      eyeX: 0.40, eyeY: -0.05, eyeW: 0.76, eyeH: 0.80,
      mouth: { kind: "smile", lip: "#b4566e" },
      mouthY: -0.60,
      blush: true, blushColor: "rgba(255,120,150,0.5)", blushOpacity: 0.75,
      outline: C.outline,
      jaw: 0.16,
    });
    headGroup.add(head.group);

    /* ---------------- 头发 ---------------- */
    var hairGroup = K.group(headGroup);
    var capMesh = new THREE.Mesh(FIG.hairCap(1.0, { scale: 1.048, thetaFront: 0.352, thetaBack: 0.92 }), matHair);
    K.outline(capMesh, OH);
    hairGroup.add(capMesh);

    var hairBack = K.group(headGroup);
    // 后发：10 束长及脚踝
    var backPhi = [110, 123, 136, 149, 162, 175, 188, 201, 214, 227, 240, 253, 266];
    backPhi.forEach(function (ph, idx) {
      var s = Math.sin(ph * D), c = Math.cos(ph * D);
      var pts = [
        hp(22, ph, 1.01),
        hp(54, ph, 1.05),
        hp(88, ph, 1.07),
        [s * 0.92, -0.68, c * 0.84 - 0.06],
        [s * 1.06, -1.52, c * 0.92 - 0.10],
        [s * 0.98, -2.28, c * 0.78 - 0.10],
        [s * 0.84, -2.78, c * 0.62 - 0.06],
      ];
      var w = 0.34 + 0.06 * Math.cos(ph * D);
      var cl = new THREE.Mesh(K.ribbon({
        pts: pts, widths: [w * 0.9, w, w * 1.06, w, w * 0.88, w * 0.5, 0.03],
        thick: 0.05, ref: [c, 0, -s], seg: 20, radial: 8, tension: 0.3,
      }), matHairBack);
      hairBack.add(cl);
    });
    // 侧发（贴脸 + 垂到胸口）
    [1, -1].forEach(function (side) {
      var ph = side * 60;
      var pts = [
        hp(14, ph, 1.01), hp(44, ph, 1.05), hp(74, ph, 1.08), hp(98, ph * 0.98, 1.06),
        [side * 0.82, -0.52, 0.40], [side * 0.90, -1.14, 0.34], [side * 0.84, -1.70, 0.24],
      ];
      var cl = new THREE.Mesh(K.ribbon({
        pts: pts, widths: [0.20, 0.23, 0.22, 0.19, 0.16, 0.10, 0.02],
        thick: 0.055, ref: [Math.cos(ph * D), 0, -Math.sin(ph * D)], seg: 18, radial: 8,
      }), matHair);
      hairBack.add(cl);
    });
    // 刘海：9 束宽片子，盖住额头
    // 刘海：两层——里层密实盖住额头，外层尖尖的碎发
    for (var i = 0; i < 19; i++) {
      var t = (i - 9) / 9;
      var ph = t * 86;
      var len = (1 - Math.abs(t) * 0.08) * (i % 3 === 0 ? 0.9 : i % 3 === 1 ? 1.0 : 1.07);
      var pts = [
        hp(6, ph * 0.34, 1.008),
        hp(24, ph * 0.72, 1.042),
        hp(44, ph * 0.90, 1.062),
        hp(62 * len, ph * 0.99, 1.075),
        hp(76 * len, ph * 1.02, 1.082),
        hp(86 * len, ph * 1.04, 1.086),
      ];
      var w = 0.30 - Math.abs(t) * 0.018;
      var cl = new THREE.Mesh(K.ribbon({
        pts: pts, widths: [w * 0.7, w, w, w * 0.96, w * 0.78, w * 0.36],
        thick: 0.06, ref: [Math.cos(ph * D), 0, -Math.sin(ph * D)], seg: 16, radial: 8, tension: 0.3,
      }), matHair);
      hairGroup.add(cl);
    }
    // 刘海在额头上的投影（让头发"贴"在脸上）
    var browShadowTex = K.canvasTexWH(256, 128, function (xc, w2, h2) {
      var g2 = xc.createLinearGradient(0, 0, 0, h2);
      g2.addColorStop(0, "rgba(110,50,80,0.42)");
      g2.addColorStop(0.55, "rgba(110,50,80,0.18)");
      g2.addColorStop(1, "rgba(110,50,80,0)");
      xc.fillStyle = g2;
      xc.fillRect(0, 0, w2, h2);
    });
    var browShade = FIG.patchMesh(1.0, [0, 0.50, 0.86], 1.5, 0.62, browShadowTex, { order: 1, opacity: 0.9 });
    browShade.position.y = 0;
    head.group.add(browShade);
    // 呆毛
    var ahoge = new THREE.Mesh(K.ribbon({
      pts: [[0, 1.00, 0.14], [0.01, 1.20, 0.24], [0.08, 1.34, 0.42], [0.22, 1.30, 0.55], [0.30, 1.20, 0.58]],
      widths: [0.075, 0.062, 0.045, 0.024, 0.004], thick: 0.018, ref: [1, 0, 0], seg: 14, radial: 6,
    }), matHair);

    hairGroup.add(ahoge);
    // 白色发带（贴在头发外面）
    var bandPts = [];
    for (var bp = -138; bp <= 138; bp += 7) bandPts.push(hp(35 - Math.abs(bp) * 0.06, bp, 1.062));
    var band = new THREE.Mesh(K.ribbon({
      pts: bandPts, widths: [0.082], thick: 0.022, ref: [0, 1, 0], seg: 28, radial: 6,
    }), matTrim);

    hairGroup.add(band);
    // 红角
    [1, -1].forEach(function (side) {
      var pts = [
        hp(24, side * 36, 1.0),
        hp(28, side * 40, 1.04),
        [side * 0.50, 1.18, 0.46],
        [side * 0.66, 1.34, 0.34],
        [side * 0.76, 1.44, 0.24],
      ];
      var horn = new THREE.Mesh(K.strand({ pts: pts, radii: [0.135, 0.125, 0.095, 0.055, 0.005], flat: 1.0, seg: 12, radial: 8 }), matHorn);
      K.outline(horn, { thickness: 0.0035, color: 0x7a1a2c });
      hairGroup.add(horn);
    });
    // 天使环高光
    for (var si = 0; si < 4; si++) {
      var ph2 = -54 + si * 36;
      var pts2 = [];
      for (var a = 26; a <= 52; a += 6) pts2.push(hp(a, ph2, 1.094));
      var shine = new THREE.Mesh(K.ribbon({ pts: pts2, widths: [0.085, 0.05], thick: 0.012, ref: [Math.cos(ph2 * D), 0, -Math.sin(ph2 * D)], seg: 8, radial: 5 }), matShine);
      shine.userData.noOutline = true;
      hairGroup.add(shine);
    }

    /* ---------------- 骨架 ---------------- */
    var rig = FIG.rig();
    rig.add("body", body, { k: 140, d: 18 });
    rig.add("torso", torso, { k: 160, d: 20 });
    rig.add("head", headGroup, { k: 150, d: 17 });
    rig.add("hairBack", hairBack, { k: 90, d: 14 });
    rig.add("hairGroup", hairGroup, { k: 120, d: 16 });
    rig.add("armR", arms[-1].shoulder, { k: 120, d: 15 });
    rig.add("armRElbow", arms[-1].elbow, { k: 120, d: 15 });
    rig.add("armL", arms[1].shoulder, { k: 120, d: 15 });
    rig.add("armLElbow", arms[1].elbow, { k: 120, d: 15 });
    rig.add("legL", legs[1].hip, { k: 130, d: 16 });
    rig.add("legR", legs[-1].hip, { k: 130, d: 16 });

    /* ---------------- 状态 ---------------- */
    var look = { x: 0, y: 0, tx: 0, ty: 0 };
    var state = "idle", stateT = 0;
    var blinkAt = 2 + Math.random() * 3, blinkT = -1;
    var mouthT = 0, patT = 0;

    var POSES = {
      idle: {
        armR: [0.0, 0.02, -2.34], armRElbow: [0, 0.05, -0.55],
        armL: [0.02, -0.04, 0.20], armLElbow: [0, -0.08, 0.38],
        head: [0.02, 0, 0],
      },
      happy: {
        armR: [-0.05, 0.10, -2.55], armRElbow: [0, 0.35, -0.7],
        armL: [0, 0.1, 0.55], armLElbow: [0, -0.2, 1.1],
        head: [-0.07, 0, 0],
      },
      talk: {
        armR: [0.02, 0.06, -2.2], armRElbow: [0.05, 0.25, -0.8],
        armL: [0.03, -0.05, 0.3], armLElbow: [0.06, -0.15, 0.55],
        head: [0.0, 0, 0],
      },
      sleep: {
        armR: [0.12, 0.2, -1.2], armRElbow: [0, 0.3, -0.5],
        armL: [0.12, -0.2, 1.2], armLElbow: [0, -0.3, 0.5],
        head: [0.18, 0.22, 0.12],
      },
      shy: {
        armR: [0.04, 0.08, -1.9], armRElbow: [0.1, 0.45, -1.15],
        armL: [0.04, -0.08, 0.38], armLElbow: [0.1, -0.3, 0.8],
        head: [0.06, 0.06, 0.1],
      },
      stretch: {
        armR: [0, 0.08, -2.85], armRElbow: [0, 0.12, -0.1],
        armL: [0, -0.08, 2.85], armLElbow: [0, -0.12, 0.1],
        head: [-0.12, 0, 0],
      },
      wink: {
        armR: [0.0, 0.02, -2.34], armRElbow: [0, 0.05, -0.55],
        armL: [0.02, -0.04, 0.22], armLElbow: [0, -0.08, 0.4],
        head: [0.02, 0.05, 0.09],
      },
      eat: {
        armR: [0.02, 0.08, -2.0], armRElbow: [0.15, 0.3, -1.3],
        armL: [0.02, -0.04, 0.2], armLElbow: [0, -0.08, 0.38],
        head: [0.02, 0, 0],
      },
    };

    function applyPose(name) {
      var p = POSES[name] || POSES.idle;
      rig.pose({
        armR: p.armR, armRElbow: p.armRElbow,
        armL: p.armL, armLElbow: p.armLElbow,
        head: p.head,
      });
    }
    applyPose("idle");

    function setState(name) {
      if (!POSES[name]) name = "idle";
      state = name;
      stateT = 0;
      applyPose(name);
      if (name === "sleep") {
        head.face.setMood("closed");
        head.face.setMouth("smile");
      } else if (name === "happy" || name === "stretch") {
        head.face.setMood("happy");
        head.face.setMouth("open");
        head.face.setBlush(1);
      } else if (name === "wink") {
        head.face.setMood("happy");
        head.face.setMouth("cat");
        head.face.setBlush(1);
      } else if (name === "shy") {
        head.face.setMood("half");
        head.face.setMouth("shy");
        head.face.setBlush(1);
      } else if (name === "eat") {
        head.face.setMood("happy");
        head.face.setMouth("open");
      } else if (name === "talk") {
        head.face.setMood("open");
        head.face.setMouth("smile");
      } else {
        head.face.setMood("open");
        head.face.setMouth("smile");
        head.face.setBlush(0.75);
      }
    }

    var char = {
      root: root,
      height: P.height,
      camera: P.camera,
      stateName: function () { return state; },
      setState: setState,
      setLook: function (x, y) {
        look.tx = K.clamp(x, -1, 1);
        look.ty = K.clamp(y, -1, 1);
      },
      pat: function () {
        patT = 1;
        setState("happy");
        head.face.setBlush(1);
        setTimeout(function () { if (state === "happy") setState("idle"); }, 1700);
      },
      update: function (dt, t) {
        stateT += dt;
        look.x += (look.tx - look.x) * Math.min(1, dt * 8);
        look.y += (look.ty - look.y) * Math.min(1, dt * 8);
        head.face.look(look.x, look.y);

        blinkAt -= dt;
        if (blinkAt <= 0 && state !== "sleep" && state !== "happy" && state !== "wink") {
          blinkAt = 2.2 + Math.random() * 3.4;
          blinkT = 0.13;
          head.face.setMood("closed");
        }
        if (blinkT > 0) {
          blinkT -= dt;
          if (blinkT <= 0) {
            if (state === "sleep") head.face.setMood("closed");
            else if (state === "happy" || state === "stretch" || state === "wink") head.face.setMood("happy");
            else if (state === "shy") head.face.setMood("half");
            else head.face.setMood("open");
          }
        }

        var breathe = Math.sin(t * 2.1);
        torso.scale.set(1 + breathe * 0.006, 1 + breathe * 0.012, 1 + breathe * 0.006);
        body.position.y = Math.sin(t * 2.1) * 0.014 + (state === "sleep" ? -0.05 : 0);

        rig.resetMotion();
        var sway = Math.sin(t * 1.1) * 0.5 + Math.sin(t * 0.63) * 0.5;
        rig.motion("body", 0, Math.sin(t * 0.42) * 0.02, sway * 0.012);
        rig.motion("head", Math.sin(t * 1.7) * 0.012 + look.y * 0.06, Math.sin(t * 0.53) * 0.05 + look.x * 0.32, Math.sin(t * 0.9) * 0.02 + look.x * 0.05);
        rig.motion("hairGroup", 0, 0, Math.sin(t * 1.3) * 0.008);
        rig.motion("hairBack", Math.sin(t * 1.5 + 0.6) * 0.025, Math.sin(t * 0.9) * 0.035, Math.sin(t * 1.1) * 0.02);
        rig.motion("armR", Math.sin(t * 1.6) * 0.02, 0, Math.sin(t * 1.55) * 0.04);
        rig.motion("armL", Math.sin(t * 1.4 + 1) * 0.02, 0, Math.sin(t * 1.3) * 0.03);
        // 招手
        rig.motion("armRElbow", 0, 0, Math.sin(t * 5.2) * 0.16);

        if (state === "talk" || state === "eat") {
          mouthT += dt;
          head.face.setMouth(Math.sin(mouthT * 11) > 0 ? "open" : "smile");
          rig.motion("head", Math.sin(t * 5) * 0.03, 0, Math.sin(t * 3.1) * 0.02);
        }

        if (patT > 0) {
          patT = Math.max(0, patT - dt * 2.2);
          var sq = Math.sin(patT * PI) * 0.06;
          root.scale.set(1 + sq * 0.7, 1 - sq, 1 + sq * 0.7);
        } else {
          root.scale.set(1, 1, 1);
        }
        if (state === "sleep") rig.motion("head", 0.12, 0.25, 0.14);
        rig.update(dt);
      },
      dispose: function () { K.dispose(root); },
    };
    return char;
  }

  var variants = {
    chibi: {
      meta: { id: "chibi", label: "Q版", height: PRESETS.chibi.height, camera: PRESETS.chibi.camera },
      build: function () { return buildChibi(PRESETS.chibi); },
    },
  };
  return { variants: variants };
};
