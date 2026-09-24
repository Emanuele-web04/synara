"""Failed authenticate() attempts are throttled per bus peer without a round-trip."""
from pathlib import Path
import unittest

from production import AUTH_HEADER, class_definition, run_fixture

FIXTURE = Path(__file__).with_name("auth_limiter_fixture.cpp")


class AuthLimiterTest(unittest.TestCase):
    def test_cooldown_and_bounded_table(self):
        run_fixture(FIXTURE, [class_definition(AUTH_HEADER.read_text(), "ComputerUseAuthLimiter")],
                    prefix="synara-kwin-auth-limiter-test-")


if __name__ == "__main__":
    unittest.main()
