"""xdg_activation: the agent's serials never activate a window, and the human's launches still do."""
from pathlib import Path
import re
import unittest

from production import PLUGIN_SOURCE, definition, run_fixture

FIXTURE = Path(__file__).with_name("activation_token_fixture.cpp")


class ActivationTokenTest(unittest.TestCase):
    def test_agent_serials_refused_and_kwin_rule_kept(self):
        source = PLUGIN_SOURCE.read_text()
        refused = re.search(r"^static const QString s_notGrantedToken = [^\n]*;", source, re.MULTILINE)
        self.assertIsNotNone(refused)
        free = "\n".join([refused.group(0)] + [definition(source, name, member=False) for name in
                                                ["serialInBurst", "isPrivilegedInWindowManagement", "activationTokenGranted"]])
        definitions = [definition(source, name) for name in ["noteAgentBurst", "agentMintedSerial", "createActivationToken"]]
        run_fixture(FIXTURE, definitions, prefix="synara-kwin-activation-test-", replacements={"// PRODUCTION_FREE": free})

    def test_no_serial_concealment(self):
        # The rule this replaced moved KWin's last interaction past every
        # burst, which made a window the human had just launched open behind
        # whatever they were in whenever the agent was busy as it mapped.
        self.assertNotIn("setLastInteractionSerial", PLUGIN_SOURCE.read_text())


if __name__ == "__main__":
    unittest.main()
