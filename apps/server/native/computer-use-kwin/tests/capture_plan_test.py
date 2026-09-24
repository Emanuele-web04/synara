"""Captures render at the delivered scale and tile mixed-scale, negative-origin layouts exactly (S5)."""
from pathlib import Path
import re
import unittest

from production import PLUGIN_SOURCE, class_definition, definition, run_fixture

FIXTURE = Path(__file__).with_name("capture_plan_fixture.cpp")


class CapturePlanTest(unittest.TestCase):
    def test_plan_and_tiling(self):
        source = PLUGIN_SOURCE.read_text()
        constants = re.findall(r"^static constexpr qreal s_capture(?:Min|Max)RenderFactor = [^;]+;", source, re.MULTILINE)
        self.assertEqual(len(constants), 2)
        definitions = constants + [
            definition(source, "deviceSize", member=False),
            definition(source, "deviceDestination", member=False),
            class_definition(source, "CapturePlan"),
            definition(source, "planCapture", member=False),
        ]
        run_fixture(FIXTURE, definitions, prefix="synara-kwin-capture-plan-test-")


if __name__ == "__main__":
    unittest.main()
