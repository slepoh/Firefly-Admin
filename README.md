# Firefly-Admin

Firefly 博客（[Slepoh/Firefly](https://github.com/slepoh/Firefly)）的内容管理后台。
本项目是Firefly项目的**可视化管理后台**，直接通过 GitHub API 远程增删改博客内容、配置博客信息等操作，
保存即提交到 GitHub，Cloudflare 自动重新部署。

支持三类内容：

| 类型 | 目录 | 说明 |
|---|---|---|
| 文章 | `src/content/posts` | 结构化字段（title/published/tags/category/draft/pinned…）+ Markdown 正文，支持子目录、`.md/.mdx` |
| 最新动态 | `src/content/dynamic` | 自动按 `YYYY-MM-DD-HHMMSS.md` 命名，只需填发布时间 + 地点 + 短文本 |
| 单页 | `src/content/spec` | 整文件 Markdown 编辑（如 `about.md`） |

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

## 六、三类内容管理要点

- **文章**：可视化表单填写 Frontmatter，`published` 等日期在保存时保持不引号，兼容 Firefly 解析。
- **最新动态**：只需选发布时间、填地点、写正文；文件名自动生成。
- **单页**：直接编辑整份 Markdown（可含自己的 Frontmatter）。

保存后内容提交到 `GH_OWNER/GH_REPO@GH_BRANCH`，Firefly 站点随之自动更新。

---

## 七、后台功能一览

- **内容管理**：文章 / 最新动态 / 单页，支持列表批量删除、单独编辑 / 重命名 / 删除、新建；图片以宫格展示并支持点击预览。
- **配置管理**：点击分类即在右侧加载该配置的结构化编辑界面（参数名锁定、仅改值），保存即提交到 GitHub。
  - 文件名已做中文映射（如 `siteConfig.ts → 站点基础配置`、`booknavConfig.ts → 书签导航配置`、`displaySettingsConfig.ts → 显示设置面板配置`、`mermaidConfig.ts → Mermaid图表配置`、`footerConfig.ts → 页脚配置`）。
  - 枚举下拉：注释中给出多可选项的字段自动渲染为下拉；此外对常用字段做了**字段级覆盖**（优先于注释），如 `mermaidConfig` 的 `lightTheme`/`darkTheme`、`pioConfig` 的 `position`、`sidebarConfig` 的 `position`/`tabletSidebar` 均为下拉；`siteConfig.SITE_LANG` 为下拉且支持「自定义…」输入。
  - **标量数组可增删**：如 `siteConfig.keywords`（站点关键词）不再限定条数，可自由添加 / 删除 / 编辑每一项。
  - **页脚合并 + 富文本**：同名 `.ts` 与 `.html` 自动合并为一个「页脚配置」面板——上方为 `footerConfig.ts` 结构化配置，下方为 `FooterConfig.html` 的 **ToastUI 富文本编辑器**；所有 `.html` 配置均用富文本编辑。
- **站点外观**：顶部 Tab 形式为 Logo / 头像 + 常用配置（`profileConfig`、`backgroundWallpaper`、`booknavConfig`、`announcementConfig`、`sponsorConfig`、`sidebarConfig` 等），Tab 由 GitHub 动态拉取，新增配置自动出现；外观 Tab 显示名更简洁（`booknavConfig → 书签导航`、`displaySettingsConfig → 显示设置面板`）。
- **书签导航**：`booknavConfig.ts` 以分组 / 书签的扁平列表展示，支持新增分组与书签，保存按偏移量整体回写原始文件。
- **列表操作图标**：文件列表的「编辑」（✏️）与「重命名」（🏷️）使用不同图标，移动端仅显示图标避免遮挡文件名。
