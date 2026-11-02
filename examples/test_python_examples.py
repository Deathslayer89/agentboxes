"""Loads each Python example against a live agentbox server (AGENTBOX_URL) and calls its run_python tool. No model is called."""

import asyncio
import importlib.util
import os
import pathlib
import unittest

HERE = pathlib.Path(__file__).parent
# The frameworks read their keys when the agent is built, so the examples must import without a real one.
os.environ.setdefault("ANTHROPIC_API_KEY", "not-used")
os.environ.setdefault("OPENAI_API_KEY", "not-used")


def load(name: str):
    spec = importlib.util.spec_from_file_location("example_" + name.replace("-", "_"), HERE / name / "agent.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class PythonExamples(unittest.TestCase):
    def check(self, name: str, extra):
        module = load(name)
        try:
            self.assertEqual(module.run_python("print(2 + 2)"), "4\n")
            self.assertIn("ZeroDivisionError", module.run_python("1 / 0"))
            extra(module)
        finally:
            module.box.destroy()

    def test_openai_agents(self):
        self.check("openai-agents", lambda m: self.assertEqual([t.name for t in m.agent.tools], ["run_python"]))

    def test_langgraph(self):
        self.check("langgraph", lambda m: self.assertIn("tools", m.agent.nodes))

    def test_claude_agent_sdk(self):
        def handler(m):
            self.assertEqual(m.options.allowed_tools, ["mcp__sandbox__run_python"])
            result = asyncio.run(m.run_python_tool.handler({"code": "print('from the sdk tool')"}))
            self.assertEqual(result, {"content": [{"type": "text", "text": "from the sdk tool\n"}]})

        self.check("claude-agent-sdk", handler)


if __name__ == "__main__":
    unittest.main()
