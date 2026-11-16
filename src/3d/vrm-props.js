/**
 * vrm-props —— 给 VRM 角色加"02 的零件"：红角 / 白王冠发带 / 白色贝雷帽 / 女仆头饰 / 鲸鱼尾巴 / 棒棒糖。
 *
 * 全部是用 THREE 基本几何现场建的（没有外部模型文件），材质用 vrm-style 的 MToon 工厂，
 * 观感和模型本体一致；挂到 humanoid 骨骼上跟随动画。
 *
 * 用法：
 *   var PROPS = __req("vrm-props").create(THREE, STYLE);
 *   PROPS.apply(vrm, { horns: true, beret: true, chibi: 1.45 });   // 加载完 VRM 后调用
 *
 * 注意：VRM 模型高约 1.6（米），本文件所有尺寸都按这个量级（0.01 ~ 0.3）。
 */
module.exports.create = function (THREE, STYLE) {
  var PI = Math.PI, TAU = PI * 2;
  var api = {};

  function mat(opts) {
    if (STYLE && STYLE.makeMToonMaterial) return STYLE.makeMToonMaterial(opts);
    return new THREE.MeshToonMaterial({ color: opts.color == null ? 0xffffff : opts.color });
  }

  /** 反壳描边：给配件一个小黑边，和 VRM 的描边观感统一 */
  function outline(mesh, thickness) {
    var m = new THREE.Mesh(
      mesh.geometry,
      new THREE.MeshBasicMaterial({ color: 0x2a1a22, side: THREE.BackSide })
    );
    m.scale.setScalar(1 + (thickness || 0.06));
    m.raycast = function () {};
    mesh.add(m);
    return mesh;
  }

  /* ----------------------------- 红角 ----------------------------- */
  var hornGeo = (function () {
    var pts = [];
    var N = 12;
    for (var i = 0; i <= N; i++) {
      var t = i / N;
      var r = 0.020 * Math.pow(1 - t, 0.85) + 0.0012;
      pts.push(new THREE.Vector2(r, t * 0.105));
    }
    var g = new THREE.LatheGeometry(pts, 16);
    var pos = g.attributes.position;
    for (var j = 0; j < pos.count; j++) {
      var y = pos.getY(j);
      pos.setX(j, pos.getX(j) + y * y * 2.4);
      pos.setZ(j, pos.getZ(j) + y * y * 0.6);
    }
    g.computeVertexNormals();
    return g;
  })();

  api.horns = function (opts) {
    opts = opts || {};
    var g = new THREE.Group();
    g.name = "prop-horns";
    var M = mat({ color: opts.color == null ? 0xef4458 : opts.color, shadeColorFactor: 0xa8203a, rim: 0xffc0c8, rimFresnel: 3, rimLift: 0.15 });
    [-1, 1].forEach(function (side) {
      var m = new THREE.Mesh(hornGeo, M);
      m.position.set(side * 0.048, 0.028, 0.012);
      m.rotation.z = -side * 0.42;
      m.rotation.x = -0.16;
      m.scale.setScalar(1.38);
      outline(m, 0.10);
      g.add(m);
    });
    return g;
  };

  /* -------------------------- 白王冠发带 -------------------------- */
  api.headband = function (opts) {
    opts = opts || {};
    var g = new THREE.Group();
    g.name = "prop-headband";
    var band = new THREE.Mesh(
      new THREE.TorusGeometry(opts.r || 0.088, opts.tube || 0.0095, 8, 28, PI * 1.42),
      mat({ color: 0xfff6f2, shadeColorFactor: 0xd9bcc4 })
    );
    band.rotation.x = PI / 2 - 0.22;
    band.rotation.z = -0.25;
    band.position.y = 0.052;
    g.add(band);
    // 两端的白色小装饰
    [-1, 1].forEach(function (side) {
      var dot = new THREE.Mesh(new THREE.SphereGeometry(0.012, 10, 8), mat({ color: 0xfff6f2 }));
      dot.position.set(side * 0.086, 0.055, 0.028);
      g.add(dot);
    });
    return g;
  };

  /* ---------------------------- 贝雷帽 ---------------------------- */
  api.beret = function (opts) {
    opts = opts || {};
    var g = new THREE.Group();
    g.name = "prop-beret";
    var cream = opts.color == null ? 0xfff4ea : opts.color;
    var cap = new THREE.Mesh(
      new THREE.SphereGeometry(0.105, 22, 14, 0, TAU, 0, PI * 0.52),
      mat({ color: cream, shadeColorFactor: 0xd8c6bc })
    );
    cap.scale.set(1.04, 0.62, 1.06);
    cap.position.set(0, 0.07, 0.004);
    cap.rotation.x = 0.16;
    cap.rotation.z = 0.06;
    g.add(cap);
    var brim = new THREE.Mesh(new THREE.TorusGeometry(0.098, 0.011, 8, 26), mat({ color: 0xf6e4d8 }));
    brim.rotation.x = PI / 2 - 0.16;
    brim.position.y = 0.052;
    g.add(brim);
    var knob = new THREE.Mesh(new THREE.SphereGeometry(0.012, 10, 8), mat({ color: 0xfff4ea }));
    knob.position.set(0, 0.128, 0.0);
    g.add(knob);
    return g;
  };

  /* -------------------------- 女仆荷叶边头饰 -------------------------- */
  api.maidHeaddress = function (opts) {
    opts = opts || {};
    var g = new THREE.Group();
    g.name = "prop-headdress";
    var white = mat({ color: 0xd6ebff, shadeColorFactor: 0x94b8e8 });
    var band = new THREE.Mesh(new THREE.TorusGeometry(0.086, 0.011, 8, 26), white);
    band.rotation.x = PI / 2 - 0.1;
    band.position.y = 0.05;
    g.add(band);
    for (var i = 0; i < 9; i++) {
      var a = -PI * 0.55 + (i / 8) * PI * 1.1;
      var puff = new THREE.Mesh(new THREE.SphereGeometry(0.0155, 10, 8), white);
      puff.position.set(Math.sin(a) * 0.086, 0.05 + Math.cos(a) * 0.01, Math.cos(a) * 0.086 * 0.75 - 0.012);
      puff.scale.set(1, 0.85, 1);
      g.add(puff);
    }
    return g;
  };

  /* ---------------------------- 鲸鱼尾巴 ---------------------------- */
  api.whaleTail = function (opts) {
    opts = opts || {};
    var g = new THREE.Group();
    g.name = "prop-tail";
    var blue = opts.color == null ? 0x4a7fd8 : opts.color;
    var M = mat({ color: blue, shadeColorFactor: 0x24429c, rim: 0x9fd0ff, rimFresnel: 3 });
    // 尾根
    var stem = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.038, 0.16, 12), M);
    stem.rotation.x = PI / 2;
    stem.position.set(0, 0, -0.08);
    g.add(stem);
    // 尾鳍：两片叶形（用 Shape + Extrude）
    var shape = new THREE.Shape();
    shape.moveTo(0, 0);
    shape.bezierCurveTo(0.05, 0.05, 0.16, 0.10, 0.20, 0.02);
    shape.bezierCurveTo(0.15, -0.02, 0.07, -0.03, 0, 0);
    var finGeo = new THREE.ExtrudeGeometry(shape, { depth: 0.016, bevelEnabled: true, bevelSize: 0.006, bevelThickness: 0.005, bevelSegments: 1, curveSegments: 10 });
    finGeo.center();
    [-1, 1].forEach(function (side) {
      var fin = new THREE.Mesh(finGeo, M);
      fin.position.set(side * 0.075, 0, -0.155);
      fin.rotation.y = side * 0.55;
      fin.rotation.z = side * 0.22;
      g.add(fin);
    });
    return g;
  };

  /* ---------------------------- 棒棒糖 ---------------------------- */
  api.candy = function (opts) {
    opts = opts || {};
    var g = new THREE.Group();
    g.name = "prop-candy";
    var stick = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.005, 0.11, 8), mat({ color: 0xfffbf6 }));
    stick.position.y = -0.055;
    g.add(stick);
    var ball = new THREE.Mesh(new THREE.SphereGeometry(0.026, 16, 12), mat({ color: 0x3fd39a, shadeColorFactor: 0x1f8a68, rim: 0xbfffe8, rimFresnel: 2 }));
    ball.scale.y = 0.94;
    g.add(ball);
    return g;
  };

  /* --------------------------- Q 版：放大头 --------------------------- */
  /**
   * 把 raw head 骨骼放大，做出大头 Q 版（蒙皮会跟着放大，脖子以下不动）。
   * factor 建议 1.35 ~ 1.7。
   */
  api.chibify = function (vrm, factor) {
    if (!vrm || !vrm.humanoid || !factor || factor === 1) return false;
    var head = vrm.humanoid.getRawBoneNode("head");
    if (!head) return false;
    head.scale.setScalar(factor);
    // 脖子稍微加粗一点，衔接自然
    var neck = vrm.humanoid.getRawBoneNode("neck");
    if (neck) neck.scale.setScalar(1 + (factor - 1) * 0.35);
    return true;
  };

  /* --------------------------- 一键应用 --------------------------- */
  /**
   * cfg = {
   *   horns: true, headband: true, beret: true, headdress: true, tail: true, candy: true,
   *   chibi: 1.45,
   *   neckCandy: false
   * }
   */
  api.apply = function (vrm, cfg) {
    cfg = cfg || {};
    var out = { attached: [], chibi: false };
    if (!vrm) return out;
    // vrmchar 会把模型缩放到舞台尺寸（~3 倍），配件偏移要按这个缩放换算到世界单位
    var S = cfg.scale || (vrm.scene && vrm.scene.scale && vrm.scene.scale.x) || 1;
    // 挂 raw 骨；space:"world" 让偏移按"人形世界方向"给，避免 VRoid 骨骼 rest 朝向的坑
    function attach(bone, obj, offset, rot) {
      if (!obj) return;
      var scaled = offset ? [offset[0] * S, offset[1] * S, offset[2] * S] : null;
      try {
        if (STYLE && STYLE.attachToBone) {
          STYLE.attachToBone(vrm, bone, obj, { position: scaled, rotation: rot }, { space: "world" });
        } else {
          var b = vrm.humanoid.getRawBoneNode(bone);
          if (!b) return;
          if (scaled) obj.position.set(scaled[0], scaled[1], scaled[2]);
          if (rot) obj.rotation.set(rot[0], rot[1], rot[2]);
          b.add(obj);
        }
        out.attached.push(obj.name || bone);
      } catch (e) {
        console.warn("[vrm-props] 挂件失败 " + bone, e);
      }
    }
    if (cfg.chibi) out.chibi = api.chibify(vrm, cfg.chibi);
    if (cfg.horns) attach("head", api.horns(cfg.hornsOpts), [0, 0.115, 0.02]);
    if (cfg.headband) attach("head", api.headband(cfg.headbandOpts), [0, 0.135, 0.015]);
    if (cfg.beret) attach("head", api.beret(cfg.beretOpts), [0, 0.145, 0.005]);
    if (cfg.headdress) attach("head", api.maidHeaddress(cfg.headdressOpts), [0, 0.145, -0.005]);
    if (cfg.tail) attach("hips", api.whaleTail(cfg.tailOpts), [0.09, -0.06, -0.12], [-0.35, 0.5, 0.15]);
    if (cfg.candy) attach("rightHand", api.candy(cfg.candyOpts), [0, -0.04, 0.02], [0.4, 0, 0]);
    return out;
  };

  return api;
};
