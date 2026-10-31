// A Mastra agent that writes Python and runs it in an agentbox sandbox.
// Needs a running agentbox server (AGENTBOX_URL, default http://127.0.0.1:7788) and ANTHROPIC_API_KEY.
import { anthropic } from "@ai-sdk/anthropic";
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { Agentbox, ExecTimeout, type Sandbox } from "../../sdk/src/index.js";

const agentbox = new Agentbox({
  baseUrl: process.env.AGENTBOX_URL ?? "http://127.0.0.1:7788",
  ...(process.env.AGENTBOX_API_KEY ? { apiKey: process.env.AGENTBOX_API_KEY } : {}),
});
// AGENTBOX_ALLOW_HOSTS="pypi.org,files.pythonhosted.org" lets the agent pip install; unset means no network.
const allowHosts = (process.env.AGENTBOX_ALLOW_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean);

// One sandbox for the whole conversation, so a file written by one tool call is still there for the next.
let box: Sandbox | undefined;

export async function sandbox(): Promise<Sandbox> {
  if (box !== undefined) {
    const info = await box.refresh().catch(() => undefined);
    if (info?.status === "ready" || info?.status === "busy") return box;
  }
  box = await agentbox.create(allowHosts.length > 0 ? { allowHosts } : {});
  return box;
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export async function runPythonInSandbox(code: string): Promise<RunResult> {
  const current = await sandbox();
  await current.writeFile("main.py", code);
  try {
    const r = await current.exec(["python", "main.py"], { timeoutMs: 60_000 });
    return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, timedOut: false };
  } catch (err) {
    if (err instanceof ExecTimeout) return { exitCode: err.result.exitCode, stdout: err.result.stdout, stderr: err.result.stderr, timedOut: true };
    throw err;
  }
}

export const runPython = createTool({
  id: "run_python",
  description: "Runs Python code in an isolated sandbox and returns the exit code, stdout and stderr. Files written under /workspace stay for later calls.",
  inputSchema: z.object({ code: z.string().describe("Python source to run as main.py") }),
  outputSchema: z.object({ exitCode: z.number(), stdout: z.string(), stderr: z.string(), timedOut: z.boolean() }),
  execute: async ({ code }) => runPythonInSandbox(code),
});

export const agent = new Agent({
  id: "sandboxed-coder",
  name: "Sandboxed coder",
  instructions:
    "You solve tasks by writing Python and running it with the run_python tool. Always run the code rather than predicting its output, report the real output, and fix errors by editing and re-running.",
  model: anthropic("claude-opus-5-5"),
  tools: { runPython },
});

// Only when run as a script, so the tool can be imported and tested without an API key.
if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const task = process.argv.slice(2).join(" ") || "Compute the first ten prime numbers and print them.";
  const result = await agent.generate(task);
  console.log(result.text);
  if (box !== undefined) await box.destroy();
}
