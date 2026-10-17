// Purpose: Gives only the currently owned backend a narrow updater control channel.
// Layer: Desktop lifecycle; installation continues through main.ts's verified updater.
import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";

import {
  DesktopUpdateIpcRequest,
  type DesktopUpdateState,
  type ServerDesktopUpdateResult,
} from "@synara/contracts";
import { Schema } from "effect";

export const DESKTOP_UPDATE_IPC_ENV = "SYNARA_DESKTOP_UPDATE_IPC";

// The token acknowledges a delivered prepare response; it is never an installer URL or version selector.
export function attachDesktopUpdateControl(
  child: ChildProcess,
  input: {
    readonly isCurrentChild: () => boolean;
    readonly supported: () => boolean;
    readonly getState: () => DesktopUpdateState;
    readonly getInstallBlockedReason: () => string | null;
    readonly check: () => Promise<void>;
    readonly download: () => Promise<unknown>;
    readonly install: () => Promise<unknown>;
  },
): void {
  let ticket: {
    readonly token: string;
    readonly authority: string;
    readonly version: string;
    readonly expiresAt: number;
  } | null = null;
  let committed = false;

  const status = (message: string | null = null): ServerDesktopUpdateResult["status"] => ({
    supported: input.supported(),
    state: input.supported() ? input.getState() : null,
    busy: committed || input.getInstallBlockedReason() !== null,
    message: message ?? input.getInstallBlockedReason(),
  });
  const send = (
    id: string,
    result: ServerDesktopUpdateResult,
    afterSend?: (delivered: boolean) => void,
  ): void => {
    if (!input.isCurrentChild() || !child.connected) {
      afterSend?.(false);
      return;
    }
    try {
      child.send({ type: "synara:desktop-update:response", id, result }, (error) => {
        afterSend?.(!error && input.isCurrentChild());
      });
    } catch {
      // A retiring child cannot cause installation or revive a backend generation.
      afterSend?.(false);
    }
  };
  const onMessage = (raw: unknown): void => {
    if (!input.isCurrentChild() || !Schema.is(DesktopUpdateIpcRequest)(raw)) return;
    const request = raw;
    const refuse = (message: string) =>
      send(request.id, { accepted: false, status: status(message) });
    if (!input.supported()) {
      refuse("Remote updates require the packaged Synara Remote app on macOS.");
      return;
    }
    if (request.action === "status") {
      send(request.id, { accepted: true, status: status() });
      return;
    }
    if (committed) {
      refuse("Synara is already preparing to restart.");
      return;
    }
    if (request.action === "check" || request.action === "download") {
      if (ticket !== null) {
        ticket = null;
      }
      const operation = request.action === "check" ? input.check() : input.download();
      void operation.catch(() => {}); // The canonical updater publishes the failure state.
      send(request.id, { accepted: true, status: status() });
      return;
    }

    const blockedReason = input.getInstallBlockedReason();
    if (blockedReason) {
      ticket = null;
      refuse(blockedReason);
      return;
    }
    const state = input.getState();
    if (
      !request.expectedVersion ||
      state.status !== "downloaded" ||
      state.downloadedVersion !== request.expectedVersion
    ) {
      ticket = null;
      refuse("The downloaded update changed. Refresh its status and confirm again.");
      return;
    }
    if (!request.restartToken) {
      ticket = {
        token: randomUUID(),
        authority: request.authority,
        version: request.expectedVersion,
        expiresAt: Date.now() + 60_000,
      };
      send(request.id, {
        accepted: true,
        status: status(
          "Synara will restart to install the update. This connection will disconnect.",
        ),
        restartToken: ticket.token,
      });
      return;
    }
    if (
      ticket === null ||
      ticket.token !== request.restartToken ||
      ticket.authority !== request.authority ||
      ticket.version !== request.expectedVersion ||
      ticket.expiresAt < Date.now()
    ) {
      refuse("The restart confirmation expired. Refresh its status and confirm again.");
      return;
    }
    ticket = null;
    committed = true;
    // Receipt of this token proves that the remote client received the prepare response.
    send(
      request.id,
      { accepted: true, status: status("Restarting to install the update.") },
      (delivered) => {
        const latest = input.getState();
        if (
          !delivered ||
          latest.status !== "downloaded" ||
          latest.downloadedVersion !== request.expectedVersion ||
          input.getInstallBlockedReason() !== null
        ) {
          committed = false;
          return;
        }
        void input
          .install()
          .catch(() => {})
          .finally(() => {
            committed = false;
          });
      },
    );
  };
  child.on("message", onMessage);
  child.once("exit", () => {
    ticket = null;
    child.removeListener("message", onMessage);
  });
}
