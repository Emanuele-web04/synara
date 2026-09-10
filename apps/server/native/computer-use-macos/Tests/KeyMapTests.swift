import CoreGraphics
import Foundation

@main
struct KeyMapTests {
  static func main() throws {
    for (key, code) in [("!", 18), ("?", 44), ("A", 0), ("~", 50), ("+", 24)] {
      let chord = try KeyMap.chord(for: key, modifiers: [])
      precondition(chord.code == CGKeyCode(code))
      precondition(chord.modifiers.count == 1 && chord.modifiers[0].flags == .maskShift)
      let flags = chord.modifiers.reduce(CGEventFlags()) { $0.union($1.flags) }
      let down = CGEvent(keyboardEventSource: nil, virtualKey: chord.code, keyDown: true)!
      down.flags = flags
      let up = InputReleaseEvent.make(from: down, type: .keyUp)!
      precondition(up.getIntegerValueField(.keyboardEventKeycode) == Int64(code))
      precondition(up.flags == .maskShift && down.type == .keyDown && up.type == .keyUp)
    }
    let explicit = try KeyMap.chord(for: "?", modifiers: ["ctrl", "shift", "control"])
    precondition(explicit.modifiers.map { $0.code } == [59, 56])
    let shortcut = try KeyMap.chord(for: "A", modifiers: ["cmd", "command"])
    precondition(shortcut.modifiers.map { $0.code } == [55, 56])
    for key in ["a", "/", "1", " ", "enter", " F1 "] {
      let chord = try KeyMap.chord(for: key, modifiers: [])
      precondition(chord.modifiers.isEmpty)
    }
    for (key, modifiers) in [("?", ["hyper"]), ("😀", [])] {
      do { _ = try KeyMap.chord(for: key, modifiers: modifiers); fatalError("Invalid chord accepted") }
      catch is RPCError {}
    }
    let shift = CGEvent(keyboardEventSource: nil, virtualKey: 56, keyDown: true)!
    shift.flags = [.maskCommand, .maskShift]
    precondition(InputReleaseEvent.make(from: shift, type: .keyUp)!.flags == .maskCommand)
    print("PASS: printable codes and flags, named keys, modifier deduplication and releases (no posting)")
  }
}
