/**
 * Backwards-compatibility shim: `frameDigest` and `StillFrameDedupe` now live
 * in `./stillFramePublisher.ts`, the single ticker that owns them. This module
 * re-exports them so existing importers keep working.
 *
 * @module computer/stillFrameDedupe
 */
export { frameDigest, StillFrameDedupe } from "./stillFramePublisher.ts";
