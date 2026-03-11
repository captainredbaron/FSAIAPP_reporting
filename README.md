# GWR Reporting Portal

Desktop-first reporting portal for the existing food safety inspection backend.

## Scope
- Dashboard KPIs and trends (`/reporting`)
- Inspections Explorer with filters and PDF access (`/reporting/inspections`)
- Admin module for client setup, checklist builder, and assignments (`/reporting/admin`)
- Shared Supabase auth/users with the capture app

## Reporting Pipeline v2 (Implemented)
- Vercel route `/api/internal/reports/worker` is enqueue-only (fast, no heavy PDF render)
- Supabase-backed queue and artifact versioning:
  - `report_jobs`
  - `inspection_report_versions`
  - `inspection_report_latest`
  - `inspection_report_assets`
- Public endpoints:
  - `GET /api/inspections/:id/report?kind=summary|full` (backward-compatible default)
  - `GET /api/inspections/:id/report/status`
- Internal endpoint:
  - `POST /api/internal/reports/requeue` (auth by bearer secret)
- External worker package:
  - `workers/report-worker` (Cloud Run target)

## Required Environment Variables (Next.js app)
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `REPORTS_TRIGGER_SECRET`
- `CRON_SECRET`
- optional `REPORT_TEMPLATE_VERSION` (default `v2`)
- optional `NEXT_PUBLIC_APP_BUILD_CODE`

## Database Migrations
Run in order:
1. `supabase/migrations/0001_inspection_reports.sql`
2. `supabase/migrations/0002_report_pipeline_v2.sql`
3. `supabase/migrations/0003_client_checklists_and_assignments.sql`

## Admin APIs
- `GET|POST /api/admin/checklists` (version retrieval by `client_id`, draft creation)
- `POST /api/admin/checklists/publish` (publish + activate version)
- `GET|POST|PATCH /api/admin/assignments` (list/create/update assignment lifecycle)

## Cloud Run Worker
- Worker lives at `workers/report-worker`
- Build/deploy this package as a separate service to process `report_jobs`
- Worker reads from Supabase and writes staged assets + immutable PDFs to Storage

## Local Setup (Next.js app)
1. `npm install`
2. Configure `.env.local` from `.env.example`
3. `npm run dev`

## Notes
- This repo is reporting-focused and intentionally separate from mobile capture flow.
- Heavy report rendering is externalized for scale and to avoid Vercel invocation timeouts.
