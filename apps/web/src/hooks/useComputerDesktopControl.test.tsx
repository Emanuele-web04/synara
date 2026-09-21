import { ThreadId, type ThreadComputerState } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { useComputerDesktopControl } from "./useComputerDesktopControl";

const interrupt = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const current = vi.hoisted(() => ({ state: undefined as ThreadComputerState | undefined }));
vi.mock("~/lib/threadTurnInterrupt", () => ({ interruptThreadTurn: interrupt }));
vi.mock("../computerStateStore", () => ({
  selectThreadComputerState: () => () => current.state,
  useComputerStateStore: (selector: () => unknown) => selector(),
}));

function createClient() {
  return new QueryClient({ defaultOptions: { mutations: { retry: false } } });
}

function mount(queryClient: QueryClient = createClient()) {
  let controls!: ReturnType<typeof useComputerDesktopControl>;
  function Probe() {
    controls = useComputerDesktopControl(ThreadId.makeUnsafe("viewed-thread"));
    return null;
  }
  renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <Probe />
    </QueryClientProvider>,
  );
  return controls;
}

describe("desktop Stop control", () => {
  it("stays available between calls and interrupts the actual desktop owner", async () => {
    current.state = {
      controlOwnerThreadId: ThreadId.makeUnsafe("owning-thread"),
      agentActive: false,
      capabilities: { visibleDesktop: true },
    } as ThreadComputerState;
    const controls = mount();
    expect(controls.agentActive).toBe(true);
    expect(controls.visibleDesktop).toBe(true);
    controls.stop();
    await vi.waitFor(() => expect(interrupt.mock.calls[0]?.[0]).toBe("owning-thread"));
  });

  it("shares one stop between the pane and the chat banner", () => {
    // Both are on screen at once and they stop the same turn. Owning the
    // mutation per instance let the surface that did not press Stop keep an
    // enabled button, and pressing it dispatched a second interrupt.
    current.state = {
      controlOwnerThreadId: ThreadId.makeUnsafe("owning-thread"),
      agentActive: true,
      capabilities: { visibleDesktop: true },
    } as ThreadComputerState;
    interrupt.mockReset();
    interrupt.mockReturnValue(new Promise(() => {}));
    const queryClient = createClient();

    const pane = mount(queryClient);
    pane.stop();

    const banner = mount(queryClient);
    expect(banner.stopRequested).toBe(true);
    banner.stop();
    // One mutation for one stop: the second press found the first still in
    // flight instead of dispatching its own interrupt for the same turn.
    expect(queryClient.getMutationCache().getAll()).toHaveLength(1);
  });

  it("reports a failed stop on every surface, not just the one that was pressed", async () => {
    current.state = {
      controlOwnerThreadId: ThreadId.makeUnsafe("owning-thread"),
      agentActive: true,
      capabilities: { visibleDesktop: true },
    } as ThreadComputerState;
    interrupt.mockReset();
    interrupt.mockRejectedValue(new Error("the server refused"));
    const queryClient = createClient();

    mount(queryClient).stop();

    await vi.waitFor(() => expect(mount(queryClient).stopError).toBe("the server refused"));
  });

  it("becomes inactive immediately when ownership and activity end", () => {
    current.state = {
      agentActive: false,
      capabilities: { visibleDesktop: true },
    } as ThreadComputerState;
    expect(mount().agentActive).toBe(false);
  });
});
