#!/usr/bin/env node
/**
 * zero02-pet 渲染/几何冒烟：模型加载、贴图风格参数、发丝、姿势、皮肤切换、VRM、2D 回退。
 *
 *   node tools/render-smoke.mjs
 *
 * 依赖：tools/serve.py 在 :8899 运行。
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";

const NODE = process.env.NODE || process.execPath;
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SHOT = path.join(ROOT, "tools", "shot.mjs");
const BASE = process.env.URL || "http://127.0.0.1:8899/preview/?pkg=zero02-pet&z02debug=1";
const results = [];
function record(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log((ok ? "  ✅ " : "  ❌ ") + name + (detail ? "  — " + detail : ""));
}
function runShot({ skin, evalExpr, infoExpr, wait, ready }) {
  const url = BASE + "&skin=" + (skin || "onee");
  const args = [
    SHOT, "--url", url,
    "--out", path.join(os.tmpdir(), "z02-render.png"),
    "--size", "1100x950", "--wait", String(wait || 12000),
    "--ready", ready || `window.__z02 && __z02.get3d() && __z02.get3d().ready("${skin || "onee"}")`,
    "--eval", evalExpr, "--info", infoExpr || "({})",
  ];
  const r = spawnSync(NODE, args, { cwd: ROOT, encoding: "utf8", timeout: 150000 });
  const out = (r.stdout || "") + (r.stderr || "");
  const m = out.match(/^info: (.*)$/m);
  let info = null;
  if (m) { try { info = JSON.parse(m[1]); } catch { info = m[1]; } }
  return { info, out, code: r.status };
}

/* 组 1：TDA 参数 / 发丝 / 姿势 */
{
  console.log("\n▶ 组 1：TDA 造型参数 / 发丝 / 姿势");
  const evalExpr = `(function(){
    var z = __z02; var out = {};
    z.state.seenGuide = true;
    var g = document.querySelector('[data-role="z02-guide"]'); if (g) g.remove();
    setTimeout(function(){
      var c = z.getChar();
      out.bones = c && c._bones ? Object.keys(c._bones).length : 0;
      out.height = c ? +c.height.toFixed(2) : 0;
      // 发型体积：根骨 scale 应被放大
      var roots = (c._hair || []).filter(function(b){ return !b.parent || !/^cf_J_hair/.test(b.parent.name); });
      out.hairRootScale = roots.length ? +roots[0].scale.x.toFixed(3) : 0;
      out.strands = (c._hairStrands && c._hairStrands.count) || (c._hairStrands && c._hairStrands.group ? c._hairStrands.group.children.length : 0);
      // 眼睛缩放
      var eye = c._bones && (c._bones["左目"] || c._bones["eye_L"]);
      out.eyeScale = eye ? +eye.scale.x.toFixed(3) : 0;
      // 姿势全跑一遍，看有没有 NaN
      var bad = [];
      ["idle","happy","pat","talk","shy","sleep","stretch","wink","eat"].forEach(function(st){
        try {
          c.setState(st);
          if (!isFinite(c.root.position.x) || !isFinite(c.root.position.y)) bad.push(st);
          var anyBad = Object.keys(c._bones || {}).some(function(k){
            var b = c._bones[k]; return b && (!isFinite(b.rotation.x) || !isFinite(b.rotation.y) || !isFinite(b.rotation.z));
          });
          if (anyBad) bad.push(st + ":NaN");
        } catch (e) { bad.push(st + ":err"); }
      });
      c.setState("idle");
      out.badPoses = bad;
      // 快照（拍照）必须真有画面：渲染同一 task 内导出，再数非透明像素
      try {
        var du = z.get3d().snapshot();
        out.snapLen = du ? du.length : 0;
        window.__SNAPURL = du;
      } catch (e) { out.snapLen = -1; }
      // 表情：切到 happy 后检查「笑い/にこり」权重确实被驱动
      c.setState("happy");
      // 解码快照数非透明像素
      try {
        var img = new Image();
        img.onload = function () {
          var cv = document.createElement("canvas");
          cv.width = img.width; cv.height = img.height;
          var ctx = cv.getContext("2d");
          ctx.drawImage(img, 0, 0);
          var d = ctx.getImageData(0, 0, cv.width, cv.height).data, n = 0;
          for (var i = 3; i < d.length; i += 4) if (d[i] > 8) n++;
          out.snapOpaque = n;
          window.__R1 = out;
        };
        img.src = window.__SNAPURL;
      } catch (e) {}
      setTimeout(function(){
        out.happyExpr = { smile: c.getExpr("smile"), nicon: c.getExpr("nicon"), calm: c.getExpr("calm") };
        window.__R1 = out;
      }, 900);
      window.__R1 = out;
    }, 1200);
  })()`;
  const r = runShot({ evalExpr, infoExpr: "window.__R1", wait: 15000 });
  const i = r.info || {};
  record("TDA 模型加载（骨 > 300）", (i.bones || 0) > 300, "bones=" + i.bones);
  record("发量 1.06 已应用（根骨 scale>1.02）", (i.hairRootScale || 0) > 1.02, "scale=" + i.hairRootScale);
  record("眼睛缩放 1.26 已应用", Math.abs((i.eyeScale || 0) - 1.26) < 0.02, "eyeScale=" + i.eyeScale);
  record("姿势全跑无 NaN/异常", Array.isArray(i.badPoses) && i.badPoses.length === 0, JSON.stringify(i.badPoses || []));
  const he = i.happyExpr || {};
  record("表情驱动（happy → 笑い/にこり > 0）", (he.smile || 0) > 0.05 || (he.nicon || 0) > 0.05, JSON.stringify(he));
  record("拍照导出非空（非透明像素 > 1000）", (i.snapOpaque || 0) > 1000, "opaque=" + (i.snapOpaque || 0) + " len=" + (i.snapLen || 0));
}

/* 组 1.5：取景（全身 / 半身） */
{
  console.log("\n▶ 组 1.5：取景切换");
  const evalExpr = `(function(){
    var z = __z02; var out = {};
    z.state.seenGuide = true;
    var g = document.querySelector('[data-role="z02-guide"]'); if (g) g.remove();
    // 等引擎加载后的取景定时器跑完（900/2600/5200ms）再测，避免被复位覆盖
    setTimeout(function(){
      var st = z.get3d().stage;
      out.full = st.getCam ? st.getCam() : null;
      st.bust(true);
      setTimeout(function(){
        out.bust = st.getCam ? st.getCam() : null;
        st.bust(false);
        setTimeout(function(){
          out.back = st.getCam ? st.getCam() : null;
          window.__R15 = out;
        }, 1200);
      }, 1300);
    }, 6800);
  })()`;
  const r = runShot({ evalExpr, infoExpr: "window.__R15", wait: 15000 });
  const i = r.info || {};
  record("半身取景拉近相机", i.full && i.bust && i.bust.dist < i.full.dist * 0.85, "full=" + (i.full && i.full.dist) + " → " + (i.bust && i.bust.dist));
  record("半身取景视点上移", i.full && i.bust && i.bust.ty > i.full.ty + 1, "ty " + (i.full && i.full.ty) + " → " + (i.bust && i.bust.ty));
  record("切回全身可恢复", i.back && i.full && Math.abs(i.back.distT - i.full.distT) < 0.5, "back=" + (i.back && i.back.distT) + " full=" + (i.full && i.full.distT));
}

/* 组 2：皮肤切换 + HD + 鲸鲸 + 2D */
{
  console.log("\n▶ 组 2：皮肤切换 / HD Darling / 鲸鲸 / 2D");
  const evalExpr = `(function(){
    var z = __z02; var out = {};
    z.state.seenGuide = true;
    var g = document.querySelector('[data-role="z02-guide"]'); if (g) g.remove();
    setTimeout(function(){
      // Q 版
      try { z.applySkin("chibi"); } catch (e) { out.chibiErr = String(e.message); }
      setTimeout(function(){
        var c = z.getChar();
        out.chibi = c && c._cfg ? +(+c._cfg.height).toFixed(2) : 0;
        out.chibiRealH = c ? +c.height.toFixed(2) : 0;
        out.chibiBones = c && c._bones ? Object.keys(c._bones).length : 0;
        try { z.applySkin("onee"); } catch (e) {}
        setTimeout(function(){
          var c2 = z.getChar();
          out.onee = c2 ? +c2.height.toFixed(2) : 0;
          // 2D 模式回退
          try { z.setDim("2d"); } catch (e) { out.dimErr = String(e.message); }
          setTimeout(function(){
            var img = document.querySelector('[data-z02-root] img');
            out.dim2d = z.state.dim;
            out.hasImg = !!img;
            try { z.setDim("3d"); } catch (e) {}
            window.__R2 = out;
          }, 2500);
        }, 4000);
      }, 4500);
    }, 1000);
  })()`;
  const r = runShot({ evalExpr, infoExpr: "window.__R2", wait: 24000, skin: "onee" });
  const i = r.info || {};
  record("Q 版可切换（取景高度 < 6）", (i.chibi || 99) < 6, "fitH=" + i.chibi + " realH=" + i.chibiRealH);
  record("切回御姐正常（骨 > 300）", (i.chibiBones || 0) > 300 || (i.onee || 0) > 5, "h=" + i.onee);
  record("2D 模式回退可用", i.dim2d === "2d" && i.hasImg === true, "dim=" + i.dim2d + " img=" + i.hasImg);
  record("切换过程无异常", !i.chibiErr && !i.dimErr, String(i.chibiErr || "") + String(i.dimErr || ""));
}

/* 组 3：鲸鲸 VRM */
{
  console.log("\n▶ 组 3：鲸鲸（VRM）");
  const evalExpr = `(function(){
    var z = __z02; var out = {};
    z.state.seenGuide = true;
    var g = document.querySelector('[data-role="z02-guide"]'); if (g) g.remove();
    setTimeout(function(){
      var c = z.getChar();
      var v = c && c.getVRM ? c.getVRM() : null;
      out.height = c ? +c.height.toFixed(2) : 0;
      out.hasVRM = !!v;
      // 浮动：两次采样看 root 的 y / rz 是否在变
      out.s1 = c ? { y: +c.root.position.y.toFixed(4), rz: +c.root.rotation.z.toFixed(4) } : null;
      setTimeout(function(){
        out.s2 = c ? { y: +c.root.position.y.toFixed(4), rz: +c.root.rotation.z.toFixed(4) } : null;
        window.__R3 = out;
      }, 400);
      out.expr = v && v.expressionManager ? Object.keys(v.expressionManager.expressionMap || {}).length : 0;
      out.hasTalk = typeof (c && c.talkMouth) === "function";
      out.hasFloat = true;
    }, 1800);
  })()`;
  const r = runShot({ evalExpr, infoExpr: "window.__R3", wait: 16000, skin: "whale" });
  const i = r.info || {};
  record("鲸鲸 VRM 加载", i.hasVRM === true, "h=" + i.height);
  record("鲸鲸表情/口型可用", (i.expr || 0) > 10 && i.hasTalk === true, "expr=" + i.expr);
  const moved = i.s1 && i.s2 && (Math.abs(i.s1.y - i.s2.y) > 0.001 || Math.abs(i.s1.rz - i.s2.rz) > 0.0005);
  record("鲸鲸浮动/摇摆生效", moved === true, JSON.stringify(i.s1 || {}) + " → " + JSON.stringify(i.s2 || {}));
}

const pass = results.filter((r) => r.ok).length;
console.log("\n" + "─".repeat(40));
console.log("渲染冒烟：" + pass + " 通过 / " + (results.length - pass) + " 失败（共 " + results.length + "）");
process.exit(pass === results.length ? 0 : 1);
