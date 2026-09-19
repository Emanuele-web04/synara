"""The panic-release latch survives every stop but the human's own resume."""
from pathlib import Path
import unittest

from production import PLUGIN_SOURCE, definition, run_fixture

FIXTURE = Path(__file__).with_name("release_latch_fixture.cpp")


class ReleaseLatchTest(unittest.TestCase):
    def test_only_resume_shortcut_clears_latch(self):
        source = PLUGIN_SOURCE.read_text()
        definitions = [definition(source, name) for name in
                       ["stopReasonName", "recordStop", "handleReleaseShortcut"]]
        run_fixture(FIXTURE, definitions, prefix="synara-kwin-latch-test-")


if __name__ == "__main__":
    unittest.main()
