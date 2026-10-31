import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ConflictError, DomainError, LimitExceededError, NotFoundError, UnauthorizedError, ValidationError } from "../errors.js";
import type { Sandbox } from "../models/sandbox.js";
import type { SandboxService } from "../services/sandboxService.js";
import { bearerAuth } from "./auth.js";
import { parseCreateRequest, parseExecRequest } from "./validation.js";

// The public shape of a sandbox: everything except runtime bookkeeping.
function view(sandbox: Sandbox) {
  const { id, status, limits, createdAt, expiresAt } = sandbox;
  return { id, status, limits, createdAt, expiresAt };
}

// Maps the error classes the service throws to HTTP status codes.
function statusFor(err: DomainError): ContentfulStatusCode {
  if (err instanceof ValidationError) return 400;
  if (err instanceof UnauthorizedError) return 401;
  if (err instanceof NotFoundError) return 404;
  if (err instanceof ConflictError) return 409;
  if (err instanceof LimitExceededError) return 429;
  return 500;
}

// Reads the JSON body; an empty body means "all defaults".
async function jsonBody(c: Context): Promise<unknown> {
  const text = await c.req.text();
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ValidationError("body must be valid JSON");
  }
}

export interface AppOptions {
  // When set, every route except /health needs `Authorization: Bearer <apiKey>`.
  apiKey?: string;
}

export function createApp(service: SandboxService, options: AppOptions = {}): Hono {
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof DomainError) return c.json({ error: err.name, message: err.message }, statusFor(err));
    console.error(err);
    return c.json({ error: "InternalError", message: "unexpected server error" }, 500);
  });

  // Open so load balancers and uptime checks can probe without the key.
  app.get("/health", (c) => c.json({ ok: true }));

  if (options.apiKey !== undefined) app.use("/sandboxes/*", bearerAuth(options.apiKey));

  app.post("/sandboxes", async (c) => {
    const sandbox = await service.create(parseCreateRequest(await jsonBody(c)));
    return c.json(view(sandbox), 201);
  });

  app.get("/sandboxes", (c) => c.json(service.list().map(view)));

  app.get("/sandboxes/:id", (c) => c.json(view(service.get(c.req.param("id")))));

  app.post("/sandboxes/:id/exec", async (c) => {
    const result = await service.exec(c.req.param("id"), parseExecRequest(await jsonBody(c)));
    return c.json(result);
  });

  app.delete("/sandboxes/:id", async (c) => c.json(view(await service.destroy(c.req.param("id")))));

  // F7: raw bytes in and out, the path in the query string so the body stays unencoded.
  app.put("/sandboxes/:id/files", async (c) => {
    const data = Buffer.from(await c.req.arrayBuffer());
    const path = await service.writeFile(c.req.param("id"), c.req.query("path"), data);
    return c.json({ path, bytes: data.length });
  });

  app.get("/sandboxes/:id/files", async (c) => {
    const data = await service.readFile(c.req.param("id"), c.req.query("path"));
    // Hono wants a plain Uint8Array; a Node Buffer does not satisfy its type.
    return c.body(new Uint8Array(data), 200, { "content-type": "application/octet-stream" });
  });

  return app;
}
