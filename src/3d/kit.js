/**
 * kit —— 3D 底层工具箱
 * 卡通渲染材质 / 描边 / 程序化几何（发丝、车削、胶囊）/ Canvas 贴图 / 弹簧动画 / 粒子几何。
 * 只依赖 THREE（由外部注入），不含任何角色设定。
 */
module.exports.create = function (THREE) {
  var K = { THREE: THREE };
  var PI = Math.PI;
  var TAU = Math.PI * 2;

  /* ------------------------------ 数学 ------------------------------ */
  K.clamp = function (v, a, b) { return v < a ? a : v > b ? b : v; };
  K.lerp = function (a, b, t) { return a + (b - a) * t; };
  K.smooth = function (t) { t = K.clamp(t, 0, 1); return t * t * (3 - 2 * t); };
  K.easeOut = function (t) { t = K.clamp(t, 0, 1); return 1 - Math.pow(1 - t, 3); };
  K.easeInOut = function (t) { t = K.clamp(t, 0, 1); return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; };
  K.easeBack = function (t) { t = K.clamp(t, 0, 1); var c = 1.70158; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };
  K.rand = function (a, b) { return a + Math.random() * (b - a); };
  K.pick = function (arr) { return arr[(Math.random() * arr.length) | 0]; };

  K.springer = function (initial, cfg) {
    cfg = cfg || {};
    var k = cfg.k || 170, d = cfg.d || 20;
    var s = { value: initial, target: initial, v: 0, eps: cfg.eps || 0.0004 };
    s.set = function (t) { s.target = t; return s; };
    s.jump = function (t) { s.target = s.value = t; s.v = 0; return s; };
    s.update = function (dt) {
      if (dt > 0.1) dt = 0.1;
      var a = (s.target - s.value) * k - s.v * d;
      s.v += a * dt;
      s.value += s.v * dt;
      if (Math.abs(s.target - s.value) < s.eps && Math.abs(s.v) < s.eps) { s.value = s.target; s.v = 0; }
      return s.value;
    };
    return s;
  };

  /* ------------------------------ 颜色 ------------------------------ */
  K.color = function (hex) { return new THREE.Color(hex); };
  K.shadeOf = function (hex, amount, tint) {
    var base = new THREE.Color(hex);
    var c = base.clone().multiplyScalar(amount == null ? 0.58 : amount);
    if (tint) c.lerp(new THREE.Color(tint), 0.22);
    return c;
  };

  /* --------------------------- 共享的光照方向 --------------------------- */
  // 所有卡通材质共享同一组 uniform 对象，切昼夜时整体改一次即可
  var SHARED = {
    uLight: { value: new THREE.Vector3(0.45, 0.82, 0.62).normalize() },
    uLight2: { value: new THREE.Vector3(-0.7, 0.15, -0.55).normalize() },
    uNight: { value: 0 },
  };
  K.shared = SHARED;
  K.setLightDir = function (x, y, z) { SHARED.uLight.value.set(x, y, z).normalize(); };
  K.setNight = function (v) { SHARED.uNight.value = v; };

  var CEL_VERT = [
    "varying vec3 vN;",
    "varying vec3 vW;",
    "varying vec2 vUv;",
    "void main() {",
    "  vUv = uv;",
    "  vec4 wp = modelMatrix * vec4(position, 1.0);",
    "  vW = wp.xyz;",
    "  vN = normalize(mat3(modelMatrix) * normal);",
    "  gl_Position = projectionMatrix * viewMatrix * wp;",
    "}",
  ].join("\n");

  var CEL_FRAG = [
    "uniform vec3 uBase;",
    "uniform vec3 uShade;",
    "uniform vec3 uHi;",
    "uniform vec3 uRim;",
    "uniform vec3 uEmis;",
    "uniform float uLift;",
    "uniform float uRimPow;",
    "uniform float uRimStr;",
    "uniform float uHiStr;",
    "uniform float uSpec;",
    "uniform float uSpecPow;",
    "uniform float uShadeMix;",
    "uniform float uOpacity;",
    "uniform float uNight;",
    "uniform vec3 uLight;",
    "uniform vec3 uLight2;",
    "varying vec3 vN;",
    "varying vec3 vW;",
    "varying vec2 vUv;",
    "void main() {",
    "  vec3 N = normalize(vN);",
    "  if (!gl_FrontFacing) N = -N;",
    "  vec3 V = normalize(cameraPosition - vW);",
    "  vec3 L = normalize(uLight);",
    "  float ndl = dot(N, L);",
    "  float t = smoothstep(-0.10, 0.34, ndl);",
    "  vec3 shadeC = mix(uShade, uBase, uLift);",
    "  vec3 c = mix(shadeC, uBase, t);",
    "  float hi = smoothstep(0.55, 0.94, ndl);",
    "  c = mix(c, uHi, hi * uHiStr);",
    // 背光补色：让暗面不死
    "  float fill = max(dot(N, normalize(uLight2)), 0.0);",
    "  c += uBase * fill * 0.16;",
    // 边缘光
    "  float rim = pow(1.0 - max(dot(N, V), 0.0), uRimPow);",
    "  c += uRim * rim * uRimStr * (0.45 + 0.55 * t);",
    // 高光
    "  vec3 H = normalize(L + V);",
    "  c += vec3(1.0) * pow(max(dot(N, H), 0.0), uSpecPow) * uSpec;",
    // 夜色：整体压暗偏蓝
    "  c = mix(c, c * vec3(0.62, 0.68, 0.92), uNight);",
    "  c += uEmis;",
    "  gl_FragColor = vec4(c, uOpacity);",
    "  #include <colorspace_fragment>",
    "}",
  ].join("\n");

  /**
   * 卡通材质。
   * cel({color, shade, hi, rim, rimStr, rimPow, spec, specPow, hiStr, emissive, opacity, side})
   */
  K.cel = function (opts) {
    opts = opts || {};
    var base = new THREE.Color(opts.color != null ? opts.color : 0xffffff);
    var shade = opts.shade != null ? new THREE.Color(opts.shade) : K.shadeOf(base.getHex(), opts.shadeAmt, opts.tint);
    var hi = opts.hi != null ? new THREE.Color(opts.hi) : base.clone().lerp(new THREE.Color(0xffffff), 0.22);
    var mat = new THREE.ShaderMaterial({
      uniforms: {
        uBase: { value: base },
        uShade: { value: shade },
        uHi: { value: hi },
        uRim: { value: new THREE.Color(opts.rim != null ? opts.rim : 0xffffff) },
        uEmis: { value: new THREE.Color(opts.emissive != null ? opts.emissive : 0x000000) },
        uRimPow: { value: opts.rimPow != null ? opts.rimPow : 2.4 },
        uRimStr: { value: opts.rimStr != null ? opts.rimStr : 0.14 },
        uHiStr: { value: opts.hiStr != null ? opts.hiStr : 0.28 },
        uSpec: { value: opts.spec != null ? opts.spec : 0.0 },
        uSpecPow: { value: opts.specPow != null ? opts.specPow : 30 },
        uShadeMix: { value: 1 },
        uLift: { value: opts.lift != null ? opts.lift : 0 },
        uOpacity: { value: opts.opacity != null ? opts.opacity : 1 },
        uNight: SHARED.uNight,
        uLight: SHARED.uLight,
        uLight2: SHARED.uLight2,
      },
      vertexShader: CEL_VERT,
      fragmentShader: CEL_FRAG,
      side: opts.side || THREE.FrontSide,
      transparent: !!opts.transparent || (opts.opacity != null && opts.opacity < 1),
      depthWrite: opts.depthWrite !== false,
    });
    mat.userData.cel = true;
    return mat;
  };

  /** 贴图装饰片（眼睛、嘴、腮红、衣服印花）：不吃光，颜色最准 */
  K.decal = function (tex, opts) {
    opts = opts || {};
    var mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      opacity: opts.opacity != null ? opts.opacity : 1,
      depthWrite: false,
      side: opts.side || THREE.FrontSide,
      alphaTest: opts.alphaTest != null ? opts.alphaTest : 0.01,
      toneMapped: false,
    });
    return mat;
  };

  /* ------------------------------ 描边 ------------------------------ */
  var OUTLINE_VERT = [
    "uniform float uT;",
    "void main() {",
    "  vec3 p = position + normal * uT;",
    "  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);",
    "}",
  ].join("\n");
  var OUTLINE_FRAG = [
    "uniform vec3 uC;",
    "uniform float uA;",
    "void main() { gl_FragColor = vec4(uC, uA); }",
  ].join("\n");

  /** 反壳描边：挂成 mesh 的子节点，跟着动画一起动 */
  K.outline = function (mesh, opts) {
    opts = opts || {};
    var mat = new THREE.ShaderMaterial({
      uniforms: {
        uT: { value: opts.thickness != null ? opts.thickness : 0.008 },
        uC: { value: new THREE.Color(opts.color != null ? opts.color : 0x2a1d24) },
        uA: { value: opts.opacity != null ? opts.opacity : 1 },
      },
      vertexShader: OUTLINE_VERT,
      fragmentShader: OUTLINE_FRAG,
      side: THREE.BackSide,
      transparent: opts.opacity != null && opts.opacity < 1,
    });
    var o = new THREE.Mesh(mesh.geometry, mat);
    o.userData.outline = true;
    o.raycast = function () {};
    mesh.add(o);
    return mesh;
  };

  /** 给一组 mesh 统一加描边 */
  K.outlineAll = function (obj, opts) {
    var list = [];
    obj.traverse(function (o) { if (o.isMesh && !o.userData.outline && !o.userData.noOutline) list.push(o); });
    for (var i = 0; i < list.length; i++) K.outline(list[i], opts);
    return obj;
  };

  /* ------------------------------ 几何 ------------------------------ */
  K.sphere = function (r, sx, sy, sz, seg) {
    var g = new THREE.SphereGeometry(r, seg || 32, (seg || 32) >> 1);
    g.scale(sx == null ? 1 : sx, sy == null ? 1 : sy, sz == null ? 1 : sz);
    return g;
  };

  /** 胶囊：y 轴朝上，总高 = len + 2r */
  K.capsule = function (r, len, seg) {
    return new THREE.CapsuleGeometry(r, Math.max(0.0001, len), seg || 8, seg || 16);
  };

  /** 车削：profile = [[r,y], ...]（从下到上），可只削一段圆弧 */
  K.lathe = function (profile, seg, phiStart, phiLen) {
    var pts = profile.map(function (p) { return new THREE.Vector2(Math.max(0.00001, p[0]), p[1]); });
    return new THREE.LatheGeometry(pts, seg || 32, phiStart || 0, phiLen || TAU);
  };

  K.ring = function (r, tube, arc, seg) {
    return new THREE.TorusGeometry(r, tube, seg || 8, Math.max(6, (seg || 8) * 4), arc == null ? TAU : arc);
  };

  K.plane = function (w, h) { return new THREE.PlaneGeometry(w, h); };

  K.box = function (w, h, d, r) {
    if (!r) return new THREE.BoxGeometry(w, h, d);
    return new THREE.BoxGeometry(w, h, d, 2, 2, 2);
  };

  K.cylinder = function (rt, rb, h, seg, open) {
    return new THREE.CylinderGeometry(rt, rb, h, seg || 24, 1, !!open);
  };

  K.tube = function (points, radius, seg, radial, closed) {
    var curve = new THREE.CatmullRomCurve3(points.map(function (p) { return new THREE.Vector3(p[0], p[1], p[2]); }));
    return new THREE.TubeGeometry(curve, seg || 24, radius, radial || 8, !!closed);
  };

  /**
   * 发丝 / 布条：沿曲线扫出来的扁平锥形管。
   * strand({pts:[[x,y,z],...], radii:[..] | [a,b], flat:0.5, seg, radial, twist})
   */
  K.strand = function (o) {
    var pts = (o.pts || []).map(function (p) { return new THREE.Vector3(p[0], p[1], p[2]); });
    var curve = new THREE.CatmullRomCurve3(pts, false, "catmullrom", o.tension == null ? 0.4 : o.tension);
    var seg = o.seg || 18, radial = o.radial || 8;
    var frames = curve.computeFrenetFrames(seg, false);
    var radii = o.radii || [1, 1];
    var flat = o.flat == null ? 0.58 : o.flat;
    var twist = o.twist || 0;
    var pos = [], nor = [], uvs = [], idx = [];
    function rAt(t) {
      if (radii.length === 2) return radii[0] + (radii[1] - radii[0]) * t;
      var f = t * (radii.length - 1), i = Math.floor(f), a = f - i;
      var j = Math.min(radii.length - 1, i + 1);
      return radii[i] * (1 - a) + radii[j] * a;
    }
    for (var i = 0; i <= seg; i++) {
      var t = i / seg;
      var P = curve.getPointAt(t);
      var N = frames.normals[Math.min(i, seg)];
      var B = frames.binormals[Math.min(i, seg)];
      var R = rAt(t);
      var ang0 = twist * t;
      for (var j = 0; j <= radial; j++) {
        var ang = (j / radial) * TAU + ang0;
        var cx = Math.cos(ang), sy = Math.sin(ang);
        var px = P.x + N.x * cx * R + B.x * sy * R * flat;
        var py = P.y + N.y * cx * R + B.y * sy * R * flat;
        var pz = P.z + N.z * cx * R + B.z * sy * R * flat;
        pos.push(px, py, pz);
        nor.push(0, 0, 0);
        uvs.push(j / radial, t);
      }
    }
    for (var i2 = 0; i2 < seg; i2++) {
      for (var j2 = 0; j2 < radial; j2++) {
        var a2 = i2 * (radial + 1) + j2;
        var b2 = a2 + radial + 1;
        idx.push(a2, a2 + 1, b2, b2, a2 + 1, b2 + 1);
      }
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  };

  /**
   * 带状发片：横截面朝向可控（宽面永远朝着 ref 方向铺开）。
   * ribbon({pts, widths:[..] | [a,b], thick, ref:[x,y,z], seg, radial, curve})
   * 用于刘海/长发——比圆管更像"一撮头发"，不会从侧面变成一根黑线。
   */
  K.ribbon = function (o) {
    var pts = (o.pts || []).map(function (p) { return new THREE.Vector3(p[0], p[1], p[2]); });
    var curve = new THREE.CatmullRomCurve3(pts, false, "catmullrom", o.tension == null ? 0.35 : o.tension);
    var seg = o.seg || 16, radial = o.radial || 8;
    var widths = o.widths || [0.1, 0.01];
    var thick = o.thick == null ? 0.03 : o.thick;
    var ref = new THREE.Vector3((o.ref || [1, 0, 0])[0], (o.ref || [1, 0, 0])[1], (o.ref || [1, 0, 0])[2]).normalize();
    function wAt(t) {
      if (widths.length === 2) return widths[0] + (widths[1] - widths[0]) * t;
      var f = t * (widths.length - 1), i = Math.floor(f), a = f - i;
      var j = Math.min(widths.length - 1, i + 1);
      return widths[i] * (1 - a) + widths[j] * a;
    }
    var pos = [], uvs = [], idx = [];
    var P = new THREE.Vector3(), T = new THREE.Vector3(), W = new THREE.Vector3(), N = new THREE.Vector3(), tmp = new THREE.Vector3();
    for (var i = 0; i <= seg; i++) {
      var t = i / seg;
      curve.getPointAt(t, P);
      curve.getTangentAt(t, T);
      W.copy(ref).addScaledVector(T, -ref.dot(T));
      if (W.lengthSq() < 1e-5) W.set(T.z, 0, -T.x);
      W.normalize();
      N.crossVectors(T, W).normalize();
      var w = wAt(t);
      var th = thick * (0.35 + 0.65 * (1 - t) * (0.5 + 0.5 * Math.min(1, w / (widths[0] || 0.1))));
      for (var j = 0; j <= radial; j++) {
        var a2 = (j / radial) * TAU;
        var cy = Math.cos(a2), sy = Math.sin(a2);
        // 上窄下宽一点，模拟发片厚度变化
        tmp.copy(P).addScaledVector(W, cy * w * 0.5).addScaledVector(N, sy * th);
        pos.push(tmp.x, tmp.y, tmp.z);
        uvs.push(j / radial, t);
      }
    }
    for (var i2 = 0; i2 < seg; i2++) {
      for (var j2 = 0; j2 < radial; j2++) {
        var a3 = i2 * (radial + 1) + j2;
        var b3 = a3 + radial + 1;
        idx.push(a3, a3 + 1, b3, b3, a3 + 1, b3 + 1);
      }
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  };

  /** 心形（可挤出成 3D） */
  K.heartShape = function (s) {
    s = s || 1;
    var sh = new THREE.Shape();
    sh.moveTo(0, -0.9 * s);
    sh.bezierCurveTo(0.25 * s, -0.55 * s, 1.0 * s, -0.15 * s, 0.95 * s, 0.28 * s);
    sh.bezierCurveTo(0.9 * s, 0.75 * s, 0.28 * s, 0.95 * s, 0.0, 0.55 * s);
    sh.bezierCurveTo(-0.28 * s, 0.95 * s, -0.9 * s, 0.75 * s, -0.95 * s, 0.28 * s);
    sh.bezierCurveTo(-1.0 * s, -0.15 * s, -0.25 * s, -0.55 * s, 0.0, -0.9 * s);
    return sh;
  };
  K.heart = function (s, depth) {
    var g = new THREE.ExtrudeGeometry(K.heartShape(s), {
      depth: depth == null ? 0.16 : depth,
      bevelEnabled: true, bevelSize: 0.06 * s, bevelThickness: 0.05 * s, bevelSegments: 2, curveSegments: 12,
    });
    g.center();
    return g;
  };

  K.starShape = function (s, points, inner) {
    var sh = new THREE.Shape();
    var n = points || 5, ri = inner == null ? 0.45 : inner;
    for (var i = 0; i < n * 2; i++) {
      var a = (i / (n * 2)) * TAU - PI / 2;
      var r = (i % 2 === 0 ? 1 : ri) * (s || 1);
      var x = Math.cos(a) * r, y = Math.sin(a) * r;
      if (i === 0) sh.moveTo(x, y); else sh.lineTo(x, y);
    }
    sh.closePath();
    return sh;
  };
  K.star = function (s, depth) {
    var g = new THREE.ExtrudeGeometry(K.starShape(s, 5, 0.44), {
      depth: depth == null ? 0.12 : depth,
      bevelEnabled: true, bevelSize: 0.03, bevelThickness: 0.03, bevelSegments: 1, curveSegments: 8,
    });
    g.center();
    return g;
  };

  /** 水滴/泡泡（鲸鲸的水花） */
  K.drop = function (r) {
    var g = new THREE.SphereGeometry(r, 16, 12);
    var p = g.attributes.position;
    for (var i = 0; i < p.count; i++) {
      var y = p.getY(i);
      if (y > 0) p.setY(i, y * 1.7);
    }
    g.computeVertexNormals();
    return g;
  };

  /* --------------------------- Canvas 贴图 --------------------------- */
  K.canvas = function (w, h) {
    var c = document.createElement("canvas");
    c.width = w; c.height = h;
    return c;
  };

  K.tex = function (canvas) {
    var t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.needsUpdate = true;
    return t;
  };

  K.canvasTex = function (size, draw) {
    var c = K.canvas(size, size);
    var x = c.getContext("2d");
    draw(x, size, size);
    return K.tex(c);
  };

  K.canvasTexWH = function (w, h, draw) {
    var c = K.canvas(w, h);
    var x = c.getContext("2d");
    draw(x, w, h);
    return K.tex(c);
  };

  /** 圆形渐变贴图：用于辉光 / 地面阴影 */
  K.radialTex = function (stops, size) {
    size = size || 256;
    return K.canvasTex(size, function (x, w) {
      var g = x.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
      for (var i = 0; i < stops.length; i++) g.addColorStop(stops[i][0], stops[i][1]);
      x.fillStyle = g;
      x.fillRect(0, 0, w, w);
    });
  };

  /** 软阴影椭圆贴图 */
  K.shadowTex = function () {
    return K.canvasTexWH(256, 256, function (x, w, h) {
      var g = x.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
      g.addColorStop(0, "rgba(0,0,0,0.55)");
      g.addColorStop(0.45, "rgba(0,0,0,0.26)");
      g.addColorStop(1, "rgba(0,0,0,0)");
      x.fillStyle = g;
      x.fillRect(0, 0, w, h);
    });
  };

  /* ------------------------------ 工具 ------------------------------ */
  K.mesh = function (geo, mat, parent, pos) {
    var m = new THREE.Mesh(geo, mat);
    if (pos) m.position.set(pos[0] || 0, pos[1] || 0, pos[2] || 0);
    if (parent) parent.add(m);
    return m;
  };

  K.group = function (parent, pos) {
    var g = new THREE.Group();
    if (pos) g.position.set(pos[0] || 0, pos[1] || 0, pos[2] || 0);
    if (parent) parent.add(g);
    return g;
  };

  /** 统一设置深度写入/透明度（贴片用） */
  K.flat = function (mesh) {
    if (mesh.material) {
      mesh.material.depthWrite = false;
      mesh.material.transparent = true;
    }
    return mesh;
  };

  K.dispose = function (obj) {
    obj.traverse(function (o) {
      if (o.geometry && !o.geometry.userData.keep) o.geometry.dispose();
      if (o.material) {
        var mats = Array.isArray(o.material) ? o.material : [o.material];
        for (var i = 0; i < mats.length; i++) {
          if (mats[i].map && !mats[i].map.userData.keep) mats[i].map.dispose();
          mats[i].dispose();
        }
      }
    });
  };

  /** 让 2D canvas 画布直接当贴图，做"画上去"的花纹 */
  K.tintColor = function (hex, l) {
    var c = new THREE.Color(hex);
    if (l) c.lerp(new THREE.Color(0xffffff), l);
    return c;
  };

  return K;
};
