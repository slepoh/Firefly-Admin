# Firefly-Admin

Firefly 博客（[Slepoh/Firefly](https://github.com/slepoh/Firefly)）的内容管理后台。
本项目是Firefly项目的**可视化管理后台**，直接通过 GitHub API 远程增删改博客内容、配置博客信息等操作，
保存即提交到 GitHub，Cloudflare 自动重新部署。

> 当前版本：**v3.2.6**

支持四类内容管理：

| 类型 | 目录 | 说明 |
|---|---|---|
| 文章 | `src/content/posts` | 结构化字段（title/published/tags/category/draft/pinned…）+ Markdown 正文，支持子目录、`.md/.mdx` |
| 最新动态 | `src/content/dynamic` | 自动按 `YYYY-MM-DD-HHMMSS.md` 命名，只需填发布时间 + 地点 + 短文本 |
| 单页 | `src/content/spec` | 整文件 Markdown 编辑（如 `about.md`） |
| 图库素材 | `src/content/posts/*`（子目录） | 按分类目录浏览文章引用的图片资源，每个分类对应一个子文件夹（如 `123456`、`abcdefg`），支持预览 / 删除 / 新建分类 |

---

## 一、一键部署到 Cloudflare Pages（Git 方式 · 推荐）

> 无需自己买服务器、无需构建，纯静态前端 + Cloudflare Pages Functions（Serverless）后端。
> GitHub 访问令牌只存在 Cloudflare 环境变量里，浏览器只拿一个 HttpOnly 会话 Cookie。

### 第 1 步：把代码推到 GitHub

Fork 或直接把本仓库推到你自己的 GitHub 账号（仓库名建议 `Firefly-Admin`）：

```bash
git clone <你的仓库地址> Firefly-Admin
cd Firefly-Admin
# 把本项目内容放进去后：
git add -A
git commit -m "init Firefly-Admin"
git push origin main
```

### 第 2 步：Cloudflare Pages 连接 Git

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**。
2. 授权并选择你的 `Firefly-Admin` 仓库。
3. 构建设置：
   - **Framework preset**：选 `None`（无框架）
   - **Build command**：**留空**（不需要构建）
   - **Build output directory**：填 `public`
4. 点击 **Save and Deploy**。

### 第 3 步：设置环境变量（关键）

进入项目 **Settings → Environment variables**，为 **Production**（和可选 Preview）添加：

| 变量名 | 必填 | 说明 |
|---|---|---|
| `GITHUB_TOKEN` | ✅ | 具备 `repo`（私有库）或 `public_repo`（公开库）权限的 GitHub PAT |
| `ADMIN_PASSWORD` | ✅ | 登录本后台的管理员密码 |
| `GH_OWNER` | | 内容仓库所有者，默认 `slepoh` |
| `GH_REPO` | | 内容仓库名，默认 `Firefly` |
| `GH_BRANCH` | | 内容分支，默认 `master` |

> 改完环境变量后，回到 **Deployments** 重新部署一次即可生效。

### 第 4 步：使用

打开分配的 `*.pages.dev` 域名（或绑定的自定义域名），输入 `ADMIN_PASSWORD` 即可登录管理。
**之后每次 `git push` 到 `Firefly-Admin`，Cloudflare 会自动重新部署后台本身**（注意：这部署的是「管理后台」，不是你的博客；博客仍由 Firefly 仓库的提交触发）。

---

## 二、本地开发（可选）

```bash
cp .dev.vars.example .dev.vars   # 填入你的 GITHUB_TOKEN / ADMIN_PASSWORD 等
npx wrangler pages dev public     # 启动本地预览（含 Functions）
```

浏览器打开终端提示的本地地址即可。

---

## 三、备选：自托管（Python server.py）

如果你更想跑在自己的服务器上（而不是 Cloudflare），仓库里也带了零依赖的 Python 后端：

```bash
pip install -r requirements.txt   # 实际上零依赖，可跳过
python server.py                  # 默认 8000 端口，可用 PORT=8080 覆盖
```

首次打开会让你填 GitHub 令牌 / owner / repo / branch / 管理员密码，配置保存在服务端 `data/config.json`（已在 `.gitignore` 忽略，**切勿提交**）。
也可以用 Docker：

```bash
docker build -t firefly-admin .
docker run -d -p 8000:8000 -v firefly-data:/app/data firefly-admin
```

> 自托管版与 Cloudflare 版共用同一套前端（`public/`），只是后端实现不同。

---

## 四、目录结构

```
Firefly-Admin/
├── public/                 # 前端（Cloudflare Pages 静态输出目录）
│   ├── index.html
│   ├── style.css
│   └── app.js
├── functions/              # Cloudflare Pages Functions 后端（Serverless）
│   └── api/[[path]].ts     # 代理 GitHub API：status/login/logout/list/file
├── server.py               # 备选：Python 自托管后端
├── Dockerfile
├── wrangler.toml           # 本地开发配置
├── .dev.vars.example       # 本地环境变量模板
└── README.md
```

---

## 五、安全说明

- GitHub 令牌**永远只存在于服务端 / Cloudflare 环境变量**，绝不下发到浏览器。
- 浏览器登录后获得一个 **HttpOnly + 7 天有效期** 的会话 Cookie（由服务端 HMAC 签名）。
- 请为 `GITHUB_TOKEN` 使用**最小权限**的 PAT，且仅授予你信任的人 `ADMIN_PASSWORD`。
- 不建议把 `GITHUB_TOKEN` 用于生产站点的公开前端；本架构已避免该问题。

---

## 六、内容管理要点

- **文章**：可视化表单填写 Frontmatter，`published` 等日期在保存时保持不引号，兼容 Firefly 解析。
- **最新动态**：只需选发布时间、填地点、写正文；文件名自动生成。
- **单页**：直接编辑整份 Markdown（可含自己的 Frontmatter）。
- **图库素材**：按分类目录浏览文章引用的图片资源；每个分类对应 `src/content/posts` 下的一个子文件夹，可用「＋ 新建分类」创建，并通过上传面板选择对应分类上传。

保存后内容提交到 `GH_OWNER/GH_REPO@GH_BRANCH`，Firefly 站点随之自动更新。

---

## 七、后台功能一览

### 7.1 界面导航
左侧导航分为三大板块，**默认全部折叠、点击展开**：
- **内容管理**：文章内容、我的动态、页面信息、图库素材
- **站点配置**：基础配置、功能配置、页面配置、扩展功能（四类可视化配置）

### 7.2 内容管理
- **文章 / 我的动态 / 页面信息**：表格化列表（含复选框批量操作）、单独编辑 / 重命名 / 删除、新建；图片以宫格展示并支持点击预览。
- **图库素材**：按 `src/content/posts` 下的分类子目录组织图片资源，支持预览、删除、新建分类。

### 7.3 上传资源（各板块独立上传区）
各内容板块列表页底部均有独立的「资源上传」面板（默认展开），面板标题随板块变化（如「图库素材 · 资源上传」），并带**文件夹选择器**：
- 文章 / 动态 / 页面：下拉列出当前板块子目录，可选根目录或指定子目录，上传落点自动拼接。
- 图库：下拉列出 `src/content/posts` 下的各个分类子文件夹，选定后上传到对应分类目录。
- 支持拖拽与多选，文件自动上传到所选目录并显示进度。

### 7.4 站点配置（可视化编辑）
点击配置分类即在右侧加载该配置的结构化编辑界面（参数名锁定、仅改值），保存即提交 GitHub：
- 文件名已做中文映射（如 `siteConfig.ts → 站点基础配置`、`footerConfig.ts → 页脚配置`）。
- 枚举下拉：注释给出可选项的字段自动渲染为下拉；常用字段做了字段级覆盖（如 `siteConfig.SITE_LANG` 支持「自定义…」输入）。
- 标量数组可增删（如 `siteConfig.keywords` 可自由添加 / 删除 / 编辑每一项）。
- 页脚合并 + 富文本：同名 `.ts` 与 `.html` 合并为一个面板，下方为 ToastUI 富文本编辑器。
- 书签导航 `booknavConfig.ts`：以分组 / 书签扁平列表展示，支持新增分组与书签，保存按偏移量整体回写原始文件。
- **配置解析失败时自动回退源码编辑器**（含提示），保证始终可编辑可保存。

### 7.5 高级模式（源码编辑）
每个可视化配置编辑器顶部提供 **⚙ 高级模式** 按钮：

- 源码编辑界面提供「← 返回可视化编辑」按钮，重新解析后可回到表单。
