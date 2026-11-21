import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const openssl = promisify(execFile);

// A server certificate for one host name or IP, signed by `ca`, valid thirty days.
export async function issueCert(ca, host) {
  const dir = await mkdtemp(join(tmpdir(), "agentbox-leaf-"));
  try {
    await writeFile(join(dir, "ca.key"), ca.key, { mode: 0o600 });
    await writeFile(join(dir, "ca.crt"), ca.cert);
    await writeFile(join(dir, "ext.cnf"), `subjectAltName=${isIP(host) ? "IP" : "DNS"}:${host}\nextendedKeyUsage=serverAuth\n`);
    await openssl("openssl", [
      "req", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
      "-keyout", join(dir, "leaf.key"), "-out", join(dir, "leaf.csr"), "-subj", `/CN=${host}`,
    ]);
    await chmod(join(dir, "leaf.key"), 0o600);
    await openssl("openssl", [
      "x509", "-req", "-in", join(dir, "leaf.csr"), "-CA", join(dir, "ca.crt"), "-CAkey", join(dir, "ca.key"),
      "-CAcreateserial", "-out", join(dir, "leaf.crt"), "-days", "30", "-extfile", join(dir, "ext.cnf"),
    ]);
    return { key: await readFile(join(dir, "leaf.key"), "utf8"), cert: await readFile(join(dir, "leaf.crt"), "utf8") };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
