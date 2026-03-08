# GWR Reporting Portal

Desktop-first reporting portal for the existing food safety inspection backend.

## Scope
- Dashboard KPIs and trends (`/reporting`)
- Inspections Explorer with filters and PDF access (`/reporting/inspections`)
- Shared Supabase auth/users with the capture app

## Required Environment Variables
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- optional `NEXT_PUBLIC_APP_BUILD_CODE`

## Local Setup
1. `npm install`
2. Configure `.env.local` from `.env.example`
3. `npm run dev`

## Notes
- This repo is read-heavy and reporting-focused.
- It intentionally does not include the mobile inspection capture flow.
