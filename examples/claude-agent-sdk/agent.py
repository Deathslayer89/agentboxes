# A Claude Agent SDK agent with one tool, run_python, that runs the model's code in an agentbox sandbox.
# Needs a running agentbox server (AGENTBOX_URL, default http://127.0.0.1:7788) and ANTHROPIC_API_KEY.
import asyncio
import os
import sys

from agentbox import Agentbox, ExecTimeout
from claude_agent_sdk import ClaudeAgentOptions, ResultMessage, create_sdk_mcp_server, query, tool

# AGENTBOX_ALLOW_HOSTS="pypi.org,files.pythonhosted.org" lets the agent pip install; unset means no network.
allow_hosts = [h.strip() for h in os.environ.get("AGENTBOX_ALLOW_HOSTS", "").split(",") if h.strip()]
client = Agentbox(os.environ.get("AGENTBOX_URL", "http://127.0.0.1:7788"), api_key=os.environ.get("AGENTBOX_API_KEY"))
# One sandbox for the whole run, so a file written by one tool call is still there for the next.
box = client.create(allow_hosts=allow_hosts or None)


def run_python(code: str) -> str:
    """Runs Python code in an isolated sandbox and returns its stdout and stderr. Files under /workspace stay for later calls."""
    box.write_file("main.py", code)
    try:
        result = box.exec(["python", "main.py"], timeout_ms=60_000)
    except ExecTimeout as killed:
        result = killed.result
    return result.stdout + result.stderr


# The SDK's custom tools are an in-process MCP server; the client call runs in a thread so it does not block the SDK's event loop.
@tool("run_python", run_python.__doc__, {"code": str})
async def run_python_tool(args):
    return {"content": [{"type": "text", "text": await asyncio.to_thread(run_python, args["code"])}]}


options = ClaudeAgentOptions(
    mcp_servers={"sandbox": create_sdk_mcp_server("sandbox", tools=[run_python_tool])},
    allowed_tools=["mcp__sandbox__run_python"],
    # No Bash, Read or Write on this machine: the sandbox is the agent's only computer.
    tools=[],
    system_prompt="You solve tasks by writing Python and running it with run_python. Always run the code rather than predicting its output, report the real output, and fix errors by editing and re-running.",
)


async def main(task: str) -> None:
    async for message in query(prompt=task, options=options):
        if isinstance(message, ResultMessage):
            print(message.result)


if __name__ == "__main__":
    task = " ".join(sys.argv[1:]) or "Compute the first ten prime numbers and print them."
    try:
        asyncio.run(main(task))
    finally:
        box.destroy()
