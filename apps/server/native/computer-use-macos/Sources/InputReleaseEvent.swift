import CoreGraphics

enum InputReleaseEvent {
  /// Copy before posting: cleanup must not allocate a missing counterpart later.
  static func make(from event: CGEvent, type: CGEventType) -> CGEvent? {
    guard let up = event.copy() else { return nil }
    up.type = type
    if type == .keyUp {
      let code = CGKeyCode(event.getIntegerValueField(.keyboardEventKeycode))
      up.flags.subtract(KeyMap.modifierFlag(for: code))
    } else {
      up.setIntegerValueField(.mouseEventDeltaX, value: 0)
      up.setIntegerValueField(.mouseEventDeltaY, value: 0)
      up.setDoubleValueField(.mouseEventPressure, value: 0)
    }
    return up
  }
}
