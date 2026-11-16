/* 客户端启动尾巴（build.py 会把它拼在 factory 末尾） */
try {
  boot();
  setTimeout(function () { try {
    var _r = root.getBoundingClientRect();
    _z02ping(
      "paint " + Math.round(_r.left) + "," + Math.round(_r.top) + " " +
      Math.round(_r.width) + "x" + Math.round(_r.height) +
      " disp=" + (root.style.display || "auto") +
      " dim=" + (S.dim || "2d") +
      " r3d=" + (typeof pet3d !== "undefined" && pet3d && pet3d.has && pet3d.has() ? 1 : 0) +
      " dimAct=" + (typeof activeDim !== "undefined" ? activeDim : "?") +
      " inBody=" + document.body.contains(root) +
      " pos=" + getComputedStyle(root).position +
      " gl=" + (function () { try { var c = stageEl && stageEl.querySelector("canvas"); return c ? c.width + "x" + c.height : 0; } catch (e) { return "ERR"; } })()
    );
  } catch (_e) {
    _z02ping("PAINTFAIL " + ((_e && _e.message) || _e));
  } }, 700);
} catch (error) {
  console.warn("[zero02-pet] 启动失败", error);
  _z02ping("BOOTFAIL " + ((error && error.stack) || error));
}
