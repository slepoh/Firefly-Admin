/* 登录页逻辑：独立页面，未登录无法进入管理后台 */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);

  // 支持 ?from= 跳转（默认回后台首页）
  const params = new URLSearchParams(location.search);
  const from = params.get("from") || "/";

  function setErr(msg, type) {
    const el = $("err");
    el.textContent = msg || "";
    el.className = "err" + (type ? " " + type : "");
  }

  async function boot() {
    try {
      const res = await fetch("/api/status");
      if (!res.ok) throw new Error("无法连接服务器，请稍后重试");
      const s = await res.json();

      // 已登录：直接进后台
      if (s.authed) {
        location.replace(from);
        return;
      }
      // 服务器未配置管理员密码
      if (!s.adminConfigured) {
        setErr("服务器未检测到 ADMIN_PASSWORD。请到 Cloudflare Pages 控制台 → Settings → Environment variables 添加 ADMIN_PASSWORD（注意大小写），保存后务必重新部署（Redeploy）再试。", "warn");
        $("submitBtn").disabled = true;
      }
    } catch (e) {
      setErr(e.message || "初始化失败");
    }
  }

  $("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const pwd = $("password").value;
    if (!pwd) { setErr("请输入密码"); return; }
    setErr("");
    $("submitBtn").disabled = true;
    $("submitBtn").textContent = "登录中…";
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pwd }),
      });
      if (res.ok) {
        location.replace(from);
        return;
      }
      const d = await res.json().catch(() => ({}));
      setErr(d.error || "登录失败");
    } catch (e) {
      setErr("网络错误，请重试");
    } finally {
      $("submitBtn").disabled = false;
      $("submitBtn").textContent = "登 录";
    }
  });

  $("togglePwd").addEventListener("click", () => {
    const inp = $("password");
    const show = inp.type === "password";
    inp.type = show ? "text" : "password";
    $("togglePwd").textContent = show ? "🙈" : "👁️";
  });

  // 回车即登录（submit 已处理）
  boot();
})();
