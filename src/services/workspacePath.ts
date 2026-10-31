import { posix } from "node:path";
import { ValidationError } from "../errors.js";

export const WORKSPACE = "/workspace";

/**
 * Resolves a caller-supplied path to an absolute path under /workspace.
 * Relative paths are joined to /workspace; absolute paths must already be inside it.
 * `..` is resolved before the check, so "a/../../etc/passwd" becomes "/etc/passwd" and is refused.
 */
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
