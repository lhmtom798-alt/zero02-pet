/**
 * 角色实验室入口（只在 lab 里跑，不进插件包）
 * 用法：/lab/?char=chibi&mode=single&state=idle
 *      /lab/?char=chibi&mode=sheet
 */
function labStart(host, params) {
  var THREE = window.THREE;
  if (!THREE) { host.textContent = "THREE 未加载"; return; }
  var K = __req("kit").create(THREE);
  var FIG = __req("fig").create(K, THREE);
  var stageMod = __req("stage");
  var chars = __req("registry").create(K, FIG, THREE).map;

  var charId = params.get("char") || "chibi";
  var preset = chars[charId];
  if (!preset) {
    host.innerHTML = '<pre style="color:#f88;padding:20px">没有形象: ' + charId + '（可用: ' + Object.keys(chars).join(", ") + "）</pre>";
    return;
  }
  var state = params.get("state") || "idle";
  var mode = params.get("mode") || "single";

  function makeStage(parent, opts) {
    var hostEl = document.createElement("div");
    hostEl.style.cssText = "position:relative;width:100%;height:100%;";
    parent.appendChild(hostEl);
    var stage = stageMod.create({ THREE: THREE, K: K, host: hostEl, quality: "high" });
    var char = preset.build({ THREE: THREE, K: K, FIG: FIG, stage: stage });
    stage.root.add(char.root);
    stage.frame(preset.meta.camera);
    stage.setSize(hostEl.clientWidth, hostEl.clientHeight);
    char.setState(state);
    char.update(0.016, 0);
    stage.tick(0.016);
    stage.render();
    return { stage: stage, char: char, host: hostEl };
  }

  if (mode === "sheet") {
    var views = [
      { az: 0, el: 0.08, label: "正面" },
      { az: 0.62, el: 0.08, label: "3/4" },
      { az: 1.15, el: 0.08, label: "侧面" },
      { az: Math.PI, el: 0.06, label: "背面" },
      { az: 0.28, el: 0.16, label: "近景", closeup: true },
    ];
    var wrap = document.createElement("div");
    wrap.style.cssText = "display:flex;gap:10px;height:100%;align-items:stretch;padding:10px;box-sizing:border-box;";
    host.appendChild(wrap);
    var cells = views.map(function (vw) {
      var cell = document.createElement("div");
      cell.style.cssText = "flex:1;position:relative;border-radius:14px;background:radial-gradient(120% 90% at 50% 20%,#2b2140,#140f1f);overflow:hidden;";
      var label = document.createElement("div");
      label.textContent = vw.label;
      label.style.cssText = "position:absolute;left:10px;top:8px;font:600 11px ui-sans-serif;color:#c9b9dd;z-index:2;opacity:.8";
      cell.appendChild(label);
      var holder = document.createElement("div");
      holder.style.cssText = "position:absolute;inset:0;";
      cell.appendChild(holder);
      wrap.appendChild(cell);
      return { vw: vw, holder: holder, cell: cell };
    });
    // 等 flex 布局稳定后再创建 canvas，否则量到的宽度是错的（会把角色压扁）
    function buildCells() {
      cells.forEach(function (c) {
        var made = makeStage(c.holder, c.vw);
        var cam = preset.meta.camera;
        if (c.vw.closeup) {
          var bb = null;
          try {
            var box = new THREE.Box3().setFromObject(made.char.root);
            bb = box;
          } catch (e) {}
          var h = bb ? (bb.max.y - bb.min.y) : preset.meta.height;
          var top = bb ? bb.max.y : preset.meta.height;
          made.stage.hard(c.vw.az, c.vw.el, h * 2.7, top - h * 0.36);
        } else {
          made.stage.hard(c.vw.az, c.vw.el);
        }
        made.stage.render();
      });
      window.__LAB_READY = true;
    }
    requestAnimationFrame(function () { requestAnimationFrame(buildCells); });
    return;
    window.__LAB_READY = true;
    return;
  }

  host.style.cssText = "position:absolute;inset:0;";
  var made2 = makeStage(host, {});
  var cam2 = preset.meta.camera;
  made2.stage.hard(0, cam2.elevation == null ? 0.09 : cam2.elevation);

  var last = performance.now(), t = 0;
  function loop(now) {
    var dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    t += dt;
    made2.char.update(dt, t);
    made2.stage.tick(dt);
    made2.stage.render();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  window.__LAB = {
    THREE: THREE, stage: made2.stage, char: made2.char, preset: preset,
    setState: function (s) { made2.char.setState(s); },
    look: function (x, y) { made2.char.setLook(x, y); },
    orbit: function (az, el) { made2.stage.hard(az, el); },
    bbox: function () {
      var b = new THREE.Box3().setFromObject(made2.char.root);
      var sz = new THREE.Vector3(); b.getSize(sz);
      return { w: +sz.x.toFixed(2), h: +sz.y.toFixed(2), d: +sz.z.toFixed(2), minY: +b.min.y.toFixed(2), maxY: +b.max.y.toFixed(2) };
    },
    ready: true,
  };
  window.__LAB_READY = true;
}
window.__LAB_START = labStart;
