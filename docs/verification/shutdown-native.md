# Native production-server shutdown and restart

Chromium drove the built production application, using actual OpenCode 1.19.0 and `opencode/mimo-v2.6-flash-free`, a synthetic empty Git repository, isolated provider directories, and no inherited API credentials. No NativeApi, transport, Git implementation, or model output was replaced.

The first native turn completed with exactly `NATIVE_SHUTDOWN_READY`. The second turn produced actual visible streamed output while Stop generation was present. SIGTERM then exited within the deadline. The first answer and partial second answer were retained; restarting the same production server/home yielded exactly two terminal turns without duplication or a stuck running turn. All persisted provider deliveries succeeded after restart. The cancelled turn is the existing explicit `error` outcome with native `Aborted` diagnostics, not a claimed successful completion. Exit 130 is the interruption-only exit code in the pinned Effect Runtime; native cleanup failure would exit 1 and fails this check.

The report pins the admission and provider-service source, including the latest provider admission repair. The two PNGs show real streaming before shutdown and the real reopened conversation. `shutdown-native-check.txt` is the completed run output. The SQLite engine regression also reproduced rejected late transcript chunks before the admission correction, then passed with the correction while ordinary new work remained fenced.

Reproduce after building web/server, from the repository root:

```sh
OPENCODE_LIVE_BINARY=/absolute/path/to/opencode CHROMIUM_EXECUTABLE_PATH=/absolute/path/to/chromium python docs/verification/shutdown-native-check.py
```

This test explicitly attaches an external native CLI owned and cleaned by the test runner. It does not establish production ownership of native descendant processes, authenticated paid-provider acceptance, or packaged desktop prepareQuit behavior. Those broader #985 qualifications remain separate. No native process-cleanup receipt is inferred from the screenshots.

The production web and CLI were rebuilt after integrating main `52f06318fdb3c0b4b310a8d55d0083cba0bde1a0`. The portable native shutdown/restart runner passed again on the combined source; the report, two screenshots, and raw output now belong to that rerun. The new transcript UI and actual SQLite settlement/recovery were exercised. The build used a scratch output directory to exclude concurrent workspace synchronization staging files from asset compression, then bundled that actual output into the CLI.

Main advanced again to `fc6fd90c1f3854719ef83fcdb3ee7e57a8437986` with orphaned-session recovery and desktop HTTP bootstrap. After integrating it and rebuilding the CLI (web source unchanged), actual native shutdown/restart passed again; the raw output, report and captures now record this final rerun. The combined provider-command/orchestration suites pass 521 cases. The upstream isolated-process HTTP dispatcher case also passes actual HTTP requests.
