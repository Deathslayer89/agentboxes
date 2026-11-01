// Compiles the server, the SDK and the MCP server to dist/, then copies the files the code reads at runtime.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
execFileSync(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.build.json"], { stdio: "inherit" });
// The proxy image is built from these files; the server finds them two directories above its own.
cpSync("proxy", "dist/proxy", { recursive: true });
mkdirSync("dist/src/http", { recursive: true });
cpSync("src/http/status.html", "dist/src/http/status.html");
console.log("built dist/");
