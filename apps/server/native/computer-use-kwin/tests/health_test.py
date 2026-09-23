"""healthJson advertises what actually holds: the bound release shortcut and the bus name."""
from pathlib import Path
import unittest

from production import PLUGIN_SOURCE, definition, run_fixture

FIXTURE = Path(__file__).with_name("health_fixture.cpp")


class HealthTest(unittest.TestCase):
    def test_effective_shortcut_and_service_registration(self):
        source = PLUGIN_SOURCE.read_text()
        definitions = [definition(source, name) for name in
                       ["updateEffectiveReleaseShortcut", "releaseShortcutJson", "releaseShortcutText", "registerOnBus", "handleServiceUnregistered"]]
        run_fixture(FIXTURE, definitions, prefix="synara-kwin-health-test-")


if __name__ == "__main__":
    unittest.main()
