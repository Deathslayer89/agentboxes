// Model Context Protocol server over stdio: gives Claude Code, Cursor and other MCP clients a sandbox to run code in.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Agentbox, AgentboxError, ExecTimeout, type CreateOptions, type ExecResult, type Sandbox } from "../sdk/src/index.js";

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
  console.error(`agentbox mcp: using sandbox ${current.id} (${current.info.startup.source})`);
  return current;
}

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const text = (value: string, isError = false): ToolResult => ({ content: [{ type: "text", text: value }], ...(isError ? { isError } : {}) });

function describe(result: ExecResult): string {
  const notes = [result.timedOut ? `killed at the ${result.durationMs} ms deadline` : "", result.truncated ? "output truncated" : ""].filter(Boolean);
  return [
    `exit code: ${result.exitCode}${notes.length > 0 ? ` (${notes.join(", ")})` : ""}`,
    "stdout:",
    result.stdout || "(empty)",
    "stderr:",
    result.stderr || "(empty)",
  ].join("\n");
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

const server = new McpServer({ name: "agentbox", version: "0.1.0" });

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
      return text(describe(await box.exec(cmd, timeoutMs === undefined ? {} : { timeoutMs })));
    }),
);

server.registerTool(
  "run_command",
  {
    title: "Run a command in the sandbox",
    description: "Runs a program with arguments in /workspace, for example [\"pip\", \"install\", \"requests\"] or [\"ls\", \"-la\"]. Returns exit code, stdout and stderr.",
    inputSchema: {
      cmd: z.array(z.string()).min(1),
      cwd: z.string().optional().describe("Directory under /workspace to run in; relative paths start at /workspace"),
      timeoutMs: z.number().int().positive().optional(),
    },
  },
  ({ cmd, cwd, timeoutMs }) =>
    guarded(async () => text(describe(await (await sandbox()).exec(cmd, { ...(cwd === undefined ? {} : { cwd }), ...(timeoutMs === undefined ? {} : { timeoutMs }) })))),
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

await server.connect(new StdioServerTransport());
console.error(`agentbox mcp: connected, server ${client["baseUrl"]}`);
