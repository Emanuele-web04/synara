import React from "react";
import { StyleSheet, View } from "react-native";
import SynaraWebView from "@local/synara-webview";

function App() {
  return (
    <View style={styles.container}>
      <SynaraWebView url="http://127.0.0.1:4773" style={styles.webview} />
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
