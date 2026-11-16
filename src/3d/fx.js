/**
 * fx —— 3D 粒子特效发射器（桌面宠物用的小而美特效）
 *
 * 依赖：create(K, THREE) 传入 kit 工具箱和 three；不直接依赖任何浏览器全局
 *      （Canvas 由 kit 的 K.canvasTex / K.heart / K.star 封装）。
 *
 * 用法：
 *   var FX = __req("fx").create(K, THREE);
 *   var fx = FX.createEmitter(char.root);          // parent = 角色挂载点（Object3D）
 *   fx.burst("hearts", { n: 8 });                  // 不传坐标：自动锚到头部/脸部（按 kind 取比例）
 *   fx.burst("notes", { x: 0, y: 3.6, z: 0.45 });  // 传坐标：parent 局部坐标，精确发射
 *   fx.update(dt);                                 // 每帧推进（自动回收死掉的粒子）
 *   fx.clear();                                    // 清屏（换状态时用，保留缓存）
 *   fx.dispose();                                  // 卸载角色时调用，释放全部几何/贴图/材质
 *
 * kind（全部内置）：
 *   hearts   爱心     粉色/红色，向上飘 + 轻微自转 + 渐隐
 *   sparkles 星星     四散爆开、一闪一闪（被夸奖 / 升级）
 *   notes    音符     精灵贴图，一边升一边左右摆（唱歌 / 说话）
 *   zzz      睡觉 Z   慢慢往上飘，timeline 里反复发射即可
 *   bubbles  水泡     半透明，向上飘并轻微变大（鲸鲸）
 *   shock    惊吓爆点 红色星星四散 + 中央 "!"（惊吓 / 生气 / 失败）
 *
 * opts：
 *   x, y, z   发射原点（parent 局部坐标）。三个都不传时，自动用 parent 包围盒高度
 *             按 kind 取锚点（头顶/脸/胸口/腰，见 KINDS 表）；传入任意一个则完全按给定坐标。
 *   n         数量。默认按 kind：hearts 7 / sparkles 9 / notes 4 / zzz 1 / bubbles 6 / shock 7
 *   scale     尺寸倍率，默认 1
 *   spread    发射半径 / 四散强度，默认 1（星星、惊吓这类爆点调大更明显）
 *   duration  寿命（秒），覆盖 kind 默认值
 *   color     颜色：0xRRGGBB / "#rrggbb" / 颜色数组（每颗粒子随机取一个）
 *   返回实际生成的粒子数。
 *
 * 设计要点：
 *   - 粒子用对象池（Mesh / Sprite 两类）+ 每种几何/贴图按 emitter 缓存，反复 burst 不新建几何；
 *   - 同屏硬上限 MAX = 72（需求 ≤ 80），超出时自动回收最老的粒子，数量永远有界；
 *   - 每颗粒子独立材质（淡出就是 material.opacity），死亡时立即从场景移除并 dispose 材质；
 *   - 共享几何 / 贴图在 emitter.dispose() 时统一释放，clear() 只回收粒子保留缓存；
 *   - 全部 MeshBasicMaterial / SpriteMaterial：不吃光、透明、不写深度，200~360px 窗口里也清楚、
 *     不会因为小窗口被卡通材质的光照吃掉颜色；
 *   - 单帧最多扫描 72 个粒子，移动端 / 低端机也扛得住。
 */

module.exports.create = function (K, THREE) {
  var PI = Math.PI;
  var TAU = PI * 2;
  var MAX = 72;          // 每个 emitter 同屏粒子上限（需求 ≤ 80）
  var BASE_H = 4.4;      // 参考身高（Q版 02 ≈ 4.42 世界单位），用于把比例换算成世界单位
  var V3 = THREE.Vector3;
  var B3 = THREE.Box3;

  function clamp(v, a, b) { return K.clamp ? K.clamp(v, a, b) : (v < a ? a : v > b ? b : v); }
  function rand(a, b) { return K.rand ? K.rand(a, b) : a + Math.random() * (b - a); }
  function smooth(t) { return K.smooth ? K.smooth(t) : (function (x) { return x * x * (3 - 2 * x); })(clamp(t, 0, 1)); }
  function easeOut(t) { return K.easeOut ? K.easeOut(t) : 1 - Math.pow(1 - clamp(t, 0, 1), 3); }
  function easeBack(t) {
    if (K.easeBack) return K.easeBack(t);
    var c = 1.70158, x = clamp(t, 0, 1);
    return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2);
  }
  function pick(arr) { return arr[(Math.random() * arr.length) | 0]; }

  /* ============================ 每种特效的参数 ============================ */
  // 长度类数值都以世界单位/秒为单位（角色高 4.4 时调出来的手感），
  // 运行时再乘 unit（由 parent 包围盒高度换算），换高矮角色不会失衡。
  var KINDS = {
    hearts: {
      n: 7, dur: 2.0, size: 0.18, sizeJit: 0.30,
      oy: 0.22, ox: 0, oz: 0.10,          // 锚点 ≈ 包围盒高度 0.78~0.80 处（脸/下巴），避免小窗里飞出画布上沿
      ringR: 1.00, ringUp: 0, ringFlatten: 0.62,   // 围脸一圈（压扁一点），向上飘一点点就渐隐
      vy: 0.12, swayA: 0.06, swayW: 2.1, swayJit: 0.8,
      spinX: 0.5, spinY: 2.2, spinZ: 0.6,
      pop: 0.22, s0: 1, s1: 0.92, alpha: 1, fadeIn: 0.08, fadeOut: 0.48,
      pulseA: 0.05, pulseW: 6, twinkleA: 0, twinkleW: 0,
      mesh: "heart",
      colors: [0xff4f7f, 0xff6f96, 0xff8fb0, 0xff3f6f, 0xffa7c6],
    },
    sparkles: {
      n: 9, dur: 0.95, size: 0.22, sizeJit: 0.45,
      oy: 0.28, ox: 0, oz: 0.12,
      radial: 1, spawnR: 1.05, speed: 1.9, vy: 0.05,   // 从头部轮廓外圈向外炸开
      swayA: 0.02, swayW: 3.1, swayJit: 0.5,
      spinX: 1.5, spinY: 4.0, spinZ: 3.0,
      pop: 0.10, s0: 1, s1: 0.35, alpha: 1, fadeIn: 0.02, fadeOut: 0.35,
      pulseA: 0.18, pulseW: 16, twinkleA: 0.45, twinkleW: 22,
      mesh: "star",
      colors: [0xffe9a8, 0xfff4d6, 0xffc7dd, 0xfff0b0, 0xffd6f0],
    },
    notes: {
      n: 4, dur: 1.9, size: 0.40, sizeJit: 0.22,
      oy: 0.14, ox: 0.10, oz: 0.30,       // 锚点 ≈ 包围盒高度 0.86 处（额前/发梢），脸前偏右
      spread: 0.30,
      vy: 0.28, swayA: 0.10, swayW: 2.6, swayJit: 0.6,
      spinZ: 0.5,
      pop: 0.18, s0: 1, s1: 1.05, alpha: 1, fadeIn: 0.10, fadeOut: 0.55,
      sprite: 1, tex: ["note0", "note1"],
      colors: [0xffffff, 0xffe9f4, 0xc9b8ff, 0xa8e6ff],
    },
    zzz: {
      n: 1, dur: 2.9, size: 0.34, sizeJit: 0.12,
      oy: 0.055, ox: 0.15, oz: 0.05,      // 头顶偏右上方冒 Z，往右上慢慢飘（+x = 屏幕右侧）
      spread: 0.10, vy: 0.13, driftX: 0.20,
      swayA: 0.05, swayW: 1.6, swayJit: 0.4,
      spinZ: 0.16,
      pop: 0.35, s0: 0.8, s1: 1.22, alpha: 0.95, fadeIn: 0.25, fadeOut: 0.60,
      sprite: 1, tex: ["zzz"],
      colors: [0xd9c8ff, 0xb9a3ff, 0xe8dcff],
    },
    bubbles: {
      n: 5, dur: 2.0, size: 0.29, sizeJit: 0.45,
      oy: 0.70, ox: 0, oz: 0.20,          // 腰/胸口位置、身体前方，向上升
      spread: 1.00,
      vy: 0.22, swayA: 0.06, swayW: 2.3, swayJit: 0.7,
      spinZ: 0.10,
      pop: 0.26, s0: 1, s1: 1.45, alpha: 0.62, fadeIn: 0.20, fadeOut: 0.72,
      sprite: 1, tex: ["bubble"],
      colors: [0xbfefff, 0xd6f6ff, 0xa8dcff, 0xc6e8ff],
    },
    shock: {
      n: 7, dur: 0.60, size: 0.17, sizeJit: 0.45,
      oy: 0.30, ox: 0, oz: 0.24,
      radial: 1, spawnR: 1.05, speed: 2.3, vy: 0.05,  // 脸部轮廓外圈向外炸
      swayA: 0.02, swayW: 8.0, swayJit: 1.0,
      spinX: 2.0, spinY: 5.0, spinZ: 4.0,
      pop: 0.08, s0: 1, s1: 0.20, alpha: 1, fadeIn: 0.01, fadeOut: 0.30,
      pulseA: 0.20, pulseW: 24, twinkleA: 0.40, twinkleW: 26,
      mesh: "star",
      colors: [0xff4d5e, 0xff7a3d, 0xffb03d, 0xff3d6e],
      extra: "bang",
    },
    // 内部 kind：shock 中央的 "!"，对外不宣传，但 burst("bang") 也能单独用
    bang: {
      n: 1, dur: 0.72, size: 0.60, sizeJit: 0, oy: 0.16, ox: 0.25, oz: 0.30,
      spread: 0, vy: 0.25, swayA: 0.02, swayW: 14, swayJit: 0,
      spinZ: 0,
      pop: 0.14, s0: 1, s1: 1.05, alpha: 1, fadeIn: 0.03, fadeOut: 0.42,
      sprite: 1, tex: ["bang"],
      colors: [0xff5a5a, 0xffc04d],
    },
  };

  /* ============================ 程序化贴图（不依赖字体） ============================ */
  // 用 canvas 路径画音符 / Z / 感叹号 / 泡泡，避免目标机器缺字体时出现豆腐块。
  function drawNote(x, S, variant) {
    x.clearRect(0, 0, S, S);
    x.fillStyle = "#ffffff";
    x.strokeStyle = "#ffffff";
    x.lineCap = "round";
    x.lineJoin = "round";
    function head(cx, cy, r) {
      x.save();
      x.translate(cx, cy);
      x.rotate(-0.28);
      x.beginPath();
      x.ellipse(0, 0, r * 1.25, r, 0, 0, TAU);
      x.fill();
      x.restore();
    }
    if (variant === 0) {
      // 单八分音符
      head(S * 0.34, S * 0.76, S * 0.098);
      x.lineWidth = S * 0.055;
      x.beginPath();
      x.moveTo(S * 0.452, S * 0.70);
      x.lineTo(S * 0.452, S * 0.20);
      x.stroke();
      x.beginPath();
      x.moveTo(S * 0.452, S * 0.20);
      x.bezierCurveTo(S * 0.66, S * 0.25, S * 0.73, S * 0.36, S * 0.66, S * 0.50);
      x.lineTo(S * 0.61, S * 0.44);
      x.bezierCurveTo(S * 0.66, S * 0.34, S * 0.60, S * 0.29, S * 0.452, S * 0.31);
      x.closePath();
      x.fill();
    } else {
      // 双音符（连杠）
      head(S * 0.28, S * 0.78, S * 0.092);
      head(S * 0.64, S * 0.70, S * 0.092);
      x.lineWidth = S * 0.048;
      x.beginPath();
      x.moveTo(S * 0.40, S * 0.72);
      x.lineTo(S * 0.40, S * 0.26);
      x.moveTo(S * 0.76, S * 0.65);
      x.lineTo(S * 0.76, S * 0.19);
      x.stroke();
      x.beginPath();
      x.moveTo(S * 0.38, S * 0.26);
      x.lineTo(S * 0.78, S * 0.18);
      x.lineTo(S * 0.78, S * 0.30);
      x.lineTo(S * 0.38, S * 0.38);
      x.closePath();
      x.fill();
    }
  }

  function drawZ(x, S) {
    x.clearRect(0, 0, S, S);
    x.strokeStyle = "#ffffff";
    x.lineWidth = S * 0.15;
    x.lineCap = "round";
    x.lineJoin = "round";
    x.beginPath();
    x.moveTo(S * 0.20, S * 0.22);
    x.lineTo(S * 0.80, S * 0.22);
    x.lineTo(S * 0.20, S * 0.78);
    x.lineTo(S * 0.80, S * 0.78);
    x.stroke();
  }

  function drawBang(x, S) {
    x.clearRect(0, 0, S, S);
    x.fillStyle = "#ffffff";
    x.beginPath();
    x.moveTo(S * 0.415, S * 0.14);
    x.lineTo(S * 0.585, S * 0.14);
    x.lineTo(S * 0.545, S * 0.62);
    x.lineTo(S * 0.455, S * 0.62);
    x.closePath();
    x.fill();
    x.beginPath();
    x.arc(S * 0.5, S * 0.80, S * 0.078, 0, TAU);
    x.fill();
  }

  function drawBubble(x, S) {
    x.clearRect(0, 0, S, S);
    var g = x.createRadialGradient(S * 0.36, S * 0.32, 0, S * 0.5, S * 0.5, S * 0.52);
    g.addColorStop(0, "rgba(255,255,255,0.26)");
    g.addColorStop(0.55, "rgba(255,255,255,0.12)");
    g.addColorStop(0.84, "rgba(255,255,255,0.62)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    x.fillStyle = g;
    x.beginPath();
    x.arc(S * 0.5, S * 0.5, S * 0.5, 0, TAU);
    x.fill();
    x.strokeStyle = "rgba(255,255,255,0.55)";
    x.lineWidth = S * 0.024;
    x.beginPath();
    x.arc(S * 0.5, S * 0.5, S * 0.45, 0, TAU);
    x.stroke();
    var hg = x.createRadialGradient(S * 0.34, S * 0.28, 0, S * 0.34, S * 0.28, S * 0.19);
    hg.addColorStop(0, "rgba(255,255,255,1)");
    hg.addColorStop(1, "rgba(255,255,255,0)");
    x.fillStyle = hg;
    x.beginPath();
    x.ellipse(S * 0.34, S * 0.28, S * 0.17, S * 0.11, -0.6, 0, TAU);
    x.fill();
    // 右下第二点反光，增加球体感
    var hg2 = x.createRadialGradient(S * 0.66, S * 0.72, 0, S * 0.66, S * 0.72, S * 0.10);
    hg2.addColorStop(0, "rgba(255,255,255,0.55)");
    hg2.addColorStop(1, "rgba(255,255,255,0)");
    x.fillStyle = hg2;
    x.beginPath();
    x.arc(S * 0.66, S * 0.72, S * 0.10, 0, TAU);
    x.fill();
  }

  var TEX_DRAW = {
    note0: function (x, S) { drawNote(x, S, 0); },
    note1: function (x, S) { drawNote(x, S, 1); },
    zzz: drawZ,
    bang: drawBang,
    bubble: drawBubble,
  };

  /* ============================ 发射器 ============================ */
  /**
   * @param {THREE.Object3D} parent 角色挂载点：粒子作为它的子节点，坐标是 parent 局部坐标。
   * @returns {{burst:Function, update:Function, clear:Function, dispose:Function, count:Function, stats:Function}}
   */
  function createEmitter(parent) {
    var ok = !!(parent && parent.isObject3D);
    if (!ok) {
      try { console.warn("[zero02] fx.createEmitter(parent) 需要 THREE.Object3D，已降级为离屏发射器"); } catch (e) {}
    }
    var holder = ok ? parent : null;
    var group = new THREE.Group();
    group.name = "z02-fx";
    if (holder) holder.add(group);

    var active = [];          // 活着的粒子（按生成顺序，[0] 最老）
    var poolMesh = [];        // 回收的 Mesh 壳
    var poolSprite = [];      // 回收的 Sprite 壳
    var geoCache = {};        // kind -> BufferGeometry
    var texCache = {};        // texKey -> CanvasTexture
    var disposed = false;

    // 自动锚点（parent 包围盒顶部），第一次 burst 时量一次
    var anchorTried = false;
    var anchor = null;        // {x,y,z} parent 局部坐标
    var anchorUnit = 1;       // 世界单位/参考身高 的换算
    var anchorH = 0;

    function getGeo(key) {
      if (geoCache[key]) return geoCache[key];
      var g;
      if (key === "heart") g = K.heart(1, 0.20);
      else if (key === "star") g = K.star(1, 0.16);
      else g = K.heart(1, 0.20);
      geoCache[key] = g;
      return g;
    }

    function getTex(key) {
      if (texCache[key]) return texCache[key];
      var draw = TEX_DRAW[key];
      var tex = draw ? K.canvasTex(128, function (x, S) { draw(x, S); }) : K.canvasTex(128, function (x, S) { drawZ(x, S); });
      texCache[key] = tex;
      return tex;
    }

    function measureAnchor() {
      if (anchorTried) return;
      anchorTried = true;
      if (!holder) return;
      var hadGroup = group.parent === holder;
      try {
        // 量包围盒时把自己的特效组摘掉，避免粒子一开始就污染锚点
        if (hadGroup) holder.remove(group);
        var box = new B3().setFromObject(holder);
        var size = new V3();
        box.getSize(size);
        if (!box.isEmpty() && size.y > 0.001) {
          var ws = new V3();
          holder.getWorldScale(ws);
          var yScale = Math.max(0.0001, Math.abs(ws.y));
          var top = new V3(
            (box.min.x + box.max.x) * 0.5,
            box.max.y,
            (box.min.z + box.max.z) * 0.5
          );
          holder.worldToLocal(top);
          anchor = { x: top.x, y: top.y, z: top.z };
          anchorH = size.y / yScale;
          anchorUnit = clamp(anchorH / BASE_H, 0.6, 1.5);
        } else {
          // 还没挂角色（或这是纯挂载点时）允许下次 burst 再量一次
          anchorTried = false;
        }
      } catch (e) {
        anchor = null;
      } finally {
        if (hadGroup && group.parent !== holder) holder.add(group);
      }
    }

    function anchorFor(kind) {
      if (!anchor) return { x: 0, y: 0, z: 0 };
      var C = KINDS[kind];
      return {
        x: anchor.x + (C.ox || 0) * anchorH,
        y: anchor.y - (C.oy || 0) * anchorH,
        z: anchor.z + (C.oz || 0) * anchorH,
      };
    }

    function takeShell(isSprite) {
      var arr = isSprite ? poolSprite : poolMesh;
      return arr.length ? arr.pop() : null;
    }

    function recycleShell(ob, isSprite) {
      ob.visible = true;
      if (isSprite) poolSprite.push(ob);
      else poolMesh.push(ob);
    }

    /** 回收第 i 个粒子：出场景 + dispose 独立材质，壳放回池子（共享几何不在这里释放） */
    function killAt(i) {
      var p = active[i];
      if (!p) return null;
      try { group.remove(p.obj); } catch (e) {}
      if (p.mat) {
        try { p.mat.dispose(); } catch (e) {}
        p.mat = null;
      }
      p.obj.material = null;
      recycleShell(p.obj, !!p.isSprite);
      active.splice(i, 1);
      return p;
    }

    function killOldest(k) {
      while (k > 0 && active.length) {
        killAt(0);
        k--;
      }
    }

    function colorOf(palette, override) {
      var c = override != null ? (Array.isArray(override) ? pick(override) : override) : pick(palette);
      var col = new THREE.Color();
      try { col.set(c); } catch (e) { col.set(0xffffff); }
      return col;
    }

    function spawnOne(kind, base, unit, opts) {
      var C = KINDS[kind];
      if (!C) return null;
      var scaleK = opts.scale != null && opts.scale > 0 ? opts.scale : 1;
      var isSprite = !!C.sprite;

      // 颜色 / 贴图 / 材质
      var col = colorOf(C.colors, opts.color);
      var mat, geo = null, tex = null;
      if (isSprite) {
        tex = getTex(pick(C.tex));
        mat = new THREE.SpriteMaterial({
          map: tex, color: col, transparent: true, opacity: 1,
          depthWrite: false, depthTest: true, toneMapped: false,
          rotation: 0,
        });
      } else {
        geo = getGeo(C.mesh);
        mat = new THREE.MeshBasicMaterial({
          color: col, transparent: true, opacity: 1,
          depthWrite: false, depthTest: true, toneMapped: false,
          side: THREE.FrontSide,
        });
      }

      var ob = takeShell(isSprite);
      if (!ob) {
        ob = isSprite ? new THREE.Sprite(mat) : new THREE.Mesh(geo, mat);
      } else if (isSprite) {
        ob.material = mat;
      } else {
        ob.geometry = geo;
        ob.material = mat;
      }
      ob.visible = true;
      ob.renderOrder = 10;
      if (ob.parent !== group) group.add(ob);

      // 位置：ring（围头一圈）/ radial（轮廓向外炸）/ 普通（区域抖动）三种发射体
      var spread = opts.spread != null ? opts.spread : 1;
      var x0 = base.x, y0 = base.y, z0 = base.z;
      var vx, vy, vz, ang;
      if (C.ringR) {
        // 沿头部轮廓生成，避免粒子出生在头里被深度挡掉
        ang = rand(0, TAU);
        if (Math.sin(ang) < -0.35) ang = -ang;   // 镜像到上半圈，避免爱心糊在嘴上
        var ringR = C.ringR * unit * rand(0.85, 1.15);
        x0 += Math.cos(ang) * ringR;
        y0 += Math.sin(ang) * ringR * (C.ringFlatten || 0.85) + (C.ringUp || 0) * unit;
        z0 += rand(-0.30, 0.30) * unit;
        vx = rand(-0.06, 0.06) * unit;
        vy = C.vy * unit * rand(0.82, 1.22);
        vz = rand(-0.05, 0.05) * unit;
      } else if (C.radial) {
        // 先在轮廓外侧一个环上出生，再沿法线向外飞，第一帧就能看见
        ang = rand(0, TAU);
        var r0 = (C.spawnR || 0.4) * unit * rand(0.9, 1.1);
        x0 += Math.cos(ang) * r0;
        y0 += Math.sin(ang) * r0 * 0.86;
        z0 += rand(-0.15, 0.15) * unit;
        var spd = C.speed * unit * rand(0.55, 1.25) * spread;
        vx = Math.cos(ang) * spd;
        vy = Math.sin(ang) * spd * 0.72 + C.vy * unit;
        vz = Math.sin(ang * 1.7) * spd * 0.25;
      } else {
        var area = (C.spread || 0.4) * unit * spread;
        x0 += rand(-0.55, 0.55) * area;
        y0 += rand(-0.35, 0.55) * area;
        z0 += rand(-0.50, 0.50) * area;
        vx = rand(-0.10, 0.10) * unit + (C.driftX || 0) * unit * rand(0.8, 1.2) + (opts.vx || 0);
        vy = C.vy * unit * rand(0.82, 1.22);
        vz = rand(-0.08, 0.08) * unit + (opts.vz || 0);
      }

      var size = C.size * unit * scaleK * (1 + rand(-C.sizeJit, C.sizeJit));
      var life = (opts.duration != null && opts.duration > 0 ? opts.duration : C.dur) * rand(0.88, 1.12);
      var p = {
        obj: ob, mat: mat, isSprite: isSprite, age: 0, life: life,
        x0: x0, y0: y0, z0: z0, vx: vx, vy: vy, vz: vz,
        swayA: (C.swayA || 0) * unit * rand(0.7, 1.3),
        swayW: (C.swayW || 1) * rand(0.7, 1.3),
        ph: rand(0, TAU),
        size: size, s0: C.s0 == null ? 1 : C.s0, s1: C.s1 == null ? 1 : C.s1,
        popT: C.pop || 0.12,
        alpha: (C.alpha == null ? 1 : C.alpha) * (opts.alpha != null ? opts.alpha : 1),
        fadeIn: C.fadeIn || 0, fadeOut: C.fadeOut == null ? 0.5 : C.fadeOut,
        pulseA: C.pulseA || 0, pulseW: C.pulseW || 6,
        twinkleA: C.twinkleA || 0, twinkleW: C.twinkleW || 20,
        rx: isSprite ? 0 : rand(-0.35, 0.35),
        ry: isSprite ? 0 : rand(0, TAU),
        rz: rand(-0.28, 0.28),
        svx: (C.spinX || 0) * rand(0.75, 1.25),
        svy: (C.spinY || 0) * (Math.random() < 0.5 ? -1 : 1) * rand(0.65, 1.35),
        svz: (C.spinZ || 0) * (Math.random() < 0.5 ? -1 : 1) * rand(0.65, 1.35),
      };

      // 初始摆位 / 缩放 / 旋转（第一帧 update 前也要是合法状态）
      ob.position.set(x0, y0, z0);
      var s0v = Math.max(0.0001, size * p.s0);
      ob.scale.set(s0v, s0v, s0v);
      if (isSprite) mat.rotation = p.rz;
      else ob.rotation.set(p.rx, p.ry, p.rz);
      mat.opacity = 0.0001;
      active.push(p);
      return p;
    }

    function burst(kind, opts) {
      if (disposed) return 0;
      opts = opts || {};
      if (!KINDS[kind]) {
        try { console.warn("[zero02] fx.burst 未知特效: " + kind); } catch (e) {}
        return 0;
      }
      measureAnchor();

      var C = KINDS[kind];
      var explicit = opts.x != null || opts.y != null || opts.z != null;
      var base = explicit
        ? { x: opts.x || 0, y: opts.y || 0, z: opts.z || 0 }
        : anchorFor(kind);
      var unit = anchor ? anchorUnit : 1;

      var want = Math.floor(opts.n != null ? opts.n : C.n);
      if (!isFinite(want) || want < 0) want = 0;
      if (want > MAX) want = MAX;
      if (want === 0) return 0;

      // 数量有界：先腾位置（回收最老的），再按剩余空间生成
      var need = want + (C.extra ? 1 : 0);
      if (active.length + need > MAX) killOldest(active.length + need - MAX);
      var room = MAX - active.length - (C.extra ? 1 : 0);
      if (want > room) want = Math.max(0, room);

      var made = 0;
      for (var i = 0; i < want; i++) {
        if (spawnOne(kind, base, unit, opts)) made++;
      }
      if (C.extra) {
        if (active.length >= MAX) killOldest(1);
        // 额外粒子（如 shock 的 "!"）用自己的锚点偏移；显式坐标时就跟爆点同位置
        var extraBase = explicit ? base : anchorFor(C.extra);
        if (spawnOne(C.extra, extraBase, unit, opts)) made++;
      }
      return made;
    }

    function stepParticle(p, dt) {
      p.age += dt;
      var t = p.age / p.life;
      if (t >= 1) return false;
      var age = p.age;
      var pos = p.obj.position;

      // 位置：解析式，避免帧率不同导致轨迹不一致
      var bx = p.x0 + p.vx * age;
      var by = p.y0 + p.vy * age;
      var bz = p.z0 + p.vz * age;
      var amp = p.swayA * (0.35 + 0.65 * Math.min(1, age * 1.6));
      pos.x = bx + amp * Math.sin(age * p.swayW + p.ph);
      pos.y = by;
      pos.z = bz + amp * 0.7 * Math.cos(age * p.swayW * 0.8 + p.ph);

      // 缩放：弹出（easeBack 回弹）→ 生长/收缩 → 呼吸
      var pop = p.popT > 0 ? easeBack(Math.min(1, age / p.popT)) : 1;
      var grow = p.s0 + (p.s1 - p.s0) * easeOut(t);
      var pulse = 1 + p.pulseA * Math.sin(age * p.pulseW + p.ph);
      var s = p.size * Math.max(0.0001, pop) * grow * pulse;
      p.obj.scale.set(s, s, s);

      // 旋转：Sprite 只能屏幕面旋转，Mesh 三轴自由转
      if (p.isSprite) {
        p.mat.rotation = p.rz + p.svz * age;
      } else {
        p.obj.rotation.set(p.rx + p.svx * age, p.ry + p.svy * age, p.rz + p.svz * age);
      }

      // 透明度：淡入 × 淡出 × 闪烁
      var fadeIn = p.fadeIn > 0 ? smooth(age / p.fadeIn) : 1;
      var fadeOut = 1 - smooth((t - p.fadeOut) / Math.max(0.0001, 1 - p.fadeOut));
      var tw = p.twinkleA > 0
        ? (1 - p.twinkleA * 0.6) + p.twinkleA * 0.6 * (0.5 + 0.5 * Math.sin(age * p.twinkleW + p.ph))
        : 1;
      var a = p.alpha * fadeIn * fadeOut * tw;
      p.mat.opacity = a < 0 ? 0 : a > 1 ? 1 : a;
      return true;
    }

    /** 每帧推进；dt 是秒。返回剩余粒子数。 */
    function update(dt) {
      if (disposed) return 0;
      dt = +dt || 0;
      if (dt <= 0) return active.length;
      if (dt > 0.06) dt = 0.06;   // 切后台回来的大跳帧不要炸轨迹
      for (var i = active.length - 1; i >= 0; i--) {
        if (!stepParticle(active[i], dt)) killAt(i);
      }
      return active.length;
    }

    /** 清空当前粒子（保留几何/贴图缓存）；切换状态时用 */
    function clear() {
      while (active.length) killAt(active.length - 1);
      return 0;
    }

    /** 卸载：清粒子 + dispose 全部共享几何/贴图 + 从 parent 上摘掉特效组 */
    function dispose() {
      if (disposed) return;
      disposed = true;
      clear();
      for (var g in geoCache) {
        if (geoCache[g]) { try { geoCache[g].dispose(); } catch (e) {} }
      }
      for (var t in texCache) {
        if (texCache[t]) { try { texCache[t].dispose(); } catch (e) {} }
      }
      geoCache = {};
      texCache = {};
      poolMesh.length = 0;
      poolSprite.length = 0;
      try { if (group.parent) group.parent.remove(group); } catch (e) {}
      try { group.clear(); } catch (e) {}
    }

    return {
      burst: burst,
      update: update,
      clear: clear,
      dispose: dispose,
      /** 当前活着的粒子数（调试用） */
      count: function () { return active.length; },
      /** 运行状态快照（验收 / 调参用，不参与渲染） */
      stats: function () {
        return {
          active: active.length,
          max: MAX,
          pooledMesh: poolMesh.length,
          pooledSprite: poolSprite.length,
          geometries: Object.keys(geoCache).length,
          textures: Object.keys(texCache).length,
          anchored: !!anchor,
          unit: anchorUnit,
          disposed: disposed,
        };
      },
    };
  }

  return { createEmitter: createEmitter };
};
