import Foundation

func normalizedElementIndexArgument(_ value: Any?) -> String? {
    if let string = value as? String {
        return string.isEmpty ? nil : string
    }

    if let integer = value as? Int {
        return String(integer)
    }

    if let number = value as? NSNumber {
        if CFGetTypeID(number as CFTypeRef) == CFBooleanGetTypeID() {
            return nil
        }

        return normalizedElementIndexNumber(number.doubleValue)
    }

    if let double = value as? Double {
        return normalizedElementIndexNumber(double)
    }

    return nil
}

private func normalizedElementIndexNumber(_ value: Double) -> String? {
    guard value.isFinite, value.rounded(.towardZero) == value else {
        return nil
    }

    guard value >= Double(Int.min), value <= Double(Int.max) else {
        return nil
    }

    return String(Int(value))
}

public final class ComputerUseToolDispatcher {
    private let service: ComputerUseService

    public init(service: ComputerUseService = ComputerUseService()) {
        self.service = service
    }

    public func callTool(name: String, arguments: [String: Any]) throws -> ToolCallResult {
        switch name {
        case "list_apps":
            return service.listApps()
        case "get_app_state":
            return try service.getAppState(app: requireString("app", in: arguments))
        case "click":
            return try service.click(
                app: requireString("app", in: arguments),
                elementIndex: optionalElementIndex(in: arguments),
                x: optionalDouble("x", in: arguments),
                y: optionalDouble("y", in: arguments),
                clickCount: Int(optionalDouble("click_count", in: arguments) ?? 1),
                mouseButton: optionalString("mouse_button", in: arguments) ?? "left"
            )
        case "perform_secondary_action":
            return try service.performSecondaryAction(
                app: requireString("app", in: arguments),
                elementIndex: requireElementIndex(in: arguments),
                action: requireString("action", in: arguments)
            )
        case "scroll":
            return try service.scroll(
                app: requireString("app", in: arguments),
                direction: requireString("direction", in: arguments),
                elementIndex: requireElementIndex(in: arguments),
                pages: optionalDouble("pages", in: arguments) ?? 1
            )
        case "run_sequence":
            return try runSequence(
                calls: requireCallSequence(in: arguments),
                interCallDelay: optionalDouble("sleep", in: arguments) ?? openComputerUseDefaultInterCallDelay
            )
        case "drag":
            return try service.drag(
                app: requireString("app", in: arguments),
                fromX: requireDouble("from_x", in: arguments),
                fromY: requireDouble("from_y", in: arguments),
                toX: requireDouble("to_x", in: arguments),
                toY: requireDouble("to_y", in: arguments)
            )
        case "type_text":
            return try service.typeText(
                app: requireString("app", in: arguments),
                text: requireString("text", in: arguments)
            )
        case "press_key":
            return try service.pressKey(
                app: requireString("app", in: arguments),
                key: requireString("key", in: arguments)
            )
        case "set_value":
            return try service.setValue(
                app: requireString("app", in: arguments),
                elementIndex: requireElementIndex(in: arguments),
                value: requireString("value", in: arguments)
            )
        default:
            throw ComputerUseError.unsupportedTool(name)
        }
    }

    public func callToolAsResult(name: String, arguments: [String: Any]) -> ToolCallResult {
        do {
            return try callTool(name: name, arguments: arguments)
        } catch let error as ComputerUseError {
            return ToolCallResult.text(
                error.errorDescription ?? String(describing: error),
                isError: error.toolResultIsError
            )
        } catch {
            let message = (error as? LocalizedError)?.errorDescription ?? String(describing: error)
            return ToolCallResult.text(message, isError: true)
        }
    }

    private func requireString(_ key: String, in arguments: [String: Any]) throws -> String {
        guard let value = arguments[key] as? String, !value.isEmpty else {
            throw ComputerUseError.missingArgument(key)
        }

        return value
    }

    private func optionalString(_ key: String, in arguments: [String: Any]) -> String? {
        arguments[key] as? String
    }

    private func requireElementIndex(in arguments: [String: Any]) throws -> String {
        guard let value = optionalElementIndex(in: arguments) else {
            throw ComputerUseError.missingArgument("element_index")
        }

        return value
    }

    private func optionalElementIndex(in arguments: [String: Any]) -> String? {
        normalizedElementIndexArgument(arguments["element_index"])
    }

    private func requireDouble(_ key: String, in arguments: [String: Any]) throws -> Double {
        guard let value = optionalDouble(key, in: arguments) else {
            throw ComputerUseError.missingArgument(key)
        }

        return value
    }

    private func optionalDouble(_ key: String, in arguments: [String: Any]) -> Double? {
        if let double = arguments[key] as? Double {
            return double
        }

        if let integer = arguments[key] as? Int {
            return Double(integer)
        }

        if let number = arguments[key] as? NSNumber {
            return number.doubleValue
        }

        return nil
    }

    private func requireCallSequence(in arguments: [String: Any]) throws -> [WandyCallSpec] {
        guard let rawCalls = arguments["calls"] as? [Any], !rawCalls.isEmpty else {
            throw ComputerUseError.missingArgument("calls")
        }

        return try rawCalls.enumerated().map { index, item in
            guard let dictionary = item as? [String: Any] else {
                throw ComputerUseError.invalidArguments("run_sequence item #\(index + 1) must be an object")
            }

            guard let tool = (dictionary["tool"] ?? dictionary["name"]) as? String, !tool.isEmpty else {
                throw ComputerUseError.invalidArguments("run_sequence item #\(index + 1) requires a non-empty tool")
            }

            guard tool != "run_sequence" else {
                throw ComputerUseError.invalidArguments("run_sequence cannot contain another run_sequence call")
            }

            let rawArguments = dictionary["args"] ?? dictionary["arguments"] ?? [:]
            guard let callArguments = rawArguments as? [String: Any] else {
                throw ComputerUseError.invalidArguments("run_sequence item #\(index + 1) args must be an object")
            }

            return WandyCallSpec(tool: tool, arguments: callArguments)
        }
    }

    private func runSequence(calls: [WandyCallSpec], interCallDelay: TimeInterval) throws -> ToolCallResult {
        guard interCallDelay >= 0, interCallDelay.isFinite else {
            throw ComputerUseError.invalidArguments("sleep must be a non-negative number of seconds")
        }

        var summaries: [[String: Any]] = []
        var hasToolError = false

        for (index, call) in calls.enumerated() {
            let result = callToolAsResult(name: call.tool, arguments: call.arguments)
            summaries.append([
                "tool": call.tool,
                "isError": result.isError,
                "text": result.primaryText ?? "",
            ])

            if result.isError {
                hasToolError = true
                break
            }

            if index < calls.count - 1, interCallDelay > 0 {
                Thread.sleep(forTimeInterval: interCallDelay)
            }
        }

        let data = try JSONSerialization.data(
            withJSONObject: [
                "completed": summaries.count,
                "requested": calls.count,
                "results": summaries,
            ],
            options: [.withoutEscapingSlashes]
        )
        let text = String(data: data, encoding: .utf8) ?? "{}"

        return ToolCallResult.text(text, isError: hasToolError)
    }
}

public struct WandyCallSpec {
    public let tool: String
    public let arguments: [String: Any]

    public init(tool: String, arguments: [String: Any]) {
        self.tool = tool
        self.arguments = arguments
    }
}

public struct WandyCallOutput {
    public let jsonObject: Any
    public let hasToolError: Bool

    public init(jsonObject: Any, hasToolError: Bool) {
        self.jsonObject = jsonObject
        self.hasToolError = hasToolError
    }

    public func jsonText() throws -> String {
        let data = try JSONSerialization.data(
            withJSONObject: jsonObject,
            options: [.prettyPrinted, .withoutEscapingSlashes]
        )
        guard let text = String(data: data, encoding: .utf8) else {
            throw ComputerUseError.message("Failed to encode call output as JSON.")
        }
        return text
    }
}

public typealias WandySleepHandler = (TimeInterval) -> Void

public func runWandyCall(
    _ invocation: WandyCallInvocation,
    service: ComputerUseService = ComputerUseService(),
    sleepHandler: WandySleepHandler = { Thread.sleep(forTimeInterval: $0) }
) throws -> WandyCallOutput {
    let dispatcher = ComputerUseToolDispatcher(service: service)

    switch invocation {
    case let .single(toolName, argumentsJSON, argumentsFile):
        let arguments = try readWandyToolArguments(
            json: argumentsJSON,
            file: argumentsFile
        )
        let result = dispatcher.callToolAsResult(name: toolName, arguments: arguments)
        return WandyCallOutput(
            jsonObject: result.asDictionary,
            hasToolError: result.isError
        )

    case let .sequence(callsJSON, callsFile, interCallDelay):
        let calls = try readWandyCallSequence(json: callsJSON, file: callsFile)
        var outputs: [[String: Any]] = []
        var hasToolError = false

        for (index, call) in calls.enumerated() {
            let result = dispatcher.callToolAsResult(name: call.tool, arguments: call.arguments)
            outputs.append([
                "tool": call.tool,
                "result": result.asDictionary,
            ])

            if result.isError {
                hasToolError = true
                break
            }

            if index < calls.count - 1, interCallDelay > 0 {
                sleepHandler(interCallDelay)
            }
        }

        return WandyCallOutput(jsonObject: outputs, hasToolError: hasToolError)
    }
}

public func readWandyToolArguments(
    json: String?,
    file: String?
) throws -> [String: Any] {
    guard let source = try readWandyJSONSource(json: json, file: file) else {
        return [:]
    }

    let object = try decodeWandyJSONObject(source)
    guard let arguments = object as? [String: Any] else {
        throw WandyCLIError(message: "--args must be a JSON object", helpCommand: "call")
    }

    return arguments
}

public func readWandyCallSequence(
    json: String?,
    file: String?
) throws -> [WandyCallSpec] {
    guard let source = try readWandyJSONSource(json: json, file: file) else {
        throw WandyCLIError(message: "call sequence requires --calls or --calls-file", helpCommand: "call")
    }

    let object = try decodeWandyJSONObject(source)
    guard let array = object as? [Any] else {
        throw WandyCLIError(message: "--calls must be a JSON array", helpCommand: "call")
    }

    return try array.enumerated().map { index, item in
        guard let dictionary = item as? [String: Any] else {
            throw WandyCLIError(
                message: "call sequence item #\(index + 1) must be a JSON object",
                helpCommand: "call"
            )
        }

        guard let tool = (dictionary["tool"] ?? dictionary["name"]) as? String, !tool.isEmpty else {
            throw WandyCLIError(
                message: "call sequence item #\(index + 1) requires a non-empty tool",
                helpCommand: "call"
            )
        }

        let rawArguments = dictionary["args"] ?? dictionary["arguments"] ?? [:]
        guard let arguments = rawArguments as? [String: Any] else {
            throw WandyCLIError(
                message: "call sequence item #\(index + 1) args must be a JSON object",
                helpCommand: "call"
            )
        }

        return WandyCallSpec(tool: tool, arguments: arguments)
    }
}

private func readWandyJSONSource(json: String?, file: String?) throws -> String? {
    if json != nil, file != nil {
        throw WandyCLIError(message: "Use either inline JSON or a JSON file, not both", helpCommand: "call")
    }

    if let json {
        return json
    }

    guard let file else {
        return nil
    }

    do {
        return try String(contentsOfFile: file, encoding: .utf8)
    } catch {
        throw WandyCLIError(
            message: "Unable to read JSON file \(file): \(error.localizedDescription)",
            helpCommand: "call"
        )
    }
}

private func decodeWandyJSONObject(_ source: String) throws -> Any {
    guard let data = source.data(using: .utf8) else {
        throw WandyCLIError(message: "JSON input must be UTF-8 text", helpCommand: "call")
    }

    do {
        return try JSONSerialization.jsonObject(with: data)
    } catch {
        throw WandyCLIError(
            message: "Invalid JSON input: \(error.localizedDescription)",
            helpCommand: "call"
        )
    }
}
