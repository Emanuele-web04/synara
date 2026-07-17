import {
  isCacheableShellRequest,
  isMobileNavigation,
  notificationPreview,
} from "./lib/cachePolicy";

declare const __SYNARA_MOBILE_PRECACHE__: readonly string[];

const worker = self as unknown as ServiceWorkerGlobalScope;
const cacheName = "synara-companion-shell-v1";
const appShellUrl = "/mobile/";
const precache = __SYNARA_MOBILE_PRECACHE__;

worker.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(cacheName)
      .then((cache) => cache.addAll([...precache]))
      .then(() => worker.skipWaiting()),
  );
});

worker.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key.startsWith("synara-companion-shell-") && key !== cacheName)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => worker.clients.claim()),
  );
});

worker.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (isMobileNavigation(url, request.mode)) {
    event.respondWith(
      fetch(request).catch(async () => {
        const cached = await caches.match(appShellUrl);
        return cached ?? Response.error();
      }),
    );
    return;
  }

  if (!isCacheableShellRequest(url, worker.location.origin)) return;
  event.respondWith(
    caches.match(request).then(async (cached) => {
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok) {
        const cache = await caches.open(cacheName);
        await cache.put(request, response.clone());
      }
      return response;
    }),
  );
});

interface PushPayload {
  readonly kind?: string;
  readonly threadId?: string;
  readonly title?: string;
  readonly preview?: string;
}

worker.addEventListener("push", (event) => {
  const payload = readPushPayload(event.data);
  const threadId = safeThreadId(payload.threadId);
  const destination = threadId
    ? `${worker.location.origin}/mobile/threads/${encodeURIComponent(threadId)}`
    : `${worker.location.origin}/mobile/`;
  const destinationPath = new URL(destination).pathname;

  event.waitUntil(
    worker.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (clients) => {
      const visibleThread = clients.find(
        (client) =>
          client.visibilityState === "visible" &&
          new URL(client.url).pathname.replace(/\/$/, "") === destinationPath.replace(/\/$/, ""),
      );
      if (visibleThread) {
        visibleThread.postMessage({ type: "companion-push", payload });
        return;
      }

      const body = notificationPreview(payload.preview);
      await worker.registration.showNotification(
        notificationPreview(payload.title) ?? notificationTitle(payload.kind),
        {
          ...(body ? { body } : {}),
          icon: "/mobile/icons/synara-192.png",
          badge: "/mobile/icons/synara-192.png",
          tag: `${payload.kind ?? "synara"}:${threadId ?? "home"}`,
          data: { destination },
        },
      );
    }),
  );
});

worker.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data as { destination?: unknown } | undefined;
  const destination =
    typeof data?.destination === "string" && data.destination.startsWith(worker.location.origin)
      ? data.destination
      : `${worker.location.origin}/mobile/`;

  event.waitUntil(
    worker.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (clients) => {
      const existing = clients.find((client) => client.url.startsWith(worker.location.origin));
      if (existing) {
        await existing.navigate(destination);
        return existing.focus();
      }
      return worker.clients.openWindow(destination);
    }),
  );
});

function readPushPayload(data: PushMessageData | null): PushPayload {
  if (!data) return {};
  try {
    const value: unknown = data.json();
    return value && typeof value === "object" ? (value as PushPayload) : {};
  } catch {
    return {};
  }
}

function safeThreadId(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) return undefined;
  return value;
}

function notificationTitle(kind: string | undefined): string {
  switch (kind) {
    case "task_completed":
      return "Task completed";
    case "task_failed":
      return "Task needs attention";
    case "approval_required":
      return "Approval required";
    case "user_input_required":
      return "Synara needs your input";
    default:
      return "Synara update";
  }
}
