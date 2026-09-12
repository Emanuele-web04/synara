"""Run production pointer cleanup against isolated client and seat models."""
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


def definition(source, name):
    match = re.search(r"^void SynaraComputerUsePlugin::" + re.escape(name) + r"\([^\n]*\)\n\{", source, re.MULTILINE)
    if not match:
        raise AssertionError(f"Missing production definition: {name}")
    opening = source.index("{", match.start())
    depth, end = 1, opening + 1
    while depth:
        depth += (source[end] == "{") - (source[end] == "}")
        end += 1
    return source[match.start():end]


class PointerCleanupTest(unittest.TestCase):
    def test_releases_buttons_before_clearing_delivery(self):
        source = (ROOT / "synaracomputeruseplugin.cpp").read_text()
        definitions = [definition(source, name) for name in
                       ["sendButton", "releasePressedButtons", "clearPointerDelivery"]]
        fixture = (ROOT / "tests/pointer_cleanup_fixture.cpp").read_text()
        with tempfile.TemporaryDirectory(prefix="synara-kwin-pointer-test-") as directory:
            cpp = Path(directory) / "pointer_cleanup.cpp"
            cpp.write_text(fixture.replace("// PRODUCTION_DEFINITIONS", "\n\n".join(definitions)))
            binary = Path(directory) / "pointer-cleanup-test"
            subprocess.run(["g++", "-std=c++20", "-Wall", "-Wextra", str(cpp), "-o", str(binary)], check=True)
            subprocess.run([str(binary)], check=True)


if __name__ == "__main__":
    unittest.main()
