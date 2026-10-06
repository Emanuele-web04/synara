# Connection and stream recovery

A missed pong cannot distinguish a busy server from a failed network path. The
client keeps an open socket during ordinary server stalls and retains the existing
session-owned RPC buffering, acknowledgement and cancellation behavior.

The socket sends keepalives every 5 seconds. **Any incoming server frame** refreshes
liveness, including responses and subscription chunks; a pong queued behind a large
snapshot therefore does not cause a reconnect. **180 seconds of complete silence**
starts the existing coalesced reconnect ladder. This exceeds the observed 45–60
second stalls and bounds half-open connections used by paired remote clients.
Socket errors and closures still start recovery immediately. A monotonic clock
measures silence; background timer throttling can delay detection.
Network-online and visibility changes do not shorten that bound: neither proves
that the server has stopped responding, and a short wake-up timeout would also
replace connections during ordinary server stalls.

WebSocket upgrades allow 90 seconds before recovery. The feature-socket readiness
probe allows 180 seconds even if keepalive pongs arrive without its RPC response.
Disposal cancels both waits. These budgets do not remove ordinary RPC deadlines or
automatically retry mutations. Reconnect restores each thread from its last
successfully applied `afterSequence`, rather than replaying its original input.

## Bounded stream overflow

`ORCHESTRATION_STREAM_OVERFLOW_CODE` is exported by `@synara/contracts`. The server
stream-budget change emits the existing `WsRpcError` shape with that code and
`retryable: true`. It does not send a new cursor. Servers without this error continue
to use the existing recovery behavior.

Only the failed subscription restarts, preserving its last applied cursor and all
other subscriptions on the socket. Retry delays are 250 ms, 500 ms, 1 s, 2 s, 4 s,
8 s, 16 s and 16 s, for **eight retries maximum**. A stream that remains alive for
10 seconds earns a fresh retry budget; an initial snapshot alone does not reset it.
Unsubscribe, disposal and session replacement cancel keyed retries.

After exhaustion, the client stops automatic retries and surfaces a failed thread
synchronization state and a compact thread/workspace-updates toast, including when
cached messages remain visible. **Retry updates** reopens only the affected stream;
thread retries retain their cursor and event fence and run through the same
subscription queue as other thread synchronization operations. Shell retries reset
the shell snapshot fence. Thread notices have stable identities and route-scoped
thread context; retry closes the notice, and an applied event from the recovered
subscription clears the failed state. A catch-up poll can recover missing events
without reviving an exhausted stream, so replay alone keeps the failed state and
retry notice visible. Retry rejections use separate stable notice identities.
Exhaustion does not clear thread cursors or reconnect the whole transport. The
server owns its bounded event buffers and resume/snapshot policy; this client
change does not edit server handlers or their buffering hooks.
