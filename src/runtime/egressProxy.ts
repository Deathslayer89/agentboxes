import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type Docker from "dockerode";
import type { SettingsRepository } from "../repositories/sqliteStore.js";
import type { DeniedRequest, EgressPolicy } from "./sandboxRuntime.js";

export interface EgressAttachment {
  // Name of the sandbox's own isolated network.
  network: string;
  // Proxy and certificate environment for the sandbox.
  env: string[];
  // The proxy's CA certificate, only when the policy has secrets; installed into the sandbox after start.
  caPem: string | undefined;
}

const IMAGE = "agentbox/egress-proxy:latest";
const CONTAINER = "agentbox-egress-proxy";
const PROXY_PORT = 3128;
const CONTROL_PORT = 3129;
const LABEL_PROXY = "agentbox.proxy";
const ADMIN_TOKEN_SETTING = "egressProxy.adminToken";
const LABEL_SOURCE = "agentbox.proxy.source";
// On networks; the value is the sandbox id.
export const LABEL_NETWORK = "agentbox.network";
const SOURCE_DIR = fileURLToPath(new URL("../../proxy/", import.meta.url));
const SOURCE_FILES = ["Dockerfile", "policy.mjs", "certs.mjs", "server.mjs", "main.mjs"];
// Where the CA certificate and the combined bundle are written inside a sandbox with secrets.
export const CA_DIR = "/tmp/agentbox";
const MB = 1024 * 1024;

/**
 * Runs the egress proxy container and gives each allowlisted sandbox its own internal Docker
 * network with an isolated gateway, so the sandbox can reach the proxy and nothing else, not
 * even the host. The proxy runs under runc, not gVisor, because gVisor does not pick up
 * networks connected after start; otherwise it is hardened like a sandbox.
 */
export class EgressProxyManager {
  private adminToken = "";
  private containerId: string | undefined;
  private controlUrl: string | undefined;
  private caPem: string | undefined;
  // Set when the allowlist feature cannot work on this machine; create() then refuses allowHosts.
  unavailableReason: string | undefined;
  // True when init() found the previous proxy container still running and kept it, with its policies intact.
  reused = false;

  constructor(
    private readonly docker: Docker,
    private readonly settings: SettingsRepository,
  ) {}

  get available(): boolean {
    return this.unavailableReason === undefined;
  }

  private get proxyId(): string {
    if (this.containerId === undefined) throw new Error("the egress proxy is not running");
    return this.containerId;
  }

  async init(): Promise<void> {
    const version = (await this.docker.version()).Version ?? "0";
    if (Number(version.split(".")[0]) < 28) {
      this.unavailableReason = `isolated networks need Docker 28 or newer, this is ${version}`;
      return;
    }
    try {
      await this.buildImage();
      if (await this.reuseRunning()) return;
      await this.removeLeftovers();
      this.adminToken = randomBytes(24).toString("hex");
      this.settings.set(ADMIN_TOKEN_SETTING, this.adminToken);
      await this.startContainer();
    } catch (e) {
      this.unavailableReason = `the egress proxy could not start: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // Keeps the proxy from the previous server run when it is still up and answers to the stored token.
  private async reuseRunning(): Promise<boolean> {
    const token = this.settings.get(ADMIN_TOKEN_SETTING);
    if (token === undefined) return false;
    const [running] = await this.docker.listContainers({ filters: { label: [`${LABEL_PROXY}=1`], status: ["running"] } });
    if (running === undefined) return false;
    const info = (await this.docker.getContainer(running.Id).inspect()) as { NetworkSettings: { Networks: Record<string, { IPAddress: string }> } };
    const ip = info.NetworkSettings.Networks.bridge?.IPAddress;
    if (!ip) return false;
    this.adminToken = token;
    this.containerId = running.Id;
    this.controlUrl = `http://${ip}:${CONTROL_PORT}`;
    try {
      await this.control("GET", "/health");
    } catch {
      this.containerId = undefined;
      this.controlUrl = undefined;
      return false;
    }
    this.caPem = await (await this.control("GET", "/ca")).text();
    this.reused = true;
    return true;
  }

  // Creates the network, puts the proxy on it, registers the policy and returns what the sandbox needs.
  async attach(sandboxId: string, policy: EgressPolicy): Promise<EgressAttachment> {
    const name = `agentbox-${sandboxId}`;
    const network = await this.docker.createNetwork({
      Name: name,
      Driver: "bridge",
      Internal: true,
      Options: { "com.docker.network.bridge.gateway_mode_ipv4": "isolated" },
      Labels: { [LABEL_NETWORK]: sandboxId },
    });
    try {
      await network.connect({ Container: this.proxyId });
      const info = (await network.inspect()) as { Containers: Record<string, { IPv4Address: string }> };
      const proxyIp = info.Containers[this.proxyId]?.IPv4Address.split("/")[0];
      if (proxyIp === undefined) throw new Error("proxy has no address on the sandbox network");
      const token = randomBytes(16).toString("hex");
      await this.control("PUT", `/policies/${sandboxId}`, { token, allowHosts: policy.allowHosts, secrets: policy.secrets });
      const proxyUrl = `http://${sandboxId}:${token}@${proxyIp}:${PROXY_PORT}`;
      const env = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"].map((key) => `${key}=${proxyUrl}`);
      const hasSecrets = Object.keys(policy.secrets).length > 0;
      if (hasSecrets) {
        const bundle = `${CA_DIR}/bundle.pem`;
        env.push(`SSL_CERT_FILE=${bundle}`, `REQUESTS_CA_BUNDLE=${bundle}`, `CURL_CA_BUNDLE=${bundle}`, `GIT_SSL_CAINFO=${bundle}`, `PIP_CERT=${bundle}`, `NODE_EXTRA_CA_CERTS=${CA_DIR}/ca.pem`);
      }
      return { network: name, env, caPem: hasSecrets ? this.caPem : undefined };
    } catch (e) {
      await this.detach(sandboxId).catch(() => {});
      throw e;
    }
  }

  // Drops the policy and the network. The sandbox container must already be gone.
  async detach(sandboxId: string): Promise<void> {
    await this.control("DELETE", `/policies/${sandboxId}`).catch(() => {});
    const network = this.docker.getNetwork(`agentbox-${sandboxId}`);
    if (this.containerId !== undefined) await network.disconnect({ Container: this.containerId, Force: true }).catch(() => {});
    try {
      await network.remove();
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
  }

  async deniedLog(sandboxId: string): Promise<DeniedRequest[]> {
    const body = (await (await this.control("GET", `/policies/${sandboxId}/log`)).json()) as { denied: DeniedRequest[] };
    return body.denied;
  }

  async shutdown(): Promise<void> {
    if (this.containerId === undefined) return;
    await this.docker.getContainer(this.containerId).remove({ force: true }).catch(() => {});
    this.containerId = undefined;
  }

  // Builds the image from proxy/ unless an image built from the same source is already there.
  private async buildImage(): Promise<void> {
    const hash = createHash("sha256");
    for (const file of SOURCE_FILES) hash.update(readFileSync(SOURCE_DIR + file));
    const source = hash.digest("hex");
    try {
      const info = (await this.docker.getImage(IMAGE).inspect()) as { Config?: { Labels?: Record<string, string> } };
      if (info.Config?.Labels?.[LABEL_SOURCE] === source) return;
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
    console.log("agentbox: building the egress proxy image");
    const stream = await this.docker.buildImage({ context: SOURCE_DIR, src: SOURCE_FILES }, { t: IMAGE, labels: { [LABEL_SOURCE]: source } });
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(
        stream,
        (err) => (err ? reject(err) : resolve()),
        (event: { error?: string }) => event.error && reject(new Error(event.error)),
      );
    });
  }

  // A proxy container from a previous run has a stale token; networks without containers are leftovers too.
  private async removeLeftovers(): Promise<void> {
    for (const c of await this.docker.listContainers({ all: true, filters: { label: [`${LABEL_PROXY}=1`] } })) {
      await this.docker.getContainer(c.Id).remove({ force: true });
    }
    for (const n of await this.docker.listNetworks({ filters: { label: [LABEL_NETWORK] } })) {
      const info = (await this.docker.getNetwork(n.Id).inspect()) as { Containers?: Record<string, unknown> };
      if (Object.keys(info.Containers ?? {}).length === 0) await this.docker.getNetwork(n.Id).remove();
    }
  }

  private async startContainer(): Promise<void> {
    const container = await this.docker.createContainer({
      Image: IMAGE,
      name: CONTAINER,
      Env: [`ADMIN_TOKEN=${this.adminToken}`, `PROXY_PORT=${PROXY_PORT}`, `CONTROL_PORT=${CONTROL_PORT}`],
      Labels: { [LABEL_PROXY]: "1" },
      HostConfig: {
        NetworkMode: "bridge",
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges"],
        ReadonlyRootfs: true,
        Tmpfs: { "/tmp": "rw,size=64m,mode=1777" },
        Memory: 256 * MB,
        MemorySwap: 256 * MB,
        PidsLimit: 128,
      },
    });
    await container.start();
    this.containerId = container.id;
    const info = (await container.inspect()) as { NetworkSettings: { Networks: Record<string, { IPAddress: string }> } };
    const ip = info.NetworkSettings.Networks.bridge?.IPAddress;
    if (!ip) throw new Error("proxy container has no address on the default bridge");
    this.controlUrl = `http://${ip}:${CONTROL_PORT}`;
    await this.waitUntilHealthy();
    this.caPem = await (await this.control("GET", "/ca")).text();
  }

  private async waitUntilHealthy(): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (true) {
      try {
        await this.control("GET", "/health");
        return;
      } catch (e) {
        if (Date.now() > deadline) throw new Error(`proxy did not become healthy: ${e instanceof Error ? e.message : String(e)}`);
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  }

  private async control(method: string, path: string, body?: unknown): Promise<Response> {
    const init: RequestInit = { method, headers: { authorization: `Bearer ${this.adminToken}` }, signal: AbortSignal.timeout(5_000) };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await fetch(this.controlUrl + path, init);
    if (!res.ok) throw new Error(`proxy control ${method} ${path} failed with status ${res.status}`);
    return res;
  }
}

function isNotFound(e: unknown): boolean {
  return typeof e === "object" && e !== null && "statusCode" in e && e.statusCode === 404;
}
