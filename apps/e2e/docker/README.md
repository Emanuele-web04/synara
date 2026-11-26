# Retired relay Docker workflow

The Bun relay Docker workflow was removed with the managed Cloudflare migration. Use `bun run --cwd apps/e2e test` with an isolated `TEST_DATABASE_URL`, then build and run `bun run --cwd apps/e2e test:workspace`. See [operations and limitations](../../../docs/cloudflare-remote.md). These local HTTPS fixtures are not live Cloudflare qualification.
