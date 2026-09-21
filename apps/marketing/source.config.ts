import { defineConfig, defineDocs } from "fumadocs-mdx/config";

export const docs = defineDocs({
  dir: "content/docs",
  docs: {
    postprocess: {
      includeProcessedMarkdown: true,
    },
    // stamps pages with last git commit date — needs VERCEL_DEEP_CLONE=true on Vercel to see history
    lastModified: true,
  },
});

export default defineConfig();
