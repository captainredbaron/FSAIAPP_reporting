# GWR Report Worker (Cloud Run)

Background worker that processes `report_jobs` from Supabase and generates immutable report artifacts.

## Responsibilities
- Claim jobs via `claim_report_jobs` RPC
- Build inspection snapshot
- Stage assets (thumbnails + chart PNGs)
- Render PDF via Playwright Chromium
- Upload PDF to `inspection-reports`
- Update `inspection_report_versions`, `inspection_report_latest`, compatibility pointer, and job state

## Required Environment
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- optional `REPORTS_BUCKET` (default `inspection-reports`)
- optional `REPORT_ASSETS_BUCKET` (default `inspection-report-assets`)
- optional `REPORT_TEMPLATE_VERSION` (default `v2`)
- optional `WORKER_ID`
- optional `POLL_INTERVAL_MS` (default `5000`)
- optional `CLAIM_BATCH_SIZE` (default `1`)

## Local
1. `cd workers/report-worker`
2. `npm install`
3. `npm run dev`
