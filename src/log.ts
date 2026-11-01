import pino, { type Logger } from "pino";

export type { Logger };

// Silent inside the test runner unless LOG_LEVEL says otherwise, so test output stays readable.
const level = process.env.LOG_LEVEL ?? (process.env.NODE_TEST_CONTEXT === undefined ? "info" : "silent");
// Pretty single lines on a terminal, JSON lines for Docker, pm2 or a file.
const format = process.env.LOG_FORMAT ?? (process.stdout.isTTY ? "pretty" : "json");

// A root logger writing to one file descriptor: 1 for the server, 2 for the MCP server whose stdout carries the protocol.
export function rootLogger(fd: 1 | 2 = 1): Logger {
  if (format === "pretty") {
    return pino({
      level,
      transport: {
        target: "pino-pretty",
        options: { destination: fd, singleLine: true, ignore: "pid,hostname,component", messageFormat: "({component}) {msg}", translateTime: "HH:MM:ss.l" },
      },
    });
  }
  return pino({ level }, pino.destination(fd));
}

let root: Logger | undefined;

// The server's logger for one component (http, service, runtime, proxy, pool); every line carries the component name.
export function logFor(component: string): Logger {
  root ??= rootLogger(1);
  return root.child({ component });
}
