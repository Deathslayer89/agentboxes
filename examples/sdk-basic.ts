// Runs against a local agentbox server. Prints how long each step took.
import { Agentbox } from "../sdk/src/index.js";

const agentbox = new Agentbox({ baseUrl: process.env.AGENTBOX_URL ?? "http://127.0.0.1:7788", ...(process.env.AGENTBOX_API_KEY ? { apiKey: process.env.AGENTBOX_API_KEY } : {}) });
let last = performance.now();
const lap = (label: string) => {
  const now = performance.now();
  console.log(`${label.padEnd(12)} ${(now - last).toFixed(0).padStart(5)} ms`);
  last = now;
};

const box = await agentbox.create();
lap(`create (${box.info.startup.source})`);

const r = await box.exec(["python", "-c", "print(2+2)"]);
console.log(`stdout: ${r.stdout.trim()}`);
lap("exec");

await box.writeFile("main.py", "import time\nfor i in range(3):\n    print('line', i)\n    time.sleep(0.2)\n");
lap("writeFile");

for await (const event of box.execStream(["python", "main.py"])) {
  if (event.type === "exit") console.log(`exit ${event.exitCode} after ${event.durationMs} ms`);
  else process.stdout.write(`${event.type}: ${event.text}`);
}
lap("execStream");

await box.destroy();
lap("destroy");
