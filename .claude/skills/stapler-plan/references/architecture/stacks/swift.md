# Swift (iOS / macOS) — Layered Scaffold

Applies to SwiftUI-first apps for iOS and macOS (UIKit/AppKit fit the same shape with view controllers in Presentation). Read with [../layered-architecture.md](../layered-architecture.md).

## 1. Recommended directory structure

**Small project (single app target, groups as layers):**

```
MyApp/
├── App/                  # composition root: @main App struct, DI wiring
├── Domain/               # entities, value types, business rules — pure Swift
├── Application/          # use cases + port protocols
├── Data/                 # adapters: repositories, API client, persistence, mappers
├── Presentation/
│   ├── Screens/          # feature screens: View + ViewModel pairs
│   └── Components/       # reusable views, styles, design tokens
└── Resources/
MyAppTests/
MyAppUITests/
```

**Grown project (local Swift packages — the boundary becomes compiler-enforced):**

```
MyApp/                    # thin app target: @main + composition root only
Packages/
├── Domain/               # pure Swift package, no dependencies
├── Application/          # depends on Domain; declares port protocols
├── Data/                 # depends on Application + Domain; URLSession/SwiftData/etc.
├── DesignSystem/         # shared UI components + tokens
└── Features/
    ├── Checkout/         # Presentation for one feature; depends on Application + DesignSystem
    └── Profile/
```

Each package's `Package.swift` declares its dependencies — the build graph *is* the architecture diagram. Start with groups; move to packages when more than one person or agent works on the app, or when build times grow.

## 2. Layer mapping

- **Domain** — structs/enums with invariants and pure logic. Imports Foundation at most. No SwiftUI, no SwiftData/CoreData, no Codable conformance tied to a wire format.
- **Application** — use-case types (`PlaceOrderUseCase`) holding port **protocols** (`OrderRepository`, `Clock`). Async APIs via `async/await`.
- **Adapters (Data)** — repository implementations over URLSession/SwiftData/CoreData/Keychain; separate `Codable` DTO types mapped to domain types at this boundary. SwiftData `@Model`/CoreData `NSManagedObject` classes stay here, never crossing inward.
- **Presentation** — SwiftUI `View`s plus `@Observable` view models. View models call use cases and expose display state; views stay logic-free. Navigation (NavigationStack path/router) is presentation-layer.
- **Infrastructure** — URLSession configuration, persistent container setup, push registration, third-party SDKs.
- **Composition root** — the `@main` App struct (or a small `AppComposition` type): builds concrete adapters, injects into use cases and view models via initializer injection (preferred) or `Environment`. Avoid singletons (`Foo.shared`) as the wiring mechanism.

## 3. Boundary enforcement

- **Local SPM packages** are the primary enforcement: a package physically cannot import what it doesn't declare. `Domain` declares zero dependencies; done.
- **Access control** as the secondary mechanism: `public` only what the layer's contract requires; keep adapter internals `internal`. In the single-target variant, discipline + review carry this until packages arrive.
- SwiftLint with `custom_rules` (regex) can flag `import SwiftUI` under `Domain/`/`Application/` in single-target projects.
- Protocol-first seams: any type the Application layer needs from outside is a protocol it owns.

## 4. Testing conventions

- **Domain/Application** — Swift Testing (or XCTest) unit tests with hand-written fakes conforming to port protocols; no mocking frameworks needed. Fast, run on every build.
- **Data adapters** — integration tests: `URLProtocol` stubs for the API client (test the real request/decode path), in-memory `ModelContainer`/persistent store for persistence.
- **View models** — unit tests with fake use cases; assert exposed state transitions.
- **UI** — a few XCUITest smoke flows; snapshot tests (pointfree swift-snapshot-testing) for design-system components if visual regression matters.

## 5. Smells & refactor moves

- **Massive view / massive view controller** (networking + rules + formatting inline) → extract a view model, then extract the rules into Domain and calls into a use case.
- **`Foo.shared` singletons reached from everywhere** → convert to a protocol + injected instance; construct once at the composition root.
- **SwiftData/CoreData models used as domain models** (persistence classes with business methods, passed to views) → introduce plain domain structs; map in the repository.
- **API `Codable` structs spread through views** → keep DTOs in Data; map to domain types at the repository/client boundary.
- **Business logic keyed off `@EnvironmentObject` deep in the view tree** → move decisions into view models/use cases; environment carries dependencies, not logic.
