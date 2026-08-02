// Noema 简体中文插件 - 渲染进程翻译器。
// 本文件不直接运行；桌面插件宿主通过两条通用通道投递：
//   ① protocol.handle 把本文件内联进 HTML <head>（主路径，解析时同步执行）
//   ② dom-ready 时 executeJavaScript 注入（兜底路径）
// 因此本文件必须是一个「接收 dict 参数的函数表达式」，不能有任何顶层副作用语句。
(function zhRenderer(dict) {
  // 幂等标志要跨「隔离世界」可见（内联脚本在主世界，executeJavaScript 兜底也在主世界，
  // 但历史上曾有 preload 隔离世界路径），统一以 DOM 属性为共享标志，window 标志作快速路径。
  function alreadyPatched() {
    if (window.__zhPatched) return true;
    var de = document.documentElement;
    return !!(de && de.hasAttribute("data-zh-patched"));
  }
  function markPatched() {
    window.__zhPatched = true;
    try {
      if (document.documentElement) document.documentElement.setAttribute("data-zh-patched", "1");
    } catch (err) { /* ignore */ }
  }
  if (alreadyPatched()) return "already-patched";
  markPatched();

  var exact = (dict && dict.exact) || {};
  var regexRules = [];
  for (var i = 0; i < ((dict && dict.regex) || []).length; i++) {
    try {
      regexRules.push({ re: new RegExp(dict.regex[i].pattern), replace: dict.regex[i].replace });
    } catch (err) { /* 跳过坏正则，永不阻断 */ }
  }

  var SKIP_SELECTOR = ".cm-content"; // 编辑器文档区，绝不翻译
  var reportedMisses = {};
  var MISS_CAP = 2000;

  function translateText(s) {
    if (typeof s !== "string" || s.length === 0 || s.length > 500) return null;
    try {
      if (Object.prototype.hasOwnProperty.call(exact, s)) return exact[s];
      // 保留首尾空白的 trim 匹配（词典 key 两种约定都兼容）
      var m = s.match(/^(\s*)(\S[\s\S]*?\S|\S)(\s*)$/);
      if (m && Object.prototype.hasOwnProperty.call(exact, m[2])) return m[1] + exact[m[2]] + m[3];
      for (var i = 0; i < regexRules.length; i++) {
        if (regexRules[i].re.test(s)) return s.replace(regexRules[i].re, regexRules[i].replace);
      }
      if (m) {
        var core = m[2];
        for (var j = 0; j < regexRules.length; j++) {
          if (regexRules[j].re.test(core)) return m[1] + core.replace(regexRules[j].re, regexRules[j].replace) + m[3];
        }
      }
    } catch (err) { /* 返回 null 保持原文 */ }
    return null;
  }

  function looksLikeUiText(s) {
    // 只上报「像英文 UI 文案」的未命中，避免把用户笔记、路径、数据刷进 misses.log
    if (!s || s.length > 120) return false;
    if (!/[A-Za-z]/.test(s)) return false;
    if (!/^[A-Za-z0-9]/.test(s.trim())) return false;
    if (/[/\\]/.test(s)) return false; // 路径
    return true;
  }

  function reportMiss(s) {
    try {
      var key = s.trim();
      if (!looksLikeUiText(key)) return;
      if (reportedMisses[key]) return;
      if (Object.keys(reportedMisses).length >= MISS_CAP) return;
      reportedMisses[key] = true;
      console.log("[NOEMA_ZH_MISS] " + key.replace(/\s+/g, " "));
    } catch (err) { /* ignore */ }
  }

  function isSkipped(node) {
    for (var el = node.nodeType === 1 ? node : node.parentElement; el; el = el.parentElement) {
      if (el.matches && el.matches(SKIP_SELECTOR)) return true;
    }
    return false;
  }

  function translateTextNode(node) {
    if (!node || !node.nodeValue || isSkipped(node)) return;
    var before = node.nodeValue;
    var after = translateText(before);
    if (after !== null && after !== before) {
      node.nodeValue = after;
    } else if (after === null && before.trim().length > 1) {
      reportMiss(before);
    }
  }

  var ATTRS = ["title", "placeholder", "aria-label"];
  function translateElement(el) {
    if (!el || !el.getAttribute || isSkipped(el)) return;
    for (var i = 0; i < ATTRS.length; i++) {
      var attr = ATTRS[i];
      var before = el.getAttribute(attr);
      if (!before) continue;
      var after = translateText(before);
      if (after !== null && after !== before) el.setAttribute(attr, after);
    }
  }

  // 显式栈遍历（元素+文本），在元素层面对 .cm-content 整棵子树 continue——真剪枝。
  // （TreeWalker(SHOW_TEXT) 无法在进入子树前剪枝，大文档下会把闪烁变成卡顿。）
  function walk(root) {
    if (!root) return;
    try {
      var stack = [root];
      while (stack.length) {
        var node = stack.pop();
        var type = node.nodeType;
        if (type === 1) {
          var tag = node.tagName;
          if (tag === "SCRIPT" || tag === "STYLE" || tag === "TEXTAREA") continue;
          if (node.matches && node.matches(SKIP_SELECTOR)) continue; // 真剪枝：整棵子树不进入
          translateElement(node);
          for (var child = node.lastChild; child; child = child.previousSibling) stack.push(child);
        } else if (type === 3) {
          translateTextNode(node);
        }
      }
    } catch (err) { /* ignore */ }
  }

  function translateTitle() {
    try {
      var t = document.title;
      var after = translateText(t);
      if (after !== null && after !== t) document.title = after;
    } catch (err) { /* ignore */ }
  }

  // cloak 解除：首轮 UI 变更被同步翻译后，在下一个渲染机会移除 pending 属性。
  // 真正的 fail-open 兜底是 cloak 自身的 CSS 动画超时（JS 全部失效也会自动回英文）。
  var uncloaked = false;
  function uncloak() {
    if (uncloaked) return;
    uncloaked = true;
    try {
      requestAnimationFrame(function () {
        try {
          document.documentElement.removeAttribute("data-noema-plugins-pending");
        } catch (err) { /* ignore */ }
      });
    } catch (err) {
      try {
        document.documentElement.removeAttribute("data-noema-plugins-pending");
      } catch (err2) { /* ignore */ }
    }
  }
  window.addEventListener("load", uncloak, { once: true });
  setTimeout(uncloak, 2000); // JS 兜底（正常路径远早于此）

  // 对 Observer 安装后、观察范围内发生的普通 DOM 变更，MutationObserver 微任务通常在
  // 下一次渲染更新前执行；回调内同步翻译可避免这些变更以英文状态进入下一帧。
  // （此前用 50ms debounce，延迟越过首帧导致每页先闪一帧英文；现改为回调内同步处理。）
  var observer = new MutationObserver(function (mutations) {
    var sawUiChange = false;
    for (var i = 0; i < mutations.length; i++) {
      var mu = mutations[i];
      try {
        if (mu.type === "characterData") {
          translateTextNode(mu.target);
        } else if (mu.type === "attributes") {
          translateElement(mu.target);
        } else {
          // childList 只处理 addedNodes（不反复全扫 mutation.target），.cm-content 在 walk 根处剪枝
          for (var j = 0; j < mu.addedNodes.length; j++) {
            var n = mu.addedNodes[j];
            if (n.nodeType === 1) {
              sawUiChange = true;
              walk(n);
            } else if (n.nodeType === 3) {
              translateTextNode(n);
            }
          }
        }
      } catch (err) { /* ignore */ }
    }
    translateTitle();
    if (sawUiChange) uncloak();
  });

  // 立即安装 Observer（本脚本经 <head> bootstrap 注入，执行时应用脚本尚未运行，
  // 不需要也不能等 DOMContentLoaded）；对已存在的部分做首轮遍历。
  function boot() {
    try {
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ATTRS,
      });
      walk(document.documentElement);
      translateTitle();
    } catch (err) { /* ignore */ }
  }

  if (document.documentElement) boot();
  else document.addEventListener("DOMContentLoaded", boot, { once: true });

  return "patched";
})
