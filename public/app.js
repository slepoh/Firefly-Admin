/* Firefly CMS 前端逻辑 */
(() => {
  "use strict";

  const CONTENT_ROOT = "src/content";
  const $ = (id) => document.getElementById(id);

  const state = {
    token: localStorage.getItem("ff_token") || "",
    status: null,
    type: "posts",
    subdir: "",
    files: [],
    current: null, // {path, sha, name, isNew, type}
    mode: "split", // split | raw
    postData: {},
  };

  // 文章结构化字段定义
  const POST_FIELDS = [
    { key: "title", label: "标题 title", type: "text", required: true, full: true },
    { key: "published", label: "发布日期 published", type: "datetime", required: true },
    { key: "updated", label: "更新日期 updated", type: "datetime" },
    { key: "description", label: "描述 description", type: "textarea", full: true },
    { key: "image", label: "封面图 image", type: "text", full: true },
    { key: "tags", label: "标签 tags (逗号分隔)", type: "text" },
    { key: "category", label: "分类 category", type: "text" },
    { key: "slug", label: "自定义路径 slug", type: "text" },
    { key: "lang", label: "语言 lang", type: "text" },
    { key: "author", label: "作者 author", type: "text" },
    { key: "draft", label: "草稿 draft", type: "checkbox" },
    { key: "pinned", label: "置顶 pinned", type: "checkbox" },
    { key: "comment", label: "允许评论 comment", type: "checkbox" },
    { key: "licenseName", label: "许可证名称 licenseName", type: "text", full: true },
    { key: "licenseUrl", label: "许可证链接 licenseUrl", type: "text", full: true },
    { key: "sourceLink", label: "来源链接 sourceLink", type: "text", full: true },
    { key: "password", label: "访问密码 password", type: "text" },
    { key: "passwordHint", label: "密码提示 passwordHint", type: "text", full: true },
  ];

  // ----------------------------------------------------------------------
  // API
  // ----------------------------------------------------------------------
  async function api(path, opts = {}) {
    const headers = { "Content-Type": "application/json" };
    if (state.token) headers["Authorization"] = "Bearer " + state.token;
    const res = await fetch(path, { ...opts, headers });
    let data = {};
    try { data = await res.json(); } catch (e) { /* ignore */ }
    if (res.status === 401) {
      localStorage.removeItem("ff_token");
      state.token = "";
      showLogin();
      throw new Error("未登录或会话失效");
    }
    return { status: res.status, data };
  }

  // ----------------------------------------------------------------------
  // Frontmatter (轻量 YAML)
  // ----------------------------------------------------------------------
  function parseYamlScalar(v) {
    v = v.trim();
    if (v === "") return "";
    if (v.startsWith("[") && v.endsWith("]")) {
      const inner = v.slice(1, -1).trim();
      if (inner === "") return [];
      return inner.split(",").map((s) => parseYamlScalar(s.trim()));
    }
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      return v.slice(1, -1);
    }
    if (v === "true") return true;
    if (v === "false") return false;
    if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
    return v;
  }

  function parseFrontmatter(text) {
    const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
    if (!m) return { data: {}, body: text };
    const fm = m[1];
    const body = m[2];
    const data = {};
    fm.split("\n").forEach((line) => {
      if (!line.trim() || line.trim().startsWith("#")) return;
      const idx = line.indexOf(":");
      if (idx === -1) return;
      const key = line.slice(0, idx).trim();
      const val = line.slice(idx + 1).trim();
      data[key] = parseYamlScalar(val);
    });
    return { data, body };
  }

  function yamlScalar(v) {
    if (Array.isArray(v)) {
      if (v.length === 0) return "[]";
      return "[" + v.map(yamlScalar).join(", ") + "]";
    }
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "number") return String(v);
    const s = String(v);
    if (s === "") return '""';
    // 日期 / 时间：保持不引号，符合 Firefly 约定（含毫秒与 Z / 时区偏移）
    if (/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(s)) return s;
    // 含特殊字符则加双引号
    if (/[:#\[\]{},&*?|<>=!%@`"' ]/.test(s) || /^ | $/.test(s) ||
        ["true", "false", "null", "yes", "no", "~"].includes(s)) {
      return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
    }
    return s;
  }

  function serializeFrontmatter(data, body) {
    let out = "---\n";
    for (const [k, v] of Object.entries(data)) {
      if (v === "" || v === undefined || v === null) continue;
      if (Array.isArray(v) && v.length === 0) continue;
      out += k + ": " + yamlScalar(v) + "\n";
    }
    out += "---\n";
    if (body && !body.endsWith("\n")) body += "\n";
    out += body;
    return out;
  }

  function stripFrontmatterForPreview(text) {
    const m = text.match(/^---\s*\n[\s\S]*?\n---\s*\n?([\s\S]*)$/);
    return m ? m[1] : text;
  }

  // ----------------------------------------------------------------------
  // 日期转换
  // ----------------------------------------------------------------------
  function dateToInput(s) {
    if (!s) return "";
    s = s.trim();
    const t = s.replace(" ", "T");
    const m = t.match(/^(\d{4}-\d{2}-\d{2})(T(\d{2}:\d{2}))?/);
    if (!m) return "";
    return m[3] ? m[1] + "T" + m[3] : m[1] + "T00:00";
  }
  function inputToDateStr(v, dynamic) {
    if (!v) return "";
    const m = v.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
    if (!m) return v;
    const d = m[1], tm = m[2];
    if (dynamic) return `${d} ${tm}:00`;
    return tm === "00:00" ? d : `${d}T${tm}:00`;
  }

  // ----------------------------------------------------------------------
  // UI 辅助
  // ----------------------------------------------------------------------
  let toastTimer = null;
  function toast(msg, type) {
    const el = $("toast");
    el.textContent = msg;
    el.hidden = false;
    el.style.background = type === "err" ? "#e5484d" : "#1f2329";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 2600);
  }

  function showLogin() {
    $("loginModal").hidden = false;
    $("setupModal").hidden = true;
  }
  function hideModals() {
    $("loginModal").hidden = true;
    $("setupModal").hidden = true;
  }

  // ----------------------------------------------------------------------
  // 状态 / 初始化
  // ----------------------------------------------------------------------
  async function init() {
    try {
      const { data } = await api("/api/status");
      state.status = data;
      if (!data.configured) {
        $("setupModal").hidden = false;
        return;
      }
      // 登录态由服务端通过 Cookie 判定（Cloudflare Pages 版本），
      // 也兼容 Python 版本（服务端校验 Bearer 令牌）。
      if (!data.authed) {
        showLogin();
        return;
      }
      enterApp();
    } catch (e) {
      toast(e.message || "初始化失败", "err");
    }
  }

  async function enterApp() {
    hideModals();
    $("mainApp").hidden = false;
    $("logoutBtn").hidden = false;
    const s = state.status;
    $("repoInfo").textContent = `${s.owner}/${s.repo}@${s.branch}`;
    bindEvents();
    await loadList();
  }

  // ----------------------------------------------------------------------
  // 列表
  // ----------------------------------------------------------------------
  async function loadList() {
    try {
      const q = `type=${state.type}` + (state.subdir ? `&path=${encodeURIComponent(state.subdir)}` : "");
      const { data } = await api("/api/list?" + q);
      state.files = data.items || [];
      renderList();
      renderCrumb();
    } catch (e) {
      toast(e.message || "加载列表失败", "err");
    }
  }

  function renderList() {
    const box = $("fileList");
    box.innerHTML = "";
    const kw = ($("searchInput").value || "").toLowerCase();
    state.files
      .filter((f) => f.name.toLowerCase().includes(kw))
      .forEach((f) => {
        const div = document.createElement("div");
        div.className = "file-item";
        const isDir = f.type === "dir";
        let icon = "📄";
        if (isDir) icon = "📁";
        else if (f.name.endsWith(".mdx")) icon = "📘";
        else if (/\.(png|jpe?g|gif|webp|avif|svg)$/i.test(f.name)) icon = "🖼️";
        div.innerHTML = `<span class="fi-icon">${icon}</span><span class="fi-name">${esc(f.name)}</span>` +
          (isDir ? "" : `<span class="fi-size">${fmtSize(f.size)}</span>`);
        div.onclick = () => (isDir ? navigate(f) : openFile(f));
        box.appendChild(div);
      });
  }

  function navigate(dirItem) {
    // dirItem.path 是完整路径，取 type 之后的部分作为 subdir
    const prefix = CONTENT_ROOT + "/" + state.type + "/";
    state.subdir = dirItem.path.startsWith(prefix) ? dirItem.path.slice(prefix.length) : dirItem.name;
    loadList();
  }

  function renderCrumb() {
    const c = $("crumb");
    let html = `${CONTENT_ROOT}/${state.type}`;
    if (state.subdir) html += " / " + state.subdir;
    c.textContent = html;
  }

  function fmtSize(n) {
    if (!n && n !== 0) return "";
    if (n < 1024) return n + "B";
    return (n / 1024).toFixed(1) + "KB";
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  // ----------------------------------------------------------------------
  // 打开 / 新建
  // ----------------------------------------------------------------------
  async function openFile(f) {
    try {
      const { data } = await api("/api/file?path=" + encodeURIComponent(f.path));
      let fm = {}, body;
      if (state.type === "spec") {
        // 单页：保留完整文件（可能含自己的 Frontmatter）
        body = data.content;
      } else {
        const parsed = parseFrontmatter(data.content);
        fm = parsed.data;
        body = parsed.body;
      }
      state.current = { path: f.path, sha: data.sha, name: f.name, isNew: false, type: state.type };
      showEditor(body, fm, f.name);
    } catch (e) {
      toast(e.message || "打开失败", "err");
    }
  }

  function newFile() {
    let name, body, fm = {};
    if (state.type === "dynamic") {
      name = tsFilename();
      fm = { published: inputToDateStr(nowLocalInput(), true), location: "" };
      body = "";
    } else if (state.type === "posts") {
      name = "untitled.md";
      fm = { title: "新文章", published: inputToDateStr(nowLocalInput(), false), draft: true };
      body = "# 新文章\n\n在这里写正文…\n";
    } else {
      name = "page.md";
      fm = {};
      body = "# 新页面\n\n在这里写内容…\n";
    }
    state.current = { path: null, sha: null, name, isNew: true, type: state.type };
    showEditor(body, fm, name);
  }

  function nowLocalInput() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function tsFilename() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.md`;
  }

  // ----------------------------------------------------------------------
  // 编辑器渲染
  // ----------------------------------------------------------------------
  function showEditor(body, fm, name) {
    $("emptyState").hidden = true;
    $("editForm").hidden = false;
    $("deleteBtn").hidden = state.current.isNew;
    $("fileName").value = name;
    $("fileName").readOnly = !state.current.isNew ? true : false;

    state.postData = fm;
    state.mode = "split";

    const isPosts = state.type === "posts";
    const isDynamic = state.type === "dynamic";
    $("postFields").hidden = !isPosts;
    $("dynamicFields").hidden = !isDynamic;

    if (isPosts) renderPostFields(fm);
    if (isDynamic) {
      $("dynPublished").value = dateToInput(fm.published || "");
      $("dynLocation").value = fm.location || "";
    }

    $("bodyEditor").value = body;
    $("rawEditor").hidden = true;
    $("splitView").hidden = false;
    setModeButtons("split");
    renderPreview();
    setStatus("");
  }

  function renderPostFields(fm) {
    const box = $("postFields");
    box.innerHTML = "";
    POST_FIELDS.forEach((f) => {
      const wrap = document.createElement("div");
      wrap.className = "field" + (f.full ? " full" : "") + (f.type === "checkbox" ? " checkbox" : "");
      const label = document.createElement("label");
      label.textContent = f.label + (f.required ? " *" : "");
      let input;
      if (f.type === "textarea") {
        input = document.createElement("textarea");
        input.rows = 2;
        input.value = fm[f.key] || "";
      } else if (f.type === "datetime") {
        input = document.createElement("input");
        input.type = "datetime-local";
        input.value = dateToInput(fm[f.key] || "");
      } else if (f.type === "checkbox") {
        input = document.createElement("input");
        input.type = "checkbox";
        input.checked = !!fm[f.key];
        input.id = "pf_" + f.key;
      } else {
        input = document.createElement("input");
        input.type = "text";
        input.value = fm[f.key] != null ? fm[f.key] : "";
      }
      input.dataset.key = f.key;
      input.dataset.kind = f.type;
      if (f.type === "checkbox") {
        wrap.appendChild(input);
        wrap.appendChild(label);
      } else {
        wrap.appendChild(label);
        wrap.appendChild(input);
      }
      box.appendChild(wrap);
    });
  }

  function collectPostData() {
    const data = {};
    POST_FIELDS.forEach((f) => {
      const el = document.querySelector(`#postFields [data-key="${f.key}"]`);
      if (!el) return;
      let v;
      if (f.type === "checkbox") v = el.checked;
      else if (f.type === "datetime") v = inputToDateStr(el.value, false);
      else if (f.key === "tags") {
        v = el.value.split(",").map((s) => s.trim()).filter(Boolean);
      } else v = el.value;
      if (f.type === "checkbox") {
        if (v) data[f.key] = true; // 仅在勾选时写入，减少噪音
      } else if (v !== "" && !(Array.isArray(v) && v.length === 0)) {
        data[f.key] = v;
      }
    });
    return data;
  }

  // ----------------------------------------------------------------------
  // 模式切换
  // ----------------------------------------------------------------------
  function setModeButtons(mode) {
    $("modeSplit").classList.toggle("active", mode === "split");
    $("modeRaw").classList.toggle("active", mode === "raw");
  }

  function applyMode(mode) {
    if (mode === "raw") {
      $("rawEditor").value = buildContent();
      $("rawEditor").hidden = false;
      $("splitView").hidden = true;
    } else {
      // 从 raw 切回 split：重新解析
      if (state.mode === "raw") {
        const { data, body } = parseFrontmatter($("rawEditor").value);
        state.postData = data;
        if (state.type === "posts") renderPostFields(data);
        if (state.type === "dynamic") {
          $("dynPublished").value = dateToInput(data.published || "");
          $("dynLocation").value = data.location || "";
        }
        if (state.type === "spec") {
          // spec 整文件
        }
        $("bodyEditor").value = state.type === "spec" ? $("rawEditor").value : body;
      }
      $("rawEditor").hidden = true;
      $("splitView").hidden = false;
      renderPreview();
    }
    state.mode = mode;
    setModeButtons(mode);
  }

  // ----------------------------------------------------------------------
  // 构建文件内容
  // ----------------------------------------------------------------------
  function buildContent() {
    if (state.mode === "raw") return $("rawEditor").value;
    if (state.type === "posts") {
      return serializeFrontmatter(collectPostData(), $("bodyEditor").value);
    }
    if (state.type === "dynamic") {
      const data = {};
      const pub = inputToDateStr($("dynPublished").value, true);
      if (pub) data.published = pub;
      const loc = $("dynLocation").value.trim();
      if (loc) data.location = loc;
      return serializeFrontmatter(data, $("bodyEditor").value);
    }
    // spec
    return $("bodyEditor").value;
  }

  // ----------------------------------------------------------------------
  // 预览
  // ----------------------------------------------------------------------
  function renderPreview() {
    const text = state.type === "spec" ? $("bodyEditor").value : stripFrontmatterForPreview($("bodyEditor").value);
    if (window.marked) {
      marked.setOptions({ breaks: true, gfm: true });
      const html = marked.parse(text || "");
      $("preview").innerHTML = DOMPurify.sanitize(html);
    } else {
      $("preview").textContent = text;
    }
  }

  // ----------------------------------------------------------------------
  // 保存 / 删除
  // ----------------------------------------------------------------------
  async function saveFile() {
    const content = buildContent();
    let path;
    if (state.current.isNew) {
      const fname = ($("fileName").value || "").trim();
      if (!fname) { setStatus("请填写文件名", "err"); return; }
      if (!/\.(md|mdx)$/i.test(fname)) { setStatus("文件名需以 .md 或 .mdx 结尾", "err"); return; }
      path = CONTENT_ROOT + "/" + state.type + (state.subdir ? "/" + state.subdir : "") + "/" + fname;
    } else {
      path = state.current.path;
    }
    const payload = {
      path,
      content,
      sha: state.current.sha || undefined,
      message: (state.current.isNew ? "Create " : "Update ") + path + " via FireflyCMS",
    };
    setStatus("保存中…");
    try {
      const { status, data } = await api("/api/file", {
        method: state.current.isNew ? "POST" : "PUT",
        body: JSON.stringify(payload),
      });
      if (status === 200 || status === 201) {
        state.current.sha = data.sha || state.current.sha;
        state.current.isNew = false;
        state.current.path = path;
        state.current.name = ($("fileName").value || "").trim();
        $("deleteBtn").hidden = false;
        $("fileName").readOnly = true;
        setStatus("✅ 已保存，GitHub 将自动重新部署", "ok");
        toast("保存成功");
      } else {
        setStatus((data && data.message) || "保存失败", "err");
      }
    } catch (e) {
      setStatus(e.message || "保存失败", "err");
    }
  }

  async function deleteFile() {
    if (!state.current || state.current.isNew) { backToEmpty(); return; }
    if (!confirm("确定删除 " + state.current.name + " ？此操作会提交到 GitHub。")) return;
    try {
      const { status, data } = await api("/api/file", {
        method: "DELETE",
        body: JSON.stringify({
          path: state.current.path,
          sha: state.current.sha,
          message: "Delete " + state.current.path + " via FireflyCMS",
        }),
      });
      if (status === 200 || status === 204) {
        toast("已删除");
        backToEmpty();
        await loadList();
      } else {
        toast((data && data.message) || "删除失败", "err");
      }
    } catch (e) {
      toast(e.message || "删除失败", "err");
    }
  }

  function backToEmpty() {
    state.current = null;
    $("editForm").hidden = true;
    $("emptyState").hidden = false;
  }

  function setStatus(msg, type) {
    const el = $("editStatus");
    el.textContent = msg || "";
    el.className = "edit-status" + (type ? " " + type : "");
  }

  // ----------------------------------------------------------------------
  // 事件绑定
  // ----------------------------------------------------------------------
  let bound = false;
  function bindEvents() {
    if (bound) return;
    bound = true;

    $("typeTabs").querySelectorAll(".tab").forEach((t) => {
      t.onclick = () => {
        $("typeTabs").querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
        t.classList.add("active");
        state.type = t.dataset.type;
        state.subdir = "";
        backToEmpty();
        loadList();
      };
    });

    $("searchInput").oninput = renderList;
    $("refreshBtn").onclick = loadList;
    $("newBtn").onclick = newFile;
    $("saveBtn").onclick = saveFile;
    $("deleteBtn").onclick = deleteFile;
    $("backBtn").onclick = backToEmpty;
    $("logoutBtn").onclick = async () => {
      try { await api("/api/logout", { method: "POST" }); } catch (e) { /* ignore */ }
      localStorage.removeItem("ff_token");
      location.reload();
    };

    $("modeSplit").onclick = () => applyMode("split");
    $("modeRaw").onclick = () => applyMode("raw");

    $("bodyEditor").addEventListener("input", renderPreview);

    // setup
    $("setupBtn").onclick = async () => {
      const body = {
        github_token: $("setToken").value.trim(),
        owner: $("setOwner").value.trim(),
        repo: $("setRepo").value.trim(),
        branch: $("setBranch").value.trim() || "master",
        admin_password: $("setPassword").value,
      };
      $("setupErr").textContent = "";
      try {
        const { status, data } = await api("/api/setup", { method: "POST", body: JSON.stringify(body) });
        if (status === 200) {
          state.token = data.token;
          localStorage.setItem("ff_token", data.token);
          state.status = await (await api("/api/status")).data;
          enterApp();
        } else {
          $("setupErr").textContent = (data && data.error) || "配置失败";
        }
      } catch (e) {
        $("setupErr").textContent = e.message || "配置失败";
      }
    };

    // login
    $("loginBtn").onclick = async () => {
      $("loginErr").textContent = "";
      try {
        const { status, data } = await api("/api/login", {
          method: "POST",
          body: JSON.stringify({ password: $("loginPassword").value }),
        });
        if (status === 200) {
          state.token = data.token;
          localStorage.setItem("ff_token", data.token);
          state.status = await (await api("/api/status")).data;
          enterApp();
        } else {
          $("loginErr").textContent = (data && data.error) || "登录失败";
        }
      } catch (e) {
        $("loginErr").textContent = e.message || "登录失败";
      }
    };
  }

  init();
})();
