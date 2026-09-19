"""org.synara.ComputerUse.xml declares exactly what the plugin exports.

The plugin exports its Q_INVOKABLE methods and Q_SCRIPTABLE signals through
QDBusConnection::ExportAllInvokables, so the header is the source of truth and
the XML has to match it: name for name, argument signature for argument
signature. The server's own test holds its proxy against the XML.
"""
from pathlib import Path
import re
import unittest
import xml.etree.ElementTree as ElementTree

from production import PLUGIN_SOURCE, ROOT

HEADER = ROOT / "synaracomputeruseplugin.h"
INTROSPECTION = ROOT / "org.synara.ComputerUse.xml"

# QtDBus's marshalling of the C++ types the plugin uses.
SIGNATURES = {
    "QString": "s",
    "bool": "b",
    "uint": "u",
    "int": "i",
    "double": "d",
    "QByteArray": "ay",
}


def signature(cpp_type):
    cpp_type = cpp_type.replace("const", "").replace("&", "").strip()
    if cpp_type not in SIGNATURES:
        raise AssertionError(f"no D-Bus signature known for C++ type {cpp_type!r}")
    return SIGNATURES[cpp_type]


def argument_signatures(parameters):
    parameters = parameters.strip()
    if not parameters:
        return []
    return [signature(parameter.rsplit(" ", 1)[0]) for parameter in parameters.split(",")]


def declared_methods(header):
    """{name: (in signatures, out signature)} from Q_INVOKABLE declarations."""
    methods = {}
    for match in re.finditer(r"Q_INVOKABLE\s+(\w+)\s+(\w+)\(([^)]*)\)(?:\s+const)?;", header):
        returned, name, parameters = match.groups()
        methods[name] = (argument_signatures(parameters), signature(returned))
    return methods


def declared_signals(header):
    signals = {}
    for match in re.finditer(r"Q_SCRIPTABLE\s+void\s+(\w+)\(([^)]*)\);", header):
        name, parameters = match.groups()
        signals[name] = argument_signatures(parameters)
    return signals


def described(interface):
    methods, signals = {}, {}
    for method in interface.findall("method"):
        inputs = [arg.get("type") for arg in method.findall("arg") if arg.get("direction", "in") == "in"]
        outputs = [arg.get("type") for arg in method.findall("arg") if arg.get("direction") == "out"]
        methods[method.get("name")] = (inputs, "".join(outputs))
    for signal in interface.findall("signal"):
        signals[signal.get("name")] = [arg.get("type") for arg in signal.findall("arg")]
    return methods, signals


class IntrospectionTest(unittest.TestCase):
    def test_xml_matches_exported_invokables(self):
        header = HEADER.read_text()
        source = PLUGIN_SOURCE.read_text()
        node = ElementTree.parse(INTROSPECTION).getroot()
        interface_name = re.search(r's_interface = QStringLiteral\("([^"]+)"\)', source).group(1)
        path = re.search(r's_path = QStringLiteral\("([^"]+)"\)', source).group(1)
        self.assertEqual(node.get("name"), path)
        interfaces = [i for i in node.findall("interface") if i.get("name") == interface_name]
        self.assertEqual(len(interfaces), 1, f"the XML must describe exactly one {interface_name} interface")
        methods, signals = described(interfaces[0])
        self.assertEqual(methods, declared_methods(header))
        self.assertEqual(signals, declared_signals(header))
        self.assertIn("resetInputDelivery", methods)
        for method in interfaces[0].findall("method"):
            for arg in method.findall("arg"):
                self.assertIn(arg.get("direction"), ("in", "out"), f"{method.get('name')}: every arg names its direction")
                self.assertTrue(arg.get("name"), f"{method.get('name')}: every arg is named")


if __name__ == "__main__":
    unittest.main()
