import CoreGraphics
import Foundation

@main
struct InputDeliveryStateTests {
  final class Log: @unchecked Sendable {
    private let lock = NSLock()
    private var entries: [String] = []
    func append(_ entry: String) { lock.lock(); defer { lock.unlock() }; entries.append(entry) }
    var snapshot: [String] { lock.lock(); defer { lock.unlock() }; return entries }
  }

  static func main() throws {
    // Block *inside* a down post, then race shutdown against registration of
    // its up. There must be no gap in which shutdown can miss the held key.
    let state = InputDeliveryState<String>()
    let log = Log()
    let entered = DispatchSemaphore(value: 0)
    let resume = DispatchSemaphore(value: 0)
    let stopping = DispatchSemaphore(value: 0)
    let stopped = DispatchSemaphore(value: 0)
    let posting = DispatchGroup()
    let target = "pid:123/window:42"
    try state.acquire("shift") {
      log.append("shift-down@\(target)")
      return { log.append("shift-up@\(target)") }
    }
    posting.enter()
    DispatchQueue.global().async {
      defer { posting.leave() }
      do {
        try state.acquire("A") {
          log.append("A-down@\(target)")
          entered.signal()
          precondition(resume.wait(timeout: .now() + 5) == .success)
          return { log.append("A-up@\(target)") }
        }
      } catch { fatalError("Unexpected post failure: \(error)") }
    }
    precondition(entered.wait(timeout: .now() + 5) == .success)
    DispatchQueue.global().async {
      stopping.signal()
      state.stop()
      stopped.signal()
    }
    precondition(stopping.wait(timeout: .now() + 5) == .success)
    precondition(stopped.wait(timeout: .now() + .milliseconds(20)) == .timedOut,
      "Shutdown passed an in-flight down before its release was registered")
    resume.signal()
    precondition(stopped.wait(timeout: .now() + 5) == .success)
    precondition(posting.wait(timeout: .now() + 5) == .success)
    state.release("A")
    state.releaseAll()
    state.stop()
    precondition(log.snapshot == ["shift-down@\(target)", "A-down@\(target)",
      "A-up@\(target)", "shift-up@\(target)"])
    do {
      try state.acquire("later") { log.append("late down"); return {} }
      fatalError("Down accepted after shutdown")
    } catch InputDeliveryState<String>.Failure.stopped {}
    do { try state.send { fatalError("Move accepted after shutdown") }; fatalError("Send accepted") }
    catch InputDeliveryState<String>.Failure.stopped {}

    // Cancellation is not terminal. Use the real cancellation token inside the
    // real posting gate, then verify release and a later request's recovery.
    let active = InputDeliveryState<String>()
    let token = InputCancellation.register("held", isAction: true)
    try active.acquire("key") {
      try token.check()
      log.append("cancel-down@\(target)")
      return { log.append("cancel-up@\(target)") }
    }
    InputCancellation.cancel("held")
    do {
      try active.acquire("next") { try token.check(); fatalError("Cancelled down posted") }
      fatalError("Cancellation ignored")
    } catch is RPCError {}
    active.releaseAll()
    active.release("key")
    InputCancellation.finish("held")
    try active.acquire("key") { log.append("resumed-down"); return { log.append("resumed-up") } }
    active.release("key")
    precondition(Array(log.snapshot.suffix(4)) == ["cancel-down@\(target)", "cancel-up@\(target)",
      "resumed-down", "resumed-up"])

    // A failed nested gesture must release its button/key before the modifier,
    // but must not undo the enclosing synthetic focus until that scope ends.
    for key in ["focus", "modifier", "ordinary", "button"] {
      try active.acquire(key) { return { log.append("scope-up:\(key)") } }
    }
    active.releaseFrom("modifier")
    precondition(Array(log.snapshot.suffix(3)) == ["scope-up:button", "scope-up:ordinary", "scope-up:modifier"])
    active.releaseAll()
    precondition(log.snapshot.last == "scope-up:focus")

    // Drag cleanup uses the latest stamped location, not a fresh target lookup.
    let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown,
      mouseCursorPosition: CGPoint(x: 10, y: 20), mouseButton: .left)!
    down.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: 42)
    let firstUp = InputReleaseEvent.make(from: down, type: .leftMouseUp)!
    try active.acquire("button") { return { log.append("initial-up@\(firstUp.location)") } }
    let drag = down.copy()!
    drag.type = .leftMouseDragged
    drag.location = CGPoint(x: 50, y: 60)
    drag.setIntegerValueField(.mouseEventDeltaX, value: 40)
    let finalUp = InputReleaseEvent.make(from: drag, type: .leftMouseUp)!
    precondition(finalUp.location == drag.location)
    precondition(finalUp.getIntegerValueField(.mouseEventWindowUnderMousePointer) == 42)
    precondition(finalUp.getIntegerValueField(.mouseEventDeltaX) == 0)
    precondition(finalUp.getDoubleValueField(.mouseEventPressure) == 0)
    try active.update("button", release: { log.append("final-up@\(target)") }) {}
    active.stop()
    active.release("button")
    precondition(log.snapshot.last == "final-up@\(target)")
    precondition(!log.snapshot.contains { $0.hasPrefix("initial-up") })
    print("PASS: concurrent shutdown, original recipient, exactly-once reverse releases, cancellation, drag (no posting)")
  }
}
