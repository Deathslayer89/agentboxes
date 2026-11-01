import pino, { type Logger } from "pino";

// A logger whose lines land in an array as parsed objects, so a test can assert on what was logged.
export function captureLog(): { log: Logger; entries: Array<Record<string, unknown>> } {
  const entries: Array<Record<string, unknown>> = [];
  const log = pino({ level: "debug" }, { write: (line: string) => void entries.push(JSON.parse(line) as Record<string, unknown>) });
  return { log, entries };
}
