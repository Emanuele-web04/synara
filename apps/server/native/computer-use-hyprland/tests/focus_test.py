"""Compile production input and capture functions against isolated models.

No compositor is started or contacted. Each fixture stubs the compositor and
protocol surface a group of production functions touches, splices the real
function bodies in, and checks what the client would have heard.

The production source is C++26 and so are the fixtures: a body that compiles
here compiles in the plugin, and a construct the plugin uses never has to be
avoided for the tests' sake.
"""
from pathlib import Path
import re
import subprocess
import tempfile
import unittest
import xml.etree.ElementTree as ElementTree

ROOT = Path(__file__).resolve().parents[1]
STANDARD = "-std=c++26"

# Return types the plugin's free functions use. A definition starts at column 0
# with one of these, the name, a parameter list, and an opening brace.
RETURN_TYPE = (
    r"(?:\[\[noreturn\]\] )?(?:static )?(?:inline )?"
    r"(?:const )?[A-Za-z_][\w:]*(?:<[^{};]*?>)?(?:\s*[*&])?"
)


def block_end(source, opening):
    """Index just past the brace block opened at `opening`.

    Braces inside comments, string literals (including raw strings) and
    character literals do not count, so an error message containing "{"
    or a commented-out line cannot truncate or over-extend a definition.
    """
    depth = 0
    i = opening
    n = len(source)
    while i < n:
        c = source[i]
        nxt = source[i + 1] if i + 1 < n else ""
        if c == "/" and nxt == "/":
            i = source.index("\n", i) if "\n" in source[i:] else n
            continue
        if c == "/" and nxt == "*":
            i = source.index("*/", i + 2) + 2
            continue
        if c == "R" and nxt == '"':
            close_paren = source.index("(", i + 2)
            delimiter = source[i + 2:close_paren]
            i = source.index(")" + delimiter + '"', close_paren) + len(delimiter) + 2
            continue
        if c in "\"'":
            quote = c
            i += 1
            while source[i] != quote:
                i += 2 if source[i] == "\\" else 1
            i += 1
            continue
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    raise AssertionError("unterminated block")


def definition(source, name, kind="function"):
    if kind == "variable":
        # A one-line namespace-scope definition: `Type name = init;` or `Type name;`.
        match = re.search(r"^[A-Za-z_][^\n;{}]*?\b" + re.escape(name) + r"\b\s*(?:=[^\n;]*)?;", source, re.MULTILINE)
        if not match:
            raise AssertionError(f"Missing production definition: {name}")
        return match.group(0)
    if kind == "struct":
        pattern = r"^struct " + re.escape(name) + r"\s*\{"
    elif kind == "enum":
        pattern = r"^enum class " + re.escape(name) + r"\b[^{;]*\{"
    else:
        pattern = r"^" + RETURN_TYPE + r"\s+" + re.escape(name) + r"\([^{};]*\)\s*(?:const\s*)?\{"
    match = re.search(pattern, source, re.MULTILINE)
    if not match:
        raise AssertionError(f"Missing production definition: {name}")
    opening = source.index("{", match.start())
    end = block_end(source, opening)
    return source[match.start():end] + (";" if kind in ("struct", "enum") else "")


def definitions(source, names):
    """Production definitions in the given order; a struct or variable is named `("Name", "struct"|"variable")`."""
    parts = []
    for entry in names:
        name, kind = entry if isinstance(entry, tuple) else (entry, "function")
        parts.append(definition(source, name, kind))
    return "\n\n".join(parts)


def compile_and_run(fixture_name, production, prefix):
    fixture = (ROOT / "tests" / fixture_name).read_text()
    assert "// PRODUCTION_DEFINITIONS" in fixture, f"{fixture_name} has no splice point"
    with tempfile.TemporaryDirectory(prefix=prefix) as directory:
        cpp = Path(directory) / "fixture.cpp"
        cpp.write_text(fixture.replace("// PRODUCTION_DEFINITIONS", production))
        binary = Path(directory) / "fixture-test"
        subprocess.run(["g++", STANDARD, "-Wall", "-Wextra", str(cpp), "-o", str(binary)], check=True)
        subprocess.run([str(binary)], check=True)


class ExtractionTest(unittest.TestCase):
    def test_braces_in_literals_and_comments_are_ignored(self):
        source = (
            'void tricky() {\n'
            '    const char* a = "{"; // } not a close\n'
            "    const char b = '{';\n"
            '    /* { { */\n'
            '    const char* raw = R"x(} })x";\n'
            '    if (a) { b; }\n'
            '}\n'
            'void next() {\n}\n'
        )
        extracted = definition(source, "tricky")
        self.assertTrue(extracted.startswith("void tricky() {"))
        self.assertTrue(extracted.endswith("if (a) { b; }\n}"))

    def test_variable_definitions(self):
        source = "std::unordered_map<uintptr_t, SWindowIdentity> windowIdentities;\nuint64_t nextWindowGeneration = 1;\n"
        self.assertEqual(definition(source, "windowIdentities", "variable"), "std::unordered_map<uintptr_t, SWindowIdentity> windowIdentities;")
        self.assertEqual(definition(source, "nextWindowGeneration", "variable"), "uint64_t nextWindowGeneration = 1;")

    def test_return_type_shapes(self):
        source = (
            "std::optional<CBox> boxes(int a) {\n}\n"
            "[[noreturn]] void fail(const std::string& m) {\n}\n"
            "cairo_surface_t* make(int w, int h) {\n}\n"
            "SP<CWLSurfaceResource> surface(const PHLWINDOW& w) {\n}\n"
        )
        for name in ["boxes", "fail", "make", "surface"]:
            self.assertIn(name + "(", definition(source, name))


class FocusRegressionTest(unittest.TestCase):
    def setUp(self):
        self.source = (ROOT / "synarahyprlandplugin.cpp").read_text()

    def test_capture_respects_emergency_release(self):
        production = definitions(self.source, [
            "sessionLocked", "requireControlAvailable", "requireUnlockedSession",
            "captureWindow", "captureRegion",
        ])
        compile_and_run("capture_guard_fixture.cpp", production, "synara-capture-guard-test-")

    def test_capture_transforms(self):
        with tempfile.TemporaryDirectory(prefix="synara-transform-test-") as directory:
            binary = Path(directory) / "capture-test"
            subprocess.run(["g++", STANDARD, "-Wall", "-Wextra", str(ROOT / "tests/capturetransform_test.cpp"), "-o", str(binary)], check=True)
            subprocess.run([str(binary)], check=True)

    def test_input_delivery_and_handback(self):
        production = definitions(self.source, [
            ("ReleaseMode", "enum"),
            "sendPointerEnter", "sendPointerLeave", "humanHoldsButton", "leaveSeatSiblingBeforePointerEnter",
            "deliverReleases", "deferReleases", "deliverDeferredReleases", "settleDeferredReleases",
            "releasePressedButtons", "directPointerLeave", "returnPointerToSeat",
            "handBackPointerBeforeHumanEvent", "directPointerMotion", "clearPointerDelivery",
            "refuseIfHumanHoldsButton", "updatePointerFocus", "onSeatPointerFocusChange",
            "sendKeyboardLeave", "leaveSeatSiblingBeforeKeyboardEnter", "sendKeyboardEnterEvent",
            "directKeyboardLeave", "releasePressedKeys", "returnKeyboardToSeat",
            "handBackKeyboardBeforeHumanKey", "onSeatKeyboardFocusChange",
            "clearKeyboardDelivery", "updateKeyboardFocus", ("InputFocusHandback", "struct"),
            "clearFocusWindow", "resetInputDelivery",
            "movePointer", "injectButton", "takeDiscreteSteps", "scrollAxisValue",
            "scrollValue120", "injectAxis", "injectKey",
        ])
        compile_and_run("focus_fixture.cpp", production, "synara-focus-test-")

    def test_window_identity(self):
        production = definitions(self.source, [
            ("SWindowIdentity", "struct"), ("windowIdentities", "variable"), ("nextWindowGeneration", "variable"),
            "windowId", "findWindowById", "forgetDeadWindowIds",
        ])
        compile_and_run("window_identity_fixture.cpp", production, "synara-window-id-test-")


class IntrospectionTest(unittest.TestCase):
    """org.synara.ComputerUse.xml declares exactly what setupDbus registers.

    The server drives both compositor plugins through one proxy built from
    this file, so a method registered here but missing from the file (or the
    reverse) is a contract break the compiler cannot see.
    """
    def test_xml_matches_registered_methods(self):
        source = (ROOT / "synarahyprlandplugin.cpp").read_text()
        registered = set(re.findall(r'registerMethod\("([A-Za-z]+)"\)', source))
        signals = set(re.findall(r'registerSignal\("([A-Za-z]+)"\)', source))
        tree = ElementTree.parse(ROOT / "org.synara.ComputerUse.xml")
        interface = tree.getroot().find("interface")
        self.assertEqual(interface.get("name"), "org.synara.ComputerUse1")
        declared = {method.get("name") for method in interface.findall("method")}
        self.assertEqual(declared, registered)
        self.assertEqual({signal.get("name") for signal in interface.findall("signal")}, signals)
        # Every method returns exactly one value, and the reply of every
        # non-JSON, non-capture, non-authenticate method is a boolean.
        for method in interface.findall("method"):
            outs = [arg for arg in method.findall("arg") if arg.get("direction") == "out"]
            self.assertEqual(len(outs), 1, method.get("name"))
            name = method.get("name")
            expected = "s" if name in {"authenticate", "healthJson", "stateJson", "windowsJson"} else "ay" if name.startswith("capture") else "b"
            self.assertEqual(outs[0].get("type"), expected, name)

    def test_xml_matches_kwin_declaration(self):
        kwin = ROOT.parent / "computer-use-kwin" / "org.synara.ComputerUse.xml"
        if not kwin.exists():
            self.skipTest("KWin declaration not present in this checkout")
        def signatures(path):
            interface = ElementTree.parse(path).getroot().find("interface")
            return {
                m.get("name"): [(a.get("name"), a.get("type"), a.get("direction")) for a in m.findall("arg")]
                for m in interface.findall("method")
            }
        self.assertEqual(signatures(ROOT / "org.synara.ComputerUse.xml"), signatures(kwin))


if __name__ == "__main__":
    unittest.main()
