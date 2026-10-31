// A coding agent in one file: Claude works on a copy of your repository inside an agentbox sandbox.
//   npm start -- <repo path> "<task>"           result tree lands in <repo path>.agent-out, diff is printed
// Needs a running agentbox server (AGENTBOX_URL, default http://127.0.0.1:7788) and Anthropic credentials.
// Optional: AGENTBOX_API_KEY, AGENTBOX_TEMPLATE (an image with your toolchain), AGENTBOX_ALLOW_HOSTS (comma separated).
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { Agentbox, ExecTimeout, type Sandbox } from "../../sdk/src/index.js";

const REPO = "repo"; // where the repository lives inside the sandbox, under /workspace
const OUTPUT_LIMIT = 20_000; // characters of command output handed to the model

const env = process.env;
const agentbox = new Agentbox({ baseUrl: env.AGENTBOX_URL ?? "http://127.0.0.1:7788", ...(env.AGENTBOX_API_KEY ? { apiKey: env.AGENTBOX_API_KEY } : {}) });

// The four things the model can do, all inside the sandbox. Paths are relative to the repository root.
export function makeTools(box: Sandbox) {
  const inRepo = (path: string) => `${REPO}/${path.replace(/^\/+/, "")}`;
  const clip = (text: string) => (text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT)}\n... (${text.length - OUTPUT_LIMIT} more characters)` : text);

  const runCommand = betaZodTool({
    name: "run_command",
    description: "Run a program with arguments in the repository, for example [\"npm\", \"test\"] or [\"git\", \"diff\"]. Returns exit code, stdout and stderr. The sandbox has no network unless the server was given an allowlist.",
    inputSchema: z.object({
      cmd: z.array(z.string()).min(1),
      cwd: z.string().optional().describe("Subdirectory of the repository to run in"),
      timeoutMs: z.number().int().positive().max(600_000).optional().describe("Kill the program after this long; default 120000"),
    }),
    run: async ({ cmd, cwd, timeoutMs }) => {
      try {
        const r = await box.exec(cmd, { cwd: inRepo(cwd ?? ""), timeoutMs: timeoutMs ?? 120_000 });
        return `exit code: ${r.exitCode}${r.truncated ? " (output truncated)" : ""}\nstdout:\n${clip(r.stdout) || "(empty)"}\nstderr:\n${clip(r.stderr) || "(empty)"}`;
      } catch (err) {
        if (err instanceof ExecTimeout) return `killed after ${err.result.durationMs} ms\nstdout:\n${clip(err.result.stdout)}\nstderr:\n${clip(err.result.stderr)}`;
        throw err;
      }
    },
  });

  const readFile = betaZodTool({
    name: "read_file",
    description: "Return the text of a file in the repository.",
    inputSchema: z.object({ path: z.string() }),
    run: ({ path }) => box.readFile(inRepo(path)),
  });

  const writeFile = betaZodTool({
    name: "write_file",
    description: "Create or overwrite a file in the repository with the given text, creating parent directories.",
    inputSchema: z.object({ path: z.string(), content: z.string() }),
    run: async ({ path, content }) => {
      await box.writeFile(inRepo(path), content);
      return `wrote ${Buffer.byteLength(content)} bytes to ${path}`;
    },
  });

  // Replacing one exact passage is cheaper and safer than rewriting a whole file.
  const editFile = betaZodTool({
    name: "edit_file",
    description: "Replace one exact occurrence of `old` with `new` in a file. Fails if `old` is missing or appears more than once; include enough surrounding lines to make it unique.",
    inputSchema: z.object({ path: z.string(), old: z.string(), new: z.string() }),
    run: async ({ path, old, new: replacement }) => {
      const text = await box.readFile(inRepo(path));
      const count = text.split(old).length - 1;
      if (count !== 1) return `edit refused: \`old\` occurs ${count} times in ${path}; it must occur exactly once`;
      await box.writeFile(inRepo(path), text.replace(old, replacement));
      return `edited ${path}`;
    },
  });

  return [runCommand, readFile, writeFile, editFile];
}

const SYSTEM = `You are a software engineer working in a sandboxed copy of a repository at /workspace/${REPO}.
Work only through the tools. Look at the code before changing it, keep changes small and in the project's style,
and verify every change by running the project's tests or a focused check; never report a result you did not run.
Finish with a short summary of what you changed and what you ran.`;

export async function runTask(repoPath: string, task: string, outDir: string): Promise<string> {
  const allowHosts = (env.AGENTBOX_ALLOW_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  const box = await agentbox.create({
    ...(env.AGENTBOX_TEMPLATE ? { template: env.AGENTBOX_TEMPLATE } : {}),
    ...(allowHosts.length > 0 ? { allowHosts } : {}),
    ttlSeconds: 3600,
  });
  console.error(`sandbox ${box.id} (${box.info.startup.source}, ${box.info.startup.ms} ms)`);
  try {
    await box.uploadDirectory(repoPath, REPO);
    const client = new Anthropic();
    const runner = client.beta.messages.toolRunner({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      max_iterations: 80,
      // A safety refusal is retried on a fallback model chosen by the API instead of ending the run.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM,
      tools: makeTools(box),
      messages: [{ role: "user", content: task }],
    });
    for await (const message of runner) {
      for (const block of message.content) {
        if (block.type === "text" && block.text.trim()) console.error(`claude: ${block.text.trim()}`);
        if (block.type === "tool_use") console.error(`tool: ${block.name} ${JSON.stringify(block.input).slice(0, 200)}`);
      }
    }
    const final = await runner.runUntilDone();
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    await box.downloadDirectory(REPO, outDir);
    return final.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  } finally {
    await box.destroy().catch(() => {});
  }
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [repoPath, ...words] = process.argv.slice(2);
  if (!repoPath || words.length === 0) {
    console.error('usage: npm start -- <repo path> "<task>"');
    process.exit(1);
  }
  const outDir = `${repoPath.replace(/\/$/, "")}.agent-out`;
  const summary = await runTask(repoPath, words.join(" "), outDir);
  console.log(`\n${summary}\n`);
  console.log(`result tree: ${outDir}`);
  try {
    console.log(execFileSync("git", ["diff", "--no-index", "--stat", repoPath, outDir], { encoding: "utf8" }));
  } catch (e) {
    const stdout = (e as { stdout?: string }).stdout; // git diff exits 1 when there are differences
    if (stdout) console.log(stdout);
  }
}
