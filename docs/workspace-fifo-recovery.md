# Workspace reads must reject named pipes without waiting

Workspace previews and version-checked saves accept regular files. On POSIX, opening a named pipe with ordinary read flags waits for a writer before the descriptor can be checked. Cancelling the RPC does not cancel that native open. Repeated requests can strand the Node filesystem worker pool and prevent unrelated requests from completing.

Both read paths now open with `O_RDONLY | O_NONBLOCK` on POSIX and reject non-regular descriptors before reading. Windows retains `O_RDONLY`. Existing resolved-path containment, descriptor identity, symlink handling, version checks, and descriptor cleanup remain in place. This does not increase a timeout or change the busy banner.

## Controlled reproduction

Use a disposable home, empty Git repository/worktree, unused server and browser ports, and a test-only auth token. Never use an existing Synara database or provider credentials. Build the actual server entry point and run it with Node 24.21.0. The investigation used the pinned Claude SDK 0.3.296 without calling a model.

1. Create a regular `healthy.txt` and four named pipes with `mkfifo pipe-0.txt pipe-1.txt pipe-2.txt pipe-3.txt` inside the disposable worktree.
2. Connect the real browser `WsTransport` to the full authenticated application server, with its browser origin explicitly configured as the development origin. Verify `projects.readFile` reads the regular file first.
3. Use two real connections to send two `projects.readFile` requests per connection for the four pipes. After 300 ms, abort the four client requests. This exercises both per-connection expensive-request slots.
4. On the established connection request `server.getRuntimeStatus` with a 4-second deadline, then read `healthy.txt` again. Cancellation alone must not leave either operation blocked.
5. Always release baseline readers during cleanup by opening each synthetic pipe with `O_RDWR | O_NONBLOCK` and closing that descriptor; stop only the isolated server.

The same full-server fixture also exercised four real socket closures, cancellation of pending snapshot requests, protocol renegotiation, and successful snapshots after reconnect. Its disposable database had a Claude session in `error`, a latest turn in `completed`, and zero messages/activity, matching the reported state without accessing customer data. No live provider was started.

| Control                                                                  | Original main                           | Fixed read flags |
| ------------------------------------------------------------------------ | --------------------------------------- | ---------------- |
| Regular-file read before workload                                        | Pass                                    | Pass             |
| Four socket reconnects and pending-request cancellation                  | Pass                                    | Pass             |
| Runtime-status RPC after cancelled FIFO reads, WS event logging disabled | Times out at 4 seconds                  | Pass             |
| Unrelated regular-file read after workload                               | Blocked behind preceding failed control | Pass             |

The committed filesystem regression tests reproduce both direct reads and version-checked saves with actual named pipes and real-time deadlines. Existing tests cover ordinary file reads/writes, symlinks, containment, encoding, version conflicts, and descriptor/path races. The two new tests fail on the original flags and pass with the fix.

## Limits

This proves a special-file read starvation defect and its repair. It does not prove that the customer's hours-long Claude error was caused by a named pipe, or that every busy/unresponsive banner is resolved. The full-server controls ran on local macOS, not a signed Intel build or a live Claude session. The Windows runtime boundary check passed; named-pipe regression tests are POSIX-only.
