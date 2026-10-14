"""Run the real native lifecycle test with isolated config and an empty workspace.

Run from the repository root with Bun and the native OpenCode CLI on PATH.
OPENCODE_LIVE_BINARY can specify the native executable explicitly.
No API credentials or existing provider configuration are inherited.
"""

import base64
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import tempfile
import time
import urllib.error
import urllib.request


def wait_for_owned_server(server, output_path, password, timeout=30):
    """Accept only the loopback URL announced by this owned CLI process."""
    deadline = time.monotonic() + timeout
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    authorization = "Basic " + base64.b64encode(
        f"opencode:{password}".encode()
    ).decode()
    while time.monotonic() < deadline:
        if server.poll() is not None:
            raise RuntimeError("Native CLI exited during startup")
        # Do not let unrelated output consume unbounded memory, or accept a
        # generic health response from an already occupied fixed port.
        if output_path.stat().st_size > 262_144:
            raise RuntimeError("Native CLI startup output exceeded 256 KiB")
        output = output_path.read_text(errors="replace")
        match = re.search(
            r"(?m)^(?:opencode )?server listening on (http://127\.0\.0\.1:([0-9]+))\r?$",
            output,
        )
        if match:
            if not 1 <= int(match[2]) <= 65535:
                raise RuntimeError("Native CLI announced an invalid loopback port")
            request = urllib.request.Request(
                match[1] + "/global/health",
                headers={"Authorization": authorization},
            )
            try:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                with opener.open(request, timeout=min(1, remaining)) as response:
                    if response.status != 200:
                        raise RuntimeError("Native CLI health check did not return 200")
                if server.poll() is not None:
                    raise RuntimeError("Native CLI exited during its health check")
                return match[1]
            except urllib.error.HTTPError as error:
                if error.code in (401, 403):
                    raise RuntimeError("Owned native CLI rejected its fresh server password") from error
            except OSError:
                pass
        time.sleep(min(0.05, max(0, deadline - time.monotonic())))
    raise RuntimeError("Owned native CLI did not announce a healthy loopback server")


def stop_owned_server(server):
    if server.poll() is None:
        server.kill()
    # This confirms only this direct child. It is not a descendant-tree receipt.
    server.wait(timeout=10)


def main():
    binary = os.environ.get("OPENCODE_LIVE_BINARY") or shutil.which("opencode")
    bun = shutil.which("bun")
    if not binary or not bun:
        raise RuntimeError("Install Bun and the native OpenCode CLI first")
    model = "opencode/mimo-v2.6-flash-free"
    transport = {
        key: value
        for key, value in os.environ.items()
        if key.upper()
        in {
            "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
            "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS", "NODE_USE_ENV_PROXY",
            "CODEX_NETWORK_PROXY_ACTIVE", "CODEX_NETWORK_ALLOW_LOCAL_BINDING", "NETWORK",
        }
    }
    with tempfile.TemporaryDirectory(prefix="synara-isolated-opencode-") as directory:
        root = Path(directory)
        workspace = root / "workspace"
        workspace.mkdir()
        env = {"PATH": os.environ.get("PATH", ""), "HOME": str(root), **transport}
        for variable, folder in {
            "XDG_CONFIG_HOME": "config", "XDG_DATA_HOME": "data",
            "XDG_CACHE_HOME": "cache", "XDG_STATE_HOME": "state",
        }.items():
            env[variable] = str(root / folder)
        # These are freshly generated local-server credentials, not model API
        # credentials. Do not inherit a password or print it in diagnostics.
        password = secrets.token_urlsafe(32)
        env["OPENCODE_SERVER_USERNAME"] = "opencode"
        env["OPENCODE_SERVER_PASSWORD"] = password
        env["OPENCODE_PASSWORD"] = password
        env["OPENCODE_CONFIG_CONTENT"] = json.dumps({
            "enabled_providers": ["opencode"], "model": model, "small_model": model,
            "autoupdate": False, "share": "disabled", "permission": {"*": "deny"},
            "instructions": [],
            "tools": {name: False for name in [
                "read", "edit", "write", "bash", "glob", "grep", "webfetch",
                "task", "skill", "question", "todowrite",
            ]},
        })
        output_path = root / "native-server.txt"
        with output_path.open("w") as output:
            server = subprocess.Popen(
                [binary, "serve", "--hostname", "127.0.0.1", "--port", "0"],
                cwd=workspace, env=env, stdout=output, stderr=subprocess.STDOUT,
            )
            try:
                server_url = wait_for_owned_server(server, output_path, password)
                subprocess.run(
                    [bun, "run", "--cwd", "apps/server", "test",
                     "src/provider/Layers/OpenCodeAdapter.live.test.ts"],
                    check=True, timeout=240,
                    env={**env, "SYNARA_LIVE_OPENCODE": "1", "OPENCODE_LIVE_MODEL": model,
                         "OPENCODE_LIVE_BINARY": binary,
                         "OPENCODE_LIVE_SERVER_URL": server_url,
                         "OPENCODE_LIVE_SERVER_PASSWORD": password},
                )
            finally:
                # Cleanup failures remain visible, including any preceding test
                # exception in Python's exception chain.
                stop_owned_server(server)


if __name__ == "__main__":
    main()
