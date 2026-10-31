import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { UnauthorizedError } from "../errors.js";

/**
 * One shared API key, sent as `Authorization: Bearer <key>`.
 * The comparison is constant-time so response timing does not reveal how many leading characters matched.
 */
export function bearerAuth(apiKey: string): MiddlewareHandler {
  const expected = Buffer.from(apiKey);
  return async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const [scheme, token] = header.split(" ", 2);
    const given = Buffer.from(token ?? "");
    const ok = scheme?.toLowerCase() === "bearer" && given.length === expected.length && timingSafeEqual(given, expected);
    if (!ok) throw new UnauthorizedError("missing or wrong API key");
    await next();
  };
}
