# Local Auto mode

Open **Settings → Auto mode → Install Auto**. Synara downloads a private Python 3.12
environment, pinned inference dependencies, and
[ProCreations/auto-0.4b-2](https://huggingface.co/ProCreations/auto-0.4b-2/tree/5937dd0162a9dd564a07c812b65012681daae3fd).
Installation does not change any task's permissions. After installation, select **Auto (local)**
in any supported provider's task permissions menu. Provider-native **Approve for me** remains
available separately for providers that support it.

The model occupies approximately 1.6 GB; allow several GB for Python, PyTorch, and caches.
Everything is stored under the server's state directory in `local-auto/`. On a remote Synara
connection, installation and inference happen on the **server**, not in the browser.
Installation progress survives closing settings. Failed/cancelled installations can be retried;
only a successful model load and inference self-test mark the installation ready.

## Providers

Auto (local) supports all nine providers: Codex, Claude Code, OpenCode, Cursor, Devin,
Antigravity, Grok, Pi, and Droid. Each integration keeps the provider's permission boundary:

| Provider                   | Approval integration                                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex, Claude Code         | Native approval callbacks, with native automatic review disabled.                                                                           |
| Cursor, Grok, Devin, Droid | ACP permission requests; only `allow_once` can be selected automatically. Native supervised/Code modes and Plan restrictions remain active. |
| OpenCode                   | Native permission requests matched by message/call ID to full tool input. Directory-policy expansion and loop guards remain manual.         |
| Pi                         | SDK pre-tool hook pauses built-in, extension, and gateway tools. Existing extension vetoes run first.                                       |
| Antigravity                | CLI `PreToolUse` hook pauses for Synara's one-call response, without `--dangerously-skip-permissions`.                                      |

Pi and Antigravity expose normal Synara approval prompts while the classifier reviews the call.
Interrupting or stopping the session cancels their pending hooks; late approvals cannot resume them.
Antigravity's hook wait is bounded to ten minutes, then denies the call. Its hook configuration
allows that wait within the [documented hook timeout](https://antigravity.google/docs/hooks).
Subagent calls without their own complete user/history context remain manual.

Providers may omit raw arguments or tool results in some protocol versions. Those requests stay
manual, including Antigravity histories whose post-tool hooks lack results. Summaries, permission
patterns, empty error fields, and display titles never substitute for missing tool input/output.
Local Auto reviews calls exposed by these provider hooks; existing native allowances still apply.

## Hardware

- Apple Silicon: PyTorch MPS (Metal), FP32, SDPA.
- NVIDIA on Windows/Linux: uv selects the PyTorch wheel for the installed driver. CUDA uses BF16
  where supported and the model card's pinned FlashAttention kernel when available.
- CPU on Windows/Linux and Apple Silicon: FP32, SDPA. Unsupported GPU initialization falls back
  to CPU. Windows/Linux architectures need compatible Python/PyTorch binary wheels.
- Intel macOS is not supported by the current PyTorch wheels. Installation reports this explicitly.

The installer pins uv 0.12.13 and verifies its installer SHA-256 before execution. Python is
managed inside Synara; shell profiles and system Python packages are not modified. Dependencies
are PyTorch 2.13.0, Transformers 5.16.1, and kernels 0.16.1. The model and FlashAttention kernel
are pinned to immutable revisions. Model loading uses safetensors with `trust_remote_code=False`.
The optional FlashAttention kernel is executable code from the model card's pinned repository.

## Classification contract

The input follows the model card exactly, without a chat template or instructions added around it:

```text
### PROPOSED TOOL CALL
tool: <tool name>
args: <complete arguments>

### USER REQUEST
<dispatched user requests and steering, in order>

### AGENT HISTORY
[1] <tool>(<complete arguments>)
-> <result>
```

An empty history is `(no prior actions)`. Structured arguments/results are serialized as JSON;
strings retain their original contents. The proposed call comes from the provider's actual
approval payload. Tool history comes from the durable runtime journal, not shortened UI summaries.
Queued messages that have not been dispatched cannot authorize a current call. Imports, missing
turn history, unsupported tool payloads, and image/file attachments require manual review.

The label mapping is **0 = approve, 1 = deny**. Synara uses the published decision threshold,
`P(deny) >= 0.5`. It validates finite probabilities and the corresponding decision before acting.
The tokenizer never truncates. FlashAttention supports 65,536 tokens; SDPA is limited to 4,096 to
bound its attention masks. Over-limit input is sent to manual review, never silently shortened.

An approval accepts only the current request, never the entire session. Denied/unsupported reviews
leave the normal approval prompt available. Authentication, permission-profile grants, plan
acceptance, and user-input questions stay interactive. Decisions appear in task activity.
A stopped turn, changed mode, user response, steering, or changed approval generation invalidates
an in-flight result. A server restart does not automatically approve old journal requests.

Reviews run in a single warm worker with a 90-second response timeout. The worker releases model
memory after five idle minutes and is terminated when the server exits. Inference uses offline
model/kernel caches, with context passed over stdin rather than a network endpoint or process args.
No API key is required and review context is not uploaded to Hugging Face.

This mode only reviews approval requests exposed by the provider. It does not intercept calls the
provider already permits, replace its sandbox, or guarantee that an approved action is safe.
The classifier can make mistakes. Switch to **Ask for approval** for manual review.

## Verification

Run the repository's normal checks plus:

```sh
bun run --cwd apps/server test src/localAuto/input.test.ts src/localAuto/reviewer.test.ts
bun run windows-runtime:check
```

Hardware smoke tests should exercise the bundled worker with the pinned dependencies: successful
initialization, an authorized call, an unauthorized call, and over-limit input. GPU tests should
also verify a finite long-context inference with the pinned FlashAttention kernel. Unit tests do
not substitute for these device checks or a packaged Windows smoke test.
