import React from "react";
import { StyleSheet, View } from "react-native";
import { Menu } from "@react-native-gpui/core/desktop";
import SynaraWebView from "@local/synara-webview";

Menu.setMenuBarVisible(false).catch(() => {});

const SYNARA_PORTS = [4773, 3773];

async function resolveSynaraUrl(): Promise<string> {
  for (const port of SYNARA_PORTS) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) {
        return `http://127.0.0.1:${port}`;
      }
    } catch {}
  }
  return `http://127.0.0.1:${SYNARA_PORTS[0]}`;
}

function App() {
  const [url, setUrl] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    resolveSynaraUrl()
      .then((resolved) => {
        if (!cancelled) setUrl(resolved);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <View style={styles.container}>
      {url ? <SynaraWebView url={url} style={styles.webview} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  webview: {
    flex: 1,
  },
});

export default App;
