# Web cold-boot results: chunk grouping of PR #2266

Machine: Apple M5 Pro, 18 cores, 48 GB, macOS (Darwin 27.2). Headless Chromium from
`apps/web/node_modules/playwright`. Bundler: Vite 8.1.5 with **rolldown 1.1.5**. Variant
builds come from `build-variant.mjs`. Checked: on the PR, `--variant asis` and `--variant V1`
emit the same file names, and on `main` (`35f8d842d`) `--variant asis` emits the same
file names as main's own `bun run build`.

Numbers are medians with the full range in brackets, n samples per variant, variants
alternating in rotating order within one run. A difference inside the overlap of the
ranges is reported as no change. All numbers in this file were measured in one session.

Protocol change against the numbers first posted on the PR: the server under test gets a
throwaway `HOME`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR` and `CLAUDE_SECURESTORAGE_CONFIG_DIR`,
so no provider finds real credentials (the earlier runs used the operator's `HOME`, which
let the server fetch provider usage on every boot). The network script now also uses one
warm browser instead of one per sample. Absolute numbers therefore differ a little from
the earlier ones; comparisons are always within one run.

## R1. Bundler semantics

Vite 8.1.5 bundles with `node_modules/.bun/rolldown@1.1.5` (its own dependency, printed by
`build-variant.mjs` as `this.meta.rolldownVersion`). `rolldown@1.0.0-rc.3` in the tree
belongs to tsdown and is not used by the web build. 1.1.5 adds two group options that rc.3
lacks: `tags: ['$initial']` and `entriesAware`.

Sources: `node_modules/.bun/rolldown@1.1.5/node_modules/rolldown/dist/shared/define-config-BhJ90aEv.d.mts`
(`CodeSplittingGroup`, lines 999-1191; `CodeSplittingOptions`, 1201-1230;
`CodeSplittingNameFunction`/`ChunkingContext`, 335-356; `ModuleInfo`, 14-60) and the option
schema in `dist/shared/rolldown-build-CtPvmZgJ.mjs:1705-1730`. Each claim below was also
checked on a small fixture with rolldown 1.1.5's JS API; `rolldown-semantics.mjs` reruns
it.

| Question                                          | Answer                                                                                                                                                                                                                                          | Evidence                                                                                                                                                                                                                               |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Several groups match                              | Highest `priority` takes the module; equal priority, lower index. A captured module is removed from every other group.                                                                                                                          | d.mts 1070-1101; fixture: `High` (5) took `shared2.js` from `Low` (1).                                                                                                                                                                 |
| What `minShareCount` counts                       | Entry chunks that reference the module, **dynamic-import entries included**.                                                                                                                                                                    | d.mts 1108-1113; fixture: `shared.js`, imported only by two lazy chunks, captured at `minShareCount: 2`, not at 3. Every route split and lazy component of this app is an entry, so `minShareCount: 2` captures most shared lazy code. |
| Restrict a group to entry-reachable modules       | `tags: ['$initial']`: only modules in the static closure of a user-defined entry.                                                                                                                                                               | d.mts 993-998, 1176-1190; fixture: a catch-all `$initial` group took `a.js`, `dep.js`, `entryOnly.js` and left the lazy-only modules alone.                                                                                            |
| Keep a group out of the entry                     | No option. A higher-priority `$initial` group must take every initial module first; otherwise a lower group can capture one, and the entry then imports that whole group.                                                                       | Follows from the two rows above and the next one.                                                                                                                                                                                      |
| `includeDependenciesRecursively` (default `true`) | A captured module's static dependencies join the same group unless a higher-priority group already took them. With `false` the dependency stays behind and the group can import back from the entry (circular chunk import).                    | d.mts 1162-1175; fixture: `dep.js` followed `a.js` into the group; with `false`, `dep.js` stayed in `entry` and the group chunk imported `entry.js`.                                                                                   |
| `name` as a function                              | `(moduleId, ctx)`; `ctx.getModuleInfo(id)` returns `importers`, `dynamicImporters`, `importedIds`, `dynamicallyImportedIds`, `isEntry`, `code`. Each distinct returned name is its own group with its own size limits; `null` skips the module. | d.mts 335, 354-356, 1025-1054; fixture logged the `ModuleInfo` it received. The module graph is complete at that point, so a name function can compute static closures.                                                                |
| `maxSize`                                         | Splits a group whose captured size exceeds it. On this app's graph the pieces are far from equal: a 1 MB cap on the boot groups produced 60+ chunks, many under 1 KB. A cap on the `$initial` group splits the entry closure the same way.      | d.mts 1114-1119; V5 build (below).                                                                                                                                                                                                     |
| Group that matches lazy entry modules             | It swallows the lazy entry modules too; the dynamic import then points at the merged chunk.                                                                                                                                                     | Fixture: a catch-all group without tags put all three lazy entries into one chunk with the entry's code.                                                                                                                               |

Why the PR's closure grew: of the 221 modules in the entry's static closure (V2), V1
places 6 in `index`, 17 in `app-lib-core`, 6 in `app-ui-primitives`, 90 in
`app-shared-contracts`, 87 in `vendor-effect`, 8 in `vendor-i18n`, 4 in `vendor-react`, 2
in `vendor-tanstack`. A group chunk's static imports are the union of its members' imports,
so `index` → `app-lib-core` + `app-ui-primitives` → `vendor-react`, `vendor-base-ui`,
`vendor-markdown`, `vendor-icons`, ... : 12 files, 3,182 KB, all evaluated before
DOMContentLoaded.

## R2. What the grouping alone buys and costs (V1 against V2)

V2 is the PR without the `codeSplitting` block, so V2 against `main` is the PR's lazy
loading alone and V1 against V2 is the grouping alone. Candidate run, same session
(table in "Candidates" below):

- The lazy-loading changes alone (V2 vs main) save wire bytes (2,078 vs 2,431 KB) but add
  requests (336 vs 315): more lazy entries mean more shared chunks. Entry closure, DCL,
  long tasks and splash are unchanged.
- The grouping alone (V1 vs V2) is what cuts requests (173 vs 336) and wire bytes
  (1,904 vs 2,078 KB) and dismisses the splash earlier (132 vs 155 ms), and it is also
  what costs DOMContentLoaded (93 vs 63 ms), long-task time (191 vs 133 ms) and the
  entry closure (3,182 vs 849 KB): V1 adds one 60–67 ms long task before
  DOMContentLoaded that V2 does not have (the entry evaluating 3.2 MB of modules).
- On a slow link the grouping is worth far more than on loopback (R6).

## R3. The boot set

The entry's static closure in V2 (= main's): 221 modules, 849 KB raw / 227 KB brotli in
16 files. By rendered size: `packages/contracts` 550 KB, `packages/shared` 488 KB (of
which the English locale JSON ~400 KB), `effect` 278 KB, `apps/web/src` 137 KB,
`i18next` 74 KB, `msgpackr` 64 KB, `react` 16 KB. Largest modules: `locales/en/settings.json`
138 KB, `common.json` 100 KB, `contracts/orchestration.ts` 86 KB, `wsTransport.ts` 80 KB,
`i18next` 74 KB. (`bootset.mjs <V2 chunks.json> --modules`.)

That closure is only the first step. Everything a cold boot fetches, attributed to the
dynamic import that first pulled each chunk in (V2, network sample):

| Boot step                                                       | Chunks |      Raw | Brotli | Fetched at |
| --------------------------------------------------------------- | -----: | -------: | -----: | ---------: |
| Entry static closure (`bootstrap.ts`)                           |     16 |   849 KB | 228 KB |       4 ms |
| `main.tsx` (imported by `bootstrap.ts` once connected)          |    154 | 2,068 KB | 616 KB |      70 ms |
| `_chat` layout component (all routes render inside it)          |     86 | 1,539 KB | 437 KB |     142 ms |
| `_chat.index` component                                         |      4 |     8 KB |   4 KB |     147 ms |
| `_chat.$threadId` component (warmed by `usePreloadRouteChunks`) |     45 | 2,187 KB | 579 KB |     217 ms |

Those five steps account for all 305 JS files V2 fetches. Everything else (other routes,
dialogs, xterm, KaTeX, diffs, non-English locales) is not fetched at boot. The 280 extra
files exist because automatic chunking makes one chunk per combination of entries that
share a module, and each boot module is also imported by some different mix of the 300+
lazy entries. Each step's modules are always loaded together, so merging each step into
one file loses nothing: no boot step fetches a module it does not need.

Also seen in the boot set (not chunking, a source-level question for later): both
`react-dom-server.browser` (220 KB) and `react-dom-server-legacy.browser` (194 KB) load
before the splash is removed in every variant.

## R4. Where the main-thread time goes (4x CPU, traced)

`profile.mjs` traces (3 boots per variant, 4x CPU, tracing adds overhead so absolute
numbers are higher than in the untraced runs) of V1 and V2 built with
`SYNARA_WEB_SOURCEMAP=hidden` (same JS as the measured builds, checked byte for byte),
attributed with `attribute-trace.mjs`. Mean per boot, inside long tasks:

| Cost                                                    |           V1 |           V2 |
| ------------------------------------------------------- | -----------: | -----------: |
| Long-task time per boot                                 |     1,604 ms |     1,729 ms |
| `react-dom`, JS self time (inclusive: 1,170 / 1,291 ms) |       337 ms |       358 ms |
| `effect` runtime, self (inclusive 236 / 260 ms)         |       223 ms |       246 ms |
| `@base-ui/react` + `@base-ui/utils`, self               |       154 ms |       179 ms |
| Layout + style recalculation                            |       135 ms |       144 ms |
| `lexical`, self                                         |        63 ms |        64 ms |
| `Sidebar.tsx` inclusive / `ChatView.tsx` inclusive      | 156 / 105 ms | 162 / 115 ms |
| GC                                                      |        23 ms |        19 ms |
| Main-thread module compile                              |        19 ms |   under 1 ms |

The top five costs are React rendering (react-dom is on the stack for about 70% of
long-task time), the Effect runtime, Base UI, layout/style, and Lexical. No single module
dominates and `packages/contracts` schema construction is not among them (under 55 ms
inclusive, below the top 16). The JS work is the same in both variants: chunking only
decides which task it lands in. V1's extra cost is one task: the entry evaluating its
3.2 MB closure before DOMContentLoaded (`v8.evaluateModule`, 60–67 ms at 1x untraced).

Outside long tasks, `components/chat/AsciiWaveBackground.tsx` is the largest JS self
time over the 12 s window (about 1,000 ms of 4x-throttled time in both variants), an
animation running in short frames; it is not part of the boot cost measured here.

## R5. Why first paint moved

The first contentful paint is the boot splash logo (`img.app-boot-splash__icon`, the LCP
element in every sample). It needs the SVG loaded and a frame with the logo's opacity
above zero. The entry's module graph is evaluated as soon as all its files are compiled,
and that evaluation (about 40 ms at 1x, about 150 ms at 4x) blocks the frame. So FCP is a
race between the logo and the entry closure:

| 1x, candidate run medians                              | main |    V1 |   V2 |    V4 |   V4b |    V6 |
| ------------------------------------------------------ | ---: | ----: | ---: | ----: | ----: | ----: |
| JS files requested in the first 15 ms                  |   13 |    12 |   16 |     2 |     4 |     3 |
| Logo response end, ms                                  |   16 |    17 |   17 |    10 |     9 |     9 |
| Entry JS response end, ms                              |   15 |    21 |   17 |    13 |    12 |    18 |
| Samples painted before the entry evaluated (paint run) | 6/12 | 12/12 | 6/12 | 12/12 | 12/12 | 12/12 |

- On `main` and V2 the logo request queues behind 13–16 module preloads on the six
  HTTP/1.1 connections, arrives with or after the JS, and loses the race half the time:
  FCP is bimodal, 16–20 ms or about DOMContentLoaded + 2 ms (64–68 ms). An earlier
  run's "72 ms (24–216)" for `main` is this bimodality.
- V1 wins the race for a different reason: its 3.2 MB closure finishes downloading and
  compiling later (first long task at 28–35 ms), after the first frame. That is the
  DOMContentLoaded regression itself.
- With the entry closure in 2–4 files, the logo gets a connection at once (done at
  9–10 ms) and paints first in every sample, without a bigger closure.
- Not the cause: stylesheets. No variant loads CSS before FCP; `main.css` (482 KB) is
  imported by `main.tsx` and arrives at ~78 ms, after FCP in every variant. KaTeX's
  CSS leaving the boot path changes nothing before FCP.
- At 4x CPU the main thread is so slow that the entry's JS is ready before the first
  frame in nearly every sample of every variant (FCP 172–256 ms); the PR's 4x FCP win in
  an earlier run (48 ms) did not reproduce in this session (V1: 308 ms, 3 of 6 samples
  at 32–36 ms).

## R6. Slow link

CDP `Network.emulateNetworkConditions`: 40 ms latency, 20 Mbit/s down, 10 Mbit/s up,
empty cache, 1x CPU, 6 samples per variant (candidate run). Chrome applies the latency
per HTTP request; WebSocket frames are not delayed the same way, so the server
round-trips during boot are faster than on a real link.

| Slow link                  |                main |              V1 |                  V2 |            V4 |           V4b |            V6 |
| -------------------------- | ------------------: | --------------: | ------------------: | ------------: | ------------: | ------------: |
| Splash dismissed, ms       | 1,598 (1,575–1,622) | 989 (974–1,010) | 1,739 (1,693–1,754) | 700 (677–708) | 695 (683–699) | 568 (560–570) |
| DOMContentLoaded, ms       |       255 (252–260) |   510 (505–511) |       305 (298–310) | 256 (250–257) | 248 (247–254) | 347 (338–349) |
| First Contentful Paint, ms |       200 (192–204) |   264 (264–268) |       208 (200–212) | 112 (108–116) | 112 (108–116) | 112 (108–116) |

This is the case the grouping was written for, and it matters: V1 dismisses the splash
600 ms (38%) sooner than `main` and 750 ms sooner than V2, because 283–305 files at 40 ms
each queue on six connections. One file per boot step goes further: V4b dismisses the
splash in 695 ms, 30% sooner than V1, with `main`'s DOMContentLoaded. V1 pays for its win
with a doubled DOMContentLoaded (510 ms) because the 786 KB (brotli) closure must arrive
before anything runs.

## Candidates

All in `variants.mjs`; every grouped variant first takes the entry's static closure with
`tags: ['$initial']` at the highest priority (R1).

| Variant | Design                                                                                                                                                                                      | Outcome                                                                                                                                    |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| V1      | PR as is                                                                                                                                                                                    | control                                                                                                                                    |
| V2      | no `codeSplitting` block                                                                                                                                                                    | control                                                                                                                                    |
| V3      | `$initial` guard + vendor groups (react, base-ui, tanstack, effect, i18n)                                                                                                                   | dropped after screening: 269 JS requests, nothing gained (the vendor code is a small part of the 300 files)                                |
| V4      | `$initial` in one chunk + one chunk per boot step (`main.tsx`, `_chat` layout, thread route; each the root's static closure minus earlier steps)                                            | 8 JS requests; DOMContentLoaded 6 ms later than `main` (one 839 KB entry file compiles on one thread)                                      |
| V4b     | V4 with `$initial` in three chunks (npm, `packages/*`, the rest)                                                                                                                            | DOMContentLoaded back below `main`; 10 JS requests                                                                                         |
| V5      | V4 with `maxSize: 1_000_000` on the boot groups                                                                                                                                             | **broken at runtime**: 5 chunk-import cycles, boot ends on "Cannot read properties of undefined (reading 'map')"; builds without a warning |
| V6      | V4 + `<link rel=modulepreload>` for `boot-main` in `index.html`                                                                                                                             | fastest splash (1x and slow link) but its `index.html` references 698 KB brotli and slow-link DOMContentLoaded is +90 ms; dropped          |
| V7      | V4b with each boot step split into npm and app chunks                                                                                                                                       | 4x TBT 896 vs V4b 946 vs `main` 783 (screening, 6 samples): bigger scripts cost main-thread time at 4x                                     |
| V8      | V4b with each boot step cut into bands of ~1 MB of source, in topological order with strongly connected components kept whole (a band only imports earlier bands: no cycle by construction) | 4x long-task time equal to `main`; 30 JS requests (37 before each module's counted size was capped at 150 KB)                              |

Why V7/V8 exist: at 4x CPU every one-chunk-per-step variant had ~150 ms more long-task
time than `main` while the same metric at 1x was unchanged. The extra time sits in the
task that receives `boot-main` (136 ms against 71 ms on `main`) and one extra ~80 ms task
when `boot-chat`/`boot-thread` arrive: per-script main-thread work (compile finalization,
instantiation) grows with script size and is not split across tasks. Splitting the same
modules into smaller acyclic scripts shrinks it (V7: 105 + 68 ms; V8's first cut: 94 ms,
no extra task).

### Candidate run

`main`, V1, V2, V4, V4b, V6; 12 paint samples at 1x, 6 at 4x, 6 network, 6 slow link.

| Metric                                |                    main |                       V1 |                      V2 |                     V4 |                    V4b |                      V6 |
| ------------------------------------- | ----------------------: | -----------------------: | ----------------------: | ---------------------: | ---------------------: | ----------------------: |
| Static entry closure, raw / brotli    | 845 / 226 KB (13 files) | 3182 / 786 KB (12 files) | 849 / 227 KB (16 files) | 840 / 217 KB (2 files) | 840 / 219 KB (4 files) | 2827 / 698 KB (3 files) |
| Chunk-import cycles                   |                       0 |                        0 |                       0 |                      0 |                      0 |                       0 |
| JS chunks emitted                     |                     686 |                      567 |                     734 |                    432 |                    434 |                     432 |
| DOMContentLoaded, ms                  |              63 (60–66) |              93 (88–100) |              63 (59–65) |             69 (65–71) |             57 (54–59) |              69 (65–79) |
| DOMContentLoaded 4x CPU, ms           |           192 (185–221) |            294 (280–310) |           188 (186–211) |          202 (195–220) |          170 (163–171) |           198 (196–203) |
| Long-task time, ms                    |           138 (131–153) |            191 (187–202) |           133 (125–153) |          136 (129–150) |          134 (128–137) |           135 (134–150) |
| Long-task time 4x CPU, ms             |        1275 (1187–1533) |         1325 (1306–1455) |        1299 (1227–1443) |       1481 (1439–1634) |       1450 (1384–1543) |        1468 (1419–1485) |
| Total Blocking Time, ms               |              38 (31–53) |               41 (37–52) |              33 (25–53) |             36 (29–50) |             34 (28–37) |              35 (34–50) |
| Total Blocking Time 4x CPU, ms        |           795 (775–983) |           925 (906–1055) |           849 (791–993) |         984 (969–1134) |         950 (934–1043) |           977 (968–985) |
| First Contentful Paint, ms            |              64 (20–68) |               24 (20–28) |              64 (16–68) |             16 (12–20) |             20 (12–20) |              20 (12–24) |
| First Contentful Paint 4x CPU, ms     |            200 (36–220) |             308 (32–320) |           196 (192–220) |          216 (204–232) |          180 (172–228) |           220 (208–256) |
| Splash dismissed, ms                  |           151 (147–161) |            132 (126–144) |           155 (150–163) |          149 (144–162) |          136 (132–146) |           127 (124–139) |
| Splash dismissed 4x CPU, ms           |           409 (401–468) |            407 (392–432) |           414 (403–457) |          430 (415–466) |          398 (385–413) |           421 (410–422) |
| HTTP requests (total)                 |                     315 |                      173 |                     336 |                     39 |                     41 |                      39 |
| HTTP requests (JS)                    |                     283 |                      142 |                     305 |                      8 |                     10 |                       8 |
| HTTP wire bytes, KB                   |                    2431 |                     1904 |                    2078 |                   1766 |                   1769 |                    1766 |
| Boot getConfig + getSettings calls    |                     5–5 |                      0–0 |                     0–0 |                    0–0 |                    0–0 |                     0–0 |
| Slow link: DOMContentLoaded, ms       |           255 (252–260) |            510 (505–511) |           305 (298–310) |          256 (250–257) |          248 (247–254) |           347 (338–349) |
| Slow link: splash dismissed, ms       |        1598 (1575–1622) |           989 (974–1010) |        1739 (1693–1754) |          700 (677–708) |          695 (683–699) |           568 (560–570) |
| Slow link: First Contentful Paint, ms |           200 (192–204) |            264 (264–268) |           208 (200–212) |          112 (108–116) |          112 (108–116) |           112 (108–116) |

Samples per variant: paint 1x 12, paint 4x 6, network 6, slow link 6.

V6's entry closure counts its `boot-main` modulepreload; what it evaluates before
DOMContentLoaded is the same 217 KB as V4.

4x screening of V7 and V8 (separate runs, 6 samples each, so compare within a run; V8
here is the first cut, before the 150 KB per-module cap):

| 4x CPU                |                main |            V2 |                 V4b |                  V7 |                  V8 |
| --------------------- | ------------------: | ------------: | ------------------: | ------------------: | ------------------: |
| TBT, run A            |       783 (773–785) | 832 (820–838) |       947 (940–952) |       896 (884–907) |                   – |
| TBT, run B            |       788 (780–793) |             – |       946 (936–953) |       905 (884–911) |       842 (837–843) |
| Long-task time, run B | 1,288 (1,180–1,343) |             – | 1,446 (1,436–1,453) | 1,405 (1,384–1,411) | 1,289 (1,192–1,293) |

## Final run

`main`, V1, V2, V4b and V8, where V8's build is byte-identical to `bun run build` with the
config now in `apps/web/vite.config.ts` (same file names and `index.html`). 12 paint samples at 1x, 6 at 4x
CPU, 6 network, 6 slow link, variants in rotating order.

| Metric                                |                    main |                       V1 |                      V2 |                    V4b |                     V8 |
| ------------------------------------- | ----------------------: | -----------------------: | ----------------------: | ---------------------: | ---------------------: |
| Static entry closure, raw / brotli    | 845 / 226 KB (13 files) | 3182 / 786 KB (12 files) | 849 / 227 KB (16 files) | 840 / 219 KB (4 files) | 840 / 219 KB (4 files) |
| Chunk-import cycles                   |                       0 |                        0 |                       0 |                      0 |                      0 |
| JS chunks emitted                     |                     686 |                      567 |                     734 |                    434 |                    454 |
| DOMContentLoaded, ms                  |              58 (57–59) |               89 (87–92) |              58 (57–60) |             53 (52–55) |             54 (53–55) |
| DOMContentLoaded 4x CPU, ms           |           186 (183–328) |            285 (273–306) |           189 (184–205) |          166 (162–194) |          167 (165–168) |
| Long-task time, ms                    |           130 (128–134) |            179 (178–189) |           126 (120–144) |          128 (122–131) |           123 (67–140) |
| Long-task time 4x CPU, ms             |        1236 (1225–1339) |         1306 (1256–1350) |        1290 (1221–1742) |       1442 (1310–1568) |       1239 (1216–1269) |
| Total Blocking Time, ms               |              30 (28–34) |               29 (28–39) |              26 (20–44) |             28 (22–31) |             23 (17–40) |
| Total Blocking Time 4x CPU, ms        |           786 (775–939) |            906 (890–950) |          831 (790–1192) |         942 (910–1118) |          835 (816–839) |
| First Contentful Paint, ms            |              60 (16–60) |               24 (20–24) |              60 (16–64) |             16 (12–56) |             20 (12–56) |
| First Contentful Paint 4x CPU, ms     |           192 (124–200) |             288 (28–320) |           204 (192–268) |          176 (172–212) |          176 (172–192) |
| Splash dismissed, ms                  |           139 (136–145) |            124 (121–129) |           142 (140–143) |          127 (125–131) |          104 (102–105) |
| Splash dismissed 4x CPU, ms           |           404 (396–743) |            394 (380–423) |           412 (402–438) |          389 (384–460) |          335 (334–342) |
| HTTP requests (total)                 |                     315 |                      173 |                     336 |                     41 |                     61 |
| HTTP requests (JS)                    |                     283 |                      142 |                     305 |                     10 |                     30 |
| HTTP wire bytes, KB                   |                    2431 |                     1904 |                    2078 |                   1769 |                   1885 |
| Boot getConfig + getSettings calls    |                     5–5 |                      0–0 |                     0–0 |                    0–0 |                    0–0 |
| Slow link: DOMContentLoaded, ms       |           256 (247–259) |            512 (500–517) |           304 (300–307) |          244 (240–247) |          248 (242–251) |
| Slow link: splash dismissed, ms       |        1578 (1527–1607) |            988 (974–997) |        1735 (1712–1747) |          685 (673–692) |          713 (709–715) |
| Slow link: First Contentful Paint, ms |           196 (196–200) |            268 (256–272) |           208 (196–208) |          112 (104–112) |          112 (108–116) |

Samples per variant: paint 1x 12, paint 4x 6, network 6, slow link 6.

### V8 against the targets (same run)

| Target                        | Must                                       | Aim      | V8                             | Must                 | Aim    |
| ----------------------------- | ------------------------------------------ | -------- | ------------------------------ | -------------------- | ------ |
| Static entry closure (brotli) | ≤ 330 KB                                   | ≤ 226 KB | 219 KB                         | met                  | met    |
| DOMContentLoaded 1x / 4x      | not worse than `main`                      | ≤ `main` | 54 / 167 vs 58 / 186 ms        | met                  | met    |
| Long-task time 1x             | not worse than `main`                      | ≤ `main` | 123 vs 130 ms                  | met                  | met    |
| Total Blocking Time 4x        | not worse than `main` beyond range overlap | ≤ `main` | 835 (816–839) vs 786 (775–939) | met, by overlap only | missed |
| First Contentful Paint        | ≤ 35 ms                                    | ≤ 28 ms  | 20 ms                          | met                  | met    |
| Splash dismissed              | ≤ PR + overlap                             | < PR     | 104 vs 124 ms                  | met                  | met    |
| HTTP requests                 | ≤ 220                                      | ≤ 174    | 61                             | met                  | met    |
| HTTP wire bytes               | ≤ PR + 3%                                  | ≤ PR     | 1,885 vs 1,904 KB              | met                  | met    |
| Boot getConfig + getSettings  | 0                                          | 0        | 0                              | met                  | met    |
| Slow-link splash dismissed    | not worse than PR                          | < PR     | 713 vs 988 ms                  | met                  | met    |

Total Blocking Time at 4x passes only because one `main` sample (939 ms) widens its range;
five of six `main` samples are 775–786 ms and V8's six are 816–839 ms, so V8 is about
50 ms (6%) above `main`. V2, the PR without any grouping, sits at the same level
(831 ms, and 832 vs 783 ms in screening run A): that gap comes from the PR's other
changes, not from chunking. V8 removes the part of the 4x regression that the grouping
caused (V1 906 ms, V4b 942 ms) and matches `main`'s 4x long-task time (1,239 vs 1,236 ms).

V8 against V4b, the simpler option: V4b has fewer requests (41 vs 61), fewer wire bytes
(1,769 vs 1,885 KB) and a slightly faster slow-link splash (685 vs 713 ms), but at 4x
CPU it adds ~200 ms of long-task time and ~110 ms of TBT over V8, and its 1x splash is
slower (127 vs 104 ms).

## Chosen design (V8), as implemented

- `apps/web/vite.config.ts`: the PR's 12 named groups are replaced by three `$initial`
  groups (npm, `packages/*`, rest; highest priorities, dependencies first) and the groups
  from `bootChunkGroups` for three boot steps (`main.tsx`, the `_chat` layout component,
  the thread route component).
- `apps/web/scripts/boot-chunk-groups.ts`: computes each step's modules (static closure
  minus the entry's and earlier steps'), orders them topologically with Tarjan's
  algorithm, and cuts them into bands of ~1 MB of source (each module counted at most
  150 KB), keeping strongly connected components whole. One group per band, earlier
  bands at higher priority. A missing step root fails the build. Unit test alongside.
- Result: 4 files in the entry closure, 23 band chunks for the three steps, 30 JS files
  per cold boot, no chunk-import cycles, 454 JS files emitted (686 on `main`).

## Open points

- The ~50 ms Total Blocking Time gap to `main` at 4x CPU is present without any grouping
  (V2) and is not a chunking effect. Whether to chase it in the PR's source or server
  changes is a separate decision.
- `react-dom-server.browser` and `react-dom-server-legacy.browser` (414 KB rendered) load
  on every boot through five `renderToStaticMarkup` call sites
  (`ConnectorIcon.tsx`, `MentionChipIcon.tsx`, `GroupOverview.tsx`,
  `composer-nodes/index.tsx`, `lib/contextMenuIcons.tsx`). Source-level, not part of
  this change.
- Not measured: the packaged desktop app, real remote links (CDP emulation does not
  delay WebSocket frames), Windows, browsers other than headless Chromium.
