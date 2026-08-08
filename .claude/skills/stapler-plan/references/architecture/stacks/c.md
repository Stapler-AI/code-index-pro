# C Applications — Layered Scaffold

Applies to C applications, daemons, and libraries on desktop/server (for microcontroller C, prefer [esp32-esp-idf.md](esp32-esp-idf.md) or its equivalent for the target RTOS). C has no module system, so headers, opaque types, and link-time seams do the work that interfaces do elsewhere. Read with [../layered-architecture.md](../layered-architecture.md).

## 1. Recommended directory structure

**Small project:**

```
include/myapp/           # public headers only — the API surface (ports)
│   ├── order.h
│   └── storage.h        # storage port: struct of function pointers or opaque handle
src/
├── domain/              # pure logic: order.c — no I/O, no OS calls
├── app/                 # use-case orchestration: workflows over domain + ports
├── adapters/            # storage_sqlite.c, transport_http.c — implement ports
├── platform/            # OS-specific code: threads, files, sockets, time
└── main.c               # composition root: build adapters, inject, run
tests/
├── unit/                # domain + app tests with fake adapters
└── integration/
CMakeLists.txt (or Makefile / meson.build)
```

**Grown project (internal libraries — the build system enforces layering):**

```
libs/
├── domain/              # static lib: include/ + src/, zero deps
├── app/                 # static lib: depends on domain only
├── adapter_sqlite/      # depends on app's port headers + sqlite3
├── adapter_http/
└── platform_posix/
apps/
└── myapp/main.c         # links the chosen adapters — composition root
tests/
```

Each lib declares its dependencies in the build system (`target_link_libraries`); the link graph is the architecture diagram.

## 2. Layer mapping

- **Domain** — pure functions over structs; deterministic; standard library only (and no `stdio` beyond what's essential — take buffers, return results). All state passed in.
- **Application** — workflow functions coordinating domain calls through **ports**: either a struct of function pointers (`struct storage_ops { int (*save)(void *ctx, const struct order *); ... }` plus a `void *ctx`) or link-time substitution (declare `storage_save()` in a header; link a different `.c` per build). Function-pointer ports allow runtime swapping and per-test fakes; link-time seams are simpler when one implementation per binary suffices.
- **Adapters** — implement port headers over sqlite/curl/files; translate wire/storage formats to domain structs at this boundary.
- **Platform** — isolates OS differences (POSIX/Win32) behind its own headers so domain/app code never includes `<unistd.h>`/`<windows.h>`.
- **Composition root** — `main.c`: construct adapter contexts, fill port structs, pass down. No globals as the wiring mechanism; a single `struct app` holding the ports is the C analogue of dependency injection.
- **Encapsulation** — opaque pointers: headers declare `typedef struct order order;` + accessor functions; the struct body lives in the `.c`. Consumers physically cannot reach internals.

## 3. Boundary enforcement

- **Header discipline is the boundary**: `include/` contains only what consumers may use; internal headers stay beside their `.c` files and are never installed. What isn't in a public header doesn't exist.
- **Build-system dependency declarations**: in CMake, `target_link_libraries(app PRIVATE domain)` and *omitting* sqlite from `domain`'s and `app`'s link lists means an `#include <sqlite3.h>` there fails to build.
- `-Wall -Wextra -Werror` always; `include-what-you-use` or `clang-tidy` (`misc-include-cleaner`) to catch includes that bypass the layering; no cross-layer `extern` declarations in `.c` files (an extern not backed by an owned header is a smuggled dependency).

## 4. Testing conventions

- **Domain/app** — unit tests (Unity, CMocka, or Check) linking domain + app against **fake adapters**: a `storage_fake.c` implementing the port over a static array. Function-pointer ports need no tooling; link-time seams substitute the fake `.c` in the test target.
- **Adapters** — integration tests against the real dependency (sqlite in a temp file, local HTTP server).
- **Sanitizers in CI**: ASan/UBSan on the unit suite; valgrind where sanitizers can't run.
- Deterministic domain code (no hidden clock/random calls — inject them as ports) is what makes the unit layer stable.

## 5. Smells & refactor moves

- **Globals as wiring** (`extern struct config g_config` reached from everywhere) → move into a context struct created in `main` and passed down; one parameter replaces an invisible dependency web.
- **God header** (`common.h` included by every file, defining everything) → split by concept; each header owns one type/capability; include only what's used.
- **I/O interleaved with logic** (`printf`/`fopen`/`send` inside computation) → separate compute functions (data in, data out) from I/O shells; this is the extract-pure-domain move in C.
- **Struct internals accessed across the codebase** → make the struct opaque, add accessors; do it one struct at a time starting with the most-touched.
- **`#ifdef` platform forests in logic code** → hoist per-platform code into `platform/` implementations of one header; the build picks the file, the logic stays single-path.
