# Ask-user question RTL evidence

`before-after.png` compares the ask-user question card as `main` renders it (no
direction of its own, physical left alignment) with this branch's `dir="auto"` +
logical-utility version.

The capture renders the real `UserInputQuestionForm` component with the app's own
`index.css` through a local Vite page, not a redesigned mock. The "Before" panel
reuses the pre-change class names on the same question data.
