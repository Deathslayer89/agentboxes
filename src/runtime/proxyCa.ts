import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { RuntimeUnavailableError } from "../errors.js";

const run = promisify(execFile);

export interface ProxyCa {
  key: string;
  cert: string;
}

/**
 * The server's own CA for the egress proxy, loaded from `dir` or generated and stored there (0600) on first use, so
 * the proxy keeps the same CA across restarts. The server holds the key and never puts it in the proxy's environment.
 */
export async function loadOrCreateProxyCa(dir: string): Promise<ProxyCa> {
  const keyPath = join(dir, "ca.key");
  const certPath = join(dir, "ca.crt");
  if (existsSync(keyPath) && existsSync(certPath)) {
    return { key: await readFile(keyPath, "utf8"), cert: await readFile(certPath, "utf8") };
  }
  const ca = await generateCa();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeAtomic(keyPath, ca.key);
  await writeAtomic(certPath, ca.cert);
  return ca;
}

// A self-signed EC P-256 CA valid ten years, via openssl. Fails with a clear error naming the dependency when openssl is missing.
async function generateCa(): Promise<ProxyCa> {
  const work = await mkdtemp(join(tmpdir(), "agentbox-ca-"));
  try {
    await run("openssl", [
      "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
      "-keyout", join(work, "ca.key"), "-out", join(work, "ca.crt"), "-days", "3650", "-subj", "/CN=agentbox egress proxy CA",
      "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign",
    ]);
    return { key: await readFile(join(work, "ca.key"), "utf8"), cert: await readFile(join(work, "ca.crt"), "utf8") };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new RuntimeUnavailableError("openssl is required to create the egress proxy CA; install openssl, or run the server from the agentbox Docker image");
    throw e;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

// Writes to a temporary file then renames, so a crash never leaves a half-written key, and forces 0600.
async function writeAtomic(path: string, data: string): Promise<void> {
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, data, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}
