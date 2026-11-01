# Examples

A complete coding agent on the Anthropic SDK, and a Mastra agent with one tool.

## Coding agent example

`examples/coding-agent/agent.ts` is a complete coding agent in one file, on the Anthropic SDK's tool runner: it copies a repository into a sandbox, gives Claude four tools (`run_command`, `read_file`, `write_file`, `edit_file`), lets it work until it is done, and downloads the result next to your repository with a diff. Own package so the Anthropic SDK stays out of the main install:

```bash
cd examples/coding-agent && npm install
ANTHROPIC_API_KEY=... AGENTBOX_TEMPLATE=node AGENTBOX_ALLOW_HOSTS=registry.npmjs.org npm start -- ../../some-repo "Fix the failing test in src/parser.test.ts"
```

The model is Claude Opus 5.5 with a server-side refusal fallback. The sandbox is destroyed when the run ends; the output tree is left at `<repo>.agent-out`. To turn this into a Slack bot or an issue-to-PR worker, keep `makeTools` and `runTask` and change where the task comes from and where the result goes.

## Mastra example

`examples/mastra/agent.ts` is a Mastra agent with one tool, `run_python`, that writes the model's code into a sandbox and runs it. The sandbox is created on the first call and reused, so files persist between tool calls. It has its own `package.json` so Mastra does not land in the main install:

```bash
cd examples/mastra && npm install
ANTHROPIC_API_KEY=... npm start "Compute the first ten prime numbers and print them."
AGENTBOX_ALLOW_HOSTS=pypi.org,files.pythonhosted.org npm start "Use numpy to invert a 3x3 matrix"   # lets the agent pip install
```
