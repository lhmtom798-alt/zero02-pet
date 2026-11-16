/**
 * fig —— 动漫小人"手办"装配层
 * 脸（曲面贴片五官）/ 头发 / 四肢 / 衣服 / 关节骨架。
 * 设计取向：Nendoroid 手办质感——大眼、干净曲面、厚描边、卡通两段光影。
 */
module.exports.create = function (K, THREE) {
  var PI = Math.PI, TAU = PI * 2;
  var FIG = {};
  var V3 = THREE.Vector3;

  /* ============================ 贴片几何 ============================ */
  /**
   * 把平面贴片"贴"到球面上：中心方向 dir，宽高 w/h（弧长），返回几何。
   * UV 与平面一致（左下 0,0）。
   */
  FIG.patch = function (R, dir, w, h, out) {
    var n0 = new V3(dir[0], dir[1], dir[2]).normalize();
    var upHint = new V3(0, 1, 0);
    var right = new V3().crossVectors(upHint, n0).normalize();
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
    var up = new V3().crossVectors(n0, right).normalize();
    var g = new THREE.PlaneGeometry(1, 1, 6, 6);
    var p = g.attributes.position;
    var aw = w / (2 * R), ah = h / (2 * R);
    for (var i = 0; i < p.count; i++) {
      var u = p.getX(i), v = p.getY(i);
      var dirv = new V3(n0.x + right.x * u * aw * 2, n0.y + right.y * u * aw * 2, n0.z + right.z * u * aw * 2)
        .addScaledVector(up, v * ah * 2)
        .normalize()
        .multiplyScalar(R + (out == null ? 0.002 : out));
      p.setXYZ(i, dirv.x, dirv.y, dirv.z);
    }
    g.computeVertexNormals();
    return g;
  };

  /** 贴片网格（自动 FrontSide + 无深度写入） */
  FIG.patchMesh = function (R, dir, w, h, tex, opts) {
    opts = opts || {};
    var geo = FIG.patch(R, dir, w, h, opts.out);
    var mat = K.decal(tex, { opacity: opts.opacity });
    var m = new THREE.Mesh(geo, mat);
    m.userData.noOutline = true;
    m.renderOrder = opts.order == null ? 2 : opts.order;
    if (opts.opacity != null) m.userData.baseOpacity = opts.opacity;
    return m;
  };

  /* ============================ 五官贴图 ============================ */
  function roundRect(x, rx, ry, rw, rh, r) {
    x.beginPath();
    x.moveTo(rx + r, ry);
    x.arcTo(rx + rw, ry, rx + rw, ry + rh, r);
    x.arcTo(rx + rw, ry + rh, rx, ry + rh, r);
    x.arcTo(rx, ry + rh, rx, ry, r);
    x.arcTo(rx, ry, rx + rw, ry, r);
    x.closePath();
  }

  /**
   * 眼睛（含眉毛）贴图。512×512。
   * o = {
   *   mirror, mood: open|half|happy|closed|wink|angry|sad,
   *   iris:[deep, mid, bright], lash, brow, sclera,
   *   round: 0..1  (0=细长御姐, 1=圆滚滚Q版)
   *   high: 高光强度
   * }
   */
  FIG.eyeTexture = function (o) {
    o = o || {};
    var S = 512;
    var mood = o.mood || "open";
    var iris = o.iris || ["#2c6f63", "#41b592", "#8fe9c8"];
    var lash = o.lash || "#3d2130";
    var brow = o.brow || "#c47a97";
    var sclera = o.sclera || "#fdf7fa";
    var round = o.round == null ? 0.6 : o.round;
    var high = o.high == null ? 1 : o.high;
    var c = K.canvas(S, S);
    var x = c.getContext("2d");
    if (o.mirror) { x.translate(S, 0); x.scale(-1, 1); }

    function P(u, v) { return [u * S, v * S]; }
    function moveTo(u, v) { x.moveTo(u * S, v * S); }
    function lineTo(u, v) { x.lineTo(u * S, v * S); }
    function bez(a, b, cc, d, e, f, g2, h2) {
      x.bezierCurveTo(a * S, b * S, cc * S, d * S, e * S, f * S);
      if (g2 != null) x.bezierCurveTo(g2 * S, h2 * S, 0, 0, 0, 0);
    }
    function quad(a, b, cc, d, e, f) { x.quadraticCurveTo(a * S, b * S, cc * S, d * S); }

    // 眼形参数
    var ew = 0.40 - round * 0.02;      // 半宽
    var eh = 0.26 + round * 0.09;      // 上眼睑高度
    var cy = 0.60;
    var cx = 0.52 - round * 0.01;
    // 眼型轮廓：内角(左) -> 上眼睑 -> 外角(右) -> 下眼睑
    function lidPath(scaleTop) {
      x.beginPath();
      moveTo(cx - ew, cy + 0.04);
      bez(cx - ew * 0.55, cy - eh * (scaleTop == null ? 1 : scaleTop) * 1.25,
        cx + ew * 0.35, cy - eh * (scaleTop == null ? 1 : scaleTop) * 1.3,
        cx + ew * 1.02, cy - eh * 0.10);
      bez(cx + ew * 0.72, cy + eh * 0.95,
        cx - ew * 0.15, cy + eh * 1.16,
        cx - ew, cy + 0.04);
      x.closePath();
    }

    if (mood === "happy" || mood === "closed" || mood === "wink") {
      // 闭眼：弯月线
      var up = mood === "happy";
      x.strokeStyle = lash;
      x.lineCap = "round";
      x.lineWidth = S * (0.036 + round * 0.012);
      x.beginPath();
      var y0 = cy + (up ? 0.02 : -0.02);
      moveTo(cx - ew * 0.95, y0 + (up ? 0.10 : -0.02));
      bez(cx - ew * 0.65, y0 + (up ? -0.14 : 0.10), cx + ew * 0.55, y0 + (up ? -0.16 : 0.12), cx + ew * 0.98, y0 + (up ? 0.06 : 0.03));
      x.stroke();
      // 眼尾加粗
      x.lineWidth = S * 0.05;
      x.beginPath();
      moveTo(cx + ew * 0.55, y0 + (up ? -0.10 : 0.09));
      lineTo(cx + ew * 1.0, y0 + (up ? 0.05 : 0.02));
      x.stroke();
      // 下睫毛
      x.lineWidth = S * 0.012;
      x.strokeStyle = lash;
      x.globalAlpha = 0.5;
      x.beginPath();
      moveTo(cx + ew * 0.5, y0 + (up ? -0.02 : 0.10));
      lineTo(cx + ew * 0.72, y0 + (up ? -0.04 : 0.12));
      x.stroke();
      x.globalAlpha = 1;
      drawBrow(x, brow, S, mood, round, lash);
      return K.tex(c);
    }

    // ---- 睁开 ----
    var lidScale = mood === "half" ? 0.62 : 1;
    // 眼白
    lidPath(lidScale);
    x.fillStyle = sclera;
    x.fill();
    // 眼白暗角（上眼睑投影）
    x.save();
    lidPath(lidScale);
    x.clip();
    var sh = x.createLinearGradient(0, (cy - eh) * S, 0, (cy + eh * 0.2) * S);
    sh.addColorStop(0, "rgba(90,60,90,0.30)");
    sh.addColorStop(1, "rgba(90,60,90,0)");
    x.fillStyle = sh;
    x.fillRect(0, 0, S, S);
    x.restore();

    // 虹膜
    var ir = ew * (0.80 + round * 0.12);          // 半径（相对）
    var ix = cx + ew * 0.06, iy = cy + eh * 0.05;
    x.save();
    lidPath(lidScale);
    x.clip();
    var ig = x.createLinearGradient(0, (iy - ir) * S, 0, (iy + ir) * S);
    ig.addColorStop(0, iris[0]);
    ig.addColorStop(0.55, iris[1]);
    ig.addColorStop(1, iris[2]);
    x.fillStyle = ig;
    x.beginPath();
    x.ellipse(ix * S, iy * S, ir * S * 0.86, ir * S, 0, 0, TAU);
    x.fill();
    // 虹膜外圈（limbal ring）
    x.strokeStyle = "rgba(20,45,45,0.55)";
    x.lineWidth = S * 0.018;
    x.beginPath();
    x.ellipse(ix * S, iy * S, ir * S * 0.86, ir * S, 0, 0, TAU);
    x.stroke();
    // 底部反光（月牙）
    var rg = x.createRadialGradient(ix * S, (iy + ir * 0.55) * S, 0, ix * S, (iy + ir * 0.55) * S, ir * S * 0.9);
    rg.addColorStop(0, "rgba(255,255,255,0.62)");
    rg.addColorStop(1, "rgba(255,255,255,0)");
    x.fillStyle = rg;
    x.beginPath();
    x.ellipse(ix * S, (iy + ir * 0.62) * S, ir * S * 0.72, ir * S * 0.42, 0, 0, TAU);
    x.fill();
    // 瞳孔
    var pg = x.createLinearGradient(0, (iy - ir * 0.5) * S, 0, (iy + ir * 0.5) * S);
    pg.addColorStop(0, "rgba(10,30,30,0.92)");
    pg.addColorStop(1, "rgba(20,50,50,0.65)");
    x.fillStyle = pg;
    x.beginPath();
    x.ellipse(ix * S, iy * S, ir * S * 0.42, ir * S * (0.58 + round * 0.1), 0, 0, TAU);
    x.fill();
    // 高光
    x.globalAlpha = high;
    x.fillStyle = "#ffffff";
    x.beginPath(); x.ellipse((ix - ir * 0.36) * S, (iy - ir * 0.42) * S, ir * S * (0.30 + round * 0.06), ir * S * (0.26 + round * 0.08), -0.5, 0, TAU); x.fill();
    x.globalAlpha = high * 0.85;
    x.beginPath(); x.ellipse((ix + ir * 0.42) * S, (iy + ir * 0.42) * S, ir * S * 0.13, ir * S * 0.13, 0, 0, TAU); x.fill();
    // 小十字星光
    x.globalAlpha = high * 0.9;
    x.strokeStyle = "#fff";
    x.lineWidth = S * 0.008;
    x.beginPath();
    x.moveTo((ix - ir * 0.36) * S - 10, (iy - ir * 0.42) * S); x.lineTo((ix - ir * 0.36) * S + 10, (iy - ir * 0.42) * S);
    x.moveTo((ix - ir * 0.36) * S, (iy - ir * 0.42) * S - 10); x.lineTo((ix - ir * 0.36) * S, (iy - ir * 0.42) * S + 10);
    x.stroke();
    x.globalAlpha = 1;
    x.restore();

    // 上睫毛（粗）
    x.strokeStyle = lash;
    x.lineCap = "round";
    x.lineJoin = "round";
    x.lineWidth = S * (0.030 + round * 0.016);
    x.beginPath();
    moveTo(cx - ew * 1.02, cy + 0.10);
    bez(cx - ew * 0.55, cy - eh * lidScale * 1.18,
      cx + ew * 0.30, cy - eh * lidScale * 1.28,
      cx + ew * 1.02, cy - eh * 0.12);
    x.stroke();
    // 外眼角加粗 + 上挑
    x.lineWidth = S * (0.050 + round * 0.012);
    x.beginPath();
    moveTo(cx + ew * 0.42, cy - eh * 0.92);
    quad(cx + ew * 0.78, cy - eh * 0.70, cx + ew * 1.10, cy - eh * 0.05);
    x.stroke();
    // 睫毛小刺
    x.lineWidth = S * 0.022;
    for (var i = 0; i < 3; i++) {
      var tt = 0.55 + i * 0.16;
      var bx = cx + ew * (tt + 0.05), by = cy - eh * (0.95 - i * 0.22);
      x.beginPath();
      moveTo(bx * S, by * S);
      lineTo((bx + 0.05) * S, (by - 0.075) * S);
      x.stroke();
    }
    // 下眼睑线
    x.strokeStyle = lash;
    x.globalAlpha = 0.55;
    x.lineWidth = S * (0.010 + round * 0.004);
    x.beginPath();
    moveTo(cx - ew * 0.55, cy + eh * 0.98);
    bez(cx - ew * 0.15, cy + eh * 1.08, cx + ew * 0.35, cy + eh * 0.95, cx + ew * 0.78, cy + eh * 0.68);
    x.stroke();
    x.globalAlpha = 1;

    if (mood === "half") {
      // 半睁：上眼睑压下来
      x.fillStyle = sclera;
      x.beginPath();
      x.moveTo((cx - ew * 1.1) * S, (cy - eh * 0.1) * S);
      x.bezierCurveTo((cx - ew * 0.5) * S, (cy - eh * 0.7) * S, (cx + ew * 0.5) * S, (cy - eh * 0.7) * S, (cx + ew * 1.1) * S, (cy - eh * 0.12) * S);
      x.lineTo((cx + ew * 1.1) * S, (cy - eh * 1.5) * S);
      x.lineTo((cx - ew * 1.1) * S, (cy - eh * 1.5) * S);
      x.closePath();
      x.fill();
      x.strokeStyle = lash;
      x.lineWidth = S * 0.028;
      x.beginPath();
      moveTo((cx - ew * 1.0) * S, (cy - eh * 0.12) * S);
      x.bezierCurveTo((cx - ew * 0.5) * S, (cy - eh * 0.72) * S, (cx + ew * 0.5) * S, (cy - eh * 0.72) * S, (cx + ew * 1.02) * S, (cy - eh * 0.14) * S);
      x.stroke();
    }

    drawBrow(x, brow, S, mood, round, lash);
    return K.tex(c);
  };

  function drawBrow(x, brow, S, mood, round, lash) {
    var y = 0.18 + (mood === "angry" ? 0.04 : 0);
    x.strokeStyle = brow;
    x.lineCap = "round";
    x.lineWidth = S * 0.020;
    x.beginPath();
    if (mood === "angry") {
      x.moveTo(0.24 * S, (y + 0.02) * S);
      x.quadraticCurveTo(0.46 * S, (y - 0.06) * S, 0.70 * S, (y + 0.03) * S);
    } else if (mood === "sad") {
      x.moveTo(0.24 * S, (y - 0.02) * S);
      x.quadraticCurveTo(0.48 * S, (y + 0.05) * S, 0.72 * S, (y - 0.03) * S);
    } else {
      x.moveTo(0.24 * S, (y + 0.03) * S);
      x.quadraticCurveTo(0.46 * S, (y - 0.055) * S, 0.72 * S, (y + 0.01) * S);
    }
    x.stroke();
  }

  /** 嘴：256×256，透明底 */
  FIG.mouthTexture = function (o) {
    o = o || {};
    var S = 256;
    var kind = o.kind || "smile";
    var lip = o.lip || "#b4566e";
    var inner = o.inner || "#8e3550";
    var c = K.canvas(S, S);
    var x = c.getContext("2d");
    x.lineCap = "round";
    x.lineJoin = "round";
    if (kind === "smile" || kind === "shy") {
      x.strokeStyle = lip;
      x.lineWidth = S * 0.055;
      x.beginPath();
      x.moveTo(S * 0.30, S * 0.44);
      x.quadraticCurveTo(S * 0.5, S * (kind === "shy" ? 0.62 : 0.70), S * 0.70, S * 0.44);
      x.stroke();
    } else if (kind === "cat") {
      x.strokeStyle = lip;
      x.lineWidth = S * 0.05;
      x.beginPath();
      x.moveTo(S * 0.30, S * 0.48);
      x.quadraticCurveTo(S * 0.42, S * 0.72, S * 0.5, S * 0.52);
      x.quadraticCurveTo(S * 0.58, S * 0.72, S * 0.70, S * 0.48);
      x.stroke();
    } else if (kind === "open" || kind === "grin") {
      var w = kind === "grin" ? 0.30 : 0.22;
      var h = kind === "grin" ? 0.30 : 0.24;
      x.fillStyle = inner;
      x.beginPath();
      x.moveTo((0.5 - w) * S, 0.44 * S);
      x.quadraticCurveTo(0.5 * S, (0.44 + h) * S, (0.5 + w) * S, 0.44 * S);
      x.quadraticCurveTo(0.5 * S, (0.44 + h * 0.35) * S, (0.5 - w) * S, 0.44 * S);
      x.fill();
      // 舌头
      x.fillStyle = "#e8889c";
      x.beginPath();
      x.ellipse(0.5 * S, (0.44 + h * 0.62) * S, w * 0.55 * S, h * 0.3 * S, 0, 0, TAU);
      x.fill();
      x.strokeStyle = lip;
      x.lineWidth = S * 0.045;
      x.beginPath();
      x.moveTo((0.5 - w) * S, 0.44 * S);
      x.quadraticCurveTo(0.5 * S, (0.44 + h) * S, (0.5 + w) * S, 0.44 * S);
      x.stroke();
    } else if (kind === "o") {
      x.fillStyle = inner;
      x.beginPath();
      x.ellipse(S * 0.5, S * 0.55, S * 0.12, S * 0.15, 0, 0, TAU);
      x.fill();
    } else if (kind === "wavy") {
      x.strokeStyle = lip;
      x.lineWidth = S * 0.05;
      x.beginPath();
      x.moveTo(S * 0.32, S * 0.52);
      x.quadraticCurveTo(S * 0.40, S * 0.42, S * 0.48, S * 0.54);
      x.quadraticCurveTo(S * 0.56, S * 0.66, S * 0.66, S * 0.52);
      x.stroke();
    } else {
      x.fillStyle = lip;
      x.beginPath();
      x.ellipse(S * 0.5, S * 0.52, S * 0.10, S * 0.07, 0, 0, TAU);
      x.fill();
    }
    return K.tex(c);
  };

  /** 腮红：256×256 软椭圆 + 斜线 */
  FIG.blushTexture = function (color) {
    var S = 256;
    var c = K.canvas(S, S);
    var x = c.getContext("2d");
    var g = x.createRadialGradient(S * 0.5, S * 0.5, 0, S * 0.5, S * 0.5, S * 0.5);
    g.addColorStop(0, color || "rgba(255,120,150,0.55)");
    g.addColorStop(0.6, "rgba(255,120,150,0.22)");
    g.addColorStop(1, "rgba(255,120,150,0)");
    x.fillStyle = g;
    x.beginPath();
    x.ellipse(S * 0.5, S * 0.5, S * 0.46, S * 0.36, 0, 0, TAU);
    x.fill();
    x.strokeStyle = "rgba(255,255,255,0.35)";
    x.lineWidth = S * 0.03;
    for (var i = 0; i < 3; i++) {
      x.beginPath();
      x.moveTo(S * (0.22 + i * 0.16), S * 0.62);
      x.lineTo(S * (0.34 + i * 0.16), S * 0.38);
      x.stroke();
    }
    return K.tex(c);
  };

  /** 高光条：头发上的"天使环" */
  FIG.hairShineTexture = function (color) {
    return K.canvasTexWH(256, 32, function (x, w, h) {
      var g = x.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, "rgba(255,255,255,0)");
      g.addColorStop(0.42, color || "rgba(255,255,255,0.85)");
      g.addColorStop(0.62, color || "rgba(255,255,255,0.55)");
      g.addColorStop(1, "rgba(255,255,255,0)");
      x.fillStyle = g;
      x.fillRect(0, 0, w, h);
    });
  };

  /* ============================ 头部 ============================ */
  /**
   * 头：球体 + 下巴微削 + 五官贴片。
   * o = {R, skin, skinShade, eye:{...}, mouth:{...}, blush, faceY, eyeDir, eyeSize, jaw}
   */
  FIG.head = function (o) {
    o = o || {};
    var R = o.R == null ? 1 : o.R;
    var group = new THREE.Group();
    var skinMat = K.cel({ color: o.skin || 0xffe9dd, shade: o.skinShade, rim: 0xffd0e0, rimStr: 0.14, hiStr: 0.16, lift: 0.5, shadeAmt: 0.8 });
    var geo = new THREE.SphereGeometry(R, 40, 30);
    // 下巴：把下半部分往里收一点，做出小尖下巴
    var jaw = o.jaw == null ? 0.20 : o.jaw;
    if (jaw > 0) {
      var p = geo.attributes.position;
      for (var i = 0; i < p.count; i++) {
        var y = p.getY(i);
        if (y < -R * 0.35) {
          var t = Math.min(1, (-y - R * 0.35) / (R * 0.65));
          var k = 1 - jaw * t * t;
          p.setX(i, p.getX(i) * k);
          p.setZ(i, p.getZ(i) * k);
          p.setY(i, y * (1 - 0.05 * t));
        }
      }
      geo.computeVertexNormals();
    }
    var headMesh = new THREE.Mesh(geo, skinMat);
    if (o.scale) group.scale.set(o.scale[0] || 1, o.scale[1] || 1, o.scale[2] || 1);
    K.outline(headMesh, { thickness: R * 0.012, color: o.outline || 0x33222c });
    group.add(headMesh);

    var faceY = o.faceY == null ? -0.06 : o.faceY;
    var eyeCfg = o.eye || {};
    var round = eyeCfg.round == null ? 0.6 : eyeCfg.round;

    // 眼睛（贴片）
    var ex = o.eyeX == null ? 0.36 : o.eyeX;
    var ey = o.eyeY == null ? -0.10 : o.eyeY;
    var eyeW = o.eyeW == null ? 0.82 : o.eyeW;
    var eyeH = o.eyeH == null ? 0.86 : o.eyeH;
    var eyeTexCache = { L: {}, R: {} };
    function eyeTex(mirror, mood) {
      var key = mood || "open";
      var box = mirror ? eyeTexCache.R : eyeTexCache.L;
      if (!box[key]) box[key] = FIG.eyeTexture(Object.assign({}, eyeCfg, { mirror: mirror, mood: key }));
      return box[key];
    }
    var mouthTexCache = {};
    function mouthTex(kind) {
      var key = kind || "smile";
      if (!mouthTexCache[key]) mouthTexCache[key] = FIG.mouthTexture(Object.assign({}, o.mouth || {}, { kind: key }));
      return mouthTexCache[key];
    }
    var texL = eyeTex(false, eyeCfg.mood || "open");
    var texR = eyeTex(true, eyeCfg.mood || "open");
    var dirL = [ -ex, ey + faceY, Math.sqrt(Math.max(0.05, 1 - ex * ex - (ey + faceY) * (ey + faceY))) ];
    var dirR = [ ex, ey + faceY, dirL[2] ];
    var eyeL = FIG.patchMesh(R, dirL, eyeW, eyeH, texL, { order: 3 });
    var eyeR = FIG.patchMesh(R, dirR, eyeW, eyeH, texR, { order: 3 });
    group.add(eyeL, eyeR);

    // 嘴
    var mouthY = o.mouthY == null ? -0.52 : o.mouthY;
    var mDir = [0, mouthY + faceY, Math.sqrt(Math.max(0.05, 1 - Math.pow(mouthY + faceY, 2)))];
    var mouth0 = mouthTex((o.mouth && o.mouth.kind) || "smile");
    var mouth = FIG.patchMesh(R, mDir, 0.30, 0.24, mouth0, { order: 4 });
    group.add(mouth);

    // 腮红
    var blushL = null, blushR = null;
    if (o.blush !== false) {
      var bTex = FIG.blushTexture(o.blushColor);
      var bx = 0.60, by = -0.30;
      var bz = Math.sqrt(Math.max(0.05, 1 - bx * bx - (by + faceY) * (by + faceY)));
      blushL = FIG.patchMesh(R, [-bx, by + faceY, bz], 0.46, 0.34, bTex, { order: 2, opacity: o.blushOpacity == null ? 0.9 : o.blushOpacity });
      blushR = FIG.patchMesh(R, [bx, by + faceY, bz], 0.46, 0.34, bTex, { order: 2, opacity: o.blushOpacity == null ? 0.9 : o.blushOpacity });
      group.add(blushL, blushR);
    }

    // 鼻子（一点点）
    var noseTex = K.canvasTex(128, function (xc, S) {
      xc.strokeStyle = "rgba(210,140,140,0.55)";
      xc.lineWidth = S * 0.045;
      xc.lineCap = "round";
      xc.beginPath();
      xc.moveTo(S * 0.42, S * 0.6);
      xc.quadraticCurveTo(S * 0.5, S * 0.72, S * 0.58, S * 0.6);
      xc.stroke();
    });
    var nDir = [0, -0.34 + faceY, Math.sqrt(Math.max(0.05, 1 - Math.pow(-0.34 + faceY, 2)))];
    var nose = FIG.patchMesh(R, nDir, 0.16, 0.12, noseTex, { order: 4, opacity: 0.75 });
    group.add(nose);

    var face = {
      eyeL: eyeL, eyeR: eyeR, mouth: mouth, blushL: blushL, blushR: blushR, nose: nose,
      R: R, eyeCfg: eyeCfg,
      setMood: function (mood) {
        var m = mood === "blink" ? "closed" : mood;
        eyeL.material.map = eyeTex(false, m);
        eyeR.material.map = eyeTex(true, m);
        eyeL.material.needsUpdate = true;
        eyeR.material.needsUpdate = true;
      },
      setMouth: function (kind) {
        mouth.material.map = mouthTex(kind);
        mouth.material.needsUpdate = true;
      },
      setBlush: function (v) {
        if (!blushL) return;
        blushL.material.opacity = v;
        blushR.material.opacity = v;
      },
      /** 视线：让眼贴片绕球心轻微旋转（贴片本来就在球面上，旋转后依然贴合，且零分配） */
      look: function (dx, dy) {
        var lx = K.clamp(dx, -1, 1), ly = K.clamp(dy, -1, 1);
        var ay = lx * 0.17, ax = -ly * 0.13;
        eyeL.rotation.y = ay; eyeL.rotation.x = ax;
        eyeR.rotation.y = ay; eyeR.rotation.x = ax;
      },
    };
    return { group: group, face: face, mesh: headMesh, R: R };
  };

  /* ============================ 头发 ============================ */
  /**
   * 球壳头发：发际线是平滑曲线（正面高、后面低），不会在额头留下生硬的方框边。
   */
  FIG.hairCap = function (R, opts) {
    opts = opts || {};
    var rad = R * (opts.scale == null ? 1.045 : opts.scale);
    var thetaFront = (opts.thetaFront == null ? 0.62 : opts.thetaFront) * PI;
    var thetaBack = (opts.thetaBack == null ? 0.94 : opts.thetaBack) * PI;
    var seg = 56, rows = 26;
    function thetaMaxAt(phi) {
      var c = Math.cos(phi);
      var t = K.smooth((c + 0.15) / 1.15);
      return thetaBack + (thetaFront - thetaBack) * t;
    }
    var pos = [], uv = [], idx = [];
    for (var i = 0; i <= rows; i++) {
      var u = i / rows;
      for (var j = 0; j <= seg; j++) {
        var ph = (j / seg) * TAU;
        var th = u * thetaMaxAt(ph);
        var x = rad * Math.sin(th) * Math.sin(ph);
        var y = rad * Math.cos(th);
        var z = rad * Math.sin(th) * Math.cos(ph);
        pos.push(x, y, z);
        uv.push(j / seg, u);
      }
    }
    for (var a = 0; a < rows; a++) {
      for (var b = 0; b < seg; b++) {
        var i00 = a * (seg + 1) + b, i01 = i00 + 1, i10 = i00 + seg + 1, i11 = i10 + 1;
        idx.push(i00, i10, i01, i01, i10, i11);
      }
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  };

  /** 从头顶某方向飘下来的一撮头发 */
  FIG.clump = function (opts) {
    var pts = opts.pts;
    return new THREE.Mesh(K.strand({
      pts: pts,
      radii: opts.radii || [0.10, 0.004],
      flat: opts.flat == null ? 0.55 : opts.flat,
      seg: opts.seg || 10,
      radial: opts.radial || 7,
      twist: opts.twist || 0,
    }), opts.mat);
  };

  /* ============================ 四肢 ============================ */
  /** 关节组：返回 {root, end}，root 是枢轴 */
  FIG.joint = function (parent, pos) {
    var g = new THREE.Group();
    if (pos) g.position.set(pos[0] || 0, pos[1] || 0, pos[2] || 0);
    if (parent) parent.add(g);
    return g;
  };

  /** 手臂：肩关节 -> 上臂 -> 肘 -> 前臂 -> 手 */
  FIG.arm = function (o) {
    var side = o.side === "L" ? 1 : -1;      // L 是屏幕左边（角色右手）
    var len = o.len == null ? 1 : o.len;
    var r = o.r == null ? 0.16 : o.r;
    var mat = o.mat;
    var shoulder = FIGSafeGroup(o.parent, [side * (o.x == null ? 0.9 : o.x), o.y == null ? 2.0 : o.y, 0]);
    var upper = new THREE.Group();
    shoulder.add(upper);
    var upperMesh = new THREE.Mesh(K.capsule(r, len * 0.48, 10), mat);
    upperMesh.position.y = -len * 0.26;
    if (o.outline !== false) K.outline(upperMesh, { thickness: r * 0.13, color: o.outlineColor || 0x33222c });
    upper.add(upperMesh);

    var elbow = new THREE.Group();
    elbow.position.y = -len * 0.52;
    upper.add(elbow);
    var foreMesh = new THREE.Mesh(K.capsule(r * 0.86, len * 0.44, 10), o.matLower || mat);
    foreMesh.position.y = -len * 0.24;
    if (o.outline !== false) K.outline(foreMesh, { thickness: r * 0.12, color: o.outlineColor || 0x33222c });
    elbow.add(foreMesh);

    var wrist = new THREE.Group();
    wrist.position.y = -len * 0.5;
    elbow.add(wrist);
    var hand = new THREE.Mesh(K.sphere(r * 1.05, 0.92, 1.05, 0.8, 16), o.matHand || o.mat);
    hand.position.y = -r * 0.9;
    if (o.outline !== false) K.outline(hand, { thickness: r * 0.12, color: o.outlineColor || 0x33222c });
    wrist.add(hand);
    return { shoulder: shoulder, upper: upper, elbow: elbow, wrist: wrist, hand: hand, side: side };
  };

  function FIGSafeGroup(parent, pos) {
    var g = new THREE.Group();
    if (pos) g.position.set(pos[0] || 0, pos[1] || 0, pos[2] || 0);
    if (parent) parent.add(g);
    return g;
  }

  /** 腿：髋 -> 大腿 -> 膝 -> 小腿 -> 脚 */
  FIG.leg = function (o) {
    var side = o.side === "L" ? 1 : -1;
    var len = o.len == null ? 1 : o.len;
    var r = o.r == null ? 0.17 : o.r;
    var hip = FIGSafeGroup(o.parent, [side * (o.x == null ? 0.24 : o.x), o.y == null ? 1.0 : o.y, 0]);
    var thigh = new THREE.Group();
    hip.add(thigh);
    var tm = new THREE.Mesh(K.capsule(r, len * 0.5, 10), o.mat);
    tm.position.y = -len * 0.27;
    if (o.outline !== false) K.outline(tm, { thickness: r * 0.12, color: o.outlineColor || 0x33222c });
    thigh.add(tm);

    var knee = new THREE.Group();
    knee.position.y = -len * 0.54;
    thigh.add(knee);
    var sm = new THREE.Mesh(K.capsule(r * 0.82, len * 0.42, 10), o.matLower || o.mat);
    sm.position.y = -len * 0.23;
    if (o.outline !== false) K.outline(sm, { thickness: r * 0.11, color: o.outlineColor || 0x33222c });
    knee.add(sm);

    var ankle = new THREE.Group();
    ankle.position.y = -len * 0.48;
    knee.add(ankle);
    if (o.shoe) {
      var shoe = new THREE.Mesh(o.shoe, o.matShoe || o.mat);
      shoe.position.set(0, -r * 0.55, r * 0.35);
      if (o.outline !== false) K.outline(shoe, { thickness: r * 0.1, color: o.outlineColor || 0x33222c });
      ankle.add(shoe);
    }
    return { hip: hip, thigh: thigh, knee: knee, ankle: ankle, side: side };
  };

  /* ============================ 衣服 ============================ */
  /** 裙摆 / 大衣下摆：车削 */
  FIG.flare = function (o) {
    var g = K.lathe(o.profile, o.seg || 36, o.phiStart, o.phiLen);
    var m = new THREE.Mesh(g, o.mat);
    if (o.outline !== false) K.outline(m, { thickness: o.thickness == null ? 0.006 : o.thickness, color: o.outlineColor || 0x2a1d24 });
    if (o.parent) o.parent.add(m);
    return m;
  };

  /** 荷叶边：一圈小圆弧 */
  FIG.frill = function (o) {
    var n = o.count || 16;
    var R = o.r || 0.5;
    var size = o.size || 0.06;
    var group = new THREE.Group();
    var mat = o.mat;
    for (var i = 0; i < n; i++) {
      var a = (i / n) * TAU;
      var m = new THREE.Mesh(K.sphere(size, 1, 1.35, 0.7, 12), mat);
      m.position.set(Math.cos(a) * R, 0, Math.sin(a) * R);
      m.rotation.y = -a;
      group.add(m);
    }
    if (o.parent) o.parent.add(group);
    return group;
  };

  /* ============================ 骨架 ============================ */
  /**
   * 简易关节骨架：每个关节有 pose 三轴（弹簧过渡）+ 每帧 motion 叠加。
   *   rig.add("head", headGroup)
   *   rig.pose({head:{x:0.1,y:0.2}})         // 平滑过渡到目标姿势
   *   rig.motion("head", 0, 0.05, 0)          // 每帧程序化叠加
   *   rig.update(dt)
   */
  FIG.rig = function () {
    var joints = [];
    var byName = {};
    var rig = {
      add: function (name, obj, cfg) {
        var j = {
          name: name, obj: obj,
          target: [0, 0, 0], motion: [0, 0, 0],
          sp: [K.springer(0, cfg), K.springer(0, cfg), K.springer(0, cfg)],
          k: cfg && cfg.k, d: cfg && cfg.d,
        };
        joints.push(j);
        byName[name] = j;
        return rig;
      },
      get: function (name) { return byName[name]; },
      pose: function (map) {
        for (var k in map) {
          var j = byName[k];
          if (!j) continue;
          var v = map[k];
          j.sp[0].set(v[0] || 0);
          j.sp[1].set(v[1] || 0);
          j.sp[2].set(v[2] || 0);
        }
        return rig;
      },
      poseOne: function (name, x, y, z) { return rig.pose((function () { var m = {}; m[name] = [x, y, z]; return m; })()); },
      snap: function (map) {
        for (var k in map) {
          var j = byName[k];
          if (!j) continue;
          var v = map[k];
          j.sp[0].jump(v[0] || 0); j.sp[1].jump(v[1] || 0); j.sp[2].jump(v[2] || 0);
        }
        return rig;
      },
      motion: function (name, x, y, z) {
        var j = byName[name];
        if (!j) return rig;
        j.motion[0] = x || 0; j.motion[1] = y || 0; j.motion[2] = z || 0;
        return rig;
      },
      resetMotion: function () {
        for (var i = 0; i < joints.length; i++) { joints[i].motion[0] = joints[i].motion[1] = joints[i].motion[2] = 0; }
        return rig;
      },
      update: function (dt) {
        for (var i = 0; i < joints.length; i++) {
          var j = joints[i];
          j.obj.rotation.set(
            j.sp[0].update(dt) + j.motion[0],
            j.sp[1].update(dt) + j.motion[1],
            j.sp[2].update(dt) + j.motion[2]
          );
        }
        return rig;
      },
    };
    return rig;
  };

  return FIG;
};
