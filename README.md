# agentbox

Self-hosted sandboxes for AI agents. Runs on any Linux box with Docker and gVisor; no KVM needed.

Status: v0.2 in progress. Everything below works and has a test or a benchmark behind it.

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
npx agentboxes serve     # listens on http://127.0.0.1:7788, pulls python:3.12-slim on first run; Ctrl+C stops it
```

`agentboxes` is one npm package: `agentbox serve` is the server, `agentbox mcp` the MCP server for Claude Code and Cursor, `agentbox template build|list` the template tool, and `import { Agentbox } from "agentboxes"` the TypeScript client with its types. Install it once with `npm install -g agentboxes`, or run it through `npx`. The package is published by the release workflow on each `v*` tag; from a clone, `npm install` then `npm start` runs the same server from source.

The server listens on loopback and needs no auth until you say otherwise. To serve other machines, set a key and the interface; a non-loopback `HOST` without a key is refused at startup. With a key, every route except `/health` needs `Authorization: Bearer <key>`:

```bash
AGENTBOX_API_KEY=$(openssl rand -hex 16) HOST=0.0.0.0 npm start
```

`http://127.0.0.1:7788/` is a status page: live sandboxes against the limit, the warm pool, host load and memory, and every live sandbox with its age, time to expiry, CPU share and memory, refreshed every two seconds from `GET /usage`. With auth on, the page asks for the key once and keeps it in the browser. If you run the server in the background, `npm stop` sends SIGTERM to the server process using the pid file it writes next to its database (`data/agentbox.pid`). Killing only the npm wrapper in front of it leaves the server running.

Or run the server as a container, with gVisor installed on the host as above:

```bash
docker build -t agentbox .
docker run -d --name agentbox --network host -v /var/run/docker.sock:/var/run/docker.sock -v agentbox-data:/data agentbox
curl -s localhost:7788/health
docker stop agentbox      # SIGTERM: the pool is drained, sandboxes keep running for the next start
```

Host networking keeps the server on the host's loopback, so no key is needed; add `-e AGENTBOX_API_KEY=... -e HOST=0.0.0.0` to serve other machines. The Docker socket is how the server starts sandboxes, which makes the container root-equivalent on the host, the same as `npm start` under a user in the `docker` group. `/data` holds the SQLite file and the pid file. Templates are built the same way, with the Dockerfile's directory mounted in: `docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v "$PWD/templates:/templates" agentbox node --import tsx src/cli.ts template build node /templates/node/Dockerfile`. The Firecracker runtime is not available inside the container. The `publish` workflow pushes this image to `ghcr.io/deathslayer89/agentboxes` on every `v*` tag.

More than one key, each with its own limits: `AGENTBOX_API_KEYS="team-a:<key>:5:4096,bot:<key>"` is `name:key[:maxSandboxes[:maxMemoryMb]]`, comma separated, on top of `AGENTBOX_API_KEY` (the key named `default`). A key only sees the sandboxes it created; another key's sandbox answers 404. `maxMemoryMb` caps the sum of `memoryMb` over the key's live sandboxes, and the server-wide `MAX_SANDBOXES` still applies to everyone.

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

Sandbox records live in a SQLite file (`AGENTBOX_DB`, default `data/agentbox.db`). Stopping the server leaves sandboxes running and removes the warm pool's containers; the next start adopts every sandbox whose container is still there, marks the others expired, removes anything left over (a pool container that was still starting shows up as "removed 1 orphaned container(s)"), and keeps using the egress proxy container from the previous run so allowlisted sandboxes keep their network. If Docker itself restarted, or the proxy's source changed since it was built, the proxy is started fresh and sandboxes that had a network are destroyed at startup, with a log line. While the server is down nothing enforces TTLs: sandboxes run until the next start reaps the expired ones. A command whose client disconnects, or whose streaming response is aborted, is killed inside the sandbox; the sandbox itself stays. Sandboxes expire after `ttlSeconds` (default 600, max 3600) unless extended. A reaper removes expired ones and any container labelled `agentbox=1` that the server does not know about.

## Logs

Logs are pretty single lines on a terminal and JSON lines everywhere else (Docker, pm2, a file); `LOG_FORMAT=json` or `pretty` overrides that. Every line names its component (`http`, `service`, `runtime`, `proxy`, `pool`, `server`), and every sandbox event carries the sandbox id: a create with its owner, source and limits, every command with its arguments, exit code and time, files and archives with their sizes, extends, expiries and destroys, orphans and dead pool containers, proxy starts, and one line per HTTP request with its status, time and the key's name. `LOG_LEVEL=debug` adds command starts, container ids and network attachments; `LOG_LEVEL=warn` keeps only problems. Command arguments are logged as given and environment values are not, so keep secrets out of arguments; that is what the proxy's secret injection is for.

```
14:02:11.318 INFO (service): sandbox created sandbox=sbx_9b7c32d3a19e owner=local template=default source=pool ms=0.4 ...
14:02:11.402 INFO (service): exec done sandbox=sbx_9b7c32d3a19e cmd="python -c print(2+2)" cwd=/workspace exitCode=0 ms=81 ...
14:02:11.403 INFO (http): request method=POST path=/sandboxes/sbx_9b7c32d3a19e/exec status=200 ms=83
```

## Warm pool

The server keeps default-sized containers started ahead of time, one pool per template, sized by `POOL_SIZES` (default `default:3`). A create request whose memory, cpus, disk and pids match the defaults takes one from its template's pool; `startup.source` says `pool` and `startup.ms` is the server-side time to ready. Any other size, or a template without a pool, starts a fresh container (`cold`), which takes Docker plus gVisor start time. Each pooled container is used once and destroyed with its sandbox; the pool refills all its missing containers at once, so a burst of creates costs one start's time. Pool containers do not count towards `MAX_SANDBOXES`. `GET /stats` shows size, ready, starting, hits and misses per pool, and `GET /metrics` exposes the same plus creates by source, removals by reason and an exec latency histogram in the Prometheus text format.

## Network: off by default, an allowlist per sandbox

A sandbox has no network unless the request names hosts it may reach:

```bash
curl -s -X POST localhost:7788/sandboxes -d '{"allowHosts":["pypi.org","files.pythonhosted.org"]}'
curl -s -X POST localhost:7788/sandboxes/sbx_.../exec -d '{"cmd":["pip","download","--no-deps","-d","/tmp/dl","six"],"timeoutMs":120000}'
curl -s localhost:7788/sandboxes/sbx_.../egress-log
# {"allowHosts":["pypi.org","files.pythonhosted.org"],"denied":[{"at":"...","method":"CONNECT","host":"example.com","port":443,"reason":"host not in allowHosts"}]}
```

How it works: such a sandbox gets its own internal Docker network with an isolated gateway (Docker 28+), so the only thing it can reach is the egress proxy container, not the internet and not the host. Inside, `HTTP_PROXY` and `HTTPS_PROXY` point at the proxy with a token that identifies the sandbox. The proxy lets allowlisted hosts through and refuses everything else with a 403, recording each refusal in the egress log. Hosts that resolve to loopback, link-local (the cloud metadata address `169.254.169.254`), private or multicast addresses are refused even when allowlisted. `*.example.com` in the allowlist matches subdomains. A bare host allows ports 80 and 443; `db.example.com:5432` allows one other port. The proxy's control API listens only on Docker's default bridge, which sandbox networks cannot reach, and each sandbox's proxy token is bound to its own network's subnet, so a token that leaks (into a log, say) is refused from anywhere else and the refusal shows up in the egress log.

pip, curl, git, npm, and Python's `urllib` and `requests` honour the proxy variables; `NO_PROXY` keeps the sandbox's own loopback off the proxy, so a dev server or a test server inside keeps working. Node's built-in `fetch` only does so with `NODE_USE_ENV_PROXY=1`, which the node template sets (verified on Node 22; undici prints an "experimental" warning). Installing packages at run time this way is the slow path; use a template for anything you need more than once.

A sandbox with a network always starts cold, since pooled containers have no network. The proxy container (`agentbox-egress-proxy`) is built from `proxy/` on the first start and runs under runc, not gVisor, because gVisor does not pick up networks connected after start; it runs as a non-root user with all capabilities dropped, a read-only root and a 256 MB limit.

## Secrets that never enter the sandbox

```bash
OPENAI_API_KEY=sk-... npm start
curl -s -X POST localhost:7788/sandboxes -d '{"secrets":{"api.openai.com":"OPENAI_API_KEY"}}'
curl -s -X POST localhost:7788/sandboxes -d '{"secrets":{"api.anthropic.com":{"env":"ANTHROPIC_API_KEY","header":"x-api-key"}}}'
```

The value of `OPENAI_API_KEY` is read from the server's environment and given only to the proxy. The host is allowlisted automatically. For that host the proxy terminates TLS with a certificate from its own CA, sets `Authorization: Bearer <value>` in place of whatever the sandbox sent, and opens its own TLS connection upstream. The object form names another header and an optional `prefix` for the value (none by default), which is what Anthropic's `x-api-key` needs. The CA is written into the sandbox at `/tmp/agentbox` and named by `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO`, `PIP_CERT` and `NODE_EXTRA_CA_CERTS`, alongside the image's normal bundle. Hosts without a secret are plain tunnels the proxy cannot read. The integration test for this fetches `https://httpbin.org/headers` from inside a sandbox, sees the secret in the echoed headers, and greps the sandbox's environment and filesystem to confirm the value is not there.

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

## Coding agent example

`examples/coding-agent/agent.ts` is a complete coding agent in one file, on the Anthropic SDK's tool runner: it copies a repository into a sandbox, gives Claude four tools (`run_command`, `read_file`, `write_file`, `edit_file`), lets it work until it is done, and downloads the result next to your repository with a diff. Own package so the Anthropic SDK stays out of the main install:

```bash
cd examples/coding-agent && npm install
ANTHROPIC_API_KEY=... AGENTBOX_TEMPLATE=node AGENTBOX_ALLOW_HOSTS=registry.npmjs.org npm start -- ../../some-repo "Fix the failing test in src/parser.test.ts"
```

The model is Claude Opus 5.5 with a server-side refusal fallback. The sandbox is destroyed when the run ends; the output tree is left at `<repo>.agent-out`. To turn this into a Slack bot or an issue-to-PR worker, keep `makeTools` and `runTask` and change where the task comes from and where the result goes.

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

`templates/node/Dockerfile` is a ready-made template with Node 22, npm and git for TypeScript work: `npm run agentbox -- template build node templates/node/Dockerfile`, then `create({ template: "node" })`. An `npm ci` inside it needs `allowHosts: ["registry.npmjs.org", "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"]`, the GitHub ones for the prebuilt binaries of native modules; the egress log names any host still missing.

Sandboxes still run as user 65534 with a read-only root, so anything the Dockerfile installs must be world-readable, which `pip install` as root already is. To keep a template instant, give it a pool: `POOL_SIZES=default:3,data-science:2`. The server refuses to start if `POOL_SIZES` names a template that has not been built.

Installing packages at run time needs the network allowlist above, for example `allowHosts: ["pypi.org", "files.pythonhosted.org"]`; it is the slow path.

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

### Firecracker runtime (optional, KVM hosts)

On a host with `/dev/kvm`, agentbox can run each sandbox as a Firecracker microVM instead of a gVisor container: a real guest kernel per sandbox, so a kernel bug inside a sandbox stays inside that VM. Same API, SDKs and MCP server; a second `SandboxRuntime` implementation. Setup needs no sudo and takes about a minute:

```bash
./firecracker/setup.sh           # downloads Firecracker and a prebuilt guest kernel, builds a rootfs image from python:3.12-slim
AGENTBOX_RUNTIME=firecracker npm start
```

The first start boots one VM to the guest agent's ready state and snapshots it (about 2 s). Every default-sized sandbox after that is restored from the snapshot in about 32 ms and seeded with fresh entropy; a custom size boots cold in about 620 ms. `/workspace` is a tmpfs inside the VM and the root filesystem is read-only, so VMs share one image. Commands and files travel over the VM's serial console, which is fine for commands and small files and slow for large transfers. Not supported on this runtime yet: templates, the network allowlist and secrets, live streaming of output (it arrives when the command ends), and adopting VMs after a server restart. The Firecracker jailer is not used. `npm run test:firecracker` runs its tests.

Measured on this machine through the HTTP API, median unless noted:

| | gVisor (`runsc-kvm`) | Firecracker |
|---|---|---|
| create from warm pool, p50 / p95 | 1.0 / 1.6 ms | 1.1 / 12.3 ms |
| create cold | 150 ms | 644 ms (kernel boot) |
| create from snapshot, no pool | not applicable | 32 ms |
| exec `print(2+2)` | 29 ms | 13 ms (one serial round trip instead of three Docker API calls) |
| idle sandbox host memory | 16 MB | 79 MB |

### gVisor's KVM platform

By default runsc uses the systrap platform, which works everywhere. On a machine with `/dev/kvm`, the KVM platform runs gVisor's kernel as a guest and cuts syscall overhead. Register it as a second runtime (needs sudo); agentbox uses it automatically when it is there:

```bash
sudo python3 - <<'PY'
import json; p="/etc/docker/daemon.json"; d=json.load(open(p))
d.setdefault("runtimes", {})["runsc-kvm"]={"path":"/usr/bin/runsc","runtimeArgs":["--platform=kvm"]}
json.dump(d, open(p,"w"), indent=4)
PY
sudo systemctl restart docker
docker run --rm --runtime=runsc-kvm alpine uname -a
npm start        # logs "runtime runsc-kvm"
```

Measured on this machine, one process writing and reading 3000 small files: 228 ms on systrap, 133 ms on KVM, 66 ms on runc. `npm install express`: 1945 ms, 1238 ms, 1110 ms. Python startup is unchanged at about 14 ms, and a cold sandbox start is about 20 ms slower on KVM (150 ms against 130 ms) because each sandbox sets up a small VM. `AGENTBOX_RUNTIME` accepts `auto` (the default), `runsc`, or a `runsc-` variant; there is no way to run on plain runc.

## Benchmarks

`npm run bench` measures through the HTTP API against a running server started with `POOL_SIZES=default:5`. Numbers from this machine on 2026-11-01:

Machine: 12th Gen Intel Core i7-12700H, 20 threads, 15 GB RAM, Linux 7.0.0, Docker 29.1.3, runsc release-20261026.0

| Measurement (HTTP round trip) | n | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|
| create from warm pool | 30 | 1.1 | 2.2 | 4.3 |
| create cold (no pool) | 10 | 129.9 | 154.2 | 154.2 |
| exec `print(2+2)` | 30 | 30.8 | 36.3 | 38.0 |

Five creates fired at the same time against a pool of five took 57 to 73 ms each, and a sixth create during the refill started cold at 141 ms. An idle sandbox holds about 16 MB of host memory with gVisor's sentry included, so about 63 idle sandboxes fit in 1 GB of RAM. A sandbox with a network allowlist starts cold in about 300 ms, since it also gets its own Docker network and the proxy joins it; with secrets, installing the CA adds another 300 ms.

The roadmap's kill criterion is gVisor being about 3x slower than runc on common tasks. Measured here on the systrap platform: Python startup 14 ms under gVisor against 11 ms under runc, `pip install requests` 2.0 s against 1.9 s, and `npm install express` (65 packages, node template) 1.8 s against 1.3 s. Syscall-heavy microbenchmarks (thousands of tiny files, process spawn loops) show 3 to 4x on systrap and about 2x on the KVM platform, which brings `npm install` to within 12% of runc.

Why `/workspace` is a tmpfs and not a disk volume: one Python process writing and reading 3000 small files took 214 ms on tmpfs under gVisor and 353 ms on a Docker volume under gVisor (85 ms and 62 ms under plain runc). Files in RAM are the faster choice under gVisor, and the size limit is real; the cost is that `diskMb` is memory.

## What this is not

- Not multi-node: one server per Docker host. Records are in SQLite and a server restart adopts running sandboxes, but a Docker restart loses the egress proxy's state.
- Not KVM-level isolation by default: gVisor is a user-space kernel that handles most syscalls itself, but the host kernel still serves the ones it forwards, and the sentry runs as a host process. The Firecracker runtime gives each sandbox its own kernel, at the cost of the features it does not support yet.
- Not multi-tenant beyond API keys: keys partition sandboxes and carry limits, but they share one proxy, one pool and one Docker host.
- Not disk-backed: `/workspace` is a tmpfs, so a large `node_modules` or repository is held in RAM, up to `diskMb`. Writing past `diskMb` fails with "no space left", not an OOM kill.
- Not a preview host: nothing inside a sandbox is reachable from outside, and nothing is persisted after the TTL.

## Tests

```bash
npm test                  # unit tests under test/unit, no Docker needed
npm run test:integration  # test/integration: needs Docker, runsc and internet; checks each isolation default from inside a sandbox
npm run test:firecracker  # needs ./firecracker/setup.sh and /dev/kvm; skipped otherwise
npm run test:python       # the Python client against the fake server
npm run build             # compiles dist/ for the package; npm pack runs it on its own
```

`.github/workflows/ci.yml` runs the unit suite on Node 20 and 22, the Python tests, the integration suite on a runner with gVisor installed, and the image build. Tests live in `test/unit/<area>/` mirroring `src/`, plus `test/unit/proxy` and `test/unit/sdk`, and in `test/integration/`. Do not run the integration tests while a server is running on the same Docker: both own the proxy container and the reaper would remove each other's containers. Like the server, the suite leaves the `agentbox-egress-proxy` container running for the next start to reuse.

## Layout

```
src/models/        sandbox and template records, request/response types
src/repositories/  where records live: sandboxes and settings in SQLite, templates as labelled Docker images
src/runtime/       SandboxRuntime interface, the gVisor-on-Docker implementation and the Firecracker one
src/services/      SandboxService (create, exec, files, destroy, reap) and the warm pools
src/http/          routes, auth, request parsing and the status page
src/cli.ts         `agentbox template build | list`
bin/agentbox.js    the package's command: serve, mcp, template
scripts/build.mjs  compiles dist/ and copies the proxy source and the status page into it
proxy/             the egress proxy (plain Node, no dependencies) and its Dockerfile
firecracker/       setup script and the guest agent for the Firecracker runtime
sdk/               the TypeScript client
sdk-python/        the Python client
mcp/               the MCP server, built on the client
examples/          the SDK walkthrough, the coding agent and the Mastra agent
test/              unit tests by area, and integration tests against real gVisor
Dockerfile         the server image: Node, the server source and the proxy source
.github/workflows/ CI (unit, Python, integration with gVisor, image build) and the GHCR publish on tags
```
