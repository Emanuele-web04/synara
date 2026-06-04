import { Schema } from "effect";
import { TrimmedString } from "./baseSchemas";
import { DEFAULT_GIT_TEXT_GENERATION_MODEL } from "./model";
import { ModelSelection, ProviderKind, ThreadEnvironmentMode } from "./orchestration";

const StringSetting = TrimmedString.check(Schema.isMaxLength(4096));
const CustomModels = Schema.Array(Schema.String.check(Schema.isMaxLength(256))).pipe(
  Schema.withDecodingDefault(() => []),
);

const ProviderSettingsBase = {
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true)),
  binaryPath: StringSetting.pipe(Schema.withDecodingDefault(() => "")),
  customModels: CustomModels,
};

export const CodexServerProviderSettings = Schema.Struct({
  ...ProviderSettingsBase,
  binaryPath: StringSetting.pipe(Schema.withDecodingDefault(() => "codex")),
  homePath: StringSetting.pipe(Schema.withDecodingDefault(() => "")),
});
export type CodexServerProviderSettings = typeof CodexServerProviderSettings.Type;

export const ClaudeServerProviderSettings = Schema.Struct({
  ...ProviderSettingsBase,
  binaryPath: StringSetting.pipe(Schema.withDecodingDefault(() => "claude")),
  launchArgs: Schema.String.check(Schema.isMaxLength(4096)).pipe(
    Schema.withDecodingDefault(() => ""),
  ),
});
export type ClaudeServerProviderSettings = typeof ClaudeServerProviderSettings.Type;

export const GeminiServerProviderSettings = Schema.Struct({
  ...ProviderSettingsBase,
  binaryPath: StringSetting.pipe(Schema.withDecodingDefault(() => "gemini")),
});
export type GeminiServerProviderSettings = typeof GeminiServerProviderSettings.Type;

export const GrokServerProviderSettings = Schema.Struct({
  ...ProviderSettingsBase,
  binaryPath: StringSetting.pipe(Schema.withDecodingDefault(() => "grok")),
});
export type GrokServerProviderSettings = typeof GrokServerProviderSettings.Type;

export const CursorServerProviderSettings = Schema.Struct({
  ...ProviderSettingsBase,
  binaryPath: StringSetting.pipe(Schema.withDecodingDefault(() => "cursor-agent")),
  apiEndpoint: StringSetting.pipe(Schema.withDecodingDefault(() => "")),
});
export type CursorServerProviderSettings = typeof CursorServerProviderSettings.Type;

export const OpenCodeServerProviderSettings = Schema.Struct({
  ...ProviderSettingsBase,
  binaryPath: StringSetting.pipe(Schema.withDecodingDefault(() => "opencode")),
  serverUrl: StringSetting.pipe(Schema.withDecodingDefault(() => "")),
  serverPassword: StringSetting.pipe(Schema.withDecodingDefault(() => "")),
});
export type OpenCodeServerProviderSettings = typeof OpenCodeServerProviderSettings.Type;

export const KiloServerProviderSettings = Schema.Struct({
  ...ProviderSettingsBase,
  binaryPath: StringSetting.pipe(Schema.withDecodingDefault(() => "kilo")),
  serverUrl: StringSetting.pipe(Schema.withDecodingDefault(() => "")),
  serverPassword: StringSetting.pipe(Schema.withDecodingDefault(() => "")),
});
export type KiloServerProviderSettings = typeof KiloServerProviderSettings.Type;

export const PiServerProviderSettings = Schema.Struct({
  ...ProviderSettingsBase,
  binaryPath: StringSetting.pipe(Schema.withDecodingDefault(() => "pi")),
  agentDir: StringSetting.pipe(Schema.withDecodingDefault(() => "")),
});
export type PiServerProviderSettings = typeof PiServerProviderSettings.Type;

/**
 * Remote sandbox/runtime-provider settings.
 *
 * These configure the cloud backends a `remote-runtime` thread can provision on
 * (Daytona, Vercel Sandbox, Modal, Cloudflare bridge). The server resolves each
 * provider's credentials at provision time, preferring these settings over the
 * `process.env` fallback the env resolvers already read; with nothing configured,
 * behavior is identical to today (env-or-fake).
 *
 * Secret-bearing fields (`apiKey`, `token`, `tokenSecret`, `bridgeToken`) follow
 * the same plaintext `StringSetting` shape the agent providers use for
 * `serverPassword`. The raw value belongs in `ServerSecretStore` (a 0o600 file
 * per secret name); this field is the write-only reference the UI patches when a
 * secret changes and that the resolver pairs with the stored token, so the token
 * itself is never echoed back to clients.
 */
const StringSettingDefaulted = StringSetting.pipe(Schema.withDecodingDefault(() => ""));

export const DaytonaSandboxSettings = Schema.Struct({
  apiKey: StringSettingDefaulted,
  apiUrl: StringSettingDefaulted,
  organizationId: StringSettingDefaulted,
  target: StringSettingDefaulted,
  snapshot: StringSettingDefaulted,
});
export type DaytonaSandboxSettings = typeof DaytonaSandboxSettings.Type;

export const VercelSandboxSettings = Schema.Struct({
  token: StringSettingDefaulted,
  teamId: StringSettingDefaulted,
  projectId: StringSettingDefaulted,
  runtime: StringSettingDefaulted,
});
export type VercelSandboxSettings = typeof VercelSandboxSettings.Type;

export const ModalSandboxSettings = Schema.Struct({
  tokenId: StringSettingDefaulted,
  tokenSecret: StringSettingDefaulted,
  environment: StringSettingDefaulted,
});
export type ModalSandboxSettings = typeof ModalSandboxSettings.Type;

export const CloudflareSandboxSettings = Schema.Struct({
  bridgeUrl: StringSettingDefaulted,
  bridgeToken: StringSettingDefaulted,
});
export type CloudflareSandboxSettings = typeof CloudflareSandboxSettings.Type;

export const SandboxSettings = Schema.Struct({
  defaultRemoteProvider: StringSettingDefaulted,
  defaultSnapshot: StringSettingDefaulted,
  daytona: DaytonaSandboxSettings.pipe(Schema.withDecodingDefault(() => ({}))),
  vercel: VercelSandboxSettings.pipe(Schema.withDecodingDefault(() => ({}))),
  modal: ModalSandboxSettings.pipe(Schema.withDecodingDefault(() => ({}))),
  cloudflare: CloudflareSandboxSettings.pipe(Schema.withDecodingDefault(() => ({}))),
});
export type SandboxSettings = typeof SandboxSettings.Type;

export const ServerSettings = Schema.Struct({
  enableAssistantStreaming: Schema.Boolean.pipe(Schema.withDecodingDefault(() => false)),
  defaultThreadEnvMode: ThreadEnvironmentMode.pipe(Schema.withDecodingDefault(() => "local")),
  addProjectBaseDirectory: StringSetting.pipe(Schema.withDecodingDefault(() => "")),
  textGenerationModelSelection: ModelSelection.pipe(
    Schema.withDecodingDefault(() => ({
      provider: "codex" as const,
      model: DEFAULT_GIT_TEXT_GENERATION_MODEL,
    })),
  ),
  providers: Schema.Struct({
    codex: CodexServerProviderSettings.pipe(Schema.withDecodingDefault(() => ({}))),
    claudeAgent: ClaudeServerProviderSettings.pipe(Schema.withDecodingDefault(() => ({}))),
    cursor: CursorServerProviderSettings.pipe(Schema.withDecodingDefault(() => ({}))),
    gemini: GeminiServerProviderSettings.pipe(Schema.withDecodingDefault(() => ({}))),
    grok: GrokServerProviderSettings.pipe(Schema.withDecodingDefault(() => ({}))),
    kilo: KiloServerProviderSettings.pipe(Schema.withDecodingDefault(() => ({}))),
    opencode: OpenCodeServerProviderSettings.pipe(Schema.withDecodingDefault(() => ({}))),
    pi: PiServerProviderSettings.pipe(Schema.withDecodingDefault(() => ({}))),
  }).pipe(Schema.withDecodingDefault(() => ({}))),
  sandboxes: SandboxSettings.pipe(Schema.withDecodingDefault(() => ({}))),
});
export type ServerSettings = typeof ServerSettings.Type;

export const DEFAULT_SERVER_SETTINGS: ServerSettings = Schema.decodeSync(ServerSettings)({});

const ModelSelectionPatch = Schema.Struct({
  provider: Schema.optionalKey(ProviderKind),
  model: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
  options: Schema.optionalKey(Schema.Unknown),
});

const ProviderSettingsBasePatch = {
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(StringSetting),
  customModels: Schema.optionalKey(CustomModels),
};

const SandboxSettingsPatch = Schema.Struct({
  defaultRemoteProvider: Schema.optionalKey(StringSetting),
  defaultSnapshot: Schema.optionalKey(StringSetting),
  daytona: Schema.optionalKey(
    Schema.Struct({
      apiKey: Schema.optionalKey(StringSetting),
      apiUrl: Schema.optionalKey(StringSetting),
      organizationId: Schema.optionalKey(StringSetting),
      target: Schema.optionalKey(StringSetting),
      snapshot: Schema.optionalKey(StringSetting),
    }),
  ),
  vercel: Schema.optionalKey(
    Schema.Struct({
      token: Schema.optionalKey(StringSetting),
      teamId: Schema.optionalKey(StringSetting),
      projectId: Schema.optionalKey(StringSetting),
      runtime: Schema.optionalKey(StringSetting),
    }),
  ),
  modal: Schema.optionalKey(
    Schema.Struct({
      tokenId: Schema.optionalKey(StringSetting),
      tokenSecret: Schema.optionalKey(StringSetting),
      environment: Schema.optionalKey(StringSetting),
    }),
  ),
  cloudflare: Schema.optionalKey(
    Schema.Struct({
      bridgeUrl: Schema.optionalKey(StringSetting),
      bridgeToken: Schema.optionalKey(StringSetting),
    }),
  ),
});

export const ServerSettingsPatch = Schema.Struct({
  enableAssistantStreaming: Schema.optionalKey(Schema.Boolean),
  defaultThreadEnvMode: Schema.optionalKey(ThreadEnvironmentMode),
  addProjectBaseDirectory: Schema.optionalKey(StringSetting),
  textGenerationModelSelection: Schema.optionalKey(ModelSelectionPatch),
  providers: Schema.optionalKey(
    Schema.Struct({
      codex: Schema.optionalKey(
        Schema.Struct({
          ...ProviderSettingsBasePatch,
          homePath: Schema.optionalKey(StringSetting),
        }),
      ),
      claudeAgent: Schema.optionalKey(
        Schema.Struct({
          ...ProviderSettingsBasePatch,
          launchArgs: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4096))),
        }),
      ),
      cursor: Schema.optionalKey(
        Schema.Struct({
          ...ProviderSettingsBasePatch,
          apiEndpoint: Schema.optionalKey(StringSetting),
        }),
      ),
      gemini: Schema.optionalKey(Schema.Struct(ProviderSettingsBasePatch)),
      grok: Schema.optionalKey(Schema.Struct(ProviderSettingsBasePatch)),
      kilo: Schema.optionalKey(
        Schema.Struct({
          ...ProviderSettingsBasePatch,
          serverUrl: Schema.optionalKey(StringSetting),
          serverPassword: Schema.optionalKey(StringSetting),
        }),
      ),
      opencode: Schema.optionalKey(
        Schema.Struct({
          ...ProviderSettingsBasePatch,
          serverUrl: Schema.optionalKey(StringSetting),
          serverPassword: Schema.optionalKey(StringSetting),
        }),
      ),
      pi: Schema.optionalKey(
        Schema.Struct({
          ...ProviderSettingsBasePatch,
          binaryPath: Schema.optionalKey(StringSetting),
          agentDir: Schema.optionalKey(StringSetting),
        }),
      ),
    }),
  ),
  sandboxes: Schema.optionalKey(SandboxSettingsPatch),
});
export type ServerSettingsPatch = typeof ServerSettingsPatch.Type;

export class ServerSettingsError extends Schema.TaggedErrorClass<ServerSettingsError>()(
  "ServerSettingsError",
  {
    settingsPath: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Server settings error at ${this.settingsPath}: ${this.detail}`;
  }
}
