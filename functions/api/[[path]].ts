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

// ---- 递归工具：GitHub 无目录对象，目录=路径前缀，重命名/删除需递归处理文件 ----
async function readFileContent(path: string, env: Env): Promise<{ content: string; sha: string } | null> {
  const { status, data } = await ghApi("GET", path, env);
  if (status !== 200 || !data.content) return null;
  return { content: base64Decode(data.content), sha: data.sha };
}

async function writeFileContent(path: string, content: string, message: string, env: Env, sha?: string) {
  const payload: any = { message, content: base64Encode(content), branch: env.GH_BRANCH };
  if (sha) payload.sha = sha;
  return ghApi("PUT", path, env, payload);
}

async function deleteFileContent(path: string, sha: string, message: string, env: Env) {
  return ghApi("DELETE", path, env, { message, sha, branch: env.GH_BRANCH });
}

async function listDirContents(path: string, env: Env): Promise<any[]> {
  const { status, data } = await ghApi("GET", path, env);
  if (status !== 200 || !Array.isArray(data)) return [];
  return data;
}

async function movePath(oldP: string, newP: string, isDir: boolean, env: Env): Promise<{ ok: boolean; error?: string }> {
  if (!isDir) {
    const r = await readFileContent(oldP, env);
    if (!r) return { ok: false, error: "读取原文件失败：" + oldP };
    const w = await writeFileContent(newP, r.content, "Rename " + oldP + " -> " + newP, env);
    if (w.status >= 300) return { ok: false, error: "写入新文件失败：" + ((w.data && w.data.message) || "") };
    const d = await deleteFileContent(oldP, r.sha, "Rename (remove old) " + oldP, env);
    if (d.status >= 300) return { ok: false, error: "删除原文件失败：" + oldP };
    return { ok: true };
  }
  const items = await listDirContents(oldP, env);
  for (const it of items) {
    const res = await movePath(oldP + "/" + it.name, newP + "/" + it.name, it.type === "dir", env);
    if (!res.ok) return res;
  }
  return { ok: true };
}

async function removePathRecursive(p: string, isDir: boolean, env: Env): Promise<{ ok: boolean; error?: string }> {
  if (!isDir) {
    const r = await readFileContent(p, env);
    const sha = r ? r.sha : "";
    const d = await deleteFileContent(p, sha, "Delete " + p, env);
    if (d.status >= 300) return { ok: false, error: "删除失败：" + p };
    return { ok: true };
  }
  const items = await listDirContents(p, env);
  for (const it of items) {
    const res = await removePathRecursive(p + "/" + it.name, it.type === "dir", env);
    if (!res.ok) return res;
  }
  return { ok: true };
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
    // config 映射到 src/config（站点配置文件，如 FooterConfig.html），其余映射到 src/content/*
    let basePath: string;
    if (type === "config") {
      basePath = "src/config";
    } else if (["dynamic", "posts", "spec"].includes(type)) {
      basePath = "src/content/" + type;
    } else {
      return json({ error: "type 必须是 dynamic/posts/spec/config" }, 400);
    }
    let p = basePath;
    if (sub) p += "/" + sub;
    const { status, data } = await ghApi("GET", p, env);
    if (status !== 200) {
      return json({ error: data && data.message ? data.message : "列举失败" }, status);
    }
    const items = Array.isArray(data) ? data : [];
    // type=posts 时补充「创建/修改时间」：需逐文件走 Commits API（Contents API 不返回时间）。
    // 失败视为无日期（不阻塞列表）。并发请求，控制在一批内完成。
    const enriched = await Promise.all(
      items.map(async (it: any) => {
        const base = { name: it.name, path: it.path, type: it.type, size: it.size, sha: it.sha };
        if (type === "posts" && it.type === "file") {
          try {
            const dates = await getFileDates(it.path, env);
            return { ...base, ...dates };
          } catch {
            return base;
          }
        }
        return base;
      })
    );
    return json({
      type,
      path: p,
      items: enriched,
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
        branch: env.GH_BRANCH,
      };
      if (body.sha) payload.sha = body.sha;
      const { status, data } = await ghApi("PUT", p, env, payload);
      if (status >= 300) {
        const msg = (data && data.message) || "GitHub 写入失败";
        // GitHub 的 401 表示令牌失效/无权限，不能透传为 HTTP 401，否则前端会误判为登录失效并踢回登录页
        const httpStatus = status === 401 ? 502 : status;
        return json({ ok: false, error: "保存失败：" + msg, githubStatus: status, path: p }, httpStatus);
      }
      const newSha = data && data.content ? data.content.sha : undefined;
      return json({ ok: true, sha: newSha, path: p });
    }

    if (method === "DELETE") {
      if (!body.sha) return json({ error: "缺少 sha（无法删除尚未保存的新文件）" }, 400);
      const payload = {
        message: body.message || "Delete " + p + " via Firefly-Admin",
        sha: body.sha,
        branch: env.GH_BRANCH,
      };
      const { status, data } = await ghApi("DELETE", p, env, payload);
      if (status >= 300) {
        const msg = (data && data.message) || "GitHub 删除失败";
        const httpStatus = status === 401 ? 502 : status;
        return json({ ok: false, error: "删除失败：" + msg, githubStatus: status, path: p }, httpStatus);
      }
      return new Response(null, { status: 200 });
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
      branch: env.GH_BRANCH,
    };
    const { status, data } = await ghApi("PUT", p, env, payload);
    if (status >= 300) return json({ error: (data && data.message) || "上传失败" }, status);
    const raw = `https://raw.githubusercontent.com/${env.GH_OWNER}/${env.GH_REPO}/${env.GH_BRANCH}/${p}`;
    const web = "/" + p.split("/").slice(1).join("/"); // public/uploads/x -> /uploads/x
    return json({ ok: true, path: p, url: raw, web, sha: data && data.content ? data.content.sha : undefined });
  }

  // ---- 新建目录（分类）：GitHub 无空目录对象，写入 .gitkeep 占位文件创建目录 ----
  if (seg === "mkdir" && method === "POST") {
    let body: any = {};
    try { body = await request.json(); } catch { return json({ error: "请求体错误" }, 400); }
    let p = (body.path || "").trim();
    if (!p) return json({ error: "缺少 path" }, 400);
    // 防路径穿越：禁止绝对路径与 .. 片段
    if (p.startsWith("/") || p.includes("..") || p.includes("\\")) {
      return json({ error: "非法的目录路径" }, 400);
    }
    const keepPath = p.replace(/\/+$/, "") + "/.gitkeep";
    const payload = {
      message: body.message || "Create folder " + p + " via Firefly-Admin",
      content: base64Encode("# Firefly-Admin 目录占位文件（保留目录结构，可安全删除）\n"),
      branch: env.GH_BRANCH,
    };
    const { status, data } = await ghApi("PUT", keepPath, env, payload);
    if (status >= 300) {
      const msg = (data && data.message) || "创建目录失败";
      const httpStatus = status === 401 ? 502 : status;
      return json({ ok: false, error: "创建目录失败：" + msg, githubStatus: status }, httpStatus);
    }
    return json({ ok: true, path: p, keep: keepPath });
  }

  // ---- 重命名 / 移动（文件或目录，目录递归）----
  if (seg === "rename" && method === "POST") {
    let body: any = {};
    try { body = await request.json(); } catch { return json({ error: "请求体错误" }, 400); }
    const oldP = (body.oldPath || "").trim();
    const newP = (body.newPath || "").trim();
    const isDir = !!body.isDir;
    if (!oldP || !newP) return json({ error: "缺少 oldPath 或 newPath" }, 400);
    if (oldP === newP) return json({ error: "新旧路径相同" }, 400);
    const res = await movePath(oldP, newP, isDir, env);
    if (!res.ok) return json({ ok: false, error: "重命名失败：" + (res.error || "") }, 500);
    return json({ ok: true, oldPath: oldP, newPath: newP });
  }

  // ---- 删除（文件或目录，目录递归）----
  if (seg === "remove" && method === "POST") {
    let body: any = {};
    try { body = await request.json(); } catch { return json({ error: "请求体错误" }, 400); }
    const p = (body.path || "").trim();
    const isDir = !!body.isDir;
    if (!p) return json({ error: "缺少 path" }, 400);
    const res = await removePathRecursive(p, isDir, env);
    if (!res.ok) return json({ ok: false, error: "删除失败：" + (res.error || "") }, 500);
    return json({ ok: true, path: p });
  }

  return json({ error: "Not Found" }, 404);
}

// 取文件的「创建时间」与「最后修改时间」：
// GitHub Contents API 不返回时间，需走 Commits API（按 path 过滤，最新在前）。
// - updated = 首页第一条（最新提交）
// - created = 末页第一条（最早提交），通过 Link: rel="last" 定位末页（per_page=1）
// 任一失败均视为无日期（不阻塞列表）。仅对 type=posts 且非子目录调用。
async function getFileDates(path: string, env: Env): Promise<{ created?: string; updated?: string }> {
  try {
    const headers: Record<string, string> = {
      Authorization: "Bearer " + env.GITHUB_TOKEN,
      Accept: "application/vnd.github+json",
      "User-Agent": "Firefly-Admin",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    const q =
      "?path=" + encodeURIComponent(path) + "&per_page=1&sha=" + encodeURIComponent(env.GH_BRANCH);
    const firstRes = await fetch(
      "https://api.github.com/repos/" + env.GH_OWNER + "/" + env.GH_REPO + "/commits" + q,
      { headers }
    );
    if (!firstRes.ok) return {};
    const firstJson = (await firstRes.json()) as any[];
    if (!Array.isArray(firstJson) || !firstJson.length) return {};
    const pick = (c: any) => c?.commit?.committer?.date || c?.commit?.author?.date || null;
    const updated = pick(firstJson[0]);
    let created = updated;
    const link = firstRes.headers.get("Link");
    const lastMatch = link && link.match(/<([^>]+)>;\s*rel="last"/);
    if (lastMatch && lastMatch[1]) {
      const lastRes = await fetch(lastMatch[1], { headers });
      if (lastRes.ok) {
        const lastJson = (await lastRes.json()) as any[];
        if (Array.isArray(lastJson) && lastJson.length) {
          const c = pick(lastJson[lastJson.length - 1]);
          if (c) created = c;
        }
      }
    }
    return { created: created || undefined, updated: updated || undefined };
  } catch {
    return {};
  }
}
