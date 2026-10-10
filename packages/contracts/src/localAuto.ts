import { Schema } from "effect";

export const LOCAL_AUTO_MODEL = "ProCreations/auto-0.4b-2";
export const LOCAL_AUTO_REVISION = "5937dd0162a9dd564a07c812b65012681daae3fd";

export const LocalAutoStatus = Schema.Struct({
  phase: Schema.Literals(["not-installed", "installing", "ready", "error"]),
  detail: Schema.String,
  device: Schema.NullOr(Schema.String),
  maxTokens: Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65536 }))),
});
export type LocalAutoStatus = typeof LocalAutoStatus.Type;

export const LocalAutoManageInput = Schema.Struct({
  action: Schema.Literals(["status", "install", "cancel"]),
});
export type LocalAutoManageInput = typeof LocalAutoManageInput.Type;
