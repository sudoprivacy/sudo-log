const MAX_STRING_LENGTH = 32_000;

const REDACTION_PATTERNS: Array<[RegExp, string]> = [
  [/(authorization\s*[:=]\s*bearer\s+)[a-z0-9._\-]+/gi, '$1<redacted>'],
  [/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password)\s*[:=]\s*)["']?[^"',\s}]+/gi, '$1<redacted>'],
  [/sk-[a-zA-Z0-9_\-]{12,}/g, 'sk-<redacted>'],
  [/\/Users\/[^/\s]+/g, '/Users/<redacted>'],
  [/C:\\Users\\[^\\\s]+/gi, 'C:\\Users\\<redacted>'],
];

export function redactString(value: string): string {
  let result = value.slice(0, MAX_STRING_LENGTH);
  for (const [pattern, replacement] of REDACTION_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

export function sanitizeScalar(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

export function sanitizeAttributes(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};

  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(key)) continue;
    if (raw === undefined || raw === null) continue;

    const stringValue =
      typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean'
        ? String(raw)
        : JSON.stringify(raw);

    result[key] = redactString(stringValue).slice(0, 2000);
  }
  return result;
}

