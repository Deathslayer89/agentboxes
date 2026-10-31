"""Drives the Python client against the HTTP app with the fake runtime, started from test/support/fakeServer.ts."""

import os
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "sdk-python"))

from agentbox import Agentbox, AgentboxError, ExecTimeout, PoolExhausted, SandboxNotFound  # noqa: E402


class ClientTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = subprocess.Popen(
            [os.path.join(ROOT, "node_modules", ".bin", "tsx"), os.path.join(ROOT, "test", "support", "fakeServer.ts")],
            cwd=ROOT,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            env={**os.environ, "FAKE_API_KEY": "k1", "MAX_SANDBOXES": "2"},
        )
        port = cls.server.stdout.readline().decode().strip()
        cls.client = Agentbox(f"http://127.0.0.1:{port}", api_key="k1")

    @classmethod
    def tearDownClass(cls):
        cls.server.stdin.close()
        cls.server.wait(timeout=10)
        cls.server.stdout.close()

    def test_lifecycle_files_stream_and_destroy(self):
        box = self.client.create(ttl_seconds=60)
        self.assertEqual(box.info["limits"]["ttlSeconds"], 60)
        result = box.exec(["python", "-c", "print(2+2)"], timeout_ms=1000, cwd="src", env={"CI": "1"})
        self.assertEqual(result.stdout, "python -c print(2+2)")  # the fake runtime echoes the command
        box.write_file("src/main.py", "print('hi')")
        self.assertEqual(box.read_file("src/main.py"), "print('hi')")
        box.write_file("bin", b"\x00\xff")
        self.assertEqual(box.read_file_bytes("/workspace/bin"), b"\x00\xff")
        events = list(box.exec_stream(["echo", "hi"]))
        self.assertEqual(events[0], ("stdout", "echo hi"))
        self.assertEqual(events[-1][0], "exit")
        self.assertEqual(events[-1][1].exit_code, 0)
        before = box.info["expiresAt"]
        box.extend(1800)
        self.assertGreater(box.info["expiresAt"], before)
        box.upload_tar(b"tar!", "incoming")
        self.assertEqual(box.download_tar("incoming"), b"tar!")
        self.assertEqual(len(self.client.list()), 1)
        box.destroy()
        self.assertEqual(box.info["status"], "destroyed")
        self.assertEqual(self.client.list(), [])
        self.assertEqual(self.client.templates()[0]["name"], "default")
        self.assertEqual(self.client.stats()["sandboxes"]["live"], 0)

    def test_directories_round_trip_through_real_tar_files(self):
        box = self.client.create()
        try:
            with tempfile.TemporaryDirectory() as src, tempfile.TemporaryDirectory() as out:
                os.makedirs(os.path.join(src, "pkg"))
                with open(os.path.join(src, "pkg", "a.txt"), "w") as f:
                    f.write("alpha")
                box.upload_directory(src, "proj")
                box.download_directory("proj", out)  # the fake runtime hands the same archive back
                with open(os.path.join(out, "pkg", "a.txt")) as f:
                    self.assertEqual(f.read(), "alpha")
        finally:
            box.destroy()

    def test_typed_errors(self):
        with self.assertRaises(SandboxNotFound):
            self.client.get("sbx_nope")
        a = self.client.create()
        b = self.client.create()
        with self.assertRaises(PoolExhausted):
            self.client.create()
        b.destroy()
        with self.assertRaises(AgentboxError) as caught:
            a.exec(["true"], timeout_ms=10**9)
        self.assertEqual(caught.exception.code, "ValidationError")
        self.assertEqual(caught.exception.status, 400)
        with self.assertRaises(AgentboxError) as caught:
            a.write_file("../x", "y")
        self.assertEqual(caught.exception.code, "ValidationError")
        a.destroy()
        with self.assertRaises(AgentboxError) as caught:
            a.exec(["true"])
        self.assertEqual(caught.exception.status, 409)
        with self.assertRaises(AgentboxError) as caught:
            Agentbox(self.client.base_url, api_key="wrong").list()
        self.assertEqual(caught.exception.status, 401)


if __name__ == "__main__":
    unittest.main()
