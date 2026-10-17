import type { NotionState, TodoStreamEvent } from "@synara/contracts";
import { PubSub, ServiceMap } from "effect";
import type { NotionRuntime } from "../runtime.ts";

export interface NotionIntegrationShape {
  readonly runtime: NotionRuntime | null;
  readonly events: PubSub.PubSub<TodoStreamEvent>;
  readonly state: () => NotionState;
}
export class NotionIntegration extends ServiceMap.Service<
  NotionIntegration,
  NotionIntegrationShape
>()("synara/notion/Services/NotionIntegration") {}
