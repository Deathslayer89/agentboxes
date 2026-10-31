import assert from "node:assert/strict";
import test from "node:test";
import { ValidationError } from "../../../src/errors.js";
import { resolveWorkspaceDir, resolveWorkspacePath } from "../../../src/services/workspacePath.js";

test("relative and absolute paths inside /workspace resolve to the same absolute path", () => {
  assert.equal(resolveWorkspacePath("main.py"), "/workspace/main.py");
  assert.equal(resolveWorkspacePath("./src/../src/a.py"), "/workspace/src/a.py");
  assert.equal(resolveWorkspacePath("/workspace/out/x.txt"), "/workspace/out/x.txt");
});

test("paths that leave /workspace, or are not a file, are refused", () => {
  for (const bad of ["../etc/passwd", "a/../../etc/passwd", "/etc/passwd", "/workspace", "/workspace/", "/workspacex/a", "", "a\0b", 42, undefined]) {
    assert.throws(() => resolveWorkspacePath(bad), ValidationError, `expected ${String(bad)} to be refused`);
  }
});

test("a directory may be /workspace itself; trailing slashes are dropped; escaping is refused", () => {
  assert.equal(resolveWorkspaceDir("/workspace"), "/workspace");
  assert.equal(resolveWorkspaceDir("/workspace/"), "/workspace");
  assert.equal(resolveWorkspaceDir("app/src/"), "/workspace/app/src");
  assert.equal(resolveWorkspaceDir("."), "/workspace");
  assert.throws(() => resolveWorkspaceDir(".."), ValidationError);
  assert.throws(() => resolveWorkspaceDir("/etc"), ValidationError);
});
