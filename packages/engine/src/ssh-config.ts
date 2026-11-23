// Pure parser for an OpenSSH client config (~/.ssh/config). Extracts only the
// concrete `Host` aliases and the few options Kokpit shows. Patterns (`*`, `?`,
// `!`), `Match` blocks and `Include` are ignored. Never throws.

export interface SshConfigEntry {
  alias: string;
  hostname?: string;
  user?: string;
  port?: number;
  identityFile?: string;
}

const MIN_PORT = 1;
const MAX_PORT = 65535;
const PATTERN_CHARS = /[*?!]/;

/** Splits the arguments of a config line: whitespace-separated, `"…"` quoting, `#` starts a comment. */
function splitArgs(rest: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < rest.length) {
    const ch = rest[i]!;
    if (ch === " " || ch === "\t") {
      i++;
      continue;
    }
    if (ch === "#") break;
    if (ch === '"') {
      const end = rest.indexOf('"', i + 1);
      if (end === -1) return out; // unterminated quote: ssh rejects the line; we keep what we have
      out.push(rest.slice(i + 1, end));
      i = end + 1;
      continue;
    }
    let j = i;
    while (j < rest.length && rest[j] !== " " && rest[j] !== "\t") j++;
    out.push(rest.slice(i, j));
    i = j;
  }
  return out;
}

/** Splits a line into a lowercase keyword and its arguments; null for blank/comment lines. */
function splitLine(raw: string): { key: string; args: string[] } | null {
  const line = raw.trim();
  if (line === "" || line.startsWith("#")) return null;
  const m = /^([^\s=]+)(?:\s*=\s*|\s+)?(.*)$/.exec(line);
  if (!m) return null;
  return { key: m[1]!.toLowerCase(), args: splitArgs(m[2] ?? "") };
}

function parsePort(v: string): number | undefined {
  if (!/^\d{1,5}$/.test(v)) return undefined;
  const n = Number(v);
  return n >= MIN_PORT && n <= MAX_PORT ? n : undefined;
}

export function parseSshConfig(text: string): SshConfigEntry[] {
  if (typeof text !== "string") return [];
  const entries: SshConfigEntry[] = [];
  const seen = new Set<string>();
  /** Entries created by the current Host line; null outside a Host block (top level or Match). */
  let current: SshConfigEntry[] | null = null;

  for (const raw of text.split(/\r?\n/)) {
    const parsed = splitLine(raw);
    if (!parsed) continue;
    const { key, args } = parsed;

    if (key === "host") {
      current = [];
      for (const alias of args) {
        if (alias === "" || PATTERN_CHARS.test(alias) || /\s/.test(alias) || seen.has(alias)) continue;
        seen.add(alias);
        const entry: SshConfigEntry = { alias };
        entries.push(entry);
        current.push(entry);
      }
      continue;
    }
    if (key === "match") {
      current = null;
      continue;
    }
    if (!current || current.length === 0) continue;
    const value = args[0];
    if (value === undefined || value === "") continue;

    for (const e of current) {
      switch (key) {
        case "hostname":
          e.hostname ??= value;
          break;
        case "user":
          e.user ??= value;
          break;
        case "port":
          e.port ??= parsePort(value);
          if (e.port === undefined) delete e.port;
          break;
        case "identityfile":
          e.identityFile ??= value;
          break;
        default:
          break;
      }
    }
  }
  return entries;
}
