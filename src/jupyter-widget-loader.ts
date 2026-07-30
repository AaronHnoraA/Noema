export type AmdLoaderBindings = {
  requirejs?: unknown;
  require?: unknown;
  define?: unknown;
};

export function evaluateAmdLoaderSource(source: string): AmdLoaderBindings {
  // AMD loaders traditionally declare their API with top-level `var`.
  // Return those function-local bindings explicitly instead of depending on
  // a browser to reflect evaluated vars onto `window` (xwidget-webkit does not).
  const initialize = new Function(`${source}\nreturn { requirejs: typeof requirejs === "function" ? requirejs : undefined, require: typeof require === "function" ? require : undefined, define: typeof define === "function" ? define : undefined };\n//# sourceURL=aaronnote-amd-loader.js`);
  return initialize.call(window) as AmdLoaderBindings;
}

export function validWidgetModuleName(value: string): boolean {
  return /^(?:@[A-Za-z0-9._~-]+\/)?[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~/-]+)?$/.test(value)
    && !value.includes("..")
    && !value.includes("//");
}

export function validWidgetModuleVersion(value: string): boolean {
  return value.length <= 120 && /^[A-Za-z0-9*^~<>=|.+_ -]+$/.test(value);
}

function widgetModulePathParts(moduleName: string): { packageName: string; fileName: string } {
  let packageName = moduleName;
  let fileName = "index";
  let slash = moduleName.indexOf("/");
  if (slash >= 0 && moduleName.startsWith("@")) slash = moduleName.indexOf("/", slash + 1);
  if (slash >= 0) {
    packageName = moduleName.slice(0, slash);
    fileName = moduleName.slice(slash + 1);
  }
  return { packageName, fileName };
}

export function widgetModuleCdnUrls(moduleName: string, moduleVersion: string): string[] {
  if (!validWidgetModuleName(moduleName)) throw new Error(`Invalid widget module name: ${moduleName}`);
  if (!validWidgetModuleVersion(moduleVersion)) throw new Error(`Invalid widget module version: ${moduleVersion}`);
  const { packageName, fileName } = widgetModulePathParts(moduleName);
  const jsDelivrVersion = moduleVersion.startsWith("^") ? moduleVersion.slice(1) : moduleVersion;
  const jsDelivrFile = fileName.endsWith(".js") ? fileName : `${fileName}.js`;
  return [
    `https://cdn.jsdelivr.net/npm/${packageName}@${jsDelivrVersion}/dist/${jsDelivrFile}`,
    `https://unpkg.com/${packageName}@${moduleVersion}/dist/${fileName}`,
  ];
}

export function widgetModuleCdnUrl(moduleName: string, moduleVersion: string): string {
  return widgetModuleCdnUrls(moduleName, moduleVersion)[0];
}
