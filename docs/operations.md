# Running agentbox

Installing gVisor by hand, keys, the status page, stopping, the Docker image, what survives a restart, logs and the warm pool. Commands shown with `npm start` are from a clone; the package's `agentbox serve` takes the same environment.

## Installing gVisor by hand

`agentbox setup` (`bin/setup.sh`) is what the README runs: it checks that Docker answers, and when `runsc` is not a registered Docker runtime it installs gVisor from its apt repository on Debian and Ubuntu, or from the release tarball (checksum verified, unpacked into `/usr/local/bin`) elsewhere, runs `runsc install` for `runsc` and, when `/dev/kvm` exists, for `runsc-kvm` with `--platform=kvm`, reloads Docker, and starts one container under each runtime. Every `sudo` command is printed before it runs; `--check` installs nothing and exits non-zero when something is missing. CI runs it on a runner without gVisor before the integration tests. The same steps by hand, on Ubuntu or Debian:

```bash
sudo apt-get update && sudo apt-get install -y apt-transport-https ca-certificates curl gnupg
curl -fsSL https://gvisor.dev/archive.key | sudo gpg --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg
echo "deb [arch=amd64 signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" | sudo tee /etc/apt/sources.list.d/gvisor.list > /dev/null
sudo apt-get update && sudo apt-get install -y runsc
sudo runsc install
sudo systemctl restart docker
docker run --rm --runtime=runsc alpine uname -a   # kernel line ends in -gvisor: that is gVisor
```

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

Sandbox records live in a SQLite file (`AGENTBOX_DB`, default `data/agentbox.db`). Stopping the server leaves sandboxes running and removes the warm pool's containers; the next start adopts every sandbox whose container is still there, marks the others expired, removes anything left over (a pool container that was still starting shows up as "removed 1 orphaned container(s)"), and keeps using the egress proxy container from the previous run so allowlisted sandboxes keep their network. If Docker itself restarted, or the proxy's source changed since it was built, the proxy is started fresh and sandboxes that had a network are destroyed at startup, with a log line. While the server is down nothing enforces TTLs: sandboxes run until the next start reaps the expired ones. A command whose client disconnects, or whose streaming response is aborted, is killed inside the sandbox; the sandbox itself stays. Sandboxes expire after `ttlSeconds` (default 600, max 3600) unless extended. A reaper removes expired ones and any container labelled `agentbox=1` that the server does not know about.

## Logs

Logs are pretty single lines on a terminal and JSON lines everywhere else (Docker, pm2, a file); `LOG_FORMAT=json` or `pretty` overrides that. Every line names its component (`http`, `service`, `runtime`, `proxy`, `pool`, `server`), and every sandbox event carries the sandbox id: a create with its owner, source and limits, every command with its arguments, exit code and time, files and archives with their sizes, extends, expiries and destroys, orphans and dead pool containers, proxy starts, and one line per HTTP request with its status, time and the key's name. `LOG_LEVEL=debug` adds command starts, container ids and network attachments; `LOG_LEVEL=warn` keeps only problems. Command arguments are logged as given and environment values are not, so keep secrets out of arguments; that is what the proxy's secret injection is for.

```
[01:50:56.075] INFO: (service) sandbox created {"sandbox":"sbx_591a71c56d88","owner":"local","template":"default","source":"pool","ms":0.2,"limits":{"memoryMb":512,"cpus":1,"diskMb":1024,"pids":256,"ttlSeconds":600}}
[01:50:57.848] INFO: (service) exec done {"sandbox":"sbx_591a71c56d88","cmd":"python main.py","cwd":"/workspace","exitCode":0,"ms":47,"timedOut":false,"truncated":false,"stdoutBytes":3,"stderrBytes":0}
[01:50:56.724] INFO: (http) request {"method":"POST","path":"/sandboxes/sbx_591a71c56d88/exec","status":200,"ms":46}
```

## Warm pool

The server keeps default-sized containers started ahead of time, one pool per template, sized by `POOL_SIZES` (default `default:3`). A create request whose memory, cpus, disk and pids match the defaults takes one from its template's pool; `startup.source` says `pool` and `startup.ms` is the server-side time to ready. Any other size, or a template without a pool, starts a fresh container (`cold`), which takes Docker plus gVisor start time. Each pooled container is used once and destroyed with its sandbox; the pool refills all its missing containers at once, so a burst of creates costs one start's time. Pool containers do not count towards `MAX_SANDBOXES`. `GET /stats` shows size, ready, starting, hits and misses per pool, and `GET /metrics` exposes the same plus creates by source, removals by reason and an exec latency histogram in the Prometheus text format.
