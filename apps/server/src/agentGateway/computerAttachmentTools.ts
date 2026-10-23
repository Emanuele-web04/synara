/**
 * File attachment admission and routing, not a third input backend.
 * Explicit surfaces keep tab/ref dialects separate. Delegation preserves each
 * engine's approval, cancellation, idempotency, audit and workspace enforcement.
 */
import { lstat, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { Effect } from "effect";
import { mcpToolResultJson, type McpToolCallResult } from "./protocol.ts";
import {
  GatewayToolError,
  gatewayToolErrorResult,
  WRITE_TOOL_ANNOTATIONS,
  type ToolContext,
  type ToolEntry,
} from "./toolRuntime.ts";

const MAX_FILES = 32;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const TARGET_FIELDS = ["surface", "target_id", "tab_id", "ref", "selector"] as const;
const ALLOWED_FIELDS = new Set<string>(["action", "files", ...TARGET_FIELDS]);

interface AttachmentFile {
  readonly path: string;
  readonly relativePath: string;
  readonly name: string;
  readonly byteLength: number;
}

function invalid(message: string): never {
  throw new GatewayToolError("attachment_invalid_input", message);
}

function containedPath(root: string, path: string): string {
  const rel = relative(root, path);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    invalid("Files must be regular files inside the active workspace.");
  }
  return rel;
}

/** Metadata-only preflight. Hosts still revalidate immediately before input.
 * Reject symlink components, directories, special files, duplicate canonical
 * paths and excessive payloads without opening or reading file contents.
 */
export async function inspectAttachmentFiles(
  workspaceRoot: string,
  rawFiles: unknown,
  signal?: AbortSignal,
): Promise<readonly AttachmentFile[]> {
  if (!Array.isArray(rawFiles) || rawFiles.length < 1 || rawFiles.length > MAX_FILES) {
    invalid("files must contain 1–32 workspace paths.");
  }
  const root = await realpath(workspaceRoot);
  const files: AttachmentFile[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const raw of rawFiles) {
    signal?.throwIfAborted();
    if (typeof raw !== "string" || !raw.trim() || raw.length > 4096 || raw.includes("\0")) {
      invalid("Each file path must be nonempty text without NUL, at most 4096 characters.");
    }
    // Accept absolute paths under either the original or canonical workspace.
    const inputRoot =
      isAbsolute(raw) && !relative(root, raw).startsWith(`..${sep}`)
        ? root
        : resolve(workspaceRoot);
    const rel = containedPath(inputRoot, resolve(inputRoot, raw));
    const path = resolve(root, rel);
    let current = root;
    for (const part of rel.split(sep)) {
      current = resolve(current, part);
      if ((await lstat(current)).isSymbolicLink()) {
        invalid("Symlink files and directories are not supported for attachments.");
      }
    }
    const canonical = await realpath(path);
    containedPath(root, canonical);
    const info = await lstat(canonical);
    if (!info.isFile())
      invalid("Attachment paths must name regular files, not directories or devices.");
    if (seen.has(canonical)) invalid("The same file cannot be attached twice in one call.");
    seen.add(canonical);
    totalBytes += info.size;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_TOTAL_BYTES) {
      invalid("Attachments exceed the 256 MiB per-call limit.");
    }
    files.push({
      path: canonical,
      relativePath: containedPath(root, canonical),
      name: basename(canonical),
      byteLength: info.size,
    });
  }
  signal?.throwIfAborted();
  return files;
}

function requiredString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || !value.trim() || value.length > 4096) {
    invalid(`${name} must be nonempty text, at most 4096 characters.`);
  }
  return value;
}

export function makeComputerAttachmentTools(options: {
  readonly browserTools: readonly ToolEntry[];
  readonly computerBrowserTools: readonly ToolEntry[];
  readonly resolveWorkspaceRoot: (context: ToolContext) => Effect.Effect<string | null>;
}): readonly ToolEntry[] {
  const integrated = options.browserTools.find((tool) => tool.definition.name === "browser_upload");
  const computer = options.computerBrowserTools.find(
    (tool) => tool.definition.name === "computer_browser_upload",
  );
  return [
    {
      requiredCapability: "computer:control",
      requiresActiveTurn: true,
      discoveryOnly: true,
      definition: {
        name: "computer_attach_files",
        description:
          "Inspect or attach 1–32 regular workspace files, up to 256 MiB total, without the clipboard. inspect reads metadata only. attach requires an explicit browser surface, tab_id and observed file input: selector for integrated_browser; target_id plus ref for computer_browser. Existing route approvals apply; integrated_browser additionally needs browser:control. Never submits a form, launches a browser or switches profiles. Selection is not application upload acceptance; inspect the preview before separately authorized submission. Native OS file pickers are unsupported; use an observed app upload control rather than pasting a filename.",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["inspect", "attach"] },
            files: {
              type: "array",
              minItems: 1,
              maxItems: MAX_FILES,
              items: { type: "string", minLength: 1, maxLength: 4096 },
            },
            surface: { type: "string", enum: ["integrated_browser", "computer_browser"] },
            target_id: { type: "string" },
            tab_id: { type: "string" },
            ref: { type: "string" },
            selector: { type: "string" },
          },
          required: ["action", "files"],
          additionalProperties: false,
        },
        annotations: {
          title: "Attach workspace files",
          ...WRITE_TOOL_ANNOTATIONS,
          openWorldHint: true,
        },
      },
      handler: (args, context) =>
        Effect.gen(function* () {
          const preparation = yield* Effect.gen(function* () {
            yield* context.assertCallerTurnActive();
            const route = yield* Effect.try({
              try: () => {
                if (!context.callerCapabilities.has("computer:control") || !context.callerTurnId) {
                  throw new GatewayToolError(
                    "capability_denied",
                    "An active computer-control turn is required.",
                  );
                }
                if (Object.keys(args).some((key) => !ALLOWED_FIELDS.has(key)))
                  invalid("Unknown attachment argument.");
                if (args.action === "inspect") {
                  if (TARGET_FIELDS.some((key) => args[key] !== undefined))
                    invalid("inspect accepts files only; it cannot select a target.");
                  return undefined;
                }
                if (args.action !== "attach") invalid("action must be inspect or attach.");
                const tabId = requiredString(args, "tab_id");
                if (args.surface !== "integrated_browser" && args.surface !== "computer_browser") {
                  invalid(
                    "Choose an explicit supported browser surface. Native file pickers are unsupported.",
                  );
                }
                const delegate = args.surface === "integrated_browser" ? integrated : computer;
                if (!delegate)
                  throw new GatewayToolError(
                    "attachment_surface_unavailable",
                    "This browser surface is not available; no fallback was attempted.",
                  );
                if (!context.callerCapabilities.has(delegate.requiredCapability)) {
                  throw new GatewayToolError(
                    "capability_denied",
                    "The selected browser surface requires its own capability.",
                  );
                }
                if (args.surface === "integrated_browser") {
                  if (args.target_id !== undefined || args.ref !== undefined)
                    invalid("Integrated targets use selector, not driver refs.");
                  return {
                    delegate,
                    surface: args.surface,
                    args: { tabId, target: { selector: requiredString(args, "selector") } },
                  };
                }
                if (args.selector !== undefined)
                  invalid("Computer browser targets use observed refs, not selectors.");
                return {
                  delegate,
                  surface: args.surface,
                  args: {
                    tab_id: tabId,
                    target_id: requiredString(args, "target_id"),
                    ref: requiredString(args, "ref"),
                  },
                };
              },
              catch: (error) =>
                error instanceof GatewayToolError
                  ? error
                  : new GatewayToolError(
                      "attachment_invalid_input",
                      "Invalid attachment arguments.",
                    ),
            });
            const workspaceRoot = yield* options.resolveWorkspaceRoot(context);
            if (!workspaceRoot?.trim()) {
              return yield* Effect.fail(
                new GatewayToolError(
                  "attachment_workspace_unavailable",
                  "No active workspace is available.",
                ),
              );
            }
            const files = yield* Effect.tryPromise({
              try: (signal) => inspectAttachmentFiles(workspaceRoot, args.files, signal),
              catch: (error) =>
                error instanceof GatewayToolError
                  ? error
                  : new GatewayToolError(
                      "attachment_file_unavailable",
                      "A file is missing, unreadable or changed during preflight.",
                    ),
            });
            yield* context.assertCallerTurnActive();
            return { route, files };
          }).pipe(
            Effect.map((value) => ({ ok: true as const, value })),
            Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
          );
          if (!preparation.ok) return gatewayToolErrorResult(preparation.error);
          const { route, files } = preparation.value;
          const metadata = files.map(({ name, byteLength }) => ({ name, byteLength }));
          if (!route) {
            return mcpToolResultJson({
              status: "inspected",
              effect: "not-dispatched",
              files: metadata,
              totalBytes: files.reduce((total, file) => total + file.byteLength, 0),
              note: "Metadata preflight only, not a reservation, target check or upload. The host revalidates on attach.",
            });
          }
          // Do not catch a post-dispatch failure as a preflight refusal, or race the
          // underlying operation with a timer that could release its input lease.
          const result: McpToolCallResult = yield* route.delegate.handler(
            {
              ...route.args,
              ...(route.surface === "integrated_browser"
                ? { paths: files.map((file) => file.relativePath) }
                : { files: files.map((file) => file.path) }),
            },
            context,
          );
          if (result.isError || result.structuredContent?.status === "refused") return result;
          const selectedFiles = result.structuredContent?.files;
          const selectionVerified =
            route.surface === "integrated_browser" &&
            result.structuredContent?.selectionVerified === true &&
            Array.isArray(selectedFiles) &&
            selectedFiles.length === metadata.length &&
            selectedFiles.every(
              (file: unknown, index: number) =>
                typeof file === "object" &&
                file !== null &&
                "name" in file &&
                file.name === metadata[index]!.name &&
                "byteLength" in file &&
                file.byteLength === metadata[index]!.byteLength,
            );
          const attachmentReceipt = {
            surface: route.surface,
            requestedFiles: metadata,
            selection: selectionVerified ? "verified-file-input" : "unverified",
            applicationAcceptance: "unverified",
            note: "No separate submit action was sent. Selection itself may start an upload. Inspect the application's preview/status; do not blindly repeat uncertain selections.",
          };
          return {
            ...result,
            structuredContent: { ...result.structuredContent, attachmentReceipt },
            content: [
              ...result.content,
              { type: "text" as const, text: JSON.stringify({ attachmentReceipt }) },
            ],
          };
        }),
    },
  ];
}
