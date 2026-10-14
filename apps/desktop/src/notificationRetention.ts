// FILE: notificationRetention.ts
// Purpose: Keep shown desktop notifications strongly referenced until they can
//          no longer be activated. Electron clears a Notification's native
//          delegate when its JS wrapper is garbage-collected, so a toast whose
//          object is only held by a local variable silently drops its `click`
//          (and `close`) events a few seconds after it is shown.
// Layer: Desktop main process
// Depends on: nothing. Structural notification type so it is testable without Electron.

/** Hard ceiling on retained notifications; Windows keeps 20 per app in the notification center. */
export const MAX_RETAINED_DESKTOP_NOTIFICATIONS = 50;

type NotificationCloseDetails = { readonly reason?: string } | undefined;

export interface RetainableNotification {
  once(event: "click", listener: () => void): unknown;
  once(event: "failed", listener: () => void): unknown;
  on(event: "close", listener: (details: NotificationCloseDetails) => void): unknown;
}

export function createDesktopNotificationRetainer<T extends RetainableNotification>(
  limit: number = MAX_RETAINED_DESKTOP_NOTIFICATIONS,
) {
  const retained = new Set<T>();

  const release = (notification: T): void => {
    retained.delete(notification);
  };

  return {
    retain(notification: T): void {
      retained.add(notification);
      while (retained.size > limit) {
        const oldest = retained.values().next().value;
        if (oldest === undefined) break;
        retained.delete(oldest);
      }
      notification.once("click", () => release(notification));
      notification.once("failed", () => release(notification));
      notification.on("close", (details) => {
        // A Windows toast that times out moves to the notification center and
        // stays clickable there, so only an explicit dismissal ends its life.
        if (details?.reason !== "timedOut") {
          release(notification);
        }
      });
    },
    get size(): number {
      return retained.size;
    },
  };
}
