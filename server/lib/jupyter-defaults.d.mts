export interface JupyterDefaults {
  language: string;
  kernel: string;
  session: string;
}

export function jupyterDefaultsFromEnv(
  env?: Record<string, string | undefined>,
): JupyterDefaults;
