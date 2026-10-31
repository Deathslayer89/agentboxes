import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { UnauthorizedError } from "../errors.js";
import type { ApiKey } from "../models/apiKey.js";

/**
 * Bearer auth against the configured keys; the matching key's name becomes the request's owner.
 * Every key is compared in constant time so response timing reveals neither which key nor how much of it matched.
 */
export function bearerAuth(keys: ApiKey[]): MiddlewareHandler<{ Variables: { owner: string } }> {
  const expected = keys.map((k) => ({ name: k.name, bytes: Buffer.from(k.key) }));
  return async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const [scheme, token] = header.split(" ", 2);
    const given = Buffer.from(token ?? "");
    let owner: string | undefined;
    for (const { name, bytes } of expected) {
      if (given.length === bytes.length && timingSafeEqual(given, bytes)) owner = name;
    }
    if (scheme?.toLowerCase() !== "bearer" || owner === undefined) throw new UnauthorizedError("missing or wrong API key");
    c.set("owner", owner);
    await next();
  };
}
