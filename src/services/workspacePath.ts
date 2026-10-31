import { posix } from "node:path";
import { ValidationError } from "../errors.js";

export const WORKSPACE = "/workspace";

// Turns a caller-supplied path into an absolute path under /workspace, or throws.
// Relative paths are taken from /workspace; absolute paths must already be inside it.
// `..` is resolved first, so "a/../../etc/passwd" ends up as "/etc/passwd" and is refused.
// This is an API contract, not a host boundary: the path is only ever used inside the
// sandbox, which has no view of the host filesystem at all.
export function resolveWorkspacePath(input: unknown): string {
  if (typeof input !== "string" || input === "" || input.includes("\0")) {
    throw new ValidationError("path must be a non-empty string");
  }
  const absolute = posix.isAbsolute(input) ? posix.normalize(input) : posix.join(WORKSPACE, input);
  if (!absolute.startsWith(WORKSPACE + "/") || absolute.endsWith("/")) {
    throw new ValidationError(`path must be a file under ${WORKSPACE}`);
  }
  return absolute;
}
