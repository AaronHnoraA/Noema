export function jupyterDefaultsFromEnv(env = process.env) {
  const language = String(env.AARONNOTE_JUPYTER_DEFAULT_LANGUAGE || "python").trim() || "python";
  const fallbackKernel = /^sage/i.test(language)
    ? "sagemath"
    : /^(?:bash|sh|shell|zsh)$/i.test(language)
      ? "bash"
      : "python3";
  return {
    language,
    kernel: String(env.AARONNOTE_JUPYTER_DEFAULT_KERNEL || fallbackKernel).trim() || fallbackKernel,
    session: String(env.AARONNOTE_JUPYTER_DEFAULT_SESSION || "default").trim() || "default",
  };
}
