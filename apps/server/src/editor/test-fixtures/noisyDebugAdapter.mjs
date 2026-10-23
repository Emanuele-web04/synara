// A deterministic DAP peer for exercising the service's bounded polling history.
// It never launches workspace code; the service owns and tears down this process.
import net from "node:net";

let sequence = 0;
const frame = (message) => {
  const body = JSON.stringify({ seq: ++sequence, ...message });
  return Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
};
const server = net.createServer((socket) => {
  let buffer = Buffer.alloc(0);
  let child = false;
  const send = (message) => socket.write(frame(message));
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const separator = buffer.indexOf("\r\n\r\n");
      if (separator < 0) return;
      const length = Number(
        /Content-Length: (\d+)/.exec(buffer.subarray(0, separator).toString())[1],
      );
      const end = separator + 4 + length;
      if (buffer.length < end) return;
      const request = JSON.parse(buffer.subarray(separator + 4, end).toString());
      buffer = buffer.subarray(end);
      if (request.type !== "request") continue;
      const respond = (body = {}) =>
        send({
          type: "response",
          request_seq: request.seq,
          command: request.command,
          success: true,
          body,
        });
      if (request.command === "launch") {
        child = Boolean(request.arguments.__pendingTargetId);
        respond();
      } else if (request.command === "configurationDone") {
        respond();
        if (!child) {
          send({ type: "event", event: "stopped", body: { reason: "quiet target", threadId: 1 } });
          send({
            type: "request",
            command: "startDebugging",
            arguments: {
              request: "launch",
              configuration: { name: "Noisy child", __pendingTargetId: "child" },
            },
          });
        }
      } else if (request.command === "evaluate") {
        const { event, count, size } = JSON.parse(request.arguments.expression);
        const messages = [];
        for (let index = 0; index < 600; index++)
          messages.push({
            type: "event",
            event: index % 2 ? "stopped" : "continued",
            body: { threadId: 7 },
          });
        messages.push({ type: "event", event, body: { threadId: 7 } });
        for (let index = 0; index < count; index++)
          messages.push({ type: "event", event: "output", body: { output: "x".repeat(size) } });
        socket.write(Buffer.concat(messages.map(frame)));
        respond({ result: "burst complete", variablesReference: 0 });
      } else {
        respond();
      }
    }
  });
});
server.listen(0, "127.0.0.1", () => {
  console.log(`Debug server listening at 127.0.0.1:${server.address().port}`);
});
