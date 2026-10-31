# agentbox

Self-hosted sandboxes for AI agents. Runs on any Linux box with Docker and gVisor; no KVM needed.

Status: v0.1 in progress. Day 1 (create, exec, destroy, TTL reaper) is here. Warm pool, streaming, files, SDK and the egress proxy come next.

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
npm start          # listens on http://localhost:7788, pulls python:3.12-slim on first run
```

```bash
# create a sandbox (all fields optional: memoryMb, cpus, diskMb, pids, ttlSeconds)
curl -s -X POST localhost:7788/sandboxes -d '{}'
# {"id":"sbx_...","status":"ready","limits":{...},"createdAt":"...","expiresAt":"..."}

# run a command
curl -s -X POST localhost:7788/sandboxes/sbx_.../exec -d '{"cmd":["python","-c","print(2+2)"],"timeoutMs":5000}'
# {"exitCode":0,"stdout":"4\n","stderr":"","durationMs":...,"timedOut":false}

# list, get, destroy
curl -s localhost:7788/sandboxes
curl -s localhost:7788/sandboxes/sbx_...
curl -s -X DELETE localhost:7788/sandboxes/sbx_...
```

Sandboxes expire after `ttlSeconds` (default 600, max 3600). A reaper removes expired ones and any container labelled `agentbox=1` that the server does not know about.

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

Other settings: `PORT` (7788), `AGENTBOX_IMAGE` (`python:3.12-slim`), `MAX_SANDBOXES` (20), `MAX_OUTPUT_BYTES` per stream per exec (1 MiB), `REAPER_INTERVAL_MS` (10000).

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
