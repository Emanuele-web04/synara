/**
 * ExternalAgentAdapter - Profile-driven external agent ACP implementation of
 * the generic provider adapter contract.
 *
 * Unlike built-in adapters, the launch command/args/env are not fixed: they
 * come from a resolved `ExternalAgentSessionLaunch` (profile + revision +
 * expanded credential env) resolved on the server from the pinned profile and
 * revision in `ProviderSessionStartInput.modelSelection`.
 *
 * @module ExternalAgentAdapter
 */
import { ServiceMap } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface ExternalAgentAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "external";
}

export class ExternalAgentAdapter extends ServiceMap.Service<
  ExternalAgentAdapter,
  ExternalAgentAdapterShape
>()("synara/provider/Services/ExternalAgentAdapter") {}
