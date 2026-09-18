# Smart Waste Collection

CivicCycle connects residents, collection crews, and municipal operations teams around reliable waste collection and issue resolution.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm --filter @workspace/smart-waste run dev` — run the web app
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- Required env: `DATABASE_URL`, `SESSION_SECRET`, and `GEMINI_API_KEY`

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/smart-waste` — React/Vite web application and shared visual system
- `artifacts/api-server` — Express API, session auth, migrations, seed data, and role-scoped routes
- `artifacts/api-server/src/db/schema.ts` — PostgreSQL schema used by development initialization
- `lib/api-spec/openapi.yaml` — source of truth for generated API hooks and Zod contracts
- `artifacts/smart-waste/src/index.css` — CivicCycle theme tokens

## Architecture decisions

- Opaque, database-backed HTTP sessions keep authentication server-owned and avoid exposing role decisions to the browser.
- All dashboards and operational lists are served from PostgreSQL queries; the web app uses generated OpenAPI hooks rather than mock state.
- Waste guidance uses a server-only Gemini call when configured and a conservative deterministic fallback when the model is unavailable.
- The same API enforces citizen, collector, and admin boundaries regardless of frontend navigation.

## Product

Citizens can see collection schedules, submit and track complaints, read notifications, and ask for safe waste-segregation guidance. Collectors can work their assigned collection queue and update outcomes. Administrators can monitor system health, triage complaints, manage users/zones, inspect analytics, and review audit events.

## User preferences

No additional user preferences recorded.

## Gotchas

- The API initializes its development schema and demo data before listening; demo accounts use the documented development password `WasteDemo#2026`.
- Run API codegen after changing `lib/api-spec/openapi.yaml`, then run the workspace typecheck.
- The frontend workflow supplies `PORT` and `BASE_PATH`; do not start the Vite app directly without them.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
