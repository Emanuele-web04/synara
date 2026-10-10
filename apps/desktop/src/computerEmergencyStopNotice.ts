import * as Http from "node:http";

export const DESKTOP_COMPUTER_EMERGENCY_STOP_ROUTE_PATH = "/api/desktop/computer/emergency-stop";

const REQUEST_TIMEOUT_MS = 5_000;
const RETRY_DELAYS_MS = [1_000, 3_000] as const;

function isLoopbackBackendUrl(url: URL): boolean {
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    (url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "localhost")
  );
}

function postOnce(input: {
  readonly backendHttpUrl: string;
  readonly shutdownToken: string;
}): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = new URL(input.backendHttpUrl);
    if (!isLoopbackBackendUrl(url)) {
      reject(new Error("Computer emergency-stop notice requires a loopback backend endpoint."));
      return;
    }
    url.pathname = DESKTOP_COMPUTER_EMERGENCY_STOP_ROUTE_PATH;
    url.search = "";
    url.hash = "";

    const request = Http.request(
      url,
      {
        method: "POST",
        agent: false,
        headers: {
          Authorization: `Bearer ${input.shutdownToken}`,
          "Content-Length": "0",
        },
      },
      (incoming) => {
        incoming.resume();
        resolve(incoming.statusCode ?? 0);
      },
    );
    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error("Computer emergency-stop notice timed out."));
    });
    request.once("error", reject);
    request.end();
  });
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === "object" && timer !== null && "unref" in timer) {
    timer.unref();
  }
}

/**
 * Best-effort relay of a physical Escape interrupt into the backend's
 * computer manager. The desktop's local interrupt already engaged before
 * this runs, so a lost notice must never delay or weaken the stop — the
 * retries only cover a backend that is mid-restart when the key lands.
 *
 * Authorization reuses the desktop-owner shutdown credential: a caller that
 * may stop the backend may also stop its computer input. The notice carries
 * no payload; everything it means is implied by the authenticated route.
 */
export function notifyBackendComputerEmergencyStop(input: {
  readonly backendHttpUrl: string;
  readonly shutdownToken: string;
  readonly onError?: (message: string) => void;
}): void {
  const report = input.onError ?? (() => undefined);
  if (!input.backendHttpUrl || !input.shutdownToken) {
    report("computer emergency-stop notice has no backend endpoint or credential");
    return;
  }
  void (async () => {
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        const status = await postOnce(input);
        if (status === 202) return;
        report(`computer emergency-stop notice returned HTTP ${status}`);
      } catch (error) {
        report(`computer emergency-stop notice failed: ${String(error)}`);
      }
      if (attempt < RETRY_DELAYS_MS.length) {
        await new Promise<void>((resolve) => {
          const delayTimer = setTimeout(resolve, RETRY_DELAYS_MS[attempt]);
          unrefTimer(delayTimer);
        });
      }
    }
  })();
}
