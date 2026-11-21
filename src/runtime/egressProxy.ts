import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type Docker from "dockerode";
import { logFor, type Logger } from "../log.js";
import type { SettingsRepository } from "../repositories/sqliteStore.js";
import { loadOrCreateProxyCa, type ProxyCa } from "./proxyCa.js";
import type { DeniedRequest, EgressPolicy, SecretHeader } from "./sandboxRuntime.js";

// What the proxy needs to enforce one sandbox's policy, kept so it can be re-pushed when the server restarts.
interface StoredPolicy {
  token: string;
  subnet: string | undefined;
  allowHosts: string[];
  secrets: Record<string, SecretHeader>;
}

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
// The id of the server that owns a network.
const LABEL_SERVER = "agentbox.server";
const ADMIN_TOKEN_SETTING = "egressProxy.adminToken";
const LABEL_SOURCE = "agentbox.proxy.source";
// On networks; the value is the sandbox id.
export const LABEL_NETWORK = "agentbox.network";
const SOURCE_DIR = fileURLToPath(new URL("../../proxy/", import.meta.url));
const SOURCE_FILES = ["Dockerfile", "policy.mjs", "certs.mjs", "leafs.mjs", "server.mjs", "main.mjs"];
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
  private ca: ProxyCa | undefined;
  private readonly caDir: string;
  // Set when the allowlist feature cannot work, at startup or after the proxy crashes; create() then refuses allowHosts.
  unavailableReason: string | undefined;
  // True when init() found the previous proxy container still running and kept it, with its policies intact.
  reused = false;

  constructor(
    private readonly docker: Docker,
    private readonly settings: SettingsRepository,
    private readonly serverId: string,
    dataDir: string,
    private readonly log: Logger = logFor("proxy"),
  ) {
    this.caDir = join(dataDir, `proxy-ca-${serverId}`);
  }

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
      const source = await this.buildImage();
      if (await this.reuseRunning(source)) {
        this.log.info({ container: this.containerId?.slice(0, 12) }, "egress proxy from the previous run reused");
      } else {
        await this.removeLeftovers();
        this.adminToken = randomBytes(24).toString("hex");
        this.settings.set(ADMIN_TOKEN_SETTING, this.adminToken);
        await this.startContainer();
        this.log.info({ container: this.containerId?.slice(0, 12), control: this.controlUrl }, "egress proxy started");
      }
      await this.configureProxy();
    } catch (e) {
      this.unavailableReason = `the egress proxy could not start: ${e instanceof Error ? e.message : String(e)}`;
      this.log.warn({ err: e }, "egress proxy could not start");
    }
  }

  // Keeps the proxy from the previous server run when it is still up, was built from the same source, and answers to the stored token.
  private async reuseRunning(source: string): Promise<boolean> {
    const token = this.settings.get(ADMIN_TOKEN_SETTING);
    if (token === undefined) return false;
    const [running] = await this.docker.listContainers({ filters: { label: [`${LABEL_PROXY}=${this.serverId}`], status: ["running"] } });
    if (running === undefined || running.Labels[LABEL_SOURCE] !== source) return false;
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
    this.reused = true;
    return true;
  }

  // Loads the server's CA and pushes it to the proxy over the control API.
  private async configureProxy(): Promise<void> {
    this.ca ??= await loadOrCreateProxyCa(this.caDir);
    await this.control("PUT", "/ca", { key: this.ca.key, cert: this.ca.cert });
    this.caPem = this.ca.cert;
  }

  /**
   * Reaper-tick check: if the proxy the server started is no longer running, it crashed (Docker is not told to restart
   * it). Mark egress unavailable so new allowlisted or secret creates are refused with a clear reason; existing
   * networked sandboxes keep running without egress until the server is restarted, which re-attaches them.
   */
  async ensureHealthy(): Promise<void> {
    if (this.containerId === undefined || !this.available) return;
    let running = false;
    try {
      running = ((await this.docker.getContainer(this.containerId).inspect()) as { State: { Running: boolean } }).State.Running;
    } catch {
      running = false; // the container is gone
    }
    if (!running) {
      this.unavailableReason = "the egress proxy has stopped; restart the server to restore egress for networked sandboxes";
      this.log.error("egress proxy has stopped; new allowlisted or secret sandboxes are refused until the server is restarted");
    }
  }

  // Connects the proxy to a sandbox's network at its pinned IP; a no-op when it is already connected there.
  private async connectAtPinnedIp(sandboxId: string, subnet: string): Promise<void> {
    try {
      await this.docker.getNetwork(`agentbox-${sandboxId}`).connect({ Container: this.proxyId, EndpointConfig: { IPAMConfig: { IPv4Address: secondHost(subnet) } } });
    } catch (e) {
      if (!isAlreadyConnected(e)) throw e;
    }
  }

  // Creates the network, puts the proxy on it, registers the policy and returns what the sandbox needs.
  async attach(sandboxId: string, policy: EgressPolicy): Promise<EgressAttachment> {
    const name = `agentbox-${sandboxId}`;
    const network = await this.docker.createNetwork({
      Name: name,
      Driver: "bridge",
      Internal: true,
      Options: { "com.docker.network.bridge.gateway_mode_ipv4": "isolated" },
      Labels: { [LABEL_NETWORK]: sandboxId, [LABEL_SERVER]: this.serverId },
    });
    try {
      const subnet = ((await network.inspect()) as { IPAM: { Config: Array<{ Subnet: string }> } }).IPAM.Config[0]?.Subnet;
      if (subnet === undefined) throw new Error("sandbox network has no subnet");
      // Pin the proxy to a fixed address on this network, so when the server restarts and re-attaches it the sandbox finds it at the same IP.
      const proxyIp = secondHost(subnet);
      await network.connect({ Container: this.proxyId, EndpointConfig: { IPAMConfig: { IPv4Address: proxyIp } } });
      // The token is bound to the network's subnet, so it is useless from anywhere but this sandbox.
      const token = randomBytes(16).toString("hex");
      const stored: StoredPolicy = { token, subnet, allowHosts: policy.allowHosts, secrets: policy.secrets };
      await this.control("PUT", `/policies/${sandboxId}`, stored);
      const proxyUrl = `http://${sandboxId}:${token}@${proxyIp}:${PROXY_PORT}`;
      const env = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"].map((key) => `${key}=${proxyUrl}`);
      // The sandbox's own loopback never goes through the proxy, so a dev server or a test server inside keeps working.
      env.push("NO_PROXY=localhost,127.0.0.1,::1", "no_proxy=localhost,127.0.0.1,::1");
      const hasSecrets = Object.keys(policy.secrets).length > 0;
      this.log.debug({ sandbox: sandboxId, network: name, subnet, allowHosts: policy.allowHosts, secretHosts: Object.keys(policy.secrets) }, "sandbox network attached");
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

  /**
   * Re-registers a sandbox adopted after a server restart: reads back the token from the sandbox's container
   * environment and the subnet from its network (neither survives in memory), re-attaches the proxy to the network at
   * the pinned IP, and pushes the policy again so a freshly started proxy enforces it. Returns false when the policy
   * cannot be rebuilt, so the caller can destroy the sandbox rather than leave it without egress.
   */
  async readopt(sandboxId: string, handle: string, allowHosts: string[], secrets: Record<string, SecretHeader>): Promise<boolean> {
    try {
      const env = ((await this.docker.getContainer(handle).inspect()) as { Config: { Env: string[] } }).Config.Env;
      const token = env.find((e) => e.startsWith("HTTP_PROXY="))?.match(/\/\/[^:]+:([^@]+)@/)?.[1];
      const subnet = ((await this.docker.getNetwork(`agentbox-${sandboxId}`).inspect()) as { IPAM: { Config: Array<{ Subnet: string }> } }).IPAM.Config[0]?.Subnet;
      if (token === undefined || subnet === undefined) return false;
      const stored: StoredPolicy = { token, subnet, allowHosts, secrets };
      await this.connectAtPinnedIp(sandboxId, subnet);
      await this.control("PUT", `/policies/${sandboxId}`, stored);
      return true;
    } catch {
      return false;
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

  // Builds the image from proxy/ unless an image built from the same source is already there. Returns the source hash.
  private async buildImage(): Promise<string> {
    const hash = createHash("sha256");
    for (const file of SOURCE_FILES) hash.update(readFileSync(SOURCE_DIR + file));
    const source = hash.digest("hex");
    try {
      const info = (await this.docker.getImage(IMAGE).inspect()) as { Config?: { Labels?: Record<string, string> } };
      if (info.Config?.Labels?.[LABEL_SOURCE] === source) return source;
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
    this.log.info({ image: IMAGE }, "building the egress proxy image");
    const stream = await this.docker.buildImage({ context: SOURCE_DIR, src: SOURCE_FILES }, { t: IMAGE, labels: { [LABEL_SOURCE]: source } });
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(
        stream,
        (err) => (err ? reject(err) : resolve()),
        (event: { error?: string }) => event.error && reject(new Error(event.error)),
      );
    });
    return source;
  }

  /**
   * Removes the egress proxy and sandbox networks from a version before per-server labels: the proxy container named
   * exactly `agentbox-egress-proxy` (the new name carries the server id) and the networks that carry an agentbox
   * network label but no server id. Returns the names removed, for the log.
   */
  async removePreUpgradeProxy(): Promise<string[]> {
    const removed: string[] = [];
    for (const c of await this.docker.listContainers({ all: true, filters: { name: [`^/${CONTAINER}$`] } })) {
      try {
        await this.docker.getContainer(c.Id).remove({ force: true });
      } catch {
        continue; // leave it for the next run rather than report a name that is still there
      }
      removed.push(c.Names[0] ?? c.Id);
    }
    for (const n of await this.docker.listNetworks({ filters: { label: [LABEL_NETWORK] } })) {
      if (n.Labels?.[LABEL_SERVER] !== undefined) continue; // a current server's network, not a pre-upgrade one
      try {
        await this.docker.getNetwork(n.Id).remove();
      } catch {
        continue; // leave it for the next run rather than report a name that is still there
      }
      removed.push(n.Name);
    }
    return removed;
  }

  // A proxy container from a previous run has a stale token; this server's networks without containers are leftovers too.
  private async removeLeftovers(): Promise<void> {
    for (const c of await this.docker.listContainers({ all: true, filters: { label: [`${LABEL_PROXY}=${this.serverId}`] } })) {
      await this.docker.getContainer(c.Id).remove({ force: true });
    }
    for (const n of await this.docker.listNetworks({ filters: { label: [`${LABEL_SERVER}=${this.serverId}`] } })) {
      const info = (await this.docker.getNetwork(n.Id).inspect()) as { Containers?: Record<string, unknown> };
      if (Object.keys(info.Containers ?? {}).length === 0) await this.docker.getNetwork(n.Id).remove();
    }
  }

  private async startContainer(): Promise<void> {
    const container = await this.docker.createContainer({
      Image: IMAGE,
      name: `${CONTAINER}-${this.serverId}`,
      Env: [`ADMIN_TOKEN=${this.adminToken}`, `PROXY_PORT=${PROXY_PORT}`, `CONTROL_PORT=${CONTROL_PORT}`],
      Labels: { [LABEL_PROXY]: this.serverId },
      HostConfig: {
        NetworkMode: "bridge",
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges"],
        ReadonlyRootfs: true,
        Tmpfs: { "/tmp": "rw,size=64m,mode=1777" },
        Memory: 256 * MB,
        MemorySwap: 256 * MB,
        PidsLimit: 128,
        // A crash does not restart the proxy; the server marks egress unavailable and a server restart re-attaches sandboxes.
        RestartPolicy: { Name: "no" },
      },
    });
    await container.start();
    this.containerId = container.id;
    const info = (await container.inspect()) as { NetworkSettings: { Networks: Record<string, { IPAddress: string }> } };
    const ip = info.NetworkSettings.Networks.bridge?.IPAddress;
    if (!ip) throw new Error("proxy container has no address on the default bridge");
    this.controlUrl = `http://${ip}:${CONTROL_PORT}`;
    await this.waitUntilHealthy();
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

// The second host address of an IPv4 "a.b.c.d/n" subnet (the first, .1, is the gateway), for a stable proxy IP per sandbox network.
function secondHost(subnet: string): string {
  const [a = 0, b = 0, c = 0, d = 0] = (subnet.split("/")[0] ?? "").split(".").map(Number);
  const n = (((a << 24) | (b << 16) | (c << 8) | d) + 2) >>> 0;
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

function isNotFound(e: unknown): boolean {
  return typeof e === "object" && e !== null && "statusCode" in e && e.statusCode === 404;
}

// Docker reports an "already exists in network" error when the proxy is already connected; re-attaching is then a no-op.
export function isAlreadyConnected(e: unknown): boolean {
  const message = typeof e === "object" && e !== null && "message" in e ? String((e as { message: unknown }).message) : "";
  return /already (exists in network|connected to network)/i.test(message);
}
