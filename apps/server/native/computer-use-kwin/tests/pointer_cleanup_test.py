"""Run production pointer cleanup against isolated client and seat models."""
from pathlib import Path
import unittest

from production import PLUGIN_SOURCE, definition, run_fixture

FIXTURE = Path(__file__).with_name("pointer_cleanup_fixture.cpp")


class PointerCleanupTest(unittest.TestCase):
    def test_releases_buttons_before_clearing_delivery(self):
        source = PLUGIN_SOURCE.read_text()
        definitions = [definition(source, name) for name in
                       ["sendButton", "releasePressedButtons", "clearPointerDelivery"]]
        run_fixture(FIXTURE, definitions, prefix="synara-kwin-pointer-test-")


if __name__ == "__main__":
    unittest.main()
