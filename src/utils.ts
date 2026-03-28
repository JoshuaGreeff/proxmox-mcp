import crypto from "node:crypto";

/** Normalizes optional scalar-or-array config values into a plain array. */
export function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

/** Converts simple `*` wildcard filters into case-insensitive regular expressions. */
export function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

/** Matches cluster, node, and target selectors used by repo policy rules. */
export function matchesPattern(value: string | number | undefined, patterns: string[] | undefined): boolean {
  if (patterns === undefined || patterns.length === 0) {
    return true;
  }

  if (value === undefined) {
    return patterns.includes("*");
  }

  const actual = String(value);
  return patterns.some((pattern) => wildcardToRegExp(pattern).test(actual));
}

/** Sleeps unless an abort signal cancels the operation first. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);

    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new Error("Operation aborted"));
        },
        { once: true },
      );
    }
  });
}

/** Redacts obvious secret-like fields before data is written to the audit log. */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item));
  }

  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (/(pass|secret|token|ticket|cookie|authorization|private.?key|otp)/i.test(key)) {
        result[key] = "<redacted>";
      } else if (/content/i.test(key) && typeof entry === "string" && entry.length > 256) {
        result[key] = `<redacted:${entry.length}chars>`;
      } else {
        result[key] = redactSecrets(entry);
      }
    }
    return result;
  }

  return value;
}

/** POSIX-shell-quotes a single argument. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

/** POSIX-shell-quotes and joins a full command argv. */
export function shellJoin(parts: string[]): string {
  return parts.map((part) => shellQuote(part)).join(" ");
}

/**
 * Normalizes the mixed boolean encodings returned by Proxmox config endpoints.
 *
 * Proxmox frequently serializes booleans as `1`, `0`, or inline config fragments
 * such as `enabled=1`. See:
 * https://pve.proxmox.com/wiki/Proxmox_VE_API
 */
export function normalizeBoolean(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return value !== 0;
  }

  if (typeof value === "string") {
    const normalized = value.toLowerCase().trim();
    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }

    if (/(^|[,;])\s*enabled=1(\s*|$)/i.test(normalized)) {
      return true;
    }

    if (/(^|[,;])\s*enabled=0(\s*|$)/i.test(normalized)) {
      return false;
    }
  }

  return false;
}

/** Pretty-prints data for human-readable MCP text responses. */
export function safeJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Returns an ISO-8601 timestamp suitable for audit and job records. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Creates a stable prefix plus UUID identifier for jobs and similar records. */
export function makeId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

/**
 * Decodes guest-agent output when it is actually base64, while leaving plain text untouched.
 *
 * Proxmox guest-agent responses may surface base64 payloads for file or exec data:
 * https://pve.proxmox.com/pve-docs/api-viewer/index.html
 */
export function decodeMaybeBase64(value: string | undefined): string {
  if (!value) {
    return "";
  }

  const normalized = value.replace(/\s+/g, "");
  if (normalized.length === 0 || normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/=]+$/.test(normalized)) {
    return value;
  }

  try {
    const decoded = Buffer.from(normalized, "base64").toString("utf8");
    return Buffer.from(decoded, "utf8").toString("base64").replace(/=+$/, "") === normalized.replace(/=+$/, "") ? decoded : value;
  } catch {
    return value;
  }
}

/** Returns a decoded buffer when a string is actually base64, otherwise returns its UTF-8 bytes. */
export function decodeMaybeBase64Buffer(value: string | undefined): Buffer {
  if (!value) {
    return Buffer.alloc(0);
  }

  const normalized = value.replace(/\s+/g, "");
  if (normalized.length === 0 || normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/=]+$/.test(normalized)) {
    return Buffer.from(value, "utf8");
  }

  try {
    const decoded = Buffer.from(normalized, "base64");
    return decoded.toString("base64").replace(/=+$/, "") === normalized.replace(/=+$/, "") ? decoded : Buffer.from(value, "utf8");
  } catch {
    return Buffer.from(value, "utf8");
  }
}

/** Parses optional JSON from environment variables with a typed fallback. */
export function parseJsonEnv<T>(raw: string | undefined, fallback: T): T {
  if (!raw) {
    return fallback;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
