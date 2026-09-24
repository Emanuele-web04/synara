"""stateJson.keyboardLayout names the xkb layout the agent's keys are interpreted with."""
from pathlib import Path
import unittest

from production import PLUGIN_SOURCE, definition, run_fixture

FIXTURE = Path(__file__).with_name("keyboard_layout_fixture.cpp")


class KeyboardLayoutTest(unittest.TestCase):
    def test_reports_agent_layout(self):
        source = PLUGIN_SOURCE.read_text()
        definitions = [definition(source, name) for name in
                       ["keyboardLayoutIndex", "keyboardLayout", "keyboardLayoutName"]]
        run_fixture(FIXTURE, definitions, prefix="synara-kwin-layout-test-")


if __name__ == "__main__":
    unittest.main()
