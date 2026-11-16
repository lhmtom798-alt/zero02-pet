/**
 * vrm-style —— three-vrm（VRM 3.x / r166）桌面手办观感工具。
 *
 * 做四件事（全部只改材质/骨骼，不碰 renderer / camera / DOM）：
 *   1) 材质发现与染色：findMaterial / tintByMaterialName（发色、瞳色、衣服色）
 *   2) 描边参数：outlineFactorForPx（把"我要 1.2 像素描边"换算成 MToon 参数）/ setOutline
 *   3) 配件挂骨：attachToBone（红角、发带、贝雷帽、女仆头饰、鲸鱼尾巴）
 *   4) 表情 / 骨骼 / SpringBone：setExpression / listHumanoidBones / scaleSpringBones
 *
 * 用法（插件模块机制，和 src/3d 其它模块一致）：
 *
 *   var STYLE = __req("vrm-style").create(THREE, THREE_VRM);
 *   var n = STYLE.tintByMaterialName(vrm, "hair", 0x5b8fe8, { shade: 0.6, rim: 0.2 });
 *   STYLE.setOutline(vrm, { px: 1.2, viewportHeightPx: 300 });       // 改已有描边
 *   STYLE.attachToBone(vrm, "head", hornMesh, { position: [0, 0.12, 0.02], rotation: [0, 0, -0.35] });
 *   STYLE.setExpression(vrm, "happy", 0.8);
 *   STYLE.scaleSpringBones(vrm, modelScale);                          // 缩放模型后必须调
 *
 * 依赖：
 *   - THREE：three.js（本项目 vendor/three.global.js，r166）
 *   - VRMT ：window.THREE_VRM（@pixiv/three-vrm 3.5.5 的全局包；不传也能用大部分功能，
 *            只是 isMToonMaterial 判定只能靠鸭子类型）
 *
 * 已验证的 API（three-vrm 3.5.5，路径均为 packages/…/src）：
 *   - MToonMaterial（material.color / shadeColorFactor / shadingShiftFactor / shadingToonyFactor /
 *     giEqualizationFactor / parametricRimColorFactor / rimLightingMixFactor /
 *     parametricRimFresnelPowerFactor / parametricRimLiftFactor / matcapTexture / matcapFactor /
 *     outlineWidthMode / outlineWidthFactor / outlineColorFactor / outlineLightingMixFactor /
 *     isOutline / isMToonMaterial / update(delta)）
 *       packages/three-vrm-materials-mtoon/src/MToonMaterial.ts
 *   - MToonMaterialOutlineWidthMode = { None:'none', WorldCoordinates:'worldCoordinates',
 *     ScreenCoordinates:'screenCoordinates' }
 *       packages/three-vrm-materials-mtoon/src/MToonMaterialOutlineWidthMode.ts
 *   - VRMHumanoid.getRawBoneNode(name) / getNormalizedBoneNode(name) / humanBones
 *       packages/three-vrm-core/src/humanoid/VRMHumanoid.ts
 *   - VRMExpressionManager.getExpression(name) / setValue(name, weight) / expressions
 *       packages/three-vrm-core/src/expressions/VRMExpressionManager.ts
 *   - VRMSpringBoneManager.joints（Set<VRMSpringBoneJoint>）/ colliders / colliderGroups
 *   - VRMSpringBoneJoint.settings = { stiffness, dragForce, gravityPower, gravityDir, hitRadius }
 *       packages/three-vrm-springbone/src/VRMSpringBoneJoint.ts
 *   - VRMSpringBoneColliderShapeCapsule{radius,tail,offset} / …Sphere{radius,offset}
 *
 * 注意：VRMHumanoid 的归一化骨架（getNormalizedBoneNode）是独立 Object3D 树，不在 vrm.scene 里，
 * 只负责把旋转写回 raw 骨骼（VRMHumanoidRig.update() 只写 quaternion + hips.position，不写 scale）。
 * 所以：配件必须挂 raw 骨；Q 版头身比改 raw 骨的 scale 才不会被每帧覆盖。
 */

module.exports.create = function (THREE, VRMT) {
  "use strict";

  if (!THREE) throw new Error("[vrm-style] 缺少 THREE");

  var api = {};
  var IS_COLOR = function (v) { return !!(v && v.isColor); };

  /* ================================================================ *
   * 0. 小工具
   * ================================================================ */

  function warnOnce(key, msg) {
    api._warned = api._warned || {};
    if (api._warned[key]) return;
    api._warned[key] = true;
    if (typeof console !== "undefined" && console.warn) console.warn("[vrm-style] " + msg);
  }

  /** vrm 或 scene 都接受 */
  function sceneOf(vrmOrScene) {
    if (!vrmOrScene) return null;
    return vrmOrScene.scene || vrmOrScene;
  }

  function isMToon(m) {
    if (!m) return false;
    if (m.isMToonMaterial) return true;
    if (VRMT && VRMT.MToonMaterial && m instanceof VRMT.MToonMaterial) return true;
    // 鸭子类型：MToon 一定有这些字段（VRM 0.0 经 v0compat 转换后同样具备）
    return (
      m.shadeColorFactor !== undefined &&
      m.outlineWidthMode !== undefined &&
      m.parametricRimColorFactor !== undefined
    );
  }

  function isOutlineMat(m) {
    if (!m) return false;
    if (m.isOutline === true) return true;
    // loader 生成的描边材质名固定是 "<表面材质名> (Outline)"
    return typeof m.name === "string" && /\(Outline\)\s*$/.test(m.name);
  }

  /** 把 hex / css 字符串 / Color / [r,g,b] 统一成 THREE.Color（线性工作空间） */
  function toColor(value) {
    if (value == null) return null;
    if (value.isColor) return value.clone();
    if (Object.prototype.toString.call(value) === "[object Array]") {
      // 数组按"线性 RGB"解释（和 glTF 里 factor 的存储方式一致）
      return new THREE.Color().fromArray(value);
    }
    // number / '#rrggbb' / 'rgb(...)'：three r152+ 默认按 sRGB 解释，自动转线性（ColorManagement）
    return new THREE.Color(value);
  }

  /** 描边"墨色"：基色压暗 + 往冷紫黑里收一点，避免纯黑死边 */
  function inkFrom(tint, amount, inkTint, inkMix) {
    var c = tint.clone().multiplyScalar(amount == null ? 0.30 : amount);
    if (inkTint != null && inkMix) c.lerp(toColor(inkTint), inkMix);
    return c;
  }

  function coerceVector3(value) {
    if (value == null) return null;
    if (value.isVector3) return value.clone();
    if (Object.prototype.toString.call(value) === "[object Array]") {
      return new THREE.Vector3().fromArray(value);
    }
    if (typeof value === "number") return new THREE.Vector3(value, value, value);
    if (value.x != null || value.y != null || value.z != null) {
      return new THREE.Vector3(value.x || 0, value.y || 0, value.z || 0);
    }
    return null;
  }

  /* ================================================================ *
   * 1. 材质发现
   * ================================================================ */

  /**
   * 收集 vrm.scene 里的所有材质（含 mesh.material 数组里的描边克隆）。
   * 不依赖 vrm.materials —— 那是 VRM1 MToon 插件维护的列表，VRM0 转换来的模型里
   * 可能不完整；直接遍历 scene 对两种版本都稳。
   * @returns {Array<{material:THREE.Material, mesh:THREE.Mesh, name:string,
   *                  isOutline:boolean, isMToon:boolean}>}
   */
  api.collectMaterials = function (vrmOrScene) {
    var scene = sceneOf(vrmOrScene);
    var out = [];
    if (!scene || typeof scene.traverse !== "function") return out;
    var seen = [];
    scene.traverse(function (obj) {
      if (!obj || !obj.isMesh || !obj.material) return;
      var mats = Object.prototype.toString.call(obj.material) === "[object Array]"
        ? obj.material
        : [obj.material];
      for (var i = 0; i < mats.length; i++) {
        var m = mats[i];
        if (!m || seen.indexOf(m) >= 0) continue;
        seen.push(m);
        out.push({
          material: m,
          mesh: obj,
          name: m.name || "",
          isOutline: isOutlineMat(m),
          isMToon: isMToon(m),
        });
      }
    });
    return out;
  };

  /** 材质清单（调试/验收用）：名字、是否描边、贴图有无、关键颜色 */
  api.listMaterials = function (vrmOrScene) {
    var list = api.collectMaterials(vrmOrScene);
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      var m = e.material;
      out.push({
        name: e.name,
        mesh: e.mesh && e.mesh.name,
        isOutline: e.isOutline,
        isMToon: e.isMToon,
        hasMap: !!(m.map && m.map.isTexture),
        mapName: m.map && m.map.name ? m.map.name : "",
        color: m.color ? m.color.getHexString() : null,
        shadeColor: m.shadeColorFactor ? m.shadeColorFactor.getHexString() : null,
        rimColor: m.parametricRimColorFactor ? m.parametricRimColorFactor.getHexString() : null,
        outlineWidthFactor: m.outlineWidthFactor != null ? m.outlineWidthFactor : null,
      });
    }
    return out;
  };

  function matchName(matcher, name, material) {
    if (matcher == null) return true;
    if (typeof matcher === "string") {
      return name.toLowerCase().indexOf(matcher.toLowerCase()) >= 0;
    }
    if (matcher instanceof RegExp) {
      matcher.lastIndex = 0;
      var hit = matcher.test(name);
      matcher.lastIndex = 0;
      return hit;
    }
    if (typeof matcher === "function") return !!matcher(name, material);
    if (Object.prototype.toString.call(matcher) === "[object Array]") {
      for (var i = 0; i < matcher.length; i++) {
        if (matchName(matcher[i], name, material)) return true;
      }
    }
    return false;
  }

  /**
   * 找第一个匹配的材质。默认只在"表面材质"里找（跳过描边克隆）。
   * @param matcher 字符串（不区分大小写子串）/ 正则 / function(name, material) / 数组
   * @param opts { includeOutline?:boolean, outlineOnly?:boolean, meshName?:string }
   * @returns THREE.Material|null
   */
  api.findMaterial = function (vrmOrScene, matcher, opts) {
    opts = opts || {};
    var list = api.collectMaterials(vrmOrScene);
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (!opts.includeOutline) {
        if (e.isOutline) continue;
      }
      if (opts.outlineOnly && !e.isOutline) continue;
      if (opts.meshName != null && !matchName(opts.meshName, e.mesh && e.mesh.name || "")) continue;
      if (matchName(matcher, e.name, e.material)) return e.material;
    }
    return null;
  };

  /** 找全部匹配材质 */
  api.findMaterials = function (vrmOrScene, matcher, opts) {
    opts = opts || {};
    var list = api.collectMaterials(vrmOrScene);
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (!opts.includeOutline && e.isOutline) continue;
      if (opts.outlineOnly && !e.isOutline) continue;
      if (opts.meshName != null && !matchName(opts.meshName, e.mesh && e.mesh.name || "")) continue;
      if (matchName(matcher, e.name, e.material)) out.push(e.material);
    }
    return out;
  };

  /** 找某个表面材质对应的描边材质（同 mesh 的 material 数组，或 "<name> (Outline)"） */
  api.findOutline = function (vrmOrScene, materialOrName) {
    var list = api.collectMaterials(vrmOrScene);
    var target = null;
    if (typeof materialOrName === "string") {
      for (var i = 0; i < list.length; i++) {
        if (!list[i].isOutline && list[i].name === materialOrName) { target = list[i]; break; }
      }
      if (!target) {
        // 字符串也可能是模糊匹配
        var m = api.findMaterial(vrmOrScene, materialOrName);
        if (m) target = { material: m, name: m.name || "", mesh: null };
      }
    } else if (materialOrName && materialOrName.isMaterial !== false) {
      for (var j = 0; j < list.length; j++) {
        if (!list[j].isOutline && list[j].material === materialOrName) { target = list[j]; break; }
      }
    }
    if (!target) return null;

    // 1) 同一个 mesh 的 material 数组里找
    var mesh = target.mesh;
    if (mesh && Object.prototype.toString.call(mesh.material) === "[object Array]") {
      for (var k = 0; k < mesh.material.length; k++) {
        if (isOutlineMat(mesh.material[k])) return mesh.material[k];
      }
    }
    // 2) 按名字找
    if (target.name) {
      for (var n = 0; n < list.length; n++) {
        if (list[n].isOutline && list[n].name === target.name + " (Outline)") return list[n].material;
      }
    }
    return null;
  };

  /* ================================================================ *
   * 2. 染色（发色 / 瞳色 / 衣服色）
   * ================================================================ */

  /**
   * 按材质名批量染色。推荐用法：
   *   头发  tintByMaterialName(vrm, /hair/i, 0x5b8fe8, { shade: 0.60, rim: 0.22 })
   *   衣服  tintByMaterialName(vrm, /cloth/i, 0x2f4f9e, { shade: 0.55, rim: 0.12 })
   *   皮肤  tintByMaterialName(vrm, /skin/i, 0xffe3d6, { shade: 0.86, outlineMix: 0.22 })
   *   眼睛  tintByMaterialName(vrm, /iris/i, 0x8fd8ff, { shade: false, rim: false, outline: false })
   *
   * matcher 匹配的是"表面材质名"；描边克隆不会被当成目标，但会同步改 outlineColorFactor。
   * 颜色以 hex/字符串传入时按 sRGB 解释并转线性（和 glTF factor 的存储空间一致）；
   * 传 THREE.Color 则原样使用。
   *
   * @param opts {
   *   shade?: number|false       shadeColorFactor = tint × shade；false=不改；默认 0.62
   *   shadeTint?: 颜色           暗面往这个颜色偏（默认 #2a2438 冷紫）
   *   shadeTintMix?: number     默认 0.18
   *   rim?: number|false         parametricRimColorFactor = tint × rim（0~1，默认不改）
   *   rimColor?: 颜色            直接指定 rim 颜色（优先于 rim 倍率）
   *   rimFresnel?: number        parametricRimFresnelPowerFactor，默认 3.5
   *   rimLift?: number           parametricRimLiftFactor，默认 0.10
   *   rimLightingMix?: number    rimLightingMixFactor，0=不受光照（手办感），默认 0
   *   outline?: boolean          是否同步改配对描边的颜色，默认 true
   *   outlineMix?: number        描边色 = tint × outlineMix，默认 0.30
   *   outlineInk?: 颜色          描边往这个墨色偏，默认 #1a1420
   *   outlineInkMix?: number     默认 0.15
   *   includeOutline?: boolean   是否把"名字匹配到的描边材质"也当目标，默认 false
   *   multiply?: boolean         是否覆盖 material.color（litFactor）；false=只改 shade/rim，默认 true
   * }
   * @returns {number} 改到的表面材质数
   */
  api.tintByMaterialName = function (vrmOrScene, matcher, color, opts) {
    opts = opts || {};
    var tint = toColor(color);
    if (!tint) return 0;

    var shade = null;
    if (opts.shade !== false) {
      shade = tint.clone().multiplyScalar(opts.shade == null ? 0.62 : opts.shade);
      if (opts.shadeTint !== false) {
        var shadeTint = toColor(opts.shadeTint == null ? 0x2a2438 : opts.shadeTint);
        if (shadeTint) shade.lerp(shadeTint, opts.shadeTintMix == null ? 0.18 : opts.shadeTintMix);
      }
    }

    var rimColor = null;
    if (opts.rim !== false) {
      if (opts.rimColor != null) rimColor = toColor(opts.rimColor);
      else if (typeof opts.rim === "number") rimColor = tint.clone().multiplyScalar(opts.rim);
    }

    var outlineColor = null;
    if (opts.outline !== false) {
      outlineColor = inkFrom(
        tint,
        opts.outlineMix == null ? 0.30 : opts.outlineMix,
        opts.outlineInk == null ? 0x1a1420 : opts.outlineInk,
        opts.outlineInkMix == null ? 0.15 : opts.outlineInkMix
      );
    }

    var list = api.collectMaterials(vrmOrScene);
    var count = 0;

    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      var m = e.material;
      if (!matchName(matcher, e.name, m)) continue;

      if (e.isOutline) {
        if (!opts.includeOutline) continue;
        if (outlineColor && m.outlineColorFactor) m.outlineColorFactor.copy(outlineColor);
        count++;
        continue;
      }

      if (opts.multiply !== false && m.color) m.color.copy(tint);
      if (shade && m.shadeColorFactor) m.shadeColorFactor.copy(shade);
      if (rimColor && m.parametricRimColorFactor) {
        m.parametricRimColorFactor.copy(rimColor);
        if (opts.rimFresnel != null) m.parametricRimFresnelPowerFactor = opts.rimFresnel;
        if (opts.rimLift != null) m.parametricRimLiftFactor = opts.rimLift;
        if (opts.rimLightingMix != null) m.rimLightingMixFactor = opts.rimLightingMix;
      }

      // 同步配对描边
      if (outlineColor) {
        var om = api.findOutline(vrmOrScene, m);
        if (om && om !== m) om.outlineColorFactor.copy(outlineColor);
      }
      count++;
    }

    if (!count) warnOnce("tint:" + String(matcher), "没有材质匹配 " + String(matcher) + "（可用 listMaterials() 看名字）");
    return count;
  };

  /**
   * 逐像素重绘材质贴图（用于瞳色、蓝发这类"贴图本身有颜色"的材质，
   * 只乘 material.color 会发脏/发灰）。原理：把 map.image 画进 canvas，
   * 逐像素转 HSL，只换色相/按比例改饱和度，保留明度（=贴图细节），再生成 CanvasTexture。
   *
   * 注意：
   *  - 需要浏览器 canvas；headless 无 document 时返回 false。
   *  - 会复制贴图的 colorSpace/flipY/wrap/offset/repeat，并 material.needsUpdate = true。
   *  - 原贴图不会被 dispose（可能被其它材质共享），回滚用 restoreMap(material)。
   *
   * @param opts { hue?: 0~1 目标色相（默认取 color 的色相）, saturation?: 0~1 目标饱和度（默认保留原饱和度 × 系数）,
   *               satMul?: number 默认 1, lightness?: number 覆盖明度, lightMul?: number 默认 1,
   *               alpha?: 'keep'|'max' 默认 keep }
   * @returns boolean
   */
  api.recolorMap = function (material, color, opts) {
    opts = opts || {};
    if (!material || !material.map || !material.map.image) return false;
    if (typeof document === "undefined") {
      warnOnce("recolor:no-doc", "recolorMap 需要浏览器 canvas（document 不存在）");
      return false;
    }
    var src = material.map;
    var img = src.image;
    var w = img.width || img.videoWidth || 0;
    var h = img.height || img.videoHeight || 0;
    if (!w || !h) return false;

    var canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext("2d");
    if (!ctx) return false;
    ctx.drawImage(img, 0, 0, w, h);

    var target = toColor(color);
    if (!target) return false;
    var hsl = {};
    // getHSL 的 colorSpace 参数在 r166 存在；老版本忽略第二参也能跑
    try { target.getHSL(hsl, THREE.SRGBColorSpace); }
    catch (e) { target.getHSL(hsl); }

    var wantHue = opts.hue != null ? opts.hue : hsl.h;
    var wantSat = opts.saturation != null ? opts.saturation : null;
    var satMul = opts.satMul == null ? 1 : opts.satMul;
    var lightMul = opts.lightMul == null ? 1 : opts.lightMul;
    var lightSet = opts.lightness != null ? opts.lightness : null;

    var imageData;
    try { imageData = ctx.getImageData(0, 0, w, h); }
    catch (e) { return false; } // 跨域图会抛 SecurityError

    var d = imageData.data;
    for (var i = 0; i < d.length; i += 4) {
      var r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
      var m = Math.max(r, g, b), n = Math.min(r, g, b);
      var l = (m + n) * 0.5;
      var s = 0, hh = 0;
      if (m !== n) {
        var delta = m - n;
        s = l <= 0.5 ? delta / (m + n) : delta / (2 - m - n);
        if (m === r) hh = (g - b) / delta + (g < b ? 6 : 0);
        else if (m === g) hh = (b - r) / delta + 2;
        else hh = (r - g) / delta + 4;
        hh /= 6;
      }
      var outL = lightSet != null ? lightSet : Math.min(1, Math.max(0, l * lightMul));
      var outS = wantSat != null ? wantSat : Math.min(1, Math.max(0, s * satMul));
      // HSL -> RGB（sRGB 空间，canvas 就是 sRGB）
      var q = outL <= 0.5 ? outL * (1 + outS) : outL + outS - outL * outS;
      var p = 2 * outL - q;
      d[i] = 255 * hueToRgb(p, q, wantHue + 1 / 3);
      d[i + 1] = 255 * hueToRgb(p, q, wantHue);
      d[i + 2] = 255 * hueToRgb(p, q, wantHue - 1 / 3);
      if (opts.alpha === "max" && d[i + 3] > 0) d[i + 3] = 255;
    }
    ctx.putImageData(imageData, 0, 0);

    var tex = new THREE.CanvasTexture(canvas);
    tex.name = (src.name || "map") + "_recolored";
    tex.colorSpace = src.colorSpace != null ? src.colorSpace : THREE.SRGBColorSpace;
    tex.flipY = src.flipY;
    tex.wrapS = src.wrapS;
    tex.wrapT = src.wrapT;
    tex.offset.copy(src.offset);
    tex.repeat.copy(src.repeat);
    tex.center.copy(src.center);
    tex.rotation = src.rotation;
    tex.matrixAutoUpdate = src.matrixAutoUpdate;
    tex.channel = src.channel;
    if (src.anisotropy) tex.anisotropy = src.anisotropy;
    tex.needsUpdate = true;

    if (!material.userData) material.userData = {};
    if (!material.userData.vrmStyleOrigMap) material.userData.vrmStyleOrigMap = src;
    material.map = tex;
    material.needsUpdate = true;
    return true;
  };

  /** 还原 recolorMap 改过的贴图 */
  api.restoreMap = function (material) {
    if (!material || !material.userData || !material.userData.vrmStyleOrigMap) return false;
    material.map = material.userData.vrmStyleOrigMap;
    delete material.userData.vrmStyleOrigMap;
    material.needsUpdate = true;
    return true;
  };

  /** HSL 辅助（recolorMap 内部用） */
  function hueToRgb(p, q, t) {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  }

  /* ================================================================ *
   * 3. 描边：像素 -> MToon 参数
   * ================================================================ */

  /**
   * 把"我要 N 像素描边"换算成 MToon 的 outlineWidthFactor。
   *
   * 依据（three-vrm 3.5.5 的 mtoon.vert / mtoon.frag 推导）：
   *  - screenCoordinates：顶点沿法线外扩后在 NDC 里的偏移量 = outlineWidthFactor，
   *    NDC 全高 2 对应屏幕高 H，所以  px = w × H / 2
   *    => w = 2·px / H（与模型缩放、相机距离无关）
   *  - worldCoordinates：外扩量已按 normalMatrix 长度补偿，最终世界厚度 = w（米），
   *    相机垂直取景高度 = stageHeightWorld × margin，
   *    所以  px = w × H / (stageHeightWorld × margin)
   *    => w = px × stageHeightWorld × margin / H
   *    （与模型缩放无关：三个 vrmchar 把 VRM 放大到 4.4 也不会让世界描边变粗）
   *
   * @param opts { px?:number=1.2, mode?:'screen'|'world'=('screen'),
   *               viewportHeightPx?:number=300, stageHeightWorld?:number=4.4, margin?:number=1.06 }
   * @returns number
   */
  api.outlineFactorForPx = function (opts) {
    opts = opts || {};
    var px = opts.px == null ? 1.2 : opts.px;
    var h = opts.viewportHeightPx == null ? 300 : opts.viewportHeightPx;
    var mode = opts.mode || "screen";
    if (h <= 0) return 0;
    if (mode === "world" || mode === "worldCoordinates") {
      var world = opts.stageHeightWorld == null ? 4.4 : opts.stageHeightWorld;
      var margin = opts.margin == null ? 1.06 : opts.margin;
      return (px * world * margin) / h;
    }
    return (2 * px) / h;
  };

  /**
   * 统一设置描边宽度/颜色/模式（只处理已存在的描边材质；VRM1 里由 loader 生成）。
   * vrmchar.js 的 setupMaterials() 会在模型自带描边时 ×outlineGain，建议二选一：
   *  - 继续用 vrmchar：把 cfg.outlineGain 调到 outlineFactorForPx(...) / 模型原始宽度
   *  - 用本函数：在 vrmchar 挂载后调用 setOutline() 覆盖绝对宽度（推荐，可读性好）
   *
   * @param opts { px?:number=1.2, mode?:'screen'|'world', viewportHeightPx?:number=300,
   *               stageHeightWorld?:number=4.4, margin?:number=1.06,
   *               factor?:number 直接指定、gain?:number 在换算值上再乘、color?:颜色、
   *               lightingMix?:number、skip?:RegExp|string 跳过名字匹配的描边、
   *               createMissing?:boolean 给没有描边的表面材质补壳（默认 false，实验性）,
   *               createSkip?:RegExp 补壳时跳过的材质名（默认脸/眼/眉/嘴/高光）,
   *               createWidthFactor?:number 补壳用的 factor（默认同 factor）}
   * @returns {{count:number, mode:string, widthFactor:number, created:number}}
   */
  api.setOutline = function (vrmOrScene, opts) {
    opts = opts || {};
    var mode = opts.mode === "world" || opts.mode === "worldCoordinates" ? "worldCoordinates" : "screenCoordinates";
    var factor = opts.factor != null
      ? opts.factor
      : api.outlineFactorForPx({
          px: opts.px,
          mode: mode,
          viewportHeightPx: opts.viewportHeightPx,
          stageHeightWorld: opts.stageHeightWorld,
          margin: opts.margin,
        });
    if (opts.gain) factor *= opts.gain;

    var color = toColor(opts.color);
    var skip = opts.skip || null;
    var stats = { count: 0, mode: mode, widthFactor: factor, created: 0 };
    var list = api.collectMaterials(vrmOrScene);

    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      var m = e.material;
      if (!e.isOutline) continue;
      if (skip && matchName(skip, e.name)) continue;
      m.outlineWidthMode = mode;
      m.outlineWidthFactor = factor;
      if (color && m.outlineColorFactor) m.outlineColorFactor.copy(color);
      if (opts.lightingMix != null) m.outlineLightingMixFactor = opts.lightingMix;
      stats.count++;
    }

    if (opts.createMissing) {
      var createSkip = opts.createSkip || /face|eye|mouth|brow|lash|highlight|tear|iris|pupil|tongue/i;
      var createFactor = opts.createWidthFactor == null ? factor : opts.createWidthFactor;
      for (var s = 0; s < list.length; s++) {
        var se = list[s];
        if (se.isOutline || !se.isMToon) continue;
        var mesh = se.mesh;
        if (!mesh || Object.prototype.toString.call(mesh.material) === "[object Array]") continue;
        if (createSkip && matchName(createSkip, se.name)) continue;
        if (createSkip && matchName(createSkip, (mesh.name || ""))) continue;
        try {
          var om = se.material.clone();
          om.name = (se.material.name || "mtoon") + " (Outline)";
          om.isOutline = true;
          om.side = THREE.BackSide;
          om.outlineWidthMode = mode;
          om.outlineWidthFactor = createFactor;
          om.outlineLightingMixFactor = opts.createLightingMix == null ? 0 : opts.createLightingMix;
          if (color && om.outlineColorFactor) om.outlineColorFactor.copy(color);
          var geo = mesh.geometry;
          if (!geo || (geo.groups && geo.groups.length > 1)) continue; // 多 primitive 的保护
          mesh.material = [se.material, om];
          if (geo) {
            var count = geo.index ? geo.index.count : geo.attributes.position.count;
            geo.clearGroups();
            geo.addGroup(0, count, 0);
            geo.addGroup(0, count, 1);
          }
          stats.created++;
          stats.count++;
        } catch (err) {
          warnOnce("outline:create", "补描边失败：" + (err && err.message));
        }
      }
    }
    return stats;
  };

  /* ================================================================ *
   * 4. 配件挂骨
   * ================================================================ */

  /** 取骨骼节点：默认 raw（真正参与蒙皮/动画的那棵），可选 normalized */
  api.getBone = function (vrm, boneName, opts) {
    opts = opts || {};
    if (!vrm || !vrm.humanoid) return null;
    try {
      if (opts.normalized) return vrm.humanoid.getNormalizedBoneNode(boneName) || null;
      return vrm.humanoid.getRawBoneNode(boneName) || null;
    } catch (e) {
      return null;
    }
  };

  function attachmentsOf(vrm) {
    var scene = sceneOf(vrm);
    if (!scene) return null;
    if (!scene.userData) scene.userData = {};
    if (!scene.userData.vrmStyleAttachments) scene.userData.vrmStyleAttachments = [];
    return scene.userData.vrmStyleAttachments;
  }

  /**
   * 把 Object3D 挂到 humanoid 骨骼上（跟随动画）。挂的是 raw 骨：
   * 归一化骨是 loader 额外建的 Object3D 树、不在场景里，挂上去不会跟着模型渲染。
   *
   * @param vrm       VRM 实例
   * @param boneName  VRMHumanBoneName，如 'head' / 'hips' / 'chest'
   * @param object3D  THREE.Object3D（配件根节点）
   * @param offset    位置：THREE.Vector3 / [x,y,z] / {x,y,z}
   *                  或 { position:[x,y,z], rotation:[x,y,z]（欧拉弧度）/quaternion:[x,y,z,w],
   *                       scale:number|[x,y,z] }
   *                  或 null
   * @param opts      { space?:'bone'|'world'（默认 bone，即骨骼局部坐标）,
   *                    normalized?:boolean 挂归一化骨（调试用，默认 false）,
   *                    frustumCulled?:boolean 默认 false（骨骼动画后包围盒会过期）,
   *                    keepWorldTransform?:boolean 默认 false }
   * @returns Object3D|null
   */
  api.attachToBone = function (vrm, boneName, object3D, offset, opts) {
    opts = opts || {};
    if (!object3D || !object3D.isObject3D) {
      warnOnce("attach:obj", "attachToBone 需要一个 THREE.Object3D");
      return null;
    }
    var bone = api.getBone(vrm, boneName, opts);
    if (!bone) {
      warnOnce("attach:bone:" + boneName, "找不到骨骼 " + boneName + "（用 listHumanoidBones() 看可用名字）");
      return null;
    }

    var pos = null, quat = null, scl = null;
    if (offset != null) {
      if (offset.isVector3 || typeof offset === "number") {
        pos = coerceVector3(offset);
      } else if (Object.prototype.toString.call(offset) === "[object Array]") {
        pos = coerceVector3(offset);
      } else {
        pos = coerceVector3(offset.position);
        if (offset.rotation != null) {
          var rot = offset.rotation;
          var euler = rot.isEuler ? rot : new THREE.Euler().fromArray(rot);
          quat = new THREE.Quaternion().setFromEuler(euler);
        }
        if (offset.quaternion != null) {
          quat = offset.quaternion.isQuaternion
            ? offset.quaternion.clone()
            : new THREE.Quaternion().fromArray(offset.quaternion);
        }
        if (offset.scale != null) {
          scl = typeof offset.scale === "number"
            ? new THREE.Vector3(offset.scale, offset.scale, offset.scale)
            : coerceVector3(offset.scale);
        }
      }
    }

    if (object3D.parent) object3D.parent.remove(object3D);

    if (pos || quat) {
      if (opts.space === "world") {
        // 注意：VRM 的骨骼 rest 朝向因模型而异（VRoid 的 head 骨 local 轴不是世界轴），
        // 所以配件推荐用 space:"world" —— 位置按"世界方向的位移"给，朝向按"世界朝向"给。
        bone.updateWorldMatrix(true, false);
        var bq = new THREE.Quaternion();
        var bp = new THREE.Vector3();
        var bs = new THREE.Vector3();
        bone.matrixWorld.decompose(bp, bq, bs);
        var invBq = bq.clone().invert();
        if (pos) {
          // 世界位移 -> 骨骼 local 位移（除以骨骼世界缩放；Q 版 head.scale 也会被正确抵消）
          var localPos = pos.clone().applyQuaternion(invBq);
          localPos.x /= (Math.abs(bs.x) > 1e-8 ? bs.x : 1);
          localPos.y /= (Math.abs(bs.y) > 1e-8 ? bs.y : 1);
          localPos.z /= (Math.abs(bs.z) > 1e-8 ? bs.z : 1);
          object3D.position.copy(localPos);
        }
        // 世界朝向 -> 骨骼 local 朝向：q_local = q_boneWorld⁻¹ × q_world
        var worldQ = quat ? quat.clone() : new THREE.Quaternion();
        object3D.quaternion.copy(invBq).multiply(worldQ);
      } else {
        if (pos) object3D.position.copy(pos);
        if (quat) object3D.quaternion.copy(quat);
      }
    }
    if (scl) object3D.scale.copy(scl);

    // 骨骼动画的包围盒会过期，配件统一关掉剔除（和 three-vrm 官方示例对 VRM 场景的做法一致）
    if (opts.frustumCulled !== false) object3D.frustumCulled = false;
    if (opts.keepWorldTransform) {
      // no-op：保留字段方便以后实现
    }

    bone.add(object3D);
    object3D.userData = object3D.userData || {};
    object3D.userData.vrmStyleBone = boneName;

    var attachments = attachmentsOf(vrm);
    if (attachments) attachments.push({ object: object3D, bone: bone, boneName: boneName });
    return object3D;
  };

  /** 从骨骼上摘下来（不 dispose；需要的话调用方自己 dispose 几何/材质） */
  api.detach = function (object3D) {
    if (!object3D) return false;
    if (object3D.parent) object3D.parent.remove(object3D);
    return true;
  };

  /** 摘掉所有通过本模块挂上去的配件 */
  api.detachAll = function (vrm) {
    var scene = sceneOf(vrm);
    var attachments = scene && scene.userData && scene.userData.vrmStyleAttachments;
    if (!attachments || !attachments.length) return 0;
    var n = 0;
    for (var i = 0; i < attachments.length; i++) {
      var obj = attachments[i].object;
      if (obj && obj.parent) { obj.parent.remove(obj); n++; }
    }
    attachments.length = 0;
    return n;
  };

  /* ================================================================ *
   * 5. 表情 / 骨骼
   * ================================================================ */

  /**
   * 设置表情权重。name 是 VRM 里的真实表情名（预设：aa/ih/ou/ee/oh/blink/happy/angry/
   * sad/relaxed/lookUp/lookDown/lookLeft/lookRight/blinkLeft/blinkRight/neutral/surprised）。
   * @returns boolean 是否成功（表情不存在返回 false，不抛错）
   */
  api.setExpression = function (vrm, name, weight) {
    if (!vrm || !vrm.expressionManager || !name) return false;
    var mgr = vrm.expressionManager;
    try {
      if (typeof mgr.getExpression === "function" && !mgr.getExpression(name)) return false;
      var w = typeof weight === "number" ? weight : 0;
      mgr.setValue(name, Math.max(0, Math.min(1, w)));
      return true;
    } catch (e) {
      warnOnce("expr:" + name, "setExpression 失败：" + (e && e.message));
      return false;
    }
  };

  /** 一次设多个表情：{ happy: 0.8, blink: 0.1 } */
  api.setExpressions = function (vrm, map) {
    var n = 0;
    for (var name in map) {
      if (api.setExpression(vrm, name, map[name])) n++;
    }
    return n;
  };

  /** 列出模型实际拥有的表情名 */
  api.listExpressions = function (vrm) {
    if (!vrm || !vrm.expressionManager) return [];
    var mgr = vrm.expressionManager;
    var out = [];
    try {
      if (mgr.expressions && mgr.expressions.length != null) {
        for (var i = 0; i < mgr.expressions.length; i++) out.push(mgr.expressions[i].expressionName);
      } else if (mgr.expressionMap) {
        for (var name in mgr.expressionMap) out.push(name);
      }
    } catch (e) { /* ignore */ }
    return out;
  };

  /** 列出模型有的 humanoid 骨骼名（字符串数组，顺序同 VRMHumanBoneList） */
  api.listHumanoidBones = function (vrm) {
    if (!vrm || !vrm.humanoid) return [];
    var out = [];
    try {
      var map = vrm.humanoid.humanBones || vrm.humanoid.rawHumanBones;
      for (var name in map) {
        if (map[name] && map[name].node) out.push(name);
      }
    } catch (e) { /* ignore */ }
    return out;
  };

  /** 骨骼详情：[{ name, raw, normalized }]（调试用） */
  api.listHumanoidBoneNodes = function (vrm) {
    var names = api.listHumanoidBones(vrm);
    var out = [];
    for (var i = 0; i < names.length; i++) {
      out.push({
        name: names[i],
        raw: api.getBone(vrm, names[i]),
        normalized: api.getBone(vrm, names[i], { normalized: true }),
      });
    }
    return out;
  };

  /* ================================================================ *
   * 6. SpringBone：缩放补偿 + 手办化调参
   * ================================================================ */

  /**
   * 缩放模型后必须按官方 guide 补偿 SpringBone：
   * https://github.com/pixiv/three-vrm/blob/v3.5.5/guides/spring-bones-on-scaled-models.md
   *   joint.settings.stiffness *= scale; joint.settings.hitRadius *= scale;
   *   collider.shape.radius *= scale; collider.shape.tail *= scale;
   * 否则头发会"反应快/慢得不对"、碰撞体积也错。
   *
   * @param scale 模型 scene.scale 的数值（vrmchar 里是 targetHeight / rawHeight）
   * @param opts  { stiffnessMul?:number 额外刚度倍率（小窗口想更稳就 >1）,
   *                dragForce?:number 直接覆盖阻尼（想更"跟手"用 0.5~0.6）,
   *                dragMul?:number 阻尼倍率,
   *                gravityPower?:number 直接覆盖重力,
   *                gravityMul?:number 重力倍率（小窗口建议 0.2~0.6，头发别乱飘）,
   *                scaleColliders?:boolean 默认 true }
   * @returns {{joints:number, colliders:number, stiffness:number, hitRadius:number}}
   */
  api.scaleSpringBones = function (vrm, scale, opts) {
    opts = opts || {};
    var stats = { joints: 0, colliders: 0, stiffness: scale, hitRadius: scale };
    var mgr = vrm && vrm.springBoneManager;
    if (!mgr || !(scale > 0)) return stats;
    var s = scale;
    var stiffMul = opts.stiffnessMul == null ? 1 : opts.stiffnessMul;

    try {
      if (mgr.joints && typeof mgr.joints.forEach === "function") {
        mgr.joints.forEach(function (joint) {
          var st = joint && joint.settings;
          if (!st) return;
          if (typeof st.stiffness === "number") st.stiffness *= s * stiffMul;
          if (typeof st.hitRadius === "number") st.hitRadius *= s;
          if (opts.dragForce != null) st.dragForce = opts.dragForce;
          else if (opts.dragMul != null && typeof st.dragForce === "number") st.dragForce *= opts.dragMul;
          if (opts.gravityPower != null) st.gravityPower = opts.gravityPower;
          else if (opts.gravityMul != null && typeof st.gravityPower === "number") st.gravityPower *= opts.gravityMul;
          stats.joints++;
        });
      }
      if (opts.scaleColliders !== false && mgr.colliders) {
        var colliders = mgr.colliders;
        for (var i = 0; i < colliders.length; i++) {
          var shape = colliders[i] && colliders[i].shape;
          if (!shape) continue;
          if (typeof shape.radius === "number") shape.radius *= s;
          if (shape.tail && typeof shape.tail.multiplyScalar === "function") shape.tail.multiplyScalar(s);
          if (opts.scaleOffset && shape.offset && typeof shape.offset.multiplyScalar === "function") {
            shape.offset.multiplyScalar(s);
          }
          stats.colliders++;
        }
      }
    } catch (e) {
      warnOnce("spring", "scaleSpringBones 失败：" + (e && e.message));
    }
    return stats;
  };

  /**
   * 手办化弹簧参数（在 scaleSpringBones 之后调用，或对未缩放模型单独用）。
   * 小窗口的诉求：别抖、别飘、动作幅度小 → 刚度/阻尼↑，重力↓。
   * @param opts { stiffnessMul?:number=1.15, dragForce?:number=0.5, dragMul?:number,
   *               gravityPower?:number, gravityMul?:number=0.35,
   *               hairOnly?:boolean=false（按骨名/comment 过滤 hair） }
   */
  api.setSpringStyle = function (vrm, opts) {
    opts = opts || {};
    var stats = { joints: 0 };
    var mgr = vrm && vrm.springBoneManager;
    if (!mgr || !mgr.joints) return stats;
    var stiffMul = opts.stiffnessMul == null ? 1.15 : opts.stiffnessMul;
    var dragMul = opts.dragMul == null ? 1 : opts.dragMul;
    var gravMul = opts.gravityMul == null ? 0.35 : opts.gravityMul;
    try {
      mgr.joints.forEach(function (joint) {
        var st = joint && joint.settings;
        if (!st) return;
        if (typeof st.stiffness === "number") st.stiffness *= stiffMul;
        if (opts.dragForce != null) st.dragForce = opts.dragForce;
        else if (typeof st.dragForce === "number") st.dragForce *= dragMul;
        if (opts.gravityPower != null) st.gravityPower = opts.gravityPower;
        else if (typeof st.gravityPower === "number") st.gravityPower *= gravMul;
        stats.joints++;
      });
    } catch (e) {
      warnOnce("spring2", "setSpringStyle 失败：" + (e && e.message));
    }
    return stats;
  };

  /** SpringBone 快照（调试/验收）：[{ bone, stiffness, dragForce, gravityPower, hitRadius }] */
  api.listSpringBones = function (vrm) {
    var out = [];
    var mgr = vrm && vrm.springBoneManager;
    if (!mgr || !mgr.joints) return out;
    try {
      mgr.joints.forEach(function (joint) {
        var st = joint.settings || {};
        out.push({
          bone: joint.bone && joint.bone.name,
          stiffness: st.stiffness,
          dragForce: st.dragForce,
          gravityPower: st.gravityPower,
          gravityDir: st.gravityDir && st.gravityDir.toArray ? st.gravityDir.toArray() : null,
          hitRadius: st.hitRadius,
        });
      });
    } catch (e) { /* ignore */ }
    return out;
  };

  /* ================================================================ *
   * 7. 预设：一套"精修手办"MToon 参数
   * ================================================================ */

  /**
   * 默认观感预设。按材质类别给 shading/rim/gi，值已按 200~300px 桌面窗口调过：
   *  - face/eye 类一律"打平"（shadingShift ≥ +0.6），小窗口上脸不能有明暗分界
   *  - hair 给 rim + 轻微 matcap 天使环，靠轮廓光和 UI 背景分开
   *  - 衣服/身体：阴影硬一点（shadingToony 0.92），rim 弱一点
   * 参数含义（three-vrm 3.5.5 / MToon 1.0）：
   *  - shadingShiftFactor：明暗分界线上下平移；越大越"亮"（VRM0 face 常见 -0.8 → 转换后 +0.7）
   *  - shadingToonyFactor：分界软硬；1=硬切，0=线性（默认 0.9）
   *  - giEqualizationFactor：环境光"抹平"程度（0=按法线，1=完全平均）
   *  - parametricRim*：rim = color × saturate(1 - dot(V,N) + lift) ^ fresnel；
   *    rimLightingMixFactor=0 时不受灯光影响（稳定"轮廓线"），=1 时只在受光处出现
   */
  api.PRESETS = {
    figure: {
      skin:  { shadingShift: 0.30, shadingToony: 0.92, giEqualization: 0.75, rim: 0.10, rimFresnel: 4.0 },
      face:  { shadingShift: 0.72, shadingToony: 0.96, giEqualization: 0.90, rim: 0.00 },
      iris:  { shadingShift: 0.95, shadingToony: 1.00, giEqualization: 1.00, rim: 0.00 },
      hair:  { shadingShift: -0.12, shadingToony: 0.94, giEqualization: 0.90, rim: 0.22, rimFresnel: 3.2, rimLift: 0.12, matcap: 0.30 },
      cloth: { shadingShift: -0.04, shadingToony: 0.92, giEqualization: 0.90, rim: 0.14, rimFresnel: 3.6 },
      other: { shadingShift: -0.05, shadingToony: 0.92, giEqualization: 0.90, rim: 0.10 },
      rimLightingMix: 0,
      outline: { px: 1.2 },
    },
  };

  /** 按材质名粗分类（VRoid 命名 + 通用命名都覆盖） */
  function classify(name) {
    var n = String(name || "");
    if (/eye[\s_-]*white|eyewhite|eye_white/i.test(n)) return "eyeWhite";
    if (/eye[\s_-]*highlight|eyehighlight/i.test(n)) return "eyeHighlight";
    if (/iris|pupil|eyeextra|^eye$|^eye[_-]/i.test(n)) return "iris";
    if (/face[\s_-]*(mouth|eyeline|eyelash|brow)|mouth|brow|lash|eyeline|tooth|tongue/i.test(n)) return "faceLine";
    if (/face[\s_-]*\d*[\s_-]*skin|face_00|^face$|robo[\s_-]*face/i.test(n)) return "face";
    if (/hair/i.test(n)) return "hair";
    if (/_skin$|body[\s_-]?skin|body_00/i.test(n)) return "skin";
    if (/cloth|clothes|tops|bottoms|shoes|socks|huku|wear|dress|skirt|uniform|apron|accessory|ribbon|neck/i.test(n)) return "cloth";
    return "other";
  }
  api.classify = classify;

  /** 给某材质套一组 {shadingShift, shadingToony, giEqualization, rim, rimFresnel, rimLift, matcap} */
  function applyLookParams(material, p, preset) {
    if (!material || !p) return false;
    var m = material;
    if (!isMToon(m)) return false;
    if (p.shadingShift != null && m.shadingShiftFactor != null) m.shadingShiftFactor = p.shadingShift;
    if (p.shadingToony != null && m.shadingToonyFactor != null) m.shadingToonyFactor = p.shadingToony;
    if (p.giEqualization != null && m.giEqualizationFactor != null) m.giEqualizationFactor = p.giEqualization;
    if (p.rim != null && m.parametricRimColorFactor) {
      if (p.rim <= 0) {
        m.parametricRimColorFactor.setRGB(0, 0, 0);
      } else {
        m.parametricRimColorFactor.setRGB(p.rim, p.rim, p.rim);
        if (p.rimFresnel != null) m.parametricRimFresnelPowerFactor = p.rimFresnel;
        if (p.rimLift != null) m.parametricRimLiftFactor = p.rimLift;
        if (preset.rimLightingMix != null) m.rimLightingMixFactor = preset.rimLightingMix;
      }
    }
    if (p.matcap != null && m.matcapTexture === null) {
      var tex = api.matcapTexture();
      if (tex) {
        m.matcapTexture = tex;
        m.matcapFactor.setRGB(1, 1, 1);
        if (preset.rimLightingMix != null) m.rimLightingMixFactor = preset.rimLightingMix;
        m.needsUpdate = true; // matcapTexture 影响 USE_MATCAPTEXTURE define，必须重编译
      }
    }
    return true;
  }

  /**
   * 套预设（默认 figure）。按类别批量改 shading/rim/gi；可选按类别染色。
   * @param presetName 'figure' 或直接传 preset 对象
   * @param opts { tint?: { hair?:颜色, cloth?:颜色, skin?:颜色, iris?:颜色 },
   *               recolor?: { iris?:boolean（用 recolorMap 而不是乘法，瞳色更干净） },
   *               matcap?:boolean 是否给头发挂天使环（默认预设里 hair.matcap>0 就会挂） }
   * @returns {{count:number, byCategory:object}}
   */
  api.applyLookdev = function (vrmOrScene, presetName, opts) {
    opts = opts || {};
    var preset = typeof presetName === "string" ? api.PRESETS[presetName] : presetName;
    if (!preset) preset = api.PRESETS.figure;
    var list = api.collectMaterials(vrmOrScene);
    var stats = { count: 0, byCategory: {} };

    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (e.isOutline) continue;
      var cat = classify(e.name);
      var p = preset[cat] || preset.other;
      if (applyLookParams(e.material, p, preset)) {
        stats.count++;
        stats.byCategory[cat] = (stats.byCategory[cat] || 0) + 1;
      }
      // 眼睛白/高光/眼线：永远保持"打平 + 无rim/无描边色偏移"
      if (cat === "eyeWhite" || cat === "eyeHighlight" || cat === "faceLine") {
        var flat = preset.face || {};
        applyLookParams(e.material, flat, preset);
      }
    }

    if (opts.tint) {
      for (var key in opts.tint) {
        var matcher = TINT_MATCHERS[key];
        if (!matcher) continue;
        var col = opts.tint[key];
        if (key === "iris" && opts.recolor && opts.recolor.iris) {
          var irisMats = api.findMaterials(vrmOrScene, matcher);
          for (var k = 0; k < irisMats.length; k++) api.recolorMap(irisMats[k], col, { satMul: 1.0 });
        } else {
          api.tintByMaterialName(vrmOrScene, matcher, col, key === "iris" ? { shade: false, rim: false, outline: false } : undefined);
        }
      }
    }
    return stats;
  };

  var TINT_MATCHERS = {
    hair: /hair/i,
    cloth: /cloth|clothes|tops|bottoms|shoes|wear|huku|skirt|uniform/i,
    skin: /_skin$|body_00|body_?skin/i,
    iris: /iris|eye_?iris|pupil/i,
  };
  api.TINT_MATCHERS = TINT_MATCHERS;

  /* ================================================================ *
   * 8. 给配件用的材质 / 贴图工厂
   * ================================================================ */

  /**
   * 造一个和 VRM 观感一致的 MToon 材质（配件、角、发带、尾巴都用它）。
   * 优先用 VRMT.MToonMaterial；没有 VRMT 时退回 MeshBasicMaterial（无光照）。
   * @param opts { color, shadeColorFactor, rim, rimFresnel, rimLift, rimLightingMix,
   *               shadingShift, shadingToony, side, transparent, opacity, template }
   */
  api.makeMToonMaterial = function (opts) {
    opts = opts || {};
    var col = toColor(opts.color == null ? 0xffffff : opts.color);
    var Mat = VRMT && VRMT.MToonMaterial;
    if (Mat) {
      try {
        var params = {
          color: col,
          shadeColorFactor: opts.shadeColorFactor != null
            ? toColor(opts.shadeColorFactor)
            : col.clone().multiplyScalar(0.62),
          shadingShiftFactor: opts.shadingShift == null ? -0.1 : opts.shadingShift,
          shadingToonyFactor: opts.shadingToony == null ? 0.92 : opts.shadingToony,
          giEqualizationFactor: opts.giEqualization == null ? 0.85 : opts.giEqualization,
          parametricRimColorFactor: opts.rim != null ? toColor(opts.rim) : new THREE.Color(0.18, 0.18, 0.18),
          parametricRimFresnelPowerFactor: opts.rimFresnel == null ? 3.5 : opts.rimFresnel,
          parametricRimLiftFactor: opts.rimLift == null ? 0.1 : opts.rimLift,
          rimLightingMixFactor: opts.rimLightingMix == null ? 0 : opts.rimLightingMix,
        };
        if (opts.opacity != null) { params.opacity = opts.opacity; params.transparent = opts.opacity < 1; }
        if (opts.side != null) params.side = opts.side;
        return new Mat(params);
      } catch (e) {
        warnOnce("mtoon:new", "new MToonMaterial 失败，退回 Basic：" + (e && e.message));
      }
    }
    if (opts.template && typeof opts.template.clone === "function") {
      var clone = opts.template.clone();
      if (clone.color) clone.color.copy(col);
      return clone;
    }
    var basic = new THREE.MeshBasicMaterial({ color: col });
    if (opts.opacity != null) { basic.transparent = opts.opacity < 1; basic.opacity = opts.opacity; }
    if (opts.side != null) basic.side = opts.side;
    return basic;
  };

  /**
   * 生成"天使环"matcap 贴图（给头发用）。
   * MToon 的 matcap 是加到 rim 上的：rim += matcapFactor × texture(sphereUv)，
   * sphereUv 由视空间法线投影得到；所以横向亮带会在头发上形成一圈高光。
   * 想"稳定出现"必须把 rimLightingMixFactor 设为 0（否则 rim 受灯光 spec 调制）。
   *
   * @param opts { size?:256, band?:[v0,v1]=[0.16,0.30], soft?:0.06, strength?:0.55,
   *               flipY?:false（默认 false；若环位置上下反了改成 true 重生成） }
   * @returns THREE.CanvasTexture|null（无 document 时 null）
   */
  api.matcapTexture = function (opts) {
    if (api._matcapTex) return api._matcapTex;
    if (typeof document === "undefined") return null;
    opts = opts || {};
    var size = opts.size || 256;
    var band = opts.band || [0.16, 0.30];
    var soft = opts.soft == null ? 0.07 : opts.soft;
    var strength = opts.strength == null ? 0.55 : opts.strength;
    var canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    var ctx = canvas.getContext("2d");
    if (!ctx) return null;
    var img = ctx.createImageData(size, size);
    var d = img.data;
    for (var y = 0; y < size; y++) {
      var v = y / size; // flipY=false: canvas 顶部 = v=0
      var b = 0;
      var c0 = band[0], c1 = band[1];
      if (v >= c0 && v <= c1) {
        // 带内：中间亮，两边按 soft 衰减
        var mid = (c0 + c1) * 0.5;
        var half = (c1 - c0) * 0.5 + soft;
        var t = 1 - Math.min(1, Math.abs(v - mid) / half);
        b = t * t * (3 - 2 * t) * strength;
      } else if (v < c0) {
        var dd = c0 - v;
        if (dd < soft) b = (1 - dd / soft) * strength * 0.35;
      } else {
        var dd2 = v - c1;
        if (dd2 < soft) b = (1 - dd2 / soft) * strength * 0.35;
      }
      var val = Math.max(0, Math.min(255, Math.round(b * 255)));
      for (var x = 0; x < size; x++) {
        var idx = (y * size + x) * 4;
        // 轻微横向衰减，避免像一条硬直线
        var u = x / size;
        var fade = 1 - 0.35 * Math.pow(Math.abs(u - 0.5) * 2, 2);
        d[idx] = Math.round(val * fade);
        d[idx + 1] = Math.round(val * fade);
        d[idx + 2] = Math.round(val * fade);
        d[idx + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    var tex = new THREE.CanvasTexture(canvas);
    tex.name = "vrm-style-matcap";
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.flipY = opts.flipY === true;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.needsUpdate = true;
    api._matcapTex = tex;
    return tex;
  };

  /** 释放本模块缓存的共享贴图（换角色/卸载时调） */
  api.dispose = function () {
    if (api._matcapTex) {
      try { api._matcapTex.dispose(); } catch (e) { /* ignore */ }
      api._matcapTex = null;
    }
  };

  api.version = "1.0.0";
  return api;
};
