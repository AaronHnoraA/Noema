export function buildKernelEnv(options?: {
  kernelSpecEnv?: Record<string, string>;
  runtimeBinDir?: string;
  /** @deprecated Use runtimeBinDir. */
  venvBinDir?: string;
  pythonNoUserSite?: boolean;
}): NodeJS.ProcessEnv;
