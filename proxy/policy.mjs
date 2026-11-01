import { isIP } from "node:net";

/**
 * Rules are "host" or "host:port". A bare host allows ports 80 and 443; "*.example.com" matches
 * any subdomain but not example.com itself. Returns the reason for refusal, or undefined when allowed.
 */
export function refusalFor(host, port, allowHosts) {
  const name = host.toLowerCase();
  let nameMatched = false;
  for (const rule of allowHosts) {
    const { host: pattern, port: rulePort } = splitRule(rule.toLowerCase());
    const matches = pattern.startsWith("*.") ? name.endsWith(pattern.slice(1)) && name.length > pattern.length - 1 : name === pattern;
    if (!matches) continue;
    nameMatched = true;
    if (rulePort === undefined ? port === 80 || port === 443 : port === rulePort) return undefined;
  }
  return nameMatched ? `port ${port} not allowed for ${host}` : "host not in allowHosts";
}

// "host:port" -> { host, port }; a bare host or an IPv6 literal has no port.
function splitRule(rule) {
  const match = /^(.+):(\d{1,5})$/.exec(rule);
  if (match === null || isIP(rule) === 6) return { host: rule, port: undefined };
  return { host: match[1], port: Number(match[2]) };
}

/**
 * Loopback, link-local (cloud metadata lives at 169.254.169.254), private, carrier-grade NAT,
 * multicast and reserved ranges are never reachable through the proxy, whatever the allowlist says.
 */
export function isPublicAddress(ip) {
  const version = isIP(ip);
  if (version === 4) return isPublicV4(ip);
  if (version !== 6) return false;
  const lower = ip.toLowerCase();
  if (lower.startsWith("::ffff:")) return isPublicV4(lower.slice(7));
  if (lower === "::1" || lower === "::") return false;
  const first = parseInt(lower.split(":")[0] || "0", 16);
  const uniqueLocal = (first & 0xfe00) === 0xfc00;
  const linkLocal = (first & 0xffc0) === 0xfe80;
  const multicast = (first & 0xff00) === 0xff00;
  return !(uniqueLocal || linkLocal || multicast);
}

function isPublicV4(ip) {
  const [a, b] = ip.split(".").map(Number);
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  return true;
}

// `Proxy-Authorization: Basic base64(sandboxId:token)` -> { id, token }, or undefined.
export function parseProxyAuth(header) {
  if (typeof header !== "string") return undefined;
  const [scheme, encoded] = header.split(" ");
  if (scheme?.toLowerCase() !== "basic" || !encoded) return undefined;
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon <= 0) return undefined;
  return { id: decoded.slice(0, colon), token: decoded.slice(colon + 1) };
}

// "host:port" or "[v6]:port" -> { host, port }. Port is undefined when absent.
export function splitHostPort(target) {
  const match = /^\[?([^\]]+?)\]?(?::(\d+))?$/.exec(target);
  if (!match) return { host: target, port: undefined };
  return { host: match[1], port: match[2] === undefined ? undefined : Number(match[2]) };
}
