"""Pull production definitions out of the plugin sources for isolated fixture builds.

Each fixture models the handful of compositor objects a set of production
functions touches, then compiles those functions verbatim against the model, so
the logic under test is the shipped code and not a copy of it.
"""
from pathlib import Path
import re
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
PLUGIN_SOURCE = ROOT / "synaracomputeruseplugin.cpp"
AUTH_HEADER = ROOT / "computeruseauth.h"
PLACEHOLDER = "// PRODUCTION_DEFINITIONS"


def definition(source, name, *, member=True):
    """The full text of one function definition, member or free."""
    owner = r"SynaraComputerUsePlugin::" if member else r"(?<![:\w])"
    pattern = re.compile(
        r"^[^\n;{}]*?\b" + owner + re.escape(name) + r"\([^\n]*\)(?: const)?\n\{",
        re.MULTILINE,
    )
    match = pattern.search(source)
    if not match:
        raise AssertionError(f"Missing production definition: {name}")
    return _balanced(source, match.start(), source.index("{", match.start()))


def class_definition(source, name):
    """The full text of one class or struct definition, with its trailing semicolon."""
    match = re.search(r"^(?:class|struct)\s+" + re.escape(name) + r"\b[^{;]*\{", source, re.MULTILINE)
    if not match:
        raise AssertionError(f"Missing production class: {name}")
    return _balanced(source, match.start(), source.index("{", match.start())) + ";"


def _balanced(source, start, opening):
    depth, end = 1, opening + 1
    while depth:
        depth += (source[end] == "{") - (source[end] == "}")
        end += 1
    return source[start:end]


def run_fixture(fixture, definitions, prefix="synara-kwin-fixture-", replacements=None):
    """Compile @p fixture with the placeholder replaced by @p definitions, then run it.

    @p replacements maps further placeholders to production text, for
    declarations a fixture needs ahead of its own model (enums, constants).
    """
    with tempfile.TemporaryDirectory(prefix=prefix) as directory:
        cpp = Path(directory) / "fixture.cpp"
        text = fixture.read_text().replace(PLACEHOLDER, "\n\n".join(definitions))
        for placeholder, replacement in (replacements or {}).items():
            text = text.replace(placeholder, replacement)
        cpp.write_text(text)
        binary = Path(directory) / "fixture"
        subprocess.run(["g++", "-std=c++20", "-Wall", "-Wextra", str(cpp), "-o", str(binary)], check=True)
        result = subprocess.run([str(binary)], capture_output=True, text=True)
        if result.returncode != 0:
            raise AssertionError(f"fixture failed ({result.returncode}):\n{result.stdout}{result.stderr}")
        return result.stdout
