import os from "node:os";
import { startProxy } from "./server.mjs";

const adminToken = process.env.ADMIN_TOKEN;
if (!adminToken) {
  console.error("ADMIN_TOKEN is required");
  process.exit(1);
}
// The control API listens only on the address the container has at start, Docker's default bridge; sandbox networks are joined later and never see it.
const bridgeAddress = Object.values(os.networkInterfaces())
  .flat()
  .find((iface) => iface !== undefined && iface.family === "IPv4" && !iface.internal)?.address;
if (bridgeAddress === undefined) {
  console.error("no address to bind the control API to");
  process.exit(1);
}
const { proxyPort, controlPort } = await startProxy({
  adminToken,
  controlHost: bridgeAddress,
  proxyPort: Number(process.env.PROXY_PORT ?? 3128),
  controlPort: Number(process.env.CONTROL_PORT ?? 3129),
});
console.log(`agentbox egress proxy: sandboxes on :${proxyPort}, control on ${bridgeAddress}:${controlPort}`);
process.on("SIGTERM", () => process.exit(0));
