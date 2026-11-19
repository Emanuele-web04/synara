// FILE: BotReactor.ts (service)
// Purpose: Tag for the SynBot background reactor (settlement, reports, new-project cards).
// Layer: Server reactor service

import { ServiceMap } from "effect";

export interface BotReactorShape {
  readonly ready: true;
}

export class BotReactor extends ServiceMap.Service<BotReactor, BotReactorShape>()(
  "synara/bots/Services/BotReactor",
) {}
