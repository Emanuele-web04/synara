import Darwin
import Foundation

final class ParentProcessMonitor {
    private let originalParentProcessIdentifier = getppid()
    private var timer: Timer?

    func start() {
        guard originalParentProcessIdentifier > 1 else {
            exit(EXIT_SUCCESS)
        }

        timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            self?.exitIfParentStopped()
        }
        exitIfParentStopped()
    }

    private func exitIfParentStopped() {
        if getppid() != originalParentProcessIdentifier {
            exit(EXIT_SUCCESS)
        }

        if Darwin.kill(originalParentProcessIdentifier, 0) != 0, errno == ESRCH {
            exit(EXIT_SUCCESS)
        }
    }
}
