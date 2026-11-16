#!/usr/bin/env python3
"""开发服务器：同时伺候 lab（3D 试衣间）、插件预览、素材和 mock 接口。

  /lab/...              角色实验室
  /preview/...          插件预览（旧 preview/index.html）
  /vendor /src /shots   静态文件
  /pkg/<pkg>/...        插件包内文件
  /api/<id>/assets?f=   包内素材
  /api/<id>/chat|models|ping|status|log   模拟宿主
"""
import json
import os
import pathlib
import re
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = pathlib.Path(__file__).resolve().parent.parent
PORT = 8899

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".png": "image/png",
    ".webp": "image/webp",
    ".jpg": "image/jpeg",
    ".json": "application/json; charset=utf-8",
    ".glb": "model/gltf-binary",
    ".svg": "image/svg+xml",
}

STUB_REPLY = "（预览模式）darling，现在连的是本地假接口。装进 DSH 之后我就能真的跟你说话了。"

LOG_PATH = ROOT / "shots" / "server.log"


def log(line: str):
    try:
        with LOG_PATH.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def _send(self, code, body: bytes, ctype="text/plain; charset=utf-8", extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def serve_file(self, target: pathlib.Path, base: pathlib.Path):
        try:
            target = target.resolve()
            target.relative_to(base.resolve())
        except ValueError:
            return self._send(404, b"not found")
        if not target.is_file():
            return self._send(404, b"not found")
        return self._send(200, target.read_bytes(), MIME.get(target.suffix.lower(), "application/octet-stream"))

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = urllib.parse.unquote(parsed.path)
        query = urllib.parse.parse_qs(parsed.query)

        if path.startswith("/api/") and path.endswith("/assets"):
            pkg = path.split("/")[2]
            name = (query.get("f") or [""])[0].split("?")[0]
            return self.serve_file(ROOT / pkg / "assets" / name, ROOT / pkg / "assets")

        if path.startswith("/api/"):
            if path.endswith("/config"):
                return _serve_config(self)
            if path.endswith("/status") or path.endswith("/ping"):
                return self._send(200, json.dumps({"ok": True, "now": 0, "lastPing": 0, "sinceMs": -1}).encode(), MIME[".json"])
            if path.endswith("/log"):
                try:
                    return self._send(200, LOG_PATH.read_bytes(), MIME[".json"])
                except Exception:
                    return self._send(200, b"[]", MIME[".json"])
            return self._send(404, b"not found")

        if path.startswith("/pkg/"):
            _, _, pkg, *rest = path.split("/")
            return self.serve_file(ROOT / pkg / "/".join(rest), ROOT / pkg)

        # 静态根目录（lab / vendor / src / shots / preview）
        if path.endswith("/"):
            path += "index.html"
        if path == "/":
            path = "/lab/index.html"
        return self.serve_file(ROOT / path.lstrip("/"), ROOT)

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        if self.path.startswith("/api/") and self.path.endswith("/models"):
            payload = json.dumps({"ok": True, "models": ["qwen2.5:3b", "qwen2.5:7b", "llama3.2:3b"]}).encode()
            return self._send(200, payload, MIME[".json"])
        if self.path.startswith("/api/") and self.path.endswith("/chat"):
            return _serve_chat(self, raw)
        if self.path.startswith("/api/") and self.path.endswith("/log"):
            try:
                entry = json.loads(raw or b"{}")
                log(json.dumps(entry, ensure_ascii=False))
            except Exception:
                pass
            return self._send(200, b'{"ok":true}', MIME[".json"])
        return self._send(404, b"not found")


def _auto_endpoint():
    """和宿主一样的自动端点发现：读 ~/.dsh 的 key 和 profile 的 baseURL。"""
    home = os.path.expanduser("~")
    base, key, model = "", "", "deepseek-flash"
    try:
        with open(os.path.join(home, ".dsh", ".credentials.yaml")) as f:
            m = re.search(r"DEEPSEEK_API_KEY:\s*([^\s\"']+)", f.read())
            if m: key = m.group(1)
    except Exception:
        pass
    prof = os.path.join(home, ".dsh", "profiles")
    try:
        for d in os.listdir(prof):
            try:
                with open(os.path.join(prof, d, "cordis.patch.yml")) as f:
                    txt = f.read()
                b = re.search(r"baseURL:\s*([^\s\"']+)", txt)
                mm = re.search(r"model:\s*(deepseek-[\w.-]+)", txt)
                if b and b.group(1).startswith("http"): base = b.group(1).rstrip("/")
                if mm: model = mm.group(1)
                if base: break
            except Exception:
                pass
    except Exception:
        pass
    return base, key, model


def _serve_config(self):
    base, key, model = _auto_endpoint()
    payload = json.dumps({"ok": True, "auto": bool(base and key), "model": model, "source": "dev", "hasKey": bool(key), "hasEndpoint": bool(base)}).encode()
    return self._send(200, payload, MIME[".json"])


def _serve_chat(self, raw):
    try:
        body = json.loads(raw or b"{}")
    except Exception:
        body = {}
    auto_base, auto_key, auto_model = _auto_endpoint()
    if body.get("baseURL"):
        # 明确指定了端点就严格按它来（模拟宿主行为，本地失败才能正常降级到云端）
        base, api_key, mdl = str(body["baseURL"]).rstrip("/"), body.get("apiKey") or "", body.get("model") or ""
    else:
        base, api_key, mdl = auto_base, auto_key, auto_model
    if base:
        try:
            req = urllib.request.Request(
                base.rstrip("/").removesuffix("/v1") + "/v1/chat/completions",
                data=json.dumps({"model": mdl, "messages": body.get("messages") or [], "stream": False,
                                 "temperature": 0.85, "max_tokens": 700}).encode(),
                headers={"Content-Type": "application/json", "Authorization": "Bearer " + api_key},
            )
            with urllib.request.urlopen(req, timeout=45) as r:
                data = json.loads(r.read().decode())
            reply = (data.get("choices") or [{}])[0].get("message", {}).get("content", "")
            payload = json.dumps({"ok": True, "reply": reply, "ms": 1, "model": mdl, "auto": "dev"}, ensure_ascii=False).encode()
            return self._send(200, payload, MIME[".json"])
        except Exception as e:
            payload = json.dumps({"ok": False, "error": "上游失败：" + str(e)[:200]}).encode()
            return self._send(200, payload, MIME[".json"])
    # 没配置 -> stub
    reply = STUB_REPLY
    try:
        last = ""
        for m in reversed(body.get("messages") or []):
            if m.get("role") == "user":
                last = m.get("content", ""); break
        if last: reply = "（预览模式）你刚说「" + last[:24] + "」。"
    except Exception:
        pass
    payload = json.dumps({"ok": True, "reply": reply, "ms": 42, "model": "preview-stub"}).encode()
    return self._send(200, payload, MIME[".json"])


if __name__ == "__main__":
    print(f"dev server on http://127.0.0.1:{PORT}/lab/")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
