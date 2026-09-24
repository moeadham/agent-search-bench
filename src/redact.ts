// Catch common opaque credential prefixes without corrupting ordinary prose or
// URL slugs such as "api-providers". Configured secret literals, sensitive
// fields, auth headers, and secret query parameters are handled separately.
const KEY_PATTERN = /\b(?:(?:sk|pk|rk|fc)-[A-Za-z0-9._-]{12,}|BSA[A-Za-z0-9]{20,})\b/g;
const AUTH_PATTERN = /(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,}"']+/gi;
const QUERY_SECRET_PATTERN = /([?&](?:api_?key|access_?token|token|secret|key)=)[^&#\s]+/gi;
const SENSITIVE_FIELD_PATTERN = /^(?:authorization|proxy-authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|credential)$/i;

export function redactText(input: string, secrets: string[] = []): string {
  let value = input;
  for (const secret of [...secrets].filter((item) => item.length >= 4).sort((a, b) => b.length - a.length)) {
    value = value.split(secret).join("[REDACTED]");
  }
  return value
    .replace(AUTH_PATTERN, "$1[REDACTED]")
    .replace(QUERY_SECRET_PATTERN, "$1[REDACTED]")
    .replace(KEY_PATTERN, "[REDACTED]");
}

export function redactValue<T>(value: T, secrets: string[] = []): T {
  const visit = (current: unknown): unknown => {
    if (typeof current === "string") return redactText(current, secrets);
    if (Array.isArray(current)) return current.map(visit);
    if (current && typeof current === "object") {
      return Object.fromEntries(Object.entries(current).map(([key, child]) => [
        key,
        SENSITIVE_FIELD_PATTERN.test(key) ? "[REDACTED]" : visit(child),
      ]));
    }
    return current;
  };
  return visit(value) as T;
}
