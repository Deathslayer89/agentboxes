# agentbox

Self-hosted sandboxes for AI agents. Runs on any Linux box with Docker and gVisor; no KVM needed.

Status: 0.2.0 is the first published release. Everything in this file has a test or a benchmark behind it; the numbers name the machine they were measured on.

- A sandbox from the warm pool in about 1 ms, cold in about 130 ms, a command round trip in about 30 ms, 16 MB of host memory per idle sandbox.
- No network unless you list the hosts; secrets go in through a proxy and are never inside the sandbox.
- gVisor on every sandbox, read-only root, no capabilities, no host mounts, a memory and CPU cap, a TTL.
- One npm package: the server, an MCP server for Claude Code and Cursor, and a TypeScript client. A Python client on PyPI.

![A Python session creates a sandbox, runs code in it and destroys it, with the server's log below](docs/demo.gif)

## Install

Linux with Docker 20+ (28+ for the network allowlist) and Node 20+. The first command installs gVisor if it is missing and registers it with Docker as `runsc` (and as `runsc-kvm` on a host with `/dev/kvm`), printing each `sudo` step before it runs it, then starts one container under it with the server's default image to prove it works. `--check` only reports. The server refuses to start on anything but gVisor.

```bash
npx agentboxes setup     # Debian and Ubuntu get gVisor's apt repository, other distributions the release tarball
npx agentboxes serve     # http://127.0.0.1:7788; Ctrl+C stops it
```

`npm install -g agentboxes` gives you the `agentbox` command for good: `agentbox setup`, `agentbox serve`, `agentbox mcp`, `agentbox template build|list`. The server listens on loopback with no auth; to serve other machines set `AGENTBOX_API_KEY` and `HOST=0.0.0.0`. `http://127.0.0.1:7788/` is a status page with the live sandboxes, their CPU and memory, the pool and the host. Installing gVisor by hand, a Docker image and everything about keys, logs and restarts: [docs/operations.md](docs/operations.md).

## First sandbox

```bash
curl -s -X POST localhost:7788/sandboxes -d '{}'
# {"id":"sbx_...","status":"ready","startup":{"source":"pool","ms":0.3},...}
curl -s -X POST localhost:7788/sandboxes/sbx_.../exec -d '{"cmd":["python","-c","print(2+2)"]}'
# {"exitCode":0,"stdout":"4\n","stderr":"","durationMs":31,"timedOut":false,"truncated":false}
curl -s -X DELETE localhost:7788/sandboxes/sbx_...
```

Files, tar archives of whole trees, streaming output, extend, list: [docs/api.md](docs/api.md).

## From Claude Code or Cursor

```bash
claude mcp add agentbox -e AGENTBOX_URL=http://127.0.0.1:7788 -- npx -y agentboxes mcp
```

Five tools: `run_code`, `run_command`, `write_file`, `read_file`, `reset_sandbox`. One sandbox per session, created on the first call, kept alive while in use, destroyed when the client disconnects. The Cursor config and the environment variables (template, allowed hosts, TTL) are in [docs/api.md](docs/api.md).

## From code

```ts
import { Agentbox } from "agentboxes";

const box = await new Agentbox({ baseUrl: "http://127.0.0.1:7788" }).create({ allowHosts: ["pypi.org"] });
await box.uploadDirectory("./myrepo", "repo");
const r = await box.exec(["python", "-m", "pytest"], { cwd: "repo", timeoutMs: 300_000 });
console.log(r.exitCode, r.stdout);
await box.destroy();
```

```python
from agentbox import Agentbox            # pip install agentboxes
box = Agentbox("http://127.0.0.1:7788").create(allow_hosts=["pypi.org"])
print(box.exec(["python", "-c", "print(2+2)"]).stdout)
box.destroy()
```

Both clients have no dependencies. Typed errors, streaming and the full method list: [docs/api.md](docs/api.md).

## From an agent framework

The same tool in three frameworks, each a complete example in one file: [Claude Agent SDK](examples/claude-agent-sdk/agent.py), [OpenAI Agents SDK](examples/openai-agents/agent.py) and [LangGraph](examples/langgraph/agent.py), plus [Mastra](examples/mastra/agent.ts) in TypeScript. The sandbox is these ten lines and the framework adds one:

```python
from agentbox import Agentbox, ExecTimeout
box = Agentbox("http://127.0.0.1:7788").create()

def run_python(code: str) -> str:
    """Runs Python code in an isolated sandbox and returns its stdout and stderr."""
    box.write_file("main.py", code)
    try:
        result = box.exec(["python", "main.py"], timeout_ms=60_000)
    except ExecTimeout as killed:
        result = killed.result
    return result.stdout + result.stderr

agent = create_agent(model="anthropic:claude-opus-5-5", tools=[run_python])   # LangGraph
agent = Agent(name="coder", tools=[function_tool(run_python)])                  # OpenAI Agents SDK
```

```bash
pip install -r examples/langgraph/requirements.txt
ANTHROPIC_API_KEY=... python examples/langgraph/agent.py "Compute the first ten prime numbers and print them."
```

`npm run test:examples` loads all three against a running server and calls the tool; the model's turn needs your key. A complete coding agent on the Anthropic SDK that works on a whole repository: [docs/examples.md](docs/examples.md).

## What every sandbox gets

| | Default | Env var |
|---|---|---|
| Runtime | gVisor: `runsc-kvm` when registered, else `runsc` | `AGENTBOX_RUNTIME` (`auto`) |
| Network | none, or an allowlist through the egress proxy | |
| Memory | 512 MB for processes, no swap | `DEFAULT_MEMORY_MB`, `MAX_MEMORY_MB` |
| CPUs | 1 | `DEFAULT_CPUS`, `MAX_CPUS` |
| `/workspace` tmpfs | 1024 MB, memory-backed; the sandbox's hard memory cap is memory plus disk | `DEFAULT_DISK_MB`, `MAX_DISK_MB` |
| Pids | 256 | `DEFAULT_PIDS`, `MAX_PIDS` |
| TTL | 600 s | `DEFAULT_TTL_SECONDS`, `MAX_TTL_SECONDS` |
| Exec timeout | 30 s, at most 30 min per command | `DEFAULT_EXEC_TIMEOUT_MS`, `MAX_EXEC_TIMEOUT_MS` |
| Root filesystem | read-only | |
| User | `nobody` (65534), `--cap-drop=ALL`, `no-new-privileges` | |
| Host mounts, docker socket, host env | none | |

Other settings: `PORT` (7788), `HOST`, `AGENTBOX_API_KEY`, `AGENTBOX_IMAGE` (`python:3.12-slim`), `MAX_SANDBOXES` (20), `MAX_OUTPUT_BYTES` per stream per exec (1 MiB, output past it is dropped and `truncated` is true), `MAX_FILE_BYTES` (8 MiB), `MAX_ARCHIVE_BYTES` (256 MiB), `POOL_SIZES` (`default:3`), `REAPER_INTERVAL_MS` (10000).

## Network and secrets

A sandbox has no network at all unless the request lists hosts:

```bash
curl -s -X POST localhost:7788/sandboxes -d '{"allowHosts":["pypi.org","files.pythonhosted.org"]}'
curl -s -X POST localhost:7788/sandboxes -d '{"secrets":{"api.openai.com":"OPENAI_API_KEY"}}'
```

The first gets its own network whose only neighbour is an egress proxy; the proxy allows the listed hosts on ports 80 and 443 (`host:port` for one other port), refuses everything else and logs each refusal to `GET /sandboxes/:id/egress-log`, and never lets a name resolve to the host, the cloud metadata address or any private range. The second reads `OPENAI_API_KEY` from the server's environment, gives it only to the proxy, and the proxy sets the header on the way out; a test greps the sandbox's environment and filesystem for the value and finds nothing. The whole design, `x-api-key` style headers, and what tools honour the proxy: [docs/network.md](docs/network.md).

## Templates

A template is a Docker image with packages preinstalled, labelled so the server lists it:

```bash
agentbox template build data-science ./Dockerfile    # FROM python:3.12-slim, RUN pip install pandas numpy
curl -s -X POST localhost:7788/sandboxes -d '{"template":"data-science"}'
```

`templates/node/Dockerfile` ships a Node 22 template. Pools per template, what an `npm ci` needs, and the rules: [docs/templates.md](docs/templates.md).

## Numbers

Through the HTTP API on an i7-12700H with Docker 29 and runsc release-20261026.0:

| | p50 | p95 |
|---|---|---|
| create from the warm pool | 1.1 ms | 2.2 ms |
| create cold | 130 ms | 154 ms |
| exec `print(2+2)` | 31 ms | 36 ms |

An idle sandbox holds about 16 MB of host memory. gVisor against runc on common tasks: Python startup 1.3x, `pip install` 1.1x, `npm install` 1.35x on the default platform and 1.12x on KVM. `npm run bench` reproduces the table; the method and the KVM and Firecracker figures are in [docs/benchmarks.md](docs/benchmarks.md) and [docs/runtimes.md](docs/runtimes.md).

## What this is not

- Not multi-node: one server per Docker host. Records are in SQLite and a server restart adopts running sandboxes, but a Docker restart loses the egress proxy's state.
- Not KVM-level isolation by default: gVisor is a user-space kernel that handles most syscalls itself, but the host kernel still serves the ones it forwards, and the sentry runs as a host process. The Firecracker runtime gives each sandbox its own kernel, at the cost of the features it does not support yet.
- Not multi-tenant beyond API keys: keys partition sandboxes and carry limits, but they share one proxy, one pool and one Docker host.
- Not disk-backed: `/workspace` is a tmpfs, so a large `node_modules` or repository is held in RAM, up to `diskMb`. Writing past `diskMb` fails with "no space left", not an OOM kill.
- Not a preview host: nothing inside a sandbox is reachable from outside, and nothing is persisted after the TTL.

## More

- [docs/api.md](docs/api.md): every endpoint, both clients, the MCP server
- [docs/operations.md](docs/operations.md): keys and limits per key, the status page, logs, the Docker image, what survives a restart
- [docs/network.md](docs/network.md): the allowlist and secret injection in full
- [docs/templates.md](docs/templates.md), [docs/runtimes.md](docs/runtimes.md), [docs/benchmarks.md](docs/benchmarks.md), [docs/examples.md](docs/examples.md)
- [docs/development.md](docs/development.md): tests, layout, running from a clone

MIT licensed.
