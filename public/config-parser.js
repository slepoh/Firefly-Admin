/* Firefly CMS —— 配置文件结构化解析器
 *
 * 设计目标：
 * - 解析 TypeScript 配置对象字面量（如 siteConfig.ts、profileConfig.ts）。
 * - 提取每个「参数」的 名称(key) 与 值(value)，并记录值在源码中的起止偏移量。
 * - 参数名(key) 永远不可编辑；只有 值(value) 可编辑。
 * - applyConfigEdits 仅按偏移量替换「值文本」，原文件中的键名、注释、缩进、
 *   表达式、函数结构全部保持原样 —— 从机制上保证「不能修改参数，只能改参数值」。
 * - 对无法安全编辑的内容（引用表达式、函数调用、函数定义）自动降级为只读。
 */
(function () {
  "use strict";

  var FireflyConfig = {};

  function isWs(c) {
    return c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v";
  }
  function isIdentStart(c) {
    return c != null && /[A-Za-z_$]/.test(c);
  }
  function isIdentPart(c) {
    return c != null && /[A-Za-z0-9_$]/.test(c);
  }

  // 跳过空白与注释（仅在 token 之间调用，不会进入字符串内部）
  function skipWs(src, i) {
    while (i < src.length && isWs(src[i])) i++;
    while (i < src.length) {
      if (src[i] === "/" && src[i + 1] === "/") {
        while (i < src.length && src[i] !== "\n") i++;
      } else if (src[i] === "/" && src[i + 1] === "*") {
        i += 2;
        while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
        if (i < src.length) i += 2;
      } else {
        break;
      }
      while (i < src.length && isWs(src[i])) i++;
    }
    return i;
  }

  function parseValue(src, i) {
    i = skipWs(src, i);
    var c = src[i];
    if (c === "{") return parseObject(src, i);
    if (c === "[") return parseArray(src, i);
    if (c === '"' || c === "'") return parseString(src, i);
    if (c === "-" || (c >= "0" && c <= "9")) return parseNumber(src, i);
    if (src.startsWith("true", i)) return { type: "boolean", value: true, start: i, end: i + 4 };
    if (src.startsWith("false", i)) return { type: "boolean", value: false, start: i, end: i + 5 };
    if (src.startsWith("null", i)) return { type: "null", value: null, start: i, end: i + 4 };
    if (isIdentStart(c)) return parseExpr(src, i);
    throw new Error("无法识别的标记（位置 " + i + "）：" + src.slice(i, i + 24));
  }

  function parseObject(src, i) {
    var start = i;
    i++; // 跳过 {
    var node = { type: "object", children: [], start: start, end: 0 };
    while (true) {
      i = skipWs(src, i);
      if (src[i] === "}") { i++; break; }
      // 解析 key
      var key;
      var kc = src[i];
      if (kc === '"' || kc === "'") {
        var ks = parseString(src, i);
        key = ks.value;
        i = ks.end;
      } else if (isIdentStart(kc)) {
        var s = i;
        while (i < src.length && isIdentPart(src[i])) i++;
        key = src.slice(s, i);
      } else {
        throw new Error("对象键名非法（位置 " + i + "）");
      }
      i = skipWs(src, i);
      if (src[i] !== ":") throw new Error("缺少冒号（位置 " + i + "）");
      i++;
      var val = parseValue(src, i);
      node.children.push({ key: key, value: val });
      i = val.end;
      i = skipWs(src, i);
      if (src[i] === ",") { i++; continue; }
      if (src[i] === "}") { i++; break; }
      throw new Error("期望逗号或 }（位置 " + i + "）");
    }
    node.end = i;
    return node;
  }

  function parseArray(src, i) {
    var start = i;
    i++; // 跳过 [
    var node = { type: "array", children: [], start: start, end: 0 };
    while (true) {
      i = skipWs(src, i);
      if (src[i] === "]") { i++; break; }
      var val = parseValue(src, i);
      node.children.push({ value: val });
      i = val.end;
      i = skipWs(src, i);
      if (src[i] === ",") { i++; continue; }
      if (src[i] === "]") { i++; break; }
      throw new Error("期望逗号或 ]（位置 " + i + "）");
    }
    node.end = i;
    return node;
  }

  function parseString(src, i) {
    var quote = src[i];
    var start = i;
    i++;
    var inner = "";
    while (i < src.length) {
      var c = src[i];
      if (c === "\\") { inner += c + src[i + 1]; i += 2; continue; }
      if (c === quote) { i++; break; }
      inner += c;
      i++;
    }
    return { type: "string", value: inner, quote: quote, start: start, end: i };
  }

  function parseNumber(src, i) {
    var start = i;
    if (src[i] === "-") i++;
    while (i < src.length && /[0-9.]/.test(src[i])) i++;
    return { type: "number", value: Number(src.slice(start, i)), raw: src.slice(start, i), start: start, end: i };
  }

  // 引用 / 表达式（如 SITE_LANG、LinkPresets.Home）：只读，不可编辑
  function parseExpr(src, i) {
    var start = i;
    while (i < src.length) {
      var c = src[i];
      if (isIdentPart(c) || c === "." || c === "$") { i++; continue; }
      break;
    }
    return { type: "expr", value: src.slice(start, i), start: start, end: i };
  }

  /* 顶层扫描：找出 export const NAME = ... 或 const NAME = ...
   * 跳过函数定义 / 函数调用（整段不可编辑）；只解析值以 { [ " ' 数字 标识符 true/false/null 开头的定义。
   */
  FireflyConfig.parseConfig = function (src) {
    var roots = [];
    var re = /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^={\n]*?)?\s*=\s/g;
    var m;
    while ((m = re.exec(src))) {
      // 防误匹配：前一个非空白字符若是引号，说明落在字符串内部，跳过
      var bi = m.index - 1;
      while (bi >= 0 && isWs(src[bi])) bi--;
      if (bi >= 0 && (src[bi] === '"' || src[bi] === "'")) continue;

      var name = m[1];
      var i = m.index + m[0].length;
      var j = skipWs(src, i);
      var c = src[j];
      var isFunc = false;
      if (c === "(") {
        isFunc = true;
      } else if (isIdentStart(c)) {
        var ks = j;
        while (j < src.length && isIdentPart(src[j])) j++;
        var k = skipWs(src, j);
        if (src[k] === "(" || src[k] === "=" || src[k] === ">") isFunc = true;
      }
      if (isFunc) continue; // 函数定义 / 调用：不解析，保持原样

      var canParse =
        c === "{" || c === "[" || c === '"' || c === "'" ||
        (c >= "0" && c <= "9") || c === "-" || isIdentStart(c) ||
        src.startsWith("true", j) || src.startsWith("false", j) || src.startsWith("null", j);
      if (!canParse) continue;

      try {
        var node = parseValue(src, i);
        roots.push({ name: name, node: node, start: node.start, end: node.end });
      } catch (e) {
        // 单个定义解析失败：跳过该定义，避免整文件不可用
      }
    }
    if (roots.length === 0) return { roots: [], error: "未找到可结构化编辑的配置对象" };
    return { roots: roots, error: null };
  };

  /* 将编辑结果按偏移量写回源码：仅替换「值文本」，键名/注释/结构保持不变 */
  FireflyConfig.applyConfigEdits = function (src, edits) {
    var sorted = edits.slice().sort(function (a, b) { return b.start - a.start; });
    var out = src;
    for (var n = 0; n < sorted.length; n++) {
      var e = sorted[n];
      out = out.slice(0, e.start) + e.text + out.slice(e.end);
    }
    return out;
  };

  /* 把界面上的值编码回源码文本 */
  FireflyConfig.encodeValue = function (type, raw, quote) {
    if (type === "boolean") return raw ? "true" : "false";
    if (type === "null") return raw == null || raw === "" ? "null" : String(raw);
    if (type === "number") {
      var n = Number(raw);
      if (isNaN(n)) throw new Error("数字格式错误：" + raw);
      return String(n);
    }
    if (type === "string") {
      var q = quote || '"';
      var esc = String(raw).replace(/\\/g, "\\\\").replace(new RegExp("\\" + q, "g"), "\\" + q);
      return q + esc + q;
    }
    return String(raw);
  };

  // 同时兼容浏览器(window)与 Node(module) 环境，便于测试
  if (typeof window !== "undefined") window.FireflyConfig = FireflyConfig;
  if (typeof module !== "undefined" && module.exports) module.exports = FireflyConfig;
})();
