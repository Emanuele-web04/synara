import "./storageOriginMigration";

import { bootstrapSignedOutScreen } from "./authSignedOut";
import { bootstrapPairingSession } from "./pairingBootstrap";

if (!bootstrapSignedOutScreen()) {
  void bootstrapPairingSession().then((result) => {
    if (result === "not-pairing") {
      return import("./main");
    }
  });
}
