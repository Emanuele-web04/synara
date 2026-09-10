import CoreGraphics
import Foundation

/// AX heuristics are allowed only when WindowServer identity is unavailable.
enum WindowIdentityMatcher {
  static func match<Candidate>(
    _ candidates: [Candidate], id: UInt32, title: String, bounds: CGRect,
    identifier: (Candidate) -> UInt32?,
    candidateTitle: (Candidate) -> String?, frame: (Candidate) -> CGRect?
  ) -> Candidate? {
    var unidentified: [Candidate] = []
    for candidate in candidates {
      if let candidateID = identifier(candidate), candidateID != 0 {
        if candidateID == id { return candidate }
      } else {
        unidentified.append(candidate)
      }
    }
    if !title.isEmpty {
      let titled = unidentified.filter { candidateTitle($0) == title }
      if titled.count == 1 { return titled[0] }
    }
    var best: Candidate?
    var bestArea: CGFloat = 0
    var tied = false
    for candidate in unidentified {
      guard let candidateFrame = frame(candidate) else { continue }
      let overlap = candidateFrame.intersection(bounds)
      guard !overlap.isNull else { continue }
      let area = overlap.width * overlap.height
      if area > bestArea {
        best = candidate
        bestArea = area
        tied = false
      } else if area > 0, area == bestArea {
        tied = true
      }
    }
    return tied ? nil : best
  }
}
