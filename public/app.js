/* Firefly CMS 前端逻辑（富文本版） */
(() => {
  "use strict";

  const CONTENT_ROOT = "src/content";
  const $ = (id) => document.getElementById(id);
  // 模块级事件绑定 helper：供 bindEvents / bindBackupEvents / bindRestoreEvents 等共用，
  // 之前 on 仅定义在 bindEvents 内部，导致 bindBackupEvents 调用 on 抛 ReferenceError、
  // 「生成备份」等按钮事件从未绑定——表现为点击无反应。提升为模块级彻底修复。
  const on = (id, prop, fn) => { const el = $(id); if (el) el[prop] = fn; };

  const state = {
    token: localStorage.getItem("ff_token") || "",
    status: null,
    owner: "",
    repo: "",
    branch: "master",
    type: "posts",
    sectionType: "posts", // 实际点击的一级菜单 data-type（用于导航去重，区别于 state.type）
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
  // span 控制跨列：1（默认，不写）=1/4 宽；2=半行；3=3/4；full=整行。
  // PC 端 .pf-fields 为 4 列网格，短字段自然一行多列，移动端自动回落单列。
  const POST_GROUPS = [
    { title: "基础信息", icon: "📌", fields: [
      { key: "title", label: "标题", type: "text", required: true, full: true },
      { key: "published", label: "发布日期", type: "datetime", required: true },
      { key: "updated", label: "更新日期", type: "datetime" },
      { key: "slug", label: "自定义路径 Slug", type: "text" },
      { key: "author", label: "作者 Author", type: "text" },
      { key: "lang", label: "语言 Lang", type: "text" },
    ]},
    { title: "摘要与封面", icon: "🖼️", fields: [
      { key: "description", label: "描述 Description", type: "textarea", full: true },
      { key: "image", label: "封面图 Image", type: "text", full: true },
    ]},
    { title: "分类与标签", icon: "🏷️", fields: [
      { key: "tags", label: "标签 Tags（逗号分隔）", type: "text", span: 2 },
      { key: "category", label: "分类 Category", type: "text", span: 2 },
    ]},
    { title: "加密保护", icon: "🔒", encrypt: true, fields: [
      { key: "password", label: "访问密码 Password", type: "password" },
      { key: "passwordHint", label: "密码提示 PasswordHint", type: "text", span: 3 },
    ]},
    { title: "发布选项", icon: "⚙️", fields: [
      { key: "draft", label: "草稿（不对读者可见）", type: "checkbox" },
      { key: "pinned", label: "置顶 Pinned", type: "checkbox" },
      { key: "comment", label: "允许评论 Comment", type: "checkbox" },
    ]},
    { title: "高级", icon: "🧩", fields: [
      { key: "licenseName", label: "许可证名称", type: "text", span: 2 },
      { key: "licenseUrl", label: "许可证链接", type: "text", span: 2 },
      { key: "sourceLink", label: "来源链接", type: "text", span: 2 },
    ]},
  ];
  // 扁平化便于遍历（保持分组顺序）
  const POST_FIELDS = POST_GROUPS.flatMap((g) => g.fields);

  // 配置 / 单页文件名 -> 列表显示名（依据 src/config/README.md 与固定页面）
  const CONFIG_NAME_MAP = {
    "siteConfig.ts": "站点基础",
    "analyticsConfig.ts": "统计分析",
    "announcementConfig.ts": "公告通知",
    "backgroundWallpaper.ts": "背景壁纸",
    "commentConfig.ts": "评论配置",
    "coverImageConfig.ts": "封面图",
    "dynamicConfig.ts": "动态页面",
    "effectsConfig.ts": "动画特效",
    "expressiveCodeConfig.ts": "代码高亮",
    "fontConfig.ts": "字体配置",
    "footerConfig.ts": "页脚配置",
    "friendsConfig.ts": "友情链接",
    "galleryConfig.ts": "相册配置",
    "licenseConfig.ts": "许可证",
    "musicConfig.ts": "音乐播放器",
    "navBarConfig.ts": "导航栏",
    "pioConfig.ts": "看板娘",
    "plantumlConfig.ts": "PlantUML 图表",
    "profileConfig.ts": "用户资料",
    "sidebarConfig.ts": "侧边栏布局",
    "sponsorConfig.ts": "打赏配置",
    "mermaidConfig.ts": "Mermaid 图表",
    "displaySettingsConfig.ts": "显示设置",
    "booknavConfig.ts": "书签导航",
    "FooterConfig.html": "页脚内容",
  };
  const SPEC_NAME_MAP = {
    "about.md": "关于我",
    "friends.mdx": "友情链接",
    "guestbook.md": "留言页",
  };
  // 站点外观 Tab 显示名（比配置列表名更短，去掉「配置」后缀）
  const AP_NAME_MAP = {
    "booknavConfig": "书签导航",
    "displaySettingsConfig": "显示设置",
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
      "siteConfig.SITE_LANG": {
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
    "sponsorConfig.methods": [
      { key: "name", type: "string" },
      { key: "icon", type: "string" },
      { key: "qrCode", type: "string" },
      { key: "link", type: "string" },
      { key: "description", type: "string" },
      { key: "enabled", type: "boolean" },
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
    if (!m) return { data: {}, body: text, quoted: {} };
    const fm = m[1];
    const body = m[2];
    const data = {};
    const quoted = {};
    fm.split("\n").forEach((line) => {
      if (!line.trim() || line.trim().startsWith("#")) return;
      const idx = line.indexOf(":");
      if (idx === -1) return;
      const key = line.slice(0, idx).trim();
      const val = line.slice(idx + 1).trim();
      // 记录原值是否被双/单引号包裹：序列化时若该字段原本是字符串，必须保持引号，
      // 否则像 password: "123456" 这种会被 YAML 解析成数字导致 Astro schema 校验失败。
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        quoted[key] = true;
      }
      data[key] = parseYamlScalar(val);
    });
    return { data, body, quoted };
  }

  function yamlScalar(v, forceQuote) {
    if (Array.isArray(v)) {
      if (v.length === 0) return "[]";
      return "[" + v.map((x) => yamlScalar(x)).join(", ") + "]";
    }
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "number") return String(v);
    const s = String(v);
    if (s === "") return '""';
    // 日期 / 时间：保持不引号，符合 Firefly 约定（含毫秒与 Z / 时区偏移）
    if (/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(s)) return s;
    // 需要加引号的情形：① 该字段原本就是字符串（forceQuote）；② 纯数字串（如 password: 123456，
    // 不加引号会被 YAML 解析成 number，破坏 Astro 的 string schema）；③ 含特殊字符 / 布尔或 null 字面量
    const needQuote = !!forceQuote || /^-?\d+(\.\d+)?$/.test(s) ||
      /[:#\[\]{},&*?|<>=!%@`"' ]/.test(s) || /^ | $/.test(s) ||
      ["true", "false", "null", "yes", "no", "~"].includes(s);
    if (needQuote) {
      return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
    }
    return s;
  }

  function serializeFrontmatter(data, body, quoted) {
    let out = "---\n";
    for (const [k, v] of Object.entries(data)) {
      if (v === "" || v === undefined || v === null) continue;
      if (Array.isArray(v) && v.length === 0) continue;
      // quoted[k] 表示该字段原值带引号（字符串），序列化时强制保持引号，避免类型丢失
      out += k + ": " + yamlScalar(v, !!(quoted && quoted[k])) + "\n";
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
    state.editorActive = active; // 记录当前编辑器，供 Tab 切回「内容」时恢复
    const showMain = active === "main";   // 富文本 / HTML 所见即所得
    const showRaw = active === "raw";      // 源代码
    const showCfg = active === "config";   // 可视化配置（参数锁定）
    $("editorMain").hidden = !showMain;
    $("editorHost").hidden = !showMain;
    $("rawEditor").hidden = !showRaw;
    $("configEditor").hidden = !showCfg;
  }

  // 编辑器 Tab：内容 ⇄ 文章信息 / 动态信息 互斥切换（表单视图占满编辑区，独立滚动）
  function switchEditorTab(tab) {
    const isPane = tab !== "content"; // 面板视图（文章信息 / 动态信息）
    $("editForm").classList.toggle("ed-tab-pane", isPane);
    // 按钮高亮
    $("tabContentBtn").classList.toggle("active", !isPane);
    if ($("tabMetaBtn")) $("tabMetaBtn").classList.toggle("active", tab === "meta");
    if ($("tabDynBtn")) $("tabDynBtn").classList.toggle("active", tab === "dyn");
    // 面板：Tab 视图下始终展开（移除折叠态）
    const postPanel = $("postPanel");
    const dynPanel = $("dynamicPanel");
    if (tab === "meta") postPanel.classList.remove("collapsed");
    if (tab === "dyn") dynPanel.classList.remove("collapsed");
    postPanel.hidden = tab !== "meta";
    dynPanel.hidden = tab !== "dyn";
    // 内容区：面板视图下全部隐藏；切回「内容」时按当前编辑器模式恢复
    if (isPane) {
      $("editorMain").hidden = true;
      $("editorHost").hidden = true;
      $("rawEditor").hidden = true;
      $("configEditor").hidden = true;
      $("modeSwitch").hidden = true;
    } else {
      showOnlyEditor(state.editorActive || "main");
      $("modeSwitch").hidden = state.plainRaw || state.configStruct;
    }
    window.dispatchEvent(new Event("resize"));
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
    window.__repoInfo = { owner: state.owner, repo: state.repo, branch: state.branch };
    $("repoInfo").textContent = `${s.owner}/${s.repo}@${s.branch}`;
    bindEvents();
    await selectSection("overview");
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
    // 文章板块：按文件创建日期降序排列（最新创建排第一），无日期的排末尾
    if (state.type === "posts") {
      _files.sort((a, b) => {
        const ta = a.created ? new Date(a.created).getTime() : 0;
        const tb = b.created ? new Date(b.created).getTime() : 0;
        return tb - ta;
      });
    }
    // 图片与文档分开：图片走宫格预览，文档走可编辑列表
    const _docs = _files.filter((f) => !IMG_RE.test(f.name));
    const _imgs = _files.filter((f) => IMG_RE.test(f.name));
    // 文档列表表格化：有文档时插入表头（文件名称 / 大小 / 操作），列宽与 .file-item 的 grid 模板一致
    // 文章板块额外展示「创建日期」「修改时间」两列（数据来自 GitHub Commits API）
    if (_docs.length) {
      const head = document.createElement("div");
      head.className = "file-list-head";
      let headHtml = '<span class="flh-name">文件名称</span>';
      if (state.type === "posts") {
        headHtml += '<span class="flh-created">创建日期</span><span class="flh-updated">修改时间</span>';
      }
      headHtml += '<span class="flh-size">大小</span><span class="flh-actions">操作</span>';
      head.innerHTML = headHtml;
      box.appendChild(head);
    }
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
          `<div class="fi-main"><span class="fi-icon">${icon}</span>${nameHtml}</div>` +
          (state.type === "posts" && !isDir
            ? `<span class="fi-created">${fmtDate(f.created)}</span><span class="fi-updated">${fmtDateTime(f.updated)}</span>`
            : "") +
          (isDir ? "" : `<span class="fi-size">${fmtSize(f.size)}</span>`) +
          `<div class="fi-actions">${actions}</div>`;
        div.title = f.name; // 悬停显示完整文件名（含后缀）

        // 点击整行：目录进入、文件打开编辑（复选框与行内按钮不触发）
        div.onclick = (e) => {
          if (e.target.closest(".fi-check") || e.target.closest(".fi-act")) return;
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
  async function refreshCurrent() {
    const btns = [document.getElementById("refreshBtn"), document.getElementById("topRefreshBtn")].filter(Boolean);
    // 视觉反馈：图标旋转 + 列表区先回到「数据正在加载中…」，证明正在刷新
    btns.forEach((b) => b.classList.add("refreshing"));
    showListLoading();
    try {
      if (state.type === "gallery") await loadGallery();
      else await loadList();
    } finally {
      // 给旋转一个最短可见时间，避免极快响应时动画一闪而过（用户体验更佳）
      await new Promise((r) => setTimeout(r, 350));
      btns.forEach((b) => b.classList.remove("refreshing"));
    }
  }

  // 图库：集中展示 src/content/posts 下各子目录（如 123456、abcdefg 等图库分类）的资源
  let _galGroups = []; // 图库分类（含图片），供分类筛选下拉客户端过滤，避免每次切换都重新拉取 GitHub
  async function loadGallery() {
    const IMG_RE = /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i;
    try {
      state.files = []; // 重置：图库项也纳入 state.files，供批量删除按 path 查找
      const { data } = await api("/api/list?type=gallery");
      const top = (data && data.items) || [];
      const dirs = top.filter((f) => f.type === "dir");
      const groups = [];
      // 根目录下的非文章文件（如零散图片）归入「根目录」分组，避免被隐藏
      const rootFiles = top.filter((f) => f.type !== "dir" && !/\.(md|mdx)$/i.test(f.name));
      if (rootFiles.length) groups.push({ name: "根目录", items: rootFiles, root: true });
      for (const d of dirs) {
        try {
          const r = await api("/api/list?type=gallery&path=" + encodeURIComponent(d.name));
          groups.push({ name: d.name, items: r.data.items || [], root: false });
        } catch (e) {
          groups.push({ name: d.name, items: [], root: false, error: true });
        }
      }
      _galGroups = groups;
      renderGallery(groups, IMG_RE);
      refreshGalleryCatFilter();
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

  // 图库分类筛选：下拉选了某分类只显示该分类图片（纯客户端过滤，不重新拉取 GitHub）
  function refreshGalleryCatFilter() {
    const sel = $("galleryCatSel");
    if (!sel) return;
    if (state.type !== "gallery") { sel.hidden = true; return; }
    sel.hidden = false;
    const cur = sel.value;
    const names = _galGroups.map((g) => g.name);
    const opts = ['<option value="">全部分类</option>'].concat(
      names.map((n) => '<option value="' + esc(n) + '">' + esc(n) + "</option>")
    );
    sel.innerHTML = opts.join("");
    if (cur && names.indexOf(cur) >= 0) sel.value = cur;
    sel.onchange = applyGalleryCatFilter;
  }
  function applyGalleryCatFilter() {
    const sel = $("galleryCatSel");
    if (!sel) return;
    const v = sel.value;
    const groups = v ? _galGroups.filter((g) => g.name === v) : _galGroups;
    renderGallery(groups, /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i);
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
  // 将 ISO 时间渲染为「YYYY-MM-DD HH:mm」（按本地时区）
  function fmtDateTime(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function fmtDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
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
        state.postDataQuoted = parsed.quoted || {};
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
    // 资源上传面板：默认折叠（由 index.html 的 collapsed 类控制），
    // 仅在用户主动点击「上传」按钮（quickUploadBtn）时才展开，避免一直占用编辑区空间
    $("emptyState").hidden = true;
    $("editForm").hidden = false;
    $("deleteBtn").hidden = state.current.isNew;
    // 文件名输入框只填基础名（后缀由右侧 extSelect 下拉承载，避免重复显示）
    const baseDot = (name || "").lastIndexOf(".");
    $("fileName").value = baseDot > 0 ? name.slice(0, baseDot) : name;
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
    // Tab 栏：仅文章 / 动态类型显示「内容 ⇄ 文章信息」，默认停在「内容」最大化编辑区
    $("editorTabs").hidden = !(isPosts || isDynamic);
    $("tabMetaBtn").hidden = !isPosts;
    $("tabDynBtn").hidden = !isDynamic;
    switchEditorTab("content");
    // 触发编辑器重排，保证移动端高度正确
    window.dispatchEvent(new Event("resize"));
  }

  function renderPostFields(fm) {
    const box = $("postFields");
    box.innerHTML = "";
    // 顶部提示：字段名（如 title / password）由模板固定，管理系统不暴露为可编辑项，
    // 仅值的引号在后台隐藏、提交时自动补回，避免 password: 123456 这类类型错误。
    const hint = document.createElement("div");
    hint.className = "pf-hint";
    hint.innerHTML = '🔒 <b>字段名固定</b>，仅可修改值；字符串值的引号在后台隐藏，保存时自动补回。';
    box.appendChild(hint);
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
        wrap.className = "field" + (f.full ? " full" : "") + (f.span ? " s" + f.span : "") + (f.type === "checkbox" ? " checkbox" : "");
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
      // 初始 path 必须为「根名.子键」完整路径，否则 OBJ_ARRAY_SCHEMAS（如 sponsorConfig.sponsors）与
      // CONFIG_FIELD_ENUMS 枚举覆盖在顶层子项上永远匹配不上，导致对象数组没有增删改、枚举不生效。
      const cfgName = state.current && state.current.name ? state.current.name.replace(/\.ts$/i, "") : "";
      if (r.node.type === "object" && r.node.children && r.node.children.length) {
        r.node.children.forEach((ch) => sec.appendChild(cfgNodeEl(ch.value, ch.key, 0, r.name + "." + ch.key, cfgName)));
      } else {
        sec.appendChild(cfgNodeEl(r.node, r.name, 0, r.name, cfgName));
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
    // Strip leading commas from indentClose to prevent ,, / ,,,  (the serialization
    // already adds its own trailing comma; if the original source had trailing commas
    // baked into indentClose, they would accumulate on every save cycle).
    var cleanClose = indentClose.replace(/^,+,*/, "");
    var text;
    if (items.length === 0) text = "[" + cleanClose + "]";
    else text = "[" + indentItem + items.join("," + indentItem) + "," + cleanClose + "]";
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
    if (node.children.length > 8) {
      list.querySelectorAll(".cfg-obj-item").forEach((it, i) => {
        if (i >= 8) { it.classList.add("collapsed"); const tg = it.querySelector(".cfg-obj-toggle"); if (tg) tg.textContent = "▸"; }
      });
    }
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
    const children = (objNode && objNode.children) || [];
    // 有意义的标题：优先 name / type / title / cssVariable / label / id
    const titlePriority = ["name", "type", "title", "cssVariable", "label", "id"];
    let titleVal = "第 " + (idx + 1) + " 项";
    for (const k of titlePriority) {
      const c = children.find((x) => x.key === k);
      if (c && c.value && c.value.value != null && String(c.value.value).trim() !== "") {
        titleVal = String(c.value.value).replace(/^["']|["']$/g, "");
        break;
      }
    }
    const head = document.createElement("div");
    head.className = "cfg-obj-item-head";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "cfg-obj-toggle";
    toggle.textContent = "▾";
    toggle.title = "折叠/展开";
    const title = document.createElement("span");
    title.className = "cfg-obj-item-title";
    title.textContent = titleVal;
    const del = document.createElement("button");
    del.type = "button";
    del.className = "fi-act danger cfg-objarr-del";
    del.title = "删除此项";
    del.textContent = "🗑";
    head.appendChild(toggle);
    head.appendChild(title);
    head.appendChild(del);
    card.appendChild(head);
    const body = document.createElement("div");
    body.className = "cfg-obj-item-body";
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
      } else if (f.key === "icon") {
        inp = makeIconControl(raw != null ? String(raw) : "", null);
        const ri = inp.querySelector(".icon-input");
        ri.classList.add("cfg-obj-field");
        ri.dataset.fkey = f.key;
        ri.dataset.ftype = f.type;
      } else {
        inp = document.createElement("input");
        inp.type = "text";
        inp.className = "cfg-input cfg-obj-field";
        inp.value = raw != null ? String(raw) : "";
      }
      inp.dataset.fkey = f.key;
      inp.dataset.ftype = f.type;
      row.appendChild(inp);
      body.appendChild(row);
    });
    card.appendChild(body);
    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      card.classList.toggle("collapsed");
      toggle.textContent = card.classList.contains("collapsed") ? "▸" : "▾";
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

  function cfgNodeEl(node, keyLabel, depth, path, cfgName, opts) {
    opts = opts || {};
    if (node.type === "object" || node.type === "array") {
      // 对象数组（如 links / sponsors / friendsConfig / albums / playlist）：整块增删
      if (node.type === "array" && OBJ_ARRAY_SCHEMAS[path]) {
        return renderObjectArray(node, keyLabel, depth, path, cfgName);
      }
      // 嵌套扁平化：仅作用于字体配置（fontsList 的 options → variants → [0] → src 这类
      // 「单一子节点容器链」），跳过无意义的中间标题，直接下钻渲染最内层可编辑值，
      // 并把层级名拼到显示标签（如 options.variants[0].src）。保留真实源码 path 以保证保存偏移正确。
      // 限定 fontConfig 作用域，避免影响已稳定的其他配置布局。不扁平化对象数组 schema 与组件数组。
      const onlyChild = (node.children && node.children.length === 1) ? node.children[0] : null;
      const childIsContainer = onlyChild && (onlyChild.value.type === "object" || onlyChild.value.type === "array");
      const isCompArrRoot = node.type === "array" && /sidebarLayoutConfig\.(leftComponents|rightComponents|mobileBottomComponents)$/.test(path);
      if (cfgName === "fontConfig" && childIsContainer && !isCompArrRoot && !opts.comp) {
        const childKey = node.type === "array"
          ? (onlyChild.value.comment || (keyLabel + "[" + node.children.indexOf(onlyChild) + "]"))
          : onlyChild.key;
        const flatLabel = keyLabel ? (keyLabel + "." + childKey) : childKey;
        const childPath = path ? path + "." + childKey : childKey;
        return cfgNodeEl(onlyChild.value, flatLabel, depth, childPath, cfgName, opts);
      }
      // 侧边栏组件数组（leftComponents / rightComponents / mobileBottomComponents）：
      // 元素为「组件对象」，渲染为卡片（组件类型标题 + 启用状态）。沿用通用递归（偏移编辑），
      // 保证 specificConfig 等嵌套结构在保存时不被丢弃。
      const isCompArr = node.type === "array" && /sidebarLayoutConfig\.(leftComponents|rightComponents|mobileBottomComponents)$/.test(path);
      // 一级栏目：大标题；嵌套：子标题。靠缩进 + 折叠体现层级
      const block = document.createElement("div");
      const head = document.createElement("div");
      let collapsible = depth >= 1;
      if (opts.comp && depth === 1) {
        // 侧边栏组件卡片：以组件 type 为标题，附启用 / 停用状态徽章
        block.className = "cfg-component-card";
        head.className = "cfg-component-head";
        collapsible = true;
        const tChild = (node.children || []).find((c) => c.key === "type");
        const eChild = (node.children || []).find((c) => c.key === "enable");
        const typeVal = tChild && tChild.value && tChild.value.value != null ? String(tChild.value.value) : (keyLabel || "组件");
        const enabled = !(eChild && eChild.value && eChild.value.value === false);
        let inner = '<button type="button" class="cfg-collapse" title="折叠/展开">▾</button>';
        inner += '<span class="cfg-comp-type">' + esc(typeVal) + '</span>';
        inner += '<span class="cfg-comp-badge ' + (enabled ? "on" : "off") + '">' + (enabled ? "● 已启用" : "○ 已停用") + '</span>';
        head.innerHTML = inner;
      } else {
        block.className = depth === 0 ? "cfg-title-block" : "cfg-sub-block";
        head.className = depth === 0 ? "cfg-title" : "cfg-subtitle";
        const gname = node.comment || keyLabel;
        let inner = "";
        if (collapsible) inner += '<button type="button" class="cfg-collapse" title="折叠/展开">▾</button>';
        inner += lockIcon() + '<span class="cfg-g-title">' + esc(gname) + "</span>";
        if (node.comment) inner += lockChip(keyLabel);
        if (node.type === "array") inner += '<span class="cfg-tag">数组</span>';
        head.innerHTML = inner;
      }
      if (collapsible) {
        const tg = head.querySelector(".cfg-collapse");
        tg.addEventListener("click", (e) => {
          e.stopPropagation();
          block.classList.toggle("collapsed");
          tg.textContent = block.classList.contains("collapsed") ? "▸" : "▾";
        });
      }

      const body = document.createElement("div");
      body.className = "cfg-block-body";

      // 纯标量数组（如 keywords）：渲染为可增删的列表；仅当该数组在「允许增删」名单内才显示添加/删除按钮
      const allScalar = node.children.length === 0 || node.children.every((ch) =>
        ["string", "number", "boolean", "null"].indexOf(ch.value.type) >= 0);
      const addable = node.type === "array" && allScalar && SCALAR_ARRAY_ADDABLE.has(path);

      const bigArr = node.type === "array" && node.children.length > 6;
      node.children.forEach((ch) => {
        const childKey = node.type === "array"
          ? (ch.value.comment || (keyLabel + "[" + node.children.indexOf(ch) + "]"))
          : ch.key;
        const childPath = path ? path + "." + childKey : childKey;
        const childRow = cfgNodeEl(ch.value, childKey, depth + 1, childPath, cfgName, { comp: isCompArr });
        // specificConfig：仅有内容（非空对象）时默认展开，确保广告组件等专属配置「看得见、可编辑」；
        // 空对象 {} 才折叠（避免空块占位）。原逻辑对所有 specificConfig 强制折叠，导致广告内容不可见。
        if (childKey === "specificConfig") {
          const isEmpty = ch.value.type === "object" && (!ch.value.children || ch.value.children.length === 0);
          if (isEmpty) childRow.classList.add("collapsed");
        }
        if (bigArr && childRow.classList.contains("cfg-sub-block")) childRow.classList.add("collapsed");
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
        body.appendChild(childRow);
      });
      block.appendChild(head);
      block.appendChild(body);

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

    if (keyLabel === "icon") {
      const ctrl = makeIconControl(node.value != null ? node.value : "", null);
      const ri = ctrl.querySelector(".icon-input");
      ri.dataset.start = node.start;
      ri.dataset.end = node.end;
      ri.dataset.vtype = "string";
      if (node.quote) ri.dataset.quote = node.quote;
      row.appendChild(ctrl);
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

  // ----------------------------------------------------------------------
  // 图标选择器：仅暴露构建安全的 Iconify 集合，避免手动输错导致 Cloudflare 构建失败
  // 安全集合 = Firefly 主题实际安装的 @iconify-json/*（见博客仓库 package.json）
  // ----------------------------------------------------------------------
  const ICON_SAFE_COLLECTIONS = [
    { prefix: "fa7-brands", name: "Font Awesome 7 品牌" },
    { prefix: "fa7-solid", name: "Font Awesome 7 实心" },
    { prefix: "fa7-regular", name: "Font Awesome 7 常规" },
    { prefix: "material-symbols", name: "Material Symbols" },
    { prefix: "mingcute", name: "Mingcute" },
    { prefix: "simple-icons", name: "Simple Icons" },
    { prefix: "mdi", name: "Material Design Icons" },
    { prefix: "svg-spinners", name: "SVG Spinners" },
  ];
  const ICON_SAFE_PREFIXES = ICON_SAFE_COLLECTIONS.map((c) => c.prefix).join(",");
  // 常用图标（离线可用，覆盖社交品牌 + 常用 UI）。其余可用搜索框实时检索（同样限定安全集合）
  const ICON_COMMON = [
    "fa7-brands:github", "fa7-brands:weixin", "fa7-brands:weibo", "fa7-brands:qq", "fa7-brands:bilibili",
    "fa7-brands:zhihu", "fa7-brands:x-twitter", "fa7-brands:twitter", "fa7-brands:facebook", "fa7-brands:youtube",
    "fa7-brands:instagram", "fa7-brands:linkedin", "fa7-brands:telegram", "fa7-brands:discord", "fa7-brands:envelope",
    "fa7-brands:rss", "fa7-brands:link", "fa7-brands:alipay", "fa7-brands:tiktok", "fa7-brands:juejin",
    "fa7-brands:csdn", "fa7-brands:gitlab", "fa7-brands:docker", "fa7-brands:steam", "fa7-brands:spotify",
    "fa7-brands:paypal", "fa7-brands:google", "fa7-brands:microsoft", "fa7-brands:apple", "fa7-brands:cloudflare",
    "material-symbols:link", "material-symbols:home", "material-symbols:person", "material-symbols:settings",
    "material-symbols:favorite", "material-symbols:star", "material-symbols:share", "material-symbols:menu",
    "material-symbols:search", "material-symbols:add", "material-symbols:edit", "material-symbols:delete",
    "material-symbols:visibility", "material-symbols:code", "material-symbols:public", "material-symbols:language",
    "material-symbols:article", "material-symbols:image", "material-symbols:cloud", "material-symbols:download",
    "material-symbols:mail", "material-symbols:phone", "material-symbols:location-on", "material-symbols:schedule",
    "material-symbols:info", "material-symbols:check", "material-symbols:close", "material-symbols:menu-book",
    "material-symbols:account-circle", "material-symbols:dashboard", "material-symbols:bolt", "material-symbols:lightbulb",
    "material-symbols:category", "material-symbols:label", "material-symbols:bookmark", "material-symbols:history",
    "material-symbols:notifications", "material-symbols:lock", "material-symbols:key", "material-symbols:content-copy",
    "material-symbols:launch", "material-symbols:anchor", "material-symbols:group", "material-symbols:hub",
    "material-symbols:rocket-launch", "material-symbols:trending-up", "material-symbols:insights", "material-symbols:description",
    "material-symbols:folder", "material-symbols:camera", "material-symbols:videocam", "material-symbols:mic",
    "material-symbols:music-note", "material-symbols:play-arrow", "material-symbols:forum", "material-symbols:chat",
    "material-symbols:comment", "material-symbols:thumb-up", "material-symbols:calendar-month", "material-symbols:event",
    "material-symbols:flag", "material-symbols:workspace-premium", "material-symbols:auto-awesome", "material-symbols:payments",
    "material-symbols:paid", "material-symbols:currency-yuan", "material-symbols:shopping-cart", "material-symbols:store",
    "material-symbols:local-shipping", "material-symbols:map", "material-symbols:explore", "material-symbols:restaurant",
    "material-symbols:eco", "material-symbols:volunteer-activism", "material-symbols:emoji-events",
    "fa7-solid:link", "fa7-solid:home", "fa7-solid:user", "fa7-solid:gear", "fa7-solid:envelope",
    "fa7-solid:phone", "fa7-solid:location-dot", "fa7-solid:clock", "fa7-solid:circle-info", "fa7-solid:xmark",
    "fa7-solid:bars", "fa7-solid:star", "fa7-solid:heart", "fa7-solid:image", "fa7-solid:file",
    "fa7-solid:folder", "fa7-solid:download", "fa7-solid:upload", "fa7-solid:eye", "fa7-solid:code",
    "fa7-solid:bolt", "fa7-solid:lightbulb", "fa7-solid:tag", "fa7-solid:bookmark", "fa7-solid:bell",
    "fa7-solid:lock", "fa7-solid:copy", "fa7-solid:arrow-left", "fa7-solid:users", "fa7-solid:comment",
    "fa7-solid:calendar", "fa7-solid:cloud", "fa7-solid:rocket", "fa7-solid:chart-line", "fa7-solid:camera",
    "fa7-solid:video", "fa7-solid:microphone", "fa7-solid:music", "fa7-solid:handshake", "fa7-solid:credit-card",
    "fa7-solid:cart-shopping", "fa7-solid:store", "fa7-solid:globe", "fa7-solid:wrench", "fa7-solid:leaf",
    "fa7-solid:gift", "fa7-solid:paintbrush", "fa7-solid:palette",
    "mingcute:home-2-line", "mingcute:user-2-line", "mingcute:settings-3-line", "mingcute:edit-line", "mingcute:delete-2-line",
    "mingcute:search-line", "mingcute:link-line", "mingcute:mail-line", "mingcute:phone-line", "mingcute:location-line",
    "mingcute:time-line", "mingcute:information-line", "mingcute:check-line", "mingcute:close-line", "mingcute:menu-line",
    "mingcute:share-line", "mingcute:star-line", "mingcute:heart-line", "mingcute:image-line", "mingcute:file-line",
    "mingcute:folder-line", "mingcute:download-line", "mingcute:upload-line", "mingcute:eye-line", "mingcute:code-line",
    "mdi:home", "mdi:cog", "mdi:link", "mdi:email", "mdi:phone", "mdi:map-marker", "mdi:clock", "mdi:information",
    "mdi:check", "mdi:close", "mdi:menu", "mdi:share", "mdi:star", "mdi:heart", "mdi:image", "mdi:file",
    "mdi:folder", "mdi:download", "mdi:upload", "mdi:eye", "mdi:code", "mdi:github", "mdi:wechat", "mdi:weibo",
    "mdi:qqchat", "mdi:bilibili", "mdi:zhihu",
  ];

  function iconImgUrl(prefix, name, h) {
    return "https://api.iconify.design/" + encodeURIComponent(prefix) + "/" + encodeURIComponent(name) + ".svg?height=" + (h || 22);
  }

  // 生成一个图标输入控件：预览 + 文本框（可手动输入）+ 选择按钮。onCommit(v) 在值变化时回调
  function makeIconControl(value, onCommit) {
    const wrap = document.createElement("div");
    wrap.className = "icon-control";
    const preview = document.createElement("span");
    preview.className = "icon-preview";
    const inp = document.createElement("input");
    inp.type = "text";
    inp.className = "cfg-input icon-input";
    inp.value = value != null ? value : "";
    inp.placeholder = "如 material-symbols:link";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn ghost sm icon-pick";
    btn.textContent = "🎨 选择";
    btn.title = "从图标库选择（仅构建安全的图标集合）";
    function updatePreview() {
      const v = (inp.value || "").trim();
      const idx = v.indexOf(":");
      if (idx > 0) {
        const p = v.slice(0, idx), n = v.slice(idx + 1);
        preview.innerHTML = '<img src="' + iconImgUrl(p, n, 22) + '" alt="" onerror="this.style.visibility=\'hidden\'">';
        preview.classList.remove("empty");
      } else {
        preview.textContent = v ? "🔤" : "🚫";
        preview.classList.add("empty");
      }
    }
    inp.addEventListener("input", () => { updatePreview(); if (onCommit) onCommit(inp.value); });
    btn.addEventListener("click", () => openIconPicker(inp.value, (v) => { inp.value = v; updatePreview(); if (onCommit) onCommit(v); }));
    updatePreview();
    wrap.appendChild(preview);
    wrap.appendChild(inp);
    wrap.appendChild(btn);
    return wrap;
  }

  let _iconPickerEl = null;

  function buildIconPicker() {
    const modal = document.createElement("div");
    modal.className = "icon-picker-modal";
    modal.hidden = true;
    modal.innerHTML =
      '<div class="ip-backdrop"></div>' +
      '<div class="ip-dialog" role="dialog" aria-modal="true">' +
        '<div class="ip-header"><span>🎨 选择图标<span class="ip-sub">仅显示构建安全的集合</span></span>' +
          '<button type="button" class="ip-close" title="关闭">✕</button></div>' +
        '<div class="ip-toolbar">' +
          '<select class="ip-collection" title="图标集合">' +
            '<option value="">全部集合（混合）</option>' +
            ICON_SAFE_COLLECTIONS.map((c) => '<option value="' + c.prefix + '">' + c.name + "（" + c.prefix + "）</option>").join("") +
          "</select>" +
          '<input class="ip-search" type="text" placeholder="搜索图标，如 link / github / 主页 …">' +
        "</div>" +
        '<div class="ip-body">' +
          '<div class="ip-section"><div class="ip-section-title">常用图标</div><div class="ip-grid ip-common-grid"></div></div>' +
          '<div class="ip-section"><div class="ip-section-title">搜索结果 <span class="ip-search-info"></span></div><div class="ip-grid ip-result-grid"></div></div>' +
        "</div>" +
        '<div class="ip-footer">' +
          '<span class="ip-current">当前：<b class="ip-current-val">—</b></span>' +
          '<span class="ip-spacer"></span>' +
          '<button type="button" class="btn ghost sm ip-clear">清除</button>' +
          '<button type="button" class="btn primary sm ip-ok">使用此图标</button>' +
        "</div>" +
      "</div>";
    document.body.appendChild(modal);
    modal._selected = "";
    modal._onPick = null;
    modal.querySelector(".ip-close").addEventListener("click", () => closeIconPicker(modal));
    modal.querySelector(".ip-backdrop").addEventListener("click", () => closeIconPicker(modal));
    modal.querySelector(".ip-clear").addEventListener("click", () => {
      modal._selected = "";
      modal.querySelector(".ip-current-val").textContent = "—";
      renderPickerSelection(modal);
    });
    modal.querySelector(".ip-ok").addEventListener("click", () => {
      if (modal._onPick) modal._onPick(modal._selected || "");
      closeIconPicker(modal);
    });
    let t;
    modal.querySelector(".ip-search").addEventListener("input", () => {
      clearTimeout(t);
      t = setTimeout(() => doIconSearch(modal), 300);
    });
    modal.querySelector(".ip-collection").addEventListener("change", () => {
      renderIconCommon(modal);
      if (modal.querySelector(".ip-search").value.trim()) doIconSearch(modal);
    });
    renderIconCommon(modal);
    return modal;
  }

  function renderIconCommon(modal) {
    const grid = modal.querySelector(".ip-common-grid");
    grid.innerHTML = "";
    const sel = modal.querySelector(".ip-collection") ? modal.querySelector(".ip-collection").value : "";
    const list = sel ? ICON_COMMON.filter((f) => f.indexOf(sel + ":") === 0) : ICON_COMMON;
    list.forEach((full) => {
      const sp = full.indexOf(":");
      const p = full.slice(0, sp), n = full.slice(sp + 1);
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "ip-cell";
      cell.title = full;
      cell.innerHTML = '<img src="' + iconImgUrl(p, n, 20) + '" alt="" onerror="this.style.visibility=\'hidden\'"><span>' + esc(n) + "</span>";
      cell.addEventListener("click", () => selectIcon(modal, full));
      grid.appendChild(cell);
    });
  }

  function doIconSearch(modal) {
    const q = modal.querySelector(".ip-search").value.trim();
    const info = modal.querySelector(".ip-search-info");
    const grid = modal.querySelector(".ip-result-grid");
    if (!q) { grid.innerHTML = ""; info.textContent = ""; return; }
    info.textContent = "搜索中…";
    const sel = modal.querySelector(".ip-collection") ? modal.querySelector(".ip-collection").value : "";
    const prefixes = sel || ICON_SAFE_PREFIXES;
    const url = "https://api.iconify.design/search?query=" + encodeURIComponent(q) + "&prefixes=" + prefixes + "&limit=80";
    fetch(url).then((r) => r.json()).then((data) => {
      const icons = (data && data.icons) || [];
      grid.innerHTML = "";
      if (!icons.length) { info.textContent = "（无结果）"; return; }
      info.textContent = "（" + icons.length + " 个）";
      icons.forEach((full) => {
        const sp = full.indexOf(":");
        const p = full.slice(0, sp), n = full.slice(sp + 1);
        const cell = document.createElement("button");
        cell.type = "button";
        cell.className = "ip-cell";
        cell.title = full;
        cell.innerHTML = '<img src="' + iconImgUrl(p, n, 20) + '" alt="" onerror="this.style.visibility=\'hidden\'"><span>' + esc(n) + "</span>";
        cell.addEventListener("click", () => selectIcon(modal, full));
        grid.appendChild(cell);
      });
    }).catch(() => { info.textContent = "（网络不可用，可手动输入）"; });
  }

  function selectIcon(modal, full) {
    modal._selected = full;
    modal.querySelector(".ip-current-val").textContent = full;
    renderPickerSelection(modal);
  }
  function renderPickerSelection(modal) {
    modal.querySelectorAll(".ip-cell.selected").forEach((c) => c.classList.remove("selected"));
    if (!modal._selected) return;
    modal.querySelectorAll(".ip-cell").forEach((c) => { if (c.title === modal._selected) c.classList.add("selected"); });
  }
  function openIconPicker(initial, onPick) {
    if (!_iconPickerEl) _iconPickerEl = buildIconPicker();
    const modal = _iconPickerEl;
    modal._onPick = onPick;
    modal._selected = (initial && initial.indexOf(":") > 0) ? initial : "";
    modal.querySelector(".ip-current-val").textContent = modal._selected || "—";
    const col = modal.querySelector(".ip-collection"); if (col) col.value = "";
    modal.querySelector(".ip-search").value = "";
    modal.querySelector(".ip-result-grid").innerHTML = "";
    modal.querySelector(".ip-search-info").textContent = "";
    renderIconCommon(modal);
    renderPickerSelection(modal);
    modal.hidden = false;
  }
  function closeIconPicker(modal) { modal.hidden = true; }

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
    let ctrl;
    if (label.indexOf("图标") >= 0) {
      ctrl = makeIconControl(value, (v) => onChange(v));
    } else {
      const inp = document.createElement("input");
      inp.type = type || "text";
      inp.className = "cfg-input";
      inp.value = value != null ? value : "";
      inp.oninput = () => onChange(inp.value);
      ctrl = inp;
    }
    wrap.appendChild(lab);
    wrap.appendChild(ctrl);
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
          const parsedFm = parseFrontmatter(raw);
          const data = parsedFm.data;
          const body = parsedFm.body;
          if (state.type === "posts") {
            state.postData = data;
            state.postDataQuoted = parsedFm.quoted || {};
            renderPostFields(data);
          } else if (state.type === "dynamic") {
            state.postDataQuoted = parsedFm.quoted || {};
            $("dynPublished").value = dateToInput(data.published || "");
            $("dynLocation").value = data.location || "";
          } else {
            state.postData = data;
            state.postDataQuoted = parsedFm.quoted || {};
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
      return serializeFrontmatter(collectPostData(), getBodyMarkdown(), state.postDataQuoted);
    }
    if (state.type === "dynamic") {
      const data = {};
      const pub = inputToDateStr($("dynPublished").value, true);
      if (pub) data.published = pub;
      const loc = $("dynLocation").value.trim();
      if (loc) data.location = loc;
      return serializeFrontmatter(data, getBodyMarkdown(), state.postDataQuoted);
    }
    // spec：保留原始 frontmatter + 富文本正文
    return serializeFrontmatter(state.postData || {}, getBodyMarkdown(), state.postDataQuoted);
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
      message: (state.current.isNew ? "Create " : "Update ") + path + " Chrome FFCMS",
    };
    setStatus("上传至 GitHub 中，请等待…");
    okPopup("⏳ 上传至 GitHub 中，请等待…", true);
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
        setStatus("已保存，GitHub 自动部署中");
        okPopup("✅ 已保存，GitHub 自动部署中");
      } else {
        const errMsg = (data && (data.error || data.message)) || "保存失败";
        setStatus(errMsg, "err");
        okPopup("❌ " + errMsg, false);
      }
    } catch (e) {
      setStatus(e.message || "保存失败", "err");
      okPopup("❌ " + (e.message || "保存失败"), false);
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
          message: "Delete " + state.current.path + " Chrome FFCMS",
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
    $("infoView").hidden = name !== "info";
    $("overviewView").hidden = name !== "overview";
    $("backupView").hidden = name !== "backup";
    $("restoreView").hidden = name !== "restore";
  }

  function backToEmpty() {
    state.current = null;
    state.selected.clear();
    $("editForm").hidden = true;
    $("emptyState").hidden = true;
    showView("content");
    updateBatchCount();
  }

  // 内容板块（文章 / 动态 / 单页 / 图库）数据未返回前，先提示「数据正在加载中…」
  function showListLoading() {
    const box = $("fileList");
    if (box) {
      box.innerHTML = '<div class="list-loading">加载中，请稍等...</div>';
    }
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
      if (!isDir) items.push({ label: "🏷️ 重命名", action: () => renameItem(item) });
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
          // 重命名同步：输入框只填基础名，后缀由锁定下拉承载
          const ndot = (newName || "").lastIndexOf(".");
          $("fileName").value = ndot > 0 ? newName.slice(0, ndot) : newName;
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
        await refreshUploadDirOptions();
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

  // 上传落点：读取底部「资源上传」面板的文件夹下拉，拼接为完整仓库相对路径。
  // 每个内容板块（文章/动态/单页/图库）互不影响，上传到各自板块下所选子目录，根目录即板块根。
  function uploadTargetDir() {
    const sel = $("uploadDirSel");
    const sub = sel && sel.value ? sel.value : "";
    // 图库资料实际位于 src/content/posts 下的子文件夹（如 123456、abcdefg），故 gallery 落点用 posts 而非独立目录
    const base = state.type === "gallery" ? CONTENT_ROOT + "/posts" : CONTENT_ROOT + "/" + state.type;
    return sub ? base + "/" + sub : base;
  }

  // 内容板块对应的中文名（用于上传面板标题）
  const UPLOAD_SECTION_NAMES = { posts: "文章内容", dynamic: "我的动态", spec: "页面信息", gallery: "图库素材" };

  // 进入/切换内容板块时刷新文件夹下拉，并同步标题与目标路径提示
  async function refreshUploadDirOptions() {
    const sel = $("uploadDirSel");
    const titleEl = $("uploadTitle");
    const hintEl = $("uploadTarget");
    const t = state.type;
    if (titleEl) titleEl.textContent = (UPLOAD_SECTION_NAMES[t] || "资源") + " · 资源上传";
    if (!sel) return;
    const isContent = ["posts", "dynamic", "spec", "gallery"].includes(t);
    if (!isContent) {
      sel.innerHTML = '<option value="">根目录（当前板块）</option>';
      if (hintEl) hintEl.textContent = "当前板块根目录";
      return;
    }
    sel.innerHTML = '<option value="">根目录（当前板块）</option>';
    sel.value = "";
    if (hintEl) hintEl.textContent = uploadTargetDir();
    try {
      const { data } = await api("/api/list?type=" + t);
      const dirs = ((data && data.items) || []).filter((f) => f.type === "dir").map((f) => f.name);
      let html = '<option value="">根目录（当前板块）</option>';
      html += dirs.map((d) => '<option value="' + esc(d) + '">📁 ' + esc(d) + "</option>").join("");
      sel.innerHTML = html;
      sel.value = "";
      if (hintEl) hintEl.textContent = uploadTargetDir();
    } catch (e) { /* 目录暂不存在或读取失败：保留根目录选项即可 */ }
  }

  async function handleFiles(files) {
    if (!files || !files.length) return;
    // 统一路径：读取面板所选文件夹，上传到当前板块（文章/动态/单页/图库）下对应目录
    const dir = uploadTargetDir();
    for (const f of files) await uploadFileToDir(f, dir);
    if (state.type === "gallery") await loadGallery();
    else await refreshCurrent();
    await refreshUploadDirOptions();
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
  // 配置子菜单映射：功能配置 / 页面配置 / 扩展功能 提升为与「配置」平级的左侧导航
  const CFG_GROUP_FOR_TYPE = { cfgfunc: "功能配置", cfgpage: "页面配置", cfgext: "扩展功能" };

  // 切换板块：左侧导航选中，右侧显示对应视图（内容列表 / 站点外观 / 配置）
  function selectSection(type) {
    state.sectionType = type; // 记录真实点击的一级菜单，供导航去重（功能/页面/扩展/基础配置均映射为 config）
    const cfgGroupType = CFG_GROUP_FOR_TYPE[type];
    state.type = cfgGroupType ? "config" : type;
    state.cfgGroup = cfgGroupType || null;
    state.subdir = "";
    document.querySelectorAll("#navBar .nav-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.type === type);
    });
    // 选中非概览板块时，自动展开其所属分组，确保当前项可见（若用户在折叠态下点击收藏/卡片直达）
    if (type !== "overview") {
      const btn = document.querySelector('#navBar .nav-btn[data-type="' + CSS.escape(type) + '"]');
      const grp = btn && btn.closest(".nav-group.collapsible");
      if (grp && grp.classList.contains("collapsed")) {
        grp.classList.remove("collapsed");
        const tog = grp.querySelector(".nav-group-toggle");
        if (tog) tog.setAttribute("aria-expanded", "true");
        const name = grp.dataset.group || "";
        try {
          const cur = JSON.parse(localStorage.getItem("ffNavGroups") || "{}") || {};
          cur[name] = false;
          localStorage.setItem("ffNavGroups", JSON.stringify(cur));
        } catch (e) { /* 忽略 */ }
      }
    }
    const titles = { overview: "数据概览", posts: "文章内容", dynamic: "我的动态", spec: "页面信息", gallery: "图库素材", config: "基础配置", cfgfunc: "功能配置", cfgpage: "页面配置", cfgext: "扩展功能", readme: "操作说明", about: "关于", backup: "数据备份" };
    $("ctTitle").textContent = titles[type] || type;
    // 配置类（含三个独立配置菜单）：禁止新建文件 / 批量删除 / 全选 / 上传 / 新建分类
    const isConfig = state.type === "config";
    const isGallery = type === "gallery";
    const _gcs = $("galleryCatSel"); if (_gcs && !isGallery) _gcs.hidden = true;
    const isOverview = type === "overview";
    // 图库：启用 上传 / 新建分类 / 全选 / 批量删除（每项自带删除按钮）；隐藏 新建文件 与 搜索框
    $("selectAllRow").hidden = isConfig || isOverview;
    $("batchDelBtn").hidden = isConfig || isOverview;
    $("newBtn").hidden = isConfig || isGallery || isOverview;
    $("quickUploadBtn").hidden = isConfig || isOverview;
    $("newCatBtn").hidden = isConfig || isOverview;
    $("searchInput").hidden = isConfig || isGallery || isOverview;
    $("refreshBtn").hidden = isConfig || isGallery || isOverview;
    if (isGallery || isOverview) $("searchInput").value = "";

    state.selected.clear();

    // 概览：后台首页，统计博客数据（文章 / 动态数量等）
    if (isOverview) {
      showView("overview");
      loadOverview();
      return;
    }

    if (isConfig) {
      showView("config");
      // 左侧分类导航 + 右侧配置编辑（含站点资源：Logo / 头像）
      loadConfigNav(state.cfgGroup);
      return;
    }
    // 信息类菜单：操作说明（README）/ 关于——独立于内容与配置视图，点击直接显示内容
    if (type === "readme" || type === "about") {
      const isReadme = type === "readme";
      $("infoReadme").hidden = !isReadme;
      $("infoAbout").hidden = isReadme;
      showView("info");
      if (isReadme) loadInfoReadme();
      return;
    }
    // 数据安全：数据备份
    if (type === "backup") {
      showView("backup");
      loadBackupView();
      return;
    }
    // 数据安全：数据恢复（独立菜单）
    if (type === "restore") {
      showView("restore");
      loadRestoreView();
      return;
    }
    if (type === "gallery") {
      showView("content");
      backToEmpty();
      showListLoading();
      loadGallery();
      refreshUploadDirOptions();
      return;
    }
    showView("content");
    backToEmpty();
    showListLoading();
    loadList();
    refreshUploadDirOptions();
  }

  // ----------------------------------------------------------------------
  // 概览（后台首页）：统计博客数据（文章 / 动态数量等）+ 最新内容
  // ----------------------------------------------------------------------
  async function loadOverview(isManual) {
    const loading = $("ovLoading");
    const stats = $("ovStats");
    const recent = $("ovRecent");
    const ovBtn = $("ovRefreshBtn");
    const spinning = isManual && ovBtn; // 仅手动刷新时旋转图标（首次加载已有 loading 文案）
    if (spinning) ovBtn.classList.add("refreshing");
    loading.hidden = false;
    stats.hidden = true;
    recent.hidden = true;
    $("ovRepo").textContent = `${state.owner}/${state.repo}@${state.branch}`;
    if (ovBtn) ovBtn.onclick = () => loadOverview(true);

    // 并行拉取各板块列表（任意失败不影响其余统计）
    const fetchList = async (type) => {
      try {
        const { data } = await api("/api/list?type=" + type);
        return Array.isArray(data.items) ? data.items : [];
      } catch (e) {
        return [];
      }
    };
    const [posts, dynamics, specs, configs] = await Promise.all([
      fetchList("posts"),
      fetchList("dynamic"),
      fetchList("spec"),
      fetchList("config"),
    ]);

    const postFiles = posts.filter((it) => it.type === "file");
    const postDirs = posts.filter((it) => it.type === "dir"); // 图库分类（images / guide 等）
    const dynFiles = dynamics.filter((it) => it.type === "file");
    const specFiles = specs.filter((it) => it.type === "file");
    const cfgFiles = configs.filter((it) => it.type === "file" && it.name !== "index.ts");

    const cards = [
      { ico: "📝", label: "文章内容", value: postFiles.length, type: "posts", action: "posts" },
      { ico: "⚡", label: "我的动态", value: dynFiles.length, type: "dynamic", action: "dynamic" },
      { ico: "📄", label: "页面信息", value: specFiles.length, type: "spec", action: "spec" },
      { ico: "🖼️", label: "图库分类", value: postDirs.length, type: "gallery", action: "gallery" },
      { ico: "⚙️", label: "站点配置", value: cfgFiles.length, type: "config", action: "config" },
    ];
    stats.innerHTML = cards
      .map(
        (c) =>
          `<button class="ov-card" type="button" data-go="${c.action}">` +
          `<span class="ov-card-ico">${c.ico}</span>` +
          `<span class="ov-card-val">${c.value}</span>` +
          `<span class="ov-card-label">${c.label}</span>` +
          `</button>`
      )
      .join("");
    // 点击统计卡片跳转到对应板块
    stats.querySelectorAll(".ov-card").forEach((card) => {
      card.addEventListener("click", () => selectSection(card.dataset.go));
    });

    // 最新文章（按创建日期降序，取前 6）
    const recentPosts = postFiles
      .filter((it) => /\.(md|mdx)$/i.test(it.name))
      .sort((a, b) => {
        const ta = a.created ? new Date(a.created).getTime() : 0;
        const tb = b.created ? new Date(b.created).getTime() : 0;
        return tb - ta;
      })
      .slice(0, 6);
    renderRecentList($("ovPosts"), recentPosts, "posts", "暂无文章");

    // 最新动态（按文件名降序兜底，取前 6；动态文件通常按时间命名）
    const recentDyn = dynFiles
      .slice()
      .sort((a, b) => (b.name || "").localeCompare(a.name || ""))
      .slice(0, 6);
    renderRecentList($("ovDynamic"), recentDyn, "dynamic", "暂无动态");

    loading.hidden = true;
    stats.hidden = false;
    if ($("ovInfo")) $("ovInfo").hidden = false;
    recent.hidden = false;
    if (ovBtn && spinning) ovBtn.classList.remove("refreshing");
  }

  // 渲染「最新内容」列表（点击直接打开对应文章 / 动态）
  function renderRecentList(ul, items, type, emptyText) {
    if (!ul) return;
    if (!items.length) {
      ul.innerHTML = '<li class="ov-empty">' + emptyText + "</li>";
      return;
    }
    ul.innerHTML = items
      .map((it) => {
        const isDir = it.type === "dir";
        const date = it.created ? fmtDate(it.created) : "";
        return (
          '<li class="ov-item" data-path="' +
          esc(it.path) +
          '" data-name="' +
          esc(it.name) +
          '" data-dir="' +
          (isDir ? "1" : "0") +
          '">' +
          '<span class="ov-item-name">' +
          esc(it.name) +
          "</span>" +
          (date ? '<span class="ov-item-date">' + date + "</span>" : "") +
          "</li>"
        );
      })
      .join("");
    ul.querySelectorAll(".ov-item").forEach((li) => {
      li.addEventListener("click", () => {
        const path = li.dataset.path;
        const name = li.dataset.name;
        const isDir = li.dataset.dir === "1";
        if (isDir) {
          selectSection(type);
          // 进入对应板块并定位子目录
          state.subdir = path.replace(/^src\/content\/(posts|dynamic|spec)\//, "");
          loadList();
          return;
        }
        openFile({ name, path, type: "file" });
      });
    });
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
      // 顶层子项初始 path 用「根名.子键」完整路径（理由同 renderConfigEditor）
      if (r.node.type === "object" && r.node.children && r.node.children.length) {
        r.node.children.forEach((ch) => sec.appendChild(cfgNodeEl(ch.value, ch.key, 0, r.name + "." + ch.key, cfgName)));
      } else {
        sec.appendChild(cfgNodeEl(r.node, r.name, 0, r.name, cfgName));
      }
      host.appendChild(sec);
    });
  }

  // 配置保存已统一收敛到 saveCfgConfig（站点外观视图移除后，旧的 saveApConfig 不再使用）。

  // ----------------------------------------------------------------------
  // 保存成功弹窗
  // ----------------------------------------------------------------------
  let okPopupTimer = null;
  // hold=true 时为「等待模式」：持续显示不自动消失，等待后续调用替换
  function okPopup(msg, hold) {
    const el = $("okPopup");
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
    // 触发过渡
    requestAnimationFrame(() => el.classList.add("show"));
    clearTimeout(okPopupTimer);
    if (hold) return; // 保持显示，等待保存结果后替换
    okPopupTimer = setTimeout(() => {
      el.classList.remove("show");
      setTimeout(() => (el.hidden = true), 280);
    }, 2000);
  }

  // ----------------------------------------------------------------------
  // 高级模式（源码编辑）风险确认弹窗
  // ----------------------------------------------------------------------
  let pendingAdvName = null;
  function openAdvModal(name) {
    pendingAdvName = name;
    const m = $("advModal");
    if (m) { m.hidden = false; m.classList.add("show"); }
  }
  function closeAdvModal() {
    const m = $("advModal");
    if (m) { m.classList.remove("show"); m.hidden = true; }
    pendingAdvName = null;
  }
  function confirmAdvMode() {
    const name = pendingAdvName;
    closeAdvModal();
    if (!name) return;
    const st = apState[name];
    if (!st) return;
    st.advanced = true;
    // 导航栏在可视化模式可能有未保存的模型修改：进入高级模式前先序列化同步到 st.raw，
    // 否则高级模式展示的是旧源码，来回切换时用户会看到「修改消失」
    if (name === "navBarConfig" && st.navModel && !st.rawFallback) {
      try { st.raw = serializeNavBarCustom(st.navModel, st.raw); } catch (e) { /* 保持原样 */ }
    }
    renderCfgConfig(name);
  }
  // 从高级模式返回可视化编辑：捕获源码编辑内容，重新解析后切回表单（navBarConfig 用本地 raw 重新解析，不重新拉取远程，避免覆盖未保存修改）
  async function backToVisual(name) {
    const st = apState[name];
    const host = apHostFor(name, cfgPanesRoot());
    if (!st || !host) return;
    const ta = host.querySelector("textarea.cfg-raw");
    if (ta) st.raw = ta.value; // 保留源码视图中的修改
    if (name === "navBarConfig") {
      st.advanced = false;
      try {
        const model = parseNavBarCustom(st.raw);
        st.navModel = model || [];
        st.rawFallback = model === null;
      } catch (e) {
        st.navModel = [];
        st.rawFallback = true;
      }
      renderNavBarLinksEditor(host);
      // 导航栏有结构化模型：恢复高级模式入口（进入高级模式时被 renderCfgConfig 隐藏）
      const pane = cfgPanesRoot().querySelector('.ap-pane[data-pane="' + name + '"]');
      const advBtn = pane ? pane.querySelector(".ap-adv") : null;
      if (advBtn) advBtn.hidden = false;
      return;
    }
    if (st.ext === ".ts") {
      const parsed = FireflyConfig.parseConfig(st.raw);
      st.roots = parsed.roots;
    }
    st.advanced = false;
    renderCfgConfig(name);
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
      { key: "siteConfig", label: "站点基础", file: "siteConfig.ts" },
      { key: "navBarConfig", label: "导航栏", file: "navBarConfig.ts", custom: "navbar" },
	  { key: "announcementConfig", label: "公告通知", file: "announcementConfig.ts" },
      { key: "profileConfig", label: "用户资料", file: "profileConfig.ts" },
      { key: "backgroundWallpaper", label: "背景壁纸", file: "backgroundWallpaper.ts" },
      { key: "sidebarConfig", label: "侧边栏布局", file: "sidebarConfig.ts" },
	  { key: "footerConfig", label: "页脚配置", file: "footerConfig.ts", merged: true },
    ]},
    { title: "功能配置", items: [
      { key: "fontConfig", label: "字体配置", file: "fontConfig.ts" },
      { key: "commentConfig", label: "评论配置", file: "commentConfig.ts" },
      { key: "coverImageConfig", label: "封面图", file: "coverImageConfig.ts" },
      { key: "musicConfig", label: "音乐播放器", file: "musicConfig.ts" },
	  { key: "analyticsConfig", label: "统计分析", file: "analyticsConfig.ts" },
      { key: "plantumlConfig", label: "PlantUML 图表", file: "plantumlConfig.ts" },
      { key: "mermaidConfig", label: "Mermaid图表", file: "mermaidConfig.ts" },
    ]},
    { title: "页面配置", items: [
      { key: "friendsConfig", label: "友情链接", file: "friendsConfig.ts" },
      { key: "galleryConfig", label: "相册配置", file: "galleryConfig.ts" },
      { key: "sponsorConfig", label: "打赏配置", file: "sponsorConfig.ts" },
      { key: "booknavConfig", label: "书签导航", file: "booknavConfig.ts" },
    ]},
    { title: "扩展功能", items: [
      { key: "displaySettingsConfig", label: "显示设置", file: "displaySettingsConfig.ts" },
	  { key: "dynamicConfig", label: "动态页面", file: "dynamicConfig.ts" },
      { key: "expressiveCodeConfig", label: "代码高亮", file: "expressiveCodeConfig.ts" },
	  { key: "effectsConfig", label: "动画特效", file: "effectsConfig.ts" },
      { key: "pioConfig", label: "看板娘", file: "pioConfig.ts" },
	  { key: "licenseConfig", label: "许可证", file: "licenseConfig.ts" },
    ]},
  ];

  // ===== 导航栏自定义链接编辑器（navBarConfig.ts） =====
  // navBarConfig.ts 是函数式构建（getDynamicNavBarConfig），无法用通用配置编辑器安全编辑，
  // 因此单独管理其中「// 自定义导航栏链接」区域（自定义分组 + 子链接）的增删改。
  const NAVBAR_START = "FFCMS:NAVBAR_CUSTOM_START";
  const NAVBAR_END = "FFCMS:NAVBAR_CUSTOM_END";

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
  // 解析 navBarConfig.ts 中的 LinkPresets 预设定义 → { 键: 对象 }
  function parseLinkPresets(raw) {
    const m = raw.match(/export\s+const\s+LinkPresets[^=]*=\s*(\{[\s\S]*?\n\});/);
    if (!m) return {};
    const obj = parseTsValue(m[1]);
    return (obj && typeof obj === "object") ? obj : {};
  }
  // 将文本中的 LinkPresets.xxx 引用替换为内联 JSON 对象文本（用于整体 parseTsValue）
  function expandRefsInText(text, presetsMap) {
    return text.replace(/LinkPresets\.(\w+)/g, (all, name) => {
      const p = presetsMap[name];
      return p ? JSON.stringify(p) : "null";
    });
  }
  // 按顶层逗号分割数组元素文本（跳过字符串与嵌套括号）
  function splitTopLevelArray(arrText) {
    const parts = [];
    let depth = 0, start = 0, inStr = null;
    for (let i = 0; i < arrText.length; i++) {
      const c = arrText[i];
      if (inStr) { if (c === "\\") i++; else if (c === inStr) inStr = null; continue; }
      if (c === '"' || c === "'") { inStr = c; continue; }
      if (c === "{" || c === "[" || c === "(") depth++;
      else if (c === "}" || c === "]" || c === ")") depth--;
      else if (c === "," && depth === 0) { parts.push(arrText.slice(start, i).trim()); start = i + 1; }
    }
    parts.push(arrText.slice(start).trim());
    return parts.filter(Boolean);
  }
  // 解析单个导航项（分组或子链接）：支持 LinkPresets.xxx 引用 与 对象字面量
  function parseNavLinkItem(text, presetsMap) {
    const trimmed = text.trim();
    const refM = /^LinkPresets\.(\w+)$/.exec(trimmed);
    if (refM) {
      const p = presetsMap[refM[1]];
      if (!p) return null;
      return {
        preset: refM[1], name: p.name || refM[1], url: p.url || "#", icon: p.icon || "",
        pageKey: p.pageKey || "", external: !!p.external,
        children: Array.isArray(p.children) ? p.children.map((c) => ({
          preset: null, name: c.name || "", url: c.url || "", icon: c.icon || "",
          pageKey: c.pageKey || "", external: !!c.external,
        })) : [],
      };
    }
    // 对象字面量：把 children 段替换为占位符后再解析主体（避免剥离残留双逗号），
    // children 内的 LinkPresets.xxx 引用单独解析以保留引用语义
    let mainText = trimmed, childrenArrText = null;
    const ci = trimmed.indexOf("children:");
    if (ci !== -1) {
      const bi = trimmed.indexOf("[", ci);
      if (bi !== -1) {
        let depth = 0, end = -1, inStr = null;
        for (let i = bi; i < trimmed.length; i++) {
          const c = trimmed[i];
          if (inStr) { if (c === "\\") i++; else if (c === inStr) inStr = null; continue; }
          if (c === '"' || c === "'") { inStr = c; continue; }
          if (c === "[") depth++;
          else if (c === "]") { depth--; if (depth === 0) { end = i; break; } }
        }
        if (end !== -1) {
          childrenArrText = trimmed.slice(bi + 1, end);
          mainText = trimmed.slice(0, ci) + 'children: "__FF_NAV_CHILDREN__"' + trimmed.slice(end + 1);
        }
      }
    }
    const obj = parseTsValue(expandRefsInText(mainText, presetsMap));
    if (!obj || typeof obj !== "object") return null;
    const children = [];
    if (childrenArrText) {
      for (const item of splitTopLevelArray(childrenArrText)) {
        const clean = item.replace(/^\s*\/\/[^\n]*/gm, "").trim(); // 去掉行注释后再判断引用
        const refC = /^LinkPresets\.(\w+)$/.exec(clean);
        if (refC) {
          const p = presetsMap[refC[1]];
          if (p) children.push({ preset: refC[1], name: p.name || "", url: p.url || "", icon: p.icon || "", pageKey: p.pageKey || "", external: !!p.external });
          continue;
        }
        const co = parseTsValue(expandRefsInText(clean, presetsMap));
        if (co && typeof co === "object") children.push({
          preset: null, name: co.name || "", url: co.url || "", icon: co.icon || "",
          pageKey: co.pageKey || "", external: !!co.external,
        });
      }
    }
    return {
      preset: null, name: obj.name || "", url: obj.url || "#", icon: obj.icon || "",
      pageKey: obj.pageKey || "", external: !!obj.external, children,
    };
  }
  // 解析 navBarConfig.ts 中 getDynamicNavBarConfig 函数体的全部 links.push，返回分组数组
  // 覆盖整个构建函数（而非仅自定义标记区域），支持 LinkPresets.xxx 引用与对象字面量两种形式
  function parseNavBarCustom(raw) {
    const presetsMap = parseLinkPresets(raw);
    const firstPush = raw.indexOf("links.push(");
    if (firstPush === -1) return [];
    const ret = raw.indexOf("return { links }");
    const regionStart = raw.lastIndexOf("\n", firstPush) + 1;
    const regionEnd = ret === -1 ? raw.length : raw.lastIndexOf("\n", ret);
    if (regionEnd <= regionStart) return [];
    const region = raw.slice(regionStart, regionEnd);
    const groups = [];
    const re = /links\.push\(/g; let m;
    while ((m = re.exec(region))) {
      const ls = region.lastIndexOf("\n", m.index) + 1;
      const line = region.slice(ls, region.indexOf("\n", m.index));
      if (/^\s*\/\//.test(line)) continue; // 跳过被注释掉的 links.push
      const openIdx = m.index + m[0].length - 1;
      const inner = extractBalanced(region, openIdx);
      const g = parseNavLinkItem(inner, presetsMap);
      if (g) groups.push(g);
    }
    return groups;
  }
  // 将分组模型序列化回 navBarConfig.ts 的导航栏构建函数体
  // - 引用预设的分组/子项（preset 非空）输出 LinkPresets.xxx 保持模板结构
  // - 自定义对象输出内联对象字面量（保留 pageKey/external）
  function serializeNavBarCustom(model, raw) {
    const blocks = (model || []).map((g) => {
      if (g.preset) return "\tlinks.push(LinkPresets." + g.preset + ");";
      const children = (g.children || []).map((c) => {
        if (c.preset) return "\t\t\tLinkPresets." + c.preset;
        return "\t\t\t{\n" +
          "\t\t\t\tname: " + JSON.stringify(c.name || "") + ",\n" +
          "\t\t\t\turl: " + JSON.stringify(c.url || "") + ",\n" +
          (c.icon ? "\t\t\t\ticon: " + JSON.stringify(c.icon) + ",\n" : "") +
          (c.pageKey ? "\t\t\t\tpageKey: " + JSON.stringify(c.pageKey) + ",\n" : "") +
          "\t\t\t\texternal: " + (c.external ? "true" : "false") + "\n" +
          "\t\t\t}";
      }).join(",\n");
      let out = "\tlinks.push({\n" +
        "\t\tname: " + JSON.stringify(g.name || "") + ",\n" +
        "\t\turl: " + JSON.stringify(g.url || "#") + ",\n";
      if (g.icon) out += "\t\ticon: " + JSON.stringify(g.icon) + ",\n";
      if (g.pageKey) out += "\t\tpageKey: " + JSON.stringify(g.pageKey) + ",\n";
      if (children) out += "\t\t// 子菜单\n\t\tchildren: [\n" + children + "\n\t\t],\n";
      out += "\t});";
      return out;
    }).join("\n\n");
    // 替换整个构建函数体区域：第一个 links.push 行首 至 return { links } 行首
    const firstPush = raw.indexOf("links.push(");
    const ret = raw.indexOf("return { links }");
    const regionStart = firstPush === -1 ? raw.length : raw.lastIndexOf("\n", firstPush);
    const regionEnd = ret === -1 ? raw.length : raw.lastIndexOf("\n", ret);
    return raw.slice(0, regionStart) + "\n" + blocks + "\n" + raw.slice(regionEnd);
  }
  function nvField(label, obj, key, onEdit) {
    const d = document.createElement("label"); d.className = "nv-field";
    const s = document.createElement("span"); s.className = "nv-field-label"; s.textContent = label;
    let ctrl;
    if (key === "icon") {
      ctrl = makeIconControl(obj[key] || "", (v) => { obj[key] = v; if (onEdit) onEdit(); });
    } else {
      const inp = document.createElement("input"); inp.type = "text"; inp.value = obj[key] || ""; inp.className = "nv-input";
      inp.oninput = () => { obj[key] = inp.value; if (onEdit) onEdit(); };
      ctrl = inp;
    }
    d.appendChild(s); d.appendChild(ctrl); return d;
  }
  function nvFieldInline(label, obj, key, onEdit) {
    const d = document.createElement("div"); d.className = "nv-field-inline";
    const s = document.createElement("span"); s.textContent = label;
    let ctrl;
    if (key === "icon") {
      ctrl = makeIconControl(obj[key] || "", (v) => { obj[key] = v; if (onEdit) onEdit(); });
    } else {
      const inp = document.createElement("input"); inp.type = "text"; inp.value = obj[key] || ""; inp.className = "nv-input";
      inp.oninput = () => { obj[key] = inp.value; if (onEdit) onEdit(); };
      ctrl = inp;
    }
    d.appendChild(s); d.appendChild(ctrl); return d;
  }
  // 编辑时若该项是模板预设引用，则转为自定义对象（序列化时不再输出 LinkPresets.xxx）
  function detachPreset(obj) { if (obj && obj.preset) obj.preset = null; }
  // 预设徽章 HTML（模板预设引用标记）
  function nvPresetBadge(p) {
    if (!p) return "";
    const b = document.createElement("span");
    b.className = "nv-preset-badge";
    b.textContent = "🔗 模板预设 " + p;
    b.title = "引用模板 LinkPresets." + p + " 定义；编辑任意字段后将转为自定义（不再跟随模板更新）";
    return b;
  }
  async function loadNavBarConfig(host) {
    host.innerHTML = '<div class="cfg-empty">加载中，请稍等...</div>';
    try {
      const { status, data } = await api("/api/file?path=" + encodeURIComponent("src/config/navBarConfig.ts"));
      if (status !== 200 || data.content == null) { host.innerHTML = '<div class="cfg-empty">未找到 src/config/navBarConfig.ts</div>'; return; }
      let model = null;
      try { model = parseNavBarCustom(data.content); } catch (e) { model = null; }
      apState["navBarConfig"] = { raw: data.content, sha: data.sha, name: "navBarConfig", ext: ".ts", loaded: true, dirty: false, navModel: model || [], rawFallback: model === null };
      renderNavBarLinksEditor(host);
      if (model === null) {
        const warn = document.createElement("div"); warn.className = "nv-hint";
        warn.textContent = "⚠️ 导航栏构建函数解析失败，已切换为原始文本编辑（保存将直接写入文本）。";
        host.insertBefore(warn, host.firstChild);
        makeCodeEditor(host, data.content, () => markDirtyOf(host));
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
      warn.textContent = "⚠️ 导航栏构建函数解析失败，已切换为原始文本编辑。"; host.appendChild(warn);
      makeCodeEditor(host, st.raw || "", () => markDirtyOf(host));
      return;
    }
    const wrap = document.createElement("div"); wrap.className = "navlinks-editor";
    const hint = document.createElement("div"); hint.className = "nv-hint";
    hint.textContent = "可视化编辑导航栏全部链接：模板预设分组（🔗 标记）跟随模板定义，编辑任意字段后将转为自定义；自定义分组可自由增删改。子链接支持名称、网址、图标、页面标识（pageKey）与外链开关。";
    wrap.appendChild(hint);
    model.forEach((g, gi) => {
      const card = document.createElement("div"); card.className = "nv-group";
      const head = document.createElement("div"); head.className = "nv-group-head";
      const t = document.createElement("span"); t.className = "nv-group-title";
      t.textContent = g.preset ? "分组 " + (gi + 1) + "（模板预设）" : "分组 " + (gi + 1);
      head.appendChild(t);
      const badge = nvPresetBadge(g.preset);
      if (badge) head.appendChild(badge);
      const delG = document.createElement("button"); delG.type = "button"; delG.className = "btn ghost sm nv-del-group"; delG.textContent = "删除分组";
      delG.onclick = () => { model.splice(gi, 1); renderNavBarLinksEditor(host); };
      head.appendChild(delG); card.appendChild(head);
      card.appendChild(nvField("分组名称", g, "name", () => detachPreset(g)));
      card.appendChild(nvField("链接（一般为 #）", g, "url", () => detachPreset(g)));
      card.appendChild(nvField("图标（astro-icon 名称）", g, "icon", () => detachPreset(g)));
      card.appendChild(nvField("页面标识 pageKey（可选）", g, "pageKey", () => detachPreset(g)));
      const cw = document.createElement("div"); cw.className = "nv-children";
      const ct = document.createElement("div"); ct.className = "nv-children-title"; ct.textContent = "子链接"; cw.appendChild(ct);
      (g.children || (g.children = [])).forEach((c, ci) => {
        const row = document.createElement("div"); row.className = "nv-child-row";
        row.appendChild(nvFieldInline("名称", c, "name", () => detachPreset(c)));
        row.appendChild(nvFieldInline("网址", c, "url", () => detachPreset(c)));
        row.appendChild(nvFieldInline("图标", c, "icon", () => detachPreset(c)));
        const pageKeyInput = nvFieldInline("pageKey", c, "pageKey", () => detachPreset(c));
        pageKeyInput.style.display = c.pageKey ? "" : "none"; // 无 pageKey 时隐藏输入框
        row.appendChild(pageKeyInput);
        const extW = document.createElement("label"); extW.className = "nv-ext";
        const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = !!c.external; cb.onchange = () => { c.external = cb.checked; detachPreset(c); };
        extW.appendChild(cb); extW.appendChild(document.createTextNode("外链")); row.appendChild(extW);
        const badgeC = nvPresetBadge(c.preset);
        if (badgeC) row.appendChild(badgeC);
        const delC = document.createElement("button"); delC.type = "button"; delC.className = "btn ghost sm nv-del-child"; delC.textContent = "删除";
        delC.onclick = () => { g.children.splice(ci, 1); renderNavBarLinksEditor(host); };
        row.appendChild(delC);
        cw.appendChild(row);
      });
      const addC = document.createElement("button"); addC.type = "button"; addC.className = "btn ghost sm nv-add-child"; addC.textContent = "+ 添加子链接";
      addC.onclick = () => { g.children.push({ name: "", url: "", icon: "", pageKey: "", external: false }); renderNavBarLinksEditor(host); };
      cw.appendChild(addC); card.appendChild(cw);
      wrap.appendChild(card);
    });
    const addG = document.createElement("button"); addG.type = "button"; addG.className = "btn primary sm nv-add-group"; addG.textContent = "+ 添加自定义分组";
    addG.onclick = () => { model.push({ name: "新分组", url: "#", icon: "material-symbols:link", pageKey: "", children: [] }); renderNavBarLinksEditor(host); };
    wrap.appendChild(addG);
    host.appendChild(wrap);
  }

  async function loadConfigNav(groupFilter) {
    const scroll = $("cfgNavScroll");
    const panes = $("cfgPanes");
    if (!scroll || !panes) return;
    scroll.innerHTML = "";
    panes.innerHTML = '<div class="cfg-empty" id="cfgPanesLoading">加载中，请稍等...</div>';
    const headTitle = scroll.parentElement && scroll.parentElement.querySelector(".cfg-nav-title");
    if (headTitle) headTitle.textContent = groupFilter ? groupFilter : "配置分类";

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
        '<button class="btn ghost sm ap-adv" type="button" data-adv="' + esc(name) + '" title="以源码形式直接编辑该配置文件">⚙ 高级模式</button>' +
        '<button class="btn primary sm ap-save" type="button" data-save="' + esc(f.name) + '">💾 保存</button></div>' +
        '<div class="ap-cfg-host config-editor"></div>' +
        '<div class="ap-pane-status" data-status="' + esc(f.name) + '"></div>' +
        '<div class="ap-save-bar"><button class="btn primary ap-save" type="button" data-save="' + esc(f.name) + '">💾 保存配置</button></div>';
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
    // 分组筛选：配置菜单只显示「基础配置」；功能/页面/扩展菜单各只显示对应分组
    const groupsToRender = groupFilter
      ? CFG_NAV_GROUPS.filter((g) => g.title === groupFilter)
      : CFG_NAV_GROUPS.filter((g) => g.title === "基础配置");
    groupsToRender.forEach((g) => {
      const grpEl = document.createElement("div");
      grpEl.className = "cfg-nav-group";
      const title = document.createElement("div");
      title.className = "cfg-nav-group-title";
      title.textContent = g.title;
      if (groupFilter) title.style.display = "none"; // 单组菜单下隐藏冗余分组标题
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
    if (!groupFilter && otherFiles.length) {
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
    // 进入配置页默认选中第一个导航项（原「操作说明」已移至主菜单）
    const _ld = panes.querySelector("#cfgPanesLoading");
    if (_ld) _ld.remove();
    const firstItem = scroll.querySelector(".cfg-nav-item");
    if (firstItem) selectCfgTab(firstItem.dataset.cfg);
  }

  function selectCfgTab(name) {
    document.querySelectorAll("#cfgNav .cfg-nav-item").forEach((b) => b.classList.toggle("active", b.dataset.cfg === name));
    const resource = $("cfgResource");
    const panes = $("cfgPanes");
    // 站点资源（Logo / 头像）：从「站点外观」合并而来，仅图片上传，不读取结构化配置
    if (name === "logo" || name === "avatar") {
      if (resource) resource.hidden = false;
      if (panes) { panes.hidden = true; panes.querySelectorAll(".ap-pane").forEach((p) => (p.hidden = true)); }
      if (resource) resource.querySelectorAll(".res-pane").forEach((p) => { p.hidden = p.dataset.pane !== name; });
      loadAppearance();
      return;
    }
    if (resource) resource.hidden = true;
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
      message: "Update " + path.split("/").pop() + " Chrome FFCMS",
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
    host.innerHTML = '<div class="cfg-empty">加载中，请稍等...</div>';
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
    const pane = cfgPanesRoot().querySelector('.ap-pane[data-pane="' + name + '"]');
    const advBtn = pane ? pane.querySelector(".ap-adv") : null;
    // 高级模式：直接渲染源码编辑器
    if (st.advanced) {
      renderAdvancedRaw(host, st, name);
      if (advBtn) advBtn.hidden = true;
      return;
    }
    // 合并页脚：上方结构化配置 + 下方富文本 HTML 内容
    if (st.merged) {
      // merged 含结构化 .ts 部分：恢复高级模式入口（进入高级模式时被隐藏）
      if (advBtn) advBtn.hidden = !(st.roots && st.roots.length);
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
    // 独立 .html 配置：富文本编辑（无结构化参数，不提供高级模式入口）
    if (st.ext === ".html") {
      if (advBtn) advBtn.hidden = true;
      host.innerHTML = '<div class="cfg-footer-editor" id="footerHtmlEditor"></div>';
      initFooterEditor(st.raw || "");
      if (footerEditor) setTimeout(() => footerEditor.on("change", () => markDirtyOf(host)), 0);
      return;
    }
    // 结构化解析失败但有源码：回退为源码编辑器（仍可查看 / 编辑 / 保存）
    // 场景：函数式配置（如 export const x = defineConfig({...})）或含暂不支持语法的文件，
    // 此前会显示「无可结构化编辑的参数」空白页；现在直接暴露源码，避免「打开无数据」。
    if (!st.roots || !st.roots.length) {
      host.innerHTML =
        '<div class="cfg-raw-note">⚠️ 当前文件无法结构化解析（可能是函数式配置，或包含暂不支持的语法）。已切换为源码编辑器，可直接修改内容并保存。</div>';
      makeCodeEditor(host, st.raw || "", () => markDirtyOf(host));
      if (advBtn) advBtn.hidden = true; // 已处于源码视图，无需高级模式入口
      return;
    }
    if (name === "booknavConfig") renderBooknavEditor(host, st.booknavModel);
    else renderGenericConfig(host, st.roots, name, st.raw);
    // 高级模式入口：仅当该配置存在可结构化编辑的参数时才显示
    if (advBtn) advBtn.hidden = !(st.roots && st.roots.length);
  }

  // 带行号的源码编辑器：左侧行号列 + 右侧 textarea，滚动同步、输入更新行数
  function makeCodeEditor(host, value, onInput) {
    const wrap = document.createElement("div");
    wrap.className = "cfg-code-editor";
    const gutter = document.createElement("div");
    gutter.className = "cfg-code-gutter";
    const ta = document.createElement("textarea");
    ta.className = "cfg-raw";
    ta.spellcheck = false;
    ta.wrap = "off";
    ta.value = value || "";
    const updateGutter = () => {
      const lines = (ta.value.match(/\n/g) || []).length + 1;
      let html = "";
      for (let i = 1; i <= lines; i++) html += i + "\n";
      gutter.textContent = html;
      gutter.scrollTop = ta.scrollTop;
    };
    updateGutter();
    ta.addEventListener("input", () => { updateGutter(); if (onInput) onInput(); });
    ta.addEventListener("scroll", () => { gutter.scrollTop = ta.scrollTop; });
    wrap.appendChild(gutter);
    wrap.appendChild(ta);
    host.appendChild(wrap);
  }
  // 高级模式下的源码编辑器：与解析失败时的源码视图一致，额外提供「返回可视化」入口
  function renderAdvancedRaw(host, st, name) {
    host.innerHTML =
      '<div class="cfg-adv-note">⚙️ 您已进入 <b>高级模式（源码编辑）</b>。此模式直接编辑配置文件源码，保存后将覆盖原文件；因操作不当导致站点异常需自行承担风险。</div>' +
      '<div class="cfg-adv-bar"><button class="btn ghost sm ap-back-visual" type="button" data-back="' + esc(name) + '">← 返回可视化编辑</button></div>';
    makeCodeEditor(host, st.raw || "", () => markDirtyOf(host));
  }

  async function saveCfgConfig(name, silent) {
    const st = apState[name];
    const root = cfgPanesRoot();
    const host = apHostFor(name, root);
    const statusEl = apStatusFor(name, root);
    if (!st || !host) return;
    // 高级模式保存：直接保存源码编辑器中的内容（覆盖原文件）
    if (st.advanced) {
      const ta = host.querySelector("textarea.cfg-raw");
      const content = ta ? ta.value : (st.raw || "");
      try {
        const r = await putConfigFile("src/config/" + name + (st.ext || ".ts"), content, st.sha);
        if (r.status === 200 || r.status === 201) {
          st.raw = content;
          st.sha = (r.data && r.data.sha) || st.sha;
          st.dirty = false;
          if (statusEl) { statusEl.textContent = "已保存（高级模式）"; statusEl.className = "ap-pane-status ok"; }
          if (!silent) okPopup("已保存");
        } else {
          if (statusEl) { statusEl.textContent = "保存失败：" + ((r.data && r.data.error) || r.status); statusEl.className = "ap-pane-status err"; }
          if (!silent) okPopup("保存失败");
        }
      } catch (e) {
        if (statusEl) statusEl.textContent = "保存失败：" + (e.message || "");
      }
      return;
    }
    // 导航栏保存（必须早于 rawFallback 判断）：导航栏用 navModel 序列化，st.roots 恒为 undefined，
    // 若落在 rawFallback 分支会直接写回旧 st.raw、显示「已保存（源码模式）」且丢失编辑。
    // 因此单独处理，并自带 SHA 冲突（409）重放：冲突时拉取最新文件、用内存模型重序列化后重试，
    // 既保住用户未保存的修改，又避免「is at X but expected Y」式保存失败。
    if (name === "navBarConfig") {
      const buildNav = () => {
        if (st.rawFallback) {
          const ta = host.querySelector("textarea.cfg-raw");
          return ta ? ta.value : st.raw;
        }
        return serializeNavBarCustom(st.navModel || [], st.raw);
      };
      try {
        if (!silent) okPopup("⏳ 上传至 GitHub 中，请等待…", true);
        let content = buildNav();
        let r = await putConfigFile("src/config/navBarConfig.ts", content, st.sha);
        if (r.status === 409 || (r.data && r.data.githubStatus === 409)) {
          const g = await api("/api/file?path=" + encodeURIComponent("src/config/navBarConfig.ts"));
          if (g.status === 200 && g.data.content != null) {
            st.raw = g.data.content;
            st.sha = g.data.sha;
            if (!st.rawFallback) {
              try { st.navModel = parseNavBarCustom(st.raw) || []; } catch (e) { st.navModel = st.navModel || []; }
            }
            content = buildNav();
            r = await putConfigFile("src/config/navBarConfig.ts", content, st.sha);
          }
        }
        if (r.status === 200 || r.status === 201) {
          st.raw = content;
          st.sha = (r.data && r.data.sha) || st.sha;
          st.dirty = false;
          if (statusEl) statusEl.textContent = "";
          if (!silent) okPopup("✅ 已保存，GitHub 自动部署中");
        } else {
          if (statusEl) { statusEl.textContent = "保存失败：" + ((r.data && (r.data.error || r.data.message)) || r.status); statusEl.className = "ap-pane-status err"; }
          if (!silent) okPopup("❌ 保存失败", false);
        }
      } catch (e) {
        if (statusEl) statusEl.textContent = "保存失败：" + (e.message || "");
        if (!silent) okPopup("❌ 保存失败", false);
      }
      return;
    }
    // 源码回退保存：结构化解析失败时，直接保存 textarea 中的原始内容
    if (!st.roots || !st.roots.length) {
      const ta = host.querySelector("textarea.cfg-raw");
      const content = ta ? ta.value : (st.raw || "");
      try {
        const r = await putConfigFile("src/config/" + name + (st.ext || ".ts"), content, st.sha);
        if (r.status === 200) {
          st.raw = content;
          st.sha = (r.data && r.data.sha) || st.sha;
          st.dirty = false;
          if (statusEl) { statusEl.textContent = "已保存（源码模式）"; statusEl.className = "ap-pane-status ok"; }
          if (!silent) okPopup("已保存");
        } else {
          if (statusEl) { statusEl.textContent = "保存失败：" + ((r.data && r.data.error) || r.status); statusEl.className = "ap-pane-status err"; }
          if (!silent) okPopup("保存失败");
        }
      } catch (e) {
        if (statusEl) statusEl.textContent = "保存失败：" + (e.message || "");
      }
      return;
    }
    let tsContent = null, htmlContent = null, tsPath = null, htmlPath = null;
    let tsHost = null;
    let tsRetryable = false; // 通用 .ts / 合并页脚：内容基于 raw+DOM 偏移，可在 sha 冲突时重放重试
    try {
      if (st.merged) {
        tsHost = host.querySelector(".cfg-sub");
        tsRetryable = true;
        const edits = collectConfigEdits(tsHost);
        tsContent = FireflyConfig.applyConfigEdits(st.raw, edits);
        tsPath = "src/config/" + name + ".ts";
        htmlContent = footerEditor ? footerEditor.getHTML() : ((host.querySelector("textarea") || {}).value || st.htmlRaw);
        htmlPath = "src/config/" + (st.htmlName || (name + ".html"));
      } else if (st.ext === ".html") {
        htmlContent = footerEditor ? footerEditor.getHTML() : ((host.querySelector("textarea") || {}).value || st.raw);
        htmlPath = "src/config/" + name + ".html";
      } else if (name === "booknavConfig") {
        const rootN = st.roots.find((r) => r.name === "booknavConfig");
        if (!rootN) throw new Error("未找到 booknavConfig");
        const arrText = serializeBooknav(st.booknavModel || []);
        tsContent = st.raw.slice(0, rootN.node.start) + arrText + st.raw.slice(rootN.node.end);
        tsPath = "src/config/" + name + ".ts";
      } else {
        const edits = collectConfigEdits(host);
        tsRetryable = true;
        tsContent = FireflyConfig.applyConfigEdits(st.raw, edits);
        tsPath = "src/config/" + name + ".ts";
      }
    } catch (e) {
      if (statusEl) { statusEl.textContent = e.message || "内容构建失败"; statusEl.className = "ap-pane-status err"; }
      return;
    }
    // 带 SHA 冲突重试的写入：GitHub 在文件被并发/上游改动（sha 不匹配）时会返回 409，
    // 表现为「点击保存提示失败」。这里在 409 时自动拉取最新内容、用当前 DOM 输入重放编辑后重试一次，
    // 既保住用户未保存的修改，又避免无意义的保存失败。
    const putWithRetry = async (path, buildContent, shaKey, rawKey) => {
      let content = buildContent();
      let r = await putConfigFile(path, content, st[shaKey]);
      const conflict = r.status === 409 || (r.data && r.data.githubStatus === 409);
      if (conflict) {
        const g = await api("/api/file?path=" + encodeURIComponent(path));
        if (g.status === 200 && g.data.content != null) {
          st[rawKey] = g.data.content;
          st[shaKey] = g.data.sha;
          content = buildContent(); // 用最新 raw 重新计算偏移（DOM 输入值保持不变）
          r = await putConfigFile(path, content, st[shaKey]);
        }
      }
      if (r.status !== 200 && r.status !== 201) {
        throw new Error((r.data && (r.data.error || r.data.message)) || "保存失败");
      }
      return r.data;
    };
    try {
      if (!silent) okPopup("⏳ 上传至 GitHub 中，请等待…", true);
      const tsBuilder = () => FireflyConfig.applyConfigEdits(st.raw, collectConfigEdits(tsHost || host));
      const htmlBuilder = () => (footerEditor ? footerEditor.getHTML() : ((host.querySelector("textarea") || {}).value || st.htmlRaw));
      if (tsContent != null) {
        if (tsRetryable) {
          const d = await putWithRetry(tsPath, tsBuilder, "sha", "raw");
          st.sha = d.sha || st.sha;
        } else {
          const r = await putConfigFile(tsPath, tsContent, st.sha);
          if (r.status !== 200 && r.status !== 201) throw new Error((r.data && (r.data.error || r.data.message)) || "保存失败");
          st.sha = (r.data && r.data.sha) || st.sha;
        }
      }
      if (htmlContent != null) {
        const d = await putWithRetry(htmlPath, htmlBuilder, "htmlSha", "raw");
        st.htmlSha = d.sha || st.htmlSha;
      }
      st.dirty = false; // 已提交到 GitHub，恢复为「干净」状态（下次打开将重新读取远程）
      if (silent) {
        if (statusEl) {
          statusEl.textContent = "已自动保存"; statusEl.className = "ap-pane-status";
          clearTimeout(statusEl._autoT);
          statusEl._autoT = setTimeout(() => { if (statusEl.textContent === "已自动保存") statusEl.textContent = ""; }, 2600);
        }
      } else {
        okPopup("✅ 已保存，GitHub 自动部署中");
        if (statusEl) statusEl.textContent = "";
      }
    } catch (e) {
      if (statusEl) { statusEl.textContent = e.message || "保存失败"; statusEl.className = "ap-pane-status err"; }
      if (!silent) okPopup("❌ " + (e.message || "保存失败"), false);
    }
  }

  // ===== 数据备份与恢复 =====
  // 打包博客仓库 src/config/ 下全部配置文件为 JSON（含 path/sha/content），可下载留存；
  // 也可将备份 JSON 逐文件写回 GitHub 实现恢复（保留原 sha 以便冲突检测）。
  const backupState = { data: null };
  const restoreState = { file: null };

  async function loadBackupView() {
    const list = $("bkList");
    const status = $("bkStatus");
    if (status) status.textContent = "";
    if (list) list.innerHTML = '<div class="bk-empty">点击「生成备份」打包当前线上配置；生成后可下载 JSON 留存，再到左侧「数据恢复」写回 GitHub。</div>';
    bindBackupEvents();
  }

  async function loadRestoreView() {
    const list = $("rsList");
    const status = $("rsStatus");
    if (status) status.textContent = "";
    if (list) list.innerHTML = '<div class="bk-empty">选择此前在「数据备份」下载的 JSON 备份文件，确认后即可写回 GitHub 恢复。</div>';
    bindRestoreEvents();
  }

  let _bkEventsBound = false;
  function bindBackupEvents() {
    if (_bkEventsBound) return;
    _bkEventsBound = true;
    on("bkCreateBtn", "onclick", () => createBackup());
    on("bkDownloadBtn", "onclick", () => downloadBackup());
  }

  let _rsEventsBound = false;
  function bindRestoreEvents() {
    if (_rsEventsBound) return;
    _rsEventsBound = true;
    on("rsRestoreInput", "onchange", (e) => onRestoreFileChosen(e));
    on("rsRestoreBtn", "onclick", () => restoreBackup());
  }

  function bkSet(msg, kind) {
    const el = $("bkStatus");
    if (!el) return;
    el.textContent = msg;
    el.className = "backup-status" + (kind ? " " + kind : "");
  }

  // 备份进度条：首次调用时动态创建 .bk-progress 容器（含 .bk-bar），
  // 之后仅更新宽度与文案；pct 为 0~100 的整数。错误/完成时置为 100 并保留条体。
  function bkProgress(pct, label) {
    let box = $("bkProgress");
    if (!box) {
      box = document.createElement("div");
      box.id = "bkProgress";
      box.className = "bk-progress";
      box.innerHTML = '<div class="bk-bar"></div>';
      const anchor = $("bkStatus");
      if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(box, anchor);
    }
    const bar = box.querySelector(".bk-bar");
    if (bar) {
      const p = Math.max(0, Math.min(100, pct | 0));
      bar.style.width = p + "%";
      box.setAttribute("data-label", label || "");
    }
  }

  function rsSet(msg, kind) {
    const el = $("rsStatus");
    if (!el) return;
    el.textContent = msg;
    el.className = "backup-status" + (kind ? " " + kind : "");
  }

  async function createBackup() {
    const createBtn = $("bkCreateBtn");
    const withContent = $("bkWithContent") && $("bkWithContent").checked;
    // 即时反馈：按钮进入「工作中」状态（禁用 + 文案变化），避免出现「点了没反应」的错觉
    if (createBtn) { createBtn.disabled = true; createBtn.dataset.label = createBtn.textContent; createBtn.textContent = "⏳ 生成中…"; }
    bkSet("正在读取配置列表…", "");
    bkProgress(0, "正在读取配置列表…");
    try {
      // 1) 配置目录（src/config）
      const { status, data } = await api("/api/list?type=config");
      if (status !== 200 || !data.items) throw new Error((data && data.error) || "读取配置列表失败");
      let files = (data.items || []).filter((f) => f.type === "file" && (f.name.endsWith(".ts") || f.name.endsWith(".html")));
      // 2) 可选：内容目录（posts / dynamic / spec 根层文件，浅层不递归子目录）
      if (withContent) {
        for (const t of ["posts", "dynamic", "spec"]) {
          try {
            const r = await api("/api/list?type=" + t);
            if (r.status === 200 && r.data.items) {
              (r.data.items || []).filter((f) => f.type === "file").forEach((f) => files.push(f));
            }
          } catch (e) { /* 单目录失败不阻塞整体 */ }
        }
      }
      if (files.length === 0) {
        bkSet("⚠️ 未发现任何可备份的配置文件。", "warn");
        bkProgress(100, "未发现可备份文件");
        return;
      }
      bkSet("已发现 " + files.length + " 个文件，开始逐个读取内容…", "");
      // 3) 逐文件读取内容（串行，避免触发 GitHub 限流；配置量不大）
      // 注意：f.path 形如 src/config/siteConfig.ts，后端 ghApi 会对每段单独 encodeURIComponent，
      // 因此这里【不能】整体 encodeURIComponent（会把 / 编成 %2F 再被后端二次编码成 %252F → 404）。
      // 仅对路径按 / 分段后逐段编码，与后端 encodePath 互逆且唯一。
      const enc = (p) => p.split("/").map(encodeURIComponent).join("/");
      const entries = [];
      let skip = 0;
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        try {
          const r = await api("/api/file?path=" + enc(f.path));
          if (r.status === 200 && r.data.content != null) {
            entries.push({ path: f.path, sha: f.sha, size: f.size, content: r.data.content });
          } else {
            skip++;
            console.warn("备份：文件读取失败", f.path, r.status, r.data && r.data.error);
          }
        } catch (e) {
          skip++;
          console.warn("备份：文件读取异常", f.path, e.message);
        }
        // 进度条：列表读取(10%) + 逐文件读取(10%→95%)，给用户连续可见的进展
        const pct = Math.round(10 + ((i + 1) / files.length) * 85);
        bkProgress(pct, "正在读取文件 " + (i + 1) + " / " + files.length + (f.name ? "：" + f.name : "") + "…");
      }
      if (entries.length === 0) {
        bkSet("❌ 未能读取任何文件内容（" + skip + " 个读取失败）。请检查网络或稍后重试；若持续失败可能是 GitHub API 限流。", "err");
        bkProgress(100, "读取失败");
        return;
      }
      if (skip > 0) bkSet("⚠️ 有 " + skip + " 个文件读取失败，已跳过。当前生成 " + entries.length + " 个文件。", "warn");
      const payload = {
        tool: "Firefly-Admin Backup",
        version: 1,
        repo: (window.__repoInfo && window.__repoInfo.repo) || "",
        owner: (window.__repoInfo && window.__repoInfo.owner) || "",
        branch: (window.__repoInfo && window.__repoInfo.branch) || "",
        createdAt: new Date().toISOString(),
        count: entries.length,
        files: entries,
      };
      backupState.data = payload;
      // 渲染清单
      const list = $("bkList");
      if (list) {
        list.innerHTML = entries.map((e) => '<div class="bk-item"><span class="bk-path">' + esc(e.path) + '</span><span class="bk-meta">' + (e.size || 0) + ' B</span></div>').join("");
      }
      const dl = $("bkDownloadBtn");
      if (dl) dl.disabled = false;
      bkProgress(100, "完成");
      bkSet("✅ 备份生成完成：共 " + entries.length + " 个文件。可下载 JSON 留存，或到「数据恢复」写回 GitHub。", "ok");
    } catch (e) {
      bkSet("❌ 生成备份失败：" + (e.message || ""), "err");
      bkProgress(100, "失败");
    } finally {
      if (createBtn) { createBtn.disabled = false; createBtn.textContent = createBtn.dataset.label || "📦 生成备份"; }
    }
  }

  function downloadBackup() {
    if (!backupState.data) { bkSet("请先生成备份", "warn"); return; }
    const blob = new Blob([JSON.stringify(backupState.data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    a.href = url;
    a.download = "firefly-config-backup-" + stamp + ".json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    bkSet("⬇️ 备份已下载：" + a.download, "ok");
  }

  function onRestoreFileChosen(e) {
    const file = e.target && e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const obj = JSON.parse(reader.result);
        if (!obj.files || !Array.isArray(obj.files)) throw new Error("备份文件格式不正确（缺少 files 数组）");
        restoreState.file = obj;
        const rb = $("rsRestoreBtn");
        if (rb) rb.disabled = false;
        const list = $("rsList");
        if (list) list.innerHTML = obj.files.map((f) => '<div class="bk-item"><span class="bk-path">' + esc(f.path) + '</span><span class="bk-meta">' + (f.size || 0) + ' B</span></div>').join("");
        rsSet("✅ 已选择备份：" + file.name + "（含 " + obj.files.length + " 个文件）。点击「执行恢复」将写回 GitHub。", "ok");
      } catch (err) {
        restoreState.file = null;
        const rb = $("rsRestoreBtn");
        if (rb) rb.disabled = true;
        rsSet("❌ 备份文件解析失败：" + (err.message || ""), "err");
      }
    };
    reader.readAsText(file);
  }

  async function restoreBackup() {
    const obj = restoreState.file;
    if (!obj || !obj.files || !obj.files.length) { rsSet("请先选择有效的备份文件", "warn"); return; }
    if (!confirm("确定要将备份中的 " + obj.files.length + " 个文件恢复（写回 GitHub）吗？\n此操作会覆盖现有线上文件，建议先下载当前备份留存。")) return;
    rsSet("开始恢复，已处理 0 / " + obj.files.length + " 个文件…", "");
    let okCount = 0, failCount = 0;
    for (let i = 0; i < obj.files.length; i++) {
      const f = obj.files[i];
      try {
        const r = await putConfigFile(f.path, f.content, f.sha);
        if (r.status === 200 || r.status === 201) okCount++;
        else { failCount++; rsSet("⚠️ 文件恢复失败：" + esc(f.path) + " — " + ((r.data && (r.data.error || r.data.message)) || r.status), "warn"); }
      } catch (e) { failCount++; }
      if ((i + 1) % 3 === 0) rsSet("恢复中，已处理 " + (i + 1) + " / " + obj.files.length + " 个文件（成功 " + okCount + "，失败 " + failCount + "）…", "");
    }
    rsSet("♻️ 恢复完成：成功 " + okCount + " 个，失败 " + failCount + " 个。GitHub 将自动重新部署。", failCount ? "warn" : "ok");
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

  async function loadInfoReadme() {
    const el = $("infoReadme");
    if (!el) return;
    try {
      // 操作说明是后台自身的静态资源（public/op-guide.md），随站点部署，无需依赖博客仓库。
      // 早期版本误读博客仓库的 src/config/README.md（主题配置文档），导致本应显示的后台操作说明不出现。
      const res = await fetch("op-guide.md", { cache: "no-cache" });
      if (res.ok) {
        const md = await res.text();
        el.innerHTML = renderMarkdownSimple(md);
        return;
      }
      el.innerHTML = '<div class="info-empty">暂无操作说明（未找到文档内容）。</div>';
    } catch (e) {
      el.innerHTML = '<div class="info-empty">操作说明加载失败。</div>';
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
        "",
        "  // 页面标题，如果留空则使用 i18n 中的翻译",
        "  title: \"\",",
        "",
        "  // 页面描述文本，如果留空则使用 i18n 中的翻译",
        "  description: \"\",",
        "",
        "  // 打赏用途说明",
        "  usage: \"您的打赏将用于服务器维护、内容创作和功能开发，帮助我持续提供优质内容。\",",
        "",
        "  // 是否显示打赏者列表",
        "  showSponsorsList: true,",
        "",
        "  // 是否显示评论区，需要先在commentConfig.ts启用评论系统",
        "  showComment: true,",
        "",
        "  // 是否在文章详情页底部显示打赏按钮",
        "  showButtonInPost: true,",
        "",
        "  // 打赏方式列表",
        "  methods: [",
        "    {",
        "      name: \"支付宝\",",
        "      icon: \"fa7-brands:alipay\",",
        "      // 收款码图片路径（需要放在 public 目录下）",
        "      qrCode: \"\",",
        "      link: \"\",",
        "      description: \"使用 支付宝 扫码打赏\",",
        "      enabled: true,",
        "    },",
        "    {",
        "      name: \"微信\",",
        "      icon: \"fa7-brands:weixin\",",
        "      qrCode: \"\",",
        "      link: \"\",",
        "      description: \"使用 微信 扫码打赏\",",
        "      enabled: true,",
        "    },",
        "  ],",
        "",
        "  // 打赏者列表（可选）",
        "  sponsors: [",
        "    {",
        "      name: \"匿名用户\",",
        "      amount: \"¥20\",",
        "      date: \"2025-01-01\",",
        "    },",
        "  ],",
        "};",
        "",
      ].join("\n");
    }
    return null;
  }

  // 左侧板块分组：点击标题折叠/展开，状态写入 localStorage（默认全部折叠）
  function initCollapsibleNav() {
    const KEY = "ffNavGroups";
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch (e) { saved = {}; }
    const groups = document.querySelectorAll("#navBar .nav-group.collapsible");
    groups.forEach((g) => {
      const name = g.dataset.group || "";
      // 持久化优先；否则默认折叠
      const collapsed = name in saved ? !!saved[name] : true;
      g.classList.toggle("collapsed", collapsed);
      const toggle = g.querySelector(".nav-group-toggle");
      if (toggle) toggle.setAttribute("aria-expanded", String(!collapsed));
    });
    groups.forEach((g) => {
      const toggle = g.querySelector(".nav-group-toggle");
      if (!toggle) return;
      toggle.addEventListener("click", () => {
        const collapsed = !g.classList.contains("collapsed");
        g.classList.toggle("collapsed", collapsed);
        toggle.setAttribute("aria-expanded", String(!collapsed));
        const name = g.dataset.group || "";
        try {
          const cur = JSON.parse(localStorage.getItem(KEY) || "{}") || {};
          cur[name] = collapsed;
          localStorage.setItem(KEY, JSON.stringify(cur));
        } catch (e) { /* 忽略存储异常 */ }
      });
    });
  }

  let bound = false;
  function bindEvents() {
    if (bound) return;
    bound = true;
    // 左侧导航栏：点击切换板块（文章 / 动态 / 单页 / 配置 / 站点外观）
    const navBar = $("navBar");
    if (navBar) {
      navBar.querySelectorAll(".nav-btn").forEach((b) => {
        b.addEventListener("click", () => {
          const type = b.dataset.type;
          // 移动端：点击任意导航项先收起抽屉，避免遮罩挡住右侧内容区交互
          if (isMobile()) closeDrawer();
          if (!type || state.sectionType === type) return; // 已是当前板块，不重复加载
          selectSection(type);
        });
      });
      // 左侧板块分组：可折叠/展开，状态持久化到 localStorage（默认折叠）
      initCollapsibleNav();
    }

    // 顶部图标：帮助 → 操作说明，关于 → 关于（与左侧导航同入口，移动端先收起抽屉）
    on("topHelpBtn", "onclick", () => { if (isMobile()) closeDrawer(); selectSection("readme"); });
    on("topAboutBtn", "onclick", () => { if (isMobile()) closeDrawer(); selectSection("about"); });

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
    on("quickUploadBtn", "onclick", () => {
      // 先展开底部「资源上传」面板，确保用户能看到并选择目标文件夹
      const up = $("uploadPanel");
      if (up) up.classList.remove("collapsed");
      const fi = $("fileInput");
      if (fi) fi.click();
    });
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
    // 退出登录：顶栏按钮（PC）与左侧导航按钮（移动端）共用同一逻辑
    const doLogout = async () => {
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
    };
    on("logoutBtn", "onclick", doLogout);
    on("logoutNavBtn", "onclick", doLogout);

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

    // 编辑器 Tab：内容 ⇄ 文章信息 / 动态信息 互斥切换
    on("tabContentBtn", "onclick", () => switchEditorTab("content"));
    on("tabMetaBtn", "onclick", () => switchEditorTab("meta"));
    on("tabDynBtn", "onclick", () => switchEditorTab("dyn"));

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
      // 点击「资源上传」标题：展开/折叠上传面板（修复此前点击无反应）
      const upHead = up.querySelector(".panel-head");
      if (upHead) upHead.addEventListener("click", () => up.classList.toggle("collapsed"));
      // 选择目标文件夹时，实时更新「自动上传到 …」提示
      const uds = up.querySelector("#uploadDirSel");
      if (uds) uds.addEventListener("change", () => {
        const t = $("uploadTarget");
        if (t) t.textContent = uploadTargetDir();
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
      const adv = e.target.closest(".ap-adv");
      if (adv) { openAdvModal(adv.dataset.adv); return; }
      const back = e.target.closest(".ap-back-visual");
      if (back) { backToVisual(back.dataset.back); return; }
      const b = e.target.closest(".ap-save");
      if (b) {
        const fname = b.dataset.save || "";
        const name = fname.replace(/\.(ts|html)$/, "");
        saveCfgConfig(name);
      }
    });
    // 高级模式弹窗按钮
    const advConfirmEl = $("advConfirm");
    if (advConfirmEl) advConfirmEl.addEventListener("click", confirmAdvMode);
    const advCancelEl = $("advCancel");
    if (advCancelEl) advCancelEl.addEventListener("click", closeAdvModal);
    const advModalEl = $("advModal");
    if (advModalEl) advModalEl.addEventListener("click", (e) => { if (e.target === advModalEl) closeAdvModal(); });
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
