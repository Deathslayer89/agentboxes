"""Python client for an agentbox server. Standard library only."""

from __future__ import annotations

import io
import json
import os
import subprocess
import tarfile
from dataclasses import dataclass
from typing import Any, Dict, Iterator, List, Optional, Tuple, Union
from urllib import error, request

__all__ = ["Agentbox", "Sandbox", "ExecResult", "AgentboxError", "SandboxNotFound", "PoolExhausted", "ExecTimeout"]


class AgentboxError(Exception):
    """Any non-2xx answer from the server. `code` is the server's error name, for example ValidationError."""

    def __init__(self, message: str, status: int, code: str):
        super().__init__(message)
        self.status = status
        self.code = code


class SandboxNotFound(AgentboxError):
    pass


class PoolExhausted(AgentboxError):
    """The server's live sandbox limit, or this key's limit, is reached."""


@dataclass
class ExecResult:
    exit_code: int
    stdout: str
    stderr: str
    duration_ms: int
    timed_out: bool
    truncated: bool


class ExecTimeout(Exception):
    """The per-exec timeout killed the command. `result` holds the output collected before that."""

    def __init__(self, result: ExecResult):
        super().__init__(f"command killed after {result.duration_ms} ms")
        self.result = result


def _result(data: Dict[str, Any]) -> ExecResult:
    return ExecResult(data["exitCode"], data["stdout"], data["stderr"], data["durationMs"], data["timedOut"], data["truncated"])


class Agentbox:
    def __init__(self, base_url: str = "http://127.0.0.1:7788", api_key: Optional[str] = None, timeout: float = 600.0):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout

    def create(
        self,
        template: Optional[str] = None,
        allow_hosts: Optional[List[str]] = None,
        secrets: Optional[Dict[str, Union[str, Dict[str, str]]]] = None,
        memory_mb: Optional[int] = None,
        cpus: Optional[float] = None,
        disk_mb: Optional[int] = None,
        pids: Optional[int] = None,
        ttl_seconds: Optional[int] = None,
    ) -> "Sandbox":
        body = {
            "template": template,
            "allowHosts": allow_hosts,
            "secrets": secrets,
            "memoryMb": memory_mb,
            "cpus": cpus,
            "diskMb": disk_mb,
            "pids": pids,
            "ttlSeconds": ttl_seconds,
        }
        info = self._json("POST", "/sandboxes", {k: v for k, v in body.items() if v is not None})
        return Sandbox(self, info)

    def get(self, sandbox_id: str) -> "Sandbox":
        return Sandbox(self, self._json("GET", f"/sandboxes/{sandbox_id}"))

    def list(self, all: bool = False) -> List[Dict[str, Any]]:
        return self._json("GET", "/sandboxes?all=true" if all else "/sandboxes")

    def templates(self) -> List[Dict[str, Any]]:
        return self._json("GET", "/templates")

    def stats(self) -> Dict[str, Any]:
        return self._json("GET", "/stats")

    # Sends a request and raises a typed error for any non-2xx answer.
    def request(self, method: str, path: str, body: Optional[bytes] = None, content_type: Optional[str] = None, stream: bool = False):
        headers = {}
        if self.api_key is not None:
            headers["Authorization"] = f"Bearer {self.api_key}"
        if content_type is not None:
            headers["Content-Type"] = content_type
        req = request.Request(self.base_url + path, data=body, method=method, headers=headers)
        try:
            response = request.urlopen(req, timeout=self.timeout)
        except error.HTTPError as http_error:
            code, message = "HttpError", f"{method} {path} failed with status {http_error.code}"
            try:
                payload = json.loads(http_error.read().decode("utf-8"))
                code, message = payload.get("error", code), payload.get("message", message)
            except (ValueError, UnicodeDecodeError):
                pass
            if http_error.code == 404:
                raise SandboxNotFound(message, 404, code) from None
            if http_error.code == 429:
                raise PoolExhausted(message, 429, code) from None
            raise AgentboxError(message, http_error.code, code) from None
        if stream:
            return response
        with response:
            return response.read()

    def _json(self, method: str, path: str, body: Any = None) -> Any:
        raw = self.request(method, path, None if body is None else json.dumps(body).encode("utf-8"), "application/json")
        return json.loads(raw.decode("utf-8")) if raw else None


Event = Union[Tuple[str, str], Tuple[str, ExecResult]]


class Sandbox:
    def __init__(self, client: Agentbox, info: Dict[str, Any]):
        self.client = client
        self.info = info

    @property
    def id(self) -> str:
        return self.info["id"]

    def _exec_body(self, cmd: List[str], timeout_ms: Optional[int], cwd: Optional[str], env: Optional[Dict[str, str]]) -> Dict[str, Any]:
        body: Dict[str, Any] = {"cmd": cmd}
        if timeout_ms is not None:
            body["timeoutMs"] = timeout_ms
        if cwd is not None:
            body["cwd"] = cwd
        if env is not None:
            body["env"] = env
        return body

    # Runs a command and waits for it. Raises ExecTimeout when the server killed it at the deadline.
    def exec(self, cmd: List[str], timeout_ms: Optional[int] = None, cwd: Optional[str] = None, env: Optional[Dict[str, str]] = None) -> ExecResult:
        result = _result(self.client._json("POST", f"/sandboxes/{self.id}/exec", self._exec_body(cmd, timeout_ms, cwd, env)))
        if result.timed_out:
            raise ExecTimeout(result)
        return result

    # Yields ("stdout" | "stderr", line) as the command runs, then ("exit", ExecResult) with empty output fields.
    def exec_stream(self, cmd: List[str], timeout_ms: Optional[int] = None, cwd: Optional[str] = None, env: Optional[Dict[str, str]] = None) -> Iterator[Event]:
        body = json.dumps(self._exec_body(cmd, timeout_ms, cwd, env)).encode("utf-8")
        response = self.client.request("POST", f"/sandboxes/{self.id}/exec/stream", body, "application/json", stream=True)
        pending = {"stdout": "", "stderr": ""}
        with response:
            for event, data in _sse(response):
                if event in pending:
                    pending[event] += data
                    while "\n" in pending[event]:
                        line, pending[event] = pending[event].split("\n", 1)
                        yield (event, line + "\n")
                elif event == "exit":
                    for name in ("stdout", "stderr"):
                        if pending[name]:
                            yield (name, pending[name])
                    yield ("exit", ExecResult(data["exitCode"], "", "", data["durationMs"], data["timedOut"], data["truncated"]))
                elif event == "error":
                    raise AgentboxError(data["message"], 0, data["error"])

    def write_file(self, path: str, content: Union[str, bytes]) -> None:
        data = content.encode("utf-8") if isinstance(content, str) else content
        self.client.request("PUT", f"/sandboxes/{self.id}/files?path={request.quote(path, safe='')}", data, "application/octet-stream")

    def read_file(self, path: str) -> str:
        return self.read_file_bytes(path).decode("utf-8")

    def read_file_bytes(self, path: str) -> bytes:
        return self.client.request("GET", f"/sandboxes/{self.id}/files?path={request.quote(path, safe='')}")

    def upload_tar(self, tar: bytes, directory: str = "/workspace") -> None:
        self.client.request("PUT", f"/sandboxes/{self.id}/archive?path={request.quote(directory, safe='')}", tar, "application/x-tar")

    def download_tar(self, directory: str = "/workspace") -> bytes:
        return self.client.request("GET", f"/sandboxes/{self.id}/archive?path={request.quote(directory, safe='')}")

    # Sends a local directory's contents into the sandbox.
    def upload_directory(self, local_dir: str, directory: str = "/workspace") -> None:
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w") as archive:
            for name in sorted(os.listdir(local_dir)):
                archive.add(os.path.join(local_dir, name), arcname=name)
        self.upload_tar(buffer.getvalue(), directory)

    # Writes a sandbox directory's contents into a local directory, refusing members that would leave it.
    def download_directory(self, directory: str, local_dir: str) -> None:
        with tarfile.open(fileobj=io.BytesIO(self.download_tar(directory)), mode="r") as archive:
            for member in archive.getmembers():
                if member.name.startswith("/") or ".." in member.name.split("/"):
                    raise AgentboxError(f"archive from the sandbox has an unsafe path: {member.name}", 0, "UnsafeArchive")
            archive.extractall(local_dir)

    def egress_log(self) -> Dict[str, Any]:
        return self.client._json("GET", f"/sandboxes/{self.id}/egress-log")

    def extend(self, ttl_seconds: Optional[int] = None) -> Dict[str, Any]:
        self.info = self.client._json("POST", f"/sandboxes/{self.id}/extend", {} if ttl_seconds is None else {"ttlSeconds": ttl_seconds})
        return self.info

    def refresh(self) -> Dict[str, Any]:
        self.info = self.client._json("GET", f"/sandboxes/{self.id}")
        return self.info

    def destroy(self) -> None:
        self.info = self.client._json("DELETE", f"/sandboxes/{self.id}")


# Parses a Server-Sent Events body into (event, data) pairs, with data JSON-decoded.
def _sse(response) -> Iterator[Tuple[str, Any]]:
    event, data = None, None
    for raw in response:
        line = raw.decode("utf-8").rstrip("\n")
        if line.startswith("event: "):
            event = line[7:]
        elif line.startswith("data: "):
            data = line[6:]
        elif line == "" and event is not None and data is not None:
            yield event, json.loads(data)
            event, data = None, None
