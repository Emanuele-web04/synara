// Purpose: Grok/xAI model discovery — CLI stdout parsing, xAI language-model API parsing/fetch, merge.
// Layer: pure parsers/mappers plus a self-contained fetch Effect — no session context.
// Exports: model name/slug helpers, descriptor parsers, mergeGrokModelDescriptors, fetchXaiLanguageModels.

import { type ProviderListModelsResult } from "@t3tools/contracts";
import { Effect, Option, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ProviderAdapterRequestError } from "../Errors.ts";
import { getGrokApiKeyEnv } from "../acp/GrokAcpSupport.ts";

import {
  GROK_MODEL_DISCOVERY_TIMEOUT_MS,
  isRecord,
  PROVIDER,
  XAI_API_BASE_URL,
} from "./GrokAdapter.types.ts";

export const collectStreamAsString = <E>(
  stream: Stream.Stream<Uint8Array, E>,
): Effect.Effect<string, E> =>
  Stream.runFold(
    stream,
    () => "",
    (acc, chunk) => acc + new TextDecoder().decode(chunk),
  );

export function mapGrokModelDiscoveryError(cause: unknown): ProviderAdapterRequestError {
  if (cause instanceof ProviderAdapterRequestError) {
    return cause;
  }
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method: "model/list",
    detail: cause instanceof Error ? cause.message : String(cause),
    cause,
  });
}

export function formatGrokModelName(slug: string): string {
  if (slug === "grok-build-0.1") {
    return "Grok Build 0.1";
  }
  if (slug === "grok-build") {
    return "Grok 4.3";
  }
  return slug.replace(/[-_/]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

export function isGrokBuildApiModelSlug(slug: string): boolean {
  return slug === "grok-build-0.1" || /^grok-code-fast(?:-\d+(?:-\d+)?)?$/u.test(slug);
}

function readXaiModelAliases(rawModel: Record<string, unknown>): string[] {
  const aliases = rawModel.aliases;
  if (!Array.isArray(aliases)) {
    return [];
  }
  return aliases
    .filter((alias): alias is string => typeof alias === "string")
    .map((alias) => alias.trim())
    .filter((alias) => alias.length > 0);
}

export function parseGrokCliModelList(stdout: string): Array<{ slug: string; name: string }> {
  const models: Array<{ slug: string; name: string; isDefault: boolean }> = [];
  let inAvailableModels = false;
  let fallbackDefaultModel: string | undefined;

  for (const line of stdout.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (inAvailableModels && models.length > 0) {
        break;
      }
      continue;
    }
    const defaultMatch = /^Default model:\s*(\S+)/iu.exec(trimmed);
    if (defaultMatch?.[1]) {
      fallbackDefaultModel = defaultMatch[1].trim();
      continue;
    }
    if (/^Available models:/iu.test(trimmed)) {
      inAvailableModels = true;
      continue;
    }
    if (!inAvailableModels) {
      continue;
    }

    const modelMatch = /^(?:[*-]\s*)?([A-Za-z0-9._/-]+)(?:\s+\(([^)]*)\))?/u.exec(trimmed);
    if (!modelMatch?.[1]) {
      continue;
    }
    const slug = modelMatch[1].trim();
    if (!slug) {
      continue;
    }
    models.push({
      slug,
      name: formatGrokModelName(slug),
      isDefault: (modelMatch[2] ?? "").toLowerCase().includes("default"),
    });
  }

  if (models.length === 0 && fallbackDefaultModel) {
    models.push({
      slug: fallbackDefaultModel,
      name: formatGrokModelName(fallbackDefaultModel),
      isDefault: true,
    });
  }

  return models
    .toSorted((left, right) => Number(right.isDefault) - Number(left.isDefault))
    .map(({ slug, name }) => ({ slug, name }));
}

export function parseXaiLanguageModelDescriptors(
  input: unknown,
): Array<{ slug: string; name: string }> {
  if (!isRecord(input)) return [];
  const rawModels = Array.isArray(input.models)
    ? input.models
    : Array.isArray(input.data)
      ? input.data
      : [];
  const models: Array<{ slug: string; name: string }> = [];
  const seen = new Set<string>();

  for (const rawModel of rawModels) {
    if (!isRecord(rawModel) || typeof rawModel.id !== "string") {
      continue;
    }
    const slug = rawModel.id.trim();
    if (!slug) {
      continue;
    }
    const aliases = readXaiModelAliases(rawModel);
    const supportedSlugs = [slug, ...aliases].filter(isGrokBuildApiModelSlug);
    for (const supportedSlug of supportedSlugs) {
      const key = supportedSlug.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      models.push({ slug: supportedSlug, name: formatGrokModelName(supportedSlug) });
    }
  }

  return models;
}

export function mergeGrokModelDescriptors(
  groups: ReadonlyArray<ReadonlyArray<{ slug: string; name: string }>>,
): Array<{ slug: string; name: string }> {
  const models: Array<{ slug: string; name: string }> = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const model of group) {
      const slug = model.slug.trim();
      const key = slug.toLowerCase();
      if (!slug || seen.has(key)) {
        continue;
      }
      seen.add(key);
      models.push({ slug, name: model.name.trim() || formatGrokModelName(slug) });
    }
  }
  return models;
}

export function xaiApiBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.XAI_API_BASE_URL?.trim() || XAI_API_BASE_URL).replace(/\/+$/u, "");
}

export function fetchXaiLanguageModels(input: {
  readonly apiKey: string;
  readonly baseUrl?: string;
}): Effect.Effect<Array<{ slug: string; name: string }>, ProviderAdapterRequestError> {
  return Effect.tryPromise({
    try: async () => {
      const response = await fetch(`${input.baseUrl ?? XAI_API_BASE_URL}/language-models`, {
        headers: {
          Authorization: `Bearer ${input.apiKey}`,
          "Content-Type": "application/json",
        },
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(
          detail.trim() || `xAI language model discovery failed with HTTP ${response.status}.`,
        );
      }
      return parseXaiLanguageModelDescriptors(await response.json());
    },
    catch: (cause) =>
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "model/list",
        detail: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  });
}

export function discoverGrokModels(input: {
  readonly binaryPath: string;
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
}): Effect.Effect<ProviderListModelsResult, ProviderAdapterRequestError> {
  const { binaryPath, childProcessSpawner } = input;
  return Effect.gen(function* () {
    let cliError: unknown;
    let apiError: ProviderAdapterRequestError | undefined;
    const cliModels = yield* Effect.gen(function* () {
      const child = yield* childProcessSpawner.spawn(
        ChildProcess.make(binaryPath, ["models"], {
          shell: process.platform === "win32",
          env: process.env,
        }),
      );
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          collectStreamAsString(child.stdout),
          collectStreamAsString(child.stderr),
          child.exitCode.pipe(Effect.map(Number)),
        ],
        { concurrency: "unbounded" },
      );
      if (exitCode !== 0) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "model/list",
          detail:
            stderr.trim() ||
            `Grok model discovery failed because '${binaryPath} models' exited with code ${exitCode}.`,
        });
      }
      return parseGrokCliModelList(stdout);
    }).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          cliError = error;
          return [];
        }),
      ),
    );
    const apiKey = getGrokApiKeyEnv();
    const apiModels = apiKey
      ? yield* fetchXaiLanguageModels({ apiKey, baseUrl: xaiApiBaseUrl() }).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              apiError = error;
              return [];
            }),
          ),
        )
      : [];
    const models = mergeGrokModelDescriptors([cliModels, apiModels]);
    if (models.length === 0) {
      if (cliError) {
        return yield* mapGrokModelDiscoveryError(cliError);
      }
      if (apiError) {
        return yield* apiError;
      }
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "model/list",
        detail: "Grok model discovery returned no models.",
      });
    }
    return {
      models,
      source: apiModels.length > 0 ? "grok-cli+xai-api" : "grok-cli",
      cached: false,
    } satisfies ProviderListModelsResult;
  }).pipe(
    Effect.scoped,
    Effect.mapError(mapGrokModelDiscoveryError),
    Effect.timeoutOption(GROK_MODEL_DISCOVERY_TIMEOUT_MS),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "model/list",
              detail: "Timed out while discovering Grok models via CLI.",
            }),
          ),
        onSome: (result) => Effect.succeed(result),
      }),
    ),
  );
}
