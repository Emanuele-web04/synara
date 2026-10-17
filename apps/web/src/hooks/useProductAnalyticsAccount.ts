// FILE: useProductAnalyticsAccount.ts
// Purpose: Tells the desktop usage sender which account is signed in, so one person
//   counts once across devices. The desktop keeps only a hash of the user id.
// Layer: Web hook

import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";

import { accountStatusQueryOptions } from "~/lib/accountReactQuery";
import { productAnalyticsBridge } from "~/lib/productAnalytics";

export function useProductAnalyticsAccount(): void {
  const status = useQuery(accountStatusQueryOptions()).data;
  const userId =
    status === undefined ? undefined : status.state === "signed-in" ? status.me.id : null;
  useEffect(() => {
    if (userId === undefined) return;
    try {
      productAnalyticsBridge()?.setAccount?.(userId);
    } catch {
      // Usage data never affects the app.
    }
  }, [userId]);
}
