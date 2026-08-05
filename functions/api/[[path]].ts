/// <reference types="@cloudflare/workers-types" />

/**
 * Firefly-Admin —— Cloudflare Pages Functions 后端
 *
 * 设计要点：
 * - GitHub 访问令牌（GITHUB_TOKEN）只存在于 Pages 环境变量中，绝不下发到浏览器。
 * - 浏览器只持有一个 HttpOnly 会话 Cookie（由本函数用 HMAC 签名，7 天有效）。
 * - 本函数代理 GitHub Contents API：列目录 / 读文件 / 写文件（创建或更新）/ 删文件。
 * - 部署方式：Cloudflare Pages + Git 集成，无需构建；静态资源在 public/，函数在 functions/。
 */

interface Env {
  GITHUB_TOKEN: string;
  ADMIN_PASSWORD: string;
  GH_OWNER: string;
  GH_REPO: string;
  GH_BRANCH: string;
}

const COOKIE = "fa_sid";

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function encodePath(p: string): string {
  return p
    .split("/")
    .map((s) => encodeURIComponent(s))
    .join("/");
}

function base64Encode(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}

function base64Decode(b64: string): string {
  const bin = atob(b64.replace(/\s/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function hmac(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function makeSession(password: string): Promise<string> {
  const exp = Date.now() + 1000 * 60 * 60 * 24 * 7; // 7 天
  const sig = await hmac(password, String(exp));
  return exp + "." + sig;
}

async function isAuthed(request: Request, env: Env): Promise<boolean> {
  const cookie = request.headers.get("Cookie") || "";
  const m = cookie.match(new RegExp(COOKIE + "=([^;]+)"));
  if (!m) return false;
  const token = decodeURIComponent(m[1]);
  const [exp, sig] = token.split(".");
  if (!exp || !sig) return false;
  if (Date.now() > Number(exp)) return false;
  const expected = await hmac(env.ADMIN_PASSWORD, exp);
  return sig === expected;
}

function sessionCookie(token: string, expire: boolean): string {
  return (
    COOKIE +
    "=" +
    (expire ? "" : encodeURIComponent(token)) +
    "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" +
    (expire ? 0 : 60 * 60 * 24 * 7)
  );
}

async function ghApi(
  method: string,
  path: string,
  env: Env,
  body?: unknown
): Promise<{ status: number; data: any }> {
  const url =
    "https://api.github.com/repos/" +
    env.GH_OWNER +
    "/" +
    env.GH_REPO +
    "/contents/" +
    encodePath(path) +
    "?ref=" +
    encodeURIComponent(env.GH_BRANCH);
  const headers: Record<string, string> = {
    Authorization: "Bearer " + env.GITHUB_TOKEN,
    Accept: "application/vnd.github+json",
    "User-Agent": "Firefly-Admin",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const txt = await res.text();
  let data: any = {};
  try {
    data = JSON.parse(txt);
  } catch {
    data = { message: txt };
  }
  return { status: res.status, data };
}

export async function onRequest(
  context: { request: Request; env: Env }
): Promise<Response> {
  const { request, env } = context;
  const url = new URL(request.url);
  const seg = url.pathname.replace(/^\/api\/?/, "").replace(/\/$/, "");
  const method = request.method;

  // ---- 公开：状态 ----
  if (seg === "status" && method === "GET") {
    const adminConfigured = !!(env.ADMIN_PASSWORD && env.ADMIN_PASSWORD.length);
    return json({
      ok: true,
      configured: true,
      adminConfigured,
      owner: env.GH_OWNER,
      repo: env.GH_REPO,
      branch: env.GH_BRANCH,
      authed: await isAuthed(request, env),
    });
  }

  // ---- 登录 ----
  if (seg === "login" && method === "POST") {
    if (!env.ADMIN_PASSWORD) {
      return json(
        {
          error:
            "服务器未检测到 ADMIN_PASSWORD 环境变量。请到 Cloudflare Pages 控制台 → Settings → Environment variables 添加 ADMIN_PASSWORD（注意大小写），保存后务必重新部署（Redeploy）再试。",
        },
        500
      );
    }
    let pwd = "";
    try {
      pwd = (await request.json()).password || "";
    } catch {
      /* ignore */
    }
    if (!pwd || pwd !== env.ADMIN_PASSWORD) {
      return json({ error: "密码错误" }, 401);
    }
    const token = await makeSession(env.ADMIN_PASSWORD);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Set-Cookie": sessionCookie(token, false),
      },
    });
  }

  // ---- 登出 ----
  if (seg === "logout" && method === "POST") {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Set-Cookie": sessionCookie("", true),
      },
    });
  }

  // ---- 初始化（Cloudflare 版不需要，配置来自环境变量）----
  if (seg === "setup") {
    return json({ error: "Cloudflare 版本无需初始化，令牌已在环境变量中配置" }, 400);
  }

  // ---- 以下所有操作都需要登录 ----
  if (!(await isAuthed(request, env))) {
    return json({ error: "未授权，请先登录" }, 401);
  }

  // ---- 列目录 ----
  if (seg === "list" && method === "GET") {
    const type = url.searchParams.get("type") || "posts";
    const sub = url.searchParams.get("path") || "";
    if (!["dynamic", "posts", "spec"].includes(type)) {
      return json({ error: "type 必须是 dynamic/posts/spec" }, 400);
    }
    let p = "src/content/" + type;
    if (sub) p += "/" + sub;
    const { status, data } = await ghApi("GET", p, env);
    if (status !== 200) {
      return json({ error: data && data.message ? data.message : "列举失败" }, status);
    }
    const items = Array.isArray(data) ? data : [];
    return json({
      type,
      path: p,
      items: items.map((it: any) => ({
        name: it.name,
        path: it.path,
        type: it.type,
        size: it.size,
        sha: it.sha,
      })),
    });
  }

  // ---- 文件：读 / 写 / 删 ----
  if (seg === "file") {
    // GET 时 path 在 query；写 / 删时 path 在 body（与前端保持一致）
    let p = url.searchParams.get("path") || "";
    let body: any = {};

    if (method === "GET") {
      if (!p) return json({ error: "缺少 path" }, 400);
      const { status, data } = await ghApi("GET", p, env);
      if (status !== 200 || !data.content) {
        return json({ error: (data && data.message) || "读取失败" }, status);
      }
      return json({
        path: data.path,
        name: data.name,
        sha: data.sha,
        size: data.size,
        content: base64Decode(data.content),
      });
    }

    // 写 / 删：解析 body 并取 path
    try { body = await request.json(); } catch { body = {}; }
    if (!p) p = body.path || "";
    if (!p) return json({ error: "缺少 path" }, 400);

    if (method === "POST" || method === "PUT") {
      const payload: any = {
        message: body.message || "Update " + p + " via Firefly-Admin",
        content: base64Encode(body.content || ""),
      };
      if (body.sha) payload.sha = body.sha;
      const { status, data } = await ghApi("PUT", p, env, payload);
      const newSha = data && data.content ? data.content.sha : undefined;
      return json({ ok: status < 300, sha: newSha, path: p }, status);
    }

    if (method === "DELETE") {
      if (!body.sha) return json({ error: "缺少 sha" }, 400);
      const payload = {
        message: body.message || "Delete " + p + " via Firefly-Admin",
        sha: body.sha,
      };
      const { status } = await ghApi("DELETE", p, env, payload);
      return new Response(null, { status: status < 300 ? 200 : status });
    }
  }

  // ---- 上传文件（图片 / 资源）到仓库 public/uploads ----
  if (seg === "upload" && method === "POST") {
    let body: any = {};
    try { body = await request.json(); } catch { return json({ error: "请求体错误" }, 400); }
    const contentB64 = (body.content || "").split(",").pop() || ""; // 容忍 data URI 前缀
    const name = (body.name || "file").replace(/[^\w.\-\u4e00-\u9fa5]+/g, "_");
    if (!contentB64) return json({ error: "缺少文件内容" }, 400);
    const dir = body.dir || "public/uploads";
    const p = dir + "/" + name;
    const payload = {
      message: body.message || "Upload " + p + " via Firefly-Admin",
      content: contentB64,
    };
    const { status, data } = await ghApi("PUT", p, env, payload);
    if (status >= 300) return json({ error: (data && data.message) || "上传失败" }, status);
    const raw = `https://raw.githubusercontent.com/${env.GH_OWNER}/${env.GH_REPO}/${env.GH_BRANCH}/${p}`;
    const web = "/" + p.split("/").slice(1).join("/"); // public/uploads/x -> /uploads/x
    return json({ ok: true, path: p, url: raw, web, sha: data && data.content ? data.content.sha : undefined });
  }

  return json({ error: "Not Found" }, 404);
}
