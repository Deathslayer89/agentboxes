import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const openssl = promisify(execFile);

// A self-signed EC P-256 certificate authority, valid ten years. Returns PEM strings.
export async function createCa(name = "agentbox egress proxy CA") {
  const dir = await mkdtemp(join(tmpdir(), "agentbox-ca-"));
  try {
    await openssl("openssl", [
      "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
      "-keyout", join(dir, "ca.key"), "-out", join(dir, "ca.crt"), "-days", "3650", "-subj", `/CN=${name}`,
      "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign",
    ]);
    return { key: await readFile(join(dir, "ca.key"), "utf8"), cert: await readFile(join(dir, "ca.crt"), "utf8") };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// A server certificate for one host name or IP, signed by `ca`, valid thirty days.
export async function issueCert(ca, host) {
  const dir = await mkdtemp(join(tmpdir(), "agentbox-leaf-"));
  try {
    await writeFile(join(dir, "ca.key"), ca.key);
    await writeFile(join(dir, "ca.crt"), ca.cert);
    await writeFile(join(dir, "ext.cnf"), `subjectAltName=${isIP(host) ? "IP" : "DNS"}:${host}\nextendedKeyUsage=serverAuth\n`);
    await openssl("openssl", [
      "req", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
      "-keyout", join(dir, "leaf.key"), "-out", join(dir, "leaf.csr"), "-subj", `/CN=${host}`,
    ]);
    await openssl("openssl", [
      "x509", "-req", "-in", join(dir, "leaf.csr"), "-CA", join(dir, "ca.crt"), "-CAkey", join(dir, "ca.key"),
      "-CAcreateserial", "-out", join(dir, "leaf.crt"), "-days", "30", "-extfile", join(dir, "ext.cnf"),
    ]);
    return { key: await readFile(join(dir, "leaf.key"), "utf8"), cert: await readFile(join(dir, "leaf.crt"), "utf8") };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
