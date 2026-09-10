import Foundation

/// Serializes actual event posting with cleanup. Validation and sleeps belong
/// outside this lock. Release handlers retain the original event and recipient;
/// they must post directly and must not call back into this object.
final class InputDeliveryState<Key: Hashable> {
  enum Failure: Error { case stopped, alreadyHeld, notHeld }

  private let lock = NSLock()
  private var stopped = false
  private var order: [Key] = []
  private var releases: [Key: () -> Void] = [:]

  func send(_ post: () throws -> Void) throws {
    lock.lock()
    defer { lock.unlock() }
    guard !stopped else { throw Failure.stopped }
    try post()
  }

  /// The posting and its cleanup registration are one critical section.
  /// Returning nil means no state was acquired, as with a refused focus record.
  func acquire(_ key: Key, _ post: () throws -> (() -> Void)?) throws {
    lock.lock()
    defer { lock.unlock() }
    guard !stopped else { throw Failure.stopped }
    guard releases[key] == nil else { throw Failure.alreadyHeld }
    if let release = try post() {
      releases[key] = release
      order.append(key)
    }
  }

  /// A drag updates the eventual mouse-up location without acquiring a second
  /// button. Shutdown cannot interleave between its post and this update.
  func update(_ key: Key, release: @escaping () -> Void, post: () throws -> Void) throws {
    lock.lock()
    defer { lock.unlock() }
    guard !stopped else { throw Failure.stopped }
    guard releases[key] != nil else { throw Failure.notHeld }
    try post()
    releases[key] = release
  }

  func release(_ key: Key) {
    lock.lock()
    defer { lock.unlock() }
    guard let release = releases.removeValue(forKey: key) else { return }
    order.removeAll { $0 == key }
    release()
  }

  /// End a nested input scope in reverse order, retaining earlier state (for
  /// example synthetic focus). Residual ordinary keys/buttons come up before
  /// their modifiers, including when the body threw before its normal up.
  func releaseFrom(_ key: Key) {
    lock.lock()
    defer { lock.unlock() }
    guard let start = order.firstIndex(of: key) else { return }
    for held in order[start...].reversed() { releases.removeValue(forKey: held)?() }
    order.removeSubrange(start...)
  }

  /// Cancellation ends an operation but permits the next operation to run.
  func releaseAll() {
    lock.lock()
    defer { lock.unlock() }
    releaseAllLocked()
  }

  /// Terminal and idempotent. No post can follow this cleanup, including one
  /// whose caller finished validation before shutdown acquired the lock.
  func stop() {
    lock.lock()
    defer { lock.unlock() }
    stopped = true
    releaseAllLocked()
  }

  private func releaseAllLocked() {
    for key in order.reversed() { releases.removeValue(forKey: key)?() }
    order.removeAll(keepingCapacity: true)
  }
}
