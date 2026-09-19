"""Direct injection never leaves a client's seat0 objects routing the human's input to the agent's window."""
from pathlib import Path
import unittest

from production import PLUGIN_SOURCE, class_definition, definition, run_fixture

FIXTURE = Path(__file__).with_name("seat_policy_fixture.cpp")

FREE_HELPERS = [
    "humanPointerSurfaceInClientOf",
    "humanKeyboardSurfaceInClientOf",
    "humanPointerSerial",
    "humanPointerClientPosition",
    "humanXkb",
]
MEMBERS = [
    "sendButton",
    "sendKey",
    "releasePressedButtons",
    "releasePressedKeys",
    "clearPointerDelivery",
    "clearKeyboardDelivery",
    "clearKeyboardFocus",
    "updatePointerFocus",
    "directPointerEnter",
    "directPointerLeave",
    "ensureDirectPointerEnter",
    "directPointerButton",
    "directKeyboardEnter",
    "directKeyboardLeave",
    "ensureDirectKeyboardEnter",
    "directKeyboardKey",
    "directKeyboardModifiers",
    "sendHumanKeyboardModifiers",
    "restoreHumanDelivery",
    "handleHumanPointerInput",
    "handleHumanKeyboardInput",
    "handleHumanPointerFocusChanged",
    "handleHumanKeyboardFocusAboutToChange",
    "humanConflict",
]


class SeatPolicyTest(unittest.TestCase):
    def test_shared_objects_are_handed_back(self):
        source = PLUGIN_SOURCE.read_text()
        definitions = [definition(source, name, member=False) for name in FREE_HELPERS]
        definitions.append(class_definition(source, "HeldKeysArray"))
        definitions.append(class_definition(source, "SynaraComputerUsePlugin::DirectInjectionScope"))
        definitions += [definition(source, name) for name in MEMBERS]
        run_fixture(FIXTURE, definitions, prefix="synara-kwin-seat-policy-test-")


if __name__ == "__main__":
    unittest.main()
