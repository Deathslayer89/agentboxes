# agentbox

Self-hosted sandboxes for AI agents. Runs on any Linux box with Docker and gVisor; no KVM needed.

Status: v0.1. Everything below works and has a test or a benchmark behind it.

## Requirements

- Linux, Docker 20+ (28+ for the network allowlist), Node 20+
- gVisor registered with Docker as the `runsc` runtime. The server refuses to start without it.

Install gVisor on Ubuntu or Debian:

```bash
sudo apt-get update && sudo apt-get install -y apt-transport-https ca-certificates curl gnupg
curl -fsSL https://gvisor.dev/archive.key | sudo gpg --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg
echo "deb [arch=amd64 signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" | sudo tee /etc/apt/sources.list.d/gvisor.list > /dev/null
sudo apt-get update && sudo apt-get install -y runsc
sudo runsc install
sudo systemctl restart docker
docker run --rm --runtime=runsc alpine uname -a   # kernel line ends in -gvisor: that is gVisor
```

## Run

```bash
npm install
npm start          # listens on http://127.0.0.1:7788, pulls python:3.12-slim on first run
```

Without `AGENTBOX_API_KEY` the server only listens on loopback and needs no auth. Set it to listen on all interfaces (`HOST` to change that) and require `Authorization: Bearer <key>` on every route except `/health`:

```bash
AGENTBOX_API_KEY=$(openssl rand -hex 16) npm start
```

```bash
# create a sandbox (all fields optional: template, memoryMb, cpus, diskMb, pids, ttlSeconds)
curl -s -X POST localhost:7788/sandboxes -d '{}'
# {"id":"sbx_...","status":"ready","limits":{...},"startup":{"source":"pool","ms":0.3},"createdAt":"...","expiresAt":"..."}

# run a command
curl -s -X POST localhost:7788/sandboxes/sbx_.../exec -d '{"cmd":["python","-c","print(2+2)"],"timeoutMs":5000}'
# {"exitCode":0,"stdout":"4\n","stderr":"","durationMs":...,"timedOut":false,"truncated":false}

# same body, but stdout and stderr arrive as Server-Sent Events while the command runs, then an exit event
curl -s -N -X POST localhost:7788/sandboxes/sbx_.../exec/stream -d '{"cmd":["python","-c","import time\nfor i in range(3): print(i); time.sleep(1)"]}'
# event: stdout        data: "0\n"
# event: stdout        data: "1\n"
# event: stdout        data: "2\n"
# event: exit          data: {"exitCode":0,"durationMs":3045,"timedOut":false,"truncated":false}

# files live under /workspace; relative paths start there, ".." that leaves it is a 400
curl -s -X PUT --data-binary @main.py "localhost:7788/sandboxes/sbx_.../files?path=main.py"
curl -s "localhost:7788/sandboxes/sbx_.../files?path=main.py"

# list, get, destroy
curl -s localhost:7788/sandboxes
curl -s localhost:7788/sandboxes/sbx_...
curl -s -X DELETE localhost:7788/sandboxes/sbx_...
```

Sandboxes expire after `ttlSeconds` (default 600, max 3600). A reaper removes expired ones and any container labelled `agentbox=1` that the server does not know about.

## Warm pool

The server keeps default-sized containers started ahead of time, one pool per template, sized by `POOL_SIZES` (default `default:3`). A create request whose memory, cpus, disk and pids match the defaults takes one from its template's pool; `startup.source` says `pool` and `startup.ms` is the server-side time to ready. Any other size, or a template without a pool, starts a fresh container (`cold`), which takes Docker plus gVisor start time. Each pooled container is used once and destroyed with its sandbox; a background loop refills the pool. Pool containers do not count towards `MAX_SANDBOXES`. `GET /stats` shows size, ready, starting, hits and misses per pool.

## Network: off by default, an allowlist per sandbox

A sandbox has no network unless the request names hosts it may reach:

```bash
curl -s -X POST localhost:7788/sandboxes -d '{"allowHosts":["pypi.org","files.pythonhosted.org"]}'
curl -s -X POST localhost:7788/sandboxes/sbx_.../exec -d '{"cmd":["pip","download","--no-deps","-d","/tmp/dl","six"],"timeoutMs":120000}'
curl -s localhost:7788/sandboxes/sbx_.../egress-log
# {"allowHosts":["pypi.org","files.pythonhosted.org"],"denied":[{"at":"...","method":"CONNECT","host":"example.com","port":443,"reason":"host not in allowHosts"}]}
```

How it works: such a sandbox gets its own internal Docker network with an isolated gateway (Docker 28+), so the only thing it can reach is the egress proxy container, not the internet and not the host. Inside, `HTTP_PROXY` and `HTTPS_PROXY` point at the proxy with a token that identifies the sandbox. The proxy lets allowlisted hosts through and refuses everything else with a 403, recording each refusal in the egress log. Hosts that resolve to loopback, link-local (the cloud metadata address `169.254.169.254`), private or multicast addresses are refused even when allowlisted. `*.example.com` in the allowlist matches subdomains.

pip, curl, git, npm, and Python's `urllib` and `requests` honour the proxy variables. Node's built-in `fetch` does not; use `NODE_USE_ENV_PROXY=1` on Node 24+ or undici's `EnvHttpProxyAgent`. Installing packages at run time this way is the slow path; use a template for anything you need more than once.

A sandbox with a network always starts cold, since pooled containers have no network. The proxy container (`agentbox-egress-proxy`) is built from `proxy/` on the first start and runs under runc, not gVisor, because gVisor does not pick up networks connected after start; it runs as a non-root user with all capabilities dropped, a read-only root and a 256 MB limit.

## Secrets that never enter the sandbox

```bash
OPENAI_API_KEY=sk-... npm start
curl -s -X POST localhost:7788/sandboxes -d '{"secrets":{"api.openai.com":"OPENAI_API_KEY"}}'
```

The value of `OPENAI_API_KEY` is read from the server's environment and given only to the proxy. The host is allowlisted automatically. For that host the proxy terminates TLS with a certificate from its own CA, replaces whatever `Authorization` header the sandbox sent with `Bearer <value>`, and opens its own TLS connection upstream. The CA is written into the sandbox at `/tmp/agentbox` and named by `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO`, `PIP_CERT` and `NODE_EXTRA_CA_CERTS`, alongside the image's normal bundle. Hosts without a secret are plain tunnels the proxy cannot read. The integration test for this fetches `https://httpbin.org/headers` from inside a sandbox, sees the secret in the echoed headers, and greps the sandbox's environment and filesystem to confirm the value is not there.

## TypeScript SDK

The client in `sdk/` has no dependencies and needs Node 20+. It is not on npm yet; until then import it from the repo or build it with `npm run build:sdk`.

```ts
import { Agentbox, ExecTimeout } from "agentbox";

const agentbox = new Agentbox({ baseUrl: "http://127.0.0.1:7788", apiKey: process.env.AGENTBOX_API_KEY });
const box = await agentbox.create({ template: "default", ttlSeconds: 300, allowHosts: ["pypi.org"] });

const r = await box.exec(["python", "-c", "print(2+2)"]);        // { exitCode, stdout, stderr, durationMs, truncated }
await box.writeFile("main.py", "print('hello')");
const code = await box.readFile("main.py");

for await (const event of box.execStream(["python", "main.py"])) {
  if (event.type === "exit") console.log("exit", event.exitCode);
  else process.stdout.write(event.text);                          // event.type is "stdout" or "stderr"
}

await box.destroy();
```

Errors are typed: `SandboxNotFound` (404), `PoolExhausted` (the server's live sandbox limit, 429), `ExecTimeout` (the command was killed at its deadline; `error.result` holds the output so far) and `AgentboxError` for everything else, with `status` and the server's error `code`. `npm run example` runs `examples/sdk-basic.ts` against a local server and prints the time each step took.

## MCP server for Claude Code and Cursor

`npm run mcp` starts a Model Context Protocol server over stdio with five tools: `run_code` (python, bash or javascript), `run_command`, `write_file`, `read_file` and `reset_sandbox`. It keeps one sandbox per session, created on the first call and replaced after it expires. Start the agentbox server first, then register the MCP server.

Claude Code:

```bash
claude mcp add agentbox -e AGENTBOX_URL=http://127.0.0.1:7788 -- npx tsx /path/to/agentbox/mcp/server.ts
```

Cursor (`.cursor/mcp.json`) or a project `.mcp.json` for Claude Code:

```json
{
  "mcpServers": {
    "agentbox": {
      "command": "npx",
      "args": ["tsx", "/path/to/agentbox/mcp/server.ts"],
      "env": { "AGENTBOX_URL": "http://127.0.0.1:7788" }
    }
  }
}
```

Environment for the MCP server: `AGENTBOX_URL`, `AGENTBOX_API_KEY`, `AGENTBOX_TEMPLATE`, `AGENTBOX_ALLOW_HOSTS` (comma separated, for example `pypi.org,files.pythonhosted.org`) and `AGENTBOX_TTL_SECONDS`.

## Mastra example

`examples/mastra/agent.ts` is a Mastra agent with one tool, `run_python`, that writes the model's code into a sandbox and runs it. The sandbox is created on the first call and reused, so files persist between tool calls. It has its own `package.json` so Mastra does not land in the main install:

```bash
cd examples/mastra && npm install
ANTHROPIC_API_KEY=... npm start "Compute the first ten prime numbers and print them."
AGENTBOX_ALLOW_HOSTS=pypi.org,files.pythonhosted.org npm start "Use numpy to invert a 3x3 matrix"   # lets the agent pip install
```

## Templates

A template is a Docker image with packages already installed, so a sandbox starts with them and never downloads at run time. Write a Dockerfile that starts `FROM python:3.12-slim` (the base image), install as root, and build it:

```Dockerfile
FROM python:3.12-slim
RUN pip install --no-cache-dir pandas numpy requests
```

```bash
npm run agentbox -- template build data-science ./Dockerfile   # tags agentbox/data-science and labels it
npm run agentbox -- template list
curl -s localhost:7788/templates
curl -s -X POST localhost:7788/sandboxes -d '{"template":"data-science"}'
```

Sandboxes still run as user 65534 with a read-only root, so anything the Dockerfile installs must be world-readable, which `pip install` as root already is. To keep a template instant, give it a pool: `POOL_SIZES=default:3,data-science:2`. The server refuses to start if `POOL_SIZES` names a template that has not been built.

Installing packages at run time (`pip install` inside a sandbox) fails today because the sandbox has no network. The Day 3 egress allowlist will allow it per sandbox for `pypi.org` and `files.pythonhosted.org`, as the slow path.

## What every sandbox gets

| | Default | Env var |
|---|---|---|
| Runtime | gVisor (`runsc`), not configurable | |
| Network | none, or an allowlist through the egress proxy | |
| Memory | 512 MB for processes, no swap | `DEFAULT_MEMORY_MB`, `MAX_MEMORY_MB` |
| CPUs | 1 | `DEFAULT_CPUS`, `MAX_CPUS` |
| `/workspace` tmpfs | 1024 MB, memory-backed; the sandbox's hard memory cap is memory plus disk | `DEFAULT_DISK_MB`, `MAX_DISK_MB` |
| Pids | 256 | `DEFAULT_PIDS`, `MAX_PIDS` |
| TTL | 600 s | `DEFAULT_TTL_SECONDS`, `MAX_TTL_SECONDS` |
| Exec timeout | 30 s | `DEFAULT_EXEC_TIMEOUT_MS`, `MAX_EXEC_TIMEOUT_MS` |
| Root filesystem | read-only | |
| User | `nobody` (65534), `--cap-drop=ALL`, `no-new-privileges` | |
| Host mounts, docker socket, host env | none | |

Other settings: `PORT` (7788), `HOST`, `AGENTBOX_API_KEY`, `AGENTBOX_IMAGE` (`python:3.12-slim`), `MAX_SANDBOXES` (20), `MAX_OUTPUT_BYTES` per stream per exec (1 MiB, output past it is dropped and `truncated` is true), `MAX_FILE_BYTES` (8 MiB), `POOL_SIZES` (`default:3`), `REAPER_INTERVAL_MS` (10000).

## Benchmarks

`npm run bench` measures through the HTTP API against a running server started with `POOL_SIZES=default:5`. Numbers from this machine on 2026-11-01:

Machine: 12th Gen Intel Core i7-12700H, 20 threads, 15 GB RAM, Linux 7.0.0, Docker 29.1.3, runsc release-20261026.0

| Measurement (HTTP round trip) | n | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|
| create from warm pool | 20 | 2.3 | 4.9 | 12.4 |
| create cold (no pool) | 10 | 209.5 | 240.3 | 240.3 |
| exec `print(2+2)` | 30 | 84.3 | 101.0 | 109.7 |

An idle sandbox holds about 16 MB of host memory with gVisor's sentry included, so about 62 idle sandboxes fit in 1 GB of RAM. A sandbox with a network allowlist starts cold in about 600 ms, since it also gets its own Docker network, the proxy joins it, and the CA is installed.

## What this is not

- Not multi-node: one server, one Docker host, state in memory. A restart forgets sandboxes and removes their containers.
- Not KVM-level isolation: gVisor is a user-space kernel that handles most syscalls itself, but the host kernel still serves the ones it forwards, and the sentry runs as a host process.
- Not multi-tenant: one API key for everyone who can reach the server. Per-key limits are planned for v0.2.
- Not disk-backed: `/workspace` is a tmpfs, so a large `node_modules` or repository is held in RAM, up to `diskMb`. Writing past `diskMb` fails with "no space left", not an OOM kill.
- Not a preview host: nothing inside a sandbox is reachable from outside, and nothing is persisted after the TTL.

## Tests

```bash
npm test                  # unit tests under test/unit, no Docker needed
npm run test:integration  # test/integration: needs Docker, runsc and internet; checks each isolation default from inside a sandbox
```

Tests live in `test/unit/<area>/` mirroring `src/`, plus `test/unit/proxy` and `test/unit/sdk`, and in `test/integration/`. Do not run the integration tests while a server is running on the same Docker: both own the proxy container and the reaper would remove each other's containers.

## Layout

```
src/models/        sandbox and template records, request/response types
src/repositories/  where records live: sandboxes in memory for v0.1, templates as labelled Docker images
src/runtime/       SandboxRuntime interface and the gVisor-on-Docker implementation
src/services/      SandboxService (create, exec, files, destroy, reap) and the warm pools
src/http/          routes, auth and request parsing
src/cli.ts         `agentbox template build | list`
proxy/             the egress proxy (plain Node, no dependencies) and its Dockerfile
sdk/               the TypeScript client
mcp/               the MCP server, built on the client
examples/          the SDK walkthrough and the Mastra agent
test/              unit tests by area, and integration tests against real gVisor
```
