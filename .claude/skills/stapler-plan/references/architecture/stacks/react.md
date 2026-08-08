# React (JavaScript / TypeScript) — Layered Scaffold

Applies to React web apps (Vite/Next/CRA-style SPAs; for Next.js the same layering applies inside `app/` route segments with server components as adapters). Read with [../layered-architecture.md](../layered-architecture.md).

## 1. Recommended directory structure

```
src/
├── assets/          # static assets: images, global styles (scss)
├── components/      # reusable presentational components (one folder per component, index barrel)
├── context/         # React context providers for client state
├── features/        # feature modules: composed feature UI (cards, forms, feature components)
├── hooks/           # shared custom hooks (useDebounce, useTableData, modal hooks)
├── layouts/         # page layouts (dashboard, login, default)
├── query/           # data layer: React Query hooks per domain (*.query)
├── routing/         # router config, route guards (RequireAuth), public/protected routes, menu config
├── services/        # API service modules + base HTTP client (*.service)
├── tables/          # table column/config definitions
├── validation/      # form & schema validation
├── views/           # route-level screens, grouped by area (users, server, auth, …)
├── App.jsx          # composition root: providers, router
└── index.jsx        # entry point
```

**Conventions:** directory names are always lowercase; component files are PascalCase (`UserModal.jsx`); role suffixes name the layer a file belongs to (`user.service.js`, `ai.query.jsx`, `Dashboard.layout.jsx`, `protected.routes.jsx`); each component or feature folder exposes an `index.jsx` barrel that is its public API.

## 2. Layer mapping

- **Domain** — framework-free rules and configuration: `validation/` (schemas, invariants), `tables/` (column/config definitions), and domain types alongside them. Imports no React. This is code that would survive a switch to Vue unchanged.
- **Application** — `hooks/` is the use-case layer: a hook like `useTableData()` composes queries, mutations, and domain logic, and exposes intent-named callbacks (`submitOrder`), not setters. Genuine client state lives in `context/` providers.
- **Data** — `query/` owns server-cache state: React Query hooks per domain (`ai.query.jsx`) that call services. Server data lives here, never copied into `useState` or context.
- **Adapters / Infrastructure** — `services/`: the base HTTP client plus per-domain API modules (`user.service.js`) mapping wire DTOs ↔ domain types at the fetch boundary, not in components. Auth/token plumbing and analytics SDKs also live here.
- **Composition root** — `App.jsx` + `routing/`: provider tree, router and route guards, store/client construction. Feature code never constructs clients.
- **Presentation** — `components/` (prop-driven, reusable), `features/` (composed feature UI), `views/` (route-level screens composing layouts, features, and components), `layouts/`. A component that imports the HTTP client or a service directly has skipped two layers.

## 3. Boundary enforcement

- **eslint-plugin-boundaries** (or dependency-cruiser): `validation/` and `tables/` may not import React (`no-restricted-imports` for `react` inside those dirs); `components/`, `features/`, and `views/` may not import `services/` directly (must go through `query/` or `hooks/`); import components and features only via their `index.jsx` barrel, no deep imports.
- Forbid cross-feature deep imports and cycles (`import/no-cycle` or the cruiser's `circular` rule).
- Server state stays in `query/`: lint against storing fetched data in `useState`/context (convention + review; no perfect lint exists).

## 4. Testing conventions

- **Domain (`validation/`, `tables/`)** — plain unit tests, no rendering, no mocks. This is where business-logic coverage concentrates.
- **Hooks (`hooks/`, `query/`)** — `renderHook` with a test QueryClient and **MSW** stubbing the network at the HTTP boundary (mock the wire, not your own modules).
- **Components** — React Testing Library, asserting behavior (roles, text, interactions), not implementation. Presentational components need few tests; views get interaction tests.
- **End-to-end** — Playwright/Cypress smoke flows over the composed app.

## 5. Smells & refactor moves

- **Fetch + business logic inside a component** → extract the fetch into a `query/` hook backed by a `services/` module; extract rules into `validation/`; component keeps only rendering.
- **Wire DTOs spread through the UI** (components reading `snake_case` API fields) → map DTO → domain type in the `services/` module; UI consumes domain types only.
- **God context** holding the whole app's state → split providers by concern; move server data into `query/`; keep only genuine client state in `context/`.
- **Prop-drilling a client or store** through many layers → provide at the composition root (`App.jsx`), consume via a hook at the use-case layer.
- **`components/` with 100 mixed files** → one folder per component with an `index.jsx` barrel; composed, feature-specific pieces move to `features/`; route-level screens to `views/`.
