import * as Effect from "effect/Effect";

// private dev builds briefly registered 54 as DurableProviderCommandDelivery — keep the identity reserved so those DBs stay on canonical lineage, but don't activate delivery here; production cutover is migration 64
export default Effect.void;
