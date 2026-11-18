export const source = String.raw`"""T3 tools for the current native Albedo session."""
import asyncio
import json
import re
from pathlib import Path
import urllib.error
import urllib.request
import uuid

_ROOT = Path(__file__).resolve().parent
_LIMIT = 4 * 1024 * 1024
_PROTOCOL = "2025-06-18"


class T3Error(RuntimeError):
    pass


def _configuration():
    from albedo import agents
    native_id = agents.self.id
    if not isinstance(native_id, str) or not re.fullmatch(r"[0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", native_id):
        raise T3Error("Albedo did not provide a valid native session identity")
    path = _ROOT / "sessions" / (native_id + ".json")
    try:
        with path.open("rb") as handle:
            encoded = handle.read(65537)
        if len(encoded) > 65536:
            raise T3Error("T3 session configuration exceeds its limit")
        config = json.loads(encoded)
    except (OSError, ValueError):
        raise T3Error("This native Albedo session has no T3 tool identity. Native helpers cannot use their parent's T3 authority.") from None
    if not isinstance(config, dict) or config.get("nativeSessionId") != native_id:
        raise T3Error("T3 tool identity does not match this native session")
    return config


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise T3Error("T3 refused an MCP redirect")


class _Client:
    def __init__(self, config):
        self.config = config
        self.session = None
        self.initialized = False
        self.lock = asyncio.Lock()
        self.slots = asyncio.Semaphore(16)

    def _post(self, method, params, notification=False):
        request_id = None if notification else str(uuid.uuid4())
        body = {"jsonrpc": "2.0", "method": method, "params": params}
        if request_id is not None:
            body["id"] = request_id
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "Authorization": self.config["authorizationHeader"],
            "MCP-Protocol-Version": _PROTOCOL,
            "t3-tool-exposure": "deferred",
        }
        if self.session is not None:
            headers["Mcp-Session-Id"] = self.session
        payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
        if len(payload) > _LIMIT:
            raise T3Error("T3 tool arguments exceed 4 MiB")
        request = urllib.request.Request(self.config["endpoint"], data=payload, headers=headers, method="POST")
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
        try:
            with opener.open(request, timeout=120) as response:
                session = response.headers.get("Mcp-Session-Id")
                if method == "initialize":
                    self.session = session
                elif session is not None and session != self.session:
                    raise T3Error("T3 MCP session identity changed")
                if notification:
                    return None
                if "text/event-stream" in response.headers.get("Content-Type", ""):
                    total, data = 0, []
                    while True:
                        line = response.readline(_LIMIT + 1)
                        total += len(line)
                        if total > _LIMIT:
                            raise T3Error("T3 MCP response exceeds 4 MiB")
                        if not line:
                            break
                        line = line.decode("utf-8").rstrip("\r\n")
                        if line.startswith("data:"):
                            data.append(line[5:].lstrip(" "))
                        elif not line and data:
                            item = json.loads("\n".join(data))
                            data = []
                            if item.get("id") == request_id:
                                return self._result(item)
                    raise T3Error("T3 MCP stream ended without this request's outcome")
                encoded = response.read(_LIMIT + 1)
                if len(encoded) > _LIMIT:
                    raise T3Error("T3 MCP response exceeds 4 MiB")
                item = json.loads(encoded)
                if item.get("id") != request_id:
                    raise T3Error("T3 MCP response identity mismatch")
                return self._result(item)
        except urllib.error.HTTPError as error:
            raise T3Error("T3 MCP returned HTTP " + str(error.code) + ". Reconnect to T3; do not repeat a tool call whose effects are unknown.") from None
        except (OSError, ValueError):
            raise T3Error("T3 MCP connection failed. The call's effects are unknown; inspect them before retrying.") from None

    def _result(self, item):
        if "error" in item:
            raise T3Error(str(item["error"].get("message", "T3 MCP request failed"))[:2000])
        if "result" not in item:
            raise T3Error("T3 MCP response has no result")
        return item["result"]

    async def request(self, method, params):
        async with self.slots:
            async with self.lock:
                if not self.initialized:
                    result = await asyncio.to_thread(self._post, "initialize", {
                        "protocolVersion": _PROTOCOL, "capabilities": {},
                        "clientInfo": {"name": "t3-albedo", "version": "1.0.0"},
                    })
                    if result.get("protocolVersion") != _PROTOCOL:
                        raise T3Error("T3 MCP protocol is incompatible")
                    await asyncio.to_thread(self._post, "notifications/initialized", {}, True)
                    self.initialized = True
            return await asyncio.to_thread(self._post, method, params)


_client = None


def _current():
    global _client
    config = _configuration()
    if _client is None or _client.config != config:
        _client = _Client(config)
    return _client


async def tools():
    """List available T3 tools with their descriptions and input schemas."""
    client = _current()
    found, seen, cursor = [], set(), None
    while True:
        page = await client.request("tools/list", {} if cursor is None else {"cursor": cursor})
        found.extend(page.get("tools", []))
        cursor = page.get("nextCursor")
        if len(found) > 512 or (cursor is not None and (cursor in seen or len(seen) >= 64)):
            raise T3Error("T3 tool catalog exceeds its paging limit")
        if cursor is None:
            return found
        seen.add(cursor)


async def call(name, arguments=None, **kwargs):
    """Call a T3 tool once. A tool-reported failure remains in isError."""
    return await _current().request("tools/call", {"name": name, "arguments": {**(arguments or {}), **kwargs}})
`;
