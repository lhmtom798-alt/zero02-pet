#!/usr/bin/env node
/**
 * 把 three.module.min.js（ESM）转成可直接 <script> 引入的经典脚本：
 * 去掉尾部 export 语句，改成把命名空间挂到 window.THREE。
 *
 * 这样插件客户端里可以同步使用（不需要动态 import），
 * 桌面壳/预览页/无网环境都不会因为 MIME 或 CSP 出岔子。
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "vendor", "three.module.min.js");
const OUT = path.join(HERE, "..", "vendor", "three.global.js");

const code = readFileSync(SRC, "utf8");
const at = code.lastIndexOf("export{");
if (at < 0) throw new Error("找不到 export 语句");

const head = code.slice(0, at);
const tail = code.slice(at + "export{".length, code.indexOf("}", at));
const body = code.slice(0, at);

// export{a as B, c as D, E}  ->  B: a, D: c, E: E
const pairs = [];
for (const item of tail.split(",")) {
  const s = item.trim();
  if (!s) continue;
  const m = /^([\w$]+)\s+as\s+([\w$]+)$/.exec(s);
  if (m) pairs.push([m[2], m[1]]);
  else pairs.push([s, s]);
}
if (pairs.length < 300) throw new Error("导出数量异常: " + pairs.length);

const map = pairs.map(([name, local]) => JSON.stringify(name) + ": " + local).join(", ");
const out = `/* three.js r166 (MIT) —— 由 tools/make-three-global.mjs 从 ESM 构建产物转换，勿手改 */
(function () {
"use strict";
${body}
var __three = { ${map} };
try { window.THREE = __three; } catch (e) {}
try { globalThis.THREE = __three; } catch (e) {}
})();
`;
writeFileSync(OUT, out);
console.log("wrote", OUT, (out.length / 1024).toFixed(0) + "KB", "exports:", pairs.length);
