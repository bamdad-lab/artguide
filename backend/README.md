# Gallery Ear backend

A Cloudflare Worker with a D1 database. It keeps the Anthropic key off testers' phones,
checks invite codes, caps daily spending, and stores everyone's scans and photos.

## Deploy

Pushing changes under `backend/` runs `.github/workflows/deploy-backend.yml`.
It needs four repository secrets (Settings → Secrets and variables → Actions):

| Secret | What it is |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token from the "Edit Cloudflare Workers" template, plus D1 Edit |
| `CLOUDFLARE_ACCOUNT_ID` | Shown on the Cloudflare dashboard's Workers & Pages page |
| `ANTHROPIC_API_KEY` | The key that pays for scans |
| `ADMIN_PASSWORD` | 12+ characters, for `docs/admin.html` |

After the first deploy, put the address from the run summary into `docs/config.js`.

## Limits

- `DAILY_USD_CAP` in `wrangler.toml` stops all Claude calls for the rest of the UTC day.
- Each invite has a requests-per-day limit, set when created in the admin page.
- Only Opus 5.5, Sonnet 5.5 and Haiku 5.5 are allowed, with at most 16,000 output tokens and 6 web searches.
