import { execFileSync } from "node:child_process";

// Directories the published npm package may contain, by path prefix; everything in them is code we ship.
const ALLOWED_DIRS = ["bin/", "dist/", "firecracker/", "templates/"];
// Exact files the package may contain. Full paths, so a stray docs/ file (such as docs/demo.gif) is caught here.
const ALLOWED_FILES = new Set([
  "README.md",
  "LICENSE",
  "package.json",
  "docs/api.md",
  "docs/benchmarks.md",
  "docs/development.md",
  "docs/examples.md",
  "docs/network.md",
  "docs/operations.md",
  "docs/runtimes.md",
  "docs/templates.md",
]);

const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
const files = JSON.parse(out.slice(out.indexOf("[")))[0].files.map((entry) => entry.path);
const bad = files.filter((path) => !ALLOWED_FILES.has(path) && !ALLOWED_DIRS.some((dir) => path.startsWith(dir)));
if (bad.length > 0) {
  console.error(`package would ship files outside the allowlist:\n${bad.map((path) => `  ${path}`).join("\n")}`);
  process.exit(1);
}
console.log(`package contents ok: ${files.length} files under ${[...new Set(files.map((path) => path.split("/")[0]))].sort().join(", ")}`);
