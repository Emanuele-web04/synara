// FILE: bootstrap.ts
// Purpose: Completes synchronous renderer storage migration before any app store can hydrate.

import "./storageKeyMigration";

void import("./main");
