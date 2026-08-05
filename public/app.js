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
    htmlMode: false,   // 当前文件为 HTML（如 FooterConfig.html），用 WYSIWYG 富文本
    plainRaw: false,   // 当前配置文件非 HTML（如 .ts/.md），仅源代码编辑
    postData: {},  // 解析出的 frontmatter（posts / spec 复用）
  };

  // 文章信息字段：按分组美化展示，加密保护单独成组并带启用开关
  const POST_GROUPS = [
    { title: "基础信息", icon: "📌", fields: [
      { key: "title", label: "标题", type: "text", required: true, full: true },
      { key: "published", label: "发布日期", type: "datetime", required: true },
      { key: "updated", label: "更新日期", type: "datetime" },
      { key: "slug", label: "自定义路径 slug", type: "text" },
      { key: "lang", label: "语言 lang", type: "text" },
      { key: "author", label: "作者 author", type: "text" },
    ]},
    { title: "摘要与封面", icon: "🖼️", fields: [
      { key: "description", label: "描述 description", type: "textarea", full: true },
      { key: "image", label: "封面图 image", type: "text", full: true },
    ]},
    { title: "分类与标签", icon: "🏷️", fields: [
      { key: "tags", label: "标签 tags（逗号分隔）", type: "text" },
      { key: "category", label: "分类 category", type: "text" },
    ]},
    { title: "加密保护", icon: "🔒", encrypt: true, fields: [
      { key: "password", label: "访问密码 password", type: "password" },
      { key: "passwordHint", label: "密码提示 passwordHint", type: "text", full: true },
    ]},
    { title: "发布选项", icon: "⚙️", fields: [
      { key: "draft", label: "草稿（不对读者可见）", type: "checkbox" },
      { key: "pinned", label: "置顶 pinned", type: "checkbox" },
      { key: "comment", label: "允许评论 comment", type: "checkbox" },
    ]},
    { title: "高级", icon: "🧩", fields: [
      { key: "licenseName", label: "许可证名称", type: "text", full: true },
      { key: "licenseUrl", label: "许可证链接", type: "text", full: true },
      { key: "sourceLink", label: "来源链接", type: "text", full: true },
    ]},
  ];
  // 扁平化便于遍历（保持分组顺序）
  const POST_FIELDS = POST_GROUPS.flatMap((g) => g.fields);

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
  function setHtmlContent(html) {
    ensureEditor();
    if (editor && editor.setHTML) editor.setHTML(html || "");
    else if (fallbackBody) fallbackBody.value = html || "";
  }
  function getHtmlContent() {
    if (editor && editor.getHTML) return editor.getHTML();
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
        else if (/\.html?$/i.test(f.name)) icon = "🌐";
        else if (/\.(png|jpe?g|gif|webp|avif|svg)$/i.test(f.name)) icon = "🖼️";
        let nameHtml;
        if (isDir) {
          nameHtml = `<span class="fi-name">${esc(f.name)}</span>`;
        } else {
          const dot = f.name.lastIndexOf(".");
          const base = dot > 0 ? f.name.slice(0, dot) : f.name;
          const ext = dot > 0 ? f.name.slice(dot) : "";
          nameHtml = `<span class="fi-name">${esc(base)}</span><span class="fi-ext">${esc(ext)}</span>`;
        }
        div.innerHTML = `<span class="fi-icon">${icon}</span>${nameHtml}` +
          (isDir ? "" : `<span class="fi-size">${fmtSize(f.size)}</span>`);
        div.title = f.name; // 悬停显示完整文件名（含后缀）
        div.onclick = () => {
          if (isDir) navigate(f);
          else openFile(f);
          if (isMobile()) closeDrawer();
        };
        div.oncontextmenu = (e) => onItemContext(e, f);
        box.appendChild(div);
      });
  }

  function typePrefix() {
    return (state.type === "config" ? "src/config" : CONTENT_ROOT + "/" + state.type) + "/";
  }

  function navigate(dirItem) {
    const prefix = typePrefix();
    state.subdir = dirItem.path.startsWith(prefix) ? dirItem.path.slice(prefix.length) : dirItem.name;
    loadList();
  }

  function upDir() {
    if (!state.subdir) return;
    const parts = state.subdir.split("/");
    parts.pop();
    state.subdir = parts.join("/");
    loadList();
  }

  function currentDirPath() {
    let p = state.type === "config" ? "src/config" : CONTENT_ROOT + "/" + state.type;
    if (state.subdir) p += "/" + state.subdir;
    return p;
  }

  // 上传落点：为不破坏 Astro 内容集合构建，统一进 public/uploads，并按栏目/子目录归类
  function dirForUpload(folderPath) {
    if (folderPath) {
      const rel = folderPath.replace(/^src\/(content|config)\//, "");
      return "public/uploads/" + rel;
    }
    let d = "public/uploads";
    if (state.subdir) d += "/" + state.subdir;
    return d;
  }

  function renderCrumb() {
    const c = $("crumb");
    let html = state.type === "config" ? "src/config" : `${CONTENT_ROOT}/${state.type}`;
    if (state.subdir) html += " / " + state.subdir;
    c.textContent = html;
    const ub = $("upDirBtn");
    if (ub) ub.hidden = !state.subdir;
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
      state.htmlMode = /\.html?$/i.test(f.name);
      state.plainRaw = (state.type === "config" && !state.htmlMode);
      let fm = {}, body = data.content;
      if (!state.htmlMode) {
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
    state.htmlMode = false;
    state.plainRaw = false;
    if (state.type === "dynamic") {
      name = tsFilename();
      fm = { published: inputToDateStr(nowLocalInput(), true), location: "" };
      body = "";
    } else if (state.type === "posts") {
      name = "untitled.md";
      fm = { title: "新文章", published: inputToDateStr(nowLocalInput(), false), draft: true };
      body = "# 新文章\n\n在这里写正文…\n";
    } else if (state.type === "config") {
      name = "untitled.html";
      state.htmlMode = true;
      fm = {};
      body = "<!-- 新配置 -->\n";
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
    const isConfig = state.type === "config";
    $("postPanel").hidden = !isPosts;
    $("dynamicPanel").hidden = !isDynamic;

    if (isPosts) {
      renderPostFields(fm);
      const badge = $("encBadge");
      if (badge) badge.hidden = !(fm && fm.password);
    }
    if (isDynamic) {
      $("dynPublished").value = dateToInput(fm.published || "");
      $("dynLocation").value = fm.location || "";
    }

    // 纯文本配置文件（如 .ts）不显示富文本/源代码切换
    $("modeSwitch").hidden = state.plainRaw;

    // 先让容器可见，再创建/填充编辑器，避免初次创建时高度为 0
    $("editorMain").hidden = state.plainRaw;
    $("editorHost").hidden = state.plainRaw;
    $("rawEditor").hidden = !state.plainRaw;
    if (state.plainRaw) {
      $("rawEditor").value = body;
    } else if (state.htmlMode) {
      setHtmlContent(body);
    } else {
      setBodyMarkdown(body);
    }
    setModeButtons("rich");
    setStatus("");
    // 触发编辑器重排，保证移动端高度正确
    window.dispatchEvent(new Event("resize"));
  }

  function renderPostFields(fm) {
    const box = $("postFields");
    box.innerHTML = "";
    POST_GROUPS.forEach((g) => {
      const group = document.createElement("div");
      group.className = "pf-group";
      if (g.encrypt) group.dataset.encrypt = "1";

      const head = document.createElement("div");
      head.className = "pf-group-head";
      head.innerHTML = `<span class="pf-g-icon">${g.icon}</span><span>${g.title}</span>`;
      group.appendChild(head);

      const fieldsWrap = document.createElement("div");
      fieldsWrap.className = "pf-fields";
      group.appendChild(fieldsWrap);

      // 加密保护组：顶部的「启用访问密码」开关
      if (g.encrypt) {
        const enabled = !!(fm && fm.password);
        const swRow = document.createElement("label");
        swRow.className = "pf-switch-row";
        const swText = document.createElement("span");
        swText.textContent = "启用访问密码（加密文章）";
        const sw = document.createElement("input");
        sw.type = "checkbox";
        sw.className = "pf-switch";
        sw.checked = enabled;
        sw.dataset.role = "encToggle";
        swRow.appendChild(swText);
        swRow.appendChild(sw);
        group.insertBefore(swRow, fieldsWrap);
        fieldsWrap.dataset.role = "encBody";
        fieldsWrap.style.display = enabled ? "" : "none";
        sw.onchange = () => { fieldsWrap.style.display = sw.checked ? "" : "none"; };
      }

      g.fields.forEach((f) => {
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
        } else if (f.type === "password") {
          // 密码框 + 显隐切换
          const row = document.createElement("div");
          row.className = "pw-row";
          input = document.createElement("input");
          input.type = "password";
          input.value = fm[f.key] || "";
          const eye = document.createElement("button");
          eye.type = "button";
          eye.className = "pwd-toggle";
          eye.textContent = "👁";
          eye.setAttribute("aria-label", "显示/隐藏密码");
          eye.onclick = () => {
            input.type = input.type === "password" ? "text" : "password";
            eye.textContent = input.type === "password" ? "👁" : "🙈";
          };
          row.appendChild(input);
          row.appendChild(eye);
          input.dataset.key = f.key;
          input.dataset.kind = f.type;
          wrap.appendChild(label);
          wrap.appendChild(row);
          fieldsWrap.appendChild(wrap);
          return;
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
        fieldsWrap.appendChild(wrap);
      });

      box.appendChild(group);
    });
  }

  function collectPostData() {
    const data = {};
    const encGroup = document.querySelector("#postFields .pf-group[data-encrypt='1']");
    const encOn = encGroup ? encGroup.querySelector("[data-role='encToggle']").checked : false;
    POST_FIELDS.forEach((f) => {
      const el = document.querySelector(`#postFields [data-key="${f.key}"]`);
      if (!el) return;
      // 加密字段：未启用开关时跳过，确保不写入 password / passwordHint
      if ((f.type === "password" || f.key === "passwordHint") && !encOn) return;
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
    if (state.plainRaw) return; // 纯文本配置文件无富文本/源代码切换
    if (mode === "raw") {
      $("rawEditor").value = buildContent(); // 基于当前富文本状态构建整文件
      $("rawEditor").hidden = false;
      $("editorMain").hidden = true;
      $("editorHost").hidden = true;
    } else {
      if (state.mode === "raw") {
        // 从源代码切回富文本：重新解析整文件
        const raw = $("rawEditor").value;
        if (state.htmlMode) {
          setHtmlContent(raw);
        } else {
          const { data, body } = parseFrontmatter(raw);
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
      }
      $("rawEditor").hidden = true;
      $("editorMain").hidden = false;
      $("editorHost").hidden = false;
      window.dispatchEvent(new Event("resize"));
    }
    state.mode = mode;
    setModeButtons(mode);
  }

  // ----------------------------------------------------------------------
  // 构建文件内容
  // ----------------------------------------------------------------------
  function buildContent() {
    if (state.plainRaw) return $("rawEditor").value;
    if (state.mode === "raw") return $("rawEditor").value;
    if (state.htmlMode) return getHtmlContent();
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
      // 配置文件（如 FooterConfig.html）允许任意扩展名，内容类仍需 .md/.mdx
      if (state.type !== "config" && !/\.(md|mdx)$/i.test(fname)) {
        setStatus("文件名需以 .md 或 .mdx 结尾", "err");
        return;
      }
      const base = state.type === "config" ? "src/config" : CONTENT_ROOT + "/" + state.type;
      path = base + (state.subdir ? "/" + state.subdir : "") + "/" + fname;
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
    const ok = await openModal({
      title: "删除确认",
      html: "<div class=\"modal-msg\">确定删除 <b>" + esc(state.current.name) + "</b> ？<br>此操作会提交到 GitHub，不可撤销。</div>",
      confirmText: "删除",
      danger: true,
    });
    if (!ok) return;
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

  // ----------------------------------------------------------------------
  // 通用弹窗（替代原生 prompt / confirm，与主题一致）
  // ----------------------------------------------------------------------
  function openModal(opts) {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "modal-overlay";
      const hasInput = opts.input !== undefined && opts.input !== null;
      const suffix = opts.suffix || "";
      overlay.innerHTML =
        '<div class="modal-card" role="dialog" aria-modal="true">' +
          '<div class="modal-title">' + esc(opts.title || "提示") + '</div>' +
          (opts.html ? '<div class="modal-body">' + opts.html + '</div>' : '') +
          (hasInput ?
            '<div class="modal-input-row">' +
              '<input type="text" class="modal-input" id="modalInput" value="' + esc(opts.input) + '" placeholder="' + esc(opts.placeholder || "") + '" />' +
              (suffix ? '<span class="modal-suffix" title="扩展名已锁定，不可修改">' + esc(suffix) + '</span>' : '') +
            '</div>' : '') +
          (opts.hint ? '<div class="modal-hint">' + esc(opts.hint) + '</div>' : '') +
          '<div class="modal-actions">' +
            '<button class="btn ghost modal-cancel" type="button">取消</button>' +
            '<button class="btn ' + (opts.danger ? "danger" : "primary") + ' modal-ok" type="button">' + esc(opts.confirmText || "确定") + '</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(overlay);
      const input = overlay.querySelector("#modalInput");
      const okBtn = overlay.querySelector(".modal-ok");
      const cancelBtn = overlay.querySelector(".modal-cancel");

      function close(val) {
        overlay.remove();
        document.removeEventListener("keydown", onKey);
        resolve(val);
      }
      function submit() {
        if (input && !input.value.trim()) { input.focus(); return; }
        close(input ? (input.value.trim() + suffix) : true);
      }
      function onKey(e) {
        if (e.key === "Escape") close(null);
        else if (e.key === "Enter") { e.preventDefault(); submit(); }
      }
      okBtn.addEventListener("click", submit);
      cancelBtn.addEventListener("click", () => close(null));
      overlay.addEventListener("click", (e) => { if (e.target === overlay) close(null); });
      document.addEventListener("keydown", onKey);
      if (input) { input.focus(); input.select(); }
    });
  }

  // ----------------------------------------------------------------------
  // 右键菜单 + 重命名 / 删除
  // ----------------------------------------------------------------------
  function openCtx(x, y, items) {
    const menu = $("ctxMenu");
    menu.innerHTML = "";
    items.forEach((it) => {
      const el = document.createElement("div");
      el.className = "ctx-item" + (it.danger ? " danger" : "");
      el.textContent = it.label;
      el.onclick = () => { closeCtx(); it.action(); };
      menu.appendChild(el);
    });
    menu.hidden = false;
    const mw = 180, mh = items.length * 34 + 8;
    menu.style.left = Math.min(x, window.innerWidth - mw) + "px";
    menu.style.top = Math.min(y, window.innerHeight - mh) + "px";
  }
  function closeCtx() { const m = $("ctxMenu"); if (m) m.hidden = true; }

  function onItemContext(e, item) {
    e.preventDefault();
    const isDir = item.type === "dir";
    const items = [];
    if (isDir) {
      items.push({ label: "📂 进入目录", action: () => navigate(item) });
      items.push({ label: "⬆️ 上传到此目录", action: () => triggerUpload(dirForUpload(item.path)) });
    }
    items.push({ label: "✏️ 重命名", action: () => renameItem(item) });
    items.push({ label: "🗑 删除", danger: true, action: () => removeItem(item) });
    openCtx(e.clientX, e.clientY, items);
  }

  function triggerUpload(dir) {
    const fi = $("ctxFileInput");
    if (!fi) return;
    fi.dataset.dir = dir || "";
    fi.click();
  }

  async function renameItem(item) {
    const isFile = item.type !== "dir";
    const dot = item.name.lastIndexOf(".");
    const ext = isFile && dot > 0 ? item.name.slice(dot) : "";
    const base = isFile && dot > 0 ? item.name.slice(0, dot) : item.name;
    const nn = await openModal({
      title: "重命名",
      html: "<div class=\"modal-msg\">请输入新的名称" + (ext ? "（扩展名 <b>" + esc(ext) + "</b> 已锁定，不可修改）" : "") + "：</div>",
      input: base,
      suffix: ext,
      placeholder: "文件名称",
      confirmText: "重命名",
    });
    if (!nn) return;
    if (nn === item.name) { toast("文件名未改变"); return; }
    const newName = nn; // 已自动拼接锁定的扩展名
    const parent = item.path.slice(0, item.path.length - item.name.length).replace(/\/$/, "");
    const newPath = parent + "/" + newName;
    try {
      const { status, data } = await api("/api/rename", {
        method: "POST",
        body: JSON.stringify({ oldPath: item.path, newPath, isDir: item.type === "dir" }),
      });
      if (status === 200 && data && data.ok) {
        toast("已重命名");
        // 若重命名的是当前打开的文件，同步更新编辑态路径
        if (state.current && state.current.path === item.path) {
          state.current.path = newPath;
          state.current.name = newName;
          $("fileName").value = newName;
        }
        await loadList();
      } else {
        toast((data && data.error) || "重命名失败", "err");
      }
    } catch (e) {
      toast(e.message || "重命名失败", "err");
    }
  }

  async function removeItem(item) {
    const tip = item.type === "dir" ? "（包含其下所有内容）" : "";
    const ok = await openModal({
      title: "删除确认",
      html: "<div class=\"modal-msg\">确定删除 <b>" + esc(item.name) + "</b>" + tip + "？<br>此操作会提交到 GitHub，不可撤销。</div>",
      confirmText: "删除",
      danger: true,
    });
    if (!ok) return;
    try {
      const { status, data } = await api("/api/remove", {
        method: "POST",
        body: JSON.stringify({ path: item.path, isDir: item.type === "dir" }),
      });
      if (status === 200 && data && data.ok) {
        toast("已删除");
        if (state.current && state.current.path && state.current.path.startsWith(item.path)) {
          backToEmpty();
        }
        await loadList();
      } else {
        toast((data && data.error) || "删除失败", "err");
      }
    } catch (e) {
      toast(e.message || "删除失败", "err");
    }
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

  async function uploadFileToDir(file, dir) {
    try {
      const b64 = await fileToBase64(file);
      const safe = file.name.replace(/\s+/g, "_");
      const name = Date.now() + "-" + safe;
      const payload = { name, content: b64, message: "Upload " + file.name + " via Firefly-Admin" };
      if (dir) payload.dir = dir;
      const { status, data } = await api("/api/upload", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      if (status === 200 && data && data.ok) {
        toast("已上传：" + file.name + (dir ? " → " + dir : ""));
      } else {
        toast((data && data.error) || "上传失败", "err");
      }
    } catch (e) {
      toast(e.message || "上传失败", "err");
    }
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

    on("upDirBtn", "onclick", upDir);

    // 文件列表：右键空白处 -> 上传到当前目录
    const fl = $("fileList");
    if (fl) {
      fl.addEventListener("contextmenu", (e) => {
        if (e.target.closest(".file-item")) return; // 文件项自身已处理
        e.preventDefault();
        openCtx(e.clientX, e.clientY, [
          { label: "⬆️ 上传到当前目录", action: () => triggerUpload(dirForUpload()) },
        ]);
      });
      // 拖拽文件到列表 = 上传到当前目录
      fl.addEventListener("dragover", (ev) => { ev.preventDefault(); fl.classList.add("drag"); });
      fl.addEventListener("dragleave", (e) => { if (!fl.contains(e.relatedTarget)) fl.classList.remove("drag"); });
      fl.addEventListener("drop", (ev) => {
        ev.preventDefault();
        fl.classList.remove("drag");
        if (ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files.length) {
          const dir = dirForUpload();
          for (const f of ev.dataTransfer.files) uploadFileToDir(f, dir);
        }
      });
    }

    // 右键菜单：点击别处 / 按 Esc 关闭
    document.addEventListener("click", (e) => {
      const m = $("ctxMenu");
      if (m && !m.hidden && !e.target.closest(".ctx-menu")) closeCtx();
    });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeCtx(); });

    // 右键菜单触发的上传：选完文件上传到目标目录
    on("ctxFileInput", "onchange", (e) => {
      const dir = e.target.dataset.dir || dirForUpload();
      if (e.target.files && e.target.files.length) {
        for (const f of e.target.files) uploadFileToDir(f, dir);
      }
      e.target.value = "";
    });
  }

  init();
})();
