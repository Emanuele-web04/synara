"""Run the actual production parallel-run UI with isolated native OpenCode.

Run from the repository root with Bun and the native OpenCode CLI on PATH.
OPENCODE_LIVE_BINARY can specify the native executable explicitly.
No API credentials or existing provider configuration are inherited.
"""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import urllib.request


binary = os.environ.get("OPENCODE_LIVE_BINARY") or shutil.which("opencode")
bun = shutil.which("bun")
assert binary and bun, "Install Bun and the native OpenCode CLI first"
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
with tempfile.TemporaryDirectory(prefix="synara-isolated-native-") as directory:
    root = Path(directory)
    workspace = root / "workspace"
    workspace.mkdir()
    env = {"PATH": os.environ.get("PATH", ""), "HOME": str(root), **transport}
    for variable, folder in {
        "XDG_CONFIG_HOME": "config", "XDG_DATA_HOME": "data",
        "XDG_CACHE_HOME": "cache", "XDG_STATE_HOME": "state",
    }.items():
        env[variable] = str(root / folder)
    env["OPENCODE_CONFIG_CONTENT"] = json.dumps({
        "enabled_providers": ["opencode"], "model": model, "small_model": model,
        "autoupdate": False, "share": "disabled", "permission": {"*": "deny"},
        "instructions": [],
        "tools": {name: False for name in ["read", "edit", "write", "bash", "glob", "grep", "webfetch", "task", "skill", "question", "todowrite"]},
    })
    with open("/tmp/parallel-native-cli.log", "w") as log:
        cli = subprocess.Popen([binary, "serve", "--hostname", "127.0.0.1", "--port", "46164"], cwd=workspace, env=env, stdout=log, stderr=subprocess.STDOUT)
        try:
            for attempt in range(150):
                try:
                    urllib.request.urlopen("http://127.0.0.1:46164/global/health", timeout=1).close()
                    break
                except Exception:
                    if cli.poll() is not None:
                        raise RuntimeError("Native OpenCode exited before health check")
                    time.sleep(0.2)
            clean = {key: value for key, value in env.items() if key != "OPENCODE_CONFIG_CONTENT"}
            clean["OPENCODE_LIVE_BINARY"] = binary
            clean["CHROMIUM_EXECUTABLE_PATH"] = os.environ.get("CHROMIUM_EXECUTABLE_PATH", "/tmp/synara-chromium")
            node = shutil.which("node")
            assert node, "Install Node.js 24 first"
            subprocess.run([node, "docs/verification/parallel-run-native-check.mjs"], env=clean, check=True)
        finally:
            cli.kill()
            cli.wait()
