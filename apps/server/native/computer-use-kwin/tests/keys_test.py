"""keys(): batched keystrokes with key()'s per-stroke checks and error semantics."""
from pathlib import Path
import unittest

from production import PLUGIN_SOURCE, definition, run_fixture

FIXTURE = Path(__file__).with_name("keys_fixture.cpp")


class KeysTest(unittest.TestCase):
    def test_batch_delivery_and_refusals(self):
        source = PLUGIN_SOURCE.read_text()
        definitions = [definition(source, name) for name in ["keys", "deliverKey", "sendRefusal"]]
        run_fixture(FIXTURE, definitions, prefix="synara-kwin-keys-test-")


if __name__ == "__main__":
    unittest.main()
