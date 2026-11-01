import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import http from "node:http";
import https from "node:https";
import type net from "node:net";
import tls from "node:tls";
import test, { after, before } from "node:test";
import { createCa, issueCert } from "../../../proxy/certs.mjs";
import { inSubnet } from "../../../proxy/policy.mjs";
import { startProxy } from "../../../proxy/server.mjs";

// The proxy on loopback with allowPrivateTargets, so a local echo server can stand in for the internet.
const hasOpenssl = spawnSync("openssl", ["version"]).status === 0;

// Answers with the method, url and headers it received, with a content-length so the body is not chunked, then closes.
function echoHandler(req: http.IncomingMessage, res: http.ServerResponse): void {
  const body = JSON.stringify({ method: req.method, url: req.url, headers: req.headers });
  res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body), connection: "close" });
  res.end(body);
}

type Proxy = Awaited<ReturnType<typeof startProxy>>;
let upstream: http.Server;
let upstreamPort: number;
let proxy: Proxy;

const basic = (id: string, token: string) => "Basic " + Buffer.from(`${id}:${token}`).toString("base64");

function control(p: Proxy, method: string, path: string, body?: unknown, token = "adm"): Promise<Response> {
  const init: RequestInit = { method, headers: { authorization: `Bearer ${token}` } };
  if (body !== undefined) init.body = JSON.stringify(body);
  return fetch(`http://127.0.0.1:${p.controlPort}${path}`, init);
}

function viaProxy(p: Proxy, path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: p.proxyPort, method: "GET", path, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

function connectTunnel(p: Proxy, target: string, headers: Record<string, string>): Promise<{ status: number; socket: net.Socket }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: p.proxyPort, method: "CONNECT", path: target, headers });
    req.on("connect", (res, socket) => resolve({ status: res.statusCode ?? 0, socket }));
    req.on("error", reject);
    req.end();
  });
}

// Writes one raw HTTP/1.1 request and collects everything until the other side closes.
function rawRequest(socket: net.Socket | tls.TLSSocket, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => (data += chunk));
    socket.on("end", () => resolve(data));
    socket.on("close", () => resolve(data));
    socket.on("error", reject);
    socket.write(text);
  });
}

const bodyOf = (reply: string) => JSON.parse(reply.slice(reply.indexOf("\r\n\r\n") + 4)) as { url: string; headers: Record<string, string> };

before(async () => {
  upstream = http.createServer(echoHandler);
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  upstreamPort = (upstream.address() as net.AddressInfo).port;
  proxy = await startProxy({ adminToken: "adm", host: "127.0.0.1", allowPrivateTargets: true });
  await control(proxy, "PUT", "/policies/sbx_open", { token: "tok", allowHosts: [`127.0.0.1:${upstreamPort}`] });
});

after(async () => {
  await proxy.close();
  upstream.close();
});

test("the control API needs the admin token", async () => {
  assert.equal((await control(proxy, "GET", "/health", undefined, "wrong")).status, 401);
  assert.equal((await control(proxy, "GET", "/health")).status, 200);
  assert.match(await (await control(proxy, "GET", "/ca")).text(), /BEGIN CERTIFICATE/);
});

test("plain HTTP: an allowed host is forwarded; the sandbox must authenticate to the proxy", async () => {
  const ok = await viaProxy(proxy, `http://127.0.0.1:${upstreamPort}/hello?x=1`, { "proxy-authorization": basic("sbx_open", "tok") });
  assert.equal(ok.status, 200);
  const echoed = JSON.parse(ok.body) as { url: string; headers: Record<string, string> };
  assert.equal(echoed.url, "/hello?x=1");
  assert.equal(echoed.headers.host, `127.0.0.1:${upstreamPort}`);
  assert.equal(echoed.headers["proxy-authorization"], undefined);
  assert.equal((await viaProxy(proxy, `http://127.0.0.1:${upstreamPort}/`, {})).status, 407);
  assert.equal((await viaProxy(proxy, `http://127.0.0.1:${upstreamPort}/`, { "proxy-authorization": basic("sbx_open", "wrong") })).status, 407);
  assert.equal((await viaProxy(proxy, `http://127.0.0.1:${upstreamPort}/`, { "proxy-authorization": basic("sbx_nope", "tok") })).status, 407);
});

test("a host outside the allowlist is refused and logged, for plain requests and CONNECT", async () => {
  const denied = await viaProxy(proxy, `http://127.0.0.2:${upstreamPort}/secret`, { "proxy-authorization": basic("sbx_open", "tok") });
  assert.equal(denied.status, 403);
  const tunnel = await connectTunnel(proxy, "example.org:443", { "proxy-authorization": basic("sbx_open", "tok") });
  assert.equal(tunnel.status, 403);
  tunnel.socket.destroy();
  const log = (await (await control(proxy, "GET", "/policies/sbx_open/log")).json()) as { denied: Array<{ host: string; port: number; method: string; reason: string }> };
  assert.deepEqual(
    log.denied.map(({ host, port, method, reason }) => ({ host, port, method, reason })),
    [
      { host: "127.0.0.2", port: upstreamPort, method: "GET", reason: "host not in allowHosts" },
      { host: "example.org", port: 443, method: "CONNECT", reason: "host not in allowHosts" },
    ],
  );
});

test("a bare rule allows ports 80 and 443 only; \"host:port\" allows that one port", async () => {
  await control(proxy, "PUT", "/policies/sbx_ports", { token: "tok", allowHosts: ["127.0.0.1"] });
  const refused = await viaProxy(proxy, `http://127.0.0.1:${upstreamPort}/`, { "proxy-authorization": basic("sbx_ports", "tok") });
  assert.equal(refused.status, 403);
  assert.match(refused.body, new RegExp(`port ${upstreamPort} not allowed for 127.0.0.1`));
  const log = (await (await control(proxy, "GET", "/policies/sbx_ports/log")).json()) as { denied: Array<{ reason: string }> };
  assert.deepEqual(log.denied.map((entry) => entry.reason), [`port ${upstreamPort} not allowed for 127.0.0.1`]);
  await control(proxy, "PUT", "/policies/sbx_ports", { token: "tok", allowHosts: [`127.0.0.1:${upstreamPort}`] });
  assert.equal((await viaProxy(proxy, `http://127.0.0.1:${upstreamPort}/`, { "proxy-authorization": basic("sbx_ports", "tok") })).status, 200);
});

test("a token works only from its sandbox's subnet; use from elsewhere is refused and logged", async () => {
  assert.equal(inSubnet("::ffff:172.19.0.2", "172.19.0.0/16"), true);
  assert.equal(inSubnet("172.19.255.9", "172.19.0.0/16"), true);
  assert.equal(inSubnet("172.20.0.2", "172.19.0.0/16"), false);
  assert.equal(inSubnet("fe80::1", "172.19.0.0/16"), false);
  assert.equal(inSubnet("172.19.0.2", "not a subnet"), false);
  await control(proxy, "PUT", "/policies/sbx_far", { token: "tok", subnet: "10.0.0.0/8", allowHosts: [`127.0.0.1:${upstreamPort}`] });
  assert.equal((await viaProxy(proxy, `http://127.0.0.1:${upstreamPort}/`, { "proxy-authorization": basic("sbx_far", "tok") })).status, 407);
  const log = (await (await control(proxy, "GET", "/policies/sbx_far/log")).json()) as { denied: Array<{ reason: string }> };
  assert.match(log.denied[0]?.reason ?? "", /^token used from (::ffff:)?127\.0\.0\.1, outside 10\.0\.0\.0\/8$/);
  await control(proxy, "PUT", "/policies/sbx_near", { token: "tok", subnet: "127.0.0.0/8", allowHosts: [`127.0.0.1:${upstreamPort}`] });
  assert.equal((await viaProxy(proxy, `http://127.0.0.1:${upstreamPort}/`, { "proxy-authorization": basic("sbx_near", "tok") })).status, 200);
});

test("CONNECT to an allowed host without a secret is a blind tunnel", async () => {
  const { status, socket } = await connectTunnel(proxy, `127.0.0.1:${upstreamPort}`, { "proxy-authorization": basic("sbx_open", "tok") });
  assert.equal(status, 200);
  const reply = await rawRequest(socket, `GET /tunnel HTTP/1.1\r\nHost: 127.0.0.1:${upstreamPort}\r\nAuthorization: Bearer mine\r\nConnection: close\r\n\r\n`);
  const echoed = bodyOf(reply);
  assert.equal(echoed.url, "/tunnel");
  assert.equal(echoed.headers.authorization, "Bearer mine");
});

test("loopback, private and metadata addresses are refused even when allowlisted", async () => {
  const strict = await startProxy({ adminToken: "adm", host: "127.0.0.1" });
  try {
    await control(strict, "PUT", "/policies/s", { token: "t", allowHosts: ["127.0.0.1", "169.254.169.254", "localhost", "10.0.0.1"] });
    for (const target of ["127.0.0.1:80", "169.254.169.254:80", "localhost:80", "10.0.0.1:443"]) {
      const { status, socket } = await connectTunnel(strict, target, { "proxy-authorization": basic("s", "t") });
      socket.destroy();
      assert.equal(status, 403, target);
    }
    const log = (await (await control(strict, "GET", "/policies/s/log")).json()) as { denied: Array<{ reason: string }> };
    assert.equal(log.denied.length, 4);
    assert.ok(log.denied.every((entry) => entry.reason.includes("private address")), JSON.stringify(log.denied));
  } finally {
    await strict.close();
  }
});

test("a host with a secret is intercepted: the proxy's own certificate is presented and the secret header is set", { skip: !hasOpenssl }, async () => {
  const upstreamCa = await createCa("test upstream CA");
  const leaf = await issueCert(upstreamCa, "127.0.0.1");
  const secureUpstream = https.createServer({ key: leaf.key, cert: leaf.cert }, echoHandler);
  await new Promise<void>((resolve) => secureUpstream.listen(0, "127.0.0.1", resolve));
  const securePort = (secureUpstream.address() as net.AddressInfo).port;
  const mitm = await startProxy({ adminToken: "adm", host: "127.0.0.1", allowPrivateTargets: true, upstreamCa: upstreamCa.cert });
  try {
    const viaMitm = async (policyId: string) => {
      const { status, socket } = await connectTunnel(mitm, `127.0.0.1:${securePort}`, { "proxy-authorization": basic(policyId, "t") });
      assert.equal(status, 200);
      // The client trusts only the proxy's CA, so a successful handshake proves the proxy terminated TLS.
      const secure = tls.connect({ socket, ca: [mitm.caCert], host: "127.0.0.1" });
      await new Promise<void>((resolve, reject) => {
        secure.once("secureConnect", resolve);
        secure.once("error", reject);
      });
      assert.equal(secure.authorized, true);
      return bodyOf(await rawRequest(secure, `GET /api HTTP/1.1\r\nHost: 127.0.0.1:${securePort}\r\nAuthorization: Bearer fake\r\nConnection: close\r\n\r\n`));
    };
    await control(mitm, "PUT", "/policies/s", { token: "t", allowHosts: [`127.0.0.1:${securePort}`], secrets: { "127.0.0.1": "Bearer hunter2" } });
    const bearer = await viaMitm("s");
    assert.equal(bearer.url, "/api");
    assert.equal(bearer.headers.authorization, "Bearer hunter2");
    await control(mitm, "PUT", "/policies/s2", { token: "t", allowHosts: [`127.0.0.1:${securePort}`], secrets: { "127.0.0.1": { header: "X-Api-Key", value: "hunter2" } } });
    const apiKey = await viaMitm("s2");
    assert.equal(apiKey.headers["x-api-key"], "hunter2");
    assert.equal(apiKey.headers.authorization, "Bearer fake", "a secret in another header leaves Authorization alone");
  } finally {
    await mitm.close();
    secureUpstream.close();
  }
});
