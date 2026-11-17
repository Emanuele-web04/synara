const path = require("node:path");
const { makeMetroConfig } = require("@react-native-gpui/core/metro.config");

module.exports = makeMetroConfig({
  projectRoot: path.resolve(__dirname, ".."),
});
