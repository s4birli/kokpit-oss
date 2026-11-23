// Synthetic Claude Code session transcripts for the Claude kullanımı tests (engine and Electron). Never real ones:
// every line is built here, in the shape Claude Code 2.1.x writes (one JSONL line per content block of an assistant
// message, each repeating the message's `usage`), with marker texts where real transcripts hold conversation text.
import { appendFileSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Planted wherever a real transcript holds text, titles or deep paths; must never leave the reader. */
export const SECRET_TEXT = "GIZLI-ILETI-METNI-7f3a";
export const SECRET_TITLE = "GIZLI-OTURUM-BASLIGI-91bc";
export const SECRET_SUBDIR = "gizli-alt-klasor-55d0";

export interface FixtureMessage {
  id: string;
  /** Defaults to `req-<id>`; null = the line has no request id. */
  requestId?: string | null;
  /** Epoch ms. */
  t: number;
  model?: string;
  cwd?: string;
  input?: number;
  output?: number;
  cacheWrite?: number;
  cacheRead?: number;
  /** Lines written for this message (Claude Code writes one per content block). Default 1. */
  blocks?: number;
}

export const DEFAULT_MODEL = "claude-opus-5-5";

/** The JSONL lines of one assistant message. */
export function assistantLines(m: FixtureMessage): string[] {
  const lines: string[] = [];
  for (let b = 0; b < (m.blocks ?? 1); b++) {
    lines.push(
      JSON.stringify({
        parentUuid: `parent-${m.id}`,
        isSidechain: false,
        type: "assistant",
        uuid: `uuid-${m.id}-${b}`,
        timestamp: new Date(m.t + b).toISOString(),
        cwd: m.cwd ?? "/tmp/none",
        sessionId: "00000000-0000-4000-8000-000000000000",
        gitBranch: SECRET_TITLE,
        ...(m.requestId === null ? {} : { requestId: m.requestId ?? `req-${m.id}` }),
        message: {
          id: m.id,
          type: "message",
          role: "assistant",
          model: m.model ?? DEFAULT_MODEL,
          content: [{ type: "text", text: `${SECRET_TEXT} blok ${b}` }],
          stop_reason: "end_turn",
          usage: {
            input_tokens: m.input ?? 0,
            output_tokens: m.output ?? 0,
            cache_creation_input_tokens: m.cacheWrite ?? 0,
            cache_read_input_tokens: m.cacheRead ?? 0,
            cache_creation: { ephemeral_1h_input_tokens: m.cacheWrite ?? 0, ephemeral_5m_input_tokens: 0 },
            service_tier: "standard",
          },
        },
      }),
    );
  }
  return lines;
}

/** Lines that carry no usage: a user prompt, a title, a tool result mentioning the word "usage". */
export function noiseLines(t: number): string[] {
  return [
    JSON.stringify({ type: "user", timestamp: new Date(t).toISOString(), cwd: `/tmp/${SECRET_SUBDIR}`, message: { role: "user", content: SECRET_TEXT } }),
    JSON.stringify({ type: "ai-title", title: SECRET_TITLE, sessionId: "s" }),
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: `"type":"assistant" "usage" ${SECRET_TEXT}` }] } }),
  ];
}

export interface TranscriptOptions {
  /** File mtime (epoch ms); default: the newest message's time. */
  mtime?: number;
  /** Extra raw lines appended as they are (malformed JSON, oversized lines, …). */
  raw?: string[];
  noise?: boolean;
}

/** Writes `<configDir>/projects/<relPath>` (parents created) and returns its path. */
export function writeTranscript(configDir: string, relPath: string, messages: FixtureMessage[], opts: TranscriptOptions = {}): string {
  const file = join(configDir, "projects", relPath);
  mkdirSync(dirname(file), { recursive: true });
  const lines = [...(opts.noise === false ? [] : noiseLines(messages[0]?.t ?? 0)), ...messages.flatMap(assistantLines), ...(opts.raw ?? [])];
  writeFileSync(file, lines.map((l) => `${l}\n`).join(""));
  touch(file, opts.mtime ?? Math.max(0, ...messages.map((m) => m.t)));
  return file;
}

/** Appends messages to an existing transcript and moves its mtime. */
export function appendTranscript(file: string, messages: FixtureMessage[], mtime: number): void {
  appendFileSync(file, messages.flatMap(assistantLines).map((l) => `${l}\n`).join(""));
  touch(file, mtime);
}

export function touch(file: string, ms: number): void {
  const s = ms / 1000;
  utimesSync(file, s, s);
}
