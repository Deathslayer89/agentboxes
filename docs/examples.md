# Examples

The same sandbox tool in three Python frameworks, a complete coding agent on the Anthropic SDK, and a Mastra agent with one tool.

## Claude Agent SDK, OpenAI Agents SDK and LangGraph

`examples/claude-agent-sdk/agent.py`, `examples/openai-agents/agent.py` and `examples/langgraph/agent.py` are the same agent three times: one sandbox for the run, one tool `run_python` that writes the model's code to `main.py` in it and runs it with a 60 s limit, and the framework's own loop around it. Each file has a `requirements.txt` with the framework and the `agentboxes` client. The frameworks differ only in how they take the function: LangGraph's `create_agent` and the OpenAI SDK's `function_tool` read the type hints and the docstring; the Claude Agent SDK takes an in-process MCP tool, so the example wraps the function in `@tool` and runs it in a thread. The Claude example also passes `tools=[]` so the agent has no Bash, Read or Write on the host: the sandbox is its only computer.

```bash
pip install -r examples/openai-agents/requirements.txt
OPENAI_API_KEY=... python examples/openai-agents/agent.py "Compute the first ten prime numbers and print them."
AGENTBOX_ALLOW_HOSTS=pypi.org,files.pythonhosted.org ANTHROPIC_API_KEY=... python examples/langgraph/agent.py "Use numpy to invert a 3x3 matrix"
```

`npm run test:examples` (`examples/test_python_examples.py`) loads each example against a running server with placeholder keys, calls `run_python` with a print and with a division by zero, checks the agent object and the Claude tool's MCP result, and destroys the sandbox; CI runs it after the integration tests. The model's turn is not run in CI because it needs a real key.

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
