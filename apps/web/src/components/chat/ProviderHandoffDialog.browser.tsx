import type { ComponentProps } from "react";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ProviderHandoffDialog } from "./ProviderHandoffDialog";

async function renderProviderHandoffDialog(
  overrides: Partial<ComponentProps<typeof ProviderHandoffDialog>> = {},
) {
  const props = {
    open: true,
    sourceProvider: "codex",
    targetProvider: "claudeAgent",
    imageCopyNotice: "Current image attachments will be copied to the new draft.",
    warnings: ["Queued follow-up messages stay on the original thread."],
    contextPreview: "Context packet preview text",
    contextPreviewOpen: false,
    isContextPreviewCopied: false,
    onContextPreviewOpenChange: vi.fn(),
    onCopyContextPreview: vi.fn(),
    onCancel: vi.fn(),
    onConfirm: vi.fn(),
    ...overrides,
  } satisfies ComponentProps<typeof ProviderHandoffDialog>;

  return {
    props,
    screen: await render(<ProviderHandoffDialog {...props} />),
  };
}

function findButtonByText(label: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  expect(button, `Expected to find button with text "${label}".`).toBeTruthy();
  return button!;
}

function findContextPreviewButton(): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(
    'button[aria-controls="provider-handoff-context-preview"]',
  );
  expect(button, "Expected to find context preview disclosure button.").toBeTruthy();
  return button!;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ProviderHandoffDialog", () => {
  it("shows honest transfer copy and keeps context preview collapsed by default", async () => {
    const { screen } = await renderProviderHandoffDialog();

    try {
      await expect
        .element(page.getByRole("heading", { name: "Continue this conversation with Claude?" }))
        .toBeInTheDocument();
      await expect
        .element(page.getByText("Claude will receive a compact context packet from this thread."))
        .toBeInTheDocument();
      await expect
        .element(page.getByText("The original Codex session will stay unchanged."))
        .toBeInTheDocument();
      await expect
        .element(page.getByText("Provider-native hidden state", { exact: false }))
        .toBeInTheDocument();
      await expect
        .element(page.getByText("Current image attachments will be copied to the new draft."))
        .toBeInTheDocument();
      await expect
        .element(page.getByText("Queued follow-up messages stay on the original thread."))
        .toBeInTheDocument();
      expect(findContextPreviewButton().getAttribute("aria-expanded")).toBe("false");
      const preview = document.getElementById("provider-handoff-context-preview");
      expect(preview).toBeTruthy();
      expect(preview?.closest('[aria-hidden="true"]')).toBeTruthy();
    } finally {
      await screen.unmount();
    }
  });

  it("requests preview expansion and copies preview text", async () => {
    const { props, screen } = await renderProviderHandoffDialog();

    try {
      findContextPreviewButton().click();
      expect(props.onContextPreviewOpenChange).toHaveBeenCalledWith(true);

      findButtonByText("Copy").click();
      expect(props.onCopyContextPreview).toHaveBeenCalledWith("Context packet preview text");
    } finally {
      await screen.unmount();
    }
  });

  it("dispatches cancel and continue callbacks", async () => {
    const { props, screen } = await renderProviderHandoffDialog();

    try {
      findButtonByText("Cancel").click();
      expect(props.onCancel).toHaveBeenCalledTimes(1);

      findButtonByText("Continue with Claude").click();
      expect(props.onConfirm).toHaveBeenCalledTimes(1);
    } finally {
      await screen.unmount();
    }
  });
});
