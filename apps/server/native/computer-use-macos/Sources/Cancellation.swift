import Foundation

/// Cancellation arrives on stdin, independently of the serial input lane. The
/// request retains its token until it has released any held keys/buttons.
enum InputCancellation {
  final class Token {
    private let lock = NSLock()
    private var cancelled = false
    func cancel() { lock.lock(); cancelled = true; lock.unlock() }
    func check() throws {
      lock.lock(); let stopped = cancelled; lock.unlock()
      if stopped { throw RPCError(.notDelivered, "Computer operation cancelled") }
    }
  }
  private static let lock = NSLock()
  private static var requests: [String: Token] = [:]
  private static let threadKey = "synara.inputCancellation"
  private static func key(_ id: Any?) -> String { String(describing: id ?? NSNull()) }
  static func register(_ id: Any?) -> Token {
    let token = Token()
    lock.lock(); requests[key(id)] = token; lock.unlock()
    return token
  }
  static func enter(_ token: Token) { Thread.current.threadDictionary[threadKey] = token }
  static func check() throws { try (Thread.current.threadDictionary[threadKey] as? Token)?.check() }
  static func cancel(_ id: Any?) {
    lock.lock(); let token = requests[key(id)]; lock.unlock()
    token?.cancel()
  }
  static func finish(_ id: Any?) {
    Thread.current.threadDictionary.removeObject(forKey: threadKey)
    lock.lock(); requests.removeValue(forKey: key(id)); lock.unlock()
  }
}
