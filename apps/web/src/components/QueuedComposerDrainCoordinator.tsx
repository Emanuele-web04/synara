import { useEffect } from "react";

import { resolveAssistantDeliveryMode, useAppSettings } from "../appSettings";
import {
  setQueuedComposerDrainAssistantDeliveryMode,
  startQueuedComposerDrainWatcher,
} from "../lib/queuedComposerDrain";

export function QueuedComposerDrainCoordinator() {
  const { settings } = useAppSettings();
  const assistantDeliveryMode = resolveAssistantDeliveryMode(settings);

  useEffect(() => {
    return startQueuedComposerDrainWatcher();
  }, []);

  useEffect(() => {
    setQueuedComposerDrainAssistantDeliveryMode(assistantDeliveryMode);
  }, [assistantDeliveryMode]);

  return null;
}
