import Foundation

@main
struct WindowIdentityMatcherTests {
  struct Window {
    let label: String
    let id: UInt32?
    var title = "Document"
    var frame = CGRect(x: 10, y: 10, width: 100, height: 100)
  }
  static func main() {
    func match(_ windows: [Window]) -> String? {
      WindowIdentityMatcher.match(
        windows, id: 42, title: "Document", bounds: CGRect(x: 10, y: 10, width: 100, height: 100),
        identifier: { $0.id }, candidateTitle: { $0.title }, frame: { $0.frame })?.label
    }
    let sibling = Window(label: "sibling", id: 43)
    let unknown = Window(label: "unknown", id: nil)
    precondition(match([sibling]) == nil, "Known sibling must never receive the target's tree or writes")
    precondition(match([unknown, sibling, Window(label: "target", id: 42)]) == "target")
    precondition(match([sibling, unknown]) == "unknown", "Keep fallback for AX providers without IDs")
    precondition(match([Window(label: "null ID", id: 0)]) == "null ID")
    precondition(match([unknown, Window(label: "ambiguous", id: nil)]) == nil)
    precondition(match([Window(label: "overlap", id: nil, title: "Other")]) == "overlap")
    precondition(match([Window(label: "remote", id: nil, title: "Other",
      frame: CGRect(x: 500, y: 500, width: 100, height: 100))]) == nil)
    precondition(match([]) == nil)
    print("PASS: authoritative window IDs, unidentified fallback, ambiguous and disjoint windows")
  }
}
