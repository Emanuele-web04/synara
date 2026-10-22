import { Schema } from "effect";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import { WsRpcError } from "./rpc";
import {
  NOTION_WS_METHODS,
  NotionCompleteInput,
  NotionCompleteResult,
  NotionConnectResult,
  NotionDisconnectInput,
  NotionMapping,
  NotionMappingDeleteInput,
  NotionOk,
  NotionReadInput,
  NotionReadResult,
  NotionResolveInput,
  NotionState,
  NotionWriteInput,
  NotionWriteResult,
} from "./notion";

export const NotionRpcs = RpcGroup.make(
  Rpc.make(NOTION_WS_METHODS.state, {
    payload: Schema.Struct({}),
    success: NotionState,
    error: WsRpcError,
  }),
  Rpc.make(NOTION_WS_METHODS.connect, {
    payload: Schema.Struct({}),
    success: NotionConnectResult,
    error: WsRpcError,
  }),
  Rpc.make(NOTION_WS_METHODS.complete, {
    payload: NotionCompleteInput,
    success: NotionCompleteResult,
    error: WsRpcError,
  }),
  Rpc.make(NOTION_WS_METHODS.disconnect, {
    payload: NotionDisconnectInput,
    success: NotionOk,
    error: WsRpcError,
  }),
  Rpc.make(NOTION_WS_METHODS.read, {
    payload: NotionReadInput,
    success: NotionReadResult,
    error: WsRpcError,
  }),
  Rpc.make(NOTION_WS_METHODS.write, {
    payload: NotionWriteInput,
    success: NotionWriteResult,
    error: WsRpcError,
  }),
  Rpc.make(NOTION_WS_METHODS.saveMapping, {
    payload: NotionMapping,
    success: NotionOk,
    error: WsRpcError,
  }),
  Rpc.make(NOTION_WS_METHODS.deleteMapping, {
    payload: NotionMappingDeleteInput,
    success: NotionOk,
    error: WsRpcError,
  }),
  Rpc.make(NOTION_WS_METHODS.sync, {
    payload: Schema.Struct({}),
    success: NotionState,
    error: WsRpcError,
  }),
  Rpc.make(NOTION_WS_METHODS.resolve, {
    payload: NotionResolveInput,
    success: NotionOk,
    error: WsRpcError,
  }),
);
