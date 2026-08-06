/* Firefly CMS 前端逻辑（富文本版） */
(() => {
  "use strict";

  const CONTENT_ROOT = "src/content";
  const $ = (id) => document.getElementById(id);

  const state = {
    token: localStorage.getItem("ff_token") || "",
    status: null,
    owner: "",
    repo: "",
    branch: "master",
    type: "posts",
    subdir: "",
    files: [],
    selected: new Set(), // 批量删除已勾选的文件 path
    selectableCount: 0,  // 当前列表可勾选（非配置）条目数
    current: null, // {path, sha, name, isNew, type}
    mode: "rich", // rich | raw
    htmlMode: false,   // 当前文件为 HTML（如 FooterConfig.html），用 WYSIWYG 富文本
    plainRaw: false,   // 当前配置文件非 HTML（如 .md），仅源代码编辑
    configStruct: false, // 当前配置文件为可结构化编辑的 .ts（参数名锁定、值可编辑）
    forceMarkdown: false, // 当前 .md 含裸 HTML/iframe，强制用 Markdown 模式（避免 WYSIWYG 转换崩溃）
    configRaw: "",     // 原始配置源码（保存时按偏移量回写值）
    configRoots: [],   // parseConfig 解析出的配置根节点
    booknavMode: false, // 当前配置文件为 booknavConfig.ts（数组以列表形式编辑）
    booknavModel: null, // booknavConfig 解析出的分组模型（用于列表编辑 / 新增）
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

  // 配置 / 单页文件名 -> 列表显示名（依据 src/config/README.md 与固定页面）
  const CONFIG_NAME_MAP = {
    "siteConfig.ts": "站点基础配置",
    "analyticsConfig.ts": "统计分析配置",
    "announcementConfig.ts": "公告配置",
    "backgroundWallpaper.ts": "背景壁纸配置",
    "commentConfig.ts": "评论系统配置",
    "coverImageConfig.ts": "封面图配置",
    "dynamicConfig.ts": "动态页面配置",
    "effectsConfig.ts": "动画特效配置",
    "expressiveCodeConfig.ts": "代码高亮配置",
    "fontConfig.ts": "字体配置",
    "footerConfig.ts": "页脚配置",
    "friendsConfig.ts": "友链配置",
    "galleryConfig.ts": "相册配置",
    "licenseConfig.ts": "许可证配置",
    "musicConfig.ts": "音乐播放器配置",
    "navBarConfig.ts": "导航栏配置",
    "pioConfig.ts": "看板娘配置",
    "plantumlConfig.ts": "PlantUML 图表配置",
    "profileConfig.ts": "用户资料配置",
    "sidebarConfig.ts": "侧边栏布局配置",
    "sponsorConfig.ts": "打赏配置",
  };
  const SPEC_NAME_MAP = {
    "about.md": "关于我",
    "friends.mdx": "友链",
    "guestbook.md": "留言页",
  };

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

  // 判断 Markdown 正文是否含「裸 HTML / iframe / 代码块内嵌 frontmatter」：
  // 这类内容在 ToastUI 的 WYSIWYG 模式会因裸 HTML（尤其畸形标签如 Bilibili 的 allowfullscreen="true" &autoplay=0）
  // 或代码块内 --- 而转换崩溃，必须改用 Markdown 模式（官方文档即「直接在 Markdown 中粘贴 iframe」）。
  function isHtmlHeavy(md) {
    if (!md) return false;
    if (/<(iframe|video|audio|script|style|object|embed|svg|canvas|details|summary|table|form|input|select|textarea|img|div|section|article|header|footer|nav|button|pre)\b/i.test(md)) return true;
    // 代码块内嵌 frontmatter（--- ... ---）会让 WYSIWYG 解析出错
    if (/```[\s\S]*?\n---\s*\n[\s\S]*?\n---\s*\n[\s\S]*?```/.test(md)) return true;
    return false;
  }

  // 组件存在但彻底不可用时，改用纯文本 textarea，保证文件「一定打得开、可编辑」
  function useFallbackBody(val) {
    if (fallbackBody) { fallbackBody.value = val; return; }
    const host = $("editor");
    if (host) host.style.display = "none";
    fallbackBody = document.createElement("textarea");
    fallbackBody.className = "raw-editor";
    fallbackBody.style.flex = "1";
    $("editorHost").appendChild(fallbackBody);
    fallbackBody.value = val || "";
  }

  function setBodyMarkdown(md) {
    ensureEditor();
    state.forceMarkdown = isHtmlHeavy(md);
    if (editor) {
      try {
        editor.setMarkdown(md || "", false);
        // 含裸 HTML 的帖子用 Markdown 模式（与官方文档一致），避免 WYSIWYG 转换崩溃导致「打不开」
        const want = state.forceMarkdown ? "markdown" : "wysiwyg";
        const cur = (typeof editor.getEditorType === "function") ? editor.getEditorType() : want;
        if (cur !== want) editor.changeMode(want, false);
        return;
      } catch (e) {
        // 第一次失败：尝试 Markdown 模式兜底
        try {
          editor.changeMode("markdown", false);
          editor.setMarkdown(md || "", false);
          state.forceMarkdown = true;
          return;
        } catch (_) { /* 落到纯文本 */ }
      }
      useFallbackBody(md || "");
      toast("富文本渲染异常，已切换为纯文本编辑", "err");
    } else if (fallbackBody) {
      fallbackBody.value = md || "";
    }
  }
  function getBodyMarkdown() {
    if (fallbackBody) return fallbackBody.value;
    if (editor) return editor.getMarkdown();
    return "";
  }
  function setHtmlContent(html) {
    ensureEditor();
    if (editor && editor.setHTML) {
      try {
        editor.setHTML(html || "");
        return;
      } catch (e) {
        useFallbackBody(html || "");
        toast("富文本渲染异常，已切换为纯文本编辑", "err");
        return;
      }
    }
    if (fallbackBody) fallbackBody.value = html || "";
  }
  function getHtmlContent() {
    if (fallbackBody) return fallbackBody.value;
    if (editor && editor.getHTML) return editor.getHTML();
    return "";
  }

  // 同一时刻只显示一种编辑器，避免不同后缀对应的编辑器叠加显示
  function showOnlyEditor(active) {
    const showMain = active === "main";   // 富文本 / HTML 所见即所得
    const showRaw = active === "raw";      // 源代码
    const showCfg = active === "config";   // 可视化配置（参数锁定）
    $("editorMain").hidden = !showMain;
    $("editorHost").hidden = !showMain;
    $("rawEditor").hidden = !showRaw;
    $("configEditor").hidden = !showCfg;
  }

  // 根据当前文件类型推断「编辑器类型」徽标（让用户清楚当前用的是哪种编辑器）
  function editorKind() {
    if (state.configStruct) return { kind: "config", label: "可视化配置 · 参数锁定", icon: "⚙️" };
    if (state.htmlMode) return { kind: "html", label: "HTML 富文本", icon: "🌐" };
    if (state.plainRaw) return { kind: "raw", label: "源代码", icon: "📄" };
    if (state.type === "dynamic") return { kind: "md", label: "Markdown 富文本", icon: "⚡" };
    if (state.type === "spec") return { kind: "md", label: "Markdown 富文本", icon: "📄" };
    return { kind: "md", label: "Markdown 富文本", icon: "📝" };
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
    state.owner = s.owner || "";
    state.repo = s.repo || "";
    state.branch = s.branch || "master";
    $("repoInfo").textContent = `${s.owner}/${s.repo}@${s.branch}`;
    bindEvents();
    await selectSection("posts");
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

  // 当前板块是否允许重命名 / 删除（配置类禁止，仅文章 / 动态 / 单页有效）
  function canModify() {
    return state.type !== "config";
  }

  function renderList() {
    const box = $("fileList");
    box.innerHTML = "";
    const kw = ($("searchInput").value || "").toLowerCase();
    const modifiable = canModify();
    state.selectableCount = 0;
    const IMG_RE = /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i;
    const _files = state.files
      .filter((f) => f.name.toLowerCase().includes(kw))
      // 配置板块隐藏 index.ts（仅为统一导出，无可视化参数）
      .filter((f) => !(state.type === "config" && f.name === "index.ts"));
    // 图片与文档分开：图片走宫格预览，文档走可编辑列表
    const _docs = _files.filter((f) => !IMG_RE.test(f.name));
    const _imgs = _files.filter((f) => IMG_RE.test(f.name));
    _docs.forEach((f) => {
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
          // 配置 / 单页：优先用 README / 固定页面的中文显示名
          let displayBase = base;
          let mapped = false;
          if (state.type === "config" && CONFIG_NAME_MAP[f.name]) { displayBase = CONFIG_NAME_MAP[f.name]; mapped = true; }
          else if (state.type === "spec" && SPEC_NAME_MAP[f.name]) { displayBase = SPEC_NAME_MAP[f.name]; mapped = true; }
          nameHtml = `<span class="fi-name">${esc(displayBase)}</span>`;
          if (mapped) nameHtml += `<span class="fi-origin" title="${esc(f.name)}">${esc(f.name)}</span>`;
          else nameHtml += `<span class="fi-ext">${esc(ext)}</span>`;
        }

        // 左侧可勾选（仅可修改板块的内容，配置类不可批量操作）
        const check = modifiable
          ? `<input type="checkbox" class="fi-check" data-path="${esc(f.path)}"${state.selected.has(f.path) ? " checked" : ""} />`
          : "";
        if (modifiable) state.selectableCount++;

        // 行内操作按钮：编辑常驻；重命名 / 删除仅可修改板块
        let actions = `<button class="fi-act edit" type="button" data-act="edit" title="编辑">✏️ 编辑</button>`;
        if (modifiable) {
          if (!isDir) actions += `<button class="fi-act" type="button" data-act="rename" title="重命名">✏️ 重命名</button>`;
          actions += `<button class="fi-act danger" type="button" data-act="delete" title="删除">🗑 删除</button>`;
        }

        div.innerHTML =
          check +
          `<div class="fi-main"><span class="fi-icon">${icon}</span>${nameHtml}` +
          (isDir ? "" : `<span class="fi-size">${fmtSize(f.size)}</span>`) +
          `</div>` +
          `<div class="fi-actions">${actions}</div>`;
        div.title = f.name; // 悬停显示完整文件名（含后缀）

        // 点击主区域：目录进入、文件打开编辑
        const main = div.querySelector(".fi-main");
        main.onclick = () => {
          if (isDir) navigate(f);
          else openFile(f);
          if (isMobile()) closeDrawer();
        };
        // 右键菜单（桌面）：构建与类型相关的菜单项
        div.oncontextmenu = (e) => onItemContext(e, f);
        // 行内按钮
        div.querySelectorAll(".fi-act").forEach((b) => {
          b.onclick = (ev) => {
            ev.stopPropagation();
            const act = b.dataset.act;
            if (act === "edit") { if (isDir) navigate(f); else openFile(f); if (isMobile()) closeDrawer(); }
            else if (act === "rename") renameItem(f);
            else if (act === "delete") removeItem(f);
          };
        });
        // 复选框：切换批量选中
        const cb = div.querySelector(".fi-check");
        if (cb) cb.onchange = () => {
          if (cb.checked) state.selected.add(f.path);
          else state.selected.delete(f.path);
          updateBatchCount();
        };

        box.appendChild(div);
      });

    // 图片以宫格展示，点击预览而非编辑（不再打开源码/结构化编辑器）
    if (_imgs.length) {
      const sep = document.createElement("div");
      sep.className = "img-grid-sep";
      sep.textContent = "图片（" + _imgs.length + "）";
      box.appendChild(sep);
      const grid = document.createElement("div");
      grid.className = "img-grid";
      _imgs.forEach((f) => {
        const card = document.createElement("div");
        card.className = "img-card";
        let display = f.name;
        if (state.type === "spec" && SPEC_NAME_MAP[f.name]) display = SPEC_NAME_MAP[f.name];
        else if (CONFIG_NAME_MAP[f.name]) display = CONFIG_NAME_MAP[f.name];
        const thumb = document.createElement("img");
        thumb.className = "img-thumb";
        thumb.loading = "lazy";
        thumb.src = rawUrl(f.path);
        thumb.alt = f.name;
        thumb.onerror = () => { thumb.alt = "🖼️"; thumb.classList.add("img-thumb--err"); };
        const cap = document.createElement("div");
        cap.className = "img-cap";
        cap.textContent = display;
        const meta = document.createElement("div");
        meta.className = "img-meta";
        meta.textContent = (fmtSize(f.size) ? fmtSize(f.size) + " · " : "") + f.name;
        card.appendChild(thumb);
        card.appendChild(cap);
        card.appendChild(meta);
        // 删除（仅可修改板块：文章/动态/单页）；图片不提供「编辑」
        if (modifiable) {
          const del = document.createElement("button");
          del.className = "img-del";
          del.type = "button";
          del.title = "删除";
          del.textContent = "🗑";
          del.onclick = (ev) => { ev.stopPropagation(); removeItem(f); };
          card.appendChild(del);
        }
        card.onclick = () => openImagePreview(f.path, f.name);
        grid.appendChild(card);
      });
      box.appendChild(grid);
    }
    updateBatchCount();
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
      state.plainRaw = false;
      state.configStruct = false;
      state.forceMarkdown = false;
      // 任意 .ts 配置文件：尝试结构化解析（参数名锁定、值可编辑）；解析失败或 .md 等则回退源码
      // 不再依赖 state.type，确保从「站点外观」等任意入口打开 .ts 都能结构化编辑
      if (!state.htmlMode && /\.ts$/i.test(f.name) && typeof FireflyConfig !== "undefined") {
        const parsed = FireflyConfig.parseConfig(data.content);
        if (!parsed.error && parsed.roots.length) {
          state.configStruct = true;
          state.configRaw = data.content;
          state.configRoots = parsed.roots;
        } else {
          state.plainRaw = true; // 无法结构化（如 index.ts 纯导出）-> 源码模式
        }
      }
      // booknavConfig.ts：以「列表」形式编辑（非树形），并解析出分组模型
      state.booknavMode = (f.name === "booknavConfig.ts");
      if (state.booknavMode) state.booknavModel = parseBooknavModel();
      let fm = {}, body = data.content;
      if (!state.htmlMode && !state.configStruct) {
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

  // 各板块可选的文件后缀（新建时给出选择框，已有文件锁定）
  function extOptions(type) {
    if (type === "posts") return [".md", ".mdx"];
    if (type === "dynamic") return [".md"];
    if (type === "spec") return [".md", ".mdx", ".html"];
    if (type === "config") return [".html", ".ts"];
    return [".md"];
  }

  function newFile() {
    state.htmlMode = false;
    state.plainRaw = false;
    state.configStruct = false;
    state.forceMarkdown = false;
    let base, body, fm = {};
    if (state.type === "dynamic") {
      base = tsFilename().replace(/\.md$/i, "");
      fm = { published: inputToDateStr(nowLocalInput(), true), location: "" };
      body = "";
    } else if (state.type === "posts") {
      base = "untitled";
      fm = { title: "新文章", published: inputToDateStr(nowLocalInput(), false), draft: true };
      body = "# 新文章\n\n在这里写正文…\n";
    } else if (state.type === "config") {
      base = "untitled";
      fm = {};
      body = "<!-- 新配置 -->\n";
    } else {
      base = "page";
      fm = {};
      body = "# 新页面\n\n在这里写内容…\n";
    }
    state._newBase = base;
    state._newFm = fm;
    state._newBody = body;
    state.current = { path: null, sha: null, name: base + extOptions(state.type)[0], isNew: true, type: state.type };
    enterNewFile();
  }

  // 依据「类型 + 选中的后缀」决定编辑器模式并渲染（新建文件可随时切换后缀重渲染）
  function enterNewFile() {
    const opts = extOptions(state.type);
    if (!opts.includes($("extSelect").value)) $("extSelect").value = opts[0];
    const ext = $("extSelect").value;
    const t = state.type;
    state.htmlMode = false; state.plainRaw = false; state.configStruct = false; state.forceMarkdown = false;
    if (t === "config") {
      if (ext === ".html") state.htmlMode = true;
      else state.plainRaw = true; // .ts 新文件暂无内容，暂走源代码编辑
    }
    showEditor(state._newBody, state._newFm, state._newBase);
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
    showView("editor");
    $("emptyState").hidden = true;
    $("editForm").hidden = false;
    $("deleteBtn").hidden = state.current.isNew;
    $("fileName").value = name;
    $("fileName").readOnly = !state.current.isNew;

    // 后缀选择框：按板块给出可选后缀；新建可改、已有锁定
    const extSel = $("extSelect");
    const opts = extOptions(state.type);
    extSel.innerHTML = opts.map((e) => '<option value="' + e + '">' + e + "</option>").join("");
    if (state.current.isNew) {
      if (!opts.includes(extSel.value)) extSel.value = opts[0];
      extSel.disabled = false;
    } else {
      const dot = (state.current.name || "").lastIndexOf(".");
      let curExt = dot > 0 ? state.current.name.slice(dot) : "";
      if (curExt && !opts.includes(curExt)) {
        const o = document.createElement("option");
        o.value = curExt; o.textContent = curExt;
        extSel.appendChild(o);
      }
      extSel.value = curExt || opts[0];
      extSel.disabled = true;
    }

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

    // 纯文本配置文件（如 .md）或结构化配置（.ts）不显示富文本/源代码切换
    $("modeSwitch").hidden = state.plainRaw || state.configStruct;

    // 同一时刻只显示一种编辑器（避免后缀对应的编辑器叠加）
    if (state.configStruct) {
      renderConfigEditor();
      showOnlyEditor("config");
    } else if (state.plainRaw) {
      $("rawEditor").value = body;
      showOnlyEditor("raw");
    } else {
      if (state.htmlMode) setHtmlContent(body);
      else setBodyMarkdown(body);
      showOnlyEditor("main");
    }
    updateModeLabel();

    // 编辑器头部：文件图标 + 类型徽标 + 路径
    const k = editorKind();
    $("ehIcon").textContent = k.icon;
    const badge = $("edTypeBadge");
    badge.textContent = k.label;
    badge.className = "ed-type-badge kind-" + k.kind;
    $("ehPath").textContent = state.current.path || "";

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
  // 结构化配置编辑（参数名锁定、仅值可编辑）
  // ----------------------------------------------------------------------
  function renderConfigEditor() {
    const host = $("configEditor");
    host.innerHTML = "";
    // booknavConfig.ts：以列表（非树形）形式编辑，支持自定义新增
    if (state.booknavMode) { renderBooknavEditor(host, state.booknavModel); return; }
    if (!state.configRoots || !state.configRoots.length) {
      host.innerHTML = '<div class="cfg-empty">该配置文件无可结构化编辑的参数。</div>';
      return;
    }
    state.configRoots.forEach((r) => {
      const sec = document.createElement("div");
      sec.className = "cfg-section";
      const head = document.createElement("div");
      head.className = "cfg-section-head";
      // 优先用注释当直观标题，变量名降级为 🔒 小标签
      const titleText = r.comment ? esc(r.comment) : esc(r.name);
      const varChip = r.comment
        ? '<span class="cfg-key-chip" title="变量名固定，不可修改">🔒 ' + esc(r.name) + "</span>"
        : "";
      head.innerHTML =
        '<span class="cfg-lock" title="变量名固定，不可修改">🔒</span>' +
        '<span class="cfg-var">' + titleText + "</span>" +
        varChip +
        '<span class="cfg-hint">变量名固定 · 仅可修改值</span>';
      sec.appendChild(head);
      // 一级栏目 = 根对象下的直接子项，渲染为大标题（而非嵌套盒子）
      if (r.node.type === "object" && r.node.children && r.node.children.length) {
        r.node.children.forEach((ch) => sec.appendChild(cfgNodeEl(ch.value, ch.key, 0)));
      } else {
        sec.appendChild(cfgNodeEl(r.node, r.name, 0));
      }
      host.appendChild(sec);
    });
  }

  // 递归渲染一个配置节点；keyLabel 用于显示参数名（锁定）；depth 控制标题层级（扁平化，去嵌套盒子）
  function cfgNodeEl(node, keyLabel, depth) {
    if (node.type === "object" || node.type === "array") {
      // 一级栏目：大标题；嵌套：子标题。均不再套盒子，靠缩进体现层级
      const block = document.createElement("div");
      block.className = depth === 0 ? "cfg-title-block" : "cfg-sub-block";
      const head = document.createElement("div");
      head.className = depth === 0 ? "cfg-title" : "cfg-subtitle";
      const gname = node.comment || keyLabel;
      let inner = lockIcon() + '<span class="cfg-g-title">' + esc(gname) + "</span>";
      if (node.comment) inner += lockChip(keyLabel);
      if (node.type === "array") inner += '<span class="cfg-tag">数组</span>';
      head.innerHTML = inner;
      block.appendChild(head);
      node.children.forEach((ch) => {
        const childKey = node.type === "array" ? (ch.value.comment || (keyLabel + "[" + node.children.indexOf(ch) + "]")) : ch.key;
        block.appendChild(cfgNodeEl(ch.value, childKey, depth + 1));
      });
      return block;
    }
    // 叶子：string / number / boolean / null / expr
    const row = document.createElement("div");
    row.className = "cfg-field";
    const lab = document.createElement("label");
    lab.className = "cfg-field-label";
    if (node.comment) {
      lab.innerHTML = '<span class="cfg-name">' + esc(node.comment) + "</span>" + lockChip(keyLabel);
    } else {
      lab.innerHTML = lockIcon() + '<span class="cfg-key">' + esc(keyLabel) + "</span>";
    }
    row.appendChild(lab);

    // 注释中列出可选数值（枚举）：把输入框渲染为下拉选择
    if (node.type === "string" && node.enumValues && node.enumValues.length) {
      const sel = document.createElement("select");
      sel.className = "cfg-input cfg-select";
      node.enumValues.forEach((opt) => {
        const o = document.createElement("option");
        o.value = opt.value;
        o.textContent = opt.label;
        if (String(node.value) === String(opt.value)) o.selected = true;
        sel.appendChild(o);
      });
      sel.dataset.start = node.start;
      sel.dataset.end = node.end;
      sel.dataset.vtype = "string";
      sel.dataset.quote = node.quote || '"';
      row.appendChild(sel);
      return row;
    }

    if (node.type === "expr") {
      const inp = document.createElement("input");
      inp.type = "text";
      inp.className = "cfg-input";
      inp.value = node.value;
      inp.disabled = true;
      const note = document.createElement("span");
      note.className = "cfg-locked-note";
      note.textContent = "（引用 / 表达式，禁止修改）";
      row.appendChild(inp);
      row.appendChild(note);
      return row;
    }

    let inp;
    if (node.type === "boolean") {
      inp = document.createElement("input");
      inp.type = "checkbox";
      inp.className = "cfg-check";
      inp.checked = !!node.value;
    } else if (node.type === "number") {
      inp = document.createElement("input");
      inp.type = "number";
      inp.className = "cfg-input";
      inp.value = String(node.value);
    } else if (node.type === "null") {
      inp = document.createElement("input");
      inp.type = "text";
      inp.className = "cfg-input";
      inp.value = "";
      inp.placeholder = "(null)";
    } else {
      inp = document.createElement("input");
      inp.type = "text";
      inp.className = "cfg-input";
      inp.value = node.value != null ? node.value : "";
    }
    inp.dataset.start = node.start;
    inp.dataset.end = node.end;
    inp.dataset.vtype = node.type;
    if (node.quote) inp.dataset.quote = node.quote;
    row.appendChild(inp);
    return row;
  }

  function lockIcon() {
    return '<span class="cfg-lock" title="参数名固定，不可修改">🔒</span>';
  }
  function lockChip(name) {
    return '<span class="cfg-key-chip" title="参数名固定，不可修改">🔒 ' + esc(name) + "</span>";
  }

  function collectConfigEdits(hostEl) {
    const root = hostEl || $("configEditor");
    const edits = [];
    // 注意：布尔复选框的类名是 .cfg-check（非 .cfg-input），必须一起收集，
    // 否则 enable 等布尔值永远不会出现在 edits 中，导致无法切换 true/false、提交到 GitHub 无变化。
    const inputs = root.querySelectorAll(".cfg-input, .cfg-check");
    inputs.forEach((inp) => {
      if (inp.disabled) return;
      const start = Number(inp.dataset.start);
      const end = Number(inp.dataset.end);
      const vtype = inp.dataset.vtype;
      const quote = inp.dataset.quote;
      let text;
      try {
        if (vtype === "boolean") text = inp.checked ? "true" : "false";
        else if (vtype === "null") text = inp.value.trim() === "" ? "null" : FireflyConfig.encodeValue("string", inp.value, quote);
        else if (vtype === "string") text = FireflyConfig.encodeValue("string", inp.value, quote || '"');
        else if (vtype === "number") {
          if (inp.value.trim() === "") throw new Error("数字不能为空");
          const n = Number(inp.value);
          if (isNaN(n)) throw new Error("数字格式错误：" + inp.value);
          text = String(n);
        } else text = inp.value;
      } catch (e) {
        throw new Error("参数 " + (inp.previousElementSibling ? inp.previousElementSibling.textContent : "") + " " + e.message);
      }
      edits.push({ start, end, text });
    });
    return edits;
  }

  function buildConfigContent() {
    const edits = collectConfigEdits();
    return FireflyConfig.applyConfigEdits(state.configRaw, edits);
  }

  // ----------------------------------------------------------------------
  // booknavConfig 列表化编辑（数组以列表展示，可自定义新增分组 / 书签）
  // ----------------------------------------------------------------------
  function nodeToJS(node) {
    if (!node || typeof node !== "object") return node;
    if (node.type === "object") {
      const o = {};
      (node.children || []).forEach((c) => { o[c.key] = nodeToJS(c.value); });
      return o;
    }
    if (node.type === "array") {
      return (node.children || []).map((c) => nodeToJS(c.value));
    }
    return node.value;
  }

  function findRoot(name) {
    return (state.configRoots || []).find((r) => r.name === name);
  }

  // 把原始 booknav 模型标准化（确保字段类型正确、icon 缺省为 ""）
  function normalizeBooknav(arr) {
    return (arr || []).map((g) => ({
      id: String(g.id != null ? g.id : ""),
      name: String(g.name != null ? g.name : ""),
      icon: String(g.icon != null ? g.icon : ""),
      desc: String(g.desc != null ? g.desc : ""),
      weight: Number(g.weight != null ? g.weight : 0),
      items: (g.items || []).map((it) => ({
        title: String(it.title != null ? it.title : ""),
        url: String(it.url != null ? it.url : ""),
        desc: String(it.desc != null ? it.desc : ""),
        icon: it.icon != null ? String(it.icon) : "",
        weight: Number(it.weight != null ? it.weight : 0),
      })),
    }));
  }

  // 把解析出的 booknavConfig 数组标准化为可编辑的 JS 模型
  function parseBooknavModel() {
    const root = findRoot("booknavConfig");
    if (!root) return [];
    return normalizeBooknav(nodeToJS(root.node));
  }

  function bnField(label, value, onChange, type) {
    const wrap = document.createElement("div");
    wrap.className = "bn-field";
    const lab = document.createElement("label");
    lab.textContent = label;
    const inp = document.createElement("input");
    inp.type = type || "text";
    inp.className = "cfg-input";
    inp.value = value != null ? value : "";
    inp.oninput = () => onChange(inp.value);
    wrap.appendChild(lab);
    wrap.appendChild(inp);
    return wrap;
  }

  function booknavItemCard(it, gi, ii, model, host) {
    const card = document.createElement("div");
    card.className = "bn-item";
    const head = document.createElement("div");
    head.className = "bn-item-head";
    head.innerHTML = '<span class="bn-i-title">书签</span>';
    const del = document.createElement("button");
    del.type = "button";
    del.className = "bn-del sm";
    del.textContent = "✕";
    del.title = "删除此书签";
    del.onclick = () => { model[gi].items.splice(ii, 1); renderBooknavEditor(host, model); };
    head.appendChild(del);
    card.appendChild(head);
    const fields = document.createElement("div");
    fields.className = "bn-fields";
    fields.appendChild(bnField("标题", it.title, (v) => (it.title = v)));
    fields.appendChild(bnField("链接 URL", it.url, (v) => (it.url = v)));
    fields.appendChild(bnField("描述", it.desc, (v) => (it.desc = v)));
    fields.appendChild(bnField("图标(可选)", it.icon != null ? it.icon : "", (v) => (it.icon = v)));
    fields.appendChild(bnField("权重", String(it.weight), (v) => (it.weight = Number(v) || 0), "number"));
    card.appendChild(fields);
    return card;
  }

  function booknavGroupCard(group, gi, model, host) {
    const card = document.createElement("div");
    card.className = "bn-group";
    const head = document.createElement("div");
    head.className = "bn-group-head";
    head.innerHTML = '<span class="bn-g-title">分组</span>';
    const del = document.createElement("button");
    del.type = "button";
    del.className = "bn-del";
    del.textContent = "🗑 删除分组";
    del.onclick = () => { model.splice(gi, 1); renderBooknavEditor(host, model); };
    head.appendChild(del);
    card.appendChild(head);

    const fields = document.createElement("div");
    fields.className = "bn-fields";
    fields.appendChild(bnField("分组ID", group.id, (v) => (group.id = v)));
    fields.appendChild(bnField("名称", group.name, (v) => (group.name = v)));
    fields.appendChild(bnField("图标(astro-icon)", group.icon, (v) => (group.icon = v)));
    fields.appendChild(bnField("描述", group.desc, (v) => (group.desc = v)));
    fields.appendChild(bnField("权重(weight)", String(group.weight), (v) => (group.weight = Number(v) || 0), "number"));
    card.appendChild(fields);

    const itemsWrap = document.createElement("div");
    itemsWrap.className = "bn-items";
    const itemsTitle = document.createElement("div");
    itemsTitle.className = "bn-items-title";
    itemsTitle.textContent = "书签 (" + group.items.length + ")";
    itemsWrap.appendChild(itemsTitle);
    group.items.forEach((it, ii) => itemsWrap.appendChild(booknavItemCard(it, gi, ii, model, host)));
    const addItem = document.createElement("button");
    addItem.type = "button";
    addItem.className = "bn-add-item";
    addItem.textContent = "＋ 添加书签";
    addItem.onclick = () => {
      group.items.push({ title: "新书签", url: "", desc: "", icon: "", weight: 10 });
      renderBooknavEditor(host, model);
    };
    itemsWrap.appendChild(addItem);
    card.appendChild(itemsWrap);
    return card;
  }

  // 渲染 booknav 列表编辑器；host / model 可外部传入（供站点外观 Tab 复用）
  function renderBooknavEditor(host, model) {
    host = host || $("configEditor");
    model = model || state.booknavModel || [];
    host.innerHTML = "";
    if (!model.length) host.innerHTML = '<div class="cfg-empty">暂无书签分组。点击下方「添加分组」创建。</div>';
    model.forEach((group, gi) => host.appendChild(booknavGroupCard(group, gi, model, host)));
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "bn-add-group";
    addBtn.textContent = "＋ 添加分组";
    addBtn.onclick = () => {
      model.push({ id: "group" + (model.length + 1), name: "新分组", icon: "", desc: "", weight: 50, items: [] });
      renderBooknavEditor(host, model);
    };
    host.appendChild(addBtn);
  }

  function bnQuote(s) {
    return FireflyConfig.encodeValue("string", s != null ? s : "", '"');
  }

  // 把分组模型序列化回 Firefly 风格的 TS 数组文本（与原文件缩进一致：Tab）
  function serializeBooknav(groups) {
    const T = "\t";
    const lines = ["["];
    (groups || []).forEach((g) => {
      lines.push(T + "{");
      lines.push(T + T + "id: " + bnQuote(g.id) + ",");
      lines.push(T + T + "name: " + bnQuote(g.name) + ",");
      lines.push(T + T + "icon: " + bnQuote(g.icon) + ",");
      lines.push(T + T + "desc: " + bnQuote(g.desc) + ",");
      lines.push(T + T + "weight: " + (Number(g.weight) || 0) + ",");
      lines.push(T + T + "items: [");
      (g.items || []).forEach((it) => {
        lines.push(T + T + T + "{");
        lines.push(T + T + T + T + "title: " + bnQuote(it.title) + ",");
        lines.push(T + T + T + T + "url: " + bnQuote(it.url) + ",");
        lines.push(T + T + T + T + "desc: " + bnQuote(it.desc) + ",");
        if (it.icon != null && it.icon !== "") lines.push(T + T + T + T + "icon: " + bnQuote(it.icon) + ",");
        lines.push(T + T + T + T + "weight: " + (Number(it.weight) || 0) + ",");
        lines.push(T + T + T + "},");
      });
      lines.push(T + T + "]");
      lines.push(T + "},");
    });
    lines.push("]");
    return lines.join("\n");
  }

  // 整体替换 booknavConfig 的数组文本（基于解析偏移量，保留其上方的导出语句与注释）
  function buildBooknavContent() {
    const root = findRoot("booknavConfig");
    if (!root) return state.configRaw;
    const arrText = serializeBooknav(state.booknavModel || []);
    return state.configRaw.slice(0, root.node.start) + arrText + state.configRaw.slice(root.node.end);
  }

  // ----------------------------------------------------------------------
  // 模式切换（富文本 / 源代码）
  // ----------------------------------------------------------------------
  function setModeButtons(mode) {
    $("modeRich").classList.toggle("active", mode === "rich");
    $("modeRaw").classList.toggle("active", mode === "raw");
  }

  // 含裸 HTML 的帖子强制 Markdown 模式，按钮文案同步为「Markdown」，避免误导
  function updateModeLabel() {
    const btn = $("modeRich");
    if (btn) btn.textContent = state.forceMarkdown ? "Markdown" : "富文本";
  }

  function applyMode(mode) {
    if (state.plainRaw) return; // 纯文本配置文件无富文本/源代码切换
    if (state.configStruct) return; // 结构化配置无富文本/源代码切换（键名锁定）
    if (mode === "raw") {
      $("rawEditor").value = buildContent(); // 基于当前富文本状态构建整文件
      showOnlyEditor("raw");
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
      showOnlyEditor("main");
      window.dispatchEvent(new Event("resize"));
    }
    state.mode = mode;
    setModeButtons(mode);
    updateModeLabel();
  }

  // ----------------------------------------------------------------------
  // 构建文件内容
  // ----------------------------------------------------------------------
  function buildContent() {
    if (state.booknavMode) return buildBooknavContent();
    if (state.configStruct) return buildConfigContent();
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
    let content;
    try {
      content = buildContent();
    } catch (e) {
      setStatus(e.message || "内容构建失败", "err");
      return;
    }
    let path;
    if (state.current.isNew) {
      const base = ($("fileName").value || "").trim();
      const ext = ($("extSelect").value || "").trim();
      const fname = base + ext;
      if (!base) { setStatus("请填写文件名", "err"); return; }
      // 配置文件（如 FooterConfig.html / .ts）允许任意扩展名，内容类仍需 .md/.mdx
      if (state.type !== "config" && !/\.(md|mdx)$/i.test(fname)) {
        setStatus("文件名需以 .md 或 .mdx 结尾", "err");
        return;
      }
      const root = state.type === "config" ? "src/config" : CONTENT_ROOT + "/" + state.type;
      path = root + (state.subdir ? "/" + state.subdir : "") + "/" + fname;
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
        state.current.name = ($("fileName").value || "").trim() + ($("extSelect").value || "").trim();
        $("deleteBtn").hidden = false;
        $("fileName").readOnly = true;
        $("extSelect").disabled = true;
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

  // 切换右侧三视图之一：content（内容列表）/ editor（编辑器）/ appearance（站点外观）
  function showView(name) {
    $("contentView").hidden = name !== "content";
    $("editorPane").hidden = name !== "editor";
    $("appearanceView").hidden = name !== "appearance";
  }

  function backToEmpty() {
    state.current = null;
    state.selected.clear();
    $("editForm").hidden = true;
    $("emptyState").hidden = true;
    showView("content");
    updateBatchCount();
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
  // 图片预览灯箱（列表中的图片点击后查看，而非打开编辑器）
  // ----------------------------------------------------------------------
  function openImagePreview(path, name) {
    const url = rawUrl(path);
    const overlay = document.createElement("div");
    overlay.className = "img-preview-overlay";
    overlay.innerHTML =
      '<div class="img-preview-card" role="dialog" aria-modal="true">' +
        '<div class="img-preview-head"><span class="img-preview-name">' + esc(name) + '</span>' +
        '<button class="img-preview-close" type="button" title="关闭">✕</button></div>' +
        '<div class="img-preview-body"><img class="img-preview-img" src="' + esc(url) + '" alt="' + esc(name) + '" /></div>' +
        '<div class="img-preview-actions">' +
          '<a class="btn ghost sm" href="' + esc(url) + '" target="_blank" rel="noopener">新窗口打开</a>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    function close() { overlay.remove(); document.removeEventListener("keydown", onKey); }
    function onKey(e) { if (e.key === "Escape") close(); }
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    overlay.querySelector(".img-preview-close").addEventListener("click", close);
    document.addEventListener("keydown", onKey);
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

  // 构建右键 / 操作表的菜单项（桌面右键与移动端「⋯」共用）；配置类禁重命名/删除
  function ctxItemsFor(item) {
    const isDir = item.type === "dir";
    const items = [];
    if (isDir) {
      items.push({ label: "📂 进入目录", action: () => navigate(item) });
      items.push({ label: "⬆️ 上传到此目录", action: () => triggerUpload(dirForUpload(item.path)) });
    }
    if (!isDir) items.push({ label: "✏️ 编辑", action: () => openFile(item) });
    if (canModify()) {
      if (!isDir) items.push({ label: "✏️ 重命名", action: () => renameItem(item) });
      items.push({ label: "🗑 删除", danger: true, action: () => removeItem(item) });
    }
    return items;
  }

  function onItemContext(e, item) {
    e.preventDefault();
    openCtx(e.clientX, e.clientY, ctxItemsFor(item));
  }

  // 移动端底部操作表（替代长按右键菜单，点击更方便）
  function closeActionSheet() {
    const s = document.querySelector(".action-sheet");
    if (s) s.remove();
  }
  function openActionSheet(item) {
    closeActionSheet();
    const items = ctxItemsFor(item);
    const sheet = document.createElement("div");
    sheet.className = "action-sheet";
    sheet.innerHTML =
      '<div class="as-backdrop"></div>' +
      '<div class="as-panel" role="dialog" aria-modal="true">' +
        '<div class="as-title">' + esc(item.name) + "</div>" +
        items.map((it, i) => '<button type="button" class="as-item' + (it.danger ? " danger" : "") + '" data-i="' + i + '">' + esc(it.label) + "</button>").join("") +
        '<button type="button" class="as-cancel">取消</button>' +
      "</div>";
    document.body.appendChild(sheet);
    sheet.querySelector(".as-backdrop").onclick = closeActionSheet;
    sheet.querySelector(".as-cancel").onclick = closeActionSheet;
    sheet.querySelectorAll(".as-item").forEach((b) => {
      b.onclick = () => {
        const it = items[Number(b.dataset.i)];
        closeActionSheet();
        it.action();
      };
    });
    // 阻止面板内点击冒泡到 backdrop 之外
    sheet.querySelector(".as-panel").addEventListener("click", (e) => e.stopPropagation());
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

  // 真正执行删除（无确认弹窗），供单条删除与批量删除复用
  async function doRemove(item) {
    try {
      const { status, data } = await api("/api/remove", {
        method: "POST",
        body: JSON.stringify({ path: item.path, isDir: item.type === "dir" }),
      });
      return status === 200 && data && data.ok;
    } catch (e) {
      toast(e.message || "删除失败", "err");
      return false;
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
    if (await doRemove(item)) {
      toast("已删除");
      if (state.current && state.current.path && state.current.path.startsWith(item.path)) backToEmpty();
    }
    await loadList();
  }

  // 批量删除：删除已勾选的内容（重命名/删除仅对文章/动态/单页有效，配置不在可选范围内）
  async function batchDelete() {
    const paths = [...state.selected];
    if (!paths.length) { toast("请先勾选要删除的内容", "err"); return; }
    const ok = await openModal({
      title: "批量删除确认",
      html: "<div class=\"modal-msg\">确定删除选中的 <b>" + paths.length + "</b> 项内容？<br>此操作会提交到 GitHub，不可撤销。</div>",
      confirmText: "删除",
      danger: true,
    });
    if (!ok) return;
    let done = 0;
    for (const p of paths) {
      const item = state.files.find((f) => f.path === p);
      if (item && (await doRemove(item))) done++;
    }
    state.selected.clear();
    toast("已删除 " + done + " 项内容");
    await loadList();
  }

  // 更新批量相关 UI：全选状态、按钮计数、可见性（配置类隐藏）
  function updateBatchCount() {
    const n = state.selected.size;
    const all = $("selectAll");
    if (all) all.checked = n > 0 && state.selectableCount > 0 && n === state.selectableCount;
    const bd = $("batchDelBtn");
    if (bd) bd.textContent = n > 0 ? "🗑 批量删除 (" + n + ")" : "🗑 批量删除";
  }

  // 在当前板块 / 子目录下新建分类（文件夹）。GitHub 无空目录对象，用 .gitkeep 占位文件创建。
  async function newCategory() {
    const name = await openModal({
      title: "新建分类 / 目录",
      input: "",
      placeholder: "目录名称，如 news 或 产品",
      confirmText: "创建",
      hint: "将在当前位置创建该分类文件夹。",
    });
    if (!name) return;
    const safe = name.trim().replace(/[^\w.\-\u4e00-\u9fa5]+/g, "-").replace(/^-+|-+$/g, "");
    if (!safe) { toast("目录名称无效", "err"); return; }
    const base = state.type === "config" ? "src/config" : "src/content/" + state.type;
    const p = base + (state.subdir ? "/" + state.subdir : "") + "/" + safe;
    try {
      const { status, data } = await api("/api/mkdir", {
        method: "POST",
        body: JSON.stringify({ path: p }),
      });
      if (status === 200 && data && data.ok) {
        toast("已创建分类：" + safe);
        await loadList();
      } else {
        toast((data && data.error) || "创建失败", "err");
      }
    } catch (e) {
      toast(e.message || "创建失败", "err");
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
  // 切换板块：左侧导航选中，右侧显示对应视图（内容列表 / 站点外观）
  function selectSection(type) {
    state.type = type;
    state.subdir = "";
    document.querySelectorAll("#navBar .nav-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.type === type);
    });
    const titles = { posts: "文章", dynamic: "动态", spec: "单页", config: "配置", appearance: "站点外观" };
    $("ctTitle").textContent = titles[type] || type;
    // 配置类：禁止批量删除与全选（重命名/删除仅对文章/动态/单页有效）
    const isConfig = type === "config";
    $("selectAllRow").hidden = isConfig;
    $("batchDelBtn").hidden = isConfig;

    state.selected.clear();

    if (type === "appearance") {
      showView("appearance");
      loadAppearance();
      // 动态从 GitHub 拉取 src/config 下全部 .ts，生成配置 Tab 与编辑面板（不再写死）
      loadApTabs();
      selectApTab("logo");
      return;
    }
    showView("content");
    backToEmpty();
    loadList();
  }

  // ----------------------------------------------------------------------
  // 站点外观：Logo / 头像替换 + 常用配置快捷入口
  // ----------------------------------------------------------------------
  // 仓库原始文件直链（用于预览当前 Logo / 头像）
  function rawUrl(p) {
    const branch = state.branch || "master";
    return `https://raw.githubusercontent.com/${state.owner}/${state.repo}/${branch}/${p}`;
  }

  // 资源落点：logo 深/浅两套在 src/assets/images/logo，头像在 src/assets/images
  function assetTarget(asset) {
    if (asset === "logo-dark") return { dir: "src/assets/images/logo", name: "firefly-dark.png" };
    if (asset === "logo-light") return { dir: "src/assets/images/logo", name: "firefly-light.png" };
    if (asset === "avatar") return { dir: "src/assets/images", name: "avatar.webp" };
    return null;
  }
  function previewElFor(asset) {
    if (asset === "logo-dark") return "prevLogoDark";
    if (asset === "logo-light") return "prevLogoLight";
    if (asset === "avatar") return "prevAvatar";
    return null;
  }
  function assetPath(asset) {
    if (asset === "logo-dark") return "src/assets/images/logo/firefly-dark.png";
    if (asset === "logo-light") return "src/assets/images/logo/firefly-light.png";
    if (asset === "avatar") return "src/assets/images/avatar.webp";
    return null;
  }

  function loadAppearance() {
    const setPrev = (id, p) => {
      const img = $(id);
      if (!img) return;
      img.onerror = () => {
        img.style.display = "none";
        const ph = document.createElement("span");
        ph.textContent = "🖼️";
        ph.style.fontSize = "30px";
        img.parentNode.appendChild(ph);
      };
      img.style.display = "";
      img.src = rawUrl(p) + "?v=" + Date.now();
    };
    setPrev("prevLogoDark", "src/assets/images/logo/firefly-dark.png");
    setPrev("prevLogoLight", "src/assets/images/logo/firefly-light.png");
    setPrev("prevAvatar", "src/assets/images/avatar.webp");
  }

  // ----------------------------------------------------------------------
  // 站点外观：常用配置以顶部 Tab 形式切换（内联编辑，避免跳转）
  // ----------------------------------------------------------------------
  const apState = {}; // name(去 .ts) -> { raw, sha, roots, booknavModel, loaded }

  function apHostFor(name) {
    const pane = document.querySelector('.ap-pane[data-pane="' + name + '"]');
    return pane ? pane.querySelector(".ap-cfg-host") : null;
  }
  function apStatusFor(name) {
    const pane = document.querySelector('.ap-pane[data-pane="' + name + '"]');
    return pane ? pane.querySelector(".ap-pane-status") : null;
  }
  function apPaneName(btn) {
    return (btn.dataset.save || "").replace(/\.ts$/, "");
  }

  function selectApTab(name) {
    document.querySelectorAll("#apTabs .ap-tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
    document.querySelectorAll("#apBody .ap-pane").forEach((p) => { p.hidden = p.dataset.pane !== name; });
    if (name !== "logo" && name !== "avatar") loadApConfig(name);
  }

  // 动态生成站点外观的配置 Tab：从 GitHub 拉取 src/config 下全部 .ts（排除 index.ts），
  // 按常用顺序排序后生成 Tab 与对应编辑面板，复用 loadApConfig / renderApConfig / saveApConfig。
  async function loadApTabs() {
    const holder = $("apConfigPanes");
    const tabsEl = $("apTabs");
    if (!holder || !tabsEl) return;
    holder.innerHTML = "";
    let items = [];
    try {
      const { data } = await api("/api/list?type=config");
      items = (data.items || []).filter((f) => f.name.endsWith(".ts") && f.name !== "index.ts");
    } catch (e) { /* 忽略：仅展示资源 Tab */ }
    // 常用顺序靠前；其余按文件名
    const order = ["profileConfig", "backgroundWallpaper", "booknavConfig", "announcementConfig", "sponsorConfig", "sidebarConfig"];
    items.sort((a, b) => {
      const ia = order.indexOf(a.name.replace(/\.ts$/, ""));
      const ib = order.indexOf(b.name.replace(/\.ts$/, ""));
      const wa = ia === -1 ? order.length : ia;
      const wb = ib === -1 ? order.length : ib;
      return wa - wb;
    });
    items.forEach((f) => {
      const name = f.name.replace(/\.ts$/, "");
      const label = CONFIG_NAME_MAP[f.name] || name;
      const tab = document.createElement("button");
      tab.className = "ap-tab";
      tab.type = "button";
      tab.dataset.tab = name;
      tab.textContent = label;
      tabsEl.appendChild(tab);
      const pane = document.createElement("div");
      pane.className = "ap-pane ap-config-pane";
      pane.dataset.pane = name;
      pane.hidden = true;
      pane.innerHTML =
        '<div class="ap-pane-head"><span class="ap-pane-title">' + esc(label) + " · " + esc(name) + '</span>' +
        '<button class="btn primary sm ap-save" type="button" data-save="' + esc(f.name) + '">💾 保存</button></div>' +
        '<div class="ap-cfg-host config-editor"></div>' +
        '<div class="ap-pane-status" data-status="' + esc(f.name) + '"></div>';
      holder.appendChild(pane);
    });
  }

  async function loadApConfig(name) {
    if (apState[name] && apState[name].loaded) return;
    const host = apHostFor(name);
    if (!host) return;
    host.innerHTML = '<div class="cfg-empty">加载中…</div>';
    const path = "src/config/" + name + ".ts";
    try {
      const { status, data } = await api("/api/file?path=" + encodeURIComponent(path));
      if (status !== 200 || data.content == null) {
        host.innerHTML = '<div class="cfg-empty">未找到 ' + esc(name) + ".ts</div>";
        return;
      }
      const parsed = FireflyConfig.parseConfig(data.content);
      const st = { raw: data.content, sha: data.sha, roots: parsed.roots, name: name, loaded: true };
      if (name === "booknavConfig") st.booknavModel = normalizeBooknav(nodeToJS((parsed.roots.find((r) => r.name === "booknavConfig") || { node: { type: "array", children: [] } }).node));
      apState[name] = st;
      renderApConfig(name);
    } catch (e) {
      host.innerHTML = '<div class="cfg-empty">加载失败：' + esc(e.message || "") + "</div>";
    }
  }

  function renderApConfig(name) {
    const st = apState[name];
    const host = apHostFor(name);
    if (!st || !host) return;
    if (name === "booknavConfig") renderBooknavEditor(host, st.booknavModel);
    else renderGenericConfig(host, st.roots);
  }

  // 通用配置渲染（供站点外观 Tab 与编辑器复用），渲染到指定 host
  function renderGenericConfig(host, roots) {
    host.innerHTML = "";
    if (!roots || !roots.length) {
      host.innerHTML = '<div class="cfg-empty">该配置文件无可结构化编辑的参数。</div>';
      return;
    }
    roots.forEach((r) => {
      const sec = document.createElement("div");
      sec.className = "cfg-section";
      const head = document.createElement("div");
      head.className = "cfg-section-head";
      const titleText = r.comment ? esc(r.comment) : esc(r.name);
      const varChip = r.comment ? '<span class="cfg-key-chip" title="变量名固定，不可修改">🔒 ' + esc(r.name) + "</span>" : "";
      head.innerHTML =
        '<span class="cfg-lock" title="变量名固定，不可修改">🔒</span>' +
        '<span class="cfg-var">' + titleText + "</span>" + varChip +
        '<span class="cfg-hint">变量名固定 · 仅可修改值</span>';
      sec.appendChild(head);
      if (r.node.type === "object" && r.node.children && r.node.children.length) {
        r.node.children.forEach((ch) => sec.appendChild(cfgNodeEl(ch.value, ch.key, 0)));
      } else {
        sec.appendChild(cfgNodeEl(r.node, r.name, 0));
      }
      host.appendChild(sec);
    });
  }

  async function saveApConfig(name) {
    const st = apState[name];
    const host = apHostFor(name);
    const statusEl = apStatusFor(name);
    if (!st || !host) return;
    let content;
    try {
      if (name === "booknavConfig") {
        const root = st.roots.find((r) => r.name === "booknavConfig");
        if (!root) throw new Error("未找到 booknavConfig");
        const arrText = serializeBooknav(st.booknavModel || []);
        content = st.raw.slice(0, root.node.start) + arrText + st.raw.slice(root.node.end);
      } else {
        const edits = collectConfigEdits(host);
        content = FireflyConfig.applyConfigEdits(st.raw, edits);
      }
    } catch (e) {
      if (statusEl) { statusEl.textContent = e.message || "内容构建失败"; statusEl.className = "ap-pane-status err"; }
      return;
    }
    const payload = {
      path: "src/config/" + name + ".ts",
      content,
      sha: st.sha || undefined,
      message: "Update " + name + ".ts via FireflyCMS",
    };
    try {
      const { status, data } = await api("/api/file", { method: "PUT", body: JSON.stringify(payload) });
      if (status === 200 || status === 201) {
        st.sha = data.sha || st.sha;
        if (statusEl) { statusEl.textContent = "✅ 已保存，GitHub 将自动重新部署"; statusEl.className = "ap-pane-status ok"; }
        toast("保存成功");
      } else {
        if (statusEl) { statusEl.textContent = (data && (data.error || data.message)) || "保存失败"; statusEl.className = "ap-pane-status err"; }
      }
    } catch (e) {
      if (statusEl) { statusEl.textContent = e.message || "保存失败"; statusEl.className = "ap-pane-status err"; }
    }
  }

  function uploadAsset(asset, file) {
    if (!file) return;
    const t = assetTarget(asset);
    if (!t) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const content = reader.result; // data URL
        const { status, data } = await api("/api/upload", {
          method: "POST",
          body: { name: t.name, content, dir: t.dir, message: "Update " + t.name + " via Firefly-Admin" },
        });
        if (status >= 300) {
          toast("上传失败：" + ((data && data.error) || ""), "err");
          return;
        }
        // 刷新预览（带缓存破坏参数，确保看到新图）
        const imgId = previewElFor(asset);
        const p = assetPath(asset);
        const img = imgId ? $(imgId) : null;
        if (img && p) {
          img.style.display = "";
          img.onerror = null;
          img.src = rawUrl(p) + "?v=" + Date.now();
        }
        toast("已更新 " + t.name, "ok");
      } catch (e) {
        toast(e.message || "上传失败", "err");
      }
    };
    reader.readAsDataURL(file);
  }

  // 打开常用配置文件；若文件不存在（如 sponsorConfig.ts）则创建默认内容后打开
  async function openConfigByPath(path, name) {
    state.type = "config"; // 以配置类型打开，确保编辑器按 .ts 结构化渲染
    state.subdir = "";
    document.querySelectorAll("#navBar .nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.type === "config"));
    $("ctTitle").textContent = "配置";
    const { status, data } = await api("/api/file?path=" + encodeURIComponent(path));
    if (status === 200 && data.content != null) {
      await openFile({ name, path, type: "file", sha: data.sha });
      return;
    }
    const def = defaultConfigFor(name);
    if (def == null) {
      toast("无法打开 " + name, "err");
      return;
    }
    const r = await api("/api/file", {
      method: "POST",
      body: { path, content: def, message: "Create " + name + " via Firefly-Admin" },
    });
    if (r.status >= 300) {
      toast("创建失败：" + ((r.data && r.data.error) || ""), "err");
      return;
    }
    await openFile({ name, path, type: "file", sha: r.data && r.data.sha });
    toast("已创建 " + name + "，编辑后点「保存」即可生效", "ok");
  }

  // 缺失配置文件的默认内容（仅当文件不存在时用于创建，均为合法 TS）
  function defaultConfigFor(name) {
    if (name === "sponsorConfig.ts") {
      return [
        "// 赞助设置",
        "export const sponsorConfig = {",
        "  // 赞助方式列表",
        "  sponsors: [",
        "    {",
        "      // 名称",
        "      name: \"支付宝\",",
        "      // 跳转链接",
        "      link: \"\",",
        "      // 图标（emoji 或图片地址）",
        "      icon: \"💰\",",
        "      // 二维码图片地址",
        "      qrcode: \"\",",
        "    },",
        "    {",
        "      name: \"微信\",",
        "      link: \"\",",
        "      icon: \"💚\",",
        "      qrcode: \"\",",
        "    },",
        "  ],",
        "};",
        "",
      ].join("\n");
    }
    return null;
  }

  let bound = false;
  function bindEvents() {
    if (bound) return;
    bound = true;
    const on = (id, prop, fn) => {
      const el = $(id);
      if (el) el[prop] = fn;
    };

    // 左侧导航栏：点击切换板块（文章 / 动态 / 单页 / 配置 / 站点外观）
    const navBar = $("navBar");
    if (navBar) {
      navBar.querySelectorAll(".nav-btn").forEach((b) => {
        b.addEventListener("click", () => {
          const type = b.dataset.type;
          if (!type || state.type === type) return; // 已是当前板块，不重复加载
          selectSection(type);
        });
      });
    }

    // 批量删除：删除已勾选的内容
    on("batchDelBtn", "onclick", batchDelete);
    // 全选：勾选 / 取消当前列表所有可修改条目
    const sa = $("selectAll");
    if (sa) sa.onchange = () => {
      const checked = sa.checked;
      document.querySelectorAll("#fileList .fi-check").forEach((cb) => {
        cb.checked = checked;
        const p = cb.dataset.path;
        if (checked) state.selected.add(p);
        else state.selected.delete(p);
      });
      updateBatchCount();
    };

    on("searchInput", "oninput", renderList);
    on("refreshBtn", "onclick", loadList);
    on("newBtn", "onclick", newFile);
    on("newCatBtn", "onclick", newCategory);
    on("quickUploadBtn", "onclick", () => { const fi = $("fileInput"); if (fi) fi.click(); });
    // 新建文件时切换后缀：重设编辑器模式（保留草稿内容）
    on("extSelect", "onchange", () => { if (state.current && state.current.isNew) enterNewFile(); });
    on("saveBtn", "onclick", saveFile);
    on("deleteBtn", "onclick", deleteFile);
    on("backBtn", "onclick", backToEmpty);
    on("logoutBtn", "onclick", async () => {
      // 与删除一致：先确认再执行
      const ok = await openModal({
        title: "退出登录",
        html: "确定要退出当前账号吗？退出后需重新登录才能管理站点。",
        confirmText: "退出登录",
        danger: true,
      });
      if (!ok) return;
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

    // 站点外观：更换按钮 -> 触发对应 file input
    document.querySelectorAll(".ap-btn").forEach((b) => {
      b.addEventListener("click", () => {
        const asset = b.dataset.pick;
        const fi = document.querySelector('.ap-file[data-asset="' + asset + '"]');
        if (fi) fi.click();
      });
    });
    // 站点外观：选择图片后上传到对应资源路径
    document.querySelectorAll(".ap-file").forEach((fi) => {
      fi.addEventListener("change", () => {
        const asset = fi.dataset.asset;
        if (fi.files && fi.files[0]) uploadAsset(asset, fi.files[0]);
        fi.value = "";
      });
    });
    // 站点外观：Tab 切换（含动态生成的配置 Tab，用事件委托）
    const apTabsEl = $("apTabs");
    if (apTabsEl) apTabsEl.addEventListener("click", (e) => {
      const b = e.target.closest(".ap-tab");
      if (b) selectApTab(b.dataset.tab);
    });
    // 站点外观：保存按钮（含动态生成的配置 pane，用事件委托）
    const apBodyEl = $("apBody");
    if (apBodyEl) apBodyEl.addEventListener("click", (e) => {
      const b = e.target.closest(".ap-save");
      if (b) saveApConfig(apPaneName(b));
    });

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
