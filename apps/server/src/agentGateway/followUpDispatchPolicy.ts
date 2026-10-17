/**
 * Declared follow-up dispatch policy for `synara_send_message`.
 *
 * The gateway passes the requested mode through unchanged and the runtime
 * decides delivery (see the `thread.turn.start` handling in
 * `ProviderCommandReactor`). This module is the one place that declares what
 * each mode means, so the catalog text an agent reads and the behavior it gets
 * cannot drift apart:
 *
 * - `queue` (default) never interrupts. The message runs after the live turn
 *   finishes.
 * - `steer` is an urgent redirect and is allowed to interrupt. Providers with
 *   native turn steering ride the live turn; everywhere else Synara queues the
 *   message at the head and asks the running turn to stop so the follow-up runs
 *   next. With no live turn, `steer` simply starts normally.
 *
 * @module agentGateway/followUpDispatchPolicy
 */

/** How `mode: "queue"` behaves. Ordinary follow-ups must use it. */
export const FOLLOW_UP_QUEUE_POLICY = "queue";

/** How `mode: "steer"` behaves, including the non-native fallback. */
export const FOLLOW_UP_STEER_POLICY = "steer";

/** Catalog description for the `mode` argument. */
export const FOLLOW_UP_MODE_DESCRIPTION =
  'Dispatch mode: "queue" (default) never interrupts and runs after the live turn; "steer" interrupts — natively where the provider supports it, otherwise Synara queues the message first and stops the running turn so it runs next. Use "steer" only when the change must land before the current turn finishes.';

/** Catalog description for `synara_send_message`. */
export const FOLLOW_UP_DISPATCH_DESCRIPTION = `Send a Synara follow-up message to an existing thread. Use mode "queue" (default) for ordinary follow-ups: it waits for the current turn and never interrupts. Use mode "steer" when the follow-up must take effect immediately — it steers the live turn where the provider supports that natively, and otherwise queues the message at the head and interrupts the running turn. With no live turn both modes start normally.`;
