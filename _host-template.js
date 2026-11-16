// __ID__ —— DSH 桌宠插件（宿主半边）
// 只做两件事：
//   1) 把包内 assets 以只读静态路由提供给浏览器；
//   2) 提供 /chat 代理，把对话转发到用户配置的 OpenAI 兼容端点
//      （默认本地 http://127.0.0.1:11434/v1，也就是 Ollama，零成本）。
// 不写盘、不读凭据、不调子进程、无遥测。
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const name = "__ID__";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.join(HERE, "..", "assets");

const MIME = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

const MAX_BODY = 256 * 1024;
const RUNTIME = { lastPing: 0, ver: '', where: '', note: '' };
const DEFAULT_BASE = "http://127.0.0.1:11434/v1";
const DEFAULT_MODEL = "qwen2.5:7b-instruct";

/* ---------- 自动发现 DSH 自己的模型端点（这样桌宠开箱就能说话） ----------
   读取 ~/.dsh/.credentials.yaml 里的 DEEPSEEK_API_KEY，以及
   ~/.dsh/profiles/<profile>/cordis.patch.yml 里 llm-deepseek 的 baseURL。
   只在宿主进程里用，密钥不会下发到浏览器。 */
const AUTO = { at: 0, baseURL: "", apiKey: "", model: "deepseek-flash", source: "" };
function readTextSafe(p) { try { return readFileSync(p, "utf8"); } catch { return ""; } }
function discoverAutoEndpoint() {
  if (Date.now() - AUTO.at < 15000 && AUTO.at) return AUTO;
  AUTO.at = Date.now();
  AUTO.baseURL = ""; AUTO.apiKey = ""; AUTO.source = "";
  let model = "deepseek-flash";
  try {
    const home = os.homedir();
    const creds = readTextSafe(path.join(home, ".dsh", ".credentials.yaml"));
    const m = /DEEPSEEK_API_KEY:\s*([^\s"']+)/.exec(creds);
    if (m) { AUTO.apiKey = m[1]; AUTO.source = "credentials"; }
    const profRoot = path.join(home, ".dsh", "profiles");
    let profiles = [];
    try { profiles = readdirSync(profRoot); } catch {}
    for (const prof of profiles) {
      const yml = readTextSafe(path.join(profRoot, prof, "cordis.patch.yml"));
      const b = /baseURL:\s*([^\s"']+)/.exec(yml);
      if (b && /^https?:\/\//.test(b[1])) { AUTO.baseURL = b[1].replace(/\/+$/, ""); break; }
      const mm = /model:\s*(deepseek-[\w.-]+)/.exec(yml);
      if (mm) model = mm[1];
    }
    // 顺便从 profile 读取默认模型名
    const anyYml = profiles.length ? readTextSafe(path.join(profRoot, profiles[0], "cordis.patch.yml")) : "";
    const mm2 = /model:\s*(deepseek-[\w.-]+)/.exec(anyYml);
    if (mm2) model = mm2[1];
  } catch {}
  AUTO.model = model;
  return AUTO;
}

function safeResolve(rel) {
  const target = path.normalize(path.join(ASSETS_DIR, rel));
  if (target !== ASSETS_DIR && !target.startsWith(ASSETS_DIR + path.sep)) return null;
  return target;
}

function isLoopback(req) {
  try {
    const host = new URL("http://" + String(req.headers.host || "")).hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".localhost") || host === "::1") return true;
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    return !!m && Number(m[1]) === 127 && [m[2], m[3], m[4]].every((x) => Number(x) <= 255);
  } catch {
    return false;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("请求体过大"));
        try { req.destroy(); } catch {}
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJSON(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function serveAsset(req, res) {
  try {
    const url = new URL(req.url, "http://127.0.0.1");
    const rel = (url.searchParams.get("f") || "").split("?")[0];
    const file = safeResolve(rel);
    if (!file || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    });
    createReadStream(file).pipe(res);
  } catch (error) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(String(error && error.message ? error.message : error));
  }
}

async function serveChat(req, res) {
  if (req.method !== "POST") return sendJSON(res, 405, { ok: false, error: "只接受 POST" });
  if (!isLoopback(req)) return sendJSON(res, 403, { ok: false, error: "仅允许本机访问" });

  let timer = null;
  try {
    const raw = await readBody(req);
    const body = JSON.parse(raw || "{}");

    // 客户端没配置端点时，自动使用 DSH 自己的模型端点（教师发放的 key 之类）
    const wantedAuto = !body.baseURL && !body.apiKey;
    const auto = wantedAuto ? discoverAutoEndpoint() : null;
    const autoUsable = !!(auto && auto.baseURL && auto.apiKey);
    const baseURL = String(body.baseURL || (autoUsable ? auto.baseURL : DEFAULT_BASE)).trim().replace(/\/+$/, "");
    const model = String(body.model || (autoUsable ? auto.model : DEFAULT_MODEL)).trim();
    const apiKey = typeof body.apiKey === "string" && body.apiKey.trim()
      ? body.apiKey.trim()
      : (autoUsable ? auto.apiKey : "");
    const messages = Array.isArray(body.messages)
      ? body.messages
          .filter((m) => m && typeof m.content === "string" && (m.role === "user" || m.role === "assistant" || m.role === "system"))
          .slice(-20)
          .map((m) => ({ role: m.role, content: String(m.content).slice(0, 4000) }))
      : [];

    if (!messages.length) return sendJSON(res, 200, { ok: false, error: "没有消息" });

    const target = new URL(baseURL.replace(/\/v1$/, "") + "/v1/chat/completions");
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      return sendJSON(res, 200, { ok: false, error: "端点必须是 http/https" });
    }

    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), 45000);
    const started = Date.now();

    const upstream = await fetch(target, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: "Bearer " + apiKey } : {}),
      },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        temperature: 0.85,
        max_tokens: 700,
      }),
      signal: controller.signal,
    });

    const text = await upstream.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}

    if (!upstream.ok) {
      return sendJSON(res, 200, {
        ok: false,
        error: "上游 " + upstream.status + "：" + String((data && (data.error && data.error.message)) || text).slice(0, 240),
      });
    }

    const reply =
      (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
    return sendJSON(res, 200, {
      ok: true,
      reply: String(reply).trim().slice(0, 1200),
      ms: Date.now() - started,
      model,
      auto: wantedAuto && autoUsable ? "dsh" : undefined,
    });
  } catch (error) {
    const message = error && error.name === "AbortError" ? "上游超时（45s）" : String((error && error.message) || error);
    return sendJSON(res, 200, { ok: false, error: message });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function serveConfig(req, res) {
  try {
    const auto = discoverAutoEndpoint();
    const ok = !!(auto.baseURL && auto.apiKey);
    return sendJSON(res, 200, {
      ok: true,
      auto: ok,
      model: auto.model || "",
      source: auto.source || "",
      hasKey: !!auto.apiKey,
      hasEndpoint: !!auto.baseURL,
    });
  } catch (error) {
    return sendJSON(res, 200, { ok: false, auto: false, error: String((error && error.message) || error) });
  }
}

function servePing(req, res) {
  try {
    const url = new URL(req.url, "http://127.0.0.1");
    RUNTIME.lastPing = Date.now();
    RUNTIME.ver = String(url.searchParams.get("ver") || "");
    RUNTIME.where = String(url.searchParams.get("where") || "");
    RUNTIME.note = String(url.searchParams.get("note") || "").slice(0, 200);
  } catch {}
  sendJSON(res, 200, { ok: true });
}

function serveStatus(req, res) {
  sendJSON(res, 200, {
    ok: true,
    now: Date.now(),
    lastPing: RUNTIME.lastPing,
    sinceMs: RUNTIME.lastPing ? Date.now() - RUNTIME.lastPing : -1,
    ver: RUNTIME.ver,
    where: RUNTIME.where,
    note: RUNTIME.note,
  });
}

async function listModels(req, res) {
  if (!isLoopback(req)) return sendJSON(res, 403, { ok: false, error: "仅允许本机访问" });
  try {
    const raw = await readBody(req);
    const body = JSON.parse(raw || "{}");
    const wantedAuto = !body.baseURL && !body.apiKey;
    const auto = wantedAuto ? discoverAutoEndpoint() : null;
    const autoUsable = !!(auto && auto.baseURL && auto.apiKey);
    const baseURL = String(body.baseURL || (autoUsable ? auto.baseURL : DEFAULT_BASE)).trim().replace(/\/+$/, "");
    const apiKey = typeof body.apiKey === "string" && body.apiKey.trim()
      ? body.apiKey.trim()
      : (autoUsable ? auto.apiKey : "");
    const target = new URL(baseURL.replace(/\/v1$/, "") + "/v1/models");
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      return sendJSON(res, 200, { ok: false, error: "端点必须是 http/https" });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const upstream = await fetch(target, {
      headers: apiKey ? { Authorization: "Bearer " + apiKey } : {},
      signal: controller.signal,
    });
    clearTimeout(timer);
    const text = await upstream.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}
    if (!upstream.ok) {
      return sendJSON(res, 200, { ok: false, error: "HTTP " + upstream.status + "：" + String(text).slice(0, 160) });
    }
    const list = (data && (data.data || data.models)) || [];
    const models = list.map((m) => (typeof m === "string" ? m : m.id || m.name || "")).filter(Boolean).slice(0, 40);
    return sendJSON(res, 200, { ok: true, models });
  } catch (error) {
    const message = error && error.name === "AbortError" ? "连接超时（8s）" : String((error && error.message) || error);
    return sendJSON(res, 200, { ok: false, error: message });
  }
}

export async function apply(ctx) {
  ctx.inject(["webServer"], (wctx) => {
    const webServer = wctx.get("webServer");
    const disposers = [
      webServer.register({ kind: "exact", path: "/api/__ID__/assets", handler: serveAsset }),
      webServer.register({ kind: "exact", path: "/api/__ID__/chat", handler: serveChat }),
      webServer.register({ kind: "exact", path: "/api/__ID__/models", handler: listModels }),
      webServer.register({ kind: "exact", path: "/api/__ID__/config", handler: serveConfig }),
      webServer.register({ kind: "exact", path: "/api/__ID__/ping", handler: servePing }),
      webServer.register({ kind: "exact", path: "/api/__ID__/status", handler: serveStatus }),
      // 兼容：旧版单形象插件（已卸载）残留的前端 bundle 仍会来要图，给它们同一份素材
      ...["zero02-anime", "zero02-chibi"].map((old) =>
        webServer.register({ kind: "exact", path: "/api/" + old + "/assets", handler: serveAsset })
      ),
    ];
    wctx.effect(() => () => {
      for (const dispose of disposers) {
        try { dispose(); } catch {}
      }
    }, "__ID__: routes");
  });
}
