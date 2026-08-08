# Python — Layered Scaffold

Applies to Python services, APIs, CLIs, and libraries (3.10+). Read with [../layered-architecture.md](../layered-architecture.md).

## 1. Recommended directory structure

**Small project (src layout — always use src layout):**

```
pyproject.toml
src/myapp/
├── domain/              # entities, value objects, rules — pure Python
│   ├── order.py
│   └── errors.py
├── application/         # use cases + ports
│   ├── place_order.py
│   └── ports.py         # OrderRepository, Clock, PaymentGateway (Protocols)
├── adapters/
│   ├── api/             # FastAPI/Flask routers + request/response schemas
│   ├── db/              # SQLAlchemy models + repository implementations
│   └── cli/             # CLI entry (typer/argparse) as another adapter
├── infrastructure/      # engine/session factories, settings, logging config
├── main.py              # composition root: build adapters, wire, run
└── shared/              # tiny shared kernel (Result, ids)
tests/
├── unit/                # domain + application with fakes
├── integration/         # adapters against real deps
└── conftest.py
```

**Grown project (feature-modular):**

```
src/myapp/
├── orders/
│   ├── domain.py        # or domain/ package as it grows
│   ├── application.py
│   └── adapters/
├── billing/
│   └── ...
├── infrastructure/
├── shared/
└── main.py
```

## 2. Layer mapping

- **Domain** — `@dataclass(frozen=True)` value objects, entities with invariant-checking constructors, pure functions. Stdlib imports only. Pydantic is *not* used here — pydantic models are validation/serialization DTOs and belong at the seams.
- **Application** — use-case classes/functions taking ports as parameters. Ports are `typing.Protocol` classes (preferred over ABCs — structural typing means adapters don't import the port to conform, keeping even the type-dependency pointing inward).
- **Adapters** — FastAPI routers (parse/validate with pydantic → call use case → shape response), repository classes implementing ports over SQLAlchemy, mappers between ORM/pydantic models and domain objects. SQLAlchemy models stay in `adapters/db`, never imported by domain/application.
- **Infrastructure** — engine/session factories, settings (`pydantic-settings` reading env), logging config, task-queue/client construction.
- **Composition root** — `main.py` (plus FastAPI dependency wiring if used): construct settings → infrastructure → adapters → use cases. Framework DI (FastAPI `Depends`) is referenced only in the api adapter and main; use cases receive plain objects.

## 3. Boundary enforcement

Use **import-linter** with contracts in `pyproject.toml` from day one:

```toml
[tool.importlinter]
root_package = "myapp"

[[tool.importlinter.contracts]]
name = "Layered"
type = "layers"
layers = ["myapp.adapters | myapp.infrastructure", "myapp.application", "myapp.domain"]

[[tool.importlinter.contracts]]
name = "Domain is pure"
type = "forbidden"
source_modules = ["myapp.domain", "myapp.application"]
forbidden_modules = ["fastapi", "sqlalchemy", "pydantic", "requests", "httpx"]
```

Run `lint-imports` in CI beside ruff and a strict-mode type checker (mypy/pyright) — typed ports are only contracts if the checker runs. In feature-modular layouts add an `independence` contract between feature packages.

## 4. Testing conventions

- **Domain/application** — pytest unit tests with hand-written fakes (a `dict`-backed `FakeOrderRepository`); no `unittest.mock.patch`. If a test needs `patch`, the code is importing a dependency instead of receiving it.
- **Adapters** — integration tests: repositories against real Postgres (Testcontainers) or SQLite where honest; API routers via `TestClient` with fake ports injected through the composition wiring; HTTP clients against `respx`/`responses` stubs.
- **End-to-end** — a few smoke tests through the fully wired app.
- Fixture discipline: `conftest.py` provides fakes and wiring helpers, not a parallel universe of magic.

## 5. Smells & refactor moves

- **Fat views/routes** (validation + queries + rules in one function) → extract the rules into a use case; route keeps parse → call → respond.
- **SQLAlchemy or pydantic models as the domain model** (business methods on ORM classes, pydantic models passed everywhere) → introduce plain domain classes; map at the repository/router seams.
- **Module-level singletons** (`db = create_engine(...)` at import time, settings read on import) → construct in `main.py`, pass explicitly; import-time side effects also break test isolation.
- **`utils.py` grab-bag** → relocate each function next to its consumer or name the concept in `shared/`.
- **`patch`-heavy test suite** → each patch marks a hidden dependency; refactor the target to accept a port, replace the patch with a fake, repeat.
