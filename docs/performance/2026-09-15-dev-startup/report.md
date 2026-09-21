# Development startup and reload investigation

React Compiler was the dominant measured cost in the development renderer's
large chat module. The existing Vite configuration ran the Babel compiler during
every ordinary development transform. `ChatView.tsx` has 5,911 lines and took
about 25-30 seconds per transform in the repeated comparison below.

The route is requested during startup: `bootstrap.ts` loads `main.tsx`, the router
loads the root route, and `usePreloadRouteChunks()` immediately preloads the thread
route after the root commits. `ChatThreadSurfacePrimitives.tsx` statically imports
`ChatView`, so deferring its React mount does not avoid compiling its module.
Edits to that module pay the compiler cost again.

## Change and trade-off

The Babel compiler plugin now applies to builds, `test` mode, and development
explicitly started with `SYNARA_DEV_REACT_COMPILER=1` or `true`. Normal development
uses the React plugin's Oxc TypeScript/JSX transforms and Fast Refresh. The config
remains an object so existing browser-test and performance configs can continue
to merge it. Turbo forwards the opt-in variable.

Development without the compiler can rerender more often because it lacks
compiler-generated memoization. Use the opt-in or a production build for renderer
performance work and compiler-specific debugging. Production compilation, route
preloading, backend readiness and desktop process teardown are unchanged.

## Reproduction and results

From the repository root, after installing the locked dependencies:

```bash
node apps/web/scripts/measure-dev-transforms.mjs
node apps/web/scripts/measure-dev-transforms.mjs --compiler
```

Run variants serially and do not edit Vite configuration while a measurement is
running. The script starts the real development Vite pipeline, disables speculative
pretransforms, requests five modules in a fixed order, then invalidates and
retransforms each module three times. It does not include the backend, browser
rendering or the complete HMR round trip.

Environment: Linux 6.18.44 x64, AMD EPYC 9V74, Node 24.19.0, Bun 1.4.2, Vite 8.1.5,
locked repository dependencies. Source is `dd88d9272f97e4dda5735281e73ce14de388ad25`
plus this PR's configuration change, toggled using the opt-in. Two fresh Vite
processes per variant ran in off/on/off/on order. Each had a cold source-transform
cache and used the existing dependency cache. Initial transforms are separate in
[measurements.json](./measurements.json). No warmup samples were discarded.

The table reports the median and range of six invalidated retransforms per
variant. All values are milliseconds. The shared container's host load was not
controlled, and small configuration checks/setup overlapped some samples. The
large compiler cost was also reproduced on the original unmodified configuration
before implementation. No total-startup percentage or server-initialization
improvement is claimed.

| Module                  | Compiler on, median ms | Default dev, median ms | Reduction ms | Compiler on, range ms | Default dev, range ms |
| ----------------------- | ---------------------: | ---------------------: | -----------: | --------------------- | --------------------- |
| `main.tsx`              |                   8.98 |                   3.22 |         5.76 | 7.10-12.31            | 2.07-7.60             |
| `__root.tsx`            |                 348.02 |                  20.99 |       327.03 | 316.32-417.05         | 10.62-28.85           |
| `ChatView.tsx`          |              26,489.13 |                  27.95 |    26,461.18 | 25,302.63-29,010.01   | 19.94-43.39           |
| `SingleChatSurface.tsx` |                 385.33 |                   9.93 |       375.40 | 358.13-422.59         | 6.19-19.75            |
| `MessagesTimeline.tsx`  |               1,204.89 |                  22.41 |     1,182.48 | 1,086.41-1,348.58     | 13.08-51.73           |

One compiler-on run was interrupted by a configuration edit and failed with
`ERR_CLOSED_SERVER`. It was excluded and repeated after freezing the config.
The raw successful samples and exclusion reason are retained in the JSON file.

## Validation

- Actual Vite configuration regression coverage checks the default, disabled and
  invalid flag values, both opt-in forms, production builds, test mode and the
  retained Fast Refresh plugin.
- A live Vite watcher probe edited a TSX component, received a `js-update` over
  the HMR WebSocket and fetched the changed module with its Fast Refresh wrapper.
- A Chromium 151 browser probe clicked a stateful React component, edited its
  TSX source and observed the updated label with the counter and document both
  preserved. React Compiler was disabled and there were no page errors.
- The real Bun server reached healthy startup using a fresh isolated home. The
  uncompiled development app loaded in Chromium, dismissed onboarding and
  rendered the new-thread composer without page errors.
- Four targeted `ChatView`/`EventRouter` browser cases passed with
  `--mode development`: active thread title, initial welcome coalescing, empty
  shell snapshot handling and pending approval hydration. The other 160 cases
  were not selected in this focused run. The unfiltered local attempt was
  interrupted before producing a result.
- The PR description records the final formatting, lint, typecheck, production
  build and browser verification outcomes.

These measurements establish a development transform bottleneck. They do not
measure installed production-app startup, provider availability, an existing
user database, or native desktop window launch on Windows/macOS.
