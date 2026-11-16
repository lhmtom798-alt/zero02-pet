/**
 * mmd-shade —— 让 MMD 02 从「MMD 平涂」变成「动画赛璐璐」质感。
 *
 * 做法：不换渲染管线，而是给 MMDToonMaterial 打补丁（onBeforeCompile），
 * 在原有着色基础上叠加：
 *   1) 边缘光（rim light）：头发/肩膀/角边缘亮一圈，动画片里很吃这个；
 *   2) 高光带（specular）：给头发/外套按视角做一道高光；
 *   3) 反向外壳描边：背面壳沿法线外扩，得到干净的动画描边。
 *
 * 注意：MMDToonMaterial 的 skinning/morph 由 three 自动处理，补丁只加计算，
 * 不动原有着色逻辑，所以骨骼动画、表情 morph 都不受影响。
 */
module.exports.create = function (THREE) {
  if (!THREE) throw new Error("[mmd-shade] 缺少 THREE");

  var PRESETS = {
    // 动画赛璐璐（默认）
    anime: {
      rimColor: 0xffd6e4, rimStrength: 0.45, rimPower: 2.8,
      specColor: 0xffffff, specStrength: 0.35, specPower: 40,
      outlineColor: 0x3a2431, outlineWidth: 0.032, outline: true,
      eyeScale: 1.26,
      hairSoftTips: true,
      skinTint: [1.04, 0.99, 1.02], hairTint: [1.05, 0.95, 1.0], clothTint: [1.04, 0.98, 0.99],
    },
    // 更柔和的插画风
    soft: {
      rimColor: 0xffe6ef, rimStrength: 0.3, rimPower: 3.2,
      specColor: 0xffffff, specStrength: 0.25, specPower: 60,
      outlineColor: 0x3a2733, outlineWidth: 0.024, outline: true,
      skinTint: [1.06, 1.0, 0.96], hairTint: [1.04, 0.96, 1.02], clothTint: [1.0, 0.99, 0.99],
    },
    // 关掉（用于对比/排查）
    off: {
      rimColor: 0xffffff, rimStrength: 0, rimPower: 2.6,
      specColor: 0xffffff, specStrength: 0, specPower: 46,
      outlineColor: 0x2b1922, outlineWidth: 0.032, outline: false,
      skinTint: [1, 1, 1], hairTint: [1, 1, 1], clothTint: [1, 1, 1],
    },
  };

  var built = [];   // 每个 mesh 的 { mesh, outlines: [], patched: n }

  function patchSurface(mat, cfg, scale) {
    if (!mat || mat.isOutline || mat.__mmdShadePatched) return false;
    mat.__mmdShadePatched = true;
    scale = scale || { rim: 1, spec: 1, flat: 0 };
    mat.userData.__mmdScale = scale;
    var prev = mat.onBeforeCompile;
    mat.onBeforeCompile = function (shader, renderer) {
      if (typeof prev === "function") prev.call(this, shader, renderer);
      shader.uniforms.uRimColor = { value: new THREE.Color(cfg.rimColor) };
      shader.uniforms.uRimStrength = { value: cfg.rimStrength * scale.rim };
      shader.uniforms.uRimPower = { value: cfg.rimPower };
      shader.uniforms.uSpecColor = { value: new THREE.Color(cfg.specColor) };
      shader.uniforms.uSpecStrength = { value: cfg.specStrength * scale.spec };
      shader.uniforms.uFlat = { value: scale.flat || 0 };
      shader.uniforms.uSpecPower = { value: cfg.specPower };
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "void main() {",
          "uniform vec3 uRimColor;\nuniform float uRimStrength;\nuniform float uRimPower;\n" +
            "uniform vec3 uSpecColor;\nuniform float uSpecStrength;\nuniform float uSpecPower;\nuniform float uFlat;\n" +
            "void main() {"
        )
        .replace(
          "#include <opaque_fragment>",
          [
            "  {",
            "    vec3 nV = normalize( normal );",
            "    vec3 vV = normalize( vViewPosition );",
            "    float rim = pow( clamp( 1.0 - dot( nV, vV ), 0.0, 1.0 ), uRimPower );",
            "    vec3 rimCol = uRimColor * rim * uRimStrength;",
            "    float specDot = clamp( dot( nV, normalize( vec3( -0.42, 0.55, 0.72 ) ) ), 0.0, 1.0 );",
            "    float spec = smoothstep( 0.62, 0.90, specDot );",
            "    vec3 specCol = uSpecColor * spec * uSpecStrength;",
            "    outgoingLight = mix( outgoingLight, diffuseColor.rgb, uFlat );",
            "    outgoingLight += rimCol + specCol;",
            "  }",
            "#include <opaque_fragment>",
          ].join("\n")
        );
      mat.userData.shader = shader;
    };
    mat.needsUpdate = true;
    return true;
  }

  function patchOutline(mat, cfg, width) {
    mat.__mmdShadePatched = true;
    mat.onBeforeCompile = function (shader) {
      shader.uniforms.uOutlineWidth = { value: width == null ? cfg.outlineWidth : width };
      shader.vertexShader = shader.vertexShader
        .replace("void main() {", "uniform float uOutlineWidth;\nvoid main() {")
        .replace(
          "#include <begin_vertex>",
          "#include <begin_vertex>\ntransformed += objectNormal * uOutlineWidth;"
        );
      mat.userData.shader = shader;
    };
    mat.needsUpdate = true;
  }

  /** 材质分档：皮肤/头发/衣服/眼睛，给不同的色彩与高光策略 */
  function classify(m, mesh) {
    var name = String((m && m.name) || "");
    var meshName = String((mesh && mesh.name) || "");
    if (m.isOutline) return "outline";
    if (m.transparent) return "transparent";
    var img = m && m.map && m.map.image;
    var w = img && img.width ? img.width : 0;
    var all = (name + " " + meshName).toLowerCase();
    // 名字优先（贴图可能还没 decode，width 会读到 0）
    if (/hair|髪|かみ/.test(all)) return "hair";
    if (/boot|shoe|靴|ブーツ/.test(all)) return "boots";
    if (/body|nails|首|neck|skin|肌|face|顔/.test(all)) return "skin";
    if (w === 256 || w === 512) return "hair";
    if (w === 300) return "accent";
    if (w === 1024 || w === 64) return "skin";
    return "cloth";
  }

  var GRADE = {
    skin: { sat: 1.12, warm: [1.05, 1.0, 0.96], bright: 1.03, contrast: 1.03 },
    hair: { sat: 1.38, warm: [1.07, 0.93, 1.02], bright: 1.03, contrast: 1.05 },
    cloth: { sat: 1.22, warm: [1.02, 0.97, 0.86], bright: 0.88, contrast: 1.06 },
    accent: { sat: 1.18, warm: [1.02, 1.0, 0.99], bright: 1.0, contrast: 1.04 },
    boots: { sat: 1.0, warm: [1.0, 1.0, 1.0], bright: 1.0, contrast: 1.02 },
  };

  /** 用 canvas 给贴图做饱和度/对比度/色温调整，返回新贴图（失败返回原贴图） */
  function gradeTexture(tex, kind) {
    var g = GRADE[kind];
    if (!g || !tex || !tex.image) return tex;
    try {
      var img = tex.image;
      var w = img.width || img.videoWidth || 0;
      var h = img.height || img.videoHeight || 0;
      if (!w || !h || w < 8) return tex;
      // 只处理可被 drawImage 消费的图像（TGA 等 DataTexture 跳过）
      var drawable = (typeof HTMLImageElement !== "undefined" && img instanceof HTMLImageElement) ||
        (typeof HTMLCanvasElement !== "undefined" && img instanceof HTMLCanvasElement) ||
        (typeof ImageBitmap !== "undefined" && img instanceof ImageBitmap) ||
        (typeof OffscreenCanvas !== "undefined" && img instanceof OffscreenCanvas);
      if (!drawable) return tex;
      var cv = document.createElement("canvas");
      cv.width = w; cv.height = h;
      var ctx = cv.getContext("2d");
      ctx.drawImage(img, 0, 0, w, h);
      var id = ctx.getImageData(0, 0, w, h);
      var d = id.data;
      var sat = g.sat, br = g.bright, ct = g.contrast, wr = g.warm[0], wg = g.warm[1], wb = g.warm[2];
      for (var i = 0; i < d.length; i += 4) {
        var r = d[i], gg = d[i + 1], b = d[i + 2];
        var l = 0.299 * r + 0.587 * gg + 0.114 * b;
        r = l + (r - l) * sat;
        gg = l + (gg - l) * sat;
        b = l + (b - l) * sat;
        r = (r - 128) * ct + 128; gg = (gg - 128) * ct + 128; b = (b - 128) * ct + 128;
        r = r * br * wr; gg = gg * br * wg; b = b * br * wb;
        d[i] = r < 0 ? 0 : r > 255 ? 255 : r;
        d[i + 1] = gg < 0 ? 0 : gg > 255 ? 255 : gg;
        d[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
      }
      ctx.putImageData(id, 0, 0);
      var nt = new THREE.CanvasTexture(cv);
      nt.flipY = tex.flipY;
      nt.colorSpace = tex.colorSpace;
      nt.wrapS = tex.wrapS; nt.wrapT = tex.wrapT;
      nt.minFilter = tex.minFilter; nt.magFilter = tex.magFilter;
      nt.generateMipmaps = tex.generateMipmaps !== false;
      nt.anisotropy = tex.anisotropy || 1;
      nt.needsUpdate = true;
      return nt;
    } catch (e) {
      console.warn("[mmd-shade] 贴图调色失败", e);
      return tex;
    }
  }

  var RAMP_CACHE = Object.create(null);
  function makeRamp(stops, key) {
    if (RAMP_CACHE[key]) return RAMP_CACHE[key];
    try {
      var w = 32, cv = document.createElement("canvas");
      cv.width = w; cv.height = 1;
      var ctx = cv.getContext("2d");
      // stops: [[pos0..1, brightness], ...] 台阶式
      for (var x = 0; x < w; x++) {
        var t = x / (w - 1);
        var val = stops[stops.length - 1][1];
        for (var i = 0; i < stops.length; i++) {
          if (t <= stops[i][0]) { val = stops[i][1]; break; }
        }
        var v = Math.round(255 * val);
        ctx.fillStyle = "rgb(" + v + "," + v + "," + v + ")";
        ctx.fillRect(x, 0, 1, 1);
      }
      var tex = new THREE.CanvasTexture(cv);
      tex.minFilter = THREE.NearestFilter;
      tex.magFilter = THREE.NearestFilter;
      tex.generateMipmaps = false;
      tex.colorSpace = THREE.SRGBColorSpace;
      RAMP_CACHE[key] = tex;
      return tex;
    } catch (e) { return null; }
  }

  var RAMPS = {
    // 皮肤：非常轻的两段，保留一点立体
    skin: function () { return makeRamp([[0.5, 0.93], [0.82, 0.985], [1, 1.0]], "skin"); },
    // 头发：两段对比明显，动画里头发就靠这个
    hair: function () { return makeRamp([[0.5, 0.62], [0.82, 0.88], [1, 1.0]], "hair"); },
    // 衣服：三段，暗部压深
    cloth: function () { return makeRamp([[0.45, 0.52], [0.75, 0.78], [0.95, 1.0], [1, 1.0]], "cloth"); },
    accent: function () { return makeRamp([[0.5, 0.7], [0.85, 0.95], [1, 1.0]], "accent"); },
  };

  function applyTintValue(color, v) {
    if (!color || v == null) return;
    if (Array.isArray(v)) color.setRGB(v[0], v[1], v[2]);
    else color.setHex(v);
  }

  function tintMaterial(m, kind, cfg) {
    if (!m || m.__mmdShadeTinted) return;
    m.__mmdShadeTinted = true;
    try {
      // MMD 材质自带的 emissive 会把明暗压平（默认 0x3a3a3a 之类），清掉让赛璐璐层次出来
      if (m.emissive) m.emissive.setHex(0x000000);
      if (kind === "skin" && m.color) { applyTintValue(m.color, cfg.skinTint); if (m.emissive) m.emissive.setRGB(0.12, 0.08, 0.062); }
      if (kind === "hair" && m.color) applyTintValue(m.color, cfg.hairTint);
      if (kind === "hair" && cfg.hairSoftTips) {
        // 发梢柔化：头发贴图底部带 alpha 渐隐，这里开透明 + alphaTest
        m.transparent = true;
        m.alphaTest = 0.05;
        m.depthWrite = true;
      }
      if (kind === "cloth" && m.color) applyTintValue(m.color, cfg.clothTint);
      if (kind === "boots" && m.color) applyTintValue(m.color, cfg.bootTint || [1, 1, 1]);
      if (kind === "accent" && m.color) applyTintValue(m.color, cfg.accentTint || [1.06, 1.0, 0.86]);
      var rampFn = RAMPS[kind];
      if (cfg.toonRamps !== false && rampFn && m.gradientMap) {
        var ramp = rampFn();
        if (ramp) { m.gradientMap = ramp; }
      }
      m.needsUpdate = true;
    } catch (e) { console.warn("[mmd-shade] tint fail", m && m.name, e); }
  }

  /** 给一个 MMD SkinnedMesh 套上动画质感（可重复调用，自动去重） */
  function apply(mesh, preset, extra) {
    if (!mesh || mesh.__mmdShaded) return null;
    var cfg = Object.assign({}, PRESETS[preset || "anime"] || PRESETS.anime, extra || {});
    var rec = { mesh: mesh, patched: 0, outlined: 0, cfg: cfg };

    // 1) 表面材质补光
    var mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    var seen = [];
    for (var i = 0; i < mats.length; i++) {
      var m = mats[i];
      if (!m || seen.indexOf(m) >= 0) continue;
      seen.push(m);
      var kind = classify(m, mesh);
      if (cfg.accentTint == null) cfg.accentTint = [1.07, 1.0, 0.84];
      // 透明材质（脸/眼睛/睫毛等覆盖层）不叠边光和描边，但必须清掉 MMD 的灰色自发光，
      // 否则整张脸会糊成灰绿色。
      if (m.transparent && m.opacity < 0.999) {
        tintMaterial(m, (m.map && m.map.image && m.map.image.width >= 1024) ? "skin" : kind, cfg);
        continue;
      }
      tintMaterial(m, kind === "accent" ? "cloth" : kind, cfg);
      var SCALE = {
        skin: { rim: 0.12, spec: 0.08, flat: 1.0 },
        hair: { rim: 0.95, spec: 0.78, flat: 0.8 },
        cloth: { rim: 0.8, spec: 0.5, flat: 0.5 },
        accent: { rim: 0.95, spec: 0.4, flat: 0.55 },
        boots: { rim: 0.5, spec: 0.3, flat: 0.6 },
      };
      if (patchSurface(m, cfg, SCALE[kind] || SCALE.cloth)) rec.patched++;
      if (cfg.gradeTextures !== false && m.map && m.map.image && m.map.image.width >= 8 && !m.map.__mmdGraded) {
        try {
          var graded = gradeTexture(m.map, kind === "transparent" ? "skin" : kind);
          if (graded && graded !== m.map) {
            graded.__mmdGraded = true;
            m.map = graded;
            m.needsUpdate = true;
            rec.graded = (rec.graded || 0) + 1;
          }
        } catch (e) { console.warn("[mmd-shade] 贴图调色失败", e); }
      }
    }

    // 2) 描边外壳：按材质分类给不同宽度（薄片面/眼睛/透明层为 0，避免出现黑斑）
    if (cfg.outline) {
      try {
        var origMats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        var WIDTH_KIND = { skin: 0.8, hair: 0.18, cloth: 1.35, accent: 1.0, boots: 1.2, transparent: 0 };
        var outMats = [];
        for (var oi = 0; oi < origMats.length; oi++) {
          var om0 = origMats[oi];
          var kind0 = classify(om0, mesh);
          var wMul = WIDTH_KIND[kind0] == null ? 1 : WIDTH_KIND[kind0];
          var om = new THREE.MeshToonMaterial({
            color: new THREE.Color(cfg.outlineColor),
            gradientMap: null,
            side: THREE.BackSide,
            transparent: false,
            depthWrite: true,
          });
          om.name = "mmd-outline-" + kind0 + "-" + oi;
          om.emissive = new THREE.Color(0x000000);
          patchOutline(om, cfg, cfg.outlineWidth * wMul);
          om.userData.__mmdOutlineKind = kind0;
          outMats.push(om);
        }
        var outline = new THREE.SkinnedMesh(mesh.geometry, outMats);
        outline.name = (mesh.name || "mmd") + "-outline";
        outline.frustumCulled = false;
        outline.castShadow = false;
        outline.receiveShadow = false;
        outline.bindMatrix.copy(mesh.bindMatrix);
        outline.bindMatrixInverse.copy(mesh.bindMatrixInverse);
        try { outline.bind(mesh.skeleton, mesh.bindMatrix); } catch (e) {}
        outline.position.copy(mesh.position);
        outline.quaternion.copy(mesh.quaternion);
        outline.scale.copy(mesh.scale);
        if (mesh.parent) mesh.parent.add(outline);
        rec.outline = outline;
        rec.outlined = 1;
      } catch (e) {
        console.warn("[mmd-shade] 描边失败", e);
      }
    }

    // 3) 眼睛放大：MMD 的 目/両目 骨骼控制眼球与虹膜，轻微放大虹膜更像动画大眼
    if (cfg.eyeScale && cfg.eyeScale !== 1) {
      try {
        var bonesArr = mesh.skeleton && mesh.skeleton.bones ? mesh.skeleton.bones : [];
        for (var bi = 0; bi < bonesArr.length; bi++) {
          var bn = bonesArr[bi];
          if (bn && (bn.name === "左目" || bn.name === "右目" || bn.name === "両目")) {
            bn.scale.setScalar(cfg.eyeScale);
          }
        }
      } catch (e) {}
    }

    mesh.__mmdShaded = rec;
    built.push(rec);
    // MMDLoader 的贴图是异步 decode 的，apply 时可能还没 image；
    // 800ms / 1800ms 后再补一次调色（只处理还没调过的）。
    var gradeRetry = function (attempt) {
      try {
        if (mesh.__mmdShaded !== rec) return;
        var mats2 = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (var gi = 0; gi < mats2.length; gi++) {
          var gm = mats2[gi];
          if (!gm || !gm.map || !gm.map.image || !gm.map.image.width || gm.map.image.width < 8 || gm.map.__mmdGraded) continue;
          var kind2 = classify(gm, mesh);
          var g2 = gradeTexture(gm.map, kind2 === "transparent" ? "skin" : (kind2 === "accent" ? "accent" : kind2));
          if (g2 && g2 !== gm.map) { g2.__mmdGraded = true; gm.map = g2; gm.needsUpdate = true; rec.graded = (rec.graded || 0) + 1; }
        }
      } catch (e) {}
      if (attempt < 2) setTimeout(function () { gradeRetry(attempt + 1); }, 1000);
    };
    setTimeout(function () { gradeRetry(0); }, 800);
    return rec;
  }

  function set(preset, extra) {
    for (var i = 0; i < built.length; i++) {
      var rec = built[i];
      if (!rec) continue;
      var cfg = Object.assign({}, rec.cfg || PRESETS.anime, PRESETS[preset || "anime"] || {}, extra || {});
      rec.cfg = cfg;
      // 正在用的 shader 直接改 uniform（下次编译也会用新值）
      var mats = Array.isArray(rec.mesh.material) ? rec.mesh.material : [rec.mesh.material];
      var applyUniforms = function (mat) {
        var sh = mat && mat.userData && mat.userData.shader;
        if (!sh) return;
        var sc = (mat.userData && mat.userData.__mmdScale) || { rim: 1, spec: 1 };
        if (sh.uniforms.uRimColor) sh.uniforms.uRimColor.value.set(cfg.rimColor);
        if (sh.uniforms.uRimStrength) sh.uniforms.uRimStrength.value = cfg.rimStrength * sc.rim;
        if (sh.uniforms.uRimPower) sh.uniforms.uRimPower.value = cfg.rimPower;
        if (sh.uniforms.uSpecColor) sh.uniforms.uSpecColor.value.set(cfg.specColor);
        if (sh.uniforms.uSpecStrength) sh.uniforms.uSpecStrength.value = cfg.specStrength * sc.spec;
        if (sh.uniforms.uSpecPower) sh.uniforms.uSpecPower.value = cfg.specPower;
        if (sh.uniforms.uFlat) sh.uniforms.uFlat.value = sc.flat || 0;
      };
      mats.forEach(applyUniforms);
      if (rec.outline && rec.outline.material) {
        var WIDTH_KIND2 = { skin: 0.9, hair: 0.28, cloth: 1.35, accent: 1.0, boots: 1.2, transparent: 0 };
        var omats = Array.isArray(rec.outline.material) ? rec.outline.material : [rec.outline.material];
        for (var oi2 = 0; oi2 < omats.length; oi2++) {
          var om2 = omats[oi2];
          var k2 = om2.userData && om2.userData.__mmdOutlineKind;
          var w2 = WIDTH_KIND2[k2] == null ? 1 : WIDTH_KIND2[k2];
          var osh = om2.userData && om2.userData.shader;
          if (osh && osh.uniforms.uOutlineWidth) osh.uniforms.uOutlineWidth.value = cfg.outlineWidth * w2;
          if (om2.color) om2.color.set(cfg.outlineColor);
        }
        rec.outline.visible = !!cfg.outline;
      }
    }
  }

  function dispose() {
    for (var i = 0; i < built.length; i++) {
      var rec = built[i];
      if (!rec) continue;
      try {
        if (rec.outline && rec.outline.parent) rec.outline.parent.remove(rec.outline);
        if (rec.outline) {
          rec.outline.geometry = null;
          try { rec.outline.material.dispose(); } catch (e) {}
        }
      } catch (e) {}
      rec.mesh.__mmdShaded = null;
    }
    built = [];
  }

  return { apply: apply, set: set, dispose: dispose, PRESETS: PRESETS };
};
