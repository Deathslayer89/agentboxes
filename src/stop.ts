import { existsSync, readFileSync } from "node:fs";
import { LEGACY_DB_PATH, looksLikeAgentbox, pickDbPath, pidPathFor } from "./config.js";

const db = pickDbPath(process.env, existsSync(LEGACY_DB_PATH));
const pidFile = pidPathFor(db.path);

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// The command line of a running process, or undefined when it cannot be read (not Linux, or the process is gone).
const cmdlineOf = (pid: number): string | undefined => {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
  } catch {
    return undefined;
  }
};

let pid: number;
try {
  pid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
} catch {
  console.error(`no pid file at ${pidFile}; the server does not look like it is running`);
  process.exit(1);
}
if (!Number.isInteger(pid) || pid <= 0) {
  console.error(`the pid file ${pidFile} does not hold a valid pid`);
  process.exit(1);
}
if (!alive(pid)) {
  console.error(`pid ${pid} from ${pidFile} is not running; the server has already stopped (delete the pid file if it lingers)`);
  process.exit(1);
}
const cmdline = cmdlineOf(pid);
if (cmdline !== undefined && !looksLikeAgentbox(cmdline)) {
  console.error(`pid ${pid} from ${pidFile} is not an agentbox server; refusing to signal it`);
  process.exit(1);
}

try {
  process.kill(pid, "SIGTERM");
} catch {
  console.error(`could not signal pid ${pid}`);
  process.exit(1);
}
const deadline = Date.now() + 10_000;
while (alive(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200));
if (alive(pid)) {
  console.error(`agentbox (pid ${pid}) did not stop within 10 s; it may still be shutting down`);
  process.exit(1);
}
console.log(`stopped agentbox (pid ${pid})`);
