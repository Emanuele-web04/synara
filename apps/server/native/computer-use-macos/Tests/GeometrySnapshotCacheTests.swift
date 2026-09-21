import Foundation

@main
struct GeometrySnapshotCacheTests {
  static func main() {
    let cache = GeometrySnapshotCache<String>(ttl: 10)
    let original = cache.ticket(signature: "window@0,0")!
    cache.store("old frame", ticket: original, now: 100)
    precondition(cache.read(signature: "window@0,0", now: 105) == "old frame")
    precondition(cache.read(signature: "window@50,50", now: 106) == nil)
    // Failed or timed-out refresh has no completion to store. Both callers
    // still read through this same production freshness gate.
    for _ in 0..<2 { precondition(cache.read(signature: "window@50,50", now: 107) == nil) }
    cache.store("late old frame", ticket: original, now: 108)
    precondition(cache.read(signature: "window@50,50", now: 108) == nil)
    precondition(cache.read(signature: "window@0,0", now: 108) == nil)
    cache.store("old callback after round trip", ticket: original, now: 109)
    precondition(cache.read(signature: "window@0,0", now: 109) == nil)
    let refreshed = cache.ticket(signature: "window@0,0")!
    cache.store("fresh frame", ticket: refreshed, now: 110)
    precondition(cache.read(signature: "window@0,0", now: 120) == "fresh frame")
    precondition(cache.read(signature: "window@0,0", now: 121) == nil, "Expired metadata is not a fallback")
    cache.invalidate()
    cache.store("callback after explicit invalidation", ticket: refreshed, now: 122)
    precondition(cache.read(signature: "window@0,0", now: 122) == nil)
    precondition(cache.ticket(signature: nil) == nil)
    precondition(cache.read(signature: nil, now: 123) == nil)
    let recovered = cache.ticket(signature: "new display")!
    cache.store("recovered", ticket: recovered, now: 124)
    precondition(cache.read(signature: "new display", now: 125) == "recovered")
    print("PASS: movement, failed refresh, TTL, late callbacks, invalidation and recovery")
  }
}
