# Node.js (JavaScript / TypeScript) — Layered Scaffold

Applies to Node.js servers, workers, and CLIs. For a **REST API server** — the most common case — the recommended scaffold is the [node-server-boilerplate](https://github.com/obe711/node-server-boilerplate) structure (Express + Mongoose), described below. Read with [../layered-architecture.md](../layered-architecture.md).

## 1. Recommended directory structure

**REST API server (the standard scaffold):**

```
src/
├── config/          # infrastructure config: env vars, logger, passport strategies, roles, tokens
├── routes/
│   └── v1/          # versioned route definitions + swagger annotations — no logic
├── middlewares/     # auth, validate, rateLimiter, centralized error handler
├── validations/     # Joi request schemas (the inbound DTO contract, one file per resource)
├── controllers/     # thin request handlers: pick from req → call service → send response
├── services/        # business logic (service layer) — all rules live here
├── models/          # Mongoose models + plugins (data layer): schema, hooks, toJSON/paginate
├── utils/           # shared kernel: ApiError, catchAsync, pick — keep tiny
├── docs/            # swagger definition + generated API docs
├── app.js           # Express app assembly: security middleware, routes, error handling
└── index.js         # composition root/entry: load config, connect DB, start server
tests/
├── unit/            # middlewares, model methods, plugins, pure service logic
├── integration/     # supertest against the app with a test database
├── fixtures/        # reusable test data (users, tokens)
└── utils/           # setupTestDB and helpers
```

New resources follow the chain: `routes/v1/thing.route.js` → `validations/thing.validation.js` → `controllers/thing.controller.js` → `services/thing.service.js` → `models/thing.model.js`, each layer registered in its `index.js` barrel. To scaffold a new server from this structure directly: `npx create-node-rest-server <project-name>`.

**Non-REST Node projects (CLIs, workers, libraries):** same layering with the HTTP-specific directories replaced by the equivalent seam — `routes/controllers/validations` become the CLI command parser or queue consumer, `services/` and `models/` keep their roles, `index.js` stays the composition root.

## 2. Layer mapping

Request flow is strictly one-way: **route → middleware → controller → service → model**.

- **Routes** — URL surface only: bind paths and verbs to `auth(permission)`, `validate(schema)`, and a controller method. Swagger lives beside the route. A route file containing an `if` statement has taken on someone else's job.
- **Validations (DTOs at the seam)** — Joi schemas define exactly what may enter each endpoint; the `validate` middleware rejects everything else before a controller runs. Request shapes are declared here, never inferred inside controllers.
- **Controllers (interface adapters)** — translate HTTP ↔ service calls: `pick` allowed fields from the request, call one service method, map the result to a status and response body. Wrapped in `catchAsync` so errors flow to the centralized handler. Controllers never import models and hold no business rules.
- **Services (application + domain)** — all business logic: invariants ("email already taken"), orchestration across models and other services (token, email, cookie), throwing `ApiError(status, message)` for rule violations. Services never touch `req`/`res` — they take plain values and return plain values, which is what keeps them callable from tests, jobs, or a future GraphQL adapter unchanged.
- **Models (data layer)** — Mongoose schemas, statics/methods, and cross-cutting plugins (`toJSON` strips `_id`/`__v`/private fields — the persistence-to-wire mapping; `paginate` standardizes list queries). Database concerns end here.
- **Middlewares** — cross-cutting adapters: passport-JWT `auth` with role/permission checks, `validate`, rate limiting, and the error converter/handler pair that turns anything thrown into a consistent JSON error.
- **Config (infrastructure)** — one `config.js` reads and Joi-validates env vars at boot (fail fast on missing config); logger (winston), HTTP logging (morgan), passport strategies, and role/permission maps live beside it.
- **Composition root** — `app.js` assembles the Express app (helmet, cors, sanitizers, compression, routes, error handlers); `index.js` connects Mongoose and starts the server, owning graceful shutdown. Nothing else creates connections.
- **Utils (shared kernel)** — `ApiError`, `catchAsync`, `pick`. Resist growth: anything domain-flavored belongs in a service.

## 3. Boundary enforcement

- **dependency-cruiser** (or `eslint-plugin-boundaries`) encoding the chain:

```js
// .dependency-cruiser.cjs
{ name: 'controllers-no-models',  from: { path: '^src/controllers' }, to: { path: '^src/models' },      severity: 'error' },
{ name: 'services-no-http',       from: { path: '^src/services' },    to: { path: '^src/(routes|controllers|middlewares)' }, severity: 'error' },
{ name: 'models-innermost',       from: { path: '^src/models' },      to: { path: '^src/(services|controllers|routes)' },    severity: 'error' },
{ name: 'no-circular',            from: {},                           to: { circular: true },           severity: 'error' },
```

- ESLint + Prettier with husky/lint-staged pre-commit hooks (included in the boilerplate) so violations never reach CI red.
- Env access only through `src/config/config.js` — `no-restricted-syntax` on `process.env` elsewhere; the Joi-validated config is the single source of runtime settings.
- In TypeScript variants, type the service layer's inputs/outputs explicitly so controllers can't silently pass raw request objects inward.

## 4. Testing conventions

- **Unit (`tests/unit/`)** — middlewares, model methods/plugins, and service rules that don't need the DB; plain Jest, no HTTP.
- **Integration (`tests/integration/`)** — the backbone of this scaffold: **supertest** drives real HTTP through `app.js` against a test MongoDB (`setupTestDB` connects before-all and wipes collections between tests). Each test asserts status, body shape, and resulting DB state. Auth flows use `fixtures/` users and tokens rather than re-registering per test.
- Jest runs serially (`-i`) because tests share the test database; keep it that way rather than fighting cross-test pollution.
- CI (GitHub Actions) runs lint + tests on every push; coverage reported per PR.

## 5. Smells & refactor moves

- **Fat controller** (queries, rules, and response shaping inline) → move rules and DB access into the service; controller returns to pick → call → send.
- **Controller importing a model directly** → route the call through a service method, even a thin one — the seam is what keeps the rule enforceable.
- **Business rules inside Mongoose hooks** (pre-save doing domain decisions) → hooks handle persistence mechanics only (hashing, timestamps); decisions move to services where they're visible and testable.
- **Validation drift** (controllers re-checking fields Joi already guaranteed, or endpoints missing schemas) → every route gets a `validate(schema)`; controllers trust validated input completely.
- **`utils/` accreting business helpers** (`calculateInvoiceTotals` in utils) → domain-flavored code moves into the owning service; utils stays generic (`pick`-sized).
- **Services reaching into `req`/`res` or `http-status` semantics beyond `ApiError`** → pass plain parameters in; let controllers own HTTP.
