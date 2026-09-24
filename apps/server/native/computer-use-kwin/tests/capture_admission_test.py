"""captureWindowEx/captureRegionEx: shared admission, flag validation, and passive frames (R9)."""
from pathlib import Path
import re
import unittest

from production import PLUGIN_SOURCE, definition, run_fixture

FIXTURE = Path(__file__).with_name("capture_admission_fixture.cpp")


class CaptureAdmissionTest(unittest.TestCase):
    def test_flags_and_passive_captures(self):
        source = PLUGIN_SOURCE.read_text()
        flags = re.search(r"^enum CaptureFlag : uint \{.*?^\};\n.*?^static CaptureFormat captureFormat\(uint flags\)\n\{.*?^\}\n", source, re.MULTILINE | re.DOTALL)
        self.assertIsNotNone(flags, "the capture flags, formats and captureFormat must exist")
        definitions = [definition(source, name) for name in
                       ["captureWindow", "captureWindowEx", "captureRegionEx", "admitCapture", "startCapture"]]
        run_fixture(FIXTURE, definitions, prefix="synara-kwin-capture-admission-test-",
                    replacements={"// PRODUCTION_FLAGS": flags.group(0)})


if __name__ == "__main__":
    unittest.main()
