#!/usr/bin/env node
// Entry point of the published package: picks the compiled server, the MCP server or the template CLI.
const commands = {
  serve: "../dist/src/main.js",
  mcp: "../dist/mcp/server.js",
  template: "../dist/src/cli.js",
};
const usage = `usage:
  agentbox serve                                 start the server on http://127.0.0.1:7788 (PORT, HOST, AGENTBOX_API_KEY, POOL_SIZES, AGENTBOX_DB, LOG_LEVEL)
  agentbox mcp                                   start the MCP server over stdio (AGENTBOX_URL, AGENTBOX_API_KEY, AGENTBOX_TEMPLATE, AGENTBOX_ALLOW_HOSTS)
  agentbox template build <name> <Dockerfile>    build a template image
  agentbox template list                         list template images`;
const command = process.argv[2] ?? "serve";
if (!(command in commands)) {
  console.error(usage);
  process.exit(command === "help" || command === "--help" || command === "-h" ? 0 : 2);
}
await import(commands[command]);
