// Model Context Protocol server over stdio: gives Claude Code, Cursor and other MCP clients a sandbox to run code in.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { rootLogger } from "../src/log.js";
import { Agentbox, AgentboxError, ExecTimeout, type CreateOptions, type ExecResult, type Sandbox } from "../sdk/src/index.js";

// stdout carries the protocol, so the log goes to stderr, which the MCP client keeps for its own log.
const log = rootLogger(2).child({ component: "mcp" });
const env = process.env;
const client = new Agentbox({
  baseUrl: env.AGENTBOX_URL ?? "http://127.0.0.1:7788",
  ...(env.AGENTBOX_API_KEY ? { apiKey: env.AGENTBOX_API_KEY } : {}),
});
const createOptions: CreateOptions = {
  ...(env.AGENTBOX_TEMPLATE ? { template: env.AGENTBOX_TEMPLATE } : {}),
  ...(env.AGENTBOX_ALLOW_HOSTS ? { allowHosts: env.AGENTBOX_ALLOW_HOSTS.split(",").map((h) => h.trim()).filter(Boolean) } : {}),
  ...(env.AGENTBOX_TTL_SECONDS ? { ttlSeconds: Number(env.AGENTBOX_TTL_SECONDS) } : {}),
};

const LANGUAGES = {
  python: { file: "main.py", cmd: ["python", "main.py"] },
  bash: { file: "main.sh", cmd: ["sh", "main.sh"] },
  javascript: { file: "main.js", cmd: ["node", "main.js"] },
};

// One sandbox per MCP session, created on first use and replaced once it has expired or been destroyed.
let current: Sandbox | undefined;

async function sandbox(): Promise<Sandbox> {
  if (current !== undefined) {
    const info = await current.refresh().catch(() => undefined);
    if (info !== undefined && (info.status === "ready" || info.status === "busy")) {
      // Keep a sandbox that is still in use alive instead of losing its files at the TTL.
      if (new Date(info.expiresAt).getTime() - Date.now() < 5 * 60_000) await current.extend().catch(() => {});
      return current;
    }
  }
  current = await client.create(createOptions);
  log.info({ sandbox: current.id, source: current.info.startup.source }, "sandbox opened for this session");
  return current;
}

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const text = (value: string, isError = false): ToolResult => ({ content: [{ type: "text", text: value }], ...(isError ? { isError } : {}) });

function describe(result: ExecResult): string {
  const notes = [`${(result.durationMs / 1000).toFixed(1)} s`, result.timedOut ? "killed at the deadline" : "", result.truncated ? "output truncated" : ""].filter(Boolean);
  return [
    `exit code: ${result.exitCode} (${notes.join(", ")})`,
    "stdout:",
    result.stdout || "(empty)",
    "stderr:",
    result.stderr || "(empty)",
  ].join("\n");
}

// Inside a sandbox every network failure looks like broken DNS, so a failed command gets told what it may reach.
const NETWORK_ERROR = /name resolution|Network is unreachable|ENOTFOUND|EAI_AGAIN|ENETUNREACH|getaddrinfo|Could not resolve host|CONNECT tunnel failed|403 Forbidden/i;

async function networkNote(box: Sandbox, result: ExecResult): Promise<string> {
  if (result.exitCode === 0 || !NETWORK_ERROR.test(result.stdout + result.stderr)) return "";
  const hosts = createOptions.allowHosts;
  if (hosts === undefined) return "\nnote: this sandbox has no network. Start the MCP server with AGENTBOX_ALLOW_HOSTS=host1,host2 to allow hosts.";
  const denied = (await box.egressLog().catch(() => ({ denied: [] }))).denied.slice(-5).map((d) => `${d.host}:${d.port} (${d.reason})`);
  return `\nnote: this sandbox reaches only ${hosts.join(", ")}.${denied.length > 0 ? ` The proxy refused: ${denied.join("; ")}.` : ""}`;
}

// Turns SDK errors into tool errors the model can read instead of crashing the server.
async function guarded(work: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof ExecTimeout) return text(describe(err.result), true);
    if (err instanceof AgentboxError) return text(`agentbox error (${err.code}, status ${err.status}): ${err.message}`, true);
    return text(`agentbox error: ${err instanceof Error ? err.message : String(err)}`, true);
  }
}

const server = new McpServer({ name: "agentbox", version: "0.2.0" });

server.registerTool(
  "run_code",
  {
    title: "Run code in the sandbox",
    description: "Writes the code to a file in the sandbox's /workspace and runs it. Returns exit code, stdout and stderr. The sandbox has no network unless the server was started with an allowlist.",
    inputSchema: {
      language: z.enum(["python", "bash", "javascript"]),
      code: z.string(),
      timeoutMs: z.number().int().positive().optional().describe("Kill the program after this long; the server default is 30 s"),
    },
  },
  ({ language, code, timeoutMs }) =>
    guarded(async () => {
      const box = await sandbox();
      const { file, cmd } = LANGUAGES[language];
      await box.writeFile(file, code);
      const result = await box.exec(cmd, timeoutMs === undefined ? {} : { timeoutMs });
      if (result.exitCode === 127 && language === "javascript") {
        return text(`${describe(result)}\nnode is not in this sandbox's image. Start the MCP server with AGENTBOX_TEMPLATE=node after building that template.`, true);
      }
      return text(describe(result) + (await networkNote(box, result)));
    }),
);

server.registerTool(
  "run_command",
  {
    title: "Run a command in the sandbox",
    description: "Runs a program with arguments in /workspace, for example [\"pip\", \"install\", \"requests\"] or [\"ls\", \"-la\"]. Returns exit code, stdout and stderr. The sandbox has no network unless the server was started with AGENTBOX_ALLOW_HOSTS.",
    inputSchema: {
      cmd: z.array(z.string()).min(1),
      cwd: z.string().optional().describe("Directory under /workspace to run in; relative paths start at /workspace"),
      timeoutMs: z.number().int().positive().optional(),
    },
  },
  ({ cmd, cwd, timeoutMs }) =>
    guarded(async () => {
      const box = await sandbox();
      const result = await box.exec(cmd, { ...(cwd === undefined ? {} : { cwd }), ...(timeoutMs === undefined ? {} : { timeoutMs }) });
      return text(describe(result) + (await networkNote(box, result)));
    }),
);

server.registerTool(
  "write_file",
  {
    title: "Write a file in the sandbox",
    description: "Writes text to a path under /workspace, creating parent directories. Relative paths start at /workspace.",
    inputSchema: { path: z.string(), content: z.string() },
  },
  ({ path, content }) =>
    guarded(async () => {
      await (await sandbox()).writeFile(path, content);
      return text(`wrote ${Buffer.byteLength(content)} bytes to ${path}`);
    }),
);

server.registerTool(
  "read_file",
  { title: "Read a file from the sandbox", description: "Returns the text of a file under /workspace.", inputSchema: { path: z.string() } },
  ({ path }) => guarded(async () => text(await (await sandbox()).readFile(path))),
);

server.registerTool(
  "reset_sandbox",
  { title: "Reset the sandbox", description: "Destroys the current sandbox. The next tool call gets a fresh one with an empty /workspace.", inputSchema: {} },
  () =>
    guarded(async () => {
      const old = current;
      current = undefined;
      if (old !== undefined) await old.destroy().catch(() => {});
      return text(old === undefined ? "no sandbox was open" : `destroyed sandbox ${old.id}`);
    }),
);

/**
 * When the client goes away, so does the session's sandbox. A client ends our stdin first and
 * only signals later, so stdin ending, the transport closing and a signal all share one destroy.
 */
let closing: Promise<void> | undefined;
function closeSandbox(): Promise<void> {
  closing ??= (async () => {
    const old = current;
    current = undefined;
    if (old === undefined) return;
    log.info({ sandbox: old.id }, "client gone, destroying the session sandbox");
    await old.destroy().catch((err: unknown) => log.error({ sandbox: old.id, err }, "destroy failed"));
  })();
  return closing;
}
const leave = () => void closeSandbox().finally(() => process.exit(0));
process.stdin.once("end", leave);
server.server.onclose = () => void closeSandbox();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, leave);

await server.connect(new StdioServerTransport());
log.info({ server: client["baseUrl"] }, "connected");
