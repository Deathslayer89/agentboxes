# agentbox

Self-hosted sandboxes for AI agents. Runs on any Linux box with Docker and gVisor; no KVM needed.

Status: v0.1 in progress. Create, exec, streaming exec, files, warm pool, TTL reaper and the API key are here. Templates, the SDK and the egress proxy come next.

## Requirements

- Linux, Docker 20+, Node 20+
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
# create a sandbox (all fields optional: memoryMb, cpus, diskMb, pids, ttlSeconds)
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

The server keeps `POOL_SIZE` (default 3) default-sized containers started ahead of time. A create request whose memory, cpus, disk and pids match the defaults takes one of them; `startup.source` says `pool` and `startup.ms` is the server-side time to ready. Any other size starts a fresh container (`cold`), which takes Docker plus gVisor start time. Each pooled container is used once and destroyed with its sandbox; a background loop refills the pool. Pool containers do not count towards `MAX_SANDBOXES`. `GET /stats` shows pool size, ready, starting, hits and misses.

## What every sandbox gets

| | Default | Env var |
|---|---|---|
| Runtime | gVisor (`runsc`), not configurable | |
| Network | none | |
| Memory | 512 MB, no swap | `DEFAULT_MEMORY_MB`, `MAX_MEMORY_MB` |
| CPUs | 1 | `DEFAULT_CPUS`, `MAX_CPUS` |
| `/workspace` tmpfs | 1024 MB | `DEFAULT_DISK_MB`, `MAX_DISK_MB` |
| Pids | 256 | `DEFAULT_PIDS`, `MAX_PIDS` |
| TTL | 600 s | `DEFAULT_TTL_SECONDS`, `MAX_TTL_SECONDS` |
| Exec timeout | 30 s | `DEFAULT_EXEC_TIMEOUT_MS`, `MAX_EXEC_TIMEOUT_MS` |
| Root filesystem | read-only | |
| User | `nobody` (65534), `--cap-drop=ALL`, `no-new-privileges` | |
| Host mounts, docker socket, host env | none | |

Other settings: `PORT` (7788), `HOST`, `AGENTBOX_API_KEY`, `AGENTBOX_IMAGE` (`python:3.12-slim`), `MAX_SANDBOXES` (20), `MAX_OUTPUT_BYTES` per stream per exec (1 MiB, output past it is dropped and `truncated` is true), `MAX_FILE_BYTES` (8 MiB), `POOL_SIZE` (3), `REAPER_INTERVAL_MS` (10000).

## Tests

```bash
npm test                  # unit tests, no Docker needed
npm run test:integration  # needs Docker + runsc; checks each isolation default from inside a sandbox
```

## Layout

```
src/models/        sandbox record and request/response types
src/repositories/  where records live (in memory for v0.1)
src/runtime/       SandboxRuntime interface and the gVisor-on-Docker implementation
src/services/      SandboxService: create, exec, destroy, reap
src/http/          routes and request parsing
```
