# Remote feedback: input, providers and task isolation

The Resolve and Helium failures were reported from another person's Mac. This
change addresses confirmed defects in the source paths; it does not claim to
reproduce their applications, permission database, provider accounts or timing.

| Reported symptom                                       | Confirmed defect and correction                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scrolling goes the wrong way or appears ineffective    | Public down/right deltas were sent with the wrong Core Graphics sign. The adapter now converts each axis while preserving the public result. Named AX scrolling and Linux direction conversion retain their semantics.                                                                                                                       |
| Enter fails despite an observed field                  | The tool and batch paths discarded the field reference before native delivery. Both now preserve the exact observed target; stale refs cannot silently select a surviving duplicate or a replacement at the same position. Generic shortcuts still require a proven destination.                                                             |
| Ordinary dialogs are treated as authentication dialogs | Native admission used an app-wide `AXSheet` role refusal. Revision 37 distinguishes protected input from ordinary modal ancestry. Exact semantic input must belong to the modal; raw events cannot target its parent behind it.                                                                                                              |
| Computer looks enabled but a provider has no tools     | Pi now validates its raw Computer catalog before installing compatibility forwarders. OpenCode must establish its isolated MCP connection and rejects unsupported external-server configuration. Antigravity records guidance delivery only after its process starts.                                                                        |
| Two agents block each other across unrelated apps      | Verified background actions reserve their process or exact semantic window. Native transactions remain serialized; global input, foreground and drag retain exclusive ownership. Task Stop preserves idle/queued siblings; dispatched input still requires shared cancellation drain.                                                        |
| Foreground approval disappears on “continue”           | Consent is reconstructed through routine human continuations, with new task, stop, background and imported/automated message boundaries. A declined structured answer cannot authorize the question embedded in its generated text.                                                                                                          |
| Launch steals focus and the task continues blindly     | The adapter now preserves native launch-focus observations. An unexpected change pauses subsequent background input until fresh observation; no relaunch or focus-restoration loop is added. macOS applications may still activate themselves.                                                                                               |
| Long retry loops and excessive waiting                 | Repeated persistent refusals and repeating uncertain action sequences stop before more dispatch. Screenshots alone do not clear uncertainty. Default observer quiet time is 300 ms instead of 1 second; exact effect proof still skips settling. Keyboard-focus metadata is opt-in observation work, excluded from internal geometry checks. |

The provider-facing catalog remains within its existing byte budget. Opaque
native element identities stay inside the server; no new actuator tokens or
background screenshot stream are sent to providers. Browser field append now
reads and writes the original retained element in one native operation, avoiding
an intermediate snapshot that would invalidate its token. A matching AX value
still does not prove that the browser processed DOM events or submitted a form.

AppSnap remains the shared macOS permission service. This change does not alter
the other person's grants or establish that their installed application has the
same signature and bundle identity as the build they granted. Linux's existing
browser-only Cua boundary also remains explicit; macOS input guarantees are not
inferred from compositor-specific Linux implementations.

Validation covers the tool-to-manager-to-Cua adapter path, provider startup,
target identity, modal policy, task cancellation, preview ownership, schemas and
context budget. The native patch applies to the pinned source and compiles with
the pinned Rust toolchain. The local staged artifact is an unoptimized arm64
development build, not a release performance measurement or signed distribution
qualification. Actual Helium/Resolve outcomes and the remote provider matrix
remain runtime acceptance checks on the reporting machine.
