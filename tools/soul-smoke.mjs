#!/usr/bin/env node
/**
 * zero02-pet 灵魂功能冒烟：话题 / 约定 / 夸奖 / 心情驱动 / 时段 / 追问 / 上限。
 *
 *   node tools/soul-smoke.mjs
 *
 * 依赖：tools/serve.py 在 :8899 运行（把插件预览挂在 /preview/）。
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";

const NODE = process.env.NODE || process.execPath;
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SHOT = path.join(ROOT, "tools", "shot.mjs");
const URL_BASE = process.env.URL || "http://127.0.0.1:8899/preview/?pkg=zero02-pet&z02debug=1&skin=onee";
const READY = "window.__z02 && __z02.get3d() && __z02.get3d().ready('onee')";

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log((ok ? "  ✅ " : "  ❌ ") + name + (detail ? "  — " + detail : ""));
}

function runShot({ evalExpr, infoExpr, wait }) {
  const args = [
    SHOT,
    "--url", URL_BASE,
    "--out", path.join(os.tmpdir(), "z02-soul.png"),
    "--size", "900x820",
    "--wait", String(wait || 12000),
    "--ready", READY,
    "--eval", evalExpr,
    "--info", infoExpr || "({})",
  ];
  const r = spawnSync(NODE, args, { cwd: ROOT, encoding: "utf8", timeout: 120000 });
  const out = (r.stdout || "") + (r.stderr || "");
  const m = out.match(/^info: (.*)$/m);
  let info = null;
  if (m) { try { info = JSON.parse(m[1]); } catch { info = m[1]; } }
  return { info, out, code: r.status };
}

/* 组 1：记忆类（话题 / 约定 / 夸奖 / 追问 / 提醒台词） */
{
  console.log("\n▶ 组 1：话题 / 约定 / 夸奖 / 追问");
  const evalExpr = `(function(){
    var z = __z02;
    z.state.seenGuide = true;
    var g = document.querySelector('[data-role="z02-guide"]'); if (g) g.remove();
    z.state.history = []; z.state.topics = []; z.state.promises = []; z.state.compliments = [];
    z.state.lastPromiseAt = 0; z.state.lastComplimentAt = 0;
    setTimeout(function(){ z.sendMessage("今天在做一个桌宠项目，感觉快做完了"); }, 700);
    setTimeout(function(){ z.sendMessage("等这个项目做完，我们一起去海边看日出吧"); }, 3000);
    setTimeout(function(){ z.sendMessage("你今天好可爱，眼睛特别好看"); }, 6000);
    setTimeout(function(){
      window.__SOUL = {
        topics: z.state.topics || [],
        promises: (z.state.promises || []).map(function(p){ return p.text; }),
        compliments: z.state.compliments || [],
        topicFollowUp: z.topicFollowUp(),
        promiseLine: z.promiseLine(),
        complimentLine: z.complimentLine()
      };
    }, 14000);
  })()`;
  const r = runShot({ evalExpr, infoExpr: "window.__SOUL", wait: 16000 });
  const i = r.info || {};
  record("话题入库", Array.isArray(i.topics) && i.topics.some((t) => /桌宠项目/.test(t)), "topics=" + String(i.topics || []).slice(0, 60));
  record("约定入库", Array.isArray(i.promises) && i.promises.some((t) => /海边/.test(t)), "promises=" + String(i.promises || []).slice(0, 60));
  record("夸奖入库", Array.isArray(i.compliments) && i.compliments.some((t) => /可爱/.test(t)), "compliments=" + String(i.compliments || []).slice(0, 60));
  record("追问接得住话题", /桌宠项目|话题/.test(String(i.topicFollowUp || "")), String(i.topicFollowUp || "").slice(0, 40));
  record("约定提醒台词", /海边/.test(String(i.promiseLine || "")), String(i.promiseLine || "").slice(0, 40));
  record("夸奖回想台词", /可爱|眼睛/.test(String(i.complimentLine || "")), String(i.complimentLine || "").slice(0, 40));
}

/* 组 2：心情驱动 / 时段台词 / 上限 / 周记门槛 */
{
  console.log("\n▶ 组 2：心情驱动 / 时段 / 上限 / 周记门槛");
  const evalExpr = `(function(){
    var z = __z02;
    z.state.seenGuide = true;
    var g = document.querySelector('[data-role="z02-guide"]'); if (g) g.remove();
    var moods = {};
    ["clingy", "lazy", "tsundere", "sweets"].forEach(function(id){
      z.state.dailyMood = { date: z.todayKey(), id: id, label: id, hint: "", prompt: "", line: "" };
      moods[id] = z.moodDrives();
    });
    // 上限：塞入超量数据后 reload 由另一轮验证，这里验证写入路径
    z.state.memory = []; for (var i = 0; i < 40; i++) z.state.memory.push("记忆" + i);
    z.state.topics = []; for (var j = 0; j < 30; j++) z.state.topics.push("话题" + j);
    z.rememberFact("喜欢：草莓蛋糕");
    z.noteTopic("压力测试话题X");
    // 周记门槛：刚写过（1 天前）→ 不应重复生成
    var now = Date.now();
    z.state.weekNotes = [{ t: now - 86400000, date: z.todayKey(), text: "上一周的小记" }];
    var weeklyBlocked = null;
    z.genWeekNote().then(function(ok){ weeklyBlocked = ok === false; });
    setTimeout(function(){
      window.__SOUL2 = {
        moods: moods,
        hourLine: z.hourLine("evening"),
        memCap: (z.state.memory || []).length,
        topicsCap: (z.state.topics || []).length,
        weeklyBlocked: weeklyBlocked,
        errorFree: true
      };
    }, 2400);
  })()`;
  const r = runShot({ evalExpr, infoExpr: "window.__SOUL2", wait: 15000 });
  const i = r.info || {};
  const m = i.moods || {};
  record("黏人更主动（proactiveMul<1）", m.clingy && m.clingy.proactiveMul < 1, JSON.stringify(m.clingy || {}));
  record("懒懒更安静（proactiveMul>1）", m.lazy && m.lazy.proactiveMul > 1, JSON.stringify(m.lazy || {}));
  record("心情影响犯困阈值", m.clingy && m.lazy && m.clingy.sleepMs > m.lazy.sleepMs, (m.clingy ? m.clingy.sleepMs : "?") + " vs " + (m.lazy ? m.lazy.sleepMs : "?"));
  record("时段台词可用", /傍晚|辛苦|天暗/.test(String(i.hourLine || "")), String(i.hourLine || "").slice(0, 30));
  record("记忆写入后裁剪到 16", i.memCap === 16, "mem=" + i.memCap);
  record("话题写入后裁剪到 10", i.topicsCap === 10, "topics=" + i.topicsCap);
  record("周记去重（1 天内不重复生成）", i.weeklyBlocked === true, "blocked=" + i.weeklyBlocked);
}

/* 组 3：生日 / 纪念日 / 周记内容 */
{
  console.log("\n▶ 组 3：生日 / 纪念日 / 周记");
  const evalExpr = `(function(){
    var z = __z02;
    z.state.seenGuide = true;
    var g = document.querySelector('[data-role="z02-guide"]'); if (g) g.remove();
    z.state.birthday = { m: new Date().getMonth() + 1, d: new Date().getDate() };
    z.state.lastBirthdaySaid = "";
    z.state.lastAnnivSaid = "";
    z.state.weekNotes = [];
    var bd = z.noteBirthday("我的生日是" + (new Date().getMonth() + 1) + "月" + new Date().getDate() + "日");
    window.__SOUL3 = {
      birthdayParsed: bd,
      birthdayLine: z.birthdayLine(),
      anniversaryLineToday: z.anniversaryLine(),
      daysKnown: z.daysKnown()
    };
  })()`;
  const r = runShot({ evalExpr, infoExpr: "window.__SOUL3", wait: 13000 });
  const i = r.info || {};
  record("生日可解析（X月X日）", !!(i.birthdayParsed && i.birthdayParsed.m && i.birthdayParsed.d), JSON.stringify(i.birthdayParsed || null));
  record("生日当天有专属台词", /生日|蛋糕/.test(String(i.birthdayLine || "")), String(i.birthdayLine || "").slice(0, 30));
  record("认识天数可读（纪念日依据）", typeof i.daysKnown === "number" && i.daysKnown >= 1, "days=" + i.daysKnown);
}

const pass = results.filter((r) => r.ok).length;
console.log("\n" + "─".repeat(40));
console.log("灵魂冒烟：".replace("：", "") + pass + " 通过 / " + (results.length - pass) + " 失败（共 " + results.length + "）");
process.exit(pass === results.length ? 0 : 1);
