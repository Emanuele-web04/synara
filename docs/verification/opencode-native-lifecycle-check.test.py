"""Process-level controls for the isolated native acceptance runner.

These execute real local HTTP servers and child processes with a fixture CLI/Bun.
They prove runner ownership/failure handling, not native provider behavior.
Run: python docs/verification/opencode-native-lifecycle-check.test.py
"""

import base64
import http.server
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest


SCRIPT = Path(__file__).with_name("opencode-native-lifecycle-check.py")


class RunnerControls(unittest.TestCase):
    def run_fixture(self, directory, cli_body, *, bun_exit=0):
        root = Path(directory)
        marker = root / "test-marker.json"
        cli = root / "opencode"
        bun = root / "bun"
        cli.write_text("#!" + sys.executable + "\n" + cli_body)
        bun.write_text(
            "#!" + sys.executable + "\n"
            "import json,os,pathlib,sys\n"
            f"pathlib.Path({str(marker)!r}).write_text(json.dumps({{"
            "'url': os.environ.get('OPENCODE_LIVE_SERVER_URL'),"
            "'freshPasswordPresent': bool(os.environ.get('OPENCODE_LIVE_SERVER_PASSWORD'))"
            "}))\n"
            f"sys.exit({bun_exit})\n"
        )
        cli.chmod(0o755)
        bun.chmod(0o755)
        result = subprocess.run(
            [sys.executable, str(SCRIPT)],
            env={**os.environ, "PATH": str(root), "OPENCODE_LIVE_BINARY": str(cli)},
            text=True, capture_output=True, timeout=12,
        )
        return result, json.loads(marker.read_text()) if marker.exists() else None

    def owned_cli(self, *, reject_password=False):
        return (
            "import base64,http.server,os,sys\n"
            "assert sys.argv[-2:] == ['--port','0']\n"
            "password=os.environ['OPENCODE_SERVER_PASSWORD']\n"
            "assert password and password == os.environ['OPENCODE_PASSWORD']\n"
            "expected='Basic '+base64.b64encode(('opencode:'+password).encode()).decode()\n"
            "class Handler(http.server.BaseHTTPRequestHandler):\n"
            " def do_GET(self):\n"
            f"  accepted = self.headers.get('Authorization') == expected and not {reject_password!r}\n"
            "  self.send_response(200 if accepted else 401);self.end_headers()\n"
            "  self.wfile.write(b'{\"healthy\":true}')\n"
            " def log_message(self,*args): pass\n"
            "server=http.server.HTTPServer(('127.0.0.1',0),Handler)\n"
            "print('opencode server listening on http://127.0.0.1:'+str(server.server_port),flush=True)\n"
            "server.serve_forever()\n"
        )

    @unittest.skipIf(os.name == "nt", "Fixture executables use POSIX shebangs; no Windows claim.")
    def test_rejects_health_from_unrelated_fixed_port_without_owned_announcement(self):
        requests = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                requests.append(self.path)
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{"healthy":true}')

            def log_message(self, *args):
                pass

        server = http.server.HTTPServer(("127.0.0.1", 46144), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as directory:
                result, marker = self.run_fixture(
                    directory, "import time\ntime.sleep(0.3)\n"
                )
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIsNone(marker, "An unowned server must not admit the native test")
            self.assertEqual(requests, [], "Readiness must start with the owned announcement")
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)
            self.assertFalse(thread.is_alive())

    @unittest.skipIf(os.name == "nt", "Fixture executables use POSIX shebangs; no Windows claim.")
    def test_accepts_owned_ephemeral_server_and_passes_only_fresh_local_password(self):
        with tempfile.TemporaryDirectory() as directory:
            result, marker = self.run_fixture(directory, self.owned_cli())
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIsNotNone(marker)
        self.assertTrue(marker["freshPasswordPresent"])
        self.assertRegex(marker["url"], r"^http://127\.0\.0\.1:[0-9]+$")

    @unittest.skipIf(os.name == "nt", "Fixture executables use POSIX shebangs; no Windows claim.")
    def test_preserves_native_test_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            result, marker = self.run_fixture(directory, self.owned_cli(), bun_exit=13)
        self.assertNotEqual(result.returncode, 0)
        self.assertIsNotNone(marker)
        self.assertIn("exit status 13", result.stderr)

    @unittest.skipIf(os.name == "nt", "Fixture executables use POSIX shebangs; no Windows claim.")
    def test_refuses_failed_local_server_authentication(self):
        with tempfile.TemporaryDirectory() as directory:
            result, marker = self.run_fixture(
                directory, self.owned_cli(reject_password=True)
            )
        self.assertNotEqual(result.returncode, 0)
        self.assertIsNone(marker)
        self.assertIn("rejected its fresh server password", result.stderr)


if __name__ == "__main__":
    unittest.main()
