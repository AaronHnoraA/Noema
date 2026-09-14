// This function is passed directly to chrome.scripting.executeScript. Keep it
// self-contained: Chrome serializes the function body into the active tab.
export function extractCapture(mode) {
  const root = document.createElement("div");
  if (mode === "selection") {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount < 1 || selection.isCollapsed) {
      throw new Error("No non-empty selection is available");
    }
    for (let index = 0; index < selection.rangeCount; index += 1) {
      root.append(selection.getRangeAt(index).cloneContents());
    }
  } else {
    root.append((document.body || document.documentElement).cloneNode(true));
  }
  root.querySelectorAll("script,style,iframe,object,embed,template,noscript,form,input,button,textarea,select,option,canvas,svg").forEach((node) => node.remove());
  for (const element of root.querySelectorAll("*")) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const allowed = ["href", "src", "alt", "title", "colspan", "rowspan", "start"].includes(name);
      if (!allowed || name.startsWith("on")) element.removeAttribute(attribute.name);
    }
    for (const name of ["href", "src"]) {
      const value = String(element.getAttribute(name) || "").trim();
      if (/^(?:javascript|data|file|blob):/i.test(value) || value.startsWith("//")) {
        element.removeAttribute(name);
      }
    }
  }
  return {
    url: location.href,
    title: document.title || location.hostname,
    html: root.innerHTML,
    language: document.documentElement.lang || "",
  };
}
