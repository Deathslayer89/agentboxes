# A LangGraph agent (LangChain's create_agent) with one tool, run_python, that runs the model's code in an agentbox sandbox.
# Needs a running agentbox server (AGENTBOX_URL, default http://127.0.0.1:7788) and ANTHROPIC_API_KEY.
import os
import sys

from agentbox import Agentbox, ExecTimeout
from langchain.agents import create_agent

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


# create_agent turns a plain function into a tool: the type hints are the schema and the docstring is the description.
agent = create_agent(
    model="anthropic:claude-opus-5-5",
    tools=[run_python],
    system_prompt="You solve tasks by writing Python and running it with run_python. Always run the code rather than predicting its output, report the real output, and fix errors by editing and re-running.",
)

if __name__ == "__main__":
    task = " ".join(sys.argv[1:]) or "Compute the first ten prime numbers and print them."
    try:
        print(agent.invoke({"messages": [{"role": "user", "content": task}]})["messages"][-1].text)
    finally:
        box.destroy()
