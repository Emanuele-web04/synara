import type * as Acp from "@agentclientprotocol/sdk";
import * as Schema from "effect/Schema";

const AcpMeta = Schema.optionalKey(
  Schema.Union([Schema.Record(Schema.String, Schema.Unknown), Schema.Null]),
);
const OptionalDescription = Schema.optionalKey(Schema.Union([Schema.String, Schema.Null]));

const SessionConfigSelectOption = Schema.Struct({
  _meta: AcpMeta,
  description: OptionalDescription,
  name: Schema.String,
  value: Schema.String,
});

const SessionConfigSelectGroup = Schema.Struct({
  _meta: AcpMeta,
  group: Schema.String,
  name: Schema.String,
  options: Schema.mutable(Schema.Array(SessionConfigSelectOption)),
});

const SessionConfigSelectOptions = Schema.Union([
  Schema.mutable(Schema.Array(SessionConfigSelectOption)),
  Schema.mutable(Schema.Array(SessionConfigSelectGroup)),
]);

const SessionConfigBase = {
  _meta: AcpMeta,
  category: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  description: OptionalDescription,
  id: Schema.String,
  name: Schema.String,
};

export const SessionConfigOption = Schema.Union([
  Schema.Struct({
    ...SessionConfigBase,
    type: Schema.Literal("select"),
    currentValue: Schema.String,
    options: SessionConfigSelectOptions,
  }),
  Schema.Struct({
    ...SessionConfigBase,
    type: Schema.Literal("boolean"),
    currentValue: Schema.Boolean,
  }),
]);

export const SetSessionConfigOptionResponse = Schema.Struct({
  _meta: AcpMeta,
  configOptions: Schema.mutable(Schema.Array(SessionConfigOption)),
});

type AssignableTo<Target, Source extends Target> = Source;

export type SessionConfigOptionCodecCompatibility = AssignableTo<
  Acp.SessionConfigOption,
  typeof SessionConfigOption.Type
>;
