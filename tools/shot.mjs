#!/usr/bin/env node
/**
 * 无头 Chrome 截图 / 交互验收工具（CDP）。
 *
 *   node tools/shot.mjs --url "http://127.0.0.1:8899/lab/?char=chibi" --out shots/chibi.png
 *
 * 可用参数：
 *   --url    要打开的地址                      --out   输出 png 路径
 *   --size   视口尺寸，默认 1280x900            --wait  截图前额外等待 ms，默认 700
 *   --eval   截图前执行的 JS 表达式（可重复）    --ready 就绪判定的 JS 表达式，默认 window.__LAB_READY
 *   --timeout 就绪超时 ms，默认 20000           --info  截图后执行的表达式，打印返回值
 *   --keep   不关闭 Chrome（调试用）             --click 点击坐标 "x,y"（可重复）
 *
 * 页面里的 console.error / 未捕获异常会被捕获并打印，方便定位。
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function parseArgs(argv) {
  const out = { size: "1280x900", wait: 700, timeout: 20000, eval: [], click: [], drag: [], dblclick: [], ready: "window.__LAB_READY" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--url": out.url = next(); break;
      case "--out": out.out = next(); break;
      case "--size": out.size = next(); break;
      case "--wait": out.wait = Number(next()); break;
      case "--eval": out.eval.push(next()); break;
      case "--click": out.click.push(next()); break;
      case "--ready": out.ready = next(); break;
      case "--timeout": out.timeout = Number(next()); break;
      case "--info": out.info = next(); break;
      case "--drag": out.drag.push(next()); break;
      case "--dblclick": out.click.push(next()); break;
      case "--keep": out.keep = true; break;
      case "--transparent": out.transparent = true; break;
      default: break;
    }
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitPort(port, timeout) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return await res.json();
    } catch {}
    await sleep(120);
  }
  throw new Error("Chrome 调试端口未就绪");
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener("message", (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id != null) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else p.resolve(msg.result);
        return;
      }
      const list = this.handlers.get(msg.method);
      if (list) for (const fn of list) { try { fn(msg.params); } catch {} }
    });
  }
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error("CDP 超时: " + method));
        }
      }, 30000);
    });
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) throw new Error("页面异常: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result?.value;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.url || !args.out) {
    console.error("用法: node tools/shot.mjs --url <url> --out <png>");
    process.exit(2);
  }
  const [w, h] = args.size.split("x").map(Number);
  const port = 9400 + (process.pid % 400);
  const profile = path.join(os.tmpdir(), "z02-chrome-" + port);
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});

  const chrome = spawn(CHROME, [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--window-size=${w},${h}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--hide-scrollbars",
    "--enable-unsafe-swiftshader",
    "--use-angle=swiftshader",
    "--force-device-scale-factor=1",
    "--mute-audio",
    "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });

  const logs = [];
  let ws = null;
  let code = 0;
  try {
    await waitPort(port, 15000);
    const created = await fetch(`http://127.0.0.1:${port}/json/new?url=about:blank`, { method: "PUT" }).then((r) => r.json());
    ws = new WebSocket(created.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
      setTimeout(() => reject(new Error("ws 连接超时")), 8000);
    });
    const cdp = new CDP(ws);

    cdp.on("Runtime.consoleAPICalled", (p) => {
      if (p.type === "error" || p.type === "warning") {
        const text = (p.args || []).map((a) => a.value ?? a.description ?? a.type).join(" ");
        logs.push(`[console.${p.type}] ${text}`);
      }
    });
    cdp.on("Runtime.exceptionThrown", (p) => {
      const d = p.exceptionDetails;
      logs.push(`[pageerror] ${d.exception?.description || d.text}`);
    });
    cdp.on("Log.entryAdded", (p) => {
      if (p.entry.level === "error") logs.push(`[log] ${p.entry.text} ${p.entry.url || ""}`);
    });

    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    if (args.transparent) {
      await cdp.send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
    }

    const loaded = new Promise((resolve) => cdp.on("Page.loadEventFired", () => resolve()));
    await cdp.send("Page.navigate", { url: args.url });
    await Promise.race([loaded, sleep(args.timeout)]);

    // 等页面自报就绪
    if (args.ready) {
      const end = Date.now() + args.timeout;
      let ok = false;
      while (Date.now() < end) {
        try {
          if (await cdp.eval(`Boolean(${args.ready})`)) { ok = true; break; }
        } catch {}
        await sleep(150);
      }
      if (!ok) throw new Error(`等待 ${args.ready} 超时（${args.timeout}ms）`);
    }

    for (const expr of args.eval) await cdp.eval(expr);
    for (const click of args.click) {
      const [x, y] = click.split(",").map(Number);
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    }
    for (const dbl of args.dblclick) {
      const [x, y] = dbl.split(",").map(Number);
      for (const n of [1, 2]) {
        await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: n });
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: n });
      }
    }
    // --drag "x1,y1,x2,y2[,button[,steps]]"：右键拖动可以验证 3D 转视角
    for (const spec of args.drag) {
      const parts = spec.split(",").map(Number);
      const [x1, y1, x2, y2] = parts;
      const button = parts[4] === 2 ? "right" : "left";
      const steps = parts[5] || 8;
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: x1, y: y1, button, clickCount: 1 });
      for (let i = 1; i <= steps; i++) {
        await cdp.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: x1 + ((x2 - x1) * i) / steps,
          y: y1 + ((y2 - y1) * i) / steps,
          button,
          buttons: button === "right" ? 2 : 1,
        });
        await sleep(16);
      }
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: x2, y: y2, button, clickCount: 1 });
    }
    if (args.wait) await sleep(args.wait);

    const shot = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
    await fs.mkdir(path.dirname(args.out), { recursive: true }).catch(() => {});
    await fs.writeFile(args.out, Buffer.from(shot.data, "base64"));
    console.log("screenshot:", args.out, `(${w}x${h})`);

    if (args.info) {
      try { console.log("info:", JSON.stringify(await cdp.eval(args.info))); } catch (e) { console.log("info 失败:", e.message); }
    }
  } catch (error) {
    code = 1;
    console.error("FAIL:", error.message);
  } finally {
    if (logs.length) {
      console.error("---- 页面日志 ----");
      for (const l of logs) console.error(l);
    }
    if (!args.keep) {
      try { ws && ws.close(); } catch {}
      chrome.kill("SIGKILL");
      await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
    } else {
      console.error("--keep：Chrome 保持运行，port =", port);
    }
    process.exit(code);
  }
}

main();
