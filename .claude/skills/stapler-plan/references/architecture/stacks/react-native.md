# React Native (JavaScript / TypeScript) — Layered Scaffold

Applies to React Native and Expo apps. Everything in [stacks/react.md](react.md) applies; this file covers what mobile adds: navigation, device APIs, native modules, and offline storage. Read with [../layered-architecture.md](../layered-architecture.md).

## 1. Recommended directory structure

```
src/
├── domain/              # pure business types + rules
├── api/                 # HTTP clients + DTO mappers
├── query/               # react-query hooks: useQuery/useMutation wrapped around api/ services
├── storage/             # AsyncStorage/MMKV/SQLite wrappers behind interfaces
├── hooks/               # application seam: use-case hooks
├── components/          # presentational components
├── screens/             # route-level screens composing hooks + components
├── navigation/          # navigators + typed route params
├── theme/               # design tokens
└── App.tsx              # composition root: providers, navigation container
```

This shape (`screens/ hooks/ query/ api/ storage/`) scales **if** the separation rules hold — screens stay thin, server state lives in query hooks, logic lives in hooks and domain code.

## 2. Layer mapping

- **Domain** — pure TS: profile/entity types, validation, calculations. No React, no React Native imports. Runs under plain Node in tests.
- **Application** — use-case hooks (`useChat`, `useCart`) orchestrating domain logic, API calls, and storage, plus `query/` hooks pairing react-query's `useQuery`/`useMutation` with `api/` service functions for server state (caching, polling, invalidation). Expose intent (`sendMessage`), not state setters.
- **Adapters** — API modules mapping wire DTOs ↔ domain types; storage modules exposing typed interfaces (`GuideStore`) over AsyncStorage/MMKV/SQLite; navigation as an adapter — screens receive typed params, business code never imports the navigation library.
- **Infrastructure** — HTTP client, storage engine, push/analytics SDKs, permissions, camera/image pickers, native modules. Each device capability gets a small wrapper module so the vendor SDK is named in exactly one place.
- **Composition root** — `App.tsx`: provider tree, navigation container, client/store construction.
- **Presentation** — components and screens render state from hooks. A screen that calls `fetch` or `AsyncStorage` directly has skipped the layers.

## 3. Boundary enforcement

- **eslint-plugin-boundaries** or **dependency-cruiser**, same rules as React: `domain/` may not import `react`/`react-native`; `components/` and `screens/` may not import `api/` or `storage/` directly; no cycles.
- `no-restricted-imports`: ban direct `@react-native-async-storage/async-storage`, camera, and analytics imports outside their wrapper adapters — device SDKs are the mobile equivalent of a database driver and leak everywhere if allowed.
- Keep secrets and API keys out of the bundle: config module reads from env/backend, enforced by review — anything shipped in the JS bundle is public.

## 4. Testing conventions

- **Domain** — plain Jest unit tests, no mocks, run on Node.
- **Hooks** — `renderHook` (React Native Testing Library) with fake adapters or MSW for HTTP; fake storage is an in-memory object implementing the storage interface.
- **Components/screens** — React Native Testing Library interaction tests; mock only at the adapter seams already defined (storage interface, API client), not arbitrary internals.
- **Native/device behavior** — Detox or Maestro end-to-end smoke flows on simulator; keep these few.
- `jest.setup.js` mocks live for infrastructure wrappers only — a growing setup-mock file is a sign device SDKs are being imported outside their adapters.

## 5. Smells & refactor moves

- **Screen doing everything** (fetch + AsyncStorage + business rules + rendering) → extract a use-case hook, push persistence behind a storage interface, screen keeps rendering + navigation only.
- **AsyncStorage keys and JSON parsing scattered across files** → one storage adapter per aggregate with typed get/save; keys become private constants inside it.
- **Navigation calls inside hooks or api code** → return outcomes from hooks; let screens navigate. Business logic that knows route names can't be reused or tested.
- **Vendor SDK imported in many files** (analytics, camera, purchases) → wrap in one adapter module; swap/upgrade becomes a one-file change.
- **Platform `if (Platform.OS === ...)` branching in business logic** → hoist platform differences into the adapter/infrastructure layer (`.ios.ts`/`.android.ts` files or a capability port).
