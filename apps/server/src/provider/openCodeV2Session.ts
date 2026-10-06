import type { Session } from "@opencode-ai/sdk/v2";
import { normalizeOpenCodeV2PermissionRules } from "./openCodeV2Permissions.ts";
import {
  v2Data,
  v2Number,
  v2Object,
  v2OptionalNumber,
  v2OptionalObject,
  v2OptionalString,
  v2String,
} from "./openCodeV2Json.ts";

export function normalizeOpenCodeV2Tokens(value: unknown): NonNullable<Session["tokens"]> {
  const tokens = v2OptionalObject(value);
  const cache = v2OptionalObject(tokens.cache);
  return {
    input: v2Number(tokens.input ?? 0, "tokens.input"),
    output: v2Number(tokens.output ?? 0, "tokens.output"),
    reasoning: v2Number(tokens.reasoning ?? 0, "tokens.reasoning"),
    cache: {
      read: v2Number(cache.read ?? 0, "tokens.cache.read"),
      write: v2Number(cache.write ?? 0, "tokens.cache.write"),
    },
  };
}

export function normalizeOpenCodeV2Session(value: unknown, directory = ""): Session {
  const session = v2Object(v2Data(value), "session");
  const id = v2String(session.id, "session.id");
  const time = v2Object(session.time, "session.time");
  const location = v2OptionalObject(session.location);
  const model = session.model === undefined ? undefined : v2Object(session.model, "session.model");
  const revert =
    session.revert === undefined ? undefined : v2Object(session.revert, "session.revert");
  const variant = v2OptionalString(model?.variant);
  const archived = v2OptionalNumber(time.archived);
  const partID = v2OptionalString(revert?.partID);
  const snapshot = v2OptionalString(revert?.snapshot);
  const parentID = v2OptionalString(session.parentID);
  const agent = v2OptionalString(session.agent);
  return {
    id,
    slug: v2OptionalString(session.slug) ?? id,
    projectID: v2String(session.projectID, "session.projectID"),
    ...(parentID === undefined ? {} : { parentID }),
    directory: v2OptionalString(location.directory) ?? directory,
    title: v2OptionalString(session.title) ?? "",
    ...(agent === undefined ? {} : { agent }),
    ...(model
      ? {
          model: {
            id: v2String(model.id, "session.model.id"),
            providerID: v2String(model.providerID, "session.model.providerID"),
            ...(variant === undefined ? {} : { variant }),
          },
        }
      : {}),
    version: v2OptionalString(session.version) ?? "2",
    time: {
      created: v2Number(time.created, "session.time.created"),
      updated: v2Number(time.updated, "session.time.updated"),
      ...(archived === undefined ? {} : { archived }),
    },
    ...(session.cost === undefined ? {} : { cost: v2Number(session.cost, "session.cost") }),
    ...(session.tokens === undefined ? {} : { tokens: normalizeOpenCodeV2Tokens(session.tokens) }),
    metadata: {
      ...v2OptionalObject(session.metadata),
      ...(time.idle === undefined
        ? {}
        : { opencodeIdleAt: v2Number(time.idle, "session.time.idle") }),
      ...(session.outcome === undefined
        ? {}
        : { opencodeOutcome: v2String(session.outcome, "session.outcome") }),
    },
    permission: normalizeOpenCodeV2PermissionRules(session.permissions),
    ...(revert
      ? {
          revert: {
            messageID: v2String(revert.messageID, "session.revert.messageID"),
            ...(partID === undefined ? {} : { partID }),
            ...(snapshot === undefined ? {} : { snapshot }),
          },
        }
      : {}),
  };
}
