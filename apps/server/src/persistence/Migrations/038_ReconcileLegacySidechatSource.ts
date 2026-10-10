/** repairs imports whose tracker used ID 33 for a foreign migration — our sidechat column was skipped though read-model queries require it */
import * as Effect from "effect/Effect";

import ProjectionThreadsSidechatSource from "./033_ProjectionThreadsSidechatSource.ts";

export default Effect.gen(function* () {
  yield* ProjectionThreadsSidechatSource;
});
