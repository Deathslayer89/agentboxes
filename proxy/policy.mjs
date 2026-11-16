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

// True when an IPv4 address, plain or "::ffff:"-mapped, is inside "a.b.c.d/n". Anything else is outside.
export function inSubnet(ip, cidr) {
  const [base, bits] = cidr.split("/");
  const prefix = Number(bits);
  const address = ip.toLowerCase().startsWith("::ffff:") ? ip.slice(7) : ip;
  if (isIP(address) !== 4 || isIP(base) !== 4 || !(prefix >= 0 && prefix <= 32)) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return ((v4ToInt(address) & mask) >>> 0) === ((v4ToInt(base) & mask) >>> 0);
}

function v4ToInt(ip) {
  return ip.split(".").reduce((n, part) => ((n << 8) + Number(part)) >>> 0, 0);
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
 * For IPv6 only global unicast (2000::/3) can be public, minus the documentation block; any address
 * that carries an IPv4 one (mapped, compatible, NAT64, 6to4 or Teredo) is judged by that IPv4.
 */
export function isPublicAddress(ip) {
  const version = isIP(ip);
  if (version === 4) return isPublicV4(ip);
  if (version !== 6) return false;
  const bytes = v6Bytes(ip.toLowerCase());
  if (bytes === null) return false;
  const embedded = embeddedV4(bytes);
  if (embedded !== null) return isPublicV4(embedded);
  if ((bytes[0] & 0xe0) !== 0x20) return false; // not global unicast 2000::/3
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return false; // 2001:db8::/32 documentation
  return true;
}

// The IPv4 address an IPv6 address carries, or null when it carries none.
function embeddedV4(b) {
  const v4 = (i) => `${b[i]}.${b[i + 1]}.${b[i + 2]}.${b[i + 3]}`;
  const zero = (from, to) => b.slice(from, to).every((x) => x === 0);
  if (zero(0, 10) && ((b[10] === 0xff && b[11] === 0xff) || (b[10] === 0 && b[11] === 0))) return v4(12); // ::ffff:a.b.c.d mapped and ::a.b.c.d compatible
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zero(4, 12)) return v4(12); // 64:ff9b::/96 NAT64
  if (b[0] === 0x20 && b[1] === 0x02) return v4(2); // 2002:a.b.c.d::/16 6to4
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return `${255 - b[12]}.${255 - b[13]}.${255 - b[14]}.${255 - b[15]}`; // 2001:0000::/32 Teredo, client v4 is the last four bytes inverted
  return null;
}

// The 16 bytes of an IPv6 address, expanding one "::" and a trailing dotted-quad; null if it does not parse.
function v6Bytes(ip) {
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const toWords = (part) => {
    if (part === "") return [];
    const groups = part.split(":");
    const words = [];
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      if (g.includes(".")) {
        if (i !== groups.length - 1) return null;
        const quad = g.split(".").map(Number);
        if (quad.length !== 4 || quad.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
        words.push((quad[0] << 8) | quad[1], (quad[2] << 8) | quad[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
        words.push(parseInt(g, 16));
      }
    }
    return words;
  };
  const head = toWords(halves[0]);
  const tail = halves.length === 2 ? toWords(halves[1]) : [];
  if (head === null || tail === null) return null;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const words = [...head, ...new Array(halves.length === 2 ? missing : 0).fill(0), ...tail];
  if (words.length !== 8) return null;
  const bytes = [];
  for (const w of words) bytes.push((w >> 8) & 0xff, w & 0xff);
  return bytes;
}

function isPublicV4(ip) {
  const [a, b, c] = ip.split(".").map(Number);
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false; // this host, private, loopback, multicast and reserved
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a === 169 && b === 254) return false; // link-local, which includes the 169.254.169.254 metadata address
  if (a === 172 && b >= 16 && b <= 31) return false; // private
  if (a === 192 && b === 168) return false; // private
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // IETF protocol assignments and TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
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
