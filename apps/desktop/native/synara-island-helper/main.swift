import AppKit
import Foundation

@main
@MainActor
struct SynaraIslandHelper {
    static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)

        let arguments = CommandLine.arguments
        let usesStdioProtocol = arguments.contains("--stdio-jsonl")
        let presentation = parsePresentation(arguments)
        let controller = IslandPanelController(
            initialPresentation: presentation,
            sessions: usesStdioProtocol ? [] : IslandFixtures.sessions,
            liveMode: usesStdioProtocol
        )

        app.finishLaunching()
        if usesStdioProtocol {
            let runtime = IslandProtocolRuntime(panelController: controller)
            runtime.start()
            withExtendedLifetime((controller, runtime)) {
                app.run()
            }
        } else {
            controller.show()
            withExtendedLifetime(controller) {
                app.run()
            }
        }
    }

    private static func parsePresentation(_ arguments: [String]) -> IslandPresentation {
        guard let previewIndex = arguments.firstIndex(of: "--preview"),
              arguments.indices.contains(previewIndex + 1),
              let presentation = IslandPresentation(rawValue: arguments[previewIndex + 1])
        else {
            return .collapsed
        }
        return presentation
    }
}
