#!/usr/bin/env python3
"""Bounded JSON bridge between Noema's memory workflow and Hy Memory.

The input and output are one JSON object each.  Conversation text is never
written to a diagnostic log; Hy Memory owns its local index under Noema's
private data directory.  This process is short lived so an unavailable model
provider cannot hold the editor or the research host open.
"""

from __future__ import annotations

import hashlib
import asyncio
import json
import os
import select
import shutil
import stat
import subprocess
import sys
import tempfile
from contextlib import contextmanager
from pathlib import Path


CONFIG_FILE = Path(os.environ.get("NOEMA_HY_MEMORY_CONFIG", "~/.config/noema/hy-memory.env")).expanduser()
DATA_DIR = Path(os.environ.get("NOEMA_HY_MEMORY_DATA_DIR", "~/.local/share/noema/hy-memory")).expanduser()
PI_GATEWAY = Path(__file__).with_name("noema-pi-memory-gateway.mjs")
PI_AGENT_DIR = Path(__file__).resolve().parents[3] / "var/noema/pi"
MAX_INPUT = 65536


def load_config() -> bool:
    if CONFIG_FILE.exists():
        mode = stat.S_IMODE(CONFIG_FILE.stat().st_mode)
        if mode & 0o077:
            raise ValueError("memory configuration must be readable only by its owner")
        for line in CONFIG_FILE.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            key, separator, value = line.partition("=")
            if separator and key.startswith(("MEMORY_", "OPENAI_")):
                os.environ[key] = value.strip().strip('"\'')
    os.environ["MEMORY_DATA_DIR"] = str(DATA_DIR)
    os.environ.setdefault("MEMORY_MODE", "pro")
    # The bridge's stdout is a single JSON reply.  Keep SDK diagnostics private
    # and avoid recording LLM prompts or responses in pipeline traces.
    os.environ["MEMORY_LOG_LEVEL"] = "CRITICAL"
    os.environ["MEMORY_LOG_LLM_CONTENT"] = "false"
    os.environ["MEMORY_PIPELINE_TRACE_ENABLED"] = "false"
    backend = os.environ.get("MEMORY_LLM_BACKEND", "noema-pi")
    embed_key = os.environ.get("MEMORY_EMBEDDER_API_KEY")
    embed_url = os.environ.get("MEMORY_EMBEDDER_BASE_URL")
    embed_model = os.environ.get("MEMORY_EMBEDDER_MODEL")
    pi_ready = (backend == "noema-pi" and PI_GATEWAY.is_file()
                and shutil.which("node") and shutil.which("pi-acp")
                and (PI_AGENT_DIR / "models.json").is_file())
    return bool(pi_ready and embed_key and embed_url and embed_model)


@contextmanager
def pi_gateway():
    """Start Noema Pi's Codex model adapter only for this memory operation."""
    env = os.environ.copy()
    env.setdefault("NOEMA_PI_AGENT_DIR", str(PI_AGENT_DIR))
    env["NOEMA_HY_MEMORY_PI_MODEL"] = env.get("MEMORY_LLM_MODEL", "gpt-5.6-luna")
    if "NODE_EXTRA_CA_CERTS" not in env and Path("/etc/ssl/cert.pem").is_file():
        env["NODE_EXTRA_CA_CERTS"] = "/etc/ssl/cert.pem"
    process = subprocess.Popen(
        [shutil.which("node"), str(PI_GATEWAY)],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL, text=True, env=env,
    )
    try:
        ready, _, _ = select.select([process.stdout], [], [], 10)
        if not ready:
            raise RuntimeError("Noema Pi memory gateway did not start")
        port = json.loads(process.stdout.readline()).get("port")
        if not isinstance(port, int) or not 0 < port < 65536:
            raise RuntimeError("Noema Pi memory gateway has no port")
        os.environ["MEMORY_LLM_BASE_URL"] = f"http://127.0.0.1:{port}/v1"
        os.environ["MEMORY_LLM_API_KEY"] = "noema-pi-loopback"
        os.environ.setdefault("MEMORY_LLM_MODEL", "gpt-5.6-luna")
        os.environ["MEMORY_LLM_OMIT_TEMPERATURE"] = "true"
        yield
    finally:
        process.terminate()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


def project_user(root: str) -> str:
    if not root or not os.path.isabs(root):
        raise ValueError("absolute project root required")
    canonical = os.path.realpath(root)
    return "noema-project-" + hashlib.sha256(canonical.encode()).hexdigest()[:24]


def bounded(value: object, limit: int) -> str:
    return str(value or "").strip()[:limit]


def curl_transport_factory(embed_url: str):
    """Use macOS curl for the private NAS endpoint; keep loopback on httpx.

    On this Mac, curl reaches ZeroTier while Python's direct socket sometimes
    reports EHOSTUNREACH.  The token and request body stay in temporary 0600
    files instead of appearing in a curl process argument or diagnostic log.
    """
    import httpx

    class Transport(httpx.AsyncBaseTransport):
        def __init__(self):
            self.local = httpx.AsyncHTTPTransport()

        async def handle_async_request(self, request):
            if not str(request.url).startswith(embed_url.rstrip("/") + "/"):
                return await self.local.handle_async_request(request)
            authorization = request.headers.get("authorization", "")
            if not authorization.startswith("Bearer ") or any(
                char in authorization for char in '\r\n"\\'
            ):
                raise httpx.ConnectError("embedding authorization unavailable", request=request)
            payload = await request.aread()
            with tempfile.TemporaryDirectory(prefix="noema-memory-curl-") as directory:
                config = Path(directory) / "curl.conf"
                body = Path(directory) / "body.json"
                config.write_text(
                    f'header = "Authorization: {authorization}"\n'
                    'header = "Content-Type: application/json"\n', encoding="utf-8")
                body.write_bytes(payload)
                config.chmod(0o600)
                body.chmod(0o600)
                process = await asyncio.create_subprocess_exec(
                    shutil.which("curl") or "/usr/bin/curl", "--config", str(config),
                    "--silent", "--show-error", "--max-time", "8",
                    "--request", request.method, "--data-binary", "@" + str(body),
                    "--write-out", "\n%{http_code}", str(request.url),
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
                )
                output, _ = await process.communicate()
            response_body, separator, status = output.rpartition(b"\n")
            if process.returncode or not separator or not status.isdigit() or len(response_body) > 16_000_000:
                raise httpx.ConnectError("embedding service unavailable", request=request)
            return httpx.Response(int(status), content=response_body,
                                  headers={"content-type": "application/json"}, request=request)

        async def aclose(self):
            await self.local.aclose()

    return Transport()


def search(client, request: dict, user_id: str) -> dict:
    query = bounded(request.get("query"), 8192)
    if not query:
        return {"items": []}
    result = client.search(
        query, user_ids=[user_id], agent_ids=["shared"], scene="chat",
        limit=5, min_score=0.4, intention_limit=0,
    )
    channels = result.get("memories")
    if not isinstance(channels, dict):
        raise ValueError("unexpected Hy Memory search response")
    items = []
    total = 0
    for channel in ("normal", "profile", "schema"):
        for entry in channels.get(channel, []):
            if not isinstance(entry, dict):
                continue
            content = bounded(entry.get("content"), 1400)
            if not content or total + len(content) > 3600:
                continue
            items.append({"content": content, "id": bounded(entry.get("memory_id"), 128)})
            total += len(content)
            if len(items) >= 4:
                return {"items": items}
    return {"items": items}


def remember(client, request: dict, user_id: str) -> dict:
    prompt = bounded(request.get("prompt"), 12000)
    answer = bounded(request.get("answer"), 16000)
    if not prompt or not answer:
        return {"stored": False}
    session = bounded(request.get("session"), 256) or "noema"
    source = bounded(request.get("source"), 64) or "noema-acp"
    request_id = hashlib.sha256((user_id + "\0" + session + "\0" + prompt + "\0" + answer).encode()).hexdigest()
    result = client.add(
        [{"role": "user", "content": prompt}, {"role": "assistant", "content": answer}],
        user_id=user_id, agent_id="shared", session_id=session, source=source,
        scene="chat", request_id=request_id,
        meta={"source": source, "project": user_id},
    )
    return {"stored": bool(result.get("success"))}


def main() -> int:
    if len(sys.argv) != 2 or sys.argv[1] not in {"status", "search", "remember"}:
        return 2
    configured = load_config()
    if sys.argv[1] == "status":
        print(json.dumps({"configured": configured}))
        return 0
    if not configured:
        print(json.dumps({"items": []} if sys.argv[1] == "search" else {"stored": False}))
        return 0
    raw = sys.stdin.buffer.read(MAX_INPUT + 1)
    if len(raw) > MAX_INPUT:
        raise ValueError("memory request too large")
    request = json.loads(raw)
    user_id = project_user(str(request.get("root") or ""))
    with pi_gateway():
        from hy_memory import HyMemoryClient, MemoryConfig

        config = MemoryConfig.from_env()
        if os.environ.get("MEMORY_EMBEDDER_CURL_TRANSPORT", "false").lower() == "true":
            endpoint = os.environ["MEMORY_EMBEDDER_BASE_URL"]
            config.http_transport_factory = lambda: curl_transport_factory(endpoint)
        client = HyMemoryClient(config=config, mode=os.environ["MEMORY_MODE"])
        try:
            response = (search(client, request, user_id) if sys.argv[1] == "search"
                        else remember(client, request, user_id))
        finally:
            client.close()
    print(json.dumps(response, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        # The caller fails open.  Never print the request or provider exception:
        # either could contain private conversation text or credentials.
        print(json.dumps({"error": type(error).__name__}))
        raise SystemExit(1)
