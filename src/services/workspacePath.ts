import { posix } from "node:path";
import { ValidationError } from "../errors.js";

export const WORKSPACE = "/workspace";

/**
 * Resolves a caller-supplied path to an absolute path under /workspace.
 * Relative paths are joined to /workspace; absolute paths must already be inside it.
 * `..` is resolved before the check, so "a/../../etc/passwd" becomes "/etc/passwd" and is refused.
 */
export function resolveWorkspacePath(input: unknown): string {
  const absolute = resolveWorkspaceDir(input);
  if (absolute === WORKSPACE) throw new ValidationError(`path must be a file under ${WORKSPACE}`);
  return absolute;
}

// Like resolveWorkspacePath, but /workspace itself is allowed. Trailing slashes are dropped.
export function resolveWorkspaceDir(input: unknown): string {
  if (typeof input !== "string" || input === "" || input.includes("\0")) {
    throw new ValidationError("path must be a non-empty string");
  }
  const absolute = posix.isAbsolute(input) ? posix.normalize(input) : posix.join(WORKSPACE, input);
  const trimmed = absolute.length > 1 && absolute.endsWith("/") ? absolute.slice(0, -1) : absolute;
  if (trimmed !== WORKSPACE && !trimmed.startsWith(WORKSPACE + "/")) {
    throw new ValidationError(`path must be under ${WORKSPACE}`);
  }
  return trimmed;
}
