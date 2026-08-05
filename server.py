#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Firefly CMS —— 基于 GitHub Contents API 的静态博客内容管理后台

设计要点：
- GitHub 访问令牌只保存在服务端 config.json，绝不下发到浏览器。
- 浏览器只持有一个会话令牌（session_token），用于调用本服务的 API。
- 本服务代理所有 GitHub 操作：列目录 / 读文件 / 写文件 / 删文件 / 上传二进制。
- 零第三方依赖，仅使用 Python 标准库，可直接 `python server.py` 运行，
  或打包进 Docker 部署。
"""

import json
import base64
import os
import hashlib
import secrets
import urllib.request
import urllib.parse
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(BASE, "public")
DATA = os.path.join(BASE, "data")
CONFIG_PATH = os.path.join(DATA, "config.json")
CONTENT_ROOT = "src/content"  # Firefly 内容根目录

PORT = int(os.environ.get("PORT", "8000"))
HOST = os.environ.get("HOST", "0.0.0.0")


# --------------------------------------------------------------------------- #
# 配置读写
# --------------------------------------------------------------------------- #
def ensure_data():
    os.makedirs(DATA, exist_ok=True)


def load_config():
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {}
    return {}


def save_config(cfg):
    ensure_data()
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)


def hash_password(password, salt=None):
    if salt is None:
        salt = secrets.token_hex(16)
    h = hashlib.sha256((password + salt).encode("utf-8")).hexdigest()
    return f"{salt}:{h}"


def verify_password(password, stored):
    if not stored or ":" not in stored:
        return False
    salt, _ = stored.split(":", 1)
    return hash_password(password, salt).split(":")[1] == stored.split(":", 1)[1]


# --------------------------------------------------------------------------- #
# GitHub API 封装
# --------------------------------------------------------------------------- #
def github_headers(token):
    return {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "User-Agent": "FireflyCMS",
        "X-GitHub-Api-Version": "2022-11-28",
    }


def gh_request(method, url, token, data=None, is_binary=False):
    if data is not None:
        if is_binary:
            payload = data  # 已是 bytes（base64 字符串以 ascii 编码）
        else:
            payload = json.dumps(data).encode("utf-8")
    else:
        payload = None
    req = urllib.request.Request(url, method=method, data=payload)
    for k, v in github_headers(token).items():
        req.add_header(k, v)
    if payload is not None and not is_binary:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = resp.read().decode("utf-8", "replace")
            try:
                return resp.status, json.loads(body)
            except Exception:
                return resp.status, {"message": body}
    except urllib.error.HTTPError as e:
        err = e.read().decode("utf-8", "replace")
        try:
            err = json.loads(err)
        except Exception:
            pass
        return e.code, (err if isinstance(err, dict) else {"message": str(err)})
    except Exception as e:  # noqa
        return 500, {"message": str(e)}


def encode_path(path):
    """按段编码路径，保留 '/'。"""
    return "/".join(urllib.parse.quote(seg, safe="") for seg in path.split("/"))


def gh_get_contents(cfg, path, branch):
    url = (
        f"https://api.github.com/repos/{cfg['owner']}/{cfg['repo']}/contents/"
        f"{encode_path(path)}?ref={urllib.parse.quote(branch)}"
    )
    return gh_request("GET", url, cfg["github_token"])


def gh_put_contents(cfg, path, content_b64, message, branch, sha=None):
    url = (
        f"https://api.github.com/repos/{cfg['owner']}/{cfg['repo']}/contents/"
        f"{encode_path(path)}"
    )
    body = {"message": message, "content": content_b64, "branch": branch}
    if sha:
        body["sha"] = sha
    return gh_request("PUT", url, cfg["github_token"], data=body)


def gh_delete_contents(cfg, path, sha, message, branch):
    url = (
        f"https://api.github.com/repos/{cfg['owner']}/{cfg['repo']}/contents/"
        f"{encode_path(path)}"
    )
    body = {"message": message, "sha": sha, "branch": branch}
    return gh_request("DELETE", url, cfg["github_token"], data=body)


# --------------------------------------------------------------------------- #
# HTTP 处理
# --------------------------------------------------------------------------- #
class Handler(BaseHTTPRequestHandler):
    server_version = "FireflyCMS/1.0"

    # 让日志安静一点
    def log_message(self, fmt, *args):
        pass

    def _send(self, code, obj=None, ctype="application/json; charset=utf-8"):
        if obj is None:
            payload = b""
        elif isinstance(obj, (dict, list)):
            payload = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        else:
            payload = obj.encode("utf-8") if isinstance(obj, str) else obj
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)

    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8", "replace"))
        except Exception:
            return {}

    def _auth_token(self):
        h = self.headers.get("Authorization", "")
        if h.startswith("Bearer "):
            return h[len("Bearer "):].strip()
        return None

    def _authed(self):
        cfg = load_config()
        tok = self._auth_token()
        return bool(cfg.get("session_token")) and tok == cfg.get("session_token")

    # ----- 静态资源 -----
    def _serve_static(self, rel):
        if rel in ("", "/"):
            rel = "/index.html"
        if rel.startswith("/static/"):
            sub = rel[len("/static/"):]
        elif rel == "/index.html":
            sub = "index.html"
        else:
            sub = rel.lstrip("/")
        path = os.path.normpath(os.path.join(STATIC, sub))
        if not path.startswith(STATIC) or not os.path.isfile(path):
            self._send(404, {"error": "not found"})
            return
        ctype = {
            ".html": "text/html; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".svg": "image/svg+xml",
            ".ico": "image/x-icon",
        }.get(os.path.splitext(path)[1], "application/octet-stream")
        with open(path, "rb") as f:
            self._send(200, f.read(), ctype)

    # ----- 路由 -----
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        p = parsed.path
        if p == "/api/status":
            self.api_status()
            return
        if p.startswith("/api/"):
            self._send(404, {"error": "not found"})
            return
        # 其余均视为静态资源（/、/style.css、/app.js 等）
        self._serve_static(p)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        p = parsed.path
        if p == "/api/status":
            self.api_status()
        elif p == "/api/setup":
            self.api_setup()
        elif p == "/api/login":
            self.api_login()
        elif p == "/api/list":
            self.api_list()
        elif p == "/api/file":
            self.api_get_file()
        elif p == "/api/logout":
            self.api_logout()
        elif p == "/api/upload":
            self.api_upload()
        elif p == "/api/config":
            self.api_update_config()
        else:
            self._send(404, {"error": "not found"})

    def do_PUT(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/file":
            self.api_save_file()
        else:
            self._send(404, {"error": "not found"})

    def do_DELETE(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/file":
            self.api_delete_file()
        else:
            self._send(404, {"error": "not found"})

    # ----- API 实现 -----
    def api_status(self):
        cfg = load_config()
        # 与 Cloudflare Pages 版后端保持字段一致，新增 adminConfigured
        self._send(200, {
            "configured": bool(cfg.get("github_token")),
            "hasPassword": bool(cfg.get("admin_password_hash")),
            "adminConfigured": bool(cfg.get("admin_password_hash")),
            "owner": cfg.get("owner", ""),
            "repo": cfg.get("repo", ""),
            "branch": cfg.get("branch", "master"),
            "authed": self._authed(),
        })

    def api_setup(self):
        body = self._read_body()
        token = (body.get("github_token") or "").strip()
        owner = (body.get("owner") or "").strip()
        repo = (body.get("repo") or "").strip()
        branch = (body.get("branch") or "master").strip()
        password = body.get("admin_password") or ""
        if not token or not owner or not repo:
            self._send(400, {"error": "github_token / owner / repo 不能为空"})
        if len(password) < 6:
            self._send(400, {"error": "管理员密码至少 6 位"})
        cfg = load_config()
        cfg["github_token"] = token
        cfg["owner"] = owner
        cfg["repo"] = repo
        cfg["branch"] = branch or "master"
        cfg["admin_password_hash"] = hash_password(password)
        cfg["session_token"] = secrets.token_hex(32)
        save_config(cfg)
        self._send(200, {"token": cfg["session_token"], "authed": True})

    def api_login(self):
        if not self._authed_force_check_password():
            return
        cfg = load_config()
        cfg["session_token"] = secrets.token_hex(32)
        save_config(cfg)
        self._send(200, {"token": cfg["session_token"], "authed": True})

    def _authed_force_check_password(self):
        """login 时校验密码（而非会话令牌）。"""
        cfg = load_config()
        body = self._read_body()
        pwd = body.get("password") or ""
        if not verify_password(pwd, cfg.get("admin_password_hash", "")):
            self._send(401, {"error": "密码错误"})
            return False
        return True

    def api_logout(self):
        if not self._authed():
            self._send(401, {"error": "未登录"})
            return
        cfg = load_config()
        cfg["session_token"] = secrets.token_hex(32)
        save_config(cfg)
        self._send(200, {"ok": True})

    def api_update_config(self):
        if not self._authed():
            self._send(401, {"error": "未登录"})
            return
        cfg = load_config()
        body = self._read_body()
        if "github_token" in body and body["github_token"]:
            cfg["github_token"] = body["github_token"].strip()
        if "owner" in body and body["owner"]:
            cfg["owner"] = body["owner"].strip()
        if "repo" in body and body["repo"]:
            cfg["repo"] = body["repo"].strip()
        if "branch" in body and body["branch"]:
            cfg["branch"] = body["branch"].strip()
        if body.get("admin_password"):
            cfg["admin_password_hash"] = hash_password(body["admin_password"])
        save_config(cfg)
        self._send(200, {"ok": True})

    def _require_cfg(self):
        cfg = load_config()
        if not cfg.get("github_token"):
            self._send(400, {"error": "尚未配置 GitHub 令牌"})
            return None
        if not self._authed():
            self._send(401, {"error": "未登录"})
            return None
        return cfg

    def api_list(self):
        cfg = self._require_cfg()
        if cfg is None:
            return
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        ctype = (q.get("type", [""])[0]).strip()
        sub = (q.get("path", [""])[0]).strip()
        if ctype not in ("dynamic", "posts", "spec"):
            self._send(400, {"error": "type 必须是 dynamic/posts/spec"})
            return
        path = CONTENT_ROOT + "/" + ctype
        if sub:
            path = path + "/" + sub
        code, resp = gh_get_contents(cfg, path, cfg["branch"])
        if code != 200:
            self._send(code, resp if isinstance(resp, dict) else {"message": str(resp)})
            return
        # 目录：数组；文件：对象
        items = resp if isinstance(resp, list) else [resp]
        files = []
        for it in items:
            files.append({
                "name": it.get("name"),
                "path": it.get("path"),
                "type": it.get("type"),
                "size": it.get("size"),
                "sha": it.get("sha"),
            })
        self._send(200, {"type": ctype, "path": path, "items": files})

    def api_get_file(self):
        cfg = self._require_cfg()
        if cfg is None:
            return
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        path = (q.get("path", [""])[0]).strip()
        if not path:
            self._send(400, {"error": "缺少 path"})
            return
        code, resp = gh_get_contents(cfg, path, cfg["branch"])
        if code != 200:
            self._send(code, resp if isinstance(resp, dict) else {"message": str(resp)})
            return
        content_b64 = resp.get("content", "")
        try:
            content = base64.b64decode(content_b64).decode("utf-8", "replace")
        except Exception:
            content = ""
        self._send(200, {
            "path": resp.get("path"),
            "name": resp.get("name"),
            "sha": resp.get("sha"),
            "size": resp.get("size"),
            "content": content,
        })

    def api_save_file(self):
        cfg = self._require_cfg()
        if cfg is None:
            return
        body = self._read_body()
        path = (body.get("path") or "").strip()
        content = body.get("content", "")
        sha = body.get("sha") or None
        message = body.get("message") or f"Update {os.path.basename(path)} via FireflyCMS"
        if not path:
            self._send(400, {"error": "缺少 path"})
            return
        content_b64 = base64.b64encode(content.encode("utf-8")).decode("ascii")
        code, resp = gh_put_contents(cfg, path, content_b64, message, cfg["branch"], sha)
        if code not in (200, 201):
            self._send(code, resp if isinstance(resp, dict) else {"message": str(resp)})
            return
        new_sha = (resp.get("content") or {}).get("sha") if isinstance(resp, dict) else None
        self._send(200, {"ok": True, "sha": new_sha, "path": path})

    def api_delete_file(self):
        cfg = self._require_cfg()
        if cfg is None:
            return
        body = self._read_body()
        path = (body.get("path") or "").strip()
        sha = body.get("sha") or None
        message = body.get("message") or f"Delete {os.path.basename(path)} via FireflyCMS"
        if not path or not sha:
            self._send(400, {"error": "缺少 path 或 sha"})
            return
        code, resp = gh_delete_contents(cfg, path, sha, message, cfg["branch"])
        if code not in (200, 204):
            self._send(code, resp if isinstance(resp, dict) else {"message": str(resp)})
            return
        self._send(200, {"ok": True, "path": path})

    def api_upload(self):
        """上传二进制资源（图片等），content 已是 base64 字符串。"""
        cfg = self._require_cfg()
        if cfg is None:
            return
        body = self._read_body()
        path = (body.get("path") or "").strip()
        content_b64 = body.get("content") or ""
        message = body.get("message") or f"Upload {os.path.basename(path)} via FireflyCMS"
        sha = body.get("sha") or None
        if not path or not content_b64:
            self._send(400, {"error": "缺少 path 或 content"})
            return
        code, resp = gh_put_contents(cfg, path, content_b64, message, cfg["branch"], sha)
        if code not in (200, 201):
            self._send(code, resp if isinstance(resp, dict) else {"message": str(resp)})
            return
        new_sha = (resp.get("content") or {}).get("sha") if isinstance(resp, dict) else None
        self._send(200, {"ok": True, "sha": new_sha, "path": path})


def main():
    ensure_data()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Firefly CMS 已启动: http://localhost:{PORT}")
    print(f"配置文件: {CONFIG_PATH}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == "__main__":
    main()
