"""Session stop/start must not multiply the agent device's connections to KWin's input pipeline."""
from pathlib import Path
import unittest

from production import PLUGIN_SOURCE, definition, run_fixture

FIXTURE = Path(__file__).with_name("input_device_fixture.cpp")


class InputDeviceTest(unittest.TestCase):
    def test_restart_delivers_each_event_once(self):
        source = PLUGIN_SOURCE.read_text()
        definitions = [definition(source, name) for name in ["attachInputDevice", "detachInputDevice"]]
        run_fixture(FIXTURE, definitions, prefix="synara-kwin-input-device-test-")


if __name__ == "__main__":
    unittest.main()
