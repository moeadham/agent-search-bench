import { readFile } from "node:fs/promises";

export interface ResolvedSecrets {
  env: Record<string, string>;
  values: string[];
  missing: string[];
}

export async function resolveSecrets(names: string[], source: NodeJS.ProcessEnv = process.env): Promise<ResolvedSecrets> {
  const env: Record<string, string> = {};
  const values: string[] = [];
  const missing: string[] = [];
  for (const name of names) {
    let value = source[name]?.trim();
    if (!value) {
      const file = source[`${name}_FILE`]?.trim();
      if (file) value = (await readFile(file, "utf8")).trim();
    }
    if (!value) {
      missing.push(name);
      continue;
    }
    env[name] = value;
    values.push(value);
  }
  return { env, values, missing };
}

export function safeBaseEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const keys = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "LANG", "LC_ALL", "TZ", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"];
  return Object.fromEntries(keys.flatMap((key) => source[key] ? [[key, source[key] as string]] : []));
}
