import type { UserInputQuestion } from "@synara/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UserInputQuestionForm } from "./UserInputQuestionForm";

const arabicQuestion: UserInputQuestion = {
  id: "question-0",
  header: "اختيار",
  question: "أي خيار تفضّل؟",
  multiSelect: false,
  options: [
    { label: "الخيار الأول", description: "وصف قصير" },
    { label: "الخيار الثاني", description: "وصف آخر" },
  ],
};

function renderForm(question: UserInputQuestion) {
  return renderToStaticMarkup(
    <UserInputQuestionForm
      questions={[question]}
      submissionVersion={0}
      isResponding={false}
      answers={{}}
      questionIndex={0}
      onToggleOption={() => null}
      onAdvance={() => {}}
      onPrevious={() => {}}
    />,
  );
}

describe("UserInputQuestionForm direction", () => {
  it("lets the question header and every option row resolve their own direction", () => {
    const markup = renderForm(arabicQuestion);

    expect(markup).toContain("أي خيار تفضّل؟");
    // One header row plus one row per option. Provider-authored labels and
    // descriptions must reach the browser's first-strong scan, so Arabic and
    // Hebrew questions read right-to-left without flipping the English UI chrome.
    expect(markup.match(/dir="auto"/g)).toHaveLength(3);
  });
});
