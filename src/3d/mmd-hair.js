/**
 * mmd-hair —— 给 MMD（PMX）头发叠加程序化的「动漫发束」几何（ribbon 发片）。
 *
 * 目标：在不改模型、不改材质的条件下，让 02 的头发多一层
 *       ① 层次（独立发片，比原发壳更有体积感）
 *       ② 高光（顶点色画出「天使环」亮带，纯赛璐璐风）
 *       ③ 飘动感（发片直接蒙皮到模型自己的 cf_J_hair* 骨骼上，头发物理怎么摆就怎么动）
 *
 * 做法（不引入新物理）：
 *   1) 从骨架挑出 cf_J_hair* 骨骼，按名字分组（后发中/后发左/后发右/侧长发左/
 *      侧长发右/鬓发左/鬓发右/刘海），每组按世界 Y 从高到低排成一条链
 *      （PMX parentIndex 不可靠，所以按位置排序，不依赖父子链）；
 *   2) 从「头发材质 + 头发蒙皮权重」的顶点里抽出一张头发三角网（局部坐标）；
 *      每条骨骼链上的骨骼都沿「朝外」方向打一条射线，取这条射线上最远的交点
 *      = 头发外表面，发片就贴在表面上（前发组射线偏 +Z，后发组偏径向外侧）；
 *   3) 骨骼链落点 + 往发梢方向延长 20%~40% 得到 CatmullRom 曲线，沿曲线生成
 *      宽带状发片；顶点色做「根部深粉 → 发梢浅粉」渐变 + 中段高光带；
 *   4) 发片按骨骼链蒙皮（skinIndex/skinWeight + 共享 Skeleton/bindMatrix），
 *      所以它就是原模型骨骼动画/头发物理的一部分 —— 不需要每帧更新代码。
 *
 * 用法：
 *   模块内（build.py 的 __def 模块）：
 *     var MMDHair = require("mmd-hair");
 *     var hair = MMDHair.create(THREE).attach(mesh, { density: 2, radius: 0.14 });
 *     // hair.detach() / hair.stats / hair.params
 *   独立页 / 控制台：
 *     var hair = window.MMDHAIR.attach(mesh, { color: "ff9ec4" });   // 自动取 window.THREE
 *
 * 参数（全部可省略）：
 *   density   1|2|3   每条骨骼链生成几条发片（默认 2）
 *   radius    0.14    发片根部半宽（模型身高约 19.7 单位，默认 0.14）
 *   len       1.25    发梢延长系数：延长量 = 链长 × 0.20 × len（默认 1.25 → 25%）
 *   shine     1       高光带强度，0 关闭（默认 1）
 *   color     ff9ec4  桃花粉主色；根部自动压暗、梢部自动提亮
 *   rootColor ""      可选：直接指定根部颜色
 *   tipColor  ""      可选：直接指定梢部颜色
 *   shell     1.00    （射线没打到表面时的）贴壳兜底系数
 *   lift      0.035   从表面往外抬一点，避免 z-fighting / 埋进发壳
 *   thickness 0.55    发片厚度（相对 radius）
 *   width     5       发片横向细分数（顶点数 = width+1）
 *   segments  18      发片纵向采样段数
 *   groups    ""      只生成指定组：backC,backL,backR,sideL,sideR,fringeL,fringeR,bangs
 *   mat       toon    toon | basic（调试用，默认 toon）
 *   variation 1       长度/宽度/角度随机差异（0 关闭）
 *
 * 已知限制见 docs/02-HAIR-GEO.md。
 */
(function (root) {
  "use strict";

  var VERSION = "1.1.0";

  var ALL_GROUPS = [
    "backC", "backL", "backR", "sideL", "sideR", "fringeL", "fringeR", "bangs",
  ];
  // 默认全开：后发三层 + 侧长发 + 鬓发 + 刘海。
  // 鬓发/刘海用更小的 lift/宽度，并且在贴图软边下只读成「发丝高光」，不会糊住脸。
  var DEFAULT_GROUPS = ALL_GROUPS.slice();

  // 骨骼链定义：
  //   kind = "back"  → 发片贴在「后侧/外侧」表面，法线朝外（背面/侧面视角可读）
  //   kind = "front" → 发片贴在「前面」表面，法线偏 +Z（正面视角可读）
  var CHAIN_DEFS = [
    // ray: 贴表面时射线的「径向外扩系数」（0=纯 +Z 正前方，1=纯侧向；前发用中间值绕开脸）
    // wmul: 该组发片宽度系数（避免鬓发/刘海糊住脸）
    { id: "backC", prefix: "cf_J_hairB_", exclude: /_top$/, label: "后发中", kind: "back", ray: 1.00, wmul: 1.00, liftMul: 1.0 },
    { id: "backL", prefix: "cf_J_hairBL_", exclude: /_top$/, label: "后发左", kind: "back", ray: 1.00, wmul: 1.00, liftMul: 1.0 },
    { id: "backR", prefix: "cf_J_hairBR_", exclude: /_top$/, label: "后发右", kind: "back", ray: 1.00, wmul: 1.00, liftMul: 1.0 },
    { id: "sideL", prefix: "cf_J_hairFL_02_", exclude: null, label: "侧长发左", kind: "front", ray: 1.05, wmul: 0.82, liftMul: 6.0 },
    { id: "sideR", prefix: "cf_J_hairFR_02_", exclude: null, label: "侧长发右", kind: "front", ray: 1.05, wmul: 0.82, liftMul: 6.0 },
    { id: "fringeL", prefix: "cf_J_hairFL_01_", exclude: null, label: "鬓发左", kind: "front", ray: 1.30, wmul: 0.60, liftMul: 2.0 },
    { id: "fringeR", prefix: "cf_J_hairFR_01_", exclude: null, label: "鬓发右", kind: "front", ray: 1.30, wmul: 0.60, liftMul: 2.0 },
    { id: "bangs", prefix: "cf_J_hairF_", exclude: /_top$/, label: "刘海", kind: "front", ray: 0.75, wmul: 0.70, liftMul: 1.0 },
  ];

  var DEFAULTS = {
    density: 2,
    radius: 0.08,
    len: 1.25,
    shine: 1,
    color: "ff9fc4",
    rootColor: "",
    tipColor: "",
    shell: 1.0,
    lift: 0.032,
    thickness: 0.65,
    width: 5,
    segments: 18,
    groups: "",
    mat: "basic",
    variation: 1,
    wave: 1,
    twist: 1,
    rayScale: 1,
    softEdge: 0.9,     // 发片两侧用顶点 alpha 融进头发，避免「贴纸边」
    merge: 1,          // 1 = 所有发片合并成一个 SkinnedMesh（省 draw call）
    // 头顶「天使环」高光带
    ring: 0,
    ringY: 0,          // 0 = 自动（头顶往下约 0.85）
    ringH: 0.52,       // 高光带高度
    ringIntensity: 1,
    ringSegments: 48,
  };

  /* ------------------------------------------------------------------ */
  /* 纯工具                                                              */
  /* ------------------------------------------------------------------ */

  function mergeParams(extra) {
    var out = {}, k;
    for (k in DEFAULTS) out[k] = DEFAULTS[k];
    if (extra) for (k in extra) if (extra[k] !== undefined && extra[k] !== null) out[k] = extra[k];
    out.density = Math.max(1, Math.min(3, Math.round(Number(out.density) || 1)));
    out.radius = Math.max(0.01, Number(out.radius) || DEFAULTS.radius);
    out.len = Math.max(0.1, Number(out.len) || DEFAULTS.len);
    out.shine = Math.max(0, Number(out.shine));
    out.width = Math.max(2, Math.min(8, Math.round(Number(out.width) || DEFAULTS.width)));
    out.segments = Math.max(6, Math.min(64, Math.round(Number(out.segments) || DEFAULTS.segments)));
    out.shell = Math.max(0.5, Number(out.shell) || 1);
    out.lift = Number(out.lift) || 0;
    out.thickness = Math.max(0, Number(out.thickness) || 0);
    out.variation = Math.max(0, Number(out.variation) || 0);
    out.wave = Math.max(0, Number(out.wave) || 0);
    out.twist = Math.max(0, Number(out.twist) || 0);
    out.rayScale = Math.max(0.2, Number(out.rayScale) || 1);
    out.softEdge = Math.max(0, Math.min(1, Number(out.softEdge) || 0));
    out.merge = Number(out.merge) === 0 ? 0 : 1;
    out.ring = Math.max(0, Math.min(1, Number(out.ring) || 0));
    out.ringY = Number(out.ringY) || 0;
    out.ringH = Math.max(0.1, Number(out.ringH) || 0.52);
    out.ringIntensity = Math.max(0, Number(out.ringIntensity));
    out.ringSegments = Math.max(16, Math.min(96, Math.round(Number(out.ringSegments) || 48)));
    return out;
  }

  function hexColor(THREE, s, fallback) {
    try {
      if (s) return new THREE.Color(String(s).charAt(0) === "#" ? String(s) : "#" + String(s));
    } catch (e) {}
    return fallback ? fallback.clone() : new THREE.Color(1, 1, 1);
  }

  function groupList(param) {
    if (!param) return DEFAULT_GROUPS.slice();
    var set = Object.create(null);
    if (String(param).trim() === "all") return ALL_GROUPS.slice();
    String(param).split(",").forEach(function (s) { s = s.trim(); if (s) set[s] = true; });
    return ALL_GROUPS.filter(function (id) { return set[id]; });
  }

  // 确定性伪随机（同一条链/同一层每次生成结果一样）
  function hash01(str, salt) {
    var h = 2166136261 ^ (salt || 0);
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    h ^= h >>> 13;
    h = Math.imul(h, 2246822519);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }

  /* ------------------------------------------------------------------ */
  /* 主入口                                                              */
  /* ------------------------------------------------------------------ */

  function create(THREE) {
    if (!THREE) throw new Error("[mmd-hair] 缺少 THREE");

    var state = {
      mesh: null, params: null, group: null,
      strands: [], materials: [], hull: null, surface: null, palette: null, ring: null, strandMesh: null,
    };

    /* ---------------------- 1) 头发顶点云（模型局部坐标） ---------------------- */
    // 优先用「材质贴图是 hair.png」的三角形；拿不到就退回「权重绑在 cf_J_hair* 上」的顶点。
    // 返回三角形汤 Float32Array（每 3 个顶点一组），局部坐标。
    function collectHairCloud(mesh) {
      var geo = mesh.geometry;
      if (!geo || !geo.attributes || !geo.attributes.position) return null;
      var pos = geo.attributes.position;
      var idx = geo.index;
      var out = [];
      var v = new THREE.Vector3();

      var mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      var hairMat = Object.create(null);
      var hasHairMat = false;
      for (var mi = 0; mi < mats.length; mi++) {
        var m = mats[mi];
        var src = (m && m.map && m.map.image && (m.map.image.src || "")) || "";
        if (/(^|\/)hair[^\/]*\.(png|jpe?g|bmp|tga)$/i.test(src)) {
          hairMat[mi] = true;
          hasHairMat = true;
        }
      }

      var groups = geo.groups || [];
      if (hasHairMat && groups.length) {
        for (var gi = 0; gi < groups.length; gi++) {
          var g = groups[gi];
          if (!hairMat[g.materialIndex]) continue;
          var end = g.start + g.count;
          for (var t = g.start; t < end; t++) {
            var vi = idx ? idx.getX(t) : t;
            v.fromBufferAttribute(pos, vi);
            out.push(v.x, v.y, v.z);
          }
        }
        return out.length ? new Float32Array(out) : null;
      }

      // 退路：按蒙皮权重找头发顶点（三角形汤需要 index，否则退化成点云）
      var si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight;
      if (!si || !sw || !mesh.skeleton) return null;
      var hairBone = Object.create(null);
      for (var bi = 0; bi < mesh.skeleton.bones.length; bi++) {
        if (/^cf_J_hair/.test(mesh.skeleton.bones[bi].name)) hairBone[bi] = true;
      }
      var trips = [];
      var count = idx ? idx.count : pos.count;
      for (var ti = 0; ti < count; ti++) {
        var id = idx ? idx.getX(ti) : ti;
        var w = 0;
        for (var k = 0; k < 4; k++) {
          var b = si.getComponent(id, k);
          if (!hairBone[b]) continue;
          w += sw.getComponent(id, k);
        }
        trips.push(w > 0.5 ? 1 : 0);
      }
      for (var t2 = 0; t2 + 2 < count; t2 += 3) {
        if (!(trips[t2] && trips[t2 + 1] && trips[t2 + 2])) continue;
        for (var q = 0; q < 3; q++) {
          var id2 = idx ? idx.getX(t2 + q) : (t2 + q);
          v.fromBufferAttribute(pos, id2);
          out.push(v.x, v.y, v.z);
        }
      }
      return out.length ? new Float32Array(out) : null;
    }

    /* ---------------------- 2) 头发表面代理（射线求外表面） ---------------------- */
    function buildSurface(cloud) {
      if (!cloud || cloud.length < 9) return null;
      var geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(cloud, 3));
      geo.computeBoundingSphere();
      var mat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
      var proxy = new THREE.Mesh(geo, mat);
      proxy.name = "mmd-hair-surface";
      // 不进场景，matrixWorld = 单位矩阵，交点即模型局部坐标
      proxy.updateMatrixWorld(true);
      var ray = new THREE.Raycaster();
      ray.far = 60;
      var dirTmp = new THREE.Vector3();

      // 从 origin 沿 dir 打一条射线，取最远的交点 = 该方向上头发最外层表面
      function outermost(origin, dir) {
        ray.set(origin, dirTmp.copy(dir).normalize());
        var hits = ray.intersectObject(proxy, false);
        if (!hits || !hits.length) return null;
        var h = hits[hits.length - 1];
        var n = h.face ? h.face.normal.clone() : dirTmp.clone().negate();
        // 法线朝外（与射线方向同侧）
        if (n.dot(dirTmp) < 0) n.negate();
        n.normalize();
        return { point: h.point.clone(), normal: n, distance: h.distance, hits: hits.length };
      }

      return {
        proxy: proxy,
        outermost: outermost,
        dispose: function () {
          try { geo.dispose(); mat.dispose(); } catch (e) {}
        },
      };
    }

    /* ---------------------- 3) 兜底外轮廓表（射线打空时用） ---------------------- */
    function buildHull(cloud) {
      var n = cloud.length / 3;
      if (!n) return null;
      var minY = Infinity, maxY = -Infinity;
      var i, x, y, z;
      for (i = 0; i < n; i++) {
        y = cloud[i * 3 + 1];
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      if (!(maxY > minY)) return null;
      var yTop = maxY - (maxY - minY) * 0.15;
      var sx = 0, sz = 0, tn = 0;
      for (i = 0; i < n; i++) {
        y = cloud[i * 3 + 1];
        if (y < yTop) continue;
        sx += cloud[i * 3];
        sz += cloud[i * 3 + 2];
        tn++;
      }
      var cx = tn ? sx / tn : 0;
      var cz = tn ? sz / tn : 0;
      var NY = 44, NA = 48;
      var stepY = (maxY - minY) / NY;
      var grid = new Float32Array(NY * NA);
      var TAU = Math.PI * 2;
      for (i = 0; i < n; i++) {
        x = cloud[i * 3]; y = cloud[i * 3 + 1]; z = cloud[i * 3 + 2];
        var dx = x - cx, dz = z - cz;
        var r = Math.sqrt(dx * dx + dz * dz);
        if (r < 1e-5) continue;
        var iy = Math.floor((y - minY) / stepY);
        if (iy < 0) iy = 0; else if (iy >= NY) iy = NY - 1;
        var ia = Math.floor((Math.atan2(dz, dx) + Math.PI) / TAU * NA);
        if (ia < 0) ia = 0; else if (ia >= NA) ia = NA - 1;
        var cell = iy * NA + ia;
        if (r > grid[cell]) grid[cell] = r;
      }
      function radiusAt(y, ang) {
        if (y < minY) y = minY;
        if (y > maxY) y = maxY;
        var iy = Math.floor((y - minY) / stepY);
        if (iy < 0) iy = 0; else if (iy >= NY) iy = NY - 1;
        var ia = Math.floor((ang + Math.PI) / TAU * NA);
        if (ia < 0) ia = 0; else if (ia >= NA) ia = NA - 1;
        for (var dy = 0; dy <= 2; dy++) {
          for (var dd = 0; dd <= 10; dd++) {
            for (var sgn = 0; sgn < (dd === 0 ? 1 : 2); sgn++) {
              var iy2 = iy + (dy === 0 ? 0 : (sgn ? dy : -dy));
              var ia2 = ia + (dd === 0 ? 0 : (sgn ? dd : -dd));
              if (iy2 < 0 || iy2 >= NY) continue;
              ia2 = ((ia2 % NA) + NA) % NA;
              var v = grid[iy2 * NA + ia2];
              if (v > 0) return v;
            }
          }
        }
        return 0;
      }
      return { minY: minY, maxY: maxY, cx: cx, cz: cz, points: n, radiusAt: radiusAt };
    }

    /* ---------------------- 4) 骨骼链 ---------------------- */
    function collectChains(mesh, invWorld) {
      var skeleton = mesh.skeleton;
      if (!skeleton || !skeleton.bones) return [];
      var hb = [];
      for (var i = 0; i < skeleton.bones.length; i++) {
        var b = skeleton.bones[i];
        if (!/^cf_J_hair/.test(b.name)) continue;
        if (/_top$/.test(b.name)) continue;
        var wp = new THREE.Vector3();
        b.getWorldPosition(wp);
        var lp = wp.applyMatrix4(invWorld);
        hb.push({ name: b.name, bone: b, index: i, local: lp });
      }
      var chains = [];
      for (var d = 0; d < CHAIN_DEFS.length; d++) {
        var def = CHAIN_DEFS[d];
        var list = hb.filter(function (it) {
          return it.name.indexOf(def.prefix) === 0 && !(def.exclude && def.exclude.test(it.name));
        });
        if (list.length < 2) continue;
        // 按世界 Y 从高到低 = 从发根到发梢（parentIndex 不可靠，只能这样排）
        list.sort(function (a, b) { return b.local.y - a.local.y; });
        chains.push({ def: def, bones: list });
      }
      return chains;
    }

    /* ---------------------- 5) 调色板 ---------------------- */
    function makePalette(P) {
      var base = hexColor(THREE, P.color, new THREE.Color(0xff8fbb));
      var hsl = { h: 0.93, s: 0.8, l: 0.7 };
      try { base.getHSL(hsl); } catch (e) {}
      var root = P.rootColor ? hexColor(THREE, P.rootColor, null) :
        new THREE.Color().setHSL(hsl.h, Math.min(1, hsl.s * 1.12), 0.33);
      var tip = P.tipColor ? hexColor(THREE, P.tipColor, null) :
        new THREE.Color().setHSL(hsl.h, hsl.s * 0.78, 0.855);
      return { base: base, root: root, tip: tip, shine: new THREE.Color(1, 0.97, 0.99) };
    }

    /* ---------------------- 6) 材质 ---------------------- */
    function makeMaterial(P) {
      var mat;
      if (P.mat === "basic") {
        mat = new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true, side: THREE.DoubleSide });
      } else {
        var steps = new Uint8Array([92, 148, 205, 255]);
        var data = new Uint8Array(steps.length * 4);
        for (var i = 0; i < steps.length; i++) {
          data[i * 4] = steps[i]; data[i * 4 + 1] = steps[i];
          data[i * 4 + 2] = steps[i]; data[i * 4 + 3] = 255;
        }
        var tex = new THREE.DataTexture(data, steps.length, 1, THREE.RGBAFormat);
        tex.minFilter = THREE.NearestFilter;
        tex.magFilter = THREE.NearestFilter;
        tex.generateMipmaps = false;
        tex.needsUpdate = true;
        mat = new THREE.MeshToonMaterial({
          color: 0xffffff, vertexColors: true, side: THREE.DoubleSide, gradientMap: tex,
        });
        mat.userData.mmdHairGradient = tex;
      }
      // 软边：透明 + 不写深度，两侧顶点 alpha 渐隐进头发
      if (P.softEdge > 0) {
        mat.transparent = true;
        mat.depthWrite = false;
        mat.alphaTest = 0;
      }
      mat.name = "mmd-hair-strand";
      return mat;
    }

    /* ---------------------- 7) 单条发片 ---------------------- */
    function buildStrand(bones, hull, surface, P, palette, def, layer, layerCount) {
      if (bones.length < 2) return null;
      var cx = hull ? hull.cx : 0, cz = hull ? hull.cz : 0.6;
      var i, j, s;
      var isBack = def.kind === "back";
      var vary = P.variation;

      // 每条链/每层来一点确定性差异，免得所有发片一模一样的机器感
      var rndW = 1 + (hash01(def.id, layer * 17 + 3) - 0.5) * 0.36 * vary;
      var rndL = 1 + (hash01(def.id, layer * 31 + 7) - 0.5) * 0.30 * vary;
      var rndA = (hash01(def.id, layer * 53 + 11) - 0.5) * 0.30 * vary;

      function radialOf(p) {
        var dx = p.x - cx, dz = p.z - cz;
        var l = Math.sqrt(dx * dx + dz * dz);
        if (l < 0.02) return new THREE.Vector3(0, 0, 1);
        return new THREE.Vector3(dx / l, 0, dz / l);
      }

      // 射线方向：前发朝 +Z（带一点外侧，避免所有发片挤到正中间），后发朝径向外侧
      var rayFactor = (def.ray == null ? (isBack ? 1 : 0.55) : def.ray) * P.rayScale;
      var widthMul = def.wmul == null ? 1 : def.wmul;
      var liftMul = def.liftMul == null ? 1 : def.liftMul;
      var lift = P.lift * liftMul;
      function rayDir(boneLocal) {
        var rad = radialOf(boneLocal);
        var d;
        if (isBack) {
          d = rad.clone().multiplyScalar(rayFactor).add(new THREE.Vector3(0, -0.12, 0));
        } else {
          d = rad.clone().multiplyScalar(rayFactor).add(new THREE.Vector3(0, 0, 1));
        }
        return d.normalize();
      }

      function placeAt(boneLocal) {
        var dir = rayDir(boneLocal);
        var hit = surface ? surface.outermost(boneLocal, dir) : null;
        if (hit) {
          var p = hit.point.clone().addScaledVector(hit.normal, lift);
          var n = hit.normal.clone();
          if (!isBack) {
            // 前发：法线再往镜头方向压一点，正面看在屏幕上的投影更宽（更像动画发片）
            n.add(new THREE.Vector3(0, 0, 0.85)).normalize();
          }
          return { p: p, n: n, via: "ray" };
        }
        // 兜底：贴外轮廓壳
        var rad = radialOf(boneLocal);
        var r = hull ? hull.radiusAt(boneLocal.y, Math.atan2(rad.z, rad.x)) : 1.0;
        if (!(r > 0.05)) r = 1.0;
        var rr = r * P.shell + lift;
        return {
          p: new THREE.Vector3(cx + rad.x * rr, boneLocal.y, cz + rad.z * rr),
          n: rad.clone(), via: "hull",
        };
      }

      // --- 7.1 骨骼落点 ---
      var placedP = [], placedN = [], via = {};
      for (i = 0; i < bones.length; i++) {
        var res = placeAt(bones[i].local);
        placedP.push(res.p);
        placedN.push(res.n);
        via[res.via] = (via[res.via] || 0) + 1;
      }

      // 密度 >1 时，把同一条链的发片沿横向错开一点（中段分开、两端收拢）
      var laneOff = 0;
      if (layerCount > 1) laneOff = P.radius * 2.1 * (layer - (layerCount - 1) / 2);

      // --- 7.2 发根延长：沿链条反方向、仍然贴表面往上补一段，藏进头发里 ---
      var upDir = placedP[0].clone().sub(placedP[1]);
      var seg0 = upDir.length();
      var ctrlP = [], ctrlN = [];
      if (seg0 > 1e-4) {
        upDir.multiplyScalar(1 / seg0);
        var preDist = seg0 * 0.55;
        var virtualBone = bones[0].local.clone().addScaledVector(upDir, preDist);
        var rootRes = placeAt(virtualBone);
        // 根部如果射线打空（在头发外面），就按链条方向直接往上延
        if (rootRes.via === "ray") {
          ctrlP.push(rootRes.p);
          ctrlN.push(rootRes.n);
        } else {
          ctrlP.push(placedP[0].clone().addScaledVector(upDir, preDist));
          ctrlN.push(placedN[0].clone());
        }
      } else {
        ctrlP.push(placedP[0].clone());
        ctrlN.push(placedN[0].clone());
      }
      for (i = 0; i < placedP.length; i++) { ctrlP.push(placedP[i]); ctrlN.push(placedN[i]); }

      // --- 7.3 发梢延长：延长量 = 链长 × 0.20 × len ---
      var chainLen = 0;
      for (i = 1; i < placedP.length; i++) chainLen += placedP[i].distanceTo(placedP[i - 1]);
      // 发梢延长：链长 × 0.16 × len（默认 1.25 → 链长的 20% 左右）
      var extLen = chainLen * 0.16 * P.len * rndL;
      if (extLen > 0.02) {
        var last = placedP[placedP.length - 1];
        var prev = placedP[placedP.length - 2];
        var tipDir = last.clone().sub(prev);
        var tl = tipDir.length();
        if (tl < 1e-4) tipDir.set(0, -1, 0); else tipDir.multiplyScalar(1 / tl);
        // 每条发片的发梢再随机甩开一点（确定性），避免所有发梢方向一模一样
        if (vary > 0 && rndA) {
          var yawQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rndA);
          tipDir.applyQuaternion(yawQ);
        }
        var lastN = placedN[placedN.length - 1];
        var outDir = radialOf(last);
        var tipSteps = 4;
        var down = new THREE.Vector3(0, -1, 0);
        for (s = 1; s <= tipSteps; s++) {
          var tt = s / tipSteps;
          // 越到梢部越受重力（往下垂），并轻微外飘，避免发梢像直线针
          var dir = tipDir.clone().lerp(down, 0.28 * tt).normalize();
          var p = last.clone().addScaledVector(dir, extLen * tt);
          p.addScaledVector(outDir, extLen * 0.055 * tt * tt);
          var n = lastN.clone().lerp(isBack ? outDir : new THREE.Vector3(0, 0, 1), 0.35 * tt).normalize();
          ctrlP.push(p);
          ctrlN.push(n);
        }
      }

      var ctrlCount = ctrlP.length;
      var curve = new THREE.CatmullRomCurve3(ctrlP, false, "catmullrom", 0.5);

      // 控制点 → 骨骼 映射：ctrl[0]=根部延长点，ctrl[1..M]=骨骼，ctrl[M+1..]=发梢延长
      var boneOfCtrl = function (c) {
        if (c <= 1) return 0;
        if (c >= bones.length + 1) return bones.length - 1;
        return c - 1;
      };
      var normalAtCtrl = function (c) {
        var c0 = Math.max(0, Math.min(ctrlCount - 1, Math.floor(c)));
        var c1 = Math.max(0, Math.min(ctrlCount - 1, c0 + 1));
        var f = c - c0;
        var n = ctrlN[c0].clone().lerp(ctrlN[c1], f);
        return n;
      };

      var N = P.segments;
      var W = P.width;
      var vertsPerRing = W + 1;
      var vcount = (N + 1) * vertsPerRing;
      var posArr = new Float32Array(vcount * 3);
      var nrmArr = new Float32Array(vcount * 3);
      var colArr = new Float32Array(vcount * 4);
      var uvArr = new Float32Array(vcount * 2);
      var skinIdx = new Uint16Array(vcount * 4);
      var skinW = new Float32Array(vcount * 4);
      var indices = [];

      var tmpColor = new THREE.Color();
      var tmpV = new THREE.Vector3();
      var tmpRad = new THREE.Vector3();
      var tmpLat = new THREE.Vector3();
      var tmpN = new THREE.Vector3();
      var lastRad = radialOf(placedP[placedP.length - 1]);

      for (s = 0; s <= N; s++) {
        var u = s / N;
        var pos = curve.getPoint(u);
        var tan = curve.getTangent(u);
        if (tan.lengthSq() < 1e-10) tan.set(0, -1, 0); else tan.normalize();

        // 发片法线：沿曲线插值控制点法线，再剔掉切线分量
        var cposN = u * (ctrlCount - 1);
        tmpN.copy(normalAtCtrl(cposN));
        tmpN.addScaledVector(tan, -tmpN.dot(tan));   // 正交化
        if (tmpN.lengthSq() < 1e-8) tmpN.copy(lastRad);
        tmpN.normalize();

        // 侧向 = 切线 × 法线
        tmpLat.crossVectors(tan, tmpN);
        if (tmpLat.lengthSq() < 1e-10) tmpLat.set(1, 0, 0); else tmpLat.normalize();

        // 多条发片时横向错开，两端收拢（不然发根会分叉）
        if (laneOff) pos.addScaledVector(tmpLat, laneOff * Math.sin(Math.PI * u));

        // 发丝「波浪」：沿长度做一点横向摆动，越靠发梢越明显（避免发片像直尺）
        if (P.wave > 0) {
          var wavePhase = hash01(def.id, layer * 91 + 2) * Math.PI * 2;
          var waveAmp = P.radius * widthMul * 0.85 * P.wave * Math.pow(u, 0.8);
          pos.addScaledVector(tmpLat, Math.sin(u * Math.PI * 2.2 + wavePhase) * waveAmp);
          pos.addScaledVector(tmpN, Math.cos(u * Math.PI * 1.7 + wavePhase) * waveAmp * 0.35);
        }

        // 发片沿长度的微扭转（让高光/明暗随长度变化，更有体积）
        if (P.twist > 0) {
          var twistAng = (u - 0.5) * P.twist * 0.55;
          var tq = new THREE.Quaternion().setFromAxisAngle(tan, twistAng);
          tmpN.applyQuaternion(tq);
          tmpLat.applyQuaternion(tq);
        }

        // 宽度：发根细（藏在头发里）→ 中段最宽 → 发梢收尖，像真实发绺而不是长条
        var wprof = 0.52 + 0.92 * Math.sin(Math.PI * Math.pow(u, 0.72)) - 0.36 * u * u;
        if (wprof < 0.05) wprof = 0.05;
        var halfW = P.radius * rndW * widthMul * wprof;
        if (halfW < P.radius * widthMul * 0.02) halfW = P.radius * widthMul * 0.02;

        // 蒙皮权重
        var cpos = u * (ctrlCount - 1);
        var c0 = Math.min(ctrlCount - 1, Math.floor(cpos));
        var c1 = Math.min(ctrlCount - 1, c0 + 1);
        var f = cpos - c0;
        var b0 = boneOfCtrl(c0), b1 = boneOfCtrl(c1);
        var bi0 = bones[b0].index, bi1 = bones[b1].index;

        // 顶点色：根 → 梢渐变 + 侧边压暗 + 中段「天使环」高光
        tmpColor.copy(palette.root).lerp(palette.tip, Math.pow(u, 0.85));

        for (j = 0; j <= W; j++) {
          var w = j / W;
          var uu = w - 0.5;
          tmpV.copy(pos);
          if (halfW > 0) tmpV.addScaledVector(tmpLat, uu * 2 * halfW);
          // 横截面做出一点厚度（中间鼓、两边收）
          if (P.thickness > 0) {
            tmpV.addScaledVector(tmpN, P.radius * P.thickness * 0.9 * (1 - 4 * uu * uu));
          }
          // 发根往头发里沉：浮起的发片也能从发团里「长」出来，而不是凭空出现
          if (u < 0.34) {
            var sink = Math.max(P.radius * 0.5, lift * 1.45) * Math.pow(1 - u / 0.34, 1.4);
            tmpV.addScaledVector(tmpN, -sink);
          }
          var vi = s * vertsPerRing + j;
          posArr[vi * 3] = tmpV.x;
          posArr[vi * 3 + 1] = tmpV.y;
          posArr[vi * 3 + 2] = tmpV.z;

          var nx2 = tmpN.x + tmpLat.x * (uu * 1.7);
          var ny2 = tmpN.y + tmpLat.y * (uu * 1.7);
          var nz2 = tmpN.z + tmpLat.z * (uu * 1.7);
          var nl = Math.sqrt(nx2 * nx2 + ny2 * ny2 + nz2 * nz2) || 1;
          nrmArr[vi * 3] = nx2 / nl;
          nrmArr[vi * 3 + 1] = ny2 / nl;
          nrmArr[vi * 3 + 2] = nz2 / nl;

          // 顶点法线（用于烘焙明暗）
          var nvx = tmpN.x + tmpLat.x * (uu * 1.7);
          var nvy = tmpN.y + tmpLat.y * (uu * 1.7);
          var nvz = tmpN.z + tmpLat.z * (uu * 1.7);
          var nvl = Math.sqrt(nvx * nvx + nvy * nvy + nvz * nvz) || 1;
          nvx /= nvl; nvy /= nvl; nvz /= nvl;

          // 烘焙两层：主光（左上偏前）+ 侧边压暗。unlit 材质也能有赛璐璐体积感
          var lit = nvx * 0.34 + nvy * 0.52 + nvz * 0.78;
          if (lit < 0) lit = 0;
          var shade = 0.66 + 0.46 * lit;
          // 横向细条纹：把一条发片读成「几缕头发」，而不是一张纸
          var groove = 1 - 0.075 * (0.5 + 0.5 * Math.cos(uu * 11.0));
          var edge = (1 - 0.26 * Math.pow(Math.abs(uu) * 2, 1.35)) * shade * groove;
          var cr = tmpColor.r * edge, cg = tmpColor.g * edge, cb = tmpColor.b * edge;
          if (P.shine > 0) {
            var bandT = Math.exp(-Math.pow((u - 0.28) / 0.15, 2)) +
              0.6 * Math.exp(-Math.pow((u - 0.55) / 0.13, 2));
            var bandU = Math.exp(-Math.pow(uu / 0.26, 2));
            var kk = P.shine * 0.62 * bandT * bandU;
            if (kk > 0.001) {
              if (kk > 1) kk = 1;
              cr += (palette.shine.r - cr) * kk;
              cg += (palette.shine.g - cg) * kk;
              cb += (palette.shine.b - cb) * kk;
            }
          }
          colArr[vi * 4] = cr;
          colArr[vi * 4 + 1] = cg;
          colArr[vi * 4 + 2] = cb;
          // 两侧渐隐：middle=1 → 边缘 = 1-softEdge
          var edgeFade = 1 - P.softEdge * Math.pow(Math.abs(uu) * 2, 1.6);
          if (edgeFade < 0) edgeFade = 0;
          colArr[vi * 4 + 3] = edgeFade;

          uvArr[vi * 2] = u;
          uvArr[vi * 2 + 1] = w;

          skinIdx[vi * 4] = bi0;
          skinIdx[vi * 4 + 1] = bi1;
          if (bi0 === bi1) {
            skinW[vi * 4] = 1; skinW[vi * 4 + 1] = 0;
          } else {
            skinW[vi * 4] = 1 - f; skinW[vi * 4 + 1] = f;
          }
        }
      }

      for (s = 0; s < N; s++) {
        for (j = 0; j < W; j++) {
          var a = s * vertsPerRing + j;
          var b = a + 1;
          var c = a + vertsPerRing;
          var d = c + 1;
          indices.push(a, c, b, b, c, d);
        }
      }

      var geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(posArr, 3));
      geo.setAttribute("normal", new THREE.BufferAttribute(nrmArr, 3));
      geo.setAttribute("color", new THREE.BufferAttribute(colArr, 4));
      geo.setAttribute("uv", new THREE.BufferAttribute(uvArr, 2));
      geo.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(skinIdx, 4));
      geo.setAttribute("skinWeight", new THREE.Float32BufferAttribute(skinW, 4));
      geo.setIndex(indices);
      geo.computeBoundingSphere();

      return { geometry: geo, chainLen: chainLen, extLen: extLen, boneCount: bones.length, via: via };
    }

    /* ---------------------- 7.5) 头顶高光带（天使环） ---------------------- */
    // 沿头发表面绕一圈，用顶点色 + alpha 画一条亮粉高光带；蒙皮到頭骨骼，跟着头转。
    function buildRing(mesh, hull, surface, P, palette) {
      if (!surface || !hull) return null;
      var skeleton = mesh.skeleton;
      var headIdx = -1, headBone = null;
      for (var i = 0; i < skeleton.bones.length; i++) {
        var n = skeleton.bones[i].name;
        if (n === "頭" || n === "头" || /^head$/i.test(n) || /^cf_J_Head/i.test(n)) {
          headIdx = i; headBone = skeleton.bones[i]; break;
        }
      }
      if (headIdx < 0) return null;
      var cx = hull.cx, cz = hull.cz;
      var ringY = P.ringY > 0 ? P.ringY : (hull.maxY - 0.85);
      var halfH = P.ringH * 0.5;
      var seg = P.ringSegments;
      var rows = 3;
      var pts = [], dir = new THREE.Vector3(), origin = new THREE.Vector3();
      var r, a, k;
      for (r = 0; r < rows; r++) {
        var yy = ringY + (r - 1) * halfH;
        var row = [];
        for (a = 0; a < seg; a++) {
          var ang = a / seg * Math.PI * 2;          // 0 = +Z 正前方
          dir.set(Math.sin(ang), 0, Math.cos(ang));
          origin.set(cx, yy, cz);
          var hit = surface.outermost(origin, dir);
          var pt;
          if (hit) {
            pt = hit.point.clone().addScaledVector(hit.normal, 0.05);
          } else {
            var rr = hull.radiusAt(yy, Math.atan2(dir.z, dir.x)) || 1.2;
            pt = new THREE.Vector3(cx + dir.x * rr, yy, cz + dir.z * rr);
          }
          row.push(pt);
        }
        pts.push(row);
      }
      // 射线会穿过不同发片，交点会有小锯齿：沿圆周轻度平滑
      for (r = 0; r < rows; r++) {
        for (var t = 0; t < 3; t++) {
          var row2 = pts[r];
          for (k = 0; k < seg; k++) {
            var c0 = row2[k].clone();
            c0.multiplyScalar(0.5)
              .addScaledVector(row2[(k + 1) % seg], 0.25)
              .addScaledVector(row2[(k + seg - 1) % seg], 0.25);
            row2[k].copy(c0);
          }
        }
      }

      var vcount = rows * seg;
      var posArr = new Float32Array(vcount * 3);
      var colArr = new Float32Array(vcount * 4);    // RGBA：顶点 alpha 做柔和边缘
      var ski = new Uint16Array(vcount * 4);
      var skw = new Float32Array(vcount * 4);
      var indices = [];
      var tint = palette.shine.clone().lerp(palette.tip, 0.78);
      var prof = [0.10, 1.0, 0.10];
      for (r = 0; r < rows; r++) {
        for (a = 0; a < seg; a++) {
          var vi = r * seg + a;
          var p = pts[r][a];
          posArr[vi * 3] = p.x; posArr[vi * 3 + 1] = p.y; posArr[vi * 3 + 2] = p.z;
          // 圆周方向做断续感：像画上去的高光，而不是一条灯带
          var aa = a / seg * Math.PI * 2;
          var scallop = 0.62 + 0.38 * Math.pow(Math.max(0, Math.sin(aa * 9.0 + 0.6)), 0.5);
          var alpha = 0.82 * P.ringIntensity * prof[r] * scallop;
          var bright = 0.86 + 0.14 * prof[r];
          colArr[vi * 4] = tint.r * bright;
          colArr[vi * 4 + 1] = tint.g * bright;
          colArr[vi * 4 + 2] = tint.b * bright;
          colArr[vi * 4 + 3] = Math.min(1, alpha);
          ski[vi * 4] = headIdx;
          ski[vi * 4 + 1] = 0; ski[vi * 4 + 2] = 0; ski[vi * 4 + 3] = 0;
          skw[vi * 4] = 1;
          skw[vi * 4 + 1] = 0; skw[vi * 4 + 2] = 0; skw[vi * 4 + 3] = 0;
        }
      }
      for (r = 0; r < rows - 1; r++) {
        for (k = 0; k < seg; k++) {
          var k1 = (k + 1) % seg;
          var A = r * seg + k, B = r * seg + k1;
          var C = (r + 1) * seg + k, D = (r + 1) * seg + k1;
          indices.push(A, C, B, B, C, D);
        }
      }
      var geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(posArr, 3));
      geo.setAttribute("color", new THREE.BufferAttribute(colArr, 4));
      geo.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(ski, 4));
      geo.setAttribute("skinWeight", new THREE.Float32BufferAttribute(skw, 4));
      geo.setIndex(indices);
      geo.computeBoundingSphere();
      var mat = new THREE.MeshBasicMaterial({
        vertexColors: true, transparent: true, depthWrite: false,
        side: THREE.DoubleSide, toneMapped: false,
      });
      mat.name = "mmd-hair-ring";
      return {
        geometry: geo, material: mat,
        info: { y: +ringY.toFixed(2), height: P.ringH, bone: headBone.name },
      };
    }

    /* ---------------------- 7.6) 发片合并（省 draw call） ---------------------- */
    // 所有发片共用同一个材质，把几何拼成一个 SkinnedMesh：17 个 mesh → 1 个。
    function mergeStrandGeometries(list) {
      var vTotal = 0, iTotal = 0, i, g;
      for (i = 0; i < list.length; i++) {
        g = list[i];
        vTotal += g.attributes.position.count;
        iTotal += g.index.count;
      }
      var pos = new Float32Array(vTotal * 3);
      var nrm = new Float32Array(vTotal * 3);
      var col = new Float32Array(vTotal * 4);
      var uv = new Float32Array(vTotal * 2);
      var ski = new Uint16Array(vTotal * 4);
      var skw = new Float32Array(vTotal * 4);
      var idx = vTotal > 65535 ? new Uint32Array(iTotal) : new Uint16Array(iTotal);
      var vo = 0, io = 0;
      for (i = 0; i < list.length; i++) {
        g = list[i];
        var n = g.attributes.position.count;
        pos.set(g.attributes.position.array, vo * 3);
        nrm.set(g.attributes.normal.array, vo * 3);
        col.set(g.attributes.color.array, vo * 4);
        uv.set(g.attributes.uv.array, vo * 2);
        ski.set(g.attributes.skinIndex.array, vo * 4);
        skw.set(g.attributes.skinWeight.array, vo * 4);
        var gi = g.index.array;
        for (var k = 0; k < gi.length; k++) idx[io++] = gi[k] + vo;
        vo += n;
      }
      var geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      geo.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
      geo.setAttribute("color", new THREE.BufferAttribute(col, 4));
      geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
      geo.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(ski, 4));
      geo.setAttribute("skinWeight", new THREE.Float32BufferAttribute(skw, 4));
      geo.setIndex(new THREE.BufferAttribute(idx, 1));
      geo.computeBoundingSphere();
      return geo;
    }

    /* ---------------------- 8) attach / detach ---------------------- */
    function detach() {
      if (state.group && state.group.parent) state.group.parent.remove(state.group);
      for (var i = 0; i < state.strands.length; i++) {
        try { state.strands[i].mesh.geometry.dispose(); } catch (e) {}
      }
      for (var m = 0; m < state.materials.length; m++) {
        var mat = state.materials[m];
        try {
          if (mat.userData && mat.userData.mmdHairGradient) mat.userData.mmdHairGradient.dispose();
          mat.dispose();
        } catch (e) {}
      }
      if (state.surface) { try { state.surface.dispose(); } catch (e) {} }
      state.mesh = null; state.group = null; state.strands = [];
      state.materials = []; state.hull = null; state.surface = null;
      state.palette = null; state.stats = null; state.ring = null;
      return api;
    }

    function attach(mesh, params) {
      detach();
      if (!mesh || !mesh.isSkinnedMesh || !mesh.skeleton) {
        throw new Error("[mmd-hair] 需要一个带 skeleton 的 SkinnedMesh");
      }
      var P = mergeParams(params);
      state.mesh = mesh;
      state.params = P;

      mesh.updateMatrixWorld(true);
      var invWorld = new THREE.Matrix4().copy(mesh.matrixWorld).invert();

      var cloud = collectHairCloud(mesh);
      var hull = buildHull(cloud);
      var surface = buildSurface(cloud);
      var chains = collectChains(mesh, invWorld);
      state.hull = hull;
      state.surface = surface;
      if (!hull) {
        console.warn("[mmd-hair] 没统计到头发表面（顶点云为空），跳过叠加");
        state.stats = { strands: 0, chains: 0, reason: "no-hair-cloud" };
        return api;
      }
      var palette = makePalette(P);
      state.palette = palette;

      var mat = makeMaterial(P);
      state.materials.push(mat);

      var want = groupList(P.groups);
      var group = new THREE.Group();
      group.name = "mmd-hair";
      var made = 0, chainInfo = [];
      var strandGeos = [];
      for (var ci = 0; ci < chains.length; ci++) {
        var chain = chains[ci];
        if (want.indexOf(chain.def.id) < 0) continue;
        var built = 0, viaAll = {};
        for (var L = 0; L < P.density; L++) {
          var res = buildStrand(chain.bones, hull, surface, P, palette, chain.def, L, P.density);
          if (!res) continue;
          state.strands.push({
            mesh: null, chain: chain.def.id, layer: L,
            boneCount: res.boneCount, chainLen: res.chainLen, extLen: res.extLen, via: res.via,
          });
          strandGeos.push(res.geometry);
          for (var vk in res.via) viaAll[vk] = (viaAll[vk] || 0) + res.via[vk];
          made++; built++;
        }
        chainInfo.push({
          id: chain.def.id, label: chain.def.label, kind: chain.def.kind,
          bones: chain.bones.length, strands: built, via: viaAll,
        });
      }
      // 发片：默认合并成一个 SkinnedMesh（1 个 draw call）
      var strandMesh = null;
      if (strandGeos.length) {
        var mergedGeo = P.merge ? mergeStrandGeometries(strandGeos) : null;
        if (P.merge) for (var gd = 0; gd < strandGeos.length; gd++) { try { strandGeos[gd].dispose(); } catch (e) {} }
        var sm2 = new THREE.SkinnedMesh(mergedGeo || strandGeos[0], mat);
        sm2.name = "mmd-hair-strands";
        sm2.bindMode = mesh.bindMode || "attached";
        sm2.bind(mesh.skeleton, mesh.bindMatrix);
        sm2.frustumCulled = false;
        sm2.renderOrder = 1;
        sm2.castShadow = false;
        sm2.receiveShadow = false;
        group.add(sm2);
        strandMesh = sm2;
        for (var sv = 0; sv < state.strands.length; sv++) state.strands[sv].mesh = sm2;
        if (!P.merge) {
          for (var gm = 1; gm < strandGeos.length; gm++) {
            var smx = new THREE.SkinnedMesh(strandGeos[gm], mat);
            smx.name = "mmd-hair-strand-" + gm;
            smx.bindMode = mesh.bindMode || "attached";
            smx.bind(mesh.skeleton, mesh.bindMatrix);
            smx.frustumCulled = false;
            smx.renderOrder = 1;
            group.add(smx);
            state.strands[gm].mesh = smx;
          }
        }
      }
      state.strandMesh = strandMesh;

      // 头顶高光带
      var ringInfo = null;
      if (P.ring > 0) {
        var ringBuilt = buildRing(mesh, hull, surface, P, palette);
        if (ringBuilt) {
          var rm = new THREE.SkinnedMesh(ringBuilt.geometry, ringBuilt.material);
          rm.name = "mmd-hair-ring";
          rm.bindMode = mesh.bindMode || "attached";
          rm.bind(mesh.skeleton, mesh.bindMatrix);
          rm.frustumCulled = false;
          rm.renderOrder = 2;
          group.add(rm);
          state.materials.push(ringBuilt.material);
          state.ring = rm;
          ringInfo = ringBuilt.info;
        }
      }

      if (!made && !ringInfo) {
        console.warn("[mmd-hair] 没有匹配到头发骨骼链，跳过叠加");
        state.stats = { strands: 0, chains: 0, reason: "no-chains" };
        return api;
      }

      // 射线求交用的临时头发三角网只在这一刻有用，建完就释放（约 0.6MB）
      if (state.surface) { try { state.surface.dispose(); } catch (e) {} state.surface = null; }

      mesh.add(group);
      state.group = group;
      mesh.updateMatrixWorld(false);

      state.stats = {
        strands: made,
        chains: chainInfo.length,
        bones: chains.reduce(function (n, c) { return n + c.bones.length; }, 0),
        hullPoints: hull.points,
        hullY: [+hull.minY.toFixed(2), +hull.maxY.toFixed(2)],
        hullCenter: [+hull.cx.toFixed(2), +hull.cz.toFixed(2)],
        chainInfo: chainInfo,
        drawCalls: (strandMesh ? (P.merge ? 1 : strandGeos.length) : 0) + (ringInfo ? 1 : 0),
        ring: ringInfo,
        params: P,
      };
      return api;
    }

    var api = {
      version: VERSION,
      attach: attach,
      detach: detach,
      get stats() { return state.stats; },
      get params() { return state.params; },
      get group() { return state.group; },
      get strands() { return state.strands; },
      get hull() { return state.hull; },
      get surface() { return state.surface; },
      get ring() { return state.ring; },
      get strandMesh() { return state.strandMesh; },
      get mesh() { return state.mesh; },
    };
    return api;
  }

  /* ---------------------- 模块级便捷入口 ---------------------- */
  function attachOne(mesh, params) {
    var THREE = (root && root.THREE) || null;
    if (!THREE) throw new Error("[mmd-hair] 独立调用需要 window.THREE");
    return create(THREE).attach(mesh, params);
  }

  var api = {
    version: VERSION,
    create: create,
    attach: attachOne,
    DEFAULTS: DEFAULTS,
    CHAINS: CHAIN_DEFS,
  };

  // 构建期：build.py 的 __def(module, exports, require) 包装里直接走 CommonJS；
  // 独立 lab 页里没有 module，就把 API 挂到 window.MMDHAIR。
  if (typeof module !== "undefined" && module && module.exports) module.exports = api;
  if (root) root.MMDHAIR = api;
})(typeof window !== "undefined" ? window : null);
