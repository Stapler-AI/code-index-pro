# Layered Architecture: Designing a Codebase Scaffold

Doctrine for structuring a codebase so it stays clean, easy to test, simple to change, and maintainable over years — based on layered architecture and Clean Architecture. Use it when scaffolding a new codebase and when assessing or refactoring a poorly structured one.

## How to use this document

**Scaffolding a new project:**
1. Read this document for the layer model and separation rules.
2. Read the stack file matching the project (table below) for the concrete directory structure, layer mapping, enforcement tooling, and testing conventions.
3. Pick the small-project or feature-modular variant from the stack file based on expected scope. When in doubt, start small — the stack files show structures that grow without rework.

**Assessing / refactoring an existing project:**
1. Read [Refactoring poorly structured codebases](#refactoring-poorly-structured-codebases) below.
2. Read the matching stack file's "Smells & refactor moves" section.
3. Produce the assessment before proposing moves; never reorganize and change behavior in the same step.

| Detected stack | Read |
|---|---|
| Node.js service/CLI (JS or TS) | [stacks/nodejs.md](stacks/nodejs.md) |
| React web app (JS or TS) | [stacks/react.md](stacks/react.md) |
| React Native app (JS or TS) | [stacks/react-native.md](stacks/react-native.md) |
| Swift (iOS / macOS) | [stacks/swift.md](stacks/swift.md) |
| Android (Kotlin / Java) | [stacks/android.md](stacks/android.md) |
| C application | [stacks/c.md](stacks/c.md) |
| ESP32 (ESP-IDF) | [stacks/esp32-esp-idf.md](stacks/esp32-esp-idf.md) |
| Python | [stacks/python.md](stacks/python.md) |

Projects that span stacks (e.g. a React front end with a Node back end) read one stack file per part; the rules in this document apply to each part independently.

## The layers

Clean Architecture draws the system as concentric rings; plain layered architecture names them as tiers. Both vocabularies appear in the stack files — this is the mapping:

| Ring (Clean Architecture) | Tier name | Contains | Depends on |
|---|---|---|---|
| Entities | **Domain** | Business objects, invariants, core rules. Pure code: no I/O, no framework types, no SDK imports. | Nothing |
| Use cases | **Application** | One unit of user/system intent per use case ("place order", "sync readings"). Orchestrates domain objects; defines **ports** — interfaces for everything it needs from the outside (storage, clocks, networks, notifiers). | Domain |
| Interface adapters | **Adapters** | Translators between the inside and the outside: controllers, presenters, view models, repository implementations, DTO/entity mappers. Implement the application's ports. | Application, Domain |
| Frameworks & drivers | **Infrastructure** | The UI framework, database driver, HTTP client, hardware, OS, third-party SDKs. Kept thin — glue, not logic. | Adapters (and everything, at the edge) |

Two structural elements sit outside the rings:

- **Composition root** — the single place (main/entry point) where concrete infrastructure is constructed and injected into adapters and use cases. Wiring happens here and nowhere else. If construction of a real database client appears deep inside business code, the composition root has leaked.
- **Shared kernel** (optional, keep tiny) — truly universal primitives (result types, IDs, error taxonomy) that any layer may import. Everything else must live in exactly one layer.

## Core rules for separation

These rules are what make the layering real. A directory tree without them is decoration.

### 1. The Dependency Rule
Source-code dependencies point only inward: Infrastructure → Adapters → Application → Domain. An inner layer never names anything — class, function, type, constant — declared in an outer layer. This is the single most important rule; every other rule exists to serve it.

### 2. Domain purity
Domain code imports nothing but the language's standard library (and the shared kernel). No framework annotations, no ORM base classes, no HTTP types, no JSON tags, no logging frameworks, no vendor SDKs. If the domain layer can't compile/run without a framework installed, it isn't a domain layer.

### 3. Boundaries are interfaces (dependency inversion)
When an inner layer needs an outer capability — persistence, time, network, hardware — it defines an interface (**port**) in its own layer, expressed in its own vocabulary. The outer layer implements it (**adapter**). Concrete implementations are injected at the composition root. Corollary: the application layer never constructs its own dependencies.

### 4. DTOs at the seams
Wire formats, database rows, and framework request/response types never cross a boundary inward. Adapters map them to domain/application types at the seam, in both directions. A JSON annotation on a domain entity means the wire format has become load-bearing on the business model — a schema change now breaks business rules.

### 5. No cycles, one-way flow
The module/package graph is a DAG. Cycles between modules mean the boundary between them is fictional. Every stack file names the tool that enforces this mechanically (lint rule, module system, import contract) — install it at scaffold time, not after the first violation.

### 6. Screaming architecture
The top level of the source tree should say what the system *does*, not what framework it uses. As a codebase grows, organize by feature/domain area first and by layer within each feature (`orders/{domain,application,adapters,ui}`), not by layer globally (`controllers/`, `models/`, `utils/`). A new reader should find "everything about orders" in one place. `utils/` and `common/` are where cohesion goes to die — prefer naming the actual concept.

### 7. Scale the ceremony to the project
A script, prototype, or 500-line tool does not need four directories and dependency injection. It needs the *seams*: pure logic in functions that take data and return data, and I/O pushed to the edge of the file. That is the whole architecture at small scale, and it upgrades to full layering without a rewrite. Add a layer only when the code it would contain already exists; never scaffold empty directories "for later."

## Why this stays testable, changeable, maintainable

**Testable.** Domain and application code depend only on ports, so tests use plain in-memory fakes — no framework mocking libraries, no emulators, no network. These tests are fast and stable, so they get written and get run. Adapters get a narrow band of integration tests against the real thing (real DB, real filesystem, contract tests against the API). The test pyramid falls out of the layers instead of being a policy anyone has to enforce.

**Changeable.** Change isolates to the layer that owns it. Litmus tests worth stating in any architecture doc:
- Swapping the database (or HTTP client, or storage SDK) touches one adapter and the composition root — zero domain or application files.
- A full UI redesign touches presentation code only — zero domain files.
- A new business rule touches domain/application and its tests — the diff contains no framework code.

If a proposed change violates its litmus test, the boundary it crosses is broken; fix the boundary before or alongside the change.

**Maintainable.** Boundaries carry the architecture's intent to people who never read the design doc — including agents. Enforcement tooling turns the rules from convention into build failures, so the structure survives contributor turnover and time pressure. The composition root gives one place to read to understand what the system is actually made of.

## Refactoring poorly structured codebases

Never big-bang. The sequence is assess → protect → carve → enforce, shipping continuously throughout.

**1. Assess.** Map the actual dependency graph with the stack's tooling (each stack file names it). Identify:
- **God modules** — files/classes imported by everything and importing everything.
- **Framework leakage** — framework, ORM, or wire types inside business logic (grep for the framework's import path outside the UI/infra directories).
- **Cycles** — clusters of modules that import each other.
- **Hidden composition** — `new Database()`/singletons/globals constructed deep in call stacks instead of at the entry point.

Write the findings down (this becomes the refactor plan's evidence). Rank by pain: refactor the seams where change is currently hardest, not the ugliest code.

**2. Protect with characterization tests.** Before moving anything, pin current behavior — including current bugs — with coarse tests at the outermost stable boundary (HTTP endpoint, CLI invocation, screen render). These tests define "refactor didn't break it."

**3. Carve, strangler-fig style.** Small steps, each shippable:
1. **Extract pure domain first** — pull business rules out of controllers/handlers/components into pure functions and entities. This is the highest-value, lowest-risk move and immediately makes the logic unit-testable.
2. **Introduce ports at the worst seam** — define the interface the application code wishes it had, wrap the existing messy implementation as its first adapter. Don't rewrite the implementation yet.
3. **Move composition to the root** — hoist construction of concrete dependencies out of business code and into the entry point, one dependency at a time.
4. **Migrate directories last** — only after dependencies actually flow inward does moving files into the target structure mean anything.

**4. Enforce.** Add the stack's boundary-enforcement tool with rules matching what was just carved, so the old shape cannot grow back. Ratchet: forbid new violations immediately, burn down existing ones over time.

## Reference points

The doctrine here synthesizes: Robert C. Martin's *Clean Architecture* (Dependency Rule, rings, screaming architecture), Alistair Cockburn's Hexagonal Architecture / Ports & Adapters, Eric Evans' *Domain-Driven Design* (domain isolation, ubiquitous language), Michael Feathers' *Working Effectively with Legacy Code* (characterization tests, seams), and the strangler-fig migration pattern (Fowler). Stack files additionally follow each ecosystem's official guidance where it exists (e.g. Google's Android architecture guidance, ESP-IDF component conventions).
