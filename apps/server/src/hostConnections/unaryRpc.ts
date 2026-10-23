import WebSocket, { type RawData } from "ws";

/** One request, no replay. Closing/aborting a stream leaves mutation outcomes uncertain. */
export function remoteUnaryRpc(
  socket: WebSocket,
  tag: string,
  payload: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("message", message);
      socket.off("close", closed);
      socket.off("error", closed);
      signal.removeEventListener("abort", aborted);
    };
    const fail = (reason: string) => {
      cleanup();
      reject(new Error(reason));
    };
    const closed = () =>
      fail(
        "Remote connection closed; a submitted mutation may have completed. Do not replay it automatically.",
      );
    const aborted = () =>
      fail("Remote tool call cancelled; a submitted mutation may have completed.");
    const message = (data: RawData) => {
      try {
        const frame = JSON.parse(data.toString());
        if (frame._tag !== "Exit" || String(frame.requestId) !== "1") return;
        cleanup();
        if (frame.exit?._tag === "Success") resolve(frame.exit.value);
        else {
          const failure = Array.isArray(frame.exit?.cause)
            ? frame.exit.cause.find((entry: { _tag?: string }) => entry._tag === "Fail")?.error
            : undefined;
          reject(
            new Error(
              typeof failure?.message === "string"
                ? failure.message
                : "Remote tool request was refused or interrupted.",
            ),
          );
        }
      } catch {
        fail("Invalid remote tool response.");
      }
    };
    const timer = setTimeout(
      () => fail("Remote tool call timed out; a submitted mutation may have completed."),
      120_000,
    );
    socket.on("message", message);
    socket.once("close", closed);
    socket.once("error", closed);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) return aborted();
    if (socket.readyState !== WebSocket.OPEN) return closed();
    socket.send(
      JSON.stringify({ _tag: "Request", id: "1", tag, payload, headers: [] }),
      (error) => {
        if (error) closed();
      },
    );
  });
}
