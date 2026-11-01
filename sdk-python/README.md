# agentbox (Python client)

Standard library only, Python 3.9+. Install with `pip install agentboxes` (the import is `agentbox`), or from a clone with `pip install -e sdk-python`.

```python
from agentbox import Agentbox, ExecTimeout

client = Agentbox("http://127.0.0.1:7788", api_key=None)
box = client.create(allow_hosts=["pypi.org"], ttl_seconds=300)
result = box.exec(["python", "-c", "print(2+2)"])        # ExecResult(exit_code, stdout, stderr, duration_ms, truncated)
box.write_file("main.py", "print('hello')")
print(box.read_file("main.py"))
for event in box.exec_stream(["python", "main.py"]):      # ("stdout" | "stderr", line) ... then ("exit", ExecResult)
    print(event)
box.upload_directory("./myrepo", "repo")
box.download_directory("repo", "./out")
box.extend()
box.destroy()
```

Errors: `SandboxNotFound`, `PoolExhausted`, `ExecTimeout` (with `.result`), and `AgentboxError` with `status` and `code` for everything else.
