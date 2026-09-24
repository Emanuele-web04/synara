"""No borrowed activation in the human's client, and no raise that buries their window (audit P2)."""
from pathlib import Path
import unittest

from production import PLUGIN_SOURCE, definition, run_fixture

FIXTURE = Path(__file__).with_name("human_guard_fixture.cpp")


class HumanGuardTest(unittest.TestCase):
    def test_activation_and_raise_guards(self):
        source = PLUGIN_SOURCE.read_text()
        definitions = [definition(source, name) for name in
                       ["humanKeyboardInSiblingOf", "updateWindowActivation", "clearWindowActivation", "humanWindowCoveredByRaise"]]
        run_fixture(FIXTURE, definitions, prefix="synara-kwin-human-guard-test-")


if __name__ == "__main__":
    unittest.main()
