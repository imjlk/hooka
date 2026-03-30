export type BunEnvRecord = Record<string, string | undefined>;

export function getEnv(
  name: string,
  env: BunEnvRecord = Bun.env as BunEnvRecord,
): string | undefined {
  return env[name];
}

export function getEnvOrDefault(
  name: string,
  fallback: string,
  env: BunEnvRecord = Bun.env as BunEnvRecord,
): string {
  return getEnv(name, env) ?? fallback;
}

export function getNumberEnv(
  name: string,
  fallback: number,
  env: BunEnvRecord = Bun.env as BunEnvRecord,
): number {
  const raw = getEnv(name, env);

  if (!raw || raw.trim().length === 0) {
    return fallback;
  }

  return Number(raw);
}
