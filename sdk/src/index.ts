// TypeScript client for an agentbox server. Node 20+, no dependencies: it only uses the global fetch and the system tar.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface SandboxLimits {
  memoryMb: number;
  cpus: number;
  diskMb: number;
  pids: number;
  ttlSeconds: number;
}

// How the proxy sends one secret: the header (default Authorization) and what goes before the value (default "Bearer " for Authorization, nothing otherwise).
export interface SecretSpec {
  env: string;
  header?: string;
  prefix?: string;
}

export interface CreateOptions extends Partial<SandboxLimits> {
  template?: string;
  // Rules the sandbox may reach through the egress proxy: "pypi.org" (ports 80 and 443), "db.example.com:5432", "*.example.com".
  allowHosts?: string[];
  // host -> the name of an environment variable on the server, sent as "Authorization: Bearer <value>", or a SecretSpec for another header.
  secrets?: Record<string, string | SecretSpec>;
}

export interface SandboxNetwork {
  allowHosts: string[];
  secretHosts: string[];
}

export interface DeniedRequest {
  at: string;
  method: string;
  host: string;
  port: number;
  reason: string;
}

export interface SandboxInfo {
  id: string;
  status: "starting" | "ready" | "busy" | "expired" | "destroyed";
  template: string;
  limits: SandboxLimits;
  network?: SandboxNetwork;
  startup: { source: "pool" | "cold"; ms: number };
  createdAt: string;
  expiresAt: string;
}

export interface ExecOptions {
  timeoutMs?: number;
  // Working directory under /workspace; relative paths start there.
  cwd?: string;
  // Extra environment variables for this command only.
  env?: Record<string, string>;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
}

export type ExecEvent =
  | { type: "stdout"; text: string }
  | { type: "stderr"; text: string }
  | { type: "exit"; exitCode: number; durationMs: number; timedOut: boolean; truncated: boolean };

export interface Template {
  name: string;
  image: string;
}

export interface PoolStats {
  size: number;
  ready: number;
  starting: number;
  hits: number;
  misses: number;
}

export interface Stats {
  sandboxes: { live: number; max: number };
  pools: Record<string, PoolStats>;
}

export interface AgentboxOptions {
  // Defaults to http://127.0.0.1:7788.
  baseUrl?: string;
  // Sent as a bearer token when the server has AGENTBOX_API_KEY set.
  apiKey?: string;
}

// Any non-2xx answer from the server. `code` is the server's error name, for example "ValidationError".
export class AgentboxError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class SandboxNotFound extends AgentboxError {}

// The server's live sandbox limit is reached.
export class PoolExhausted extends AgentboxError {}

// The per-exec timeout killed the command. `result` holds the output collected before that.
export class ExecTimeout extends Error {
  constructor(readonly result: ExecResult) {
    super(`command killed after ${result.durationMs} ms`);
    this.name = "ExecTimeout";
  }
}

export class Agentbox {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;

  constructor(options: AgentboxOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:7788").replace(/\/$/, "");
    this.apiKey = options.apiKey;
  }

  async create(options: CreateOptions = {}): Promise<Sandbox> {
    const info = (await this.json("POST", "/sandboxes", options)) as SandboxInfo;
    return new Sandbox(this, info);
  }

  async get(id: string): Promise<Sandbox> {
    return new Sandbox(this, (await this.json("GET", `/sandboxes/${id}`)) as SandboxInfo);
  }

  async list(): Promise<SandboxInfo[]> {
    return (await this.json("GET", "/sandboxes")) as SandboxInfo[];
  }

  async templates(): Promise<Template[]> {
    return (await this.json("GET", "/templates")) as Template[];
  }

  async stats(): Promise<Stats> {
    return (await this.json("GET", "/stats")) as Stats;
  }

  // Sends a request and throws a typed error for any non-2xx answer.
  async request(method: string, path: string, body?: BodyInit, contentType?: string): Promise<Response> {
    const headers: Record<string, string> = {};
    if (this.apiKey !== undefined) headers.authorization = `Bearer ${this.apiKey}`;
    if (contentType !== undefined) headers["content-type"] = contentType;
    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = body;
    const res = await fetch(this.baseUrl + path, init);
    if (res.ok) return res;
    let code = "HttpError";
    let message = `${method} ${path} failed with status ${res.status}`;
    try {
      const err = (await res.json()) as { error?: string; message?: string };
      if (err.error) code = err.error;
      if (err.message) message = err.message;
    } catch {
      // not JSON: keep the generic message
    }
    if (res.status === 404) throw new SandboxNotFound(message, 404, code);
    if (res.status === 429) throw new PoolExhausted(message, 429, code);
    throw new AgentboxError(message, res.status, code);
  }

  async json(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await this.request(method, path, body === undefined ? undefined : JSON.stringify(body), "application/json");
    return res.json();
  }
}

export class Sandbox {
  constructor(
    private readonly client: Agentbox,
    public info: SandboxInfo,
  ) {}

  get id(): string {
    return this.info.id;
  }

  // Runs a command and waits for it. Throws ExecTimeout when the server killed it at the deadline.
  async exec(cmd: string[], options: ExecOptions = {}): Promise<ExecResult> {
    const result = (await this.client.json("POST", `/sandboxes/${this.id}/exec`, { cmd, ...options })) as ExecResult;
    if (result.timedOut) throw new ExecTimeout(result);
    return result;
  }

  /**
   * Yields one complete line of stdout or stderr at a time (newline included) as the command
   * produces it, then one exit event. A final line without a newline is yielded before exit.
   */
  async *execStream(cmd: string[], options: ExecOptions = {}): AsyncGenerator<ExecEvent, void, undefined> {
    const res = await this.client.request("POST", `/sandboxes/${this.id}/exec/stream`, JSON.stringify({ cmd, ...options }), "application/json");
    const pending = { stdout: "", stderr: "" };
    for await (const { event, data } of readSse(res)) {
      if (event === "stdout" || event === "stderr") {
        pending[event] += data as string;
        let end: number;
        while ((end = pending[event].indexOf("\n")) >= 0) {
          yield { type: event, text: pending[event].slice(0, end + 1) };
          pending[event] = pending[event].slice(end + 1);
        }
      } else if (event === "exit") {
        if (pending.stdout !== "") yield { type: "stdout", text: pending.stdout };
        if (pending.stderr !== "") yield { type: "stderr", text: pending.stderr };
        yield { type: "exit", ...(data as Omit<Extract<ExecEvent, { type: "exit" }>, "type">) };
      } else if (event === "error") {
        const err = data as { error: string; message: string };
        throw new AgentboxError(err.message, 0, err.error);
      }
    }
  }

  // Writes a file under /workspace, creating parent directories.
  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    // A fresh Uint8Array is always backed by a plain ArrayBuffer, which is what fetch accepts.
    const body = typeof content === "string" ? new TextEncoder().encode(content) : new Uint8Array(content);
    await this.client.request("PUT", `/sandboxes/${this.id}/files?path=${encodeURIComponent(path)}`, body, "application/octet-stream");
  }

  async readFile(path: string): Promise<string> {
    return new TextDecoder().decode(await this.readFileBytes(path));
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    const res = await this.client.request("GET", `/sandboxes/${this.id}/files?path=${encodeURIComponent(path)}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  // Unpacks a tar archive into a directory under /workspace (default /workspace itself).
  async uploadTar(tar: Uint8Array, dir = "/workspace"): Promise<void> {
    await this.client.request("PUT", `/sandboxes/${this.id}/archive?path=${encodeURIComponent(dir)}`, new Uint8Array(tar), "application/x-tar");
  }

  // Packs a directory under /workspace as a tar archive.
  async downloadTar(dir = "/workspace"): Promise<Uint8Array> {
    const res = await this.client.request("GET", `/sandboxes/${this.id}/archive?path=${encodeURIComponent(dir)}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  // Sends a local directory's contents into the sandbox, using the system tar.
  async uploadDirectory(localDir: string, dir = "/workspace"): Promise<void> {
    const { stdout } = await run("tar", ["-c", "-C", localDir, "."], { encoding: "buffer", maxBuffer: 1024 * 1024 * 1024 });
    await this.uploadTar(new Uint8Array(stdout), dir);
  }

  // Writes a sandbox directory's contents into a local directory, refusing archive members that would leave it.
  async downloadDirectory(dir: string, localDir: string): Promise<void> {
    const tar = Buffer.from(await this.downloadTar(dir));
    const listing = await run("tar", ["-t"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, input: tar } as never);
    const unsafe = String(listing.stdout).split("\n").filter((m) => m !== "" && (m.startsWith("/") || m.split("/").includes("..")));
    if (unsafe.length > 0) throw new Error(`archive from the sandbox has unsafe paths: ${unsafe.slice(0, 3).join(", ")}`);
    await run("tar", ["-x", "-C", localDir], { encoding: "buffer", maxBuffer: 1024 * 1024, input: tar } as never);
  }

  // Outbound requests the proxy refused, with the allowlist in force.
  async egressLog(): Promise<{ allowHosts: string[]; denied: DeniedRequest[] }> {
    return (await this.client.json("GET", `/sandboxes/${this.id}/egress-log`)) as { allowHosts: string[]; denied: DeniedRequest[] };
  }

  // Pushes the expiry to now plus ttlSeconds (default: the sandbox's own TTL).
  async extend(ttlSeconds?: number): Promise<SandboxInfo> {
    this.info = (await this.client.json("POST", `/sandboxes/${this.id}/extend`, ttlSeconds === undefined ? {} : { ttlSeconds })) as SandboxInfo;
    return this.info;
  }

  // Re-reads the sandbox record from the server (status, expiry).
  async refresh(): Promise<SandboxInfo> {
    this.info = (await this.client.json("GET", `/sandboxes/${this.id}`)) as SandboxInfo;
    return this.info;
  }

  async destroy(): Promise<void> {
    this.info = (await this.client.json("DELETE", `/sandboxes/${this.id}`)) as SandboxInfo;
  }
}

// Parses a Server-Sent Events body into { event, data } pairs, with data already JSON-decoded.
async function* readSse(res: Response): AsyncGenerator<{ event: string; data: unknown }> {
  if (res.body === null) return;
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (event !== undefined && data !== undefined) yield { event, data: JSON.parse(data) };
    }
  }
}
