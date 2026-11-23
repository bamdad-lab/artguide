# Art Ear: paused

Paused on 23 November 2026. Testers see "The Art Ear test has ended" and can't scan.
The admin page still works, so data can be exported.

## What exists

| Part | Where |
|---|---|
| Phone app | `docs/index.html`, served by GitHub Pages at https://bamdad-lab.github.io/artguide/ |
| Admin page | `docs/admin.html`, at https://bamdad-lab.github.io/artguide/admin.html |
| Backend | `backend/`: a Cloudflare Worker (`gallery-ear.bam-ayati.workers.dev`) with a D1 database (`gallery-ear`) |
| Deploys | Pushing to `main` deploys the app (GitHub Pages) and, for `backend/` changes, the backend (`.github/workflows/deploy-backend.yml`) |
| Phase 0 Python pipeline | `artguide/`, from the original build spec. Not used by the app |

GitHub repository secrets used by the backend deploy: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
`ANTHROPIC_API_KEY`, `ADMIN_PASSWORD`, `GOOGLE_VISION_API_KEY` (optional).

## How it works now

1. The phone takes a photo, cropped to the corner guides.
2. Claude (model assigned by the backend, balanced across Opus, Sonnet and Haiku) tries to identify the work
   and writes commentary. Google Cloud Vision web detection runs at the same time, independently.
3. If Claude identifies the work, audio plays at once (the phone's built-in voice). The badge then says
   whether Google agreed.
4. If not, suggestions from Google and Claude are shown, with pictures from the page, Wikipedia or Wikimedia Commons.
5. Testers answer "Was this right?". Everything is stored in D1 and shown in admin.

## To resume

1. Anthropic: make sure the account has credit (the free promotional credit expired on 3 Dec 2026)
   and create an API key. Put it in the GitHub secret `ANTHROPIC_API_KEY`.
2. Google image search (optional): create or re-enable a Cloud Vision API key and put it in `GOOGLE_VISION_API_KEY`.
3. In `backend/wrangler.toml`, set `PAUSED = "0"`. Commit and push to `main`; the backend redeploys.
   (Or change it and run Actions → Deploy backend → Run workflow.)
4. If the repository was made private, make it public again so GitHub Pages serves the app,
   or host `docs/` elsewhere and keep `docs/config.js` pointing at the backend.
5. In admin, create invites and send the links.

If the Cloudflare Worker or database was deleted, the deploy workflow recreates both, but old scans are gone.

## What the test showed

- Claude alone is a weak identifier from photos. In a real gallery (Gagosian, 7 Nov) Google Lens found
  works the app missed, including obscure ones.
- Google Cloud Vision (the official API) is weaker than Lens. There is no official Lens API; services
  such as SerpApi scrape it, which Google's terms don't allow.
- Main usability problems: waiting time, no zoom, square crop picks up wall and other works, angled photos,
  robotic voice, suggestions without pictures.
- Testers were too busy to use it, so there's little data beyond the organiser's own scans.
- A free alternative (Lens plus Gemini, or Gemini Live with the camera) covers "what is this, tell me about it"
  for consumers. A paid consumer app looks weak.

## Planned next steps, if resumed

1. Image search identifies, Claude narrates: use Lens-quality results first, Claude as backup. Faster and more accurate.
2. Crop box after the photo (like Lens's highlight) and pinch-to-zoom.
3. Natural voice (Google Cloud Text-to-Speech) and streamed audio.
4. Narration grounded in the museum's own page text.
5. In the analysis, report "Right" answers on suggestions without pictures separately (title-matched, not picture-matched).

Most promising direction: a product for one gallery or museum, using its own collection images and texts,
rather than "identify any artwork anywhere". Worth testing with one or two galleries before more building.
