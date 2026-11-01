# Development

Working from a clone: `npm install` then `npm start` runs the server from source, `npm run agentbox -- template build` builds templates, and `npx tsx mcp/server.ts` is the MCP server.

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
