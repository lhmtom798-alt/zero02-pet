/**
 * vrm-look —— vrmchar 的"外观风格"钩子模块（被 vrmchar 通过 styleModule 调用）。
 *
 * vrmchar 会在模型挂载后调用 `require("vrm-look").apply(vrm, styleCfg)`；
 * 本模块负责：染色（发/瞳/衣服）、描边、外观预设、3D 配件（红角/发带/贝雷帽/头饰/尾巴）、Q 版头身比。
 *
 * styleCfg 例：
 *   {
 *     lookdev: "figure",              // vrm-style 的 MToon 预设
 *     outlinePx: 1.1,
 *     tint: { hair: 0xf49ac0, iris: 0x2f9b7f, cloth: 0xc02038 },
 *     recolor: { hair: true },        // true=直接重绘贴图（更准，更慢）
 *     props: { horns: true, headband: true, chibi: 1.5 }
 *   }
 */
module.exports.apply = function (vrm, cfg) {
  cfg = cfg || {};
  if (!vrm) return null;
  var THREE = (typeof window !== "undefined" && window.THREE) || null;
  if (!THREE) return null;

  var out = { tinted: 0, outlined: 0, props: null, chibi: false };

  // 同一个 vrm 只应用一次
  vrm.scene.userData = vrm.scene.userData || {};
  if (vrm.scene.userData.__petLookApplied) return vrm.scene.userData.__petLookApplied;
  vrm.scene.userData.__petLookApplied = out;

  var STYLE = null;
  try {
    var mod = require("vrm-style");
    if (mod && mod.create) STYLE = mod.create(THREE, window.THREE_VRM);
  } catch (e) {
    console.warn("[vrm-look] vrm-style 未就绪", e);
  }

  if (STYLE) {
    // 1) 外观预设（MToon 卡通化参数：面/发/衣分档）
    try {
      if (cfg.lookdev !== false) {
        STYLE.applyLookdev(vrm, cfg.lookdev || "figure", {});
      }
    } catch (e) { console.warn("[vrm-look] applyLookdev 失败", e); }

    // 2) 换色
    if (cfg.tint) {
      try {
        if (cfg.tint.hair != null && STYLE.TINT_MATCHERS && STYLE.TINT_MATCHERS.hair) {
          out.tinted += applyTint(STYLE, vrm, "hair", cfg.tint.hair, cfg.recolor && cfg.recolor.hair);
        }
        if (cfg.tint.iris != null && STYLE.TINT_MATCHERS && STYLE.TINT_MATCHERS.iris) {
          out.tinted += applyTint(STYLE, vrm, "iris", cfg.tint.iris, cfg.recolor && cfg.recolor.iris);
        }
        if (cfg.tint.cloth != null && STYLE.TINT_MATCHERS && STYLE.TINT_MATCHERS.cloth) {
          out.tinted += applyTint(STYLE, vrm, "cloth", cfg.tint.cloth, cfg.recolor && cfg.recolor.cloth);
        }
      } catch (e) { console.warn("[vrm-look] 染色失败", e); }
    }

    // 2.5) 弹簧骨骼按模型缩放补偿（vrmchar 把模型放大了 ~3 倍，不然头发会僵直/上飘）
    try {
      if (STYLE.scaleSpringBones && vrm.scene && vrm.scene.scale.x) {
        STYLE.scaleSpringBones(vrm, vrm.scene.scale.x);
      }
    } catch (e) { console.warn("[vrm-look] springbone 缩放补偿失败", e); }

    // 3) 描边（按像素换算，适配 200~360px 的小窗）
    try {
      if (cfg.outlinePx !== false) {
        STYLE.setOutline(vrm, { px: cfg.outlinePx == null ? 1.1 : cfg.outlinePx, viewportHeightPx: cfg.viewportHeightPx || 300 });
      }
    } catch (e) { console.warn("[vrm-look] 描边失败", e); }
  }

  // 4) 3D 配件 + Q 版
  try {
    var propsMod = require("vrm-props");
    if (propsMod && propsMod.create) {
      var PROPS = propsMod.create(THREE, STYLE);
      out.props = PROPS.apply(vrm, cfg.props || null);
      out.chibi = !!(out.props && out.props.chibi);
    }
  } catch (e) { console.warn("[vrm-look] 配件失败", e); }

  return out;
};

function applyTint(STYLE, vrm, key, color, recolorMap) {
  var matcher = STYLE.TINT_MATCHERS[key];
  if (!matcher) return 0;
  if (recolorMap && key === "hair") {
    var mats = STYLE.findMaterials(vrm, matcher);
    for (var i = 0; i < mats.length; i++) {
      try { STYLE.recolorMap(mats[i], color, { satMul: 1.1 }); } catch (e) {}
    }
    return mats.length;
  }
  var list = STYLE.findMaterials(vrm, matcher);
  var n = 0;
  for (var j = 0; j < list.length; j++) {
    try {
      var c = new (window.THREE.Color)(color);
      var m = list[j];
      if (m.color && !m.userData.__vrmLookTinted) {
        m.color.copy(c);
        if (key === "hair" && m.shadeColorFactor) m.shadeColorFactor.copy(c).multiplyScalar(0.62);
        m.userData.__vrmLookTinted = true;
        m.needsUpdate = true;
        n++;
      }
    } catch (e) {}
  }
  return n;
}
