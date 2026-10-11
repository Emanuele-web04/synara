import { clipboard, dialog } from "electron";
import { afterEach, expect, it, vi } from "vitest";
import { showDiagnosticStartupDialog } from "./startupDiagnosticDialog";

vi.mock("electron", () => ({
  dialog: { showMessageBox: vi.fn() },
  clipboard: { writeText: vi.fn() },
}));
afterEach(() => vi.resetAllMocks());

it("copies the report without consuming retry/quit or changing the cancel choice", async () => {
  const show = vi.mocked(dialog.showMessageBox);
  show.mockResolvedValueOnce({ response: 2, checkboxChecked: false });
  show.mockResolvedValueOnce({ response: 0, checkboxChecked: false });
  const getReportStatus = vi.fn().mockReturnValueOnce("queued").mockReturnValueOnce("sent");
  const result = await showDiagnosticStartupDialog(
    {
      message: "Database unavailable",
      buttons: ["Try again", "Quit"],
      cancelId: 1,
    },
    "12345678-1234-4234-8234-123456789012",
    { getReportStatus },
  );
  expect(result.response).toBe(0);
  expect(clipboard.writeText).toHaveBeenCalledExactlyOnceWith(
    "12345678-1234-4234-8234-123456789012",
  );
  expect(show).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({
      buttons: ["Try again", "Quit", "Copy diagnostic ID"],
      cancelId: 1,
      detail: expect.stringContaining("queued locally"),
    }),
  );
  expect(show).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({ detail: expect.stringContaining("report sent") }),
  );
});

it("leaves Stable dialogs untouched and survives clipboard failure in Beta", async () => {
  const options = { message: "Database unavailable", buttons: ["Quit"] };
  const show = vi.mocked(dialog.showMessageBox);
  show.mockResolvedValue({ response: 0, checkboxChecked: false });
  await showDiagnosticStartupDialog(options, null, null);
  expect(show).toHaveBeenCalledExactlyOnceWith(options);
  show.mockClear();
  show.mockResolvedValueOnce({ response: 1, checkboxChecked: false });
  vi.mocked(clipboard.writeText).mockImplementation(() => {
    throw new Error("Clipboard unavailable");
  });
  await expect(
    showDiagnosticStartupDialog(options, "report-id", { getReportStatus: () => "queued" }),
  ).resolves.toMatchObject({ response: 0 });
  expect(show).toHaveBeenCalledTimes(2);
});
