# Codex asynchronous question evidence

Captured on macOS with Node 24.13.1, Bun 1.4.2, and codex-cli 0.154.0.

## Browser fixture

The images and video render the actual `AsyncUserInputCard`, shared `UserInputQuestionForm`, and
Synara CSS in a transcript fixture. They do not claim packaged desktop validation.

- [Before](before.png): the existing plain-text representation of the question.
- [Capsule](capsule.png): a question-mark icon and question count, collapsed initially.
- [Pending](pending.png): the existing numbered-choice form and navigation, with a
  separate free-text answer while the composer remains editable.
- [Answered](answered.png): the submitted answers remain attached to the question;
  the independent composer draft is preserved.
- [Interaction video](interaction.webm): open the capsule, select a choice, navigate
  questions, type details, close and reopen, edit the independent composer, and submit.

Automated browser coverage is in `AsyncUserInputCard.browser.tsx` and
`UserInputQuestionForm.browser.tsx`. These cover saved drafts across disclosure
toggles, local keyboard shortcuts, and preservation of blocking-prompt behavior.
The focused transcript tests also cover tail anchors and row overlap.

## Native app-server smoke

An isolated temporary Codex home and empty workspace exercised the installed
app-server without modifying Synara's application state. The CLI selected its
default model (`gpt-6-astra`); no product model setting was changed.

Both requests emitted `item/completed` with an `agentMessage` containing
`delivery: "async"` and structured questions. Neither emitted an
`item/tool/requestUserInput` request. An answer submitted before completion was
accepted by `turn/steer`; an answer submitted after completion was accepted by
`turn/start`. Both resulting turns completed.

This verifies the native wire protocol independently of the browser fixture.
The orchestration integration tests verify persistence, concurrent-answer
admission, message identity, late-answer dispatch, and preservation of the
assistant message's completion timestamp.
