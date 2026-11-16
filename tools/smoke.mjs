#!/usr/bin/env node
/**
 * zero02-pet 冒烟测试：用无头 Chrome 跑几组关键功能验收，打印 PASS/FAIL。
 *
 *   node tools/smoke.mjs            # 全部检查（约 60~90 秒）
 *   node tools/smoke.mjs --fast     # 只跑核心 2 组（约 30 秒）
 *
 * 依赖：tools/serve.py 在 :8899 运行（把插件预览挂在 /preview/）。
 * 每组检查复用一个页面，通过 shot.mjs 的 --eval / --info 机制执行与取结果。
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";

const NODE = process.env.NODE || process.execPath;
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SHOT = path.join(ROOT, "tools", "shot.mjs");
const URL_BASE = process.env.URL || "http://127.0.0.1:8899/preview/?pkg=zero02-pet&z02debug=1&skin=onee";
const READY = "window.__z02 && __z02.get3d() && __z02.get3d().ready('onee')";
const FAST = process.argv.includes("--fast");

const results = [];
function record(group, name, ok, detail) {
  results.push({ group, name, ok: !!ok, detail });
  console.log((ok ? "  ✅ " : "  ❌ ") + name + (detail ? "  — " + detail : ""));
}

function runShot({ evalExpr, infoExpr, wait, ready }) {
  const args = [
    SHOT,
    "--url", URL_BASE,
    "--out", path.join(os.tmpdir(), "z02-smoke.png"),
    "--size", "900x820",
    "--wait", String(wait || 12000),
    "--ready", ready || READY,
    "--eval", evalExpr,
    "--info", infoExpr || "({})",
  ];
  const r = spawnSync(NODE, args, { cwd: ROOT, encoding: "utf8", timeout: 120000 });
  const out = (r.stdout || "") + (r.stderr || "");
  const m = out.match(/^info: (.*)$/m);
  let info = null;
  if (m) {
    try { info = JSON.parse(m[1]); } catch { info = m[1]; }
  }
  return { info, out, code: r.status };
}

function section(title) { console.log("\n▶ " + title); }

/* ---------------- 组 1：启动 + 基础交互 + 记忆/共同记忆 ---------------- */
section("组 1：启动 / 摸头 / 投喂 / 记忆");
{
  const evalExpr = `(function(){
    window.__S = { errors: [] };
    window.addEventListener("error", function(e){ __S.errors.push(String(e.message)); });
    var z = __z02;
    z.state.seenGuide = true;
    var g = document.querySelector('[data-role="z02-guide"]'); if (g) g.remove();
    var before = z.state.affinity || 0;
    setTimeout(function(){ z.pet(); }, 600);
    setTimeout(function(){ z.feed(); }, 1400);
    setTimeout(function(){ z.sendMessage("嗯"); }, 2200);
    setTimeout(function(){ z.sendMessage("我喜欢吃草莓蛋糕"); }, 9000);
    setTimeout(function(){
      window.__SMOKE = {
        affinity: z.state.affinity || 0,
        affinityUp: (z.state.affinity || 0) > before,
        chats: z.state.chats || 0,
        memory: z.state.memory || [],
        boneCount: (z.getChar() && z.getChar()._bones) ? Object.keys(z.getChar()._bones).length : 0,
        errors: window.__S.errors
      };
    }, 15000);
  })()`;
  const r = runShot({ evalExpr, infoExpr: "window.__SMOKE", wait: 17000 });
  const i = r.info || {};
  record("1", "3D 角色加载（骨头 > 300）", (i.boneCount || 0) > 300, "bones=" + i.boneCount);
  record("1", "摸头/投喂加好感", i.affinityUp === true, "affinity=" + i.affinity);
  record("1", "聊天与句数统计", (i.chats || 0) >= 2, "chats=" + i.chats);
  record("1", "即时记忆提取（我喜欢吃草莓蛋糕）", Array.isArray(i.memory) && i.memory.some((m) => /草莓/.test(m)), JSON.stringify(i.memory || []).slice(0, 80));
  record("1", "无未捕获 JS 错误", !(i.errors && i.errors.length), (i.errors || []).join(" | ").slice(0, 100));
}

/* ---------------- 组 2：小请求 + 晚安仪式 ---------------- */
section("组 2：小请求 / 晚安仪式");
{
  const evalExpr = `(function(){
    var z = __z02;
    z.state.seenGuide = true;
    var g = document.querySelector('[data-role="z02-guide"]'); if (g) g.remove();
    z.state.history = [];
    setTimeout(function(){ z.askRequest("feed"); window.__REQ1 = !!z.activeRequest(); }, 600);
    setTimeout(function(){ z.feed(); window.__REQ2 = !!z.activeRequest(); }, 1800);
    setTimeout(function(){ z.sendMessage("晚安，我先睡了"); }, 6000);
    setTimeout(function(){ z.sleepNow(); }, 12000);
    setTimeout(function(){
      window.__SMOKE = {
        reqBefore: window.__REQ1, reqAfter: window.__REQ2,
        sleep: z.sleepMode(),
        bubble: (document.querySelector(".z02-bubble") || {}).textContent || ""
      };
    }, 15000);
  })()`;
  const r = runShot({ evalExpr, infoExpr: "window.__SMOKE", wait: 17000 });
  const i = r.info || {};
  record("2", "小请求（要糖）发起", i.reqBefore === true);
  record("2", "投喂完成小请求", i.reqAfter === false);
  record("2", "晚安仪式有回应（话术/入睡）", i.sleep === true || /晚安|睡/.test(String(i.bubble || "")), "bubble=" + String(i.bubble || "").slice(0, 30));
  record("2", "睡眠机制可用（sleepNow）", i.sleep === true);
}

if (!FAST) {
  /* ---------------- 组 3：模型切换 / 数据导出 / 设置 ---------------- */
  section("组 3：模型切换 / 数据导出 / 设置面板");
  {
    const evalExpr = `(function(){
      var z = __z02;
      z.state.seenGuide = true;
      var g = document.querySelector('[data-role="z02-guide"]'); if (g) g.remove();
      window.__SM = {};
      z.openPanel("settings");
      setTimeout(function(){ var b = document.querySelector('[data-act="exportdata"]'); if (b) { b.click(); __SM.export = b.textContent; } }, 800);
      setTimeout(function(){ z.closePanel(); z.openPanel("settings"); setTimeout(function(){ var b = document.querySelector('[data-hd="1"]'); if (b) b.click(); }, 300); }, 1600);
      setTimeout(function(){
        var c = z.getChar();
        __SM.hdHeight = c ? +c.height.toFixed(2) : null;
        __SM.hdBones = c && c._bones ? Object.keys(c._bones).length : 0;
        var s = document.querySelector('[data-hd="0"]'); if (s) s.click();
      }, 11000);
      setTimeout(function(){
        var c = z.getChar();
        __SM.backHeight = c ? +c.height.toFixed(2) : null;
        __SM.backBones = c && c._bones ? Object.keys(c._bones).length : 0;
        __SM.voiceSupported = !!(window.VOICE && VOICE.status && VOICE.status().supported);
        __SM.picStyle = z.state.picStyle;
        window.__SMOKE = __SM;
      }, 24000);
    })()`;
    const r = runShot({ evalExpr, infoExpr: "window.__SMOKE", wait: 26000 });
    const i = r.info || {};
    record("3", "导出按钮可用", /导出/.test(String(i.export || "")), String(i.export || ""));
    record("3", "切到游戏风 Darling（24.29 / 242 骨）", Math.abs((i.hdHeight || 0) - 24.29) < 0.2 && (i.hdBones || 0) === 242, "h=" + i.hdHeight + " bones=" + i.hdBones);
    record("3", "切回经典 TDA（19.69 / 322 骨）", Math.abs((i.backHeight || 0) - 19.69) < 0.2 && (i.backBones || 0) === 322, "h=" + i.backHeight + " bones=" + i.backBones);
    record("3", "TTS 可用性探测", i.voiceSupported === true);
    record("3", "画面风格状态存在", !!i.picStyle, String(i.picStyle || ""));
  }
}

/* ---------------- 汇总 ---------------- */
const pass = results.filter((r) => r.ok).length;
const fail = results.length - pass;
console.log("\n" + "─".repeat(40));
console.log(`冒烟结果：${pass} 通过 / ${fail} 失败（共 ${results.length}）`);
if (fail) {
  console.log("失败项：");
  results.filter((r) => !r.ok).forEach((r) => console.log("  - [" + r.group + "] " + r.name + " " + (r.detail || "")));
}
process.exit(fail ? 1 : 0);
