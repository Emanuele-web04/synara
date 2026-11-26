# Composer placeholder RTL evidence

`before-main.png` and `after-branch.png` are the same page at the same size, rendering the
real `ComposerPromptEditor` with the app's own `index.css` through a local Vite page. Only
the component differs: `before-main.png` is `main`, `after-branch.png` is this branch.

Four drafts are shown in order: Arabic, Hebrew, English, and an empty draft with a Persian
placeholder. Draft text is already right-aligned on `main`, because Lexical marks top-level
draft paragraphs with `dir="auto"`. The placeholder is not a Lexical paragraph, so on `main`
it inherits the app's left-to-right direction and a Persian placeholder renders against the
left edge; this branch gives it `dir="auto"` and it resolves like the draft.
