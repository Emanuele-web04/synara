import Foundation

/// A failed refresh must never turn invalid geometry into a usable fallback.
/// Tickets also prevent an old asynchronous callback from undoing invalidation.
final class GeometrySnapshotCache<Value> {
  struct Ticket {
    fileprivate let generation: UInt64
    fileprivate let signature: String
  }
  private let lock = NSLock()
  private let ttl: UInt64
  private var generation: UInt64 = 0
  private var signature: String?
  private var value: Value?
  private var storedAt: UInt64 = 0

  init(ttl: UInt64) { self.ttl = ttl }

  private func observe(_ signature: String?) {
    if self.signature != signature {
      self.signature = signature
      generation &+= 1
      value = nil
    }
  }

  func ticket(signature: String?) -> Ticket? {
    lock.lock(); defer { lock.unlock() }
    observe(signature)
    guard let signature else { return nil }
    return Ticket(generation: generation, signature: signature)
  }

  func read(signature: String?, now: UInt64) -> Value? {
    lock.lock(); defer { lock.unlock() }
    observe(signature)
    guard signature != nil, now >= storedAt, now - storedAt <= ttl else { return nil }
    return value
  }

  func store(_ value: Value, ticket: Ticket, now: UInt64) {
    lock.lock(); defer { lock.unlock() }
    guard ticket.generation == generation, ticket.signature == signature else { return }
    self.value = value
    storedAt = now
  }

  func invalidate() {
    lock.lock(); defer { lock.unlock() }
    generation &+= 1
    value = nil
  }
}
