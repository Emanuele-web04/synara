"""Locking or an inactive session stops the agent and refuses everything with SessionLocked."""
from pathlib import Path
import re
import unittest

from production import PLUGIN_SOURCE, definition, run_fixture

FIXTURE = Path(__file__).with_name("session_lock_fixture.cpp")


class SessionLockTest(unittest.TestCase):
    def test_lock_gate_stops_and_refuses(self):
        source = PLUGIN_SOURCE.read_text()
        error = re.search(r'static const QString s_sessionLockedErrorName = QStringLiteral\("([^"]+)"\);', source)
        self.assertIsNotNone(error, "the SessionLocked error name constant must exist")
        self.assertEqual(error.group(1), "org.synara.ComputerUse.Error.SessionLocked")
        definitions = [
            f'static const QString s_sessionLockedErrorName = QStringLiteral("{error.group(1)}");',
            f'#define SYNARA_SESSION_LOCKED_ERROR "{error.group(1)}"',
        ] + [definition(source, name) for name in
             ["stopReasonName", "recordStop", "sessionLocked", "refuseIfSessionLocked", "handleSessionStateChanged"]]
        run_fixture(FIXTURE, definitions, prefix="synara-kwin-lock-test-")


if __name__ == "__main__":
    unittest.main()
