/**
 * registry —— 把所有角色的 3D 版本汇总成一张表（key = 皮肤 id）。
 * 任何角色模块挂了都不影响其它角色加载。
 */
module.exports.create = function (K, FIG, THREE) {
  var MODULES = ["chars.zerotwo", "chars.zerotwo-tall", "chars.whale"];
  var list = {};
  for (var i = 0; i < MODULES.length; i++) {
    try {
      var mod = require(MODULES[i]);
      var built = mod && mod.create ? mod.create(K, FIG, THREE) : null;
      if (built && built.variants) {
        for (var id in built.variants) list[id] = built.variants[id];
      }
    } catch (error) {
      try { console.warn("[zero02] 角色模块加载失败 " + MODULES[i], error); } catch (e) {}
    }
  }
  return {
    map: list,
    ids: function () { return Object.keys(list); },
    get: function (id) { return list[id] || null; },
    has: function (id) { return !!list[id]; },
  };
};
