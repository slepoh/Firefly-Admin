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

  // 跳过空白与注释，同时记录途中遇到的所有注释块（用于提取「参数名/说明」）
  function skipAndCollect(src, i) {
    var comments = [];
    while (i < src.length && isWs(src[i])) i++;
    while (i < src.length) {
      if (src[i] === "/" && src[i + 1] === "/") {
        var s = i;
        i += 2;
        while (i < src.length && src[i] !== "\n") i++;
        comments.push({ text: src.slice(s, i).replace(/^\/\/\s?/, ""), start: s, end: i });
      } else if (src[i] === "/" && src[i + 1] === "*") {
        var s2 = i;
        i += 2;
        while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
        if (i < src.length) i += 2;
        var t2 = src.slice(s2, i).replace(/^\/\*\s?/, "").replace(/\s*\*\/$/, "").replace(/\n\s*\*/g, "\n");
        comments.push({ text: t2, start: s2, end: i });
      } else {
        break;
      }
      while (i < src.length && isWs(src[i])) i++;
    }
    return { next: i, comments: comments };
  }

  // 行内尾注：值之后、逗号之前的 // 注释（同一行）
  function inlineTrailingComment(src, from) {
    var i = from;
    while (i < src.length && (src[i] === " " || src[i] === "\t")) i++;
    if (src[i] === "/" && src[i + 1] === "/") {
      var s = i;
      i += 2;
      while (i < src.length && src[i] !== "\n") i++;
      return src.slice(s, i).replace(/^\/\/\s?/, "");
    }
    return null;
  }

  // 多个注释块合并为单行说明（去多余空白）
  function joinComments(arr) {
    return arr
      .map(function (c) { return (c && c.text ? c.text : "").trim(); })
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // 跳过 TypeScript 类型断言：as const | as TypeName [<...>] | as Foo.Bar
  // 配置值可能带 `as const` / `as SomeType`（如 position: "bottom-left" as const），
  // 不处理会导致解析在值后遇到 `as` 直接抛错（整个 const 根被跳过）。
  function skipTypeAssertion(src, i) {
    i = skipWs(src, i);
    if (!/^as\b/.test(src.slice(i))) return i;
    i += 2; // 跳过 "as"
    i = skipWs(src, i);
    if (src.startsWith("const", i)) {
      i += 5;
    } else if (isIdentStart(src[i])) {
      while (i < src.length && (isIdentPart(src[i]) || src[i] === ".")) i++;
      if (src[i] === "<") {
        var depth = 0;
        while (i < src.length) {
          if (src[i] === "<") depth++;
          else if (src[i] === ">") { depth--; if (depth === 0) { i++; break; } }
          i++;
        }
      }
    }
    return i;
  }

  /* 从注释中识别「多选数值（枚举）」，用于把输入框渲染为下拉选择。
   * 例：// 评论系统类型: none, twikoo, waline, giscus, disqus, artalk，默认为none
   *   -> ["none","twikoo","waline","giscus","disqus","artalk"]（不含「默认为none」）
   * 识别策略：
   *  1) 注释中的纯标识符引号串 'enable' "force" 等（排除 URL / 含特殊字符的串）。
   *  2) 冒号之后的逗号分隔片段，取每段开头的连续标识符（如 none / waline），
   *     跳过含中文描述的片段（如「默认为none」只取不到 none，因为段首是中文）。
   * 返回 [{value,label}] 或 null（候选 < 2 视为非枚举，避免误判）。
   */
  function detectEnum(comment, val) {
    if (!comment) return null;
    var vals = [];
    // 1) 引号内的纯标识符（排除 URL 等含 : / @ 的内容）
    var qRe = /['"]([A-Za-z][A-Za-z0-9_-]*)['"]/g;
    var m;
    while ((m = qRe.exec(comment)) !== null) {
      vals.push({ value: m[1], label: m[1] });
    }
    // 2) 冒号之后的逗号分隔片段，取段首连续标识符
    var ci = comment.search(/[:：]/);
    if (ci >= 0) {
      var after = comment.slice(ci + 1);
      after.split(/[，,]/).forEach(function (chunk) {
        var mm = chunk.match(/^\s*([A-Za-z][A-Za-z0-9_-]*)/);
        if (mm) {
          var v = mm[1];
          // 排除明显像 URL / 协议头 / 超长串，降低误判
          if (/^https?$/i.test(v)) return;
          if (v.length > 24) return;
          vals.push({ value: v, label: v });
        }
      });
    }
    // 去重
    var seen = {};
    var out = [];
    vals.forEach(function (x) {
      if (seen[x.value]) return;
      seen[x.value] = true;
      out.push(x);
    });
    if (out.length < 2) return null;
    // 确保当前值也在选项中（即使不在枚举列表内也保留，标注「当前」）
    if (val && val.value != null) {
      var cur = String(val.value);
      if (!seen[cur]) out.push({ value: cur, label: cur + "（当前值）" });
    }
    return out;
  }

  // 提取某个位置之前的连续 // 注释行（用于根 const 的标题）
  function leadingCommentBefore(src, pos) {
    var lineStart = src.lastIndexOf("\n", pos - 1) + 1; // const 所在行开头
    var lines = [];
    var end = src.lastIndexOf("\n", lineStart - 1); // 上一行末尾的换行
    while (end >= 0) {
      var start = src.lastIndexOf("\n", end - 1) + 1;
      var line = src.slice(start, end).replace(/\s+$/, "").replace(/^\s+/, "");
      if (/^\/\//.test(line)) {
        lines.push(line.replace(/^\/\/\s?/, ""));
        end = src.lastIndexOf("\n", start - 1); // 继续向上找更早的注释行
      } else {
        break;
      }
    }
    if (!lines.length) return null;
    return lines.reverse().join(" ").replace(/\s+/g, " ").trim();
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
    var node = { type: "object", children: [], start: start, end: 0, comment: null };
    var prevEnd = i; // 紧跟 '{' 之后
    while (true) {
      var sc = skipAndCollect(src, prevEnd);
      var keyStart = sc.next;
      var leading = sc.comments;
      if (src[keyStart] === "}") { i = keyStart + 1; break; }
      // 解析 key
      var key;
      var kc = src[keyStart];
      if (kc === '"' || kc === "'") {
        var ks = parseString(src, keyStart);
        key = ks.value;
        i = ks.end;
      } else if (isIdentStart(kc)) {
        var s = keyStart;
        var ke = keyStart;
        while (ke < src.length && isIdentPart(src[ke])) ke++;
        key = src.slice(s, ke);
        i = ke;
      } else {
        throw new Error("对象键名非法（位置 " + keyStart + "）");
      }
      i = skipWs(src, i);
      if (src[i] !== ":") throw new Error("缺少冒号（位置 " + i + "）");
      i++;
      var val = parseValue(src, i);
      var afterVal = skipTypeAssertion(src, val.end);
      var trail = inlineTrailingComment(src, afterVal);
      var comment = leading.length ? joinComments(leading) : (trail || null);
      // 关键：把注释同步到 value 节点本身，否则嵌套对象/数组/叶子在渲染时读不到 comment，
      // 会回退为显示「参数名 / 函数名」。comment 仅用于显示，不参与偏移量回写。
      if (val && typeof val === "object") {
        val.comment = comment;
        // 注释中若列出可选数值（枚举），附加 enumValues 供前端渲染为下拉选择
        var enums = detectEnum(comment, val);
        if (enums && enums.length) val.enumValues = enums;
      }
      node.children.push({ key: key, value: val, comment: comment });
      i = afterVal;
      i = skipWs(src, i);
      if (src[i] === ",") { i++; prevEnd = i; continue; }
      if (src[i] === "}") { i++; break; }
      throw new Error("期望逗号或 }（位置 " + i + "）");
    }
    node.end = i;
    return node;
  }

  function parseArray(src, i) {
    var start = i;
    i++; // 跳过 [
    var node = { type: "array", children: [], start: start, end: 0, comment: null };
    var prevEnd = i; // 紧跟 '[' 之后
    while (true) {
      var sc = skipAndCollect(src, prevEnd);
      var elemStart = sc.next;
      var leading = sc.comments;
      if (src[elemStart] === "]") { i = elemStart + 1; break; }
      // 容忍空元素（如 ["a",, "b"] 中的双逗号 / 多余逗号 / 残留尾逗号）：
      // 直接跳到下一个逗号后继续，避免 parseValue 在「,」上抛错导致整段数组乃至
      // 整个配置对象被上层 catch 吞掉（表现为后台配置选项整片消失）。
      if (src[elemStart] === ",") { prevEnd = elemStart + 1; continue; }
      var val = parseValue(src, elemStart);
      var afterVal = skipTypeAssertion(src, val.end);
      var trail = inlineTrailingComment(src, afterVal);
      var comment = leading.length ? joinComments(leading) : (trail || null);
      if (val && typeof val === "object") {
        val.comment = comment;
        var enums2 = detectEnum(comment, val);
        if (enums2 && enums2.length) val.enumValues = enums2;
      }
      node.children.push({ value: val, comment: comment });
      i = afterVal;
      i = skipWs(src, i);
      if (src[i] === ",") { i++; prevEnd = i; continue; }
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
        var rootComment = leadingCommentBefore(src, m.index);
        roots.push({ name: name, node: node, start: node.start, end: node.end, comment: rootComment });
        // 关键：解析完一个根后，把正则扫描位置推进到「值末尾」，避免下次 exec 从值内部
        // （尤其字符串值）重新开始，从而把值文本里出现的 const 误判为新的配置根。
        re.lastIndex = node.end;
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
