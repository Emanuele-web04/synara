# Web cold-boot harness

Measures the cold boot of production web builds (`apps/web` served by `apps/server`) in
headless Chromium on this machine: paint timing, main-thread blocking, HTTP requests and
bytes, and where the main-thread time goes. Used to choose the chunking configuration in
`apps/web/vite.config.ts`; findings are in [RESULTS.md](RESULTS.md).

It never touches `~/.synara` or `~/.synara-beta`. Each sample restores a seeded data home
into a directory you choose, starts the variant's own server on it with
`SYNARA_AUTH_TOKEN` removed, and gives that server a throwaway `HOME`, `CODEX_HOME`,
`CLAUDE_CONFIG_DIR` and `CLAUDE_SECURESTORAGE_CONFIG_DIR`, so no provider finds the
operator's credentials: no provider session, usage fetch or model call happens.

## Run it

```bash
DATA=/tmp/web-boot   # any scratch directory
OUT=benchmarks/web-boot/results; mkdir -p $OUT

# 1. Once: seed a data home (6 projects, 83 threads) into $DATA/template.
node benchmarks/web-boot/seed.mjs --data $DATA

# 2. Build variants. `asis` keeps the checkout's own config; V1..V8 are in variants.mjs.
#    The transform cache makes every build after the first take ~11 s instead of ~45 s.
export SYNARA_WEB_BUILD_TRANSFORM_CACHE_DIR=$DATA/transform-cache
node benchmarks/web-boot/build-variant.mjs --variant asis --out $DATA/dists/now --report $DATA/dists/now.chunks.json
node benchmarks/web-boot/build-variant.mjs --variant V1 --out $DATA/dists/V1 --report $DATA/dists/V1.chunks.json
# main: a detached worktree outside this checkout, `bun install --frozen-lockfile --ignore-scripts`,
# then the same command with --repo <worktree> --variant asis.

# 3. Measure. Variants alternate in rotating order; the port must be free.
node benchmarks/web-boot/measure.mjs --mode paint --rounds 12 --data $DATA --out $OUT/paint-1x.json \
  --variant main=<main worktree>@$DATA/dists/main --variant V1=.@$DATA/dists/V1 --variant now=.@$DATA/dists/now
#    --cpu 4 for CPU throttling, --mode network for requests and bytes,
#    --network slow for 40 ms RTT / 20 Mbit/s down (CDP emulation).
node benchmarks/web-boot/summarize.mjs $OUT/paint-1x.json          # add --md for a table
node benchmarks/web-boot/report.mjs --paint1 $OUT/paint-1x.json --paint4 $OUT/paint-4x.json \
  --net $OUT/net.json --slow $OUT/slow.json --dist now=$DATA/dists/now --dist V1=$DATA/dists/V1

# 4. Static closure of the entry, raw and brotli, and chunk-import cycles.
node benchmarks/web-boot/closure.mjs $DATA/dists/now

# 5. After a chunking change: the build must still boot and load its lazy chunks.
node benchmarks/web-boot/smoke-ui.mjs --data $DATA --variant now=.@$DATA/dists/now
```

A variant is `name=<checkout>[@<dist>]`: the server comes from `<checkout>` (so `main` runs
main's server), the static files from `<dist>` (default `<checkout>/apps/web/dist`).

## Scripts

| Script                   | What it does                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `seed.mjs`               | Seeds `<data>/template` with `benchmarks/desktop-perf/seed-home.ts` (copied into `apps/server/.bench/` for the run, removed after).                                                                                                                                                                                                                              |
| `build-variant.mjs`      | Production build of `apps/web` with one `codeSplitting` value from `variants.mjs` (or `asis`) into its own directory; `--report` writes every chunk's modules and imports.                                                                                                                                                                                       |
| `variants.mjs`           | The chunking variants of RESULTS.md, as copies, so they stay reproducible after the config changes. The config in `apps/web` is V8 (`apps/web/scripts/boot-chunk-groups.ts`).                                                                                                                                                                                    |
| `measure.mjs`            | The cold-boot sampler. `paint`: FCP, LCP, DOMContentLoaded, long tasks and Total Blocking Time (sum over 50 ms of every long task in the settle window, 6 s or 3 s × CPU rate), splash removal, resources started before FCP. `network`: adds CDP request counts, wire and decoded bytes, Resource Timing per file, and the WebSocket RPC tags sent during boot. |
| `summarize.mjs`          | Median (min–max) per variant; boot `server.getConfig`/`server.getSettings` counts.                                                                                                                                                                                                                                                                               |
| `report.mjs`             | The Markdown table of RESULTS.md from one run's paint, 4× paint, network and slow-link files plus each variant's dist.                                                                                                                                                                                                                                           |
| `smoke-ui.mjs`           | Boots one build and drives it: sidebar, a seeded thread with highlighted code, the composer (typed, never sent), the terminal drawer (lazy xterm), Settings; fails on the boot error screen, page errors or console errors. Run it after every chunking change: a chunk-import cycle builds cleanly and fails only at runtime.                                   |
| `closure.mjs`            | Static-import closure of `index.html`'s entry (script plus modulepreloads) and of the route chunks, raw and brotli, and static chunk-import cycles.                                                                                                                                                                                                              |
| `bootset.mjs`            | Entry closure and the chunks a boot actually fetched, grouped by package or folder.                                                                                                                                                                                                                                                                              |
| `profile.mjs`            | Chromium trace (timeline + V8 sampler) of cold boots, default 4× CPU.                                                                                                                                                                                                                                                                                            |
| `attribute-trace.mjs`    | Main-thread time of those traces: long tasks, JS self time per chunk and per source module (with a `SYNARA_WEB_SOURCEMAP=hidden` build), compile, GC, style, layout, paint.                                                                                                                                                                                      |
| `rolldown-semantics.mjs` | Checks the code-splitting rules RESULTS.md relies on against Vite's rolldown on a small fixture.                                                                                                                                                                                                                                                                 |
| `lib.mjs`                | Shared server, browser, variant and statistics helpers.                                                                                                                                                                                                                                                                                                          |

## Method notes

- One browser process per run, warmed with a blank page; a fresh context (empty HTTP
  cache) per sample. A browser launched per sample adds process start-up to FCP.
- Run-to-run spread is large (FCP is bimodal, see RESULTS.md R5): use at least 12 samples
  per variant for paint and blocking metrics, 6 for network and 4× CPU, and report ranges.
- First run on a fresh data home shows an "Import projects" dialog and an app tour; they
  do not affect these measurements but block clicks in scripted UI checks.
- `results/` is git-ignored: raw samples carry this machine's paths.
