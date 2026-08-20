export function jupyterDefaultsFromEnv(env = process.env) {
  const requestedLanguage = String(env.AARONNOTE_JUPYTER_DEFAULT_LANGUAGE || "python").trim() || "python";
  const fallbackKernel = /^sage/i.test(requestedLanguage)
    ? "sagemath"
    : /^(?:bash|sh|shell|zsh)$/i.test(requestedLanguage)
      ? "bash"
      : "python3";
  const language = /^sage(?:math)?$/i.test(requestedLanguage)
    ? "python"
    : requestedLanguage;
  return {
    language,
    kernel: String(env.AARONNOTE_JUPYTER_DEFAULT_KERNEL || fallbackKernel).trim() || fallbackKernel,
    session: String(env.AARONNOTE_JUPYTER_DEFAULT_SESSION || "default").trim() || "default",
  };
}
