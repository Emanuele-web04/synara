// TypeScript's standard libraries are runtime input to the editor compiler worker.
// Override electron-builder's default .d.ts exclusion only for those libraries.
module.exports = (filePath) =>
  /(?:^|[\\/])node_modules[\\/]typescript[\\/]lib[\\/]lib(?:\.[^\\/]+)?\.d\.ts$/.test(filePath);
