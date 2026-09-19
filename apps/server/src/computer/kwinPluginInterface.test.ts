import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { COMPUTER_INTERFACE, COMPUTER_PLUGIN_METHOD_SIGNATURES } from "./kwinDbus.ts";

/**
 * The plugin's introspection XML is the C++ side's declaration of the methods
 * it exports; `COMPUTER_PLUGIN_METHOD_SIGNATURES` is the TypeScript side's
 * record of what it calls. A method renamed or re-typed on one side only
 * otherwise fails at runtime, inside the compositor.
 */
const INTROSPECTION_XML_PATH = join(
  import.meta.dirname,
  "..",
  "..",
  "native",
  "computer-use-kwin",
  "org.synara.ComputerUse.xml",
);

type MethodSignatures = Record<string, { readonly in: string; readonly out: string }>;

/**
 * A regex reader for the small subset of D-Bus introspection XML we emit:
 * `<interface>` blocks holding `<method>` elements with `<arg>` children. An
 * `<arg>` without a `direction` is an input, per the D-Bus specification.
 */
function parseIntrospectionMethods(xml: string, interfaceName: string): MethodSignatures {
  const interfacePattern = new RegExp(
    `<interface\\s+name="${interfaceName.replaceAll(".", "\\.")}"[^>]*>([\\s\\S]*?)</interface>`,
  );
  const scope = interfacePattern.exec(xml)?.[1] ?? xml;
  const methods: MethodSignatures = {};
  for (const match of scope.matchAll(
    /<method\s+name="([^"]+)"[^>]*?(?:\/>|>([\s\S]*?)<\/method>)/g,
  )) {
    const [, name, body = ""] = match;
    let input = "";
    let output = "";
    for (const arg of body.matchAll(/<arg\b([^>]*?)\/?>/g)) {
      const attributes = arg[1]!;
      const type = /\btype="([^"]*)"/.exec(attributes)?.[1] ?? "";
      const direction = /\bdirection="([^"]*)"/.exec(attributes)?.[1] ?? "in";
      if (direction === "out") output += type;
      else input += type;
    }
    methods[name!] = { in: input, out: output };
  }
  return methods;
}

describe("parseIntrospectionMethods", () => {
  const fixture = `<!DOCTYPE node PUBLIC "-//freedesktop//DTD D-BUS Object Introspection 1.0//EN"
  "http://www.freedesktop.org/standards/dbus/1.0/introspect.dtd">
<node>
  <interface name="org.freedesktop.DBus.Peer">
    <method name="Ping"/>
  </interface>
  <interface name="org.example.Thing1">
    <method name="noArgs"/>
    <method name="movePointer">
      <arg name="x" type="d" direction="in"/>
      <arg name="y" type="d" direction="in"/>
      <arg type="b" direction="out"/>
    </method>
    <method name="captureRegion">
      <arg direction="in" type="i" name="x"/>
      <arg direction="in" type="i" name="y"/>
      <arg direction="in" type="u" name="width"/>
      <arg direction="in" type="u" name="height"/>
      <arg direction="in" type="u" name="maxDimension"/>
      <arg direction="out" type="ay"/>
    </method>
    <method name="implicitIn">
      <arg type="s" name="token"/>
      <arg type="s" direction="out"/>
    </method>
    <signal name="stateChanged">
      <arg type="s"/>
    </signal>
  </interface>
</node>`;

  it("reads methods and concatenated argument signatures per direction", () => {
    expect(parseIntrospectionMethods(fixture, "org.example.Thing1")).toEqual({
      noArgs: { in: "", out: "" },
      movePointer: { in: "dd", out: "b" },
      captureRegion: { in: "iiuuu", out: "ay" },
      implicitIn: { in: "s", out: "s" },
    });
  });

  it("scopes to the named interface, and ignores signals", () => {
    expect(parseIntrospectionMethods(fixture, "org.freedesktop.DBus.Peer")).toEqual({
      Ping: { in: "", out: "" },
    });
    expect(parseIntrospectionMethods(fixture, "org.example.Thing1")).not.toHaveProperty(
      "stateChanged",
    );
  });

  it("falls back to the whole document when the interface is not named", () => {
    const methods = parseIntrospectionMethods(fixture, "org.example.Absent");
    expect(Object.keys(methods).toSorted()).toEqual([
      "Ping",
      "captureRegion",
      "implicitIn",
      "movePointer",
      "noArgs",
    ]);
  });
});

describe("KWin plugin D-Bus interface", () => {
  it("records a signature for every method the proxy calls", () => {
    for (const [name, signature] of Object.entries(COMPUTER_PLUGIN_METHOD_SIGNATURES)) {
      expect(name).toMatch(/^[A-Za-z][A-Za-z0-9_]*$/);
      expect(signature.in).toMatch(/^[a-z{}()]*$/);
      expect(signature.out).toMatch(/^[a-z{}()]*$/);
    }
  });

  it.skipIf(!existsSync(INTROSPECTION_XML_PATH))(
    "matches the plugin's introspection XML for every method the proxy calls",
    () => {
      const declared = parseIntrospectionMethods(
        readFileSync(INTROSPECTION_XML_PATH, "utf8"),
        COMPUTER_INTERFACE,
      );
      // The plugin may export more than the proxy calls; the proxy must not
      // call anything the plugin does not export, or with other types.
      const called = Object.fromEntries(
        Object.keys(COMPUTER_PLUGIN_METHOD_SIGNATURES).map((name) => [name, declared[name]]),
      );
      expect(called).toEqual(COMPUTER_PLUGIN_METHOD_SIGNATURES);
    },
  );
});
