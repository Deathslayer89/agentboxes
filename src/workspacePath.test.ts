import assert from "node:assert/strict";
import test from "node:test";
import { ValidationError } from "./errors.js";
import { resolveWorkspacePath } from "./services/workspacePath.js";

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
