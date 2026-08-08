# Android (Kotlin / Java) — Layered Scaffold

Applies to Android apps in Kotlin (preferred; Java fits the same shape). Aligns with Google's official architecture guidance (UI / domain / data layers) extended with a compiler-enforced module boundary. Read with [../layered-architecture.md](../layered-architecture.md).

## 1. Recommended directory structure

**Small project (single `:app` module, packages as layers):**

```
app/src/main/java/com/example/myapp/
├── domain/              # entities + business rules — pure Kotlin
├── application/         # use cases + port interfaces (repositories, clock)
├── data/                # adapters: repository impls, Room, Retrofit, DTO mappers
├── ui/
│   ├── checkout/        # per-screen: Screen composable + ViewModel
│   └── components/      # shared composables + theme
├── di/                  # Hilt modules (composition root wiring)
└── MyApp.kt             # @HiltAndroidApp application class
```

**Grown project (Gradle modules — the module graph enforces the boundaries):**

```
:app                     # thin shell: navigation host, Hilt setup, MainActivity
:core:domain             # pure Kotlin/JVM module (no Android plugin) — entities + use cases + ports
:core:data               # repository implementations; depends on :core:domain, :core:network, :core:database
:core:network            # Retrofit/Ktor client + wire DTOs
:core:database           # Room entities + DAOs
:core:designsystem       # theme + shared composables
:feature:checkout        # UI + ViewModels for one feature; depends on :core:domain, :core:designsystem
:feature:profile
```

`:core:domain` uses the plain `kotlin("jvm")` plugin — it cannot reference Android APIs even by accident. Feature modules never depend on each other; navigation between features is wired in `:app`.

## 2. Layer mapping

- **Domain** — data classes with invariants, pure functions, use-case classes (`operator fun invoke`), and port interfaces (`OrderRepository`). No `android.*` imports, no Room/Retrofit annotations.
- **Application** — in Android practice, use cases live with domain (Google's "domain layer"); keep ports there too. Coroutines/Flow are acceptable in this layer (kotlinx, not Android).
- **Adapters (data layer)** — repository implementations combining Retrofit services and Room DAOs; mappers between network DTOs / Room entities and domain models (three model sets is normal and correct at scale).
- **Presentation (UI layer)** — Compose screens + `ViewModel`s exposing `StateFlow<UiState>` and handling intent-named events; screens are stateless renderers of `UiState`. Navigation (Compose Navigation) is UI-layer, hosted in `:app`.
- **Infrastructure** — Retrofit/OkHttp/Room/DataStore construction, WorkManager, push, vendor SDKs — provided by Hilt modules.
- **Composition root** — Hilt: `@Module`/`@Provides`/`@Binds` declarations bind ports to implementations. All binding lives in `di/` (or each module's `di/` package); business code never calls a service locator.

## 3. Boundary enforcement

- **Gradle module graph** is the primary mechanism: a module can only import declared dependencies. `:feature:*` modules omit `:core:network`/`:core:database` from their dependency lists, so UI cannot reach the wire or the DB even deliberately.
- `:core:domain` as a pure JVM module enforces domain purity at compile time.
- In the single-module variant: lint rules (detekt `ForbiddenImport`: no `android.*` in `domain/`, no `retrofit2.*`/`androidx.room.*` outside `data/`) until modules arrive.
- Konsist or ArchUnit tests can assert layer rules (`classes in ..domain.. should not depend on classes in ..data..`) as a CI gate.

## 4. Testing conventions

- **Domain/use cases** — plain JUnit on the JVM with hand-written fakes of ports; no Android, no Robolectric, no mocking framework required (fakes over mocks, per Google guidance).
- **Data adapters** — Room DAOs against in-memory database; Retrofit services against MockWebServer (test real serialization); repository tests with fake DAO/service where useful.
- **ViewModels** — JVM tests with fake use cases + coroutine test dispatchers; assert `UiState` transitions with Turbine.
- **UI** — Compose UI tests for key screens; a few Espresso/Compose end-to-end flows; screenshot tests (Paparazzi/Roborazzi) for the design system.

## 5. Smells & refactor moves

- **God ViewModel** (Retrofit calls, SQL, and rules inline) → extract repository behind a port, then extract use cases; ViewModel keeps state mapping only.
- **Room/network models used as domain models** (`@Entity` data classes passed to composables) → introduce plain domain models; map in the repository.
- **Business logic in composables** (`if` chains deciding business outcomes in UI) → hoist into ViewModel/use case; composable renders `UiState` only.
- **Feature modules depending on each other** → extract the shared contract into a `:core:*` module, or route the interaction through navigation in `:app`.
- **Context passed into domain/data logic** (for resources, prefs, connectivity) → wrap the capability behind an interface implemented in infrastructure; domain never sees `Context`.
