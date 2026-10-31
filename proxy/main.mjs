import { startProxy } from "./server.mjs";

const adminToken = process.env.ADMIN_TOKEN;
if (!adminToken) {
  console.error("ADMIN_TOKEN is required");
  process.exit(1);
}
const { proxyPort, controlPort } = await startProxy({
  adminToken,
  proxyPort: Number(process.env.PROXY_PORT ?? 3128),
  controlPort: Number(process.env.CONTROL_PORT ?? 3129),
});
console.log(`agentbox egress proxy: sandboxes on :${proxyPort}, control on :${controlPort}`);
process.on("SIGTERM", () => process.exit(0));
