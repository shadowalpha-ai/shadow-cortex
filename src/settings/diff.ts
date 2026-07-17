/**
 * Flat dot-path diff between two settings objects — feeds the
 * settings_changed audit event and the dashboard's restart banner.
 */

export interface FieldChange {
  path: string;
  from: unknown;
  to: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Order-insensitive deep equality via key-sorted canonicalization. */
export function canonicalEqual(a: unknown, b: unknown): boolean {
  return canonicalize(a) === canonicalize(b);
}

function canonicalize(value: unknown): string {
  if (isPlainObject(value)) {
    const entries = Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`);
    return `{${entries.join(",")}}`;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  return JSON.stringify(value);
}

export function diffSettings(a: unknown, b: unknown, prefix = ""): FieldChange[] {
  if (canonicalEqual(a, b)) return [];
  if (isPlainObject(a) && isPlainObject(b)) {
    const changes: FieldChange[] = [];
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const path = prefix ? `${prefix}.${key}` : key;
      changes.push(...diffSettings(a[key], b[key], path));
    }
    return changes;
  }
  return [{ path: prefix || "(root)", from: a, to: b }];
}
