# Packaged app resource sampling

Run this read-only macOS sampler alongside a sequential workload in the
[packaged fixture](packaged-e2e.md). Select the exact running application bundle
and its main PID. The sampler validates the PID's executable against that
bundle's `CFBundleExecutable`; matching another app's name is insufficient.
Run it from a process outside the selected application's tree so its own CPU
and memory are excluded.

```sh
bun scripts/computer-use-fixtures/sample-packaged-resources.ts \
  --bundle "$ISOLATED_CUA_BUNDLE" \
  --pid "$PACKAGED_MAIN_PID" \
  --seconds 180 \
  --interval-ms 1000 \
  --out /private/tmp/synara-packaged-resources-001.jsonl
```

Wait for `Resource sampler ready` before starting the measured workload. The
first sample has been written at that point. Use a new output filename: the
sampler exclusively creates a `0600` JSONL file and does not overwrite existing
evidence. It does not launch the application, run provider requests, change
permissions, or send signals to the observed processes. Interrupting the
sampler writes an incomplete summary and leaves the application running.

Defaults are 120 seconds and a 1000 ms interval. Duration is limited to 1–600
seconds, interval to 500–5000 ms, output to 16 MiB, and each sample to 512
processes. At most 4096 distinct observed identities are retained. Read commands
have a one-second timeout and an 8 MiB output cap. Bounds or read failures mark
the report incomplete; samples do not silently truncate.

Each sample includes the app and its currently attributable descendants, with
PID, parent PID, start identity, executable basename and a role hint. Descendants
already observed remain tracked after reparenting. A reused PID with a different
start time is a new identity; it is included only if its current ancestry belongs
to the selected app. Replacing the root invalidates completion. Role hints use
executable names; a generic Node/Bun process stays `other-descendant` because
the sampler does not inspect arguments to guess which provider it runs.

The process table is read using `comm`, never `args` or `command`. Unrelated
processes and executable paths are discarded. Reports contain no process
arguments, environment variables, window text or account data. The explicitly
selected bundle path remains in the metadata.

Measurements:

- `rssKiB` is resident memory in 1024-byte units. `totals.rssKiB` sums the sampled
  processes and `peakTreeRssKiB` is that sum's observed peak. Shared pages may be
  counted more than once; this is not unique app memory or incremental overhead.
- `cpuPercent` is `ps`'s OS estimate, not an interval benchmark or hardware GPU
  utilization. Summed percentages can exceed 100% on multiple CPU cores.
- `lifetimeCpuSeconds` is cumulative CPU time for that process. The summary's
  `observedCpuSeconds` adds differences only between observations of the same
  PID/start identity. It excludes CPU before the first observation, after the
  last, and from processes missed between samples. It is not complete workload
  CPU. A decreasing same-identity counter makes completion false.

`ps` snapshots are not atomic and `lstart` has one-second precision, so PID reuse
inside that resolution may be indistinguishable. Short-lived descendants and
children reparented before their first observation can be missed. Existing
browser instances outside this process tree are excluded. Sampling itself adds
small, unmeasured system work; compare equivalent workloads with the same sampler.

JSONL starts with `metadata`, followed by `sample` records and a final `summary`.
Exit 0 means sampling completed for its bounded interval or the observed tree
ended; it does not establish task success, cleanup, or coverage of a workload
that continued after sampling. Exit 2 means evidence is incomplete, and exit 1
means setup/output failed. A missing summary is incomplete evidence. Correlate
sample timestamps with workload receipts before drawing conclusions. These
measurements alone establish neither a leak, battery use nor optimization savings.
