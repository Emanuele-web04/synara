import "../../../index.css";

import type { ServerLocalServerProcess } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

vi.mock("~/store", () => ({
  useStore: (select: (state: { projects: never[] }) => unknown) => select({ projects: [] }),
}));

import { serverQueryKeys } from "~/lib/serverReactQuery";
import { EnvironmentLocalServersSection } from "./EnvironmentLocalServersSection";

describe("EnvironmentLocalServersSection", () => {
  it("disables Stop and explains why when the listener cannot be signaled", async () => {
    const server: ServerLocalServerProcess = {
      id: "123:5432",
      pid: 123,
      command: "postgres",
      displayName: "postgres",
      args: "postgres",
      ports: [5432],
      addresses: [{ host: "127.0.0.1", port: 5432, family: "tcp4", url: "http://localhost:5432" }],
      isStoppable: false,
      stopDisabledReason: "Synara cannot signal this process.",
    };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(serverQueryKeys.localServers(true), {
      generatedAt: "2026-10-05T12:00:00Z",
      servers: [server],
    });
    await render(
      <QueryClientProvider client={queryClient}>
        <EnvironmentLocalServersSection enabled={false} />
      </QueryClientProvider>,
    );
    await page.getByRole("button", { name: /Ports/ }).click();
    await expect.element(page.getByText("postgres", { exact: true })).toBeVisible();
    const stop = document.querySelector<HTMLElement>(
      '[aria-label="Synara cannot signal this process."]',
    );
    expect(stop?.getAttribute("aria-disabled")).toBe("true");
    expect(stop?.getAttribute("title")).toBe("Synara cannot signal this process.");
  });
});
