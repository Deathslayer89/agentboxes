# The HTTP API, the SDKs and the MCP server

Every endpoint with curl, then the TypeScript and Python clients and the MCP server. The server is `agentbox serve` from the package or `npm start` from a clone.

```bash
# create a sandbox (all fields optional: template, memoryMb, cpus, diskMb, pids, ttlSeconds)
curl -s -X POST localhost:7788/sandboxes -d '{}'
# {"id":"sbx_...","status":"ready","limits":{...},"startup":{"source":"pool","ms":0.3},"createdAt":"...","expiresAt":"..."}

# run a command
curl -s -X POST localhost:7788/sandboxes/sbx_.../exec -d '{"cmd":["python","-c","print(2+2)"],"timeoutMs":5000}'
# {"exitCode":0,"stdout":"4\n","stderr":"","durationMs":...,"timedOut":false,"truncated":false}
# past timeoutMs the command and its process group are killed: exitCode 137, timedOut true. A command that pushes the
# sandbox past its memory cap takes the whole sandbox down (gVisor is one host process); the record then says destroyed
# within the reaper's 10 s tick, and every later call on it answers 409.

# same body, but stdout and stderr arrive as Server-Sent Events while the command runs, then an exit event
curl -s -N -X POST localhost:7788/sandboxes/sbx_.../exec/stream -d '{"cmd":["python","-c","import time\nfor i in range(3): print(i); time.sleep(1)"]}'
# event: stdout        data: "0\n"
# event: stdout        data: "1\n"
# event: stdout        data: "2\n"
# event: exit          data: {"exitCode":0,"durationMs":3045,"timedOut":false,"truncated":false}

# run in a subdirectory with extra environment, for this command only
curl -s -X POST localhost:7788/sandboxes/sbx_.../exec -d '{"cmd":["npm","test"],"cwd":"app","env":{"CI":"1"}}'

# files live under /workspace; relative paths start there, ".." that leaves it is a 400
curl -s -X PUT --data-binary @main.py "localhost:7788/sandboxes/sbx_.../files?path=main.py"
curl -s "localhost:7788/sandboxes/sbx_.../files?path=main.py"

# whole trees as tar archives: a repository in, the results out
tar -c -C ./myrepo . | curl -s -X PUT --data-binary @- "localhost:7788/sandboxes/sbx_.../archive?path=repo"
curl -s "localhost:7788/sandboxes/sbx_.../archive?path=repo" | tar -x -C ./out

# keep a sandbox alive while it is in use: expiry becomes now plus ttlSeconds (default: its own TTL)
curl -s -X POST localhost:7788/sandboxes/sbx_.../extend -d '{"ttlSeconds":1800}'

# list (live ones; add ?all=true for expired and destroyed), get, destroy
curl -s localhost:7788/sandboxes
curl -s localhost:7788/sandboxes/sbx_...
curl -s -X DELETE localhost:7788/sandboxes/sbx_...
```

## TypeScript SDK

The client has no dependencies and needs Node 20+. From npm: `npm install agentboxes`, then `import { Agentbox } from "agentboxes"`, types included. From a clone, import `../sdk/src/index.js` as `examples/sdk-basic.ts` does; a one-off script outside the repo should be an `.mts` file, or tsx treats it as CommonJS and refuses top-level `await`.

```ts
import { Agentbox, ExecTimeout } from "../sdk/src/index.js";

const agentbox = new Agentbox({ baseUrl: "http://127.0.0.1:7788", apiKey: process.env.AGENTBOX_API_KEY });
const box = await agentbox.create({ template: "default", ttlSeconds: 300, allowHosts: ["pypi.org"] });

const r = await box.exec(["python", "-c", "print(2+2)"]);        // { exitCode, stdout, stderr, durationMs, truncated }
await box.writeFile("main.py", "print('hello')");
const code = await box.readFile("main.py");
await box.uploadDirectory("./myrepo", "repo");                     // whole tree in, through the system tar
const r2 = await box.exec(["npm", "test"], { cwd: "repo", env: { CI: "1" } });
await box.downloadDirectory("repo", "./out");                     // and back out
await box.extend();                                               // push the expiry out while the session continues

for await (const event of box.execStream(["python", "main.py"])) {
  if (event.type === "exit") console.log("exit", event.exitCode);
  else process.stdout.write(event.text);                          // event.type is "stdout" or "stderr"
}

await box.destroy();
```

Errors are typed: `SandboxNotFound` (404), `PoolExhausted` (the server's live sandbox limit, 429), `ExecTimeout` (the command was killed at its deadline; `error.result` holds the output so far) and `AgentboxError` for everything else, with `status` and the server's error `code`. `npm run example` runs `examples/sdk-basic.ts` against a local server and prints the time each step took; `AGENTBOX_URL=http://127.0.0.1:7801 npm run example` points it at another port.

## MCP server for Claude Code and Cursor

`npm run mcp` starts a Model Context Protocol server over stdio with five tools: `run_code` (`language`: python, bash, or javascript with `AGENTBOX_TEMPLATE=node`; `code`; optional `timeoutMs`), `run_command` (`cmd` as an array, optional `cwd` and `timeoutMs`), `write_file` (`path`, `content`), `read_file` (`path`) and `reset_sandbox` (no arguments). It keeps one sandbox per session, created on the first call, kept alive while in use, and destroyed when the client disconnects. Start the agentbox server first, then register the MCP server.

Claude Code:

```bash
claude mcp add agentbox -e AGENTBOX_URL=http://127.0.0.1:7788 -- npx -y agentboxes mcp
```

From a clone, the command is `npx tsx /path/to/agentbox/mcp/server.ts` instead.

Cursor (`.cursor/mcp.json`) or a project `.mcp.json` for Claude Code:

```json
{
  "mcpServers": {
    "agentbox": {
      "command": "npx",
      "args": ["-y", "agentboxes", "mcp"],
      "env": { "AGENTBOX_URL": "http://127.0.0.1:7788" }
    }
  }
}
```

Environment for the MCP server: `AGENTBOX_URL`, `AGENTBOX_API_KEY`, `AGENTBOX_TEMPLATE`, `AGENTBOX_ALLOW_HOSTS` (comma separated, for example `pypi.org,files.pythonhosted.org`) and `AGENTBOX_TTL_SECONDS`.

## Python SDK

`sdk-python/` is the same client for Python 3.9+, standard library only: `pip install agentboxes` (the import stays `agentbox`), or `pip install -e sdk-python` from a clone. Same methods in snake case, line-based `exec_stream`, `upload_directory` and `download_directory` through Python's `tarfile`, and the same typed errors. `npm run test:python` runs its tests against the HTTP app with the fake runtime, no Docker needed.

```python
from agentbox import Agentbox
box = Agentbox("http://127.0.0.1:7788").create(allow_hosts=["pypi.org"])
print(box.exec(["python", "-c", "print(2+2)"]).stdout)
box.destroy()
```
