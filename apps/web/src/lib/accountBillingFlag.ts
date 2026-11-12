// FILE: accountBillingFlag.ts
// Purpose: Whether this build ships the Synara billing UI. Kept apart from the billing
//          workflows so light modules (the settings taxonomy) can read it.
// Exports: ACCOUNT_BILLING_ENABLED

import { isElectron } from "~/env";

/** Billing UI ships in desktop builds that enable it, or in any sandbox build. */
export const ACCOUNT_BILLING_ENABLED =
  (isElectron && import.meta.env.VITE_SYNARA_BILLING_ENABLED === "1") ||
  import.meta.env.VITE_SYNARA_BILLING_SANDBOX === "1";
