// This interval includes the builder's sanity/fuse preparation before signing.
const starts = new Map();
module.exports = (context) => {
  starts.set(context.appOutDir, performance.now());
  console.log(
    `[build-timing] ${JSON.stringify({ stage: "app-signing-and-preparation", event: "start", at: new Date().toISOString() })}`,
  );
};
module.exports.finish = (context) => {
  const start = starts.get(context.appOutDir);
  if (start === undefined) throw new Error("Missing macOS signing preparation boundary.");
  starts.delete(context.appOutDir);
  console.log(
    `[build-timing] ${JSON.stringify({ stage: "app-signing-and-preparation", event: "complete", at: new Date().toISOString(), durationMs: Math.round(performance.now() - start) })}`,
  );
};
