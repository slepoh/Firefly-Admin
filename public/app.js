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
    "mermaidConfig.ts": "Mermaid图表配置",
    "displaySettingsConfig.ts": "显示设置面板配置",
    "booknavConfig.ts": "书签导航配置",
    "FooterConfig.html": "页脚内容",
  };
  const SPEC_NAME_MAP = {
    "about.md": "关于我",
    "friends.mdx": "友链",
    "guestbook.md": "留言页",
  };
  // 站点外观 Tab 显示名（比配置列表名更短，去掉「配置」后缀）
  const AP_NAME_MAP = {
    "booknavConfig": "书签导航",
    "displaySettingsConfig": "显示设置面板",
  };

  // 字段级枚举下拉覆盖表（key 为「文件名」→「从根 const 名起的完整路径」）。
  // 优先级高于注释自动识别的 detectEnum。value 可为字符串数组（value 即 label），
  // 或为 { custom:true, options:[[value,label],...] } 以支持「下拉 + 自定义输入」。
  const CONFIG_FIELD_ENUMS = {
    mermaidConfig: {
      "mermaidConfig.lightTheme": ["editor-light", "gruvbox-light", "ayu-light"],
      "mermaidConfig.darkTheme": ["editor-dark", "one-dark", "gruvbox-dark", "ayu-dark"],
    },
    pioConfig: {
      "spineModelConfig.position.corner": ["bottom-left", "bottom-right", "top-left", "top-right"],
      "live2dWidgetConfig.position": ["bottom-left", "bottom-right", "top-left", "top-right"],
    },
    sidebarConfig: {
      "sidebarLayoutConfig.position": ["left", "right", "both"],
      "sidebarLayoutConfig.tabletSidebar": ["left", "right"],
    },
    siteConfig: {
      "SITE_LANG": {
        custom: true,
        options: [
          ["zh_CN", "简体中文"],
          ["zh_TW", "繁體中文"],
          ["en", "English"],
          ["ja", "日本語"],
          ["ru", "Русский"],
          ["ko", "한국어"],
        ],
      },
      "siteConfig.post.rehypeCallouts.theme": ["github", "obsidian", "vitepress", "docusaurus"],
      "siteConfig.navbar.menuAlign": ["left", "center"],
    },
  };

  // 仅以下「标量字符串数组」支持列表式增删（整段重序列化）。
  // 其余标量数组仅可逐项编辑，不再显示「添加/删除一项」按钮（避免误以为所有数组都能增删）。
  const SCALAR_ARRAY_ADDABLE = new Set([
    "siteConfig.keywords",
    "backgroundWallpaper.src.desktop",
    "backgroundWallpaper.src.mobile",
    "backgroundWallpaper.common.homeText.subtitle",
    "spineModelConfig.interactive.clickMessages",
    "coverImageConfig.randomCoverImage.apis",
  ]);

  // 仅以下「对象数组」支持整块增删（每个对象是重复结构，应作为一个整体添加/删除，而非只加一个字段）。
  // key 为从根 const 名起的完整路径；value 为该对象字段的渲染 schema（按顺序渲染卡片）。
  // type: string | number | boolean | string[]（逗号分隔，序列化回字符串数组）。
  const OBJ_ARRAY_SCHEMAS = {
    "profileConfig.links": [
      { key: "name", type: "string" },
      { key: "icon", type: "string" },
      { key: "url", type: "string" },
      { key: "showName", type: "boolean" },
    ],
    "sponsorConfig.sponsors": [
      { key: "name", type: "string" },
      { key: "avatar", type: "string" },
      { key: "amount", type: "string" },
      { key: "date", type: "string" },
    ],
    "friendsConfig": [
      { key: "title", type: "string" },
      { key: "imgurl", type: "string" },
      { key: "desc", type: "string" },
      { key: "siteurl", type: "string" },
      { key: "tags", type: "string[]" },
      { key: "weight", type: "number" },
      { key: "enabled", type: "boolean" },
    ],
    "galleryConfig.albums": [
      { key: "id", type: "string" },
      { key: "name", type: "string" },
      { key: "description", type: "string" },
      { key: "location", type: "string" },
      { key: "date", type: "string" },
      { key: "tags", type: "string[]" },
      { key: "password", type: "string" },
      { key: "passwordHint", type: "string" },
    ],
    "musicPlayerConfig.local.playlist": [
      { key: "name", type: "string" },
      { key: "artist", type: "string" },
      { key: "url", type: "string" },
      { key: "cover", type: "string" },
      { key: "lrc", type: "string" },
    ],
  };
  // 渲染通用配置时临时持有源码（用于标量数组整段重序列化时还原缩进）
  let cfgRawSrc = "";

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
      .filter((f) => !(state.type === "config" && f.name === "index.ts"))
      // 文章板块隐藏子目录（images / guide 等），这些统一由「图库」集中管理
      .filter((f) => !(state.type === "posts" && f.type === "dir"));
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
        // 文字包入 .fi-act-label，移动端隐藏文字仅留图标，避免遮挡文件名
        let actions = `<button class="fi-act edit" type="button" data-act="edit" title="编辑">✏️<span class="fi-act-label">编辑</span></button>`;
        if (modifiable) {
          if (!isDir) actions += `<button class="fi-act" type="button" data-act="rename" title="重命名">🏷️<span class="fi-act-label">重命名</span></button>`;
          actions += `<button class="fi-act danger" type="button" data-act="delete" title="删除">🗑<span class="fi-act-label">删除</span></button>`;
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

  // 刷新当前列表：文章/动态/单页走 loadList，图库走 loadGallery
  function refreshCurrent() {
    if (state.type === "gallery") loadGallery();
    else loadList();
  }

  // 图库：集中展示 src/content/posts 下所有子目录（images / guide 等）的资源
  async function loadGallery() {
    const IMG_RE = /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i;
    try {
      state.files = []; // 重置：图库项也纳入 state.files，供批量删除按 path 查找
      const { data } = await api("/api/list?type=posts");
      const top = data.items || [];
      const dirs = top.filter((f) => f.type === "dir");
      const groups = [];
      // 根目录下的非文章文件（如零散图片）归入「根目录」分组，避免被隐藏
      const rootFiles = top.filter((f) => f.type !== "dir" && !/\.(md|mdx)$/i.test(f.name));
      if (rootFiles.length) groups.push({ name: "根目录", items: rootFiles, root: true });
      for (const d of dirs) {
        try {
          const r = await api("/api/list?type=posts&path=" + encodeURIComponent(d.name));
          groups.push({ name: d.name, items: r.data.items || [], root: false });
        } catch (e) {
          groups.push({ name: d.name, items: [], root: false, error: true });
        }
      }
      renderGallery(groups, IMG_RE);
    } catch (e) {
      toast(e.message || "加载图库失败", "err");
    }
  }

  function renderGallery(groups, IMG_RE) {
    const box = $("fileList");
    box.innerHTML = "";
    state.selectableCount = 0;
    if (!groups.length) {
      box.innerHTML = '<div class="gallery-empty">图库为空（src/content/posts 下暂无子目录或资源）</div>';
      updateBatchCount();
      return;
    }
    const kw = ($("searchInput").value || "").toLowerCase();
    groups.forEach((g) => {
      const items = (g.items || []).filter((f) => f.name.toLowerCase().includes(kw));
      const title = document.createElement("div");
      title.className = "gallery-group-title";
      title.innerHTML =
        "<span>📁</span><span>" + esc(g.name) + "</span>" +
        '<span class="gg-count">' + (g.error ? "加载失败" : items.length + " 项") + "</span>";
      // 非根目录分组：提供「删除整个分类」按钮
      if (!g.root) {
        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "gallery-group-del";
        delBtn.title = "删除整个分类目录";
        delBtn.textContent = "🗑 删除分类";
        delBtn.onclick = () => removeItem({ name: g.name, path: "src/content/posts/" + g.name, type: "dir" });
        title.appendChild(delBtn);
      }
      box.appendChild(title);
      if (g.error) {
        const err = document.createElement("div");
        err.className = "gallery-group-empty";
        err.textContent = "该目录读取失败，请重试。";
        box.appendChild(err);
        return;
      }
      if (!items.length) {
        const empty = document.createElement("div");
        empty.className = "gallery-group-empty";
        empty.textContent = "（空）";
        box.appendChild(empty);
        return;
      }
      const imgs = items.filter((f) => IMG_RE.test(f.name));
      const docs = items.filter((f) => !IMG_RE.test(f.name));
      if (imgs.length) {
        const grid = document.createElement("div");
        grid.className = "img-grid";
        imgs.forEach((f) => {
          const card = document.createElement("div");
          card.className = "img-card";
          const thumb = document.createElement("img");
          thumb.className = "img-thumb";
          thumb.loading = "lazy";
          thumb.src = rawUrl(f.path);
          thumb.alt = f.name;
          thumb.onerror = () => { thumb.alt = "🖼️"; thumb.classList.add("img-thumb--err"); };
          const cap = document.createElement("div");
          cap.className = "img-cap";
          cap.textContent = f.name;
          const meta = document.createElement("div");
          meta.className = "img-meta";
          meta.textContent = (fmtSize(f.size) ? fmtSize(f.size) + " · " : "") + f.name;
          // 勾选框（批量删除用）+ 删除按钮
          const chk = document.createElement("input");
          chk.type = "checkbox"; chk.className = "fi-check gallery-chk"; chk.dataset.path = f.path;
          if (state.selected.has(f.path)) chk.checked = true;
          // 阻止冒泡：勾选框只做选择，不触发卡片的图片预览
          chk.onclick = (ev) => ev.stopPropagation();
          chk.onchange = () => { if (chk.checked) state.selected.add(f.path); else state.selected.delete(f.path); updateBatchCount(); };
          const del = document.createElement("button");
          del.type = "button"; del.className = "gallery-img-del"; del.title = "删除";
          del.textContent = "🗑";
          del.onclick = (ev) => { ev.stopPropagation(); removeItem(f); };
          card.appendChild(chk);
          card.appendChild(del);
          card.appendChild(thumb);
          card.appendChild(cap);
          card.appendChild(meta);
          card.onclick = () => openImagePreview(f.path, f.name);
          grid.appendChild(card);
          state.selectableCount++;
          state.files.push(f);
        });
        box.appendChild(grid);
      }
      if (docs.length) {
        const list = document.createElement("div");
        list.className = "gallery-file-list";
        docs.forEach((f) => {
          const row = document.createElement("div");
          row.className = "gallery-file-item";
          const chk = document.createElement("input");
          chk.type = "checkbox"; chk.className = "fi-check"; chk.dataset.path = f.path;
          if (state.selected.has(f.path)) chk.checked = true;
          chk.onchange = () => { if (chk.checked) state.selected.add(f.path); else state.selected.delete(f.path); updateBatchCount(); };
          const url = rawUrl(f.path);
          row.innerHTML =
            '<span class="gf-icon">📄</span>' +
            '<span class="gf-name">' + esc(f.name) + "</span>" +
            '<a href="' + esc(url) + '" target="_blank" rel="noopener">打开</a>';
          const del = document.createElement("button");
          del.type = "button"; del.className = "gallery-file-del"; del.title = "删除";
          del.textContent = "🗑";
          del.onclick = (ev) => { ev.stopPropagation(); removeItem(f); };
          row.insertBefore(chk, row.firstChild);
          row.appendChild(del);
          list.appendChild(row);
          state.selectableCount++;
          state.files.push(f);
        });
        box.appendChild(list);
      }
    });
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

  // 上传落点：默认上传到当前打开的分类目录；若已指定目录则使用指定目录（不再固定 public/uploads）
  function dirForUpload(folderPath) {
    if (folderPath) return folderPath; // folderPath 已是完整仓库相对路径（如 src/content/posts/guide）
    return currentDirPath();
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

  // 仅用于判断「切换后缀是否改变了编辑器模式」：内容类 md/mdx 同属 Markdown 模式，
  // 配置类 html（可视化）/ts（源代码）模式不同。切换同模式后缀时不重建编辑器，避免草稿丢失。
  function editorModeKey(type, ext) {
    if (type === "config") return ext === ".html" ? "html" : "raw";
    return "md";
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
    const sel = $("extSelect");
    if (!opts.includes(sel.value)) sel.value = opts[0];
    const ext = sel.value;
    const t = state.type;
    state.htmlMode = false; state.plainRaw = false; state.configStruct = false; state.forceMarkdown = false;
    if (t === "config") {
      if (ext === ".html") state.htmlMode = true;
      else state.plainRaw = true; // .ts 新文件暂无内容，暂走源代码编辑
    }
    // 保留用户已输入的文件名（避免切换后缀时被重置为默认 base）
    const base = ($("fileName").value || "").trim() || state._newBase;
    state._newBase = base;
    state._curExt = ext;
    showEditor(state._newBody, state._newFm, base);
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
  // 字段级枚举覆盖查询（文件名 + 完整路径）
  function enumOverrideFor(cfgName, path) {
    const fm = CONFIG_FIELD_ENUMS[cfgName];
    if (!fm) return null;
    return fm[path] || null;
  }

  // 纯标量数组整段重序列化：从 DOM 读取当前各项值，按原始缩进重建数组文本
  function collectArrayEdit(block) {
    const start = Number(block.dataset.arrStart);
    const end = Number(block.dataset.arrEnd);
    const type = block.dataset.arrType || "string";
    const indentItem = JSON.parse(block.dataset.arrItemIndent || '"\\n\\t\\t"');
    const indentClose = JSON.parse(block.dataset.arrCloseIndent || '"\\n\\t"');
    const inputs = Array.prototype.slice.call(block.querySelectorAll(".cfg-arr-val"));
    const items = inputs.map((inp) => {
      if (type === "number") {
        const n = inp.value.trim();
        return isNaN(Number(n)) ? "0" : n;
      }
      if (type === "boolean") return inp.checked ? "true" : "false";
      return FireflyConfig.encodeValue("string", inp.value, '"');
    });
    let text;
    if (items.length === 0) text = "[" + indentClose + "]";
    else text = "[" + indentItem + items.join("," + indentItem) + "," + indentClose + "]";
    return { start, end, text };
  }

  // 标记某元素所在 .ap-pane 为未保存
  function markDirtyOf(el) {
    const pane = el.closest && el.closest(".ap-pane");
    if (pane && pane.dataset.pane && apState[pane.dataset.pane]) apState[pane.dataset.pane].dirty = true;
  }

  // 为标量数组追加一项（空白输入）
  function addArrayItem(btn) {
    const block = btn.closest('[data-array="1"]');
    if (!block) return;
    const type = block.dataset.arrType || "string";
    const row = document.createElement("div");
    row.className = "cfg-field";
    const lab = document.createElement("label");
    lab.className = "cfg-field-label";
    lab.innerHTML = '<span class="cfg-key">新项</span>';
    row.appendChild(lab);
    let inp;
    if (type === "boolean") {
      inp = document.createElement("input");
      inp.type = "checkbox";
      inp.className = "cfg-check cfg-arr-val";
    } else {
      inp = document.createElement("input");
      inp.type = type === "number" ? "number" : "text";
      inp.className = "cfg-input cfg-arr-val";
      inp.value = "";
    }
    row.appendChild(inp);
    const del = document.createElement("button");
    del.type = "button";
    del.className = "fi-act danger cfg-arr-del";
    del.title = "删除此项";
    del.textContent = "🗑";
    row.appendChild(del);
    block.insertBefore(row, btn.closest(".cfg-arr-foot"));
    markDirtyOf(btn);
  }

  // 对象数组：整块增删（每个对象是重复结构，作为整体添加/删除）
  function renderObjectArray(node, keyLabel, depth, path, cfgName) {
    const schema = OBJ_ARRAY_SCHEMAS[path];
    if (!schema) return cfgNodeElObjectFallback(node, keyLabel, depth, path, cfgName);
    const block = document.createElement("div");
    block.className = "cfg-objarr";
    block.dataset.arrStart = node.start;
    block.dataset.arrEnd = node.end;
    block.dataset.schema = path;
    let itemIndent = "\n\t\t", closeIndent = "\n\t";
    if (cfgRawSrc) {
      if (node.children.length) {
        itemIndent = cfgRawSrc.slice(node.start + 1, node.children[0].value.start);
        closeIndent = cfgRawSrc.slice(node.children[node.children.length - 1].value.end, node.end - 1);
      } else {
        closeIndent = cfgRawSrc.slice(node.start + 1, node.end - 1) || "\n\t\t";
        itemIndent = closeIndent;
      }
    }
    block.dataset.itemIndent = JSON.stringify(itemIndent);
    block.dataset.closeIndent = JSON.stringify(closeIndent);
    const list = document.createElement("div");
    list.className = "cfg-objarr-list";
    node.children.forEach((ch, idx) => list.appendChild(renderObjectArrayItem(ch.value, idx, schema)));
    block.appendChild(list);
    const foot = document.createElement("div");
    foot.className = "cfg-arr-foot";
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "btn ghost sm cfg-objarr-add";
    addBtn.textContent = "➕ 添加一项";
    foot.appendChild(addBtn);
    block.appendChild(foot);
    return block;
  }

  function objFieldDefault(type) {
    if (type === "boolean") return false;
    if (type === "number") return 0;
    return "";
  }

  function renderObjectArrayItem(objNode, idx, schema) {
    const card = document.createElement("div");
    card.className = "cfg-obj-item";
    const head = document.createElement("div");
    head.className = "cfg-obj-item-head";
    head.innerHTML = '<span class="cfg-obj-item-title">第 ' + (idx + 1) + " 项</span>";
    const del = document.createElement("button");
    del.type = "button";
    del.className = "fi-act danger cfg-objarr-del";
    del.title = "删除此项";
    del.textContent = "🗑";
    head.appendChild(del);
    card.appendChild(head);
    const children = (objNode && objNode.children) || [];
    schema.forEach((f) => {
      const child = children.find((c) => c.key === f.key);
      let raw = objFieldDefault(f.type);
      if (child && child.value) {
        if (child.value.type === "array") {
          raw = (child.value.children || []).map((c) =>
            c.value && c.value.value != null ? String(c.value.value).replace(/^["']|["']$/g, "") : "");
        } else {
          raw = child.value.value != null ? child.value.value : objFieldDefault(f.type);
        }
      }
      const row = document.createElement("div");
      row.className = "cfg-field";
      const lab = document.createElement("label");
      lab.className = "cfg-field-label";
      lab.innerHTML = '<span class="cfg-key">' + esc(f.key) + "</span>";
      row.appendChild(lab);
      let inp;
      if (f.type === "boolean") {
        inp = document.createElement("input");
        inp.type = "checkbox";
        inp.className = "cfg-check cfg-obj-field";
        inp.checked = !!raw;
      } else if (f.type === "number") {
        inp = document.createElement("input");
        inp.type = "number";
        inp.className = "cfg-input cfg-obj-field";
        inp.value = String(raw);
      } else if (f.type === "string[]") {
        inp = document.createElement("input");
        inp.type = "text";
        inp.className = "cfg-input cfg-obj-field cfg-obj-tags";
        inp.value = Array.isArray(raw) ? raw.join(", ") : "";
        inp.placeholder = "逗号分隔多个值";
      } else {
        inp = document.createElement("input");
        inp.type = "text";
        inp.className = "cfg-input cfg-obj-field";
        inp.value = raw != null ? String(raw) : "";
      }
      inp.dataset.fkey = f.key;
      inp.dataset.ftype = f.type;
      row.appendChild(inp);
      card.appendChild(row);
    });
    return card;
  }

  function addObjectArrayItem(btn) {
    const blk = btn.closest(".cfg-objarr");
    if (!blk) return;
    const schema = OBJ_ARRAY_SCHEMAS[blk.dataset.schema];
    if (!schema) return;
    const list = blk.querySelector(".cfg-objarr-list");
    const idx = list.children.length;
    list.appendChild(renderObjectArrayItem({ type: "object", children: [] }, idx, schema));
    markDirtyOf(btn);
  }

  function cfgNodeElObjectFallback(node, keyLabel, depth, path, cfgName) {
    // 未知对象数组：退化为普通嵌套渲染（不应触发，schema 未配置时）
    const block = document.createElement("div");
    block.className = depth === 0 ? "cfg-title-block" : "cfg-sub-block";
    return block;
  }

  function cfgNodeEl(node, keyLabel, depth, path, cfgName) {
    if (node.type === "object" || node.type === "array") {
      // 对象数组（如 links / sponsors / friendsConfig / albums / playlist）：整块增删
      if (node.type === "array" && OBJ_ARRAY_SCHEMAS[path]) {
        return renderObjectArray(node, keyLabel, depth, path, cfgName);
      }
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

      // 纯标量数组（如 keywords）：渲染为可增删的列表；仅当该数组在「允许增删」名单内才显示添加/删除按钮
      const allScalar = node.children.length === 0 || node.children.every((ch) =>
        ["string", "number", "boolean", "null"].indexOf(ch.value.type) >= 0);
      const addable = node.type === "array" && allScalar && SCALAR_ARRAY_ADDABLE.has(path);

      node.children.forEach((ch) => {
        const childKey = node.type === "array"
          ? (ch.value.comment || (keyLabel + "[" + node.children.indexOf(ch) + "]"))
          : ch.key;
        const childPath = path ? path + "." + childKey : childKey;
        const childRow = cfgNodeEl(ch.value, childKey, depth + 1, childPath, cfgName);
        if (addable) {
          const inp = childRow.querySelector(".cfg-input, .cfg-check");
          if (inp) inp.classList.add("cfg-arr-val");
          const del = document.createElement("button");
          del.type = "button";
          del.className = "fi-act danger cfg-arr-del";
          del.title = "删除此项";
          del.textContent = "🗑";
          childRow.appendChild(del);
        }
        block.appendChild(childRow);
      });

      if (addable) {
        block.dataset.array = "1";
        block.dataset.arrStart = node.start;
        block.dataset.arrEnd = node.end;
        block.dataset.arrType = node.children.length ? node.children[0].value.type : "string";
        // 还原原始缩进，保证写回后格式一致
        let indentItem = "\n\t\t";
        let indentClose = "\n\t";
        if (cfgRawSrc) {
          if (node.children.length) {
            indentItem = cfgRawSrc.slice(node.start + 1, node.children[0].value.start);
            indentClose = cfgRawSrc.slice(node.children[node.children.length - 1].value.end, node.end - 1);
          } else {
            indentClose = cfgRawSrc.slice(node.start + 1, node.end - 1) || "\n\t\t";
            indentItem = indentClose;
          }
        }
        block.dataset.arrItemIndent = JSON.stringify(indentItem);
        block.dataset.arrCloseIndent = JSON.stringify(indentClose);
        const foot = document.createElement("div");
        foot.className = "cfg-arr-foot";
        const addBtn = document.createElement("button");
        addBtn.type = "button";
        addBtn.className = "btn ghost sm cfg-arr-add";
        addBtn.textContent = "➕ 添加一项";
        foot.appendChild(addBtn);
        block.appendChild(foot);
      }
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

    // 枚举下拉：优先字段级覆盖，其次注释自动识别
    if (node.type === "string") {
      const ov = enumOverrideFor(cfgName, path);
      const enumList = ov ? (ov.options || ov) : (node.enumValues || null);
      if (enumList && enumList.length) {
        const custom = !!(ov && ov.custom);
        const sel = document.createElement("select");
        sel.className = "cfg-input cfg-select";
        let curInOpts = false;
        enumList.forEach((opt) => {
          let v, lbl;
          if (Array.isArray(opt)) { v = opt[0]; lbl = opt[1] != null ? opt[1] : opt[0]; }
          else if (opt && typeof opt === "object") { v = opt.value; lbl = opt.label != null ? opt.label : opt.value; }
          else { v = opt; lbl = opt; }
          const pair = [v, lbl];
          if (String(node.value) === String(pair[0])) curInOpts = true;
          const o = document.createElement("option");
          o.value = pair[0];
          o.textContent = pair[1];
          if (String(node.value) === String(pair[0])) o.selected = true;
          sel.appendChild(o);
        });
        if (custom) {
          const oc = document.createElement("option");
          oc.value = "__custom__";
          oc.textContent = "+ 自定义…";
          if (!curInOpts) oc.selected = true;
          sel.appendChild(oc);
        }
        sel.dataset.start = node.start;
        sel.dataset.end = node.end;
        sel.dataset.vtype = "string";
        sel.dataset.quote = node.quote || '"';
        row.appendChild(sel);
        if (custom) {
          const cinput = document.createElement("input");
          cinput.type = "text";
          cinput.className = "cfg-input cfg-custom";
          cinput.dataset.start = node.start;
          cinput.dataset.end = node.end;
          cinput.dataset.vtype = "string";
          cinput.dataset.quote = node.quote || '"';
          cinput.placeholder = "输入自定义值";
          cinput.style.display = "none";
          cinput.disabled = true;
          if (!curInOpts) {
            cinput.style.display = "";
            cinput.disabled = false;
            cinput.value = node.value != null ? node.value : "";
            sel.disabled = true;
          }
          row.appendChild(cinput);
          sel.addEventListener("change", () => {
            if (sel.value === "__custom__") {
              cinput.style.display = "";
              cinput.disabled = false;
              cinput.value = "";
              sel.disabled = true;
              cinput.focus();
            } else {
              cinput.style.display = "none";
              cinput.disabled = true;
              sel.disabled = false;
            }
          });
        }
        return row;
      }
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

  // 收集对象数组（整块重序列化）：读取每个对象卡片的字段，重建 [ ... ] 文本并按原始偏移写回
  function collectObjectArrayEdits(hostEl) {
    const root = hostEl || $("configEditor");
    const edits = [];
    root.querySelectorAll(".cfg-objarr").forEach((blk) => {
      const schema = OBJ_ARRAY_SCHEMAS[blk.dataset.schema];
      if (!schema) return;
      const itemIndent = JSON.parse(blk.dataset.itemIndent || '"\\n\\t\\t"');
      const closeIndent = JSON.parse(blk.dataset.closeIndent || '"\\n\\t"');
      const list = blk.querySelector(".cfg-objarr-list");
      if (!list) return;
      const items = Array.prototype.slice.call(list.children).filter((c) => c.classList.contains("cfg-obj-item"));
      const objTexts = items.map((card) => {
        const fields = schema.map((f) => {
          const inp = card.querySelector('.cfg-obj-field[data-fkey="' + f.key + '"]');
          let v;
          if (f.type === "boolean") v = inp.checked ? "true" : "false";
          else if (f.type === "number") {
            const n = (inp.value || "").trim();
            v = n === "" ? "0" : String(Number(n));
          } else if (f.type === "string[]") {
            const arr = (inp.value || "").split(",").map((s) => s.trim()).filter((s) => s !== "");
            v = "[" + arr.map((x) => FireflyConfig.encodeValue("string", x, '"')).join(", ") + "]";
          } else {
            v = FireflyConfig.encodeValue("string", inp.value, '"');
          }
          return itemIndent + "  " + f.key + ": " + v;
        }).join(",\n");
        return itemIndent + "{\n" + fields + "\n" + itemIndent + "}";
      }).join(",");
      const text = "[" + objTexts + closeIndent + "]";
      edits.push({ start: Number(blk.dataset.arrStart), end: Number(blk.dataset.arrEnd), text });
    });
    return edits;
  }

  function collectConfigEdits(hostEl) {
    const root = hostEl || $("configEditor");
    const edits = [];
    // 纯标量数组：整段重序列化（覆盖其中各项的逐值编辑，避免重复写入）
    root.querySelectorAll('[data-array="1"]').forEach((blk) => {
      edits.push(collectArrayEdit(blk));
    });
    // 对象数组（links / sponsors / friendsConfig / albums / playlist 等）：整块重序列化
    collectObjectArrayEdits(root).forEach((e) => edits.push(e));
    // 注意：布尔复选框的类名是 .cfg-check（非 .cfg-input），必须一起收集，
    // 否则 enable 等布尔值永远不会出现在 edits 中，导致无法切换 true/false、提交到 GitHub 无变化。
    // 标量数组项（.cfg-arr-val）与对象数组字段（.cfg-obj-field）已分别处理，此处排除，避免重复编辑。
    const inputs = root.querySelectorAll(".cfg-input:not(.cfg-arr-val):not(.cfg-obj-field), .cfg-check:not(.cfg-arr-val):not(.cfg-obj-field)");
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
        okPopup("✅ 已保存，GitHub 将自动重新部署");
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
    $("configView").hidden = name !== "config";
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
        await refreshCurrent();
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
    await refreshCurrent();
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
    await refreshCurrent();
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
    const base = state.type === "config" ? "src/config"
      : state.type === "gallery" ? "src/content/posts"
      : "src/content/" + state.type;
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
        // 文章/动态/单页等编辑场景：上传后提供「插入」入口（图库仅浏览，不需要）
        if (state.type !== "gallery" && data.url) addUploadItem(data.url, file.name, file.type.startsWith("image/"));
        return data;
      } else {
        const msg = (data && data.error) || "上传失败";
        toast(msg, "err");
        if (state.type !== "gallery") addUploadItemError(file.name, msg);
      }
    } catch (e) {
      const msg = e.message || "上传失败";
      toast(msg, "err");
      if (state.type !== "gallery") addUploadItemError(file.name, msg);
    }
  }

  async function handleFiles(files) {
    if (!files || !files.length) return;
    // 图库模式：上传时先选择目标分类目录
    if (state.type === "gallery") {
      const dir = await chooseGalleryUploadDir();
      if (dir === null) return; // 取消
      for (const f of files) await uploadFileToDir(f, dir);
      await loadGallery();
      return;
    }
    // 文章/动态/单页：上传到当前打开的分类目录（不再固定 public/uploads）
    const dir = currentDirPath();
    for (const f of files) await uploadFileToDir(f, dir);
    await refreshCurrent();
  }

  // 图库上传：选择目标分类目录（现有分类 + 根目录），返回完整仓库相对路径或 null（取消）
  function chooseGalleryUploadDir() {
    return new Promise((resolve) => {
      let dirs = [];
      api("/api/list?type=posts").then((r) => {
        dirs = ((r && r.data && r.data.items) || []).filter((f) => f.type === "dir").map((f) => f.name);
        show();
      }).catch(() => { dirs = []; show(); });
      function show() {
        const optsHtml =
          '<option value="">根目录（src/content/posts）</option>' +
          dirs.map((d) => '<option value="' + esc(d) + '">📁 ' + esc(d) + "</option>").join("");
        const overlay = document.createElement("div");
        overlay.className = "modal-overlay";
        overlay.innerHTML =
          '<div class="modal-card" role="dialog" aria-modal="true">' +
            '<div class="modal-title">上传到哪个分类？</div>' +
            '<div class="modal-body"><select class="modal-select" id="gDirSel">' + optsHtml + '</select></div>' +
            '<div class="modal-hint">选择目标文件夹后，文件将上传到该目录。</div>' +
            '<div class="modal-actions">' +
              '<button class="btn ghost modal-cancel" type="button">取消</button>' +
              '<button class="btn primary modal-ok" type="button">确定</button>' +
            '</div>' +
          '</div>';
        document.body.appendChild(overlay);
        const sel = overlay.querySelector("#gDirSel");
        const okBtn = overlay.querySelector(".modal-ok");
        const cancelBtn = overlay.querySelector(".modal-cancel");
        function close(val) { overlay.remove(); resolve(val); }
        okBtn.addEventListener("click", () => close("src/content/posts" + (sel.value ? "/" + sel.value : "")));
        cancelBtn.addEventListener("click", () => close(null));
        overlay.addEventListener("click", (e) => { if (e.target === overlay) close(null); });
        sel.focus();
      }
    });
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
    const titles = { posts: "文章", dynamic: "动态", spec: "单页", gallery: "图库", config: "配置" };
    $("ctTitle").textContent = titles[type] || type;
    // 配置类：禁止新建文件 / 批量删除 / 全选 / 上传 / 新建分类（仅文章/动态/单页/图库可写）
    const isConfig = type === "config";
    const isGallery = type === "gallery";
    // 图库：启用 上传 / 新建分类 / 全选 / 批量删除（每项自带删除按钮）；隐藏 新建文件 与 搜索框
    $("selectAllRow").hidden = isConfig;
    $("batchDelBtn").hidden = isConfig;
    $("newBtn").hidden = isConfig || isGallery;
    $("quickUploadBtn").hidden = isConfig;
    $("newCatBtn").hidden = isConfig;
    $("searchInput").hidden = isConfig || isGallery;
    $("refreshBtn").hidden = isConfig || isGallery;
    if (isGallery) $("searchInput").value = "";

    state.selected.clear();

    if (type === "config") {
      showView("config");
      // 左侧分类导航 + 右侧操作说明（README）/ 配置编辑（含站点资源：Logo / 头像）
      loadConfigNav();
      return;
    }
    if (type === "gallery") {
      showView("content");
      backToEmpty();
      loadGallery();
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

  function apHostFor(name, root) {
    const scope = root || document;
    const pane = scope.querySelector('.ap-pane[data-pane="' + name + '"]');
    return pane ? pane.querySelector(".ap-cfg-host") : null;
  }
  function apStatusFor(name, root) {
    const scope = root || document;
    const pane = scope.querySelector('.ap-pane[data-pane="' + name + '"]');
    return pane ? pane.querySelector(".ap-pane-status") : null;
  }
  function apPaneName(btn) {
    return (btn.dataset.save || "").replace(/\.ts$/, "");
  }

  // 「站点外观」导航已移除：站点Logo / 作者头像 合并进「配置」视图（见 selectCfgTab 的 logo/avatar 分支）；
  // 原站点外观相关函数 selectApTab / loadApTabs / loadApConfig / renderApConfig / saveApConfig 一并删除（不再依赖 #apTabs / #apBody）。

  // 通用配置渲染（供配置视图与编辑器复用），渲染到指定 host
  // cfgName：文件名（用于字段级枚举覆盖）；raw：源码（用于标量数组重序列化缩进还原）
  function renderGenericConfig(host, roots, cfgName, raw) {
    cfgRawSrc = raw || "";
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
        r.node.children.forEach((ch) => sec.appendChild(cfgNodeEl(ch.value, ch.key, 0, r.name, cfgName)));
      } else {
        sec.appendChild(cfgNodeEl(r.node, r.name, 0, r.name, cfgName));
      }
      host.appendChild(sec);
    });
  }

  // 配置保存已统一收敛到 saveCfgConfig（站点外观视图移除后，旧的 saveApConfig 不再使用）。

  // ----------------------------------------------------------------------
  // 保存成功弹窗（居中、自动消失，替换原来的「已保存，GitHub 将自动重新部署」提示）
  // ----------------------------------------------------------------------
  let okPopupTimer = null;
  function okPopup(msg) {
    const el = $("okPopup");
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
    // 触发过渡
    requestAnimationFrame(() => el.classList.add("show"));
    clearTimeout(okPopupTimer);
    okPopupTimer = setTimeout(() => {
      el.classList.remove("show");
      setTimeout(() => (el.hidden = true), 280);
    }, 2000);
  }

  // ----------------------------------------------------------------------
  // 配置页面：左侧分类导航 + 右侧操作说明（README）/ 配置编辑
  // 复用配置解析与渲染；用 #cfgPanes 作用域隔离，避免与站点外观同名 .ap-pane 冲突
  // ----------------------------------------------------------------------
  function cfgPanesRoot() { return $("cfgPanes"); }

  // ===== 配置左侧导航分组（基础 / 功能 / 页面 / 扩展；其余文件自动归入「其他配置」） =====
  const CFG_NAV_GROUPS = [
    { title: "基础配置", items: [
      { key: "logo", label: "站点Logo", resource: true },
      { key: "avatar", label: "作者头像", resource: true },
      { key: "siteConfig", label: "站点基础配置", file: "siteConfig.ts" },
      { key: "navBarConfig", label: "导航栏配置", file: "navBarConfig.ts", custom: "navbar" },
      { key: "footerConfig", label: "页脚配置", file: "footerConfig.ts", merged: true },
      { key: "backgroundWallpaper", label: "背景壁纸配置", file: "backgroundWallpaper.ts" },
      { key: "sidebarConfig", label: "侧边栏布局配置", file: "sidebarConfig.ts" },
      { key: "announcementConfig", label: "公告配置", file: "announcementConfig.ts" },
    ]},
    { title: "功能配置", items: [
      { key: "fontConfig", label: "字体配置", file: "fontConfig.ts" },
      { key: "commentConfig", label: "评论系统配置", file: "commentConfig.ts" },
      { key: "coverImageConfig", label: "封面图配置", file: "coverImageConfig.ts" },
      { key: "musicConfig", label: "音乐播放器配置", file: "musicConfig.ts" },
      { key: "plantumlConfig", label: "PlantUML 图表配置", file: "plantumlConfig.ts" },
      { key: "mermaidConfig", label: "Mermaid图表配置", file: "mermaidConfig.ts" },
    ]},
    { title: "页面配置", items: [
      { key: "friendsConfig", label: "友链配置", file: "friendsConfig.ts" },
      { key: "galleryConfig", label: "相册配置", file: "galleryConfig.ts" },
      { key: "sponsorConfig", label: "打赏配置", file: "sponsorConfig.ts" },
      { key: "booknavConfig", label: "书签导航配置", file: "booknavConfig.ts" },
    ]},
    { title: "扩展功能", items: [
      { key: "effectsConfig", label: "动画特效配置", file: "effectsConfig.ts" },
      { key: "licenseConfig", label: "许可证配置", file: "licenseConfig.ts" },
      { key: "pioConfig", label: "看板娘配置", file: "pioConfig.ts" },
    ]},
  ];

  // ===== 导航栏自定义链接编辑器（navBarConfig.ts） =====
  // navBarConfig.ts 是函数式构建（getDynamicNavBarConfig），无法用通用配置编辑器安全编辑，
  // 因此单独管理其中「// 自定义导航栏链接」区域（自定义分组 + 子链接）的增删改。
  const NAVBAR_START = "FireflyCMS:NAVBAR_CUSTOM_START";
  const NAVBAR_END = "FireflyCMS:NAVBAR_CUSTOM_END";

  // 将 TS 对象字面量（含未引号键、单行/块注释、单引号、尾逗号）转为可 JSON.parse 的文本
  function tsObjToJsonish(src) {
    let out = "", i = 0, n = src.length, inStr = null;
    while (i < n) {
      const c = src[i];
      if (inStr) {
        out += c;
        if (c === "\\") { if (i + 1 < n) { out += src[i + 1]; i += 2; } else { i++; } continue; }
        if (c === inStr) inStr = null;
        i++; continue;
      }
      if (c === '"' || c === "'") { inStr = c; out += c; i++; continue; }
      if (c === "/" && src[i + 1] === "/") { while (i < n && src[i] !== "\n") i++; continue; }
      if (c === "/" && src[i + 1] === "*") { i += 2; while (i + 2 <= n && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue; }
      const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i));
      if (m) {
        let j = i + m[0].length;
        while (j < n && (src[j] === " " || src[j] === "\t" || src[j] === "\n" || src[j] === "\r")) j++;
        if (src[j] === ":") { out += '"' + m[0] + '"'; i = j; continue; }
      }
      out += c; i++;
    }
    return out;
  }
  function parseTsValue(text) {
    let j = tsObjToJsonish(text);
    j = j.replace(/,(\s*[}\]])/g, "$1"); // 去除尾逗号
    try { return JSON.parse(j); } catch (e) { return null; }
  }
  // 从字符串 s 的 openIdx（'(' 位置）提取到匹配 ')' 之间的内容（跳过字符串内的括号）
  function extractBalanced(s, openIdx) {
    let depth = 0, i = openIdx, inStr = null;
    for (; i < s.length; i++) {
      const c = s[i];
      if (inStr) { if (c === "\\") { i++; continue; } if (c === inStr) inStr = null; continue; }
      if (c === '"' || c === "'") { inStr = c; continue; }
      if (c === "(") depth++;
      else if (c === ")") { depth--; if (depth === 0) return s.slice(openIdx + 1, i); }
    }
    return s.slice(openIdx + 1);
  }
  // 解析 navBarConfig.ts 中的自定义链接区域，返回分组数组
  function parseNavBarCustom(raw) {
    let region;
    const sS = raw.indexOf(NAVBAR_START), eS = raw.indexOf(NAVBAR_END);
    if (sS !== -1 && eS !== -1) {
      region = raw.slice(raw.indexOf("\n", sS) + 1, raw.lastIndexOf("\n", eS));
    } else {
      const a = raw.indexOf("自定义导航栏链接");
      if (a === -1) return [];
      const regionStart = raw.lastIndexOf("\n", a) + 1;
      const ret = raw.indexOf("return { links }");
      const regionEnd = ret === -1 ? raw.length : raw.lastIndexOf("\n", ret);
      region = raw.slice(regionStart, regionEnd);
    }
    const groups = [];
    const re = /links\.push\(/g; let m;
    while ((m = re.exec(region))) {
      const ls = region.lastIndexOf("\n", m.index) + 1;
      const line = region.slice(ls, region.indexOf("\n", m.index));
      if (/^\s*\/\//.test(line)) continue; // 跳过被注释掉的 links.push
      const openIdx = m.index + m[0].length - 1;
      const inner = extractBalanced(region, openIdx);
      const obj = parseTsValue(inner);
      if (!obj || typeof obj !== "object") continue;
      groups.push({
        name: typeof obj.name === "string" ? obj.name : "",
        url: typeof obj.url === "string" ? obj.url : "#",
        icon: typeof obj.icon === "string" ? obj.icon : "",
        children: Array.isArray(obj.children) ? obj.children.map((c) => ({
          name: typeof c.name === "string" ? c.name : "",
          url: typeof c.url === "string" ? c.url : "",
          icon: typeof c.icon === "string" ? c.icon : "",
          external: !!c.external,
        })) : [],
      });
    }
    return groups;
  }
  // 将分组模型序列化回 navBarConfig.ts 的自定义链接区域
  function serializeNavBarCustom(model, raw) {
    const blocks = (model || []).map((g) => {
      const children = (g.children || []).map((c) =>
        "\t\t\t{\n" +
        "\t\t\t\tname: " + JSON.stringify(c.name || "") + ",\n" +
        "\t\t\t\turl: " + JSON.stringify(c.url || "") + ",\n" +
        (c.icon ? "\t\t\t\ticon: " + JSON.stringify(c.icon) + ",\n" : "") +
        "\t\t\t\texternal: " + (c.external ? "true" : "false") + "\n" +
        "\t\t\t}"
      ).join(",\n");
      return "\tlinks.push({\n" +
        "\t\tname: " + JSON.stringify(g.name || "") + ",\n" +
        "\t\turl: " + JSON.stringify(g.url || "#") + ",\n" +
        (g.icon ? "\t\ticon: " + JSON.stringify(g.icon) + ",\n" : "") +
        "\t\t// 子菜单\n" +
        "\t\tchildren: [\n" + children + "\n\t\t],\n" +
        "\t});";
    }).join("\n\n");
    const custom = "\t// ===== " + NAVBAR_START + " =====\n" +
      (blocks || "\t// （暂无自定义分组）") + "\n" +
      "\t// ===== " + NAVBAR_END + " =====";
    let regionStart, regionEnd;
    const ss = raw.indexOf(NAVBAR_START), es = raw.indexOf(NAVBAR_END);
    if (ss !== -1 && es !== -1) {
      regionStart = raw.lastIndexOf("\n", ss);
      regionEnd = raw.indexOf("\n", es);
    } else {
      const a = raw.indexOf("自定义导航栏链接");
      if (a === -1) {
        const ret = raw.indexOf("return { links }");
        regionStart = ret === -1 ? raw.length : raw.lastIndexOf("\n", ret);
        regionEnd = regionStart;
      } else {
        regionStart = raw.lastIndexOf("\n", a);
        const ret = raw.indexOf("return { links }");
        regionEnd = ret === -1 ? raw.length : raw.lastIndexOf("\n", ret);
      }
    }
    return raw.slice(0, regionStart) + "\n" + custom + "\n" + raw.slice(regionEnd);
  }
  function nvField(label, obj, key) {
    const d = document.createElement("label"); d.className = "nv-field";
    const s = document.createElement("span"); s.className = "nv-field-label"; s.textContent = label;
    const inp = document.createElement("input"); inp.type = "text"; inp.value = obj[key] || ""; inp.className = "nv-input";
    inp.oninput = () => { obj[key] = inp.value; };
    d.appendChild(s); d.appendChild(inp); return d;
  }
  function nvFieldInline(label, obj, key) {
    const d = document.createElement("div"); d.className = "nv-field-inline";
    const s = document.createElement("span"); s.textContent = label;
    const inp = document.createElement("input"); inp.type = "text"; inp.value = obj[key] || ""; inp.className = "nv-input";
    inp.oninput = () => { obj[key] = inp.value; };
    d.appendChild(s); d.appendChild(inp); return d;
  }
  async function loadNavBarConfig(host) {
    host.innerHTML = '<div class="cfg-empty">加载中…</div>';
    try {
      const { status, data } = await api("/api/file?path=" + encodeURIComponent("src/config/navBarConfig.ts"));
      if (status !== 200 || data.content == null) { host.innerHTML = '<div class="cfg-empty">未找到 src/config/navBarConfig.ts</div>'; return; }
      let model = null;
      try { model = parseNavBarCustom(data.content); } catch (e) { model = null; }
      apState["navBarConfig"] = { raw: data.content, sha: data.sha, name: "navBarConfig", ext: ".ts", loaded: true, dirty: false, navModel: model || [], rawFallback: model === null };
      renderNavBarLinksEditor(host);
      if (model === null) {
        const warn = document.createElement("div"); warn.className = "nv-hint";
        warn.textContent = "⚠️ 自定义链接区域解析失败，已切换为原始文本编辑（保存将直接写入文本）。";
        host.insertBefore(warn, host.firstChild);
        const ta = document.createElement("textarea"); ta.className = "nv-raw"; ta.value = data.content; host.appendChild(ta);
      }
    } catch (e) {
      host.innerHTML = '<div class="cfg-empty">加载失败：' + esc(e.message || "") + "</div>";
    }
  }
  function renderNavBarLinksEditor(host) {
    const st = apState["navBarConfig"];
    if (!st) return;
    const model = st.navModel || (st.navModel = []);
    host.innerHTML = "";
    if (st.rawFallback) {
      const warn = document.createElement("div"); warn.className = "nv-hint";
      warn.textContent = "⚠️ 自定义链接区域解析失败，已切换为原始文本编辑。"; host.appendChild(warn);
      const ta = document.createElement("textarea"); ta.className = "nv-raw"; ta.value = st.raw || ""; host.appendChild(ta);
      return;
    }
    const wrap = document.createElement("div"); wrap.className = "navlinks-editor";
    const hint = document.createElement("div"); hint.className = "nv-hint";
    hint.textContent = "管理导航栏的「自定义链接」（不影响文章/社交等预设菜单）。可新增/删除整个自定义分组，或编辑每个分组下的外链（名称、网址、图标、是否外链）。";
    wrap.appendChild(hint);
    model.forEach((g, gi) => {
      const card = document.createElement("div"); card.className = "nv-group";
      const head = document.createElement("div"); head.className = "nv-group-head";
      const t = document.createElement("span"); t.className = "nv-group-title"; t.textContent = "自定义分组 " + (gi + 1);
      const delG = document.createElement("button"); delG.type = "button"; delG.className = "btn ghost sm nv-del-group"; delG.textContent = "删除分组";
      delG.onclick = () => { model.splice(gi, 1); renderNavBarLinksEditor(host); };
      head.appendChild(t); head.appendChild(delG); card.appendChild(head);
      card.appendChild(nvField("分组名称", g, "name"));
      card.appendChild(nvField("链接（一般为 #）", g, "url"));
      card.appendChild(nvField("图标（astro-icon 名称）", g, "icon"));
      const cw = document.createElement("div"); cw.className = "nv-children";
      const ct = document.createElement("div"); ct.className = "nv-children-title"; ct.textContent = "子链接"; cw.appendChild(ct);
      (g.children || (g.children = [])).forEach((c, ci) => {
        const row = document.createElement("div"); row.className = "nv-child-row";
        row.appendChild(nvFieldInline("名称", c, "name"));
        row.appendChild(nvFieldInline("网址", c, "url"));
        row.appendChild(nvFieldInline("图标", c, "icon"));
        const extW = document.createElement("label"); extW.className = "nv-ext";
        const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = !!c.external; cb.onchange = () => { c.external = cb.checked; };
        extW.appendChild(cb); extW.appendChild(document.createTextNode("外链")); row.appendChild(extW);
        const delC = document.createElement("button"); delC.type = "button"; delC.className = "btn ghost sm nv-del-child"; delC.textContent = "删除";
        delC.onclick = () => { g.children.splice(ci, 1); renderNavBarLinksEditor(host); };
        row.appendChild(delC);
        cw.appendChild(row);
      });
      const addC = document.createElement("button"); addC.type = "button"; addC.className = "btn ghost sm nv-add-child"; addC.textContent = "+ 添加子链接";
      addC.onclick = () => { g.children.push({ name: "", url: "", icon: "", external: false }); renderNavBarLinksEditor(host); };
      cw.appendChild(addC); card.appendChild(cw);
      wrap.appendChild(card);
    });
    const addG = document.createElement("button"); addG.type = "button"; addG.className = "btn primary sm nv-add-group"; addG.textContent = "+ 添加自定义分组";
    addG.onclick = () => { model.push({ name: "新分组", url: "#", icon: "material-symbols:link", children: [] }); renderNavBarLinksEditor(host); };
    wrap.appendChild(addG);
    host.appendChild(wrap);
  }

  async function loadConfigNav() {
    const scroll = $("cfgNavScroll");
    const panes = $("cfgPanes");
    if (!scroll || !panes) return;
    scroll.innerHTML = "";
    panes.innerHTML = "";
    // 操作说明（默认选中）
    const readmeItem = document.createElement("button");
    readmeItem.type = "button";
    readmeItem.className = "cfg-nav-item active";
    readmeItem.dataset.cfg = "__readme__";
    readmeItem.innerHTML = '<span class="cni-tx">操作说明</span>';
    scroll.appendChild(readmeItem);

    // 已规划的配置文件基名集合（用于把其余文件归入「其他配置」）
    const curatedBases = new Set();
    CFG_NAV_GROUPS.forEach((g) => g.items.forEach((it) => { if (it.file) curatedBases.add(it.file.replace(/\.(ts|html)$/, "").toLowerCase()); }));

    let items = [];
    try {
      const { data } = await api("/api/list?type=config");
      items = data.items || [];
    } catch (e) { /* 忽略：仅显示说明 */ }
    const all = items.filter((f) => {
      const n = f.name.toLowerCase();
      if (n === "readme.md" || n === "index.ts") return false;
      return f.name.endsWith(".ts") || f.name.endsWith(".html");
    });
    const order = ["siteConfig","analyticsConfig","profileConfig","announcementConfig","backgroundWallpaper","booknavConfig","sidebarConfig","sponsorConfig","commentConfig","navBarConfig","footerConfig","friendsConfig","galleryConfig","licenseConfig","musicConfig","pioConfig","plantumlConfig","coverImageConfig","dynamicConfig","effectsConfig","expressiveCodeConfig","fontConfig","displaySettingsConfig","mermaidConfig"];
    all.sort((a, b) => {
      const ia = order.indexOf(a.name.replace(/\.(ts|html)$/, ""));
      const ib = order.indexOf(b.name.replace(/\.(ts|html)$/, ""));
      const wa = ia === -1 ? order.length : ia;
      const wb = ib === -1 ? order.length : ib;
      return wa - wb || a.name.localeCompare(b.name);
    });
    const byBase = {};
    all.forEach((f) => {
      const base = f.name.replace(/\.(ts|html)$/, "").toLowerCase();
      (byBase[base] = byBase[base] || []).push(f);
    });
    // 为每个配置文件创建面板（含保存按钮）；同名 .ts+.html 标记为 merged（由 .ts 承载）
    all.forEach((f) => {
      const base = f.name.replace(/\.(ts|html)$/, "").toLowerCase();
      const group = byBase[base];
      const isHtml = f.name.endsWith(".html");
      if (group.length > 1 && isHtml) return;
      const name = f.name.replace(/\.(ts|html)$/, "");
      const label = CONFIG_NAME_MAP[f.name] || name;
      const pane = document.createElement("div");
      pane.className = "ap-pane ap-config-pane";
      pane.dataset.pane = name;
      pane.hidden = true;
      pane.innerHTML =
        '<div class="ap-pane-head"><span class="ap-pane-title">' + esc(label) + '</span>' +
        '<button class="btn primary sm ap-save" type="button" data-save="' + esc(f.name) + '">💾 保存</button></div>' +
        '<div class="ap-cfg-host config-editor"></div>' +
        '<div class="ap-pane-status" data-status="' + esc(f.name) + '"></div>';
      panes.appendChild(pane);
    });

    // 构建分组导航按钮（资源类不创建面板，仅创建按钮）
    const makeNavBtn = (key, label, file) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cfg-nav-item";
      btn.dataset.cfg = key;
      if (file) {
        const base = file.replace(/\.(ts|html)$/, "").toLowerCase();
        const f = all.find((x) => x.name.replace(/\.(ts|html)$/, "").toLowerCase() === base);
        btn.dataset.ext = (f && f.name.endsWith(".html")) ? ".html" : ".ts";
        if (f) {
          const grp = byBase[base] || [];
          if (grp.length > 1) { btn.dataset.merged = "1"; const hf = grp.find((g) => g.name.endsWith(".html")); if (hf) btn.dataset.html = hf.name; }
        }
      }
      btn.innerHTML = '<span class="cni-tx">' + esc(label) + "</span>";
      return btn;
    };
    CFG_NAV_GROUPS.forEach((g) => {
      const grpEl = document.createElement("div");
      grpEl.className = "cfg-nav-group";
      const title = document.createElement("div");
      title.className = "cfg-nav-group-title";
      title.textContent = g.title;
      grpEl.appendChild(title);
      const list = document.createElement("div");
      list.className = "cfg-nav-list";
      g.items.forEach((it) => list.appendChild(makeNavBtn(it.key, it.label, it.file)));
      grpEl.appendChild(list);
      scroll.appendChild(grpEl);
    });

    // 其他配置（未规划的文件），折叠且默认收起
    const otherFiles = all.filter((f) => {
      const base = f.name.replace(/\.(ts|html)$/, "").toLowerCase();
      if (curatedBases.has(base)) return false;
      if (f.name === "FooterConfig.html") return false; // 已合并进 footerConfig
      return true;
    });
    if (otherFiles.length) {
      const grpEl = document.createElement("div");
      grpEl.className = "cfg-nav-group collapsible collapsed";
      const title = document.createElement("div");
      title.className = "cfg-nav-group-title";
      title.textContent = "其他配置";
      title.onclick = () => grpEl.classList.toggle("collapsed");
      grpEl.appendChild(title);
      const list = document.createElement("div");
      list.className = "cfg-nav-list";
      otherFiles.forEach((f) => {
        const name = f.name.replace(/\.(ts|html)$/, "");
        list.appendChild(makeNavBtn(name, CONFIG_NAME_MAP[f.name] || name, f.name));
      });
      grpEl.appendChild(list);
      scroll.appendChild(grpEl);
    }
    loadConfigReadme();
  }

  function selectCfgTab(name) {
    document.querySelectorAll("#cfgNav .cfg-nav-item").forEach((b) => b.classList.toggle("active", b.dataset.cfg === name));
    const resource = $("cfgResource");
    const readme = $("cfgReadme");
    const panes = $("cfgPanes");
    // 站点资源（Logo / 头像）：从「站点外观」合并而来，仅图片上传，不读取结构化配置
    if (name === "logo" || name === "avatar") {
      if (resource) resource.hidden = false;
      if (readme) readme.hidden = true;
      if (panes) { panes.hidden = true; panes.querySelectorAll(".ap-pane").forEach((p) => (p.hidden = true)); }
      if (resource) resource.querySelectorAll(".res-pane").forEach((p) => { p.hidden = p.dataset.pane !== name; });
      loadAppearance();
      return;
    }
    if (resource) resource.hidden = true;
    if (name === "__readme__") {
      readme.hidden = false;
      panes.hidden = true;
      panes.querySelectorAll(".ap-pane").forEach((p) => (p.hidden = true));
      return;
    }
    readme.hidden = true;
    panes.hidden = false;
    panes.querySelectorAll(".ap-pane").forEach((p) => { p.hidden = p.dataset.pane !== name; });
    const tabEl = document.querySelector('#cfgNavScroll .cfg-nav-item[data-cfg="' + name + '"]');
    const ext = (tabEl && tabEl.dataset.ext) || ".ts";
    const merged = !!(tabEl && tabEl.dataset.merged === "1");
    const htmlName = tabEl && tabEl.dataset.html;
    loadCfgConfig(name, ext, merged, htmlName);
  }

  // 富文本编辑器（配置页页脚 / HTML 片段）：ToastUI 懒初始化，未加载时降级为 textarea
  let footerEditor = null;
  function initFooterEditor(html) {
    const host = $("footerHtmlEditor");
    if (!host) return;
    if (footerEditor) { try { footerEditor.destroy(); } catch (e) {} footerEditor = null; }
    if (window.toastui && toastui.Editor) {
      footerEditor = new toastui.Editor({
        el: host,
        height: "320px",
        initialEditType: "wysiwyg",
        previewStyle: "vertical",
        usageStatistics: false,
        autofocus: false,
      });
      // 用 setHTML 显式灌入内容（initialHTML 在编辑器初次布局未完成时偶尔不渲染）
      try { footerEditor.setHTML(html || ""); } catch (e) { /* 忽略 */ }
    } else {
      host.innerHTML = '<textarea class="cfg-raw">' + esc(html || "") + "</textarea>";
    }
  }

  // 单文件写入 GitHub（返回 {status,data}）
  async function putConfigFile(path, content, sha) {
    const payload = {
      path,
      content,
      sha: sha || undefined,
      message: "Update " + path.split("/").pop() + " via FireflyCMS",
    };
    return api("/api/file", { method: "PUT", body: JSON.stringify(payload) });
  }

  async function loadCfgConfig(name, ext, merged, htmlName) {
    const root = cfgPanesRoot();
    const host = apHostFor(name, root);
    if (!host) return;
    if (name === "navBarConfig") { await loadNavBarConfig(host); return; }
    const st = apState[name];
    // 远程优先：非 dirty 时重新从 GitHub 读取最新文件；dirty 时保留未保存编辑
    if (st && st.dirty) { st.ext = ext; renderCfgConfig(name); return; }
    host.innerHTML = '<div class="cfg-empty">加载中…</div>';
    try {
      let newSt;
      if (merged) {
        // 合并页脚：同时读取 .ts 结构化配置与 .html 内容
        const tsPath = "src/config/" + name + ".ts";
        const htmlPath = "src/config/" + (htmlName || (name + ".html"));
        const [tsRes, htmlRes] = await Promise.all([
          api("/api/file?path=" + encodeURIComponent(tsPath)),
          api("/api/file?path=" + encodeURIComponent(htmlPath)),
        ]);
        if (tsRes.status !== 200 || tsRes.data.content == null) {
          host.innerHTML = '<div class="cfg-empty">未找到 ' + esc(tsPath) + "</div>";
          return;
        }
        const parsed = FireflyConfig.parseConfig(tsRes.data.content);
        newSt = {
          raw: tsRes.data.content, sha: tsRes.data.sha, name, ext: ".ts",
          loaded: true, dirty: false, merged: true, htmlName: htmlName,
          htmlRaw: (htmlRes.data && htmlRes.data.content != null) ? htmlRes.data.content : "",
          htmlSha: (htmlRes.data && htmlRes.data.sha) || null,
          roots: parsed.roots,
        };
      } else {
        const path = "src/config/" + name + ext;
        const { status, data } = await api("/api/file?path=" + encodeURIComponent(path));
        if (status !== 200 || data.content == null) {
          host.innerHTML = '<div class="cfg-empty">未找到 ' + esc(path) + "</div>";
          return;
        }
        newSt = { raw: data.content, sha: data.sha, name, ext, loaded: true, dirty: false, merged: false, htmlName: null };
        if (ext === ".ts") {
          const parsed = FireflyConfig.parseConfig(data.content);
          newSt.roots = parsed.roots;
          if (name === "booknavConfig") newSt.booknavModel = normalizeBooknav(nodeToJS((parsed.roots.find((r) => r.name === "booknavConfig") || { node: { type: "array", children: [] } }).node));
        }
      }
      apState[name] = newSt;
      renderCfgConfig(name);
    } catch (e) {
      host.innerHTML = '<div class="cfg-empty">加载失败：' + esc(e.message || "") + "</div>";
    }
  }

  function renderCfgConfig(name) {
    const st = apState[name];
    const host = apHostFor(name, cfgPanesRoot());
    if (!st || !host) return;
    // 合并页脚：上方结构化配置 + 下方富文本 HTML 内容
    if (st.merged) {
      host.innerHTML = "";
      const tsWrap = document.createElement("div");
      tsWrap.className = "cfg-sub";
      renderGenericConfig(tsWrap, st.roots, name, st.raw);
      const htmlWrap = document.createElement("div");
      htmlWrap.className = "cfg-sub cfg-footer-html";
      htmlWrap.innerHTML = '<div class="cfg-subtitle">页脚 HTML 内容</div><div class="cfg-footer-editor" id="footerHtmlEditor"></div>';
      host.appendChild(tsWrap);
      host.appendChild(htmlWrap);
      initFooterEditor(st.htmlRaw || "");
      // 延迟绑定变更监听：避免初始化 setHTML 误触发「未保存」标记
      if (footerEditor) setTimeout(() => footerEditor.on("change", () => markDirtyOf(htmlWrap)), 0);
      return;
    }
    // 独立 .html 配置：富文本编辑
    if (st.ext === ".html") {
      host.innerHTML = '<div class="cfg-footer-editor" id="footerHtmlEditor"></div>';
      initFooterEditor(st.raw || "");
      if (footerEditor) setTimeout(() => footerEditor.on("change", () => markDirtyOf(host)), 0);
      return;
    }
    if (name === "booknavConfig") renderBooknavEditor(host, st.booknavModel);
    else renderGenericConfig(host, st.roots, name, st.raw);
  }

  async function saveCfgConfig(name, silent) {
    const st = apState[name];
    const root = cfgPanesRoot();
    const host = apHostFor(name, root);
    const statusEl = apStatusFor(name, root);
    if (!st || !host) return;
    let tsContent = null, htmlContent = null, tsPath = null, htmlPath = null;
    try {
      if (st.merged) {
        const tsHost = host.querySelector(".cfg-sub");
        const edits = collectConfigEdits(tsHost);
        tsContent = FireflyConfig.applyConfigEdits(st.raw, edits);
        tsPath = "src/config/" + name + ".ts";
        htmlContent = footerEditor ? footerEditor.getHTML() : ((host.querySelector("textarea") || {}).value || st.htmlRaw);
        htmlPath = "src/config/" + (st.htmlName || (name + ".html"));
      } else if (st.ext === ".html") {
        htmlContent = footerEditor ? footerEditor.getHTML() : ((host.querySelector("textarea") || {}).value || st.raw);
        htmlPath = "src/config/" + name + ".html";
      } else if (name === "navBarConfig") {
        if (st.rawFallback) {
          const ta = host.querySelector("textarea.nv-raw");
          tsContent = ta ? ta.value : st.raw;
        } else {
          tsContent = serializeNavBarCustom(st.navModel || [], st.raw);
        }
        st.raw = tsContent;
        tsPath = "src/config/navBarConfig.ts";
      } else if (name === "booknavConfig") {
        const rootN = st.roots.find((r) => r.name === "booknavConfig");
        if (!rootN) throw new Error("未找到 booknavConfig");
        const arrText = serializeBooknav(st.booknavModel || []);
        tsContent = st.raw.slice(0, rootN.node.start) + arrText + st.raw.slice(rootN.node.end);
        tsPath = "src/config/" + name + ".ts";
      } else {
        const edits = collectConfigEdits(host);
        tsContent = FireflyConfig.applyConfigEdits(st.raw, edits);
        tsPath = "src/config/" + name + ".ts";
      }
    } catch (e) {
      if (statusEl) { statusEl.textContent = e.message || "内容构建失败"; statusEl.className = "ap-pane-status err"; }
      return;
    }
    try {
      const applyRes = async (p, c, shaRef) => {
        const { status, data } = await putConfigFile(p, c, shaRef());
        if (status !== 200 && status !== 201) throw new Error((data && (data.error || data.message)) || "保存失败");
        return data;
      };
      if (tsContent != null) {
        const d = await applyRes(tsPath, tsContent, () => st.sha);
        st.sha = d.sha || st.sha;
      }
      if (htmlContent != null) {
        const d = await applyRes(htmlPath, htmlContent, () => st.htmlSha);
        st.htmlSha = d.sha || st.htmlSha;
      }
      st.dirty = false; // 已提交到 GitHub，恢复为「干净」状态（下次打开将重新读取远程）
      if (silent) {
        if (statusEl) { statusEl.textContent = "已自动保存"; statusEl.className = "ap-pane-status"; }
      } else {
        okPopup("✅ 已保存，GitHub 将自动重新部署");
        if (statusEl) statusEl.textContent = "";
      }
    } catch (e) {
      if (statusEl) { statusEl.textContent = e.message || "保存失败"; statusEl.className = "ap-pane-status err"; }
    }
  }

  // 极简 Markdown 渲染（用于配置区操作说明）
  function renderMarkdownSimple(md) {
    const escHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const inline = (s) => escHtml(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    const lines = (md || "").split(/\r?\n/);
    let html = "", i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (/^```/.test(line)) {
        let code = ""; i++;
        while (i < lines.length && !/^```/.test(lines[i])) { code += lines[i] + "\n"; i++; }
        i++;
        html += "<pre><code>" + escHtml(code) + "</code></pre>";
        continue;
      }
      const hm = line.match(/^(#{1,4})\s+(.*)$/);
      if (hm) { const l = hm[1].length; html += "<h" + l + ">" + inline(hm[2]) + "</h" + l + ">"; i++; continue; }
      if (/^\s*[-*]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*]\s+/, "")); i++; }
        html += "<ul>" + items.map((it) => "<li>" + inline(it) + "</li>").join("") + "</ul>";
        continue;
      }
      if (/^\s*\d+\.\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+\.\s+/, "")); i++; }
        html += "<ol>" + items.map((it) => "<li>" + inline(it) + "</li>").join("") + "</ol>";
        continue;
      }
      if (line.trim() === "") { i++; continue; }
      const para = [];
      while (i < lines.length && lines[i].trim() !== "" && !/^(#{1,4})\s/.test(lines[i]) && !/^\s*[-*]\s+/.test(lines[i]) && !/^\s*\d+\.\s+/.test(lines[i]) && !/^```/.test(lines[i])) { para.push(lines[i]); i++; }
      html += "<p>" + inline(para.join(" ")) + "</p>";
      continue;
    }
    return html;
  }

  async function loadConfigReadme() {
    const el = $("cfgReadme");
    if (!el) return;
    try {
      const { status, data } = await api("/api/file?path=" + encodeURIComponent("src/config/README.md"));
      if (status === 200 && data.content != null) el.innerHTML = renderMarkdownSimple(data.content);
      else el.innerHTML = '<div class="cfg-readme-empty">暂无操作说明（仓库中不存在 src/config/README.md）。</div>';
    } catch (e) {
      el.innerHTML = '<div class="cfg-readme-empty">操作说明加载失败。</div>';
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
    on("refreshBtn", "onclick", refreshCurrent);
    on("topRefreshBtn", "onclick", refreshCurrent);
    on("newBtn", "onclick", newFile);
    on("newCatBtn", "onclick", newCategory);
    on("quickUploadBtn", "onclick", () => { const fi = $("fileInput"); if (fi) fi.click(); });
    // 新建文件时切换后缀：md/mdx 同属 Markdown 模式，仅更新文件名预览，不重建编辑器（避免草稿丢失）；
    // 配置类 html↔ts 模式不同，才完整重建编辑器
    on("extSelect", "onchange", () => {
      if (!(state.current && state.current.isNew)) return;
      const sel = $("extSelect");
      const opts = extOptions(state.type);
      if (!opts.includes(sel.value)) { sel.value = opts[0]; return; }
      const base = ($("fileName").value || "").trim() || state._newBase;
      state.current.name = base + sel.value;
      const before = editorModeKey(state.type, state._curExt || opts[0]);
      const after = editorModeKey(state.type, sel.value);
      state._curExt = sel.value;
      if (before === after) {
        // 模式未变：仅刷新文件名预览，草稿内容保持不变
        $("fileName").value = base;
      } else {
        enterNewFile();
      }
    });
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
    // 配置页面：左侧分类导航切换（含站点资源 Logo / 头像 与配置文件两类条目）
    const cfgNavEl = $("cfgNav");
    if (cfgNavEl) cfgNavEl.addEventListener("click", (e) => {
      const b = e.target.closest(".cfg-nav-item");
      if (b) selectCfgTab(b.dataset.cfg);
    });
    // 配置页面：保存按钮（作用域隔离到 #cfgPanes）
    const cfgPanesEl = $("cfgPanes");
    if (cfgPanesEl) cfgPanesEl.addEventListener("click", (e) => {
      const b = e.target.closest(".ap-save");
      if (b) {
        const fname = b.dataset.save || "";
        const name = fname.replace(/\.(ts|html)$/, "");
        saveCfgConfig(name);
      }
    });
    // 配置编辑「脏标记」：任何输入/选择/书签增删都标记为未保存，
    // 使远程优先读取逻辑在存在本地编辑时不会覆盖用户修改。
    // 实时保存（防抖自动提交到 GitHub）：编辑后停顿即自动保存当前面板，
    // 避免切换分类 / 刷新页面导致未手动保存的修改丢失（即「无法实时保存」的根因之一）。
    const autosaveTimers = {};
    function scheduleAutosave(paneName) {
      clearTimeout(autosaveTimers[paneName]);
      autosaveTimers[paneName] = setTimeout(async () => {
        const st = apState[paneName];
        if (!st || !st.dirty) return;
        const pane = document.querySelector('.ap-pane[data-pane="' + paneName + '"]');
        if (!pane || pane.hidden) return; // 仅当该面板当前可见时才自动保存
        try {
          if (pane.closest("#cfgPanes")) await saveCfgConfig(paneName, true);
        } catch (e) { /* 自动保存失败不影响手动保存 */ }
      }, 1500);
    }

    function markCfgDirty(e) {
      const host = e.target.closest && e.target.closest(".ap-cfg-host");
      if (!host) return;
      const pane = host.closest(".ap-pane");
      if (!pane || !pane.dataset.pane) return;
      if (!apState[pane.dataset.pane]) return;
      // 输入框/选择框直接标记；点击仅当作用在按钮上（书签的结构性增删改）
      if (e.type === "click" && !(e.target.closest && e.target.closest("button"))) return;
      apState[pane.dataset.pane].dirty = true;
      scheduleAutosave(pane.dataset.pane);
    }
    document.addEventListener("input", markCfgDirty);
    document.addEventListener("change", markCfgDirty);
    document.addEventListener("click", markCfgDirty);

    // 标量数组（如 keywords）：添加 / 删除一项
    document.addEventListener("click", (e) => {
      const addBtn = e.target.closest && e.target.closest(".cfg-arr-add");
      if (addBtn) { addArrayItem(addBtn); return; }
      const delBtn = e.target.closest && e.target.closest(".cfg-arr-del");
      if (delBtn) {
        const row = delBtn.closest(".cfg-field");
        if (row) { row.remove(); markDirtyOf(delBtn); }
        return;
      }
      // 对象数组（links / sponsors / friendsConfig / albums / playlist 等）：整块添加 / 删除
      const objAdd = e.target.closest && e.target.closest(".cfg-objarr-add");
      if (objAdd) { addObjectArrayItem(objAdd); return; }
      const objDel = e.target.closest && e.target.closest(".cfg-objarr-del");
      if (objDel) {
        const item = objDel.closest(".cfg-obj-item");
        if (item) { item.remove(); markDirtyOf(objDel); }
        return;
      }
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
