module.exports = {
  dependency: {
    platforms: {
      desktop: {
        crate: "synara-webview",
        hostComponents: [{ name: "SynaraWebView", nativeSurface: true }],
      },
    },
  },
};
