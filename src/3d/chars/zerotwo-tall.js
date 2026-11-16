/**
 * chars.zerotwo-tall —— 02 的「高个手办」：御姐 onee / 元气 genki
 *
 * 语言：同一套 Q 版手办材质与装配方式，但比例拉高（约 4.5~5 头身）：
 *   · 细腰、长腿、A 字裙摆、颈线拉长
 *   · 头发从「几根面条」升级成「外壳 + 多束 ribbon 发片 + 飘逸长带」三层结构
 *   · 红角 / 白领 / 橙色领带 / 双排扣白边 / 裤袜 / 靴子 / 大眼睛全部保留
 *
 * 两个形象共用 buildTall()，靠参数区分：
 *   onee  —— 白色发带 + 红角、长及膝的粉发、一手叉腰一手举棒棒糖、御姐眼型
 *   genki —— 奶油白贝雷帽、一只手举到头侧挥手的元气姿态、圆眼大笑 + 腮红 + 小星星
 *
 * 角色对象契约与 chars.zerotwo 一致：
 *   { root, height, camera, update(dt,t), setState(name), setLook(nx,ny), pat(), dispose() }
 */
module.exports.create = function (K, FIG, THREE) {
  "use strict";
  var PI = Math.PI, TAU = PI * 2, D = PI / 180;
  var sin = Math.sin, cos = Math.cos, sqrt = Math.sqrt, abs = Math.abs;
  var V3 = THREE.Vector3;
  var UP = new V3(0, 1, 0);
  var DOWN = new V3(0, -1, 0);

  /* ============================== 小工具 ============================== */
  /** 头局部坐标：theta 自 +Y 起，phi 自 +Z（正前方）起 */
  function hp(thetaDeg, phiDeg, rad) {
    var th = thetaDeg * D, ph = phiDeg * D;
    return [rad * sin(th) * sin(ph), rad * cos(th), rad * sin(th) * cos(ph)];
  }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function ease(t) { t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); }

  /** 大衣旋转体：给定 y 查表面半径（profile 必须从下往上） */
  function profR(prof, y) {
    if (y <= prof[0][1]) return prof[0][0];
    for (var i = 0; i < prof.length - 1; i++) {
      var a = prof[i], b = prof[i + 1];
      if (y >= a[1] && y <= b[1]) {
        var t = (y - a[1]) / Math.max(0.00001, b[1] - a[1]);
        return a[0] + (b[0] - a[0]) * t;
      }
    }
    return prof[prof.length - 1][0];
  }

  /** 反解手臂/腿：给定上段方向 du、下段方向 df（世界方向），算两节欧拉角 */
  function limbAngles(duArr, dfArr) {
    var du = new V3(duArr[0], duArr[1], duArr[2]).normalize();
    var df = new V3(dfArr[0], dfArr[1], dfArr[2]).normalize();
    var q1 = new THREE.Quaternion().setFromUnitVectors(DOWN, du);
    var e1 = new THREE.Euler().setFromQuaternion(q1, "XYZ");
    var local = df.clone().applyQuaternion(q1.clone().invert()).normalize();
    var q2 = new THREE.Quaternion().setFromUnitVectors(DOWN, local);
    var e2 = new THREE.Euler().setFromQuaternion(q2, "XYZ");
    return { a: [e1.x, e1.y, e1.z], b: [e2.x, e2.y, e2.z] };
  }

  /* ============================== 五官贴图（自绘） ============================== */
  /**
   * 02 风格的眼睛贴图（512）：绿色虹膜 + 深色上眼睑压线 + 外眼角红眼线。
   * 画布统一「内眼角在左、外眼角在右」，mirror=true 时整体水平翻转。
   * mood: open | half | happy | closed
   */
  function eyeTexture2(opt) {
    var S = 512, c = K.canvas(S, S), g = c.getContext("2d");
    var mirror = !!opt.mirror;
    if (mirror) { g.translate(S, 0); g.scale(-1, 1); }
    g.translate(-0.05 * S, 0);   // 让内外眼角在贴片里居中
    var round = opt.round == null ? 0.3 : opt.round;
    var iris = opt.iris || ["#155a4d", "#36b18c", "#bdf7e2"];
    var lash = opt.lash || "#43222f";
    var browC = opt.brow || "#cf86a4";
    var sclera = opt.sclera || "#fffafd";
    var linerC = opt.redLiner || "#e46886";
    var mood = opt.mood || "open";

    function mv(x, y) { g.moveTo(x * S, y * S); }
    function ln(x, y) { g.lineTo(x * S, y * S); }
    function qd(x1, y1, x2, y2) { g.quadraticCurveTo(x1 * S, y1 * S, x2 * S, y2 * S); }
    function bz(x1, y1, x2, y2, x3, y3) { g.bezierCurveTo(x1 * S, y1 * S, x2 * S, y2 * S, x3 * S, y3 * S); }

    var R2 = K.clamp(round, 0, 1);
    // 眼型关键点
    var inner = [0.165, 0.600 - R2 * 0.010];
    var outer = [0.900 - R2 * 0.020, 0.470 + R2 * 0.020];
    var topY = 0.382 - R2 * 0.085;
    var botY = 0.700 + R2 * 0.045;
    var topC1 = [0.320 - R2 * 0.02, topY + 0.020];
    var topC2 = [0.620 + R2 * 0.03, topY - R2 * 0.012];
    var botC1 = [0.740, botY - 0.020];
    var botC2 = [0.400, botY + 0.008];
    // half 时的上眼睑（压低）
    var lidY = [inner[0] + 0.10, 0.490 + R2 * 0.01];
    var lidC1 = [0.330, 0.470 + R2 * 0.02];
    var lidC2 = [0.620, 0.455 + R2 * 0.02];
    var lidEnd = [outer[0], outer[1] + 0.020];

    function lidPath(lower) {
      g.beginPath();
      mv(inner[0], inner[1]);
      if (lower) {
        bz(lidC1[0], lidC1[1], lidC2[0], lidC2[1], lidEnd[0], lidEnd[1]);
        bz(outer[0] - 0.12, botY - 0.06, botC2[0], botC2[1], inner[0], inner[1]);
      } else {
        bz(topC1[0], topC1[1], topC2[0], topC2[1], outer[0], outer[1]);
        bz(botC1[0], botC1[1], botC2[0], botC2[1], inner[0], inner[1]);
      }
      g.closePath();
    }

    function drawBrow() {
      g.strokeStyle = browC;
      g.lineCap = "round";
      g.lineWidth = S * 0.016;
      g.globalAlpha = 0.95;
      g.beginPath();
      mv(0.245, 0.268);
      qd(0.420, 0.212, 0.680, 0.252);
      g.stroke();
      g.globalAlpha = 1;
    }

    function drawLash(thick, lowerLid) {
      g.fillStyle = lash;
      g.beginPath();
      if (!lowerLid) {
        mv(inner[0] - 0.010, inner[1] - 0.005);
        bz(topC1[0] - 0.01, topC1[1] - 0.030, topC2[0] + 0.02, topC2[1] - 0.036, outer[0] + 0.012, outer[1] - 0.016);
        ln(outer[0] + 0.075, outer[1] - 0.075);              // 眼尾上挑
        bz(topC2[0] + 0.01, topC2[1] + thick * 0.55, topC1[0], topC1[1] + thick * 0.65, inner[0] - 0.004, inner[1] + 0.004);
        g.closePath();
      } else {
        mv(inner[0] - 0.004, inner[1] + 0.004);
        bz(lidC1[0], lidC1[1] + 0.038, lidC2[0], lidC2[1] + 0.040, lidEnd[0] + 0.005, lidEnd[1] + 0.020);
        ln(outer[0] + 0.060, outer[1] - 0.030);
        bz(lidC2[0], lidC2[1] + 0.004, lidC1[0], lidC1[1] + 0.004, inner[0], inner[1]);
        g.closePath();
      }
      g.fill();
      // 眼尾小睫毛
      g.strokeStyle = lash;
      g.lineWidth = S * 0.014;
      g.lineCap = "round";
      for (var i = 0; i < 2; i++) {
        g.beginPath();
        mv(outer[0] + 0.005 - i * 0.055, outer[1] - 0.020 + i * 0.030);
        ln(outer[0] + 0.055 - i * 0.050, outer[1] - 0.075 + i * 0.035);
        g.stroke();
      }
    }

    function drawRedLiner() {
      g.strokeStyle = linerC;
      g.lineCap = "round";
      g.globalAlpha = 0.9;
      g.lineWidth = S * 0.017;
      g.beginPath();
      mv(outer[0] + 0.020, outer[1] + 0.008);
      qd(outer[0] + 0.055, outer[1] - 0.028, outer[0] + 0.088, outer[1] - 0.068);
      g.stroke();
      g.globalAlpha = 0.55;
      g.lineWidth = S * 0.011;
      g.beginPath();
      mv(outer[0] + 0.035, outer[1] + 0.030);
      ln(outer[0] + 0.105, outer[1] - 0.010);
      g.stroke();
      g.globalAlpha = 1;
    }

    function drawIris(clipHalf) {
      var cx = 0.548 - R2 * 0.01, cy = 0.548 + (clipHalf ? R2 * 0.02 : 0);
      var rx = 0.200 + R2 * 0.048, ry = 0.235 + R2 * 0.035;
      // 虹膜渐变
      var ig = g.createLinearGradient(0, (cy - ry) * S, 0, (cy + ry) * S);
      ig.addColorStop(0, iris[0]);
      ig.addColorStop(0.52, iris[1]);
      ig.addColorStop(1, iris[2]);
      g.fillStyle = ig;
      g.beginPath();
      g.ellipse(cx * S, cy * S, rx * S, ry * S, 0, 0, TAU);
      g.fill();
      // 外圈
      g.strokeStyle = "rgba(18,48,44,0.5)";
      g.lineWidth = S * 0.014;
      g.beginPath();
      g.ellipse(cx * S, cy * S, rx * S, ry * S, 0, 0, TAU);
      g.stroke();
      // 底部反光
      var rg = g.createRadialGradient(cx * S, (cy + ry * 0.5) * S, 0, cx * S, (cy + ry * 0.5) * S, rx * S * 1.1);
      rg.addColorStop(0, "rgba(240,255,248,0.55)");
      rg.addColorStop(1, "rgba(240,255,248,0)");
      g.fillStyle = rg;
      g.beginPath();
      g.ellipse(cx * S, (cy + ry * 0.55) * S, rx * S * 0.8, ry * S * 0.45, 0, 0, TAU);
      g.fill();
      // 瞳孔
      g.fillStyle = "rgba(9,32,30,0.9)";
      g.beginPath();
      g.ellipse(cx * S, cy * S, rx * S * 0.30, ry * S * 0.44, 0, 0, TAU);
      g.fill();
      // 高光
      g.fillStyle = "#ffffff";
      g.globalAlpha = 0.95;
      g.beginPath();
      g.ellipse((cx - rx * 0.34) * S, (cy - ry * 0.40) * S, rx * S * 0.24, ry * S * 0.21, -0.4, 0, TAU);
      g.fill();
      g.globalAlpha = 0.8;
      g.beginPath();
      g.ellipse((cx + rx * 0.40) * S, (cy + ry * 0.38) * S, rx * S * 0.11, ry * S * 0.10, 0, 0, TAU);
      g.fill();
      g.globalAlpha = 1;
    }

    if (mood === "happy") {
      // 弯月眼（开心）
      g.strokeStyle = lash;
      g.lineCap = "round";
      g.lineWidth = S * (0.042 + R2 * 0.012);
      g.beginPath();
      mv(0.185, 0.660);
      bz(0.330, 0.410, 0.610, 0.380, 0.900, 0.575);
      g.stroke();
      g.lineWidth = S * 0.020;
      g.beginPath();
      mv(0.760, 0.470);
      ln(0.905, 0.560);
      g.stroke();
      // 下眼睑淡线
      g.globalAlpha = 0.35;
      g.strokeStyle = lash;
      g.lineWidth = S * 0.012;
      g.beginPath();
      mv(0.600, 0.735);
      qd(0.720, 0.760, 0.845, 0.640);
      g.stroke();
      g.globalAlpha = 1;
      drawBrow();
      return K.tex(c);
    }
    if (mood === "closed") {
      g.strokeStyle = lash;
      g.lineCap = "round";
      g.lineWidth = S * (0.030 + R2 * 0.008);
      g.beginPath();
      mv(0.190, 0.585);
      bz(0.340, 0.690, 0.620, 0.700, 0.890, 0.560);
      g.stroke();
      g.lineWidth = S * 0.015;
      g.beginPath();
      mv(0.790, 0.615);
      ln(0.905, 0.545);
      g.stroke();
      drawBrow();
      return K.tex(c);
    }

    var half = mood === "half";
    // 眼白
    lidPath(half);
    g.fillStyle = sclera;
    g.fill();
    // 上眼睑投影
    g.save();
    lidPath(half);
    g.clip();
    var sg = g.createLinearGradient(0, (inner[1] - 0.22) * S, 0, (inner[1] + 0.03) * S);
    sg.addColorStop(0, "rgba(96,62,96,0.34)");
    sg.addColorStop(1, "rgba(96,62,96,0)");
    g.fillStyle = sg;
    g.fillRect(0, 0, S, S);
    // 虹膜（裁在眼型里）
    drawIris(half);
    g.restore();
    // 下眼睑淡线
    g.strokeStyle = lash;
    g.globalAlpha = 0.42;
    g.lineWidth = S * 0.010;
    g.lineCap = "round";
    g.beginPath();
    mv(0.520, 0.690);
    qd(0.670, 0.716, 0.805, 0.618);
    g.stroke();
    g.globalAlpha = 1;
    drawLash(half ? 0.026 : 0.034, half);
    drawRedLiner();
    drawBrow();
    return K.tex(c);
  }

  /** 02 风格的小嘴（256）：smile / cat / open / grin / shy / o / wavy */
  function mouthTexture2(kind, lip, innerC) {
    var S = 256, c = K.canvas(S, S), g = c.getContext("2d");
    lip = lip || "#b4566e";
    innerC = innerC || "#8e3550";
    g.lineCap = "round";
    g.lineJoin = "round";
    if (kind === "smile" || kind === "shy") {
      g.strokeStyle = lip;
      g.lineWidth = S * 0.046;
      g.beginPath();
      g.moveTo(S * 0.315, S * 0.43);
      g.quadraticCurveTo(S * 0.50, S * (kind === "shy" ? 0.590 : 0.660), S * 0.685, S * 0.43);
      g.stroke();
      // 下唇一点淡色
      g.globalAlpha = 0.28;
      g.strokeStyle = "#ff9db4";
      g.lineWidth = S * 0.030;
      g.beginPath();
      g.moveTo(S * 0.40, S * 0.505);
      g.quadraticCurveTo(S * 0.50, S * 0.545, S * 0.60, S * 0.505);
      g.stroke();
      g.globalAlpha = 1;
    } else if (kind === "cat") {
      g.strokeStyle = lip;
      g.lineWidth = S * 0.042;
      g.beginPath();
      g.moveTo(S * 0.315, S * 0.500);
      g.quadraticCurveTo(S * 0.405, S * 0.665, S * 0.500, S * 0.520);
      g.quadraticCurveTo(S * 0.595, S * 0.665, S * 0.685, S * 0.500);
      g.stroke();
    } else if (kind === "open" || kind === "grin") {
      var w = kind === "grin" ? 0.255 : 0.195;
      var h = kind === "grin" ? 0.255 : 0.205;
      g.fillStyle = innerC;
      g.beginPath();
      g.moveTo((0.5 - w) * S, 0.455 * S);
      g.quadraticCurveTo(0.5 * S, (0.455 + h * 1.75) * S, (0.5 + w) * S, 0.455 * S);
      g.quadraticCurveTo(0.5 * S, (0.455 + h * 0.55) * S, (0.5 - w) * S, 0.455 * S);
      g.fill();
      // 舌头
      g.fillStyle = "#ea8b9f";
      g.beginPath();
      g.ellipse(0.5 * S, (0.455 + h * 1.02) * S, w * 0.55 * S, h * 0.36 * S, 0, 0, TAU);
      g.fill();
      // 上唇线
      g.strokeStyle = lip;
      g.lineWidth = S * 0.040;
      g.beginPath();
      g.moveTo((0.5 - w) * S, 0.455 * S);
      g.quadraticCurveTo(0.5 * S, (0.455 + h * 1.75) * S, (0.5 + w) * S, 0.455 * S);
      g.stroke();
      if (kind === "grin") {
        g.fillStyle = "#fffdfb";
        g.beginPath();
        g.moveTo((0.5 - w * 0.92) * S, 0.470 * S);
        g.quadraticCurveTo(0.5 * S, 0.585 * S, (0.5 + w * 0.92) * S, 0.470 * S);
        g.quadraticCurveTo(0.5 * S, 0.520 * S, (0.5 - w * 0.92) * S, 0.470 * S);
        g.fill();
      }
    } else if (kind === "o") {
      g.fillStyle = innerC;
      g.beginPath();
      g.ellipse(0.5 * S, 0.545 * S, 0.105 * S, 0.135 * S, 0, 0, TAU);
      g.fill();
    } else if (kind === "wavy") {
      g.strokeStyle = lip;
      g.lineWidth = S * 0.042;
      g.beginPath();
      g.moveTo(S * 0.335, S * 0.500);
      g.quadraticCurveTo(S * 0.415, S * 0.415, S * 0.490, S * 0.510);
      g.quadraticCurveTo(S * 0.565, S * 0.605, S * 0.665, S * 0.495);
      g.stroke();
    } else {
      g.fillStyle = lip;
      g.beginPath();
      g.ellipse(0.5 * S, 0.52 * S, 0.085 * S, 0.060 * S, 0, 0, TAU);
      g.fill();
    }
    return K.tex(c);
  }

  /* ============================== 尺寸 ============================== */
  var L = {
    H: 6.40,
    headR: 0.80,
    headY: 5.52,
    shoulderY: 4.32,
    shoulderX: 0.610,
    waistY: 3.60,
    hipY: 3.02,
    hipX: 0.235,
    thigh: 1.34,
    shin: 1.40,
    hemY: 2.34,
    armU: 0.93,
    armF: 0.86,
  };

  /** 大衣（含 A 字裙摆）的旋转体轮廓，从下往上 */
  var COAT_PROFILE = [
    [0.001, 2.520], [0.380, 2.528], [0.720, 2.536], [0.900, 2.545],
    [0.952, 2.558], [0.966, 2.584], [0.952, 2.616], [0.912, 2.664],
    [0.852, 2.724], [0.782, 2.800], [0.704, 2.886], [0.624, 2.976],
    [0.552, 3.070], [0.492, 3.166], [0.444, 3.268], [0.402, 3.378],
    [0.366, 3.490], [0.344, 3.600], [0.352, 3.704], [0.380, 3.812],
    [0.418, 3.916], [0.442, 4.018], [0.452, 4.108], [0.446, 4.188],
    [0.430, 4.262], [0.404, 4.332], [0.364, 4.396], [0.300, 4.448],
    [0.236, 4.494], [0.190, 4.520],
  ];

  /* ============================== 两个形象 ============================== */
  var ONEE = {
    id: "onee",
    label: "02 · 御姐",
    height: 6.40,
    scale: 1.0,
    camera: { height: 6.4, targetY: 3.2, margin: 1.06, elevation: 0.07, glowColor: 0xff6f96 },
    colors: {
      skin: 0xffe6d4, skinShade: 0xefb0a3,
      hair: 0xf1b3cf, hairShade: 0xba6c95, hairHi: 0xffeaf6, hairDeep: 0xd98cb4,
      outline: 0x432633, hairOutline: 0x7d3c5f,
      coat: 0xb81f33, coatShade: 0x6b0d1b, coatTrim: 0xf9f0ea, coatTrimShade: 0xdcc2c8,
      tie: 0xef8a24, tieShade: 0xb95a0c,
      tights: 0x3a2f46, tightsShade: 0x211a2a,
      boot: 0x2b2134, bootShade: 0x17111f, bootTrim: 0xfdf5f0,
      dark: 0x2a202f, gold: 0xe0bd72, belt: 0x2e2333,
      horn: 0xf04a5c, hornShade: 0xb02036,
      eye: { iris: ["#12574a", "#33ad89", "#bdf8e2"], lash: "#3f1f2c", brow: "#cd84a2", round: 0.20, sclera: "#fffcfe" },
      eyeLiner: "#e46886",
      mouthBase: { lip: "#b4566e", inner: "#8e3550" },
      blushColor: "rgba(255,120,150,0.55)",
    },
    face: {
      R: 0.80, scale: [0.985, 1.045, 0.975],
      eyeX: 0.458, eyeY: -0.048, eyeW: 0.70, eyeH: 0.70,
      faceY: -0.070, mouthY: -0.480, jaw: 0.30,
      blush: true, blushOpacity: 0.8, mouth: { kind: "smile", lip: "#b4566e" },
    },
    hair: {
      capScale: 1.052, capFront: 0.300, capBack: 0.940,
      curtain: { lenMid: 4.00, lenSide: 3.10, r0: 0.842, r1: 1.020, z0: 0.500, z1: 0.595, zc0: -0.085, zc1: -0.265 },
      backPhis: [110, 128, 146, 163, 180, 197, 214, 232, 250],
      backLen: [3.30, 3.68, 3.96, 4.14, 4.22, 4.14, 3.96, 3.68, 3.30],
      backWidth: 0.300,
      bangs: 9, bangTip: 86, bangSpread: 80,
      ahoge: false,
      heroes: [
        { pts: [[-0.76, 0.02, 0.10], [-1.00, -0.26, 0.30], [-1.16, -0.66, 0.38], [-1.22, -1.08, 0.28], [-1.18, -1.50, 0.10], [-1.06, -1.84, -0.02], [-0.92, -2.04, 0.02], [-0.84, -2.14, 0.16]],
          radii: [0.075, 0.082, 0.076, 0.062, 0.046, 0.030, 0.016, 0.002], flat: 0.75 },
        { pts: [[-0.64, -0.24, 0.34], [-0.82, -0.92, 0.50], [-0.86, -1.56, 0.42], [-0.76, -2.06, 0.22], [-0.62, -2.38, 0.10], [-0.52, -2.52, 0.20]],
          radii: [0.045, 0.058, 0.056, 0.044, 0.026, 0.002], flat: 0.72 },
        { pts: [[0.74, 0.06, 0.08], [0.98, -0.22, 0.28], [1.14, -0.62, 0.36], [1.20, -1.04, 0.26], [1.16, -1.46, 0.08], [1.04, -1.80, -0.03], [0.90, -2.00, 0.02], [0.82, -2.10, 0.16]],
          radii: [0.070, 0.078, 0.072, 0.058, 0.043, 0.028, 0.015, 0.002], flat: 0.75 },
        { pts: [[0.60, 0.34, 0.12], [0.78, 0.18, 0.26], [0.90, -0.16, 0.32], [0.94, -0.58, 0.28], [0.88, -0.96, 0.16], [0.78, -1.18, 0.08]],
          radii: [0.040, 0.052, 0.050, 0.040, 0.026, 0.002], flat: 0.72 },
      ],
    },
    hat: "band",
    stick: true,
    sparkle: false,
    idleStick: [0.05, 1, 0.16],
  };

  var GENKI = {
    id: "genki",
    label: "02 · 元气",
    height: 6.20,
    scale: 6.20 / 6.40,
    camera: { height: 6.2, targetY: 3.1, margin: 1.06, elevation: 0.07, glowColor: 0xff8f6f },
    colors: {
      skin: 0xffe7d5, skinShade: 0xf0b2a4,
      hair: 0xefabc8, hairShade: 0xb96590, hairHi: 0xffe6f3, hairDeep: 0xd586ae,
      outline: 0x432633, hairOutline: 0x7d3c5f,
      coat: 0xc62f3a, coatShade: 0x7a121e, coatTrim: 0xfbf2ec, coatTrimShade: 0xdfc8ce,
      tie: 0xf59a2b, tieShade: 0xc06510,
      tights: 0x3e3249, tightsShade: 0x241d2e,
      boot: 0xfdf4ea, bootShade: 0xdfc9c8, bootTrim: 0xd23a44,
      dark: 0x2a202f, gold: 0xe0bd72, belt: 0x2e2333,
      horn: 0xf04a5c, hornShade: 0xb02036,
      eye: { iris: ["#0f6152", "#39c297", "#ccffec"], lash: "#421f2d", brow: "#d08ea9", round: 0.62, sclera: "#fffdfe" },
      eyeLiner: "#e8758e",
      mouthBase: { lip: "#b9506c", inner: "#8e3550" },
      blushColor: "rgba(255,126,155,0.6)",
    },
    face: {
      R: 0.80, scale: [0.985, 1.04, 0.978],
      eyeX: 0.468, eyeY: -0.052, eyeW: 0.74, eyeH: 0.74,
      faceY: -0.070, mouthY: -0.480, jaw: 0.24,
      blush: true, blushOpacity: 0.95, mouth: { kind: "smile", lip: "#b9506c" },
    },
    hair: {
      capScale: 1.052, capFront: 0.302, capBack: 0.942,
      curtain: { lenMid: 3.55, lenSide: 2.85, r0: 0.842, r1: 1.000, z0: 0.500, z1: 0.585, zc0: -0.085, zc1: -0.250 },
      backPhis: [110, 128, 146, 163, 180, 197, 214, 232, 250],
      backLen: [2.95, 3.28, 3.50, 3.64, 3.72, 3.64, 3.50, 3.28, 2.95],
      backWidth: 0.292,
      bangs: 9, bangTip: 83, bangSpread: 82,
      ahoge: true,
      heroes: [
        { pts: [[0.74, 0.20, 0.08], [0.98, -0.08, 0.28], [1.14, -0.50, 0.38], [1.20, -0.96, 0.28], [1.16, -1.40, 0.10], [1.04, -1.74, -0.02], [0.90, -1.94, 0.04], [0.82, -2.04, 0.18]],
          radii: [0.075, 0.082, 0.076, 0.062, 0.046, 0.030, 0.016, 0.002], flat: 0.75 },
        { pts: [[-0.70, -0.06, 0.16], [-0.94, -0.34, 0.34], [-1.08, -0.78, 0.38], [-1.10, -1.20, 0.24], [-1.00, -1.58, 0.08], [-0.86, -1.86, 0.02], [-0.74, -2.00, 0.14]],
          radii: [0.060, 0.070, 0.066, 0.054, 0.038, 0.022, 0.010, 0.002], flat: 0.72 },
        { pts: [[-0.58, -0.30, 0.36], [-0.74, -0.90, 0.48], [-0.76, -1.46, 0.38], [-0.64, -1.92, 0.18], [-0.50, -2.18, 0.08], [-0.42, -2.28, 0.18]],
          radii: [0.038, 0.048, 0.046, 0.034, 0.018, 0.002], flat: 0.7 },
      ],
    },
    hat: "beret",
    stick: false,
    sparkle: true,
    idleStick: [0.05, 1, 0.16],
  };

  /* ============================== 主装配 ============================== */
  function buildTall(P) {
    var C = P.colors, FT = P.face, HA = P.hair, HR = L.headR;
    var root = new THREE.Group();
    var content = K.group(root);
    content.scale.setScalar(P.scale || 1);

    var O = { thickness: 0.0082, color: C.outline };      // 大件描边
    var OH = { thickness: 0.0060, color: C.outline };     // 小件描边
    var OS = { thickness: 0.0045, color: C.outline };     // 细节描边

    /* ---------------- 材质 ---------------- */
    var matSkin = K.cel({ side: THREE.DoubleSide,  color: C.skin, shade: C.skinShade, rim: 0xffd8e4, rimStr: 0.11, hiStr: 0.10, lift: 0.72 });
    var matHair = K.cel({ side: THREE.DoubleSide,  color: C.hair, shade: C.hairShade, hi: C.hairHi, rim: 0xffe5f2, rimStr: 0.22, hiStr: 0.32, spec: 0.10, specPow: 20 });
    var matHairBack = K.cel({ side: THREE.DoubleSide,  color: C.hair, shade: C.hairShade, hi: C.hairHi, rim: 0xffdcee, rimStr: 0.15, hiStr: 0.20 });
    var matHairDeep = K.cel({ side: THREE.DoubleSide,  color: C.hairDeep, shade: C.hairShade, hi: C.hairHi, rim: 0xffd2e8, rimStr: 0.12, hiStr: 0.14 });
    var matHairShine = new THREE.MeshBasicMaterial({ color: 0xffe9f5, transparent: true, opacity: 0.45, depthWrite: false, side: THREE.DoubleSide });
    var matCoat = K.cel({ side: THREE.DoubleSide,  color: C.coat, shade: C.coatShade, rim: 0xff9fb0, rimStr: 0.18, hiStr: 0.36, spec: 0.05, specPow: 24 });
    var matCoatDark = K.cel({ side: THREE.DoubleSide,  color: C.coatShade, shade: 0x4d0a17, rim: 0xff8fa2, rimStr: 0.16 });
    var matTrim = K.cel({ side: THREE.DoubleSide,  color: C.coatTrim, shade: C.coatTrimShade, rim: 0xffffff, rimStr: 0.18, hiStr: 0.16 });
    var matTie = K.cel({ side: THREE.DoubleSide,  color: C.tie, shade: C.tieShade, rim: 0xffd2a0, rimStr: 0.16, hiStr: 0.24 });
    var matTights = K.cel({ side: THREE.DoubleSide,  color: C.tights, shade: C.tightsShade, rim: 0xffb6d2, rimStr: 0.26, spec: 0.16, specPow: 36, lift: 0.14 });
    var matBoot = K.cel({ side: THREE.DoubleSide,  color: C.boot, shade: C.bootShade, rim: 0xffffff, rimStr: 0.20, spec: 0.14, specPow: 40 });
    var matBootTrim = K.cel({ side: THREE.DoubleSide,  color: C.bootTrim, shade: C.bootTrim, rim: 0xffffff, rimStr: 0.15 });
    var matBelt = K.cel({ side: THREE.DoubleSide,  color: C.belt, shade: 0x140f18, rim: 0xc79aa8, rimStr: 0.12, lift: 0.12 });
    var matGold = K.cel({ side: THREE.DoubleSide,  color: C.gold, shade: 0x9a7a38, rim: 0xfff0c0, rimStr: 0.2, hiStr: 0.4, spec: 0.25, specPow: 30 });
    var matDark = K.cel({ side: THREE.DoubleSide,  color: C.dark, shade: 0x141018, rim: 0xa88294, rimStr: 0.10, lift: 0.1 });
    var matBeret = K.cel({ side: THREE.DoubleSide,  color: 0xf7efe2, shade: 0xd9c8bd, rim: 0xffffff, rimStr: 0.2, hiStr: 0.24 });
    var matBeretBand = K.cel({ side: THREE.DoubleSide,  color: 0xe7d9c5, shade: 0xc2b09e, rim: 0xffffff, rimStr: 0.16 });
    var matCandy = K.cel({ side: THREE.DoubleSide,  color: 0x2bbf88, shade: 0x0e7a56, hi: 0xb9ffe4, rim: 0xc9ffe9, rimStr: 0.3, hiStr: 0.3, spec: 0.4, specPow: 50 });
    var matStickWhite = K.cel({ side: THREE.DoubleSide,  color: 0xfffaf3, shade: 0xe6d9d6, rim: 0xffffff, rimStr: 0.1 });
    var hornTex = K.canvasTexWH(8, 128, function (x, w, h) {
      var g = x.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, "#ffb7c2");
      g.addColorStop(0.35, "#fa5a6c");
      g.addColorStop(1, "#b81f36");
      x.fillStyle = g;
      x.fillRect(0, 0, w, h);
    });
    var matHorn = new THREE.MeshBasicMaterial({ map: hornTex, side: THREE.DoubleSide });
    var matHeart = new THREE.MeshBasicMaterial({ color: 0xff7ba4, transparent: true, opacity: 0.92, depthWrite: false });
    var matSpark = new THREE.MeshBasicMaterial({ color: 0xffd35c, transparent: true, opacity: 0.95, depthWrite: false });

    /* ---------------- 贴图缓存 ---------------- */
    var eyeCfg = C.eye;
    var eyeCache = {}, mouthCache = {};
    function eyeTex(side, mood) {
      var key = side + ":" + mood;
      if (eyeCache[key]) return eyeCache[key];
      var t = eyeTexture2(Object.assign({}, eyeCfg, {
        mirror: side < 0, mood: mood, redLiner: C.eyeLiner,
      }));
      return (eyeCache[key] = t);
    }
    function mouthTex(kind) {
      if (mouthCache[kind]) return mouthCache[kind];
      return (mouthCache[kind] = mouthTexture2(kind, C.mouthBase.lip, C.mouthBase.inner));
    }

    /* ---------------- 身体骨架组 ---------------- */
    var body = K.group(content);         // 整个人（呼吸/拍一拍挤压）
    var torso = K.group(body);           // 上身（含头、手臂、大衣）
    var legs = {};

    /* ================================================================
     * 1. 腿 / 裤袜 / 靴
     * ================================================================ */
    function buildLeg(side) {
      var hip = K.group(body, [side * L.hipX, L.hipY, 0]);
      var thighProf = [
        [0.140, 0.00], [0.148, 0.10], [0.178, 0.32], [0.210, 0.62],
        [0.230, 0.92], [0.242, 1.16], [0.238, 1.30], [0.225, 1.34],
      ];
      var thigh = new THREE.Mesh(K.lathe(thighProf, 22), matTights);
      thigh.position.y = -L.thigh;
      hip.add(thigh);
      K.outline(thigh, O);

      var knee = K.group(hip, [0, -L.thigh, 0]);
      var shinProf = [
        [0.092, 0.00], [0.104, 0.10], [0.132, 0.28], [0.163, 0.52],
        [0.172, 0.76], [0.163, 1.02], [0.150, 1.24], [0.148, 1.40],
      ];
      var shin = new THREE.Mesh(K.lathe(shinProf, 22), matTights);
      shin.position.y = -L.shin;
      knee.add(shin);
      K.outline(shin, O);

      var ankle = K.group(knee, [0, -L.shin, 0]);
      ankle.rotation.y = side * 0.10;
      var isDarkBoot = P.hat === "band";

      // 鞋：圆头短靴（onee 深色亮面短靴 / genki 奶油白短靴 + 红边）
      var bootShaft = new THREE.Mesh(K.lathe([
        [0.124, 0.00], [0.134, 0.05], [0.132, 0.16], [0.128, 0.26],
        [0.138, 0.34], [0.146, 0.385], [0.140, 0.400],
      ], 20), matBoot);
      bootShaft.position.y = -0.325;
      ankle.add(bootShaft);
      K.outline(bootShaft, OS);

      var toe = new THREE.Mesh(K.sphere(0.155, 1.04, 0.60, 1.78, 18), matBoot);
      toe.position.set(0, -0.235, 0.075);
      ankle.add(toe);
      K.outline(toe, OS);

      var sole = new THREE.Mesh(K.lathe([[0.001, 0.0], [0.150, 0.004], [0.163, 0.026], [0.156, 0.050], [0.130, 0.056], [0.001, 0.058]], 20), matDark);
      sole.position.set(0, -0.318, 0.062);
      sole.scale.z = 1.62;
      ankle.add(sole);

      var heel = new THREE.Mesh(new THREE.BoxGeometry(0.092, 0.105, 0.092), matDark);
      heel.position.set(0, -0.268, -0.088);
      heel.scale.z = 0.85;
      ankle.add(heel);

      // 靴口滚边
      var cuff = new THREE.Mesh(K.ring(0.140, isDarkBoot ? 0.024 : 0.034, TAU, 8), matBootTrim);
      cuff.rotation.x = PI / 2;
      cuff.position.y = 0.070;
      ankle.add(cuff);


      return { hip: hip, knee: knee, ankle: ankle };
    }
    legs[1] = buildLeg(1);
    legs[-1] = buildLeg(-1);

    /* ================================================================
     * 2. 大衣 + 白边 / 双排扣 / 领带 / 腰带 / 肩章
     * ================================================================ */
    var coatGeo = K.lathe(COAT_PROFILE, 64);
    (function () {
      var pp = coatGeo.attributes.position;
      for (var i = 0; i < pp.count; i++) {
        var x = pp.getX(i), y = pp.getY(i), z = pp.getZ(i);
        var r = sqrt(x * x + z * z);
        if (r < 1e-5) continue;
        var ang = Math.atan2(x, z);
        var skirtT = K.clamp((3.30 - y) / 0.75, 0, 1);          // 越靠近裙摆越明显
        var fold = (0.020 * sin(ang * 9 + 0.6) + 0.010 * sin(ang * 4 - 1.1)) * skirtT * skirtT;
        var drape = (0.008 * sin(ang * 17 + 2.0)) * skirtT;
        var k2 = (r + fold + drape) / r;
        pp.setXYZ(i, x * k2, y, z * k2);
      }
      coatGeo.computeVertexNormals();
    })();
    var coat = new THREE.Mesh(coatGeo, matCoat);
    torso.add(coat);
    K.outline(coat, O);

    function surfZ(y, x, off) {
      var r = profR(COAT_PROFILE, y) * 0.998 + 0.004;
      return sqrt(Math.max(0.0001, r * r - x * x)) + (off == null ? 0.01 : off);
    }
    function surfP(y, x, off) { return [x, y, surfZ(y, x, off)]; }

    // 裙摆白色滚边（沿 hem 一圈）
    var hemR = profR(COAT_PROFILE, 2.586) + 0.002;
    var hem = new THREE.Mesh(K.ring(hemR, 0.030, TAU, 10), matTrim);
    hem.rotation.x = PI / 2;
    hem.position.y = 2.590;
    hem.scale.set(1, 1, 1.01);
    torso.add(hem);

    // 双排扣前襟（浮在衣面上的薄片 + 白边 + 扣子）
    var plackProfile = [];
    for (var pi = 0; pi < COAT_PROFILE.length; pi++) {
      var py = COAT_PROFILE[pi][1];
      if (py < 3.28 || py > 4.24) continue;
      plackProfile.push([COAT_PROFILE[pi][0] * 1.004 + 0.008, py]);
    }
    if (plackProfile.length) {
      var plack = new THREE.Mesh(K.lathe(plackProfile, 30, -0.52, 1.04), matCoat);
      plack.renderOrder = 1;
      torso.add(plack);
    }
    // 前襟两侧白边（沿弧面走）
    [1, -1].forEach(function (sd) {
      var pts = [];
      for (var yy = 3.30; yy <= 4.22; yy += 0.06) {
        var rr = profR(COAT_PROFILE, yy) * 1.006 + 0.012;
        var x = sd * rr * sin(0.46);
        pts.push([x, yy, rr * cos(0.46)]);
      }
      var strip = new THREE.Mesh(K.ribbon({ pts: pts, widths: [0.030, 0.026], thick: 0.010, ref: [1, 0, 0], seg: 16, radial: 5 }), matTrim);
      strip.userData.noOutline = true;
      torso.add(strip);
    });
    // 双排扣：两列深色扣子 + 金色小点
    for (var bi = 0; bi < 5; bi++) {
      var by = 4.14 - bi * 0.175;
      [-1, 1].forEach(function (sd) {
        var bx = sd * 0.148;
        var bz = surfZ(by, bx, 0.012);
        K.mesh(K.sphere(0.030, 1, 1, 1, 12), matDark, torso, [bx, by, bz]);
        K.mesh(K.sphere(0.011, 1, 1, 1, 8), matGold, torso, [bx, by, bz + 0.026]);
      });
    }
    // 裙摆前中缝白色细线
    (function () {
      var pts = [];
      for (var yy = 3.34; yy >= 2.60; yy -= 0.06) {
        var rr = profR(COAT_PROFILE, yy) * 1.004 + 0.010;
        var x = 0.085;
        pts.push([x, yy, sqrt(Math.max(0.0001, rr * rr - x * x))]);
      }
      var seam = new THREE.Mesh(K.ribbon({ pts: pts, widths: [0.016, 0.014], thick: 0.008, ref: [1, 0, 0], seg: 18, radial: 4 }), matTrim);
      seam.userData.noOutline = true;
      torso.add(seam);
    })();

    // 腰带 + 金扣
    var beltY = 3.64;
    var beltR = profR(COAT_PROFILE, beltY) + 0.020;
    var belt = new THREE.Mesh(K.ring(beltR, 0.062, TAU, 10), matBelt);
    belt.rotation.x = PI / 2;
    belt.position.y = beltY;
    belt.scale.set(1.0, 0.58, 1.02);
    torso.add(belt);
    K.mesh(K.box(0.15, 0.115, 0.055), matGold, torso, [0, beltY, surfZ(beltY, 0, 0.035)]);
    K.mesh(K.box(0.085, 0.055, 0.02), matBelt, torso, [0, beltY, surfZ(beltY, 0, 0.062)]);
    // 腰带白色细边（上下两道）
    [beltY + 0.075, beltY - 0.075].forEach(function (yy) {
      var r2 = profR(COAT_PROFILE, yy) + 0.024;
      var line = new THREE.Mesh(K.ring(r2, 0.010, TAU, 6), matTrim);
      line.rotation.x = PI / 2;
      line.position.y = yy;
      torso.add(line);
    });

    // 白领（立领围脖 + 前领尖）
    var collar = new THREE.Mesh(K.lathe([
      [0.186, 4.430], [0.212, 4.478], [0.244, 4.520], [0.276, 4.548], [0.262, 4.564],
    ], 40), matTrim);
    torso.add(collar);
    K.outline(collar, OS);
    [-1, 1].forEach(function (sd) {
      var shape = new THREE.Shape();
      shape.moveTo(0, 0);
      shape.lineTo(0.175 * sd, -0.015);
      shape.lineTo(0.062 * sd, -0.205);
      shape.closePath();
      var geo = new THREE.ExtrudeGeometry(shape, { depth: 0.024, bevelEnabled: false });
      var flap = new THREE.Mesh(geo, matTrim);
      flap.position.set(sd * 0.045, 4.505, surfZ(4.49, 0.04, 0.012));
      flap.rotation.y = -sd * 0.26;
      flap.rotation.x = -0.20;
      torso.add(flap);
    });

    // 橙色领带：结 + 剑形
    var knotY = 4.455;
    K.mesh(K.sphere(0.070, 1.15, 0.9, 0.72, 14), matTie, torso, [0, knotY, surfZ(knotY, 0, 0.022)]);
    var tiePts = [];
    for (var ty = 4.415; ty >= 3.905; ty -= 0.06) {
      tiePts.push([0, ty, surfZ(ty, 0, 0.026)]);
    }
    var tieW = [0.105, 0.100, 0.092, 0.082, 0.068, 0.050, 0.032, 0.018, 0.010];
    var tie = new THREE.Mesh(K.ribbon({ pts: tiePts, widths: tieW, thick: 0.022, ref: [1, 0, 0], seg: 14, radial: 6 }), matTie);
    torso.add(tie);
    K.outline(tie, OS);

    // 左胸金色小徽章 + 橙色饰绳（御姐更有军装感）
    if (P.id === "onee") {
      var emY = 4.10, emX = 0.195;
      var em = new THREE.Mesh(K.sphere(0.045, 1, 1.25, 0.5, 12), matGold);
      em.position.set(emX, emY, surfZ(emY, emX, 0.014));
      em.rotation.z = 0.4;
      torso.add(em);
      var cordPts = [];
      for (var ci = 0; ci <= 8; ci++) {
        var ca = ci / 8;
        var cy = 4.40 - ca * 0.30;
        var cx = 0.16 + sin(ca * PI) * 0.10;
        cordPts.push([cx, cy, surfZ(cy, cx, 0.028 + sin(ca * PI) * 0.04)]);
      }
      var cord = new THREE.Mesh(K.tube(cordPts, 0.016, 20, 6), matTie);
      torso.add(cord);
    }
    // 腰侧小口袋 / 装饰粒扣
    [-1, 1].forEach(function (sd) {
      K.mesh(K.sphere(0.024, 1, 1, 1, 8), matGold, torso, [sd * 0.30, 3.10, surfZ(3.10, sd * 0.30, 0.008)]);
    });

    // 脖子
    var neck = K.mesh(K.cylinder(0.148, 0.176, 0.34, 18), matSkin, torso, [0, 4.58, -0.01]);
    K.outline(neck, OS);

    // 肩头圆润过渡
    [-1, 1].forEach(function (sd) {
      var ball = K.mesh(K.sphere(0.163, 1, 0.95, 1, 18), matCoat, torso, [sd * 0.525, 4.335, 0]);
      K.outline(ball, OS);
    });

    /* ================================================================
     * 3. 手臂
     * ================================================================ */
    function buildArm(side) {
      var sh = K.group(torso, [side * L.shoulderX, L.shoulderY, 0]);
      var sleeveProf = [
        [0.118, 0.00], [0.124, 0.18], [0.131, 0.40], [0.140, 0.62], [0.152, 0.80], [0.162, 0.93],
      ];
      var upper = new THREE.Mesh(K.lathe(sleeveProf, 20), matCoat);
      upper.position.y = -L.armU;
      sh.add(upper);
      K.outline(upper, O);

      var elbow = K.group(sh, [0, -L.armU, 0]);
      var foreProf = [
        [0.108, 0.00], [0.112, 0.12], [0.120, 0.30], [0.128, 0.48], [0.134, 0.66], [0.140, 0.86],
      ];
      var fore = new THREE.Mesh(K.lathe(foreProf, 20), matCoat);
      fore.position.y = -L.armF;
      elbow.add(fore);
      K.outline(fore, O);
      // 深色袖口
      var cuff = new THREE.Mesh(K.lathe([
        [0.112, 0.00], [0.122, 0.02], [0.132, 0.10], [0.134, 0.185], [0.126, 0.19],
      ], 18), matDark);
      cuff.position.y = -0.19;
      elbow.add(cuff);
      K.outline(cuff, OS);
      var cuffLine = new THREE.Mesh(K.ring(0.128, 0.015, TAU, 8), matTrim);
      cuffLine.rotation.x = PI / 2;
      cuffLine.position.y = 0.012;
      elbow.add(cuffLine);

      var wrist = K.group(elbow, [0, -L.armF, 0]);
      var hand = K.mesh(K.sphere(0.132, 0.92, 1.06, 0.86, 18), matSkin, wrist, [0, -0.105, 0.012]);
      K.outline(hand, OS);
      var thumb = K.mesh(K.sphere(0.056, 1, 1.3, 0.85, 10), matSkin, wrist, [side * 0.085, -0.118, 0.052]);
      thumb.rotation.z = side * 0.5;
      return { shoulder: sh, elbow: elbow, wrist: wrist, hand: hand };
    }
    var armR = buildArm(-1);   // 屏幕左（角色右手）
    var armL = buildArm(1);    // 屏幕右（角色左手）

    /* ================================================================
     * 4. 头 + 脸
     * ================================================================ */
    var headGroup = K.group(torso, [0, L.headY, 0]);
    var head = FIG.head({
      R: HR,
      scale: FT.scale,
      skin: C.skin, skinShade: C.skinShade,
      eye: C.eye,
      eyeX: FT.eyeX, eyeY: FT.eyeY, eyeW: FT.eyeW, eyeH: FT.eyeH,
      mouth: FT.mouth,
      mouthY: FT.mouthY,
      faceY: FT.faceY,
      blush: FT.blush, blushColor: C.blushColor, blushOpacity: FT.blushOpacity,
      outline: C.outline,
      jaw: FT.jaw,
    });
    headGroup.add(head.group);
    var face = head.face;

    // 用缓存贴图接管眼睛（顺手修正 fig.head 左右 mirror 反了的问题 + 红眼线）
    (function () {
      try {
        if (face.eyeL.material.map) face.eyeL.material.map.dispose();
        if (face.eyeR.material.map) face.eyeR.material.map.dispose();
        if (face.mouth.material.map) face.mouth.material.map.dispose();
      } catch (e) {}
      applyEyes("open");
      applyMouth("smile");
      face.mouth.scale.set(1.18, 1.18, 1);
      face.nose.scale.set(1.25, 1.25, 1);
    })();
    // 注意：fig.patch 的 UV 方向导致「左眼用未镜像、右眼用镜像」才符合外眼角朝外
    function applyEyes(mood) {
      face.eyeL.material.map = eyeTex(1, mood);
      face.eyeR.material.map = eyeTex(-1, mood);
      face.eyeL.material.needsUpdate = true;
      face.eyeR.material.needsUpdate = true;
    }
    function applyEyesWink() {
      face.eyeL.material.map = eyeTex(1, "closed");
      face.eyeR.material.map = eyeTex(-1, "open");
      face.eyeL.material.needsUpdate = true;
      face.eyeR.material.needsUpdate = true;
    }
    function applyMouth(kind) {
      face.mouth.material.map = mouthTex(kind);
      face.mouth.material.needsUpdate = true;
    }

    // 头部高光（小面积、不过亮）
    // （fig.head 已带皮肤 rim；此处不再加）

    /* ================================================================
     * 5. 头发：发帽 + 刘海 + 后发壳 + 发束 + 侧发 + 飘带
     * ================================================================ */
    var hairRoot = K.group(headGroup);
    hairRoot.scale.set(1.0, FT.scale[1], FT.scale[2]);
    var hairGroup = K.group(hairRoot);   // 帽子/刘海/侧发
    var hairBack = K.group(hairRoot);    // 后发
    var hairFlow = K.group(hairRoot);    // 飘逸长发带

    var cap = new THREE.Mesh(FIG.hairCap(HR, { scale: HA.capScale, thetaFront: HA.capFront, thetaBack: HA.capBack }), matHair);
    K.outline(cap, { thickness: 0.0075, color: C.hairOutline });
    hairGroup.add(cap);

    // --- 后发内层：有体积的整片（填充缝隙，避免「几根面条」） ---
    (function () {
      var cur = HA.curtain, cols = 30, rows = 13;
      var phiA = 100 * D, phiB = 260 * D;
      var pos = [], idx = [];
      for (var i = 0; i <= cols; i++) {
        var s = i / cols;
        var phi = phiA + (phiB - phiA) * s;
        var mid = 1 - abs(s - 0.5) * 2;
        var yBot = -(cur.lenSide * 0.93 + (cur.lenMid * 0.925 - cur.lenSide * 0.93) * Math.pow(mid, 0.7));
        for (var j = 0; j <= rows; j++) {
          var t = j / rows;
          var y = 0.42 + (yBot - 0.42) * ease(t);
          var rx = cur.r0 - 0.030 + 0.085 * sin(PI * K.clamp(t * 1.02, 0, 1)) + 0.030 * t;
          var zc = cur.zc0 - 0.05 - 0.22 * t;
          var rz = cur.z0 - 0.10 + 0.10 * t;
          pos.push(rx * sin(phi), y, zc + rz * cos(phi));
        }
      }
      for (var a = 0; a < rows; a++) {
        for (var b = 0; b < cols; b++) {
          var i0 = a * (cols + 1) + b, i1 = i0 + 1, i2 = i0 + cols + 1, i3 = i2 + 1;
          idx.push(i0, i2, i1, i1, i2, i3);
        }
      }
      var geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      var shell = new THREE.Mesh(geo, matHairDeep);
      shell.userData.noOutline = true;
      hairBack.add(shell);
    })();

    // --- 后发外层：一束束宽发片（长度错落、发尾外翻） ---
    (function () {
      var phis = HA.backPhis, lens = HA.backLen, wid = HA.backWidth;
      var layerT = [0.060, 0.010, 0.080, 0.020, 0.095, 0.020, 0.080, 0.010, 0.060];
      var layerM = [0, 1, 0, 1, 0, 1, 0, 1, 0];
      for (var k = 0; k < phis.length; k++) {
        var ph = phis[k] * D;
        var sn = sin(ph), cn = cos(ph);
        var pts = [];
        var n = 10;
        var rOff = layerT[k];
        for (var q = 0; q < n; q++) {
          var t = q / (n - 1);
          if (q === 0) {
            var p0 = hp(13, phis[k] * 0.94, HR * 1.020);
            pts.push(p0);
            continue;
          }
          var tt = (t - 0.10) / 0.90;
          var y = 0.46 - lens[k] * Math.pow(tt, 1.04);
          // 贴头 → 肩部略宽 → 越往下越收，发尾再外翻
          var rad = 0.838 + rOff + 0.095 * sin(PI * K.clamp(tt * 0.92, 0, 1)) - 0.055 * tt * tt;
          var zc = -0.085 - 0.180 * tt;
          var rz = 0.470 + 0.075 * tt;
          var flare = Math.max(0, (tt - 0.72) / 0.28);
          var x = rad * sn + sn * 0.10 * flare * flare;
          var z = zc + rz * cn - 0.07 * flare;
          y += 0.025 * sin(tt * 3.6 + k * 0.9);
          pts.push([x, y, z]);
        }
        var w = wid * (0.96 + 0.10 * cos(ph));
        var widths = [w * 0.40, w * 0.78, w, w, w * 1.0, w * 0.99, w * 0.94, w * 0.82, w * 0.60, 0.06];
        var geo = K.ribbon({ pts: pts, widths: widths, thick: 0.052, ref: [1, 0, 0], seg: 24, radial: 8, tension: 0.26 });
        var m = new THREE.Mesh(geo, layerM[k] ? matHairBack : matHair);
        m.userData.noOutline = true;
        hairBack.add(m);
      }
      // 中间补几束深色细发，增加层次
      [-152, -124, -96, -68, -40].forEach(function (phd, ii) {
        var ph2 = phd * D, sn2 = sin(ph2), cn2 = cos(ph2);
        var len = HA.curtain.lenMid * (0.78 + 0.05 * (ii % 3));
        var pts2 = [];
        for (var q2 = 0; q2 < 8; q2++) {
          var t2 = q2 / 7;
          var y2 = 0.42 - len * Math.pow(t2, 1.05);
          var rad2 = 0.815 + 0.07 * sin(PI * t2 * 0.9) - 0.04 * t2;
          var zc2 = -0.075 - 0.16 * t2;
          pts2.push([rad2 * sn2, y2, zc2 + (0.445 + 0.06 * t2) * cn2]);
        }
        var geo2 = K.ribbon({
          pts: pts2, widths: [0.050, 0.10, 0.135, 0.14, 0.115, 0.07, 0.03, 0.012],
          thick: 0.028, ref: [1, 0, 0], seg: 18, radial: 6, tension: 0.3,
        });
        var m2 = new THREE.Mesh(geo2, matHairDeep);
        m2.userData.noOutline = true;
        hairBack.add(m2);
      });
    })();

    // --- 刘海：整片覆盖 + 细碎发尾 ---
    (function () {
      var N = HA.bangs, spread = HA.bangSpread, tipTh = HA.bangTip;
      for (var i = 0; i < N; i++) {
        var t = (i / (N - 1)) * 2 - 1;                 // -1..1
        var ph = t * spread;
        var lenK = 1 - abs(t) * 0.06;
        var tip = tipTh + (i % 2 === 0 ? 0 : 2.0) + (abs(t) > 0.72 ? 6 : 0);
        var pts = [
          hp(4, ph * 0.16, HR * 1.058),
          hp(18, ph * 0.50, HR * 1.070),
          hp(38, ph * 0.82, HR * 1.078),
          hp(58, ph * 0.96, HR * 1.082),
          hp(tip * 0.93 * lenK, ph * 1.00, HR * 1.074),
          hp(tip * lenK, ph * 1.01, HR * 1.048),
        ];
        var w = 0.265 - abs(t) * 0.035;
        var geo = K.ribbon({
          pts: pts,
          widths: [w * 0.62, w * 0.92, w, w * 0.96, w * 0.66, 0.014],
          thick: 0.048, ref: [cos(ph * D), 0, -sin(ph * D)], seg: 18, radial: 8, tension: 0.24,
        });
        var m = new THREE.Mesh(geo, i % 3 === 1 ? matHairDeep : matHair);
        m.userData.noOutline = true;
        hairGroup.add(m);
      }
      // 细碎短刘海（让发尾不齐整，更自然）
      for (var s2 = 0; s2 < 5; s2++) {
        var tt = (s2 / 4) * 2 - 1;
        var ph3 = tt * spread * 0.82 + 7;
        var btip = tipTh - 10 + (s2 % 2) * 5;
        var pts3 = [
          hp(12, ph3 * 0.5, HR * 1.064),
          hp(36, ph3 * 0.9, HR * 1.080),
          hp(btip * 0.9, ph3, HR * 1.084),
          hp(btip, ph3 * 1.01, HR * 1.058),
        ];
        var geo3 = K.ribbon({
          pts: pts3, widths: [0.060, 0.092, 0.075, 0.012],
          thick: 0.030, ref: [cos(ph3 * D), 0, -sin(ph3 * D)], seg: 12, radial: 6, tension: 0.3,
        });
        var m3 = new THREE.Mesh(geo3, matHairDeep);
        m3.userData.noOutline = true;
        hairGroup.add(m3);
      }
      // 侧刘海（太阳穴垂下的长片，框脸）
      [1, -1].forEach(function (sd) {
        var pts = [
          hp(34, sd * 72, HR * 1.060),
          hp(56, sd * 76, HR * 1.070),
          [sd * 0.790, -0.18, 0.350],
          [sd * 0.808, -0.68, 0.330],
          [sd * 0.798, -1.18, 0.280],
          [sd * 0.748, -1.60, 0.212],
          [sd * 0.680, -1.88, 0.152],
        ];
        var geo = K.ribbon({
          pts: pts,
          widths: [0.100, 0.150, 0.185, 0.195, 0.165, 0.100, 0.012],
          thick: 0.052, ref: [1, 0, 0], seg: 20, radial: 8, tension: 0.30,
        });
        var m = new THREE.Mesh(geo, matHair);
        m.userData.noOutline = true;
        hairGroup.add(m);
      });
      // 脸侧内层碎发（贴脸颊的小束）
      [1, -1].forEach(function (sd) {
        var pts = [
          hp(36, sd * 60, HR * 1.056),
          hp(58, sd * 64, HR * 1.066),
          [sd * 0.610, -0.30, 0.450],
          [sd * 0.640, -0.70, 0.410],
          [sd * 0.575, -1.00, 0.330],
        ];
        var geo = K.ribbon({
          pts: pts,
          widths: [0.055, 0.085, 0.090, 0.060, 0.010],
          thick: 0.034, ref: [1, 0, 0], seg: 14, radial: 7, tension: 0.3,
        });
        var m = new THREE.Mesh(geo, matHairDeep);
        m.userData.noOutline = true;
        hairGroup.add(m);
      });
      // 头顶发束：从发旋往后走的浅浮雕发片，制造体积和条纹
      for (var c2 = 0; c2 < 5; c2++) {
        var ct = (c2 / 4) * 2 - 1;
        var cph = ct * 52;
        var cpts = [];
        for (var a2 = 0; a2 <= 6; a2++) {
          var at = a2 / 6;
          var th2 = 6 + at * 52;
          cpts.push(hp(th2, cph * (1 - at * 0.15), HR * (1.066 + 0.012 * sin(at * PI))));
        }
        var cgeo = K.ribbon({
          pts: cpts, widths: [0.10, 0.20, 0.22, 0.21, 0.17, 0.12, 0.06],
          thick: 0.030, ref: [1, 0, 0], seg: 14, radial: 6, tension: 0.2,
        });
        var cm = new THREE.Mesh(cgeo, c2 % 2 ? matHair : matHairDeep);
        cm.userData.noOutline = true;
        hairGroup.add(cm);
      }
    })();

    // --- 侧发：垂在肩前的两束长发（更宽、更有厚度） ---
    (function () {
      [1, -1].forEach(function (sd) {
        [0, 1].forEach(function (kk) {
          var o = kk === 0 ? 0.0 : 0.085;
          var pts = [
            hp(24 + kk * 9, sd * (60 + kk * 10), HR * 1.052),
            hp(50 + kk * 5, sd * (68 + kk * 8), HR * 1.068),
            [sd * (0.815 + o), -0.10 - o, 0.375 - o * 0.3],
            [sd * (0.855 + o), -0.62 - o, 0.355 - o * 0.3],
            [sd * (0.870 + o), -1.22 - o * 1.1, 0.300 - o * 0.4],
            [sd * (0.830 + o), -1.78 - o * 1.3, 0.230 - o * 0.3],
            [sd * (0.740 + o), -2.14 - o * 1.1, 0.165 - o * 0.2],
          ];
          var geo = K.ribbon({
            pts: pts,
            widths: [0.120, 0.175, 0.215, 0.222, 0.195, 0.130, 0.012],
            thick: 0.064, ref: [1, 0, 0], seg: 20, radial: 8, tension: 0.30,
          });
          var m = new THREE.Mesh(geo, kk === 0 ? matHair : matHairDeep);
          m.userData.noOutline = true;
          hairGroup.add(m);
        });
      });
    })();

    // --- 天使环高光 ---
    (function () {
      var arcs = [[-52, 42, 13], [-16, 40, 15], [20, 40, 15], [56, 42, 13]];
      for (var i = 0; i < arcs.length; i++) {
        var phA = arcs[i][0], th = arcs[i][1], span = arcs[i][2];
        var pts = [];
        for (var a = -span; a <= span; a += 3) pts.push(hp(th + a * 0.55, phA + a * 0.95, HR * 1.098));
        var geo = K.ribbon({ pts: pts, widths: [0.040, 0.062, 0.038], thick: 0.008, ref: [0, 1, 0], seg: 16, radial: 4 });
        var m = new THREE.Mesh(geo, matHairShine);
        m.userData.noOutline = true;
        hairGroup.add(m);
      }
    })();

    // --- 飘逸长发带（参考图里飞出去的发丝） ---
    (function () {
      var heroes = HA.heroes;
      for (var i = 0; i < heroes.length; i++) {
        var h = heroes[i];
        var m = new THREE.Mesh(K.strand({
          pts: h.pts, radii: h.radii, flat: h.flat == null ? 0.72 : h.flat,
          seg: 30, radial: 8, tension: 0.4,
        }), matHair);
        m.userData.noOutline = true;
        hairFlow.add(m);
      }
      // 呆毛（元气专属：从帽子后面翘出来的一撮）
      if (HA.ahoge) {
        var ah = new THREE.Mesh(K.strand({
          pts: [[0.16, HR * 0.86, -0.34], [0.26, HR * 1.03, -0.44], [0.40, HR * 1.13, -0.50], [0.56, HR * 1.08, -0.50], [0.66, HR * 0.94, -0.44]],
          radii: [0.052, 0.040, 0.028, 0.015, 0.002], flat: 0.62, seg: 14, radial: 7,
        }), matHair);
        ah.userData.noOutline = true;
        hairGroup.add(ah);
      }
    })();

    /* ================================================================
     * 6. 配件：发带 + 红角 / 贝雷帽 / 棒棒糖 / 小星星 / 爱心
     * ================================================================ */
    var accessories = {};
    if (P.hat === "band") {
      // 白色发带（横过发顶，两端收在太阳穴）
      var bandPts = [];
      for (var bd = -82; bd <= 82; bd += 5) {
        var rr = HR * 1.100;
        bandPts.push(hp(56 + Math.pow(abs(bd) / 82, 2) * 13, bd, rr));
      }
      var band = new THREE.Mesh(K.ribbon({
        pts: bandPts, widths: [0.140], thick: 0.036, ref: [0, 0, 1], seg: 36, radial: 6,
      }), matTrim);
      hairGroup.add(band);
      // 发带下沿一道金边
      var bandGoldPts = bandPts.map(function (p2) {
        return [p2[0] * 1.004, p2[1] - 0.070, p2[2] * 1.004];
      });
      var bandGold = new THREE.Mesh(K.ribbon({
        pts: bandGoldPts, widths: [0.018], thick: 0.010, ref: [0, 0, 1], seg: 28, radial: 4,
      }), matGold);
      bandGold.userData.noOutline = true;
      hairGroup.add(bandGold);
      // 发带两端白色小护片（红角从这里长出来）
      [1, -1].forEach(function (sd) {
        var p0 = hp(56, sd * 80, HR * 1.052);
        var wing = new THREE.Mesh(K.lathe([
          [0.001, 0.000], [0.048, 0.008], [0.062, 0.036], [0.048, 0.070], [0.001, 0.082],
        ], 12), matTrim);
        wing.position.set(p0[0], p0[1], p0[2]);
        wing.rotation.z = sd * 0.85;
        wing.rotation.x = -0.15;
        wing.scale.set(1, 1, 0.55);
        hairGroup.add(wing);
        K.outline(wing, OS);
      });
      // 红角：从发带两端向上、向外、再微微向后弯
      [1, -1].forEach(function (sd) {
        var b = hp(66, sd * 78, HR * 1.060);
        var pts = [
          [b[0] * 0.94, b[1] - 0.02, b[2] * 1.01],
          [b[0] * 1.02, b[1] + 0.10, b[2] * 0.99],
          [b[0] * 1.10, b[1] + 0.235, b[2] * 0.88],
          [b[0] * 1.14, b[1] + 0.355, b[2] * 0.70],
          [b[0] * 1.15, b[1] + 0.45, b[2] * 0.50],
        ];
        var horn = new THREE.Mesh(K.strand({
          pts: pts, radii: [0.140, 0.120, 0.088, 0.050, 0.004], flat: 0.88, seg: 18, radial: 9,
        }), matHorn);
        K.outline(horn, { thickness: 0.0038, color: 0x7a1a2c });
        hairGroup.add(horn);
      });
    } else if (P.hat === "beret") {
      var beretGroup = K.group(hairGroup, [0.02, 0.560, -0.030]);
      beretGroup.rotation.z = 0.20;
      beretGroup.rotation.x = -0.13;
      beretGroup.rotation.y = -0.10;
      // 帽身：一整个车削，从中心顶→边缘→内卷的帽檐
      var beret = new THREE.Mesh(K.lathe([
        [0.001, 0.300], [0.130, 0.298], [0.270, 0.288], [0.400, 0.268],
        [0.510, 0.235], [0.600, 0.190], [0.670, 0.135], [0.718, 0.078],
        [0.738, 0.028], [0.735, -0.012], [0.712, -0.046], [0.668, -0.070],
        [0.610, -0.082], [0.560, -0.080],
      ], 40), matBeret);
      beretGroup.add(beret);
      K.outline(beret, { thickness: 0.0085, color: 0x8a7268 });
      // 帽边一圈略深的滚边
      var beretRim = new THREE.Mesh(K.ring(0.709, 0.026, TAU, 10), matBeretBand);
      beretRim.rotation.x = PI / 2;
      beretRim.position.y = -0.028;
      beretGroup.add(beretRim);
      // 帽顶小揪
      var knob = K.mesh(K.sphere(0.050, 1, 1.15, 1, 12), matBeretBand, beretGroup, [-0.03, 0.315, 0.0]);
      K.outline(knob, OS);
      // 贝雷帽侧后方的一小撮头发（从帽下钻出来的呆毛感）
      var tuft = new THREE.Mesh(K.strand({
        pts: [[0.10, 0.28, -0.58], [0.18, 0.42, -0.66], [0.30, 0.48, -0.72], [0.42, 0.40, -0.74], [0.48, 0.26, -0.70]],
        radii: [0.07, 0.055, 0.040, 0.022, 0.003], flat: 0.7, seg: 12, radial: 7,
      }), matHair);
      tuft.userData.noOutline = true;
      hairGroup.add(tuft);
      // 贝雷帽前缘下方：两只小红角尖（02 的角从帽檐下顶出来）
      [1, -1].forEach(function (sd) {
        var p0 = hp(74, sd * 64, HR * 1.075);
        var pts = [
          [p0[0] * 0.94, p0[1] - 0.03, p0[2] * 1.00],
          [p0[0] * 1.06, p0[1] + 0.05, p0[2] * 0.95],
          [p0[0] * 1.17, p0[1] + 0.135, p0[2] * 0.87],
        ];
        var horn = new THREE.Mesh(K.strand({
          pts: pts, radii: [0.062, 0.046, 0.003], flat: 0.9, seg: 8, radial: 7,
        }), matHorn);
        K.outline(horn, { thickness: 0.0028, color: 0x7a1a2c });
        hairGroup.add(horn);
      });
    }

    // 棒棒糖（挂在右手腕上，随手臂动）
    var lolli = null;
    if (P.stick) {
      lolli = K.group(armR.wrist, [0, -0.135, 0.035]);
      K.mesh(K.cylinder(0.015, 0.013, 0.40, 10), matStickWhite, lolli, [0, 0.17, 0]);
      var candy = K.mesh(K.sphere(0.145, 1, 1, 1, 20), matCandy, lolli, [0, 0.44, 0]);
      var swirlPts = [];
      for (var si = 0; si <= 30; si++) {
        var sa = si / 30;
        var sth = sa * PI * 1.25 + 0.3;
        var sph = sa * TAU * 1.7;
        swirlPts.push([0.147 * sin(sth) * cos(sph), 0.44 + 0.147 * cos(sth), 0.147 * sin(sth) * sin(sph)]);
      }
      var swirl = new THREE.Mesh(K.tube(swirlPts, 0.021, 36, 6), matTrim);
      swirl.userData.noOutline = true;
      lolli.add(swirl);
      var glint = new THREE.Mesh(K.sphere(0.036, 1, 1, 0.6, 8), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8 }));
      glint.position.set(-0.072, 0.498, 0.098);
      lolli.add(glint);
      K.outline(candy, OS);
    }

    // 元气小星星（举着的手旁边）
    var sparkles = null;
    if (P.sparkle) {
      sparkles = K.group(armR.wrist);
      var spots = [[-0.20, 0.06, 0.16, 1.0], [-0.08, 0.22, 0.06, 0.66], [-0.29, -0.10, 0.10, 0.5]];
      for (var spi = 0; spi < spots.length; spi++) {
        var sp = spots[spi];
        var star = new THREE.Mesh(K.star(0.055, 0.012), matSpark);
        star.position.set(sp[0], sp[1], sp[2]);
        star.userData.noOutline = true;
        star.userData.base = sp[3];
        star.scale.setScalar(sp[3]);
        sparkles.add(star);
      }
    }

    // 爱心（pat / happy 时弹出来）
    var hearts = K.group(headGroup, [0.55, 1.05, 0.30]);
    var heart1 = new THREE.Mesh(K.heart(0.10, 0.10), matHeart);
    heart1.position.set(0, 0, 0);
    var heart2 = new THREE.Mesh(K.heart(0.065, 0.07), matHeart);
    heart2.position.set(0.17, 0.14, -0.04);
    heart1.userData.noOutline = heart2.userData.noOutline = true;
    hearts.add(heart1, heart2);
    hearts.scale.setScalar(0.001);

    /* ================================================================
     * 7. 骨架 & 姿势
     * ================================================================ */
    var rig = FIG.rig();
    rig.add("body", body, { k: 150, d: 18 });
    rig.add("torso", torso, { k: 150, d: 18 });
    rig.add("head", headGroup, { k: 150, d: 16 });
    rig.add("hairGroup", hairGroup, { k: 90, d: 14 });
    rig.add("hairBack", hairBack, { k: 80, d: 13 });
    rig.add("hairFlow", hairFlow, { k: 70, d: 12 });
    rig.add("armR", armR.shoulder, { k: 110, d: 14 });
    rig.add("armRElbow", armR.elbow, { k: 110, d: 13 });
    rig.add("armL", armL.shoulder, { k: 110, d: 14 });
    rig.add("armLElbow", armL.elbow, { k: 110, d: 13 });
    rig.add("legR", legs[-1].hip, { k: 120, d: 15 });
    rig.add("legRElbow", legs[-1].knee, { k: 120, d: 14 });
    rig.add("legL", legs[1].hip, { k: 120, d: 15 });
    rig.add("legLElbow", legs[1].knee, { k: 120, d: 14 });

    function makePose(o) {
      var r = limbAngles(o.armR[0], o.armR[1]);
      var l = limbAngles(o.armL[0], o.armL[1]);
      var lr = limbAngles(o.legR ? o.legR[0] : [0.03, -1, 0.02], o.legR ? o.legR[1] : [0.03, -1, 0.04]);
      var ll = limbAngles(o.legL ? o.legL[0] : [-0.03, -1, 0.02], o.legL ? o.legL[1] : [-0.03, -1, 0.04]);
      return {
        armR: r.a, armRElbow: r.b,
        armL: l.a, armLElbow: l.b,
        legR: lr.a, legRElbow: lr.b,
        legL: ll.a, legLElbow: ll.b,
        head: o.head || [0, 0, 0],
        torso: o.torso || [0, 0, 0],
        body: o.body || [0, 0, 0],
        stick: o.stick || null,
        mouth: o.mouth || null,
        eyes: o.eyes || null,
        blush: o.blush == null ? 0.8 : o.blush,
      };
    }

    var IH = {  // 常用方向 shorthand：hip hand / raised candy / relaxed
      hipL: [[0.62, -0.78, -0.02], [-0.90, -0.10, 0.42]],
      hipHighL: [[0.72, -0.62, 0.08], [-0.88, -0.20, 0.43]],
      relaxedL: [[0.42, -0.90, 0.10], [0.04, -0.96, 0.26]],
      candyUp: [[-0.62, 0.72, 0.12], [0.42, -0.30, 0.86]],
      candyHigh: [[-0.55, 0.80, 0.10], [0.38, -0.22, 0.90]],
      candyTalk: [[-0.66, 0.68, 0.20], [0.60, -0.46, 0.66]],
      eatR: [[-0.64, 0.74, 0.12], [0.78, -0.28, 0.56]],
      sleepR: [[-0.35, -0.90, 0.20], [0.10, -0.80, 0.59]],
      sleepL: [[0.35, -0.90, 0.20], [-0.10, -0.80, 0.59]],
      wave: [[-0.72, 0.62, 0.14], [0.62, 0.55, 0.56]],
      waveHi: [[-0.68, 0.70, 0.12], [0.60, 0.60, 0.52]],
      cheerL: [[0.52, 0.85, 0.06], [0.30, 0.93, 0.16]],
      stretchR: [[-0.44, 0.89, 0.05], [-0.34, 0.93, 0.12]],
      stretchL: [[0.44, 0.89, 0.05], [0.34, 0.93, 0.12]],
      shyR: [[-0.68, 0.50, 0.55], [0.80, 0.34, 0.15]],
      shyL: [[0.68, 0.50, 0.55], [-0.80, 0.34, 0.15]],
    };

    var POSES;
    if (P.stick) {
      /* ---------------- 御姐 ---------------- */
      POSES = {
        idle: makePose({
          armR: IH.candyUp, armL: IH.hipL,
          head: [0.01, 0.03, 0.02], stick: [0.02, 1, 0.12],
          eyes: "open", mouth: "smile", blush: 0.78,
        }),
        happy: makePose({
          armR: IH.candyHigh, armL: IH.hipHighL,
          head: [-0.05, 0.05, 0.04], torso: [0, 0, -0.02], stick: [-0.10, 1, 0.16],
          eyes: "happy", mouth: "open", blush: 1,
        }),
        talk: makePose({
          armR: IH.candyTalk, armL: IH.hipL,
          head: [0.02, 0.04, 0.0], stick: [0.18, 0.95, 0.24],
          eyes: "open", mouth: "smile", blush: 0.8,
        }),
        sleep: makePose({
          armR: IH.sleepR, armL: IH.sleepL,
          head: [0.24, 0.16, 0.12], torso: [0.03, 0.03, 0.0],
          stick: [0.30, 0.60, 0.30], eyes: "closed", mouth: "smile", blush: 0.5,
        }),
        shy: makePose({
          armR: IH.shyR, armL: IH.hipL,
          head: [0.16, 0.12, 0.14], torso: [0.02, 0.02, 0.03], stick: [0.30, 0.90, 0.35],
          eyes: "half", mouth: "shy", blush: 1,
        }),
        stretch: makePose({
          armR: IH.stretchR, armL: IH.stretchL,
          head: [-0.18, 0, 0], torso: [-0.07, 0, 0], stick: [0.10, 0.95, 0.30],
          eyes: "happy", mouth: "open", blush: 0.85,
        }),
        wink: makePose({
          armR: IH.candyUp, armL: IH.hipL,
          head: [0.01, 0.02, 0.11], stick: [0.02, 1, 0.12],
          eyes: "wink", mouth: "cat", blush: 1,
        }),
        eat: makePose({
          armR: IH.eatR, armL: IH.hipL,
          head: [0.06, 0.06, 0.02], stick: [0.76, 0.65, 0.08],
          eyes: "happy", mouth: "open", blush: 0.9,
        }),
      };
    } else {
      /* ---------------- 元气 ---------------- */
      POSES = {
        idle: makePose({
          armR: IH.wave, armL: IH.relaxedL,
          head: [0.01, 0.02, 0.03],
          eyes: "open", mouth: "smile", blush: 0.9,
        }),
        happy: makePose({
          armR: IH.waveHi, armL: IH.cheerL,
          head: [-0.07, 0.05, 0.02], torso: [0, 0, -0.02],
          eyes: "happy", mouth: "grin", blush: 1,
        }),
        talk: makePose({
          armR: IH.wave, armL: IH.hipL,
          head: [0.02, 0.03, 0.0],
          eyes: "open", mouth: "smile", blush: 0.9,
        }),
        sleep: makePose({
          armR: IH.sleepR, armL: IH.sleepL,
          head: [0.22, 0.16, 0.10], torso: [0.03, 0.03, 0.0],
          eyes: "closed", mouth: "smile", blush: 0.55,
        }),
        shy: makePose({
          armR: IH.shyR, armL: IH.hipL,
          head: [0.16, 0.10, 0.12], torso: [0.02, 0.02, 0.02],
          eyes: "half", mouth: "shy", blush: 1,
        }),
        stretch: makePose({
          armR: IH.stretchR, armL: IH.stretchL,
          head: [-0.18, 0, 0], torso: [-0.07, 0, 0],
          eyes: "happy", mouth: "open", blush: 0.95,
        }),
        wink: makePose({
          armR: IH.wave, armL: IH.relaxedL,
          head: [0.01, 0.02, 0.12],
          eyes: "wink", mouth: "cat", blush: 1,
        }),
        eat: makePose({
          armR: IH.eatR, armL: IH.relaxedL,
          head: [0.05, 0.05, 0.02],
          eyes: "happy", mouth: "open", blush: 0.95,
        }),
      };
    }

    function applyPose(name) {
      var p = POSES[name] || POSES.idle;
      rig.pose({
        armR: p.armR, armRElbow: p.armRElbow,
        armL: p.armL, armLElbow: p.armLElbow,
        legR: p.legR, legRElbow: p.legRElbow,
        legL: p.legL, legLElbow: p.legLElbow,
        head: p.head, torso: p.torso, body: p.body,
      });
      return p;
    }

    /* ================================================================
     * 8. 状态 / 动画
     * ================================================================ */
    var state = "idle", stateT = 0, pose = POSES.idle;
    var look = { x: 0, y: 0, tx: 0, ty: 0 };
    var blinkAt = 2 + Math.random() * 2.5, blinkT = -1;
    var mouthT = 0, patT = 0, patSet = false;
    var stickDir = new V3(P.idleStick[0], P.idleStick[1], P.idleStick[2]).normalize();
    var stickTarget = stickDir.clone();
    var stickQ = new THREE.Quaternion();
    var tmpQ = new THREE.Quaternion();
    var lastLookX = 9, lastLookY = 9;
    var patHearts = 0;

    function setState(name) {
      if (!POSES[name]) name = "idle";
      state = name;
      stateT = 0;
      pose = applyPose(name);
      face.setBlush(pose.blush);
      if (pose.eyes === "wink") applyEyesWink();
      else applyEyes(pose.eyes || "open");
      applyMouth(pose.mouth || "smile");
      if (pose.stick) stickTarget.set(pose.stick[0], pose.stick[1], pose.stick[2]).normalize();
      else if (P.id === "onee") stickTarget.set(0.05, 1, 0.16).normalize();
      if (name === "happy") patHearts = 0.8;
    }
    setState("idle");

    var char = {
      root: root,
      height: P.height,
      camera: P.camera,
      stateName: function () { return state; },
      setState: function (name) {
        setState(name);
        if (name !== "happy") patSet = false;
      },
      setLook: function (x, y) {
        look.tx = K.clamp(x, -1, 1);
        look.ty = K.clamp(y, -1, 1);
      },
      pat: function () {
        patT = 1.7;
        patHearts = 1.6;
        if (state !== "happy") { patSet = true; setState("happy"); }
        face.setBlush(1);
      },
      update: function (dt, t) {
        stateT += dt;
        look.x += (look.tx - look.x) * Math.min(1, dt * 8);
        look.y += (look.ty - look.y) * Math.min(1, dt * 8);
        if (abs(look.x - lastLookX) > 0.012 || abs(look.y - lastLookY) > 0.012) {
          lastLookX = look.x; lastLookY = look.y;
          face.look(look.x, look.y);
        }

        // 眨眼
        blinkAt -= dt;
        var canBlink = state !== "sleep" && state !== "happy" && state !== "wink" && state !== "stretch";
        if (blinkAt <= 0 && canBlink) {
          blinkAt = 2.0 + Math.random() * 3.2;
          blinkT = 0.12;
          applyEyes("closed");
        }
        if (blinkT > 0) {
          blinkT -= dt;
          if (blinkT <= 0) {
            applyEyes(state === "shy" ? "half" : "open");
          }
        }

        // 呼吸 / 重心
        var breathe = sin(t * 2.0);
        body.position.y = breathe * 0.013 + (state === "sleep" ? -0.06 : 0);
        body.scale.set(1, 1, 1);
        coat.scale.set(1 + breathe * 0.0035, 1, 1 + breathe * 0.0035);

        rig.resetMotion();
        var sway = sin(t * 1.05) * 0.5 + sin(t * 0.63) * 0.5;
        rig.motion("body", 0, sin(t * 0.4) * 0.02, sway * 0.010);
        rig.motion("torso", sin(t * 0.75) * 0.006, sin(t * 0.37) * 0.02, sway * 0.008);
        var headMx = sin(t * 1.6) * 0.012 + look.y * 0.05;
        var headMy = sin(t * 0.52) * 0.045 + look.x * 0.30;
        var headMz = sin(t * 0.9) * 0.015 + look.x * 0.04;
        rig.motion("head", headMx, headMy, headMz);
        rig.motion("hairGroup", sin(t * 1.4) * 0.010, sin(t * 0.6) * 0.012, sin(t * 1.1) * 0.008);
        rig.motion("hairBack", sin(t * 1.15 + 0.5) * 0.018, sin(t * 0.82) * 0.030, sin(t * 0.95) * 0.016);
        rig.motion("hairFlow", sin(t * 1.35 + 1.2) * 0.030, sin(t * 0.9 + 0.4) * 0.045, sin(t * 1.2) * 0.026);
        rig.motion("armR", sin(t * 1.5) * 0.012, 0, sin(t * 1.35) * 0.022);
        rig.motion("armL", sin(t * 1.3 + 1) * 0.012, 0, sin(t * 1.15 + 0.5) * 0.018);
        rig.motion("legR", 0, 0, 0);
        rig.motion("legL", 0, 0, 0);

        // 状态特有动作
        if (state === "talk" || state === "eat") {
          mouthT += dt;
          applyMouth(sin(mouthT * 11) > 0.1 ? "open" : "smile");
          rig.motion("head", sin(t * 5.1) * 0.026, sin(t * 2.3) * 0.04, sin(t * 3.0) * 0.016);
        }
        if (P.stick) {
          // 棒棒糖随呼吸轻轻上下晃
          var bobbing = sin(t * 1.9) * 0.02;
          rig.motion("armRElbow", bobbing, 0, sin(t * 1.6) * 0.02);
          if (state === "happy") rig.motion("armRElbow", bobbing * 1.6, 0, sin(t * 3.4) * 0.10);
        } else {
          // 招手
          var waveAmp = state === "happy" ? 0.26 : state === "talk" ? 0.10 : 0.055;
          var waveSpeed = state === "happy" ? 6.4 : 3.0;
          rig.motion("armRElbow", 0, 0, sin(t * waveSpeed) * waveAmp);
          rig.motion("armR", 0, sin(t * waveSpeed * 0.5) * 0.03, sin(t * waveSpeed) * waveAmp * 0.25);
        }
        if (state === "sleep") {
          rig.motion("head", 0.10, 0.12, 0.10);
          rig.motion("torso", 0.02, 0, 0.02);
        }
        if (state === "stretch") rig.motion("torso", -0.02 + sin(t * 1.2) * 0.01, 0, 0);
        if (state === "happy") {
          body.position.y += sin(t * 6.2) * 0.012;
          rig.motion("torso", 0, 0, sin(t * 6.2) * 0.012);
        }
        if (state === "shy") {
          rig.motion("head", 0.05, 0.06, 0.04);
        }

        // 拍一拍：Q 弹挤压
        if (patT > 0) {
          patT = Math.max(0, patT - dt);
          var k = patT / 1.7;
          var sq = sin(k * PI * 2.2) * 0.055 * k;
          body.scale.set(1 + sq * 0.8, 1 - sq, 1 + sq * 0.8);
          if (patT <= 0 && patSet && state === "happy") { patSet = false; setState("idle"); }
        }
        // 爱心
        if (patHearts > 0) {
          patHearts = Math.max(0, patHearts - dt);
          var hk = 1 - patHearts / 1.6;
          var hs = Math.sin(Math.min(1, hk * 1.5) * PI) * 1.1 + 0.001;
          hearts.scale.setScalar(Math.max(0.001, hs));
          hearts.position.y = 1.05 + hk * 0.28;
          hearts.rotation.z = sin(t * 3) * 0.1;
          matHeart.opacity = Math.max(0, 1 - hk * 0.9) * 0.92;
        } else {
          hearts.scale.setScalar(0.001);
        }
        // 小星星
        if (sparkles) {
          var on = state === "happy" || state === "wink" || state === "stretch";
          sparkles.visible = true;
          for (var i = 0; i < sparkles.children.length; i++) {
            var st = sparkles.children[i];
            var bs = st.userData.base || 1;
            var s2 = on ? bs * (0.85 + 0.25 * sin(t * 5 + i * 2)) : 0.001;
            st.scale.setScalar(s2);
            st.rotation.z = t * (1.2 + i * 0.3);
          }
        }

        rig.update(dt);

        // 棒棒糖：让糖尽量朝上（世界方向），不被手腕拧成奇怪角度
        if (lolli) {
          stickDir.lerp(stickTarget, Math.min(1, dt * 6)).normalize();
          stickQ.setFromUnitVectors(UP, stickDir);
          tmpQ.setFromEuler(torso.rotation)
            .multiply(new THREE.Quaternion().setFromEuler(armR.shoulder.rotation))
            .multiply(new THREE.Quaternion().setFromEuler(armR.elbow.rotation));
          lolli.quaternion.copy(tmpQ.invert()).multiply(stickQ);
        }
      },
      dispose: function () {
        try {
          for (var k in eyeCache) if (eyeCache[k]) eyeCache[k].dispose();
          for (var m in mouthCache) if (mouthCache[m]) mouthCache[m].dispose();
          hornTex.dispose();
          K.dispose(root);
        } catch (e) {}
      },
    };

    // 调试钩子：实验室里用 __LAB.char._dbg.rig 直接掰关节
    char._dbg = {
      rig: rig, head: head, face: face, armR: armR, armL: armL,
      lolli: lolli, heads: headGroup, pose: POSES,
      eyeTex: eyeTex, mouthTex: mouthTex, applyEyes: applyEyes, applyMouth: applyMouth,
      root: root, torso: torso, bodies: body,
    };
    return char;
  }

  /* ============================== 变体表 ============================== */
  return {
    variants: {
      onee: {
        meta: { id: "onee", label: "02 · 御姐", height: ONEE.height, camera: ONEE.camera },
        build: function () { return buildTall(ONEE); },
      },
      genki: {
        meta: { id: "genki", label: "02 · 元气", height: GENKI.height, camera: GENKI.camera },
        build: function () { return buildTall(GENKI); },
      },
    },
  };
};
