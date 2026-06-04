/**
 * Repairs imported legacy DBs whose migration tracker already used ID 33 for
 * a pre-Synara migration, causing Synara's sidechat source column migration to
 * be skipped even though read-model queries now require the column.
 */
import * as Effect from "effect/Effect";

import ProjectionThreadsSidechatSource from "./033_ProjectionThreadsSidechatSource.ts";

export default Effect.gen(function* () {
  yield* ProjectionThreadsSidechatSource;
});
