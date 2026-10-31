import { timingSafeEqual } from "node:crypto";
import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { createCa, issueCert } from "./certs.mjs";
import { hostAllowed, isPublicAddress, parseProxyAuth, splitHostPort } from "./policy.mjs";

// Denied attempts kept per sandbox; older entries are dropped.
const MAX_DENIED = 1000;

/**
 * The egress proxy. Sandboxes reach it as an HTTP proxy (absolute-URL requests and CONNECT)
 * and must send `Proxy-Authorization: Basic sandboxId:token`. The agentbox server manages
 * per-sandbox policies through the control port with a bearer admin token.
 *
 * A host with a secret is intercepted: the proxy terminates TLS with a certificate from its
 * own CA, replaces the Authorization header, and opens its own TLS connection upstream.
 * Every other allowed host is a plain tunnel the proxy cannot read.
 *
 * Options beyond adminToken exist for tests; main.mjs reads production values from the environment.
 */
export async function startProxy({ adminToken, host = "0.0.0.0", proxyPort = 0, controlPort = 0, allowPrivateTargets = false, upstreamCa = undefined }) {
  // sandboxId -> { token, allowHosts, secrets, denied }
  const policies = new Map();
  const ca = await createCa();
  // host -> Promise<{ key, cert }>, so two concurrent requests for one host share one certificate
  const leafs = new Map();

  function leafFor(target) {
    let pending = leafs.get(target);
    if (pending === undefined) {
      pending = issueCert(ca, target);
      leafs.set(target, pending);
    }
    return pending;
  }

  function authenticate(req) {
    const auth = parseProxyAuth(req.headers["proxy-authorization"]);
    const policy = auth === undefined ? undefined : policies.get(auth.id);
    if (policy === undefined || !sameString(policy.token, auth.token)) return undefined;
    return policy;
  }

  // Allowlist first, then the resolved address, so an allowed name cannot point at a private network.
  async function decide(policy, target) {
    if (!hostAllowed(target, policy.allowHosts)) return { ok: false, reason: "host not in allowHosts" };
    let address = target;
    if (!net.isIP(target)) {
      try {
        address = (await dns.lookup(target)).address;
      } catch {
        return { ok: false, reason: "dns lookup failed" };
      }
    }
    if (!allowPrivateTargets && !isPublicAddress(address)) return { ok: false, reason: `resolves to a private address (${address})` };
    return { ok: true, address };
  }

  function recordDenied(policy, entry) {
    policy.denied.push({ at: new Date().toISOString(), ...entry });
    if (policy.denied.length > MAX_DENIED) policy.denied.shift();
  }

  // Sends the sandbox's request upstream, to the already resolved address, with the secret header if any.
  function forward(req, res, { protocol, target, port, address, path, secret }) {
    const defaultPort = protocol === "https:" ? 443 : 80;
    const headers = { ...req.headers, host: port === defaultPort ? target : `${target}:${port}` };
    delete headers["proxy-authorization"];
    delete headers["proxy-connection"];
    if (secret !== undefined) headers.authorization = secret;
    const options = { host: address, port, method: req.method, path, headers, servername: net.isIP(target) ? "" : target };
    if (upstreamCa !== undefined) options.ca = upstreamCa;
    const upstream = (protocol === "https:" ? https : http).request(options, (response) => {
      res.writeHead(response.statusCode, response.headers);
      response.pipe(res);
    });
    upstream.on("error", (err) => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end(`agentbox egress proxy: upstream error: ${err.message}\n`);
    });
    req.pipe(upstream);
  }

  // Requests arriving inside an intercepted TLS session; the socket carries the target it was opened for.
  const intercepted = http.createServer((req, res) => {
    const { target, port, address, secret } = req.socket.agentbox;
    forward(req, res, { protocol: "https:", target, port, address, path: req.url, secret });
  });

  async function intercept(socket, head, context) {
    const { key, cert } = await leafFor(context.target);
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0) socket.unshift(head);
    const secure = new tls.TLSSocket(socket, { isServer: true, key, cert });
    secure.agentbox = context;
    secure.on("error", () => {});
    intercepted.emit("connection", secure);
  }

  const proxy = http.createServer();

  proxy.on("request", async (req, res) => {
    let url;
    try {
      url = new URL(req.url);
    } catch {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("agentbox egress proxy: send an absolute URL or use CONNECT\n");
      return;
    }
    const policy = authenticate(req);
    if (policy === undefined) {
      res.writeHead(407, { "proxy-authenticate": 'Basic realm="agentbox"' });
      res.end();
      return;
    }
    const target = url.hostname;
    const port = Number(url.port || 80);
    const verdict = await decide(policy, target);
    if (!verdict.ok) {
      recordDenied(policy, { method: req.method, host: target, port, reason: verdict.reason });
      res.writeHead(403, { "content-type": "text/plain" });
      res.end(`agentbox egress proxy: ${verdict.reason}\n`);
      return;
    }
    forward(req, res, { protocol: "http:", target, port, address: verdict.address, path: url.pathname + url.search, secret: policy.secrets[target.toLowerCase()] });
  });

  proxy.on("connect", async (req, socket, head) => {
    socket.on("error", () => {});
    const { host: target, port = 443 } = splitHostPort(req.url);
    const policy = authenticate(req);
    if (policy === undefined) {
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="agentbox"\r\n\r\n');
      return;
    }
    const verdict = await decide(policy, target);
    if (!verdict.ok) {
      recordDenied(policy, { method: "CONNECT", host: target, port, reason: verdict.reason });
      socket.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\nagentbox egress proxy: ${verdict.reason}\n`);
      return;
    }
    const secret = policy.secrets[target.toLowerCase()];
    if (secret !== undefined) {
      await intercept(socket, head, { target, port, address: verdict.address, secret });
      return;
    }
    const upstream = net.connect(port, verdict.address, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.on("error", () => socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"));
    socket.on("close", () => upstream.destroy());
    upstream.on("close", () => socket.destroy());
  });

  const control = http.createServer(async (req, res) => {
    const json = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (!sameString(req.headers.authorization ?? "", `Bearer ${adminToken}`)) return json(401, { error: "bad admin token" });
    const url = new URL(req.url, "http://control");
    const [resource, id, action] = url.pathname.split("/").filter((part) => part !== "");
    if (req.method === "GET" && resource === "health") return json(200, { ok: true, policies: policies.size });
    if (req.method === "GET" && resource === "ca") {
      res.writeHead(200, { "content-type": "application/x-pem-file" });
      return res.end(ca.cert);
    }
    if (resource === "policies" && id !== undefined) {
      if (req.method === "PUT" && action === undefined) {
        const body = JSON.parse(await readBody(req));
        policies.set(id, { token: body.token, allowHosts: body.allowHosts ?? [], secrets: lowercaseKeys(body.secrets ?? {}), denied: [] });
        return json(200, { ok: true });
      }
      if (req.method === "DELETE" && action === undefined) {
        policies.delete(id);
        return json(200, { ok: true });
      }
      if (req.method === "GET" && action === "log") {
        const policy = policies.get(id);
        return policy === undefined ? json(404, { error: "no such policy" }) : json(200, { denied: policy.denied });
      }
    }
    return json(404, { error: "not found" });
  });

  await listen(proxy, proxyPort, host);
  await listen(control, controlPort, host);
  return {
    proxyPort: proxy.address().port,
    controlPort: control.address().port,
    caCert: ca.cert,
    close: () => Promise.all([closeServer(proxy), closeServer(control), closeServer(intercepted)]),
  };
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
    if (!server.listening) resolve();
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function lowercaseKeys(object) {
  return Object.fromEntries(Object.entries(object).map(([key, value]) => [key.toLowerCase(), value]));
}

function sameString(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}
