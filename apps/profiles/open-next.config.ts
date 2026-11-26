import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// Publication state is read on every request. No persistent profile cache:
// hiding a profile must also hide its page and preview on the next request.
export default defineCloudflareConfig({});
