import CoreGraphics
import Foundation

/// US-ANSI key-name → virtual keycode map, plus modifier handling.
///
/// Named keys (enter, tab, arrows, function keys) need real keycodes so
/// modifiers and shortcuts dispatch; single printable characters map through the
/// same table where they are ANSI, and fall back to the Unicode-string path in
/// `typeText` for anything else (layout-independent, no AZERTY/Dvorak handling).
enum KeyMap {
  private static let named: [String: CGKeyCode] = [
    "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51,
    "escape": 53, "esc": 53, "forwarddelete": 117,
    "left": 123, "arrowleft": 123, "right": 124, "arrowright": 124,
    "down": 125, "arrowdown": 125, "up": 126, "arrowup": 126,
    "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100,
    "f9": 101, "f10": 109, "f11": 103, "f12": 111,
  ]

  private static let ansi: [Character: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
    "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
    "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26,
    "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35,
    "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45,
    "m": 46, ".": 47, "`": 50,
  ]

  /// Whitespace as literal characters. A typed line is mostly these, and they
  /// live here rather than in `ansi` so there is one table to consult whether
  /// the caller spelled the key ("space") or passed the character itself.
  private static let whitespace: [Character: CGKeyCode] = [
    "\n": 36, "\r": 36, "\t": 48, " ": 49,
  ]

  /// The US-layout characters produced by holding shift over another key.
  ///
  /// Shift state cannot be inferred from the character for these the way it can
  /// for a letter: `!` is already its own lowercase, so the "is it uppercase"
  /// test says no shift, and the character is in neither `named` nor `ansi`. The
  /// result was keycode 0 — the `A` key — for every symbol on this row, so an
  /// email address typed through the foreground route arrived as `robertaexample`.
  private static let shiftedAnsi: [Character: CGKeyCode] = [
    "!": 18, "@": 19, "#": 20, "$": 21, "%": 23, "^": 22, "&": 26, "*": 28, "(": 25, ")": 29,
    "_": 27, "+": 24, "{": 33, "}": 30, "|": 42, ":": 41, "\"": 39, "<": 43, ">": 47, "?": 44,
    "~": 50,
  ]

  /// Left-hand modifier keycodes with the flag each one asserts.
  private static let modifiers: [String: (code: CGKeyCode, flags: CGEventFlags)] = [
    "cmd": (55, .maskCommand), "command": (55, .maskCommand), "meta": (55, .maskCommand),
    "super": (55, .maskCommand), "win": (55, .maskCommand),
    "shift": (56, .maskShift),
    "alt": (58, .maskAlternate), "option": (58, .maskAlternate), "opt": (58, .maskAlternate),
    "ctrl": (59, .maskControl), "control": (59, .maskControl),
    "fn": (63, .maskSecondaryFn),
  ]

  /// Left shift, for the foreground typing path, which asserts it directly
  /// rather than going through the caller-supplied modifier list.
  static let shiftModifier: (code: CGKeyCode, flags: CGEventFlags) = (56, .maskShift)

  static func modifierFlag(for code: CGKeyCode) -> CGEventFlags {
    modifiers.values.first { $0.code == code }?.flags ?? []
  }

  static func isModifier(_ key: String) -> Bool {
    modifiers[key.lowercased()] != nil
  }

  /// Every named modifier, or an error naming the first one this map does not
  /// know.
  ///
  /// Dropping the unknown ones — which `compactMap` did silently — turned
  /// `["hyper", "cmd"] + "a"` into plain `cmd+a` and reported it as delivered,
  /// so the agent believed a chord it never sent had run. A modifier the helper
  /// cannot express is a bad request, not a smaller chord.
  static func modifierCodes(for names: [String]) throws -> [(code: CGKeyCode, flags: CGEventFlags)] {
    try names.map { name in
      guard let modifier = modifiers[name.lowercased()] else {
        throw RPCError(.invalidParams, "unknown modifier '\(name)'")
      }
      return modifier
    }
  }

  /// The names a *pointer* gesture may hold, and only these four.
  ///
  /// Deliberately narrower than `modifierCodes`: the wire contract for a gesture
  /// modifier (`ComputerInputModifier`, packages/contracts/src/computer.ts) is
  /// exactly `ctrl | alt | shift | meta`, so an alias the chord path accepts —
  /// `cmd`, `option`, `fn` — is a name no legitimate caller of a pointer method
  /// sends, and quietly honouring it would let two spellings of one request
  /// drift apart. The keycodes still come from the one table above, so there is
  /// no second copy of them to go stale.
  private static let pointerModifierNames: Set<String> = ["ctrl", "alt", "shift", "meta"]

  /// Every named pointer modifier, or an error naming the first one this map
  /// does not know.
  ///
  /// An unknown name is a bad request rather than a smaller gesture that quietly
  /// runs — the same rule `modifierCodes` follows for chords, and for the same
  /// reason: a Command-click silently demoted to a plain click is a *different*
  /// action on almost every surface, and the agent would be told the one it
  /// asked for had happened. Duplicates are dropped instead, because
  /// `["shift", "shift"]` is one key however many times it was named, and
  /// pressing it twice would leave one down after the release.
  static func pointerModifiers(for names: [String]) throws -> [(
    code: CGKeyCode, flags: CGEventFlags
  )] {
    var seen: Set<CGKeyCode> = []
    var strokes: [(code: CGKeyCode, flags: CGEventFlags)] = []
    for name in names {
      let lowered = name.lowercased()
      guard pointerModifierNames.contains(lowered), let modifier = modifiers[lowered] else {
        throw RPCError(
          .invalidParams,
          "'\(name)' is not a pointer modifier this helper knows; "
            + "use ctrl, alt, shift or meta")
      }
      guard seen.insert(modifier.code).inserted else { continue }
      strokes.append(modifier)
    }
    return strokes
  }

  /// A single character is looked up as itself; only a spelled-out key *name* is
  /// trimmed and lowercased.
  ///
  /// Trimming first is what broke typing: `" "` trimmed to the empty string,
  /// matched nothing, and every space in a line went out as keycode 0 — the `A`
  /// key — so `hello world` arrived as `helloaworld`.
  static func code(for key: String) -> CGKeyCode? {
    if key.count == 1, let character = key.first {
      return keystroke(for: character)?.code
    }
    let trimmed = key.trimmingCharacters(in: .whitespaces).lowercased()
    if let named = named[trimmed] { return named }
    if trimmed.count == 1, let character = trimmed.first { return keystroke(for: character)?.code }
    return nil
  }

  static func chord(for key: String, modifiers names: [String]) throws -> (
    code: CGKeyCode, modifiers: [(code: CGKeyCode, flags: CGEventFlags)]
  ) {
    guard let code = code(for: key) else {
      throw RPCError(.invalidParams, "unknown key '\(key)'")
    }
    var modifiers = try modifierCodes(for: names)
    let printable = key.count == 1 ? key : key.trimmingCharacters(in: .whitespaces)
    if printable.count == 1, let character = printable.first,
      keystroke(for: character)?.shift == true
    {
      modifiers.append(shiftModifier)
    }
    var seen: Set<CGKeyCode> = []
    return (code, modifiers.filter { seen.insert($0.code).inserted })
  }

  /// The physical key and shift state that produces `character` on a US layout,
  /// or nil for anything the ANSI tables cannot express — an accented or CJK
  /// character — which the caller sends as a Unicode payload instead.
  static func keystroke(for character: Character) -> (code: CGKeyCode, shift: Bool)? {
    if let code = whitespace[character] { return (code, false) }
    if let code = ansi[character] { return (code, false) }
    if let code = shiftedAnsi[character] { return (code, true) }
    // Upper case is the one shift relationship worth deriving rather than
    // tabulating. Guarded on a single-scalar lowercase, because some scripts
    // lower one character into two.
    let lowered = String(character).lowercased()
    if lowered.count == 1, let single = lowered.first, single != character,
      let code = ansi[single]
    {
      return (code, true)
    }
    return nil
  }
}
