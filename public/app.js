/* Firefly CMS 前端逻辑（富文本版） */
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
    mode: "rich", // rich | raw
    postData: {},  // 解析出的 frontmatter（posts / spec 复用）
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
      // 未登录或会话失效：跳转独立登录页（后台整页受保护）
      location.replace("login.html?from=" + encodeURIComponent(location.pathname + location.search));
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
  // 富文本编辑器（ToastUI）：懒初始化 + 纯文本兜底
  // ----------------------------------------------------------------------
  let editor = null;        // ToastUI 实例
  let fallbackBody = null;  // 组件未加载时的纯文本兜底

  function ensureEditor() {
    if (editor || fallbackBody) return;
    const host = $("editor");
    if (window.toastui && toastui.Editor) {
      editor = new toastui.Editor({
        el: host,
        height: "100%",
        initialEditType: "wysiwyg",
        previewStyle: "vertical",
        usageStatistics: false,
        autofocus: false,
      });
    } else {
      // 兜底：组件未加载（如网络异常）时使用 textarea
      host.style.display = "none";
      fallbackBody = document.createElement("textarea");
      fallbackBody.className = "raw-editor";
      fallbackBody.style.flex = "1";
      $("editorHost").appendChild(fallbackBody);
      toast("富文本组件未加载，已切换为纯文本编辑", "err");
    }
  }

  function setBodyMarkdown(md) {
    ensureEditor();
    if (editor) editor.setMarkdown(md || "", false);
    else if (fallbackBody) fallbackBody.value = md || "";
  }
  function getBodyMarkdown() {
    if (editor) return editor.getMarkdown();
    if (fallbackBody) return fallbackBody.value;
    return "";
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

  function isMobile() { return window.matchMedia("(max-width: 900px)").matches; }
  function openDrawer() { $("sidebar").classList.add("open"); $("drawerBackdrop").classList.add("show"); }
  function closeDrawer() { $("sidebar").classList.remove("open"); $("drawerBackdrop").classList.remove("show"); }

  // ----------------------------------------------------------------------
  // 状态 / 初始化
  // ----------------------------------------------------------------------
  async function init() {
    try {
      bindEvents();
      const { data } = await api("/api/status");
      state.status = data;
      // 后台整页受保护：未登录直接跳转独立登录页
      if (!data.authed) {
        location.replace("login.html?from=" + encodeURIComponent(location.pathname + location.search));
        return;
      }
      if (!data.adminConfigured) {
        toast("提示：服务器未检测到 ADMIN_PASSWORD，请在 Cloudflare 环境变量中配置后重新部署。", "err");
      }
      enterApp();
    } catch (e) {
      toast(e.message || "初始化失败", "err");
    }
  }

  async function enterApp() {
    closeDrawer();
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
        div.onclick = () => {
          if (isDir) navigate(f);
          else openFile(f);
          if (isMobile()) closeDrawer();
        };
        box.appendChild(div);
      });
  }

  function navigate(dirItem) {
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
        const parsed = parseFrontmatter(data.content);
        fm = parsed.data;
        body = parsed.body;
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
    $("fileName").readOnly = !state.current.isNew;

    state.postData = fm || {};
    state.mode = "rich";

    const isPosts = state.type === "posts";
    const isDynamic = state.type === "dynamic";
    $("postPanel").hidden = !isPosts;
    $("dynamicPanel").hidden = !isDynamic;

    if (isPosts) renderPostFields(fm);
    if (isDynamic) {
      $("dynPublished").value = dateToInput(fm.published || "");
      $("dynLocation").value = fm.location || "";
    }

    // 先让容器可见，再创建/填充富文本编辑器，避免初次创建时高度为 0
    $("editorMain").hidden = false;
    $("editorHost").hidden = false;
    $("rawEditor").hidden = true;
    setBodyMarkdown(body);
    setModeButtons("rich");
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
        if (v) data[f.key] = true;
      } else if (v !== "" && !(Array.isArray(v) && v.length === 0)) {
        data[f.key] = v;
      }
    });
    return data;
  }

  // ----------------------------------------------------------------------
  // 模式切换（富文本 / 源代码）
  // ----------------------------------------------------------------------
  function setModeButtons(mode) {
    $("modeRich").classList.toggle("active", mode === "rich");
    $("modeRaw").classList.toggle("active", mode === "raw");
  }

  function applyMode(mode) {
      if (mode === "raw") {
        $("rawEditor").value = buildContent(); // 基于当前富文本状态构建整文件
        $("rawEditor").hidden = false;
        $("editorMain").hidden = true;
        $("editorHost").hidden = true;
      } else {
      if (state.mode === "raw") {
        // 从源代码切回富文本：重新解析整文件
        const { data, body } = parseFrontmatter($("rawEditor").value);
        if (state.type === "posts") {
          state.postData = data;
          renderPostFields(data);
        } else if (state.type === "dynamic") {
          $("dynPublished").value = dateToInput(data.published || "");
          $("dynLocation").value = data.location || "";
        } else {
          state.postData = data;
        }
        setBodyMarkdown(body);
      }
        $("rawEditor").hidden = true;
        $("editorMain").hidden = false;
        $("editorHost").hidden = false;
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
      return serializeFrontmatter(collectPostData(), getBodyMarkdown());
    }
    if (state.type === "dynamic") {
      const data = {};
      const pub = inputToDateStr($("dynPublished").value, true);
      if (pub) data.published = pub;
      const loc = $("dynLocation").value.trim();
      if (loc) data.location = loc;
      return serializeFrontmatter(data, getBodyMarkdown());
    }
    // spec：保留原始 frontmatter + 富文本正文
    return serializeFrontmatter(state.postData || {}, getBodyMarkdown());
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
        setStatus((data && (data.error || data.message)) || "保存失败", "err");
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
        toast((data && (data.error || data.message)) || "删除失败", "err");
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
  // 本地文件上传（上传到 GitHub 仓库 public/uploads，再插入编辑器）
  // ----------------------------------------------------------------------
  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(new Error("读取文件失败"));
      r.readAsDataURL(file);
    });
  }

  function addUploadItem(url, name, isImage) {
    const box = $("upList");
    if (!box) return;
    const div = document.createElement("div");
    div.className = "up-item";
    const thumb = isImage ? `<img src="${esc(url)}" alt="">` : `<span style="font-size:20px">📄</span>`;
    div.innerHTML =
      thumb +
      `<span class="up-name" title="${esc(name)}">${esc(name)}</span>` +
      `<button type="button" class="up-insert" data-url="${esc(url)}" data-img="${isImage ? 1 : 0}">插入</button>`;
    box.appendChild(div);
  }

  function addUploadItemError(name, msg) {
    const box = $("upList");
    if (!box) return;
    const div = document.createElement("div");
    div.className = "up-item";
    div.innerHTML =
      `<span style="font-size:18px">⚠️</span>` +
      `<span class="up-name" title="${esc(name)}">${esc(name)}</span>` +
      `<span class="up-err">${esc(msg)}</span>`;
    box.appendChild(div);
  }

  async function uploadFile(file) {
    try {
      const b64 = await fileToBase64(file);
      const safe = file.name.replace(/\s+/g, "_");
      const name = Date.now() + "-" + safe;
      const { status, data } = await api("/api/upload", {
        method: "POST",
        body: JSON.stringify({ name, content: b64, message: "Upload " + file.name + " via Firefly-Admin" }),
      });
      if (status === 200 && data && data.ok) {
        addUploadItem(data.url, file.name, file.type.startsWith("image/"));
        toast("已上传：" + file.name);
      } else {
        addUploadItemError(file.name, (data && data.error) || "上传失败");
      }
    } catch (e) {
      addUploadItemError(file.name, e.message || "上传失败");
    }
  }

  async function handleFiles(files) {
    if (!files || !files.length) return;
    for (const f of files) await uploadFile(f);
  }

  function insertAsset(url, isImage) {
    if (!state.current) { toast("请先打开或新建一个文件，再插入资源", "err"); return; }
    if (state.mode === "raw") {
      const ta = $("rawEditor");
      const text = isImage ? "![](" + url + ")" : "[文件](" + url + ")";
      const s = ta.selectionStart, e2 = ta.selectionEnd;
      ta.value = ta.value.slice(0, s) + text + ta.value.slice(e2);
      ta.selectionStart = ta.selectionEnd = s + text.length;
      ta.focus();
    } else {
      ensureEditor();
      if (editor) {
        if (isImage) editor.insertImage({ url, alt: "" });
        else editor.insertText("[文件](" + url + ")");
      } else if (fallbackBody) {
        const s = fallbackBody.selectionStart, e2 = fallbackBody.selectionEnd;
        const text = isImage ? "![](" + url + ")" : "[文件](" + url + ")";
        fallbackBody.value = fallbackBody.value.slice(0, s) + text + fallbackBody.value.slice(e2);
        fallbackBody.focus();
      }
    }
  }

  // ----------------------------------------------------------------------
  // 事件绑定
  // ----------------------------------------------------------------------
  let bound = false;
  function bindEvents() {
    if (bound) return;
    bound = true;
    const on = (id, prop, fn) => {
      const el = $(id);
      if (el) el[prop] = fn;
    };

    const tabs = $("typeTabs");
    if (tabs) {
      tabs.querySelectorAll(".tab").forEach((t) => {
        t.onclick = () => {
          tabs.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
          t.classList.add("active");
          state.type = t.dataset.type;
          state.subdir = "";
          backToEmpty();
          loadList();
        };
      });
    }

    on("searchInput", "oninput", renderList);
    on("refreshBtn", "onclick", loadList);
    on("newBtn", "onclick", newFile);
    on("saveBtn", "onclick", saveFile);
    on("deleteBtn", "onclick", deleteFile);
    on("backBtn", "onclick", backToEmpty);
    on("logoutBtn", "onclick", async () => {
      try { await api("/api/logout", { method: "POST" }); } catch (e) { /* ignore */ }
      localStorage.removeItem("ff_token");
      location.replace("login.html");
    });

    on("modeRich", "onclick", () => applyMode("rich"));
    on("modeRaw", "onclick", () => applyMode("raw"));

    // 抽屉
    on("menuBtn", "onclick", () => {
      if (isMobile()) {
        if ($("sidebar").classList.contains("open")) closeDrawer();
        else openDrawer();
      } else {
        $("mainApp").classList.toggle("sidebar-collapsed");
        window.dispatchEvent(new Event("resize"));
      }
    });
    on("drawerBackdrop", "onclick", closeDrawer);

    // 可折叠元信息面板（文章 / 动态字段）：点击标题栏展开或收起
    document.querySelectorAll(".panel-head").forEach((h) => {
      h.addEventListener("click", () => {
        const p = h.closest(".meta-panel");
        if (p) {
          p.classList.toggle("collapsed");
          window.dispatchEvent(new Event("resize"));
        }
      });
    });

    // 上传：选择文件
    on("pickBtn", "onclick", () => { const fi = $("fileInput"); if (fi) fi.click(); });
    on("fileInput", "onchange", (e) => { handleFiles(e.target.files); e.target.value = ""; });

    // 上传：拖拽到面板
    const up = $("uploadPanel");
    if (up) {
      up.addEventListener("dragover", (ev) => { ev.preventDefault(); up.classList.add("drag"); });
      up.addEventListener("dragleave", () => up.classList.remove("drag"));
      up.addEventListener("drop", (ev) => {
        ev.preventDefault();
        up.classList.remove("drag");
        if (ev.dataTransfer && ev.dataTransfer.files) handleFiles(ev.dataTransfer.files);
      });
    }

    // 已上传列表：点击「插入」
    const ul = $("upList");
    if (ul) ul.addEventListener("click", (ev) => {
      const btn = ev.target.closest(".up-insert");
      if (!btn) return;
      insertAsset(btn.dataset.url, btn.dataset.img === "1");
    });
  }

  init();
})();
