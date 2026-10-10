# Message rail and discovery backpressure

Base: upstream `6f54f53c6`. These regressions use real browser components and
React Query with a controlled IPC boundary; they do not run provider processes.

| Case                                                | Before                                        | After                                                                                                   |
| --------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Rail with 1,000 user messages                       | 1,000 mounted buttons and per-frame styles    | Viewport plus four neighbours per edge and one keyboard tab stop; under 100 buttons in a 480px viewport |
| Pointer magnification                               | Full-history Gaussian/style arrays            | Only the rail window; 20 pointer frames cause zero React commits                                        |
| Long user message mount                             | 2 `scrollHeight` reads in the browser fixture | 0; shared ResizeObserver reports natural inner-content height                                           |
| Startup warming after transport capacity exhaustion | 27 `listModels` calls for 9 providers         | 9 calls for the same providers                                                                          |

The rail retains its complete scroll extent and original message indexes.
Home, End, arrows, keyboard activation, pointer selection, hover previews,
reading highlights, reduced motion and the audio wave use the existing math.
Transcript virtualization and bottom-follow logic remain independent of the
rail window. Geometry is rebuilt only when message count changes.

User text keeps its existing first-paint overflow hint and twelve-line clamp.
The shared observer watches an unclamped inner flow root, so wrapping, font and
content changes can update the fade and Show more control without reading
layout properties in a layout effect. Expanding disconnects that observation;
collapsing observes the natural content again.

The transport already retries capacity failures up to twelve times. Model
queries and new-thread warming now retain one such budget, rather than adding
another provider retry budget on top. Other discovery failures retain the
existing provider retry counts. Observed catalogs recover using the shared
capacity backoff and retain their previous data. The existing single model
slot, foreground priorities, cancellation, cache keys and server admission
limits are preserved.

Run focused checks from the repository root:

```sh
bun run test:web:focused src/components/chat/messageTrail.logic.test.ts src/components/chat/userMessageOverflowObserver.test.ts src/lib/providerDiscoveryReactQuery.test.ts src/lib/providerModelPrefetch.test.ts src/hooks/useProviderModelCatalog.test.tsx src/lib/expensiveReadRetry.test.ts src/uiFontSize.test.ts
bun run --cwd apps/web test:browser src/components/chat/MessageTrail.browser.tsx src/components/chat/ChatTranscriptPane.browser.tsx src/components/chat/MessagesTimeline.scroll.browser.tsx src/components/chat/MessagesTimeline.tailAnchor.browser.tsx src/components/chat/MessagesTimeline.rowOverlap.browser.tsx src/lib/providerDiscovery.capacity.browser.ts
```

These counters demonstrate bounded work and retry amplification removal. They
do not establish a frame-rate improvement, live provider startup latency or
whole-application startup RPC count on a heavily loaded host.
