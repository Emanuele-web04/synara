import "../../index.css";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { beforeEach, afterEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  back: vi.fn(),
  navigate: vi.fn(),
  request: vi.fn(),
}));
vi.mock("~/hooks/useAccount", () => ({
  useAccount: () => ({
    status: { state: "signed-in", accountAuthority: "https://account.example.test/api/v1" },
  }),
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => fixture.navigate,
}));
vi.mock("~/lib/hosts/activeHost", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/hosts/activeHost")>()),
  deactivateHost: fixture.back,
}));
vi.mock("~/lib/hosts/api", async (original) => ({
  ...(await original<typeof import("~/lib/hosts/api")>()),
  readHostsApi: () => ({ remoteAccess: fixture.request }),
}));
vi.mock("~/lib/hosts/executionContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/hosts/executionContext")>()),
  readExecutionContext: () => ({
    controller: {
      channel: "beta",
      environmentId: "controller",
      capabilities: { remoteConnections: true },
    },
    execution: { label: "Mac mini", environmentId: "remote" },
    remote: { channel: "beta" },
  }),
}));
import { emitWsTransportState } from "~/wsTransportEvents";
import { HostConnectionControl } from "./HostConnectionControl";

beforeEach(() => {
  fixture.back.mockClear();
  fixture.request.mockClear();
});
afterEach(() => document.documentElement.classList.remove("dark"));
it.each(["light", "dark"])(
  "keeps a local escape visible with the remote host offline (%s)",
  async (theme) => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    await page.viewport(900, 650);
    emitWsTransportState("closed");
    await render(
      <div className="w-72 bg-background p-3 text-foreground">
        <HostConnectionControl />
      </div>,
    );
    await page.getByRole("button", { name: /Mac mini.*Synara Beta/ }).click();
    await expect
      .element(page.getByRole("menuitem", { name: "Back to this computer" }))
      .toBeVisible();
    await page.screenshot({ path: `./__screenshots__/host-control-${theme}.png` });
    await page.getByRole("menuitem", { name: "Back to this computer" }).click();
    expect(fixture.back).toHaveBeenCalledOnce();
    expect(fixture.request).not.toHaveBeenCalled();
  },
);
