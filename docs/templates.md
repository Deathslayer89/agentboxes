# Templates

Images with packages already installed, so a sandbox starts with them.

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
