"""An agent-opened popup never grabs the human's seat (audit N2)."""
from pathlib import Path
import re
import unittest

from production import PLUGIN_SOURCE, definition, run_fixture

FIXTURE = Path(__file__).with_name("popup_fixture.cpp")


class PopupTest(unittest.TestCase):
    def test_agent_popups_never_grab(self):
        source = PLUGIN_SOURCE.read_text()
        owner = re.search(r"^enum class PopupOwner \{.*?^\};\n", source, re.MULTILINE | re.DOTALL)
        window = re.search(r"^static constexpr qint64 s_popupAttributionMs = \d+;", source, re.MULTILINE)
        self.assertIsNotNone(owner)
        self.assertIsNotNone(window)
        free = "\n".join([owner.group(0), window.group(0), definition(source, "popupOpenedByAgent", member=False),
                          definition(source, "serialInBurst", member=False)])
        definitions = [definition(source, name) for name in
                       ["handlePopupCreated", "handlePopupGrab", "isAgentPopup", "dismissAgentPopups", "noteAgentBurst", "agentMintedSerial", "handleHumanPointerPress"]]
        run_fixture(FIXTURE, definitions, prefix="synara-kwin-popup-test-", replacements={"// PRODUCTION_FREE": free})


if __name__ == "__main__":
    unittest.main()
