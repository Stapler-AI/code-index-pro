# ESP32 (ESP-IDF) — Layered Scaffold

Applies to ESP32-family firmware on ESP-IDF (v5+). ESP-IDF's **component** system is a real module system with declared dependencies — use it as the layer boundary. The central goal: keep application logic pure C that runs on a host machine, with hardware and RTOS reached only through ports. Read with [../layered-architecture.md](../layered-architecture.md) and, for general C technique (opaque types, function-pointer ports, header discipline), [c.md](c.md).

## 1. Recommended directory structure

```
my_firmware/
├── main/                        # composition root ONLY
│   ├── main.c                   # app_main(): init drivers, wire ports, start tasks
│   ├── idf_component.yml        # managed-component deps
│   └── CMakeLists.txt
├── components/
│   ├── app_logic/               # domain + use cases — pure C, no esp_*/freertos includes
│   │   ├── include/app_logic/
│   │   │   ├── controller.h
│   │   │   └── ports.h          # sensor_port, storage_port, clock_port, publisher_port
│   │   ├── controller.c
│   │   └── CMakeLists.txt       # REQUIRES: (nothing, or only other pure components)
│   ├── drivers/                 # one component per peripheral wrapper
│   │   ├── sensor_bme280/       # implements sensor_port over I2C
│   │   └── display_ssd1306/
│   ├── net_mqtt/                # implements publisher_port over esp-mqtt
│   ├── storage_nvs/             # implements storage_port over NVS
│   └── platform/                # thin RTOS/OS wrappers if app code needs timing/queues
├── test/                        # host-based unit tests (linux target) for app_logic
├── sdkconfig.defaults
└── CMakeLists.txt
```

Rule of thumb: `main/` stays under ~200 lines — it constructs, wires, and starts. Everything with behavior lives in a component.

## 2. Layer mapping

- **Domain + Application (`app_logic`)** — the device's decision-making: state machines, thresholds, scheduling policy, protocol logic. Pure C11, standard library only. Defines **ports** as structs of function pointers (`struct sensor_port { int (*read)(void *ctx, struct reading *out); void *ctx; }`) for every capability: sensors, actuators, persistence, network publishing, time, randomness.
- **Adapters (driver/net/storage components)** — implement the ports over ESP-IDF APIs (`driver/i2c_master.h`, `esp_mqtt`, `nvs_flash`). Each wraps exactly one peripheral or service; translation between raw registers/wire formats and domain structs happens here.
- **Infrastructure** — ESP-IDF itself, FreeRTOS, partition tables, `sdkconfig`. Task creation and queue plumbing live in `main/` (or `platform/`), not inside `app_logic` — app logic exposes plain functions (`controller_tick()`, `controller_on_reading()`) that tasks call.
- **Composition root (`main/`)** — `app_main()` initializes NVS/netif/drivers, fills the port structs with adapter implementations, creates tasks, and starts the loop. The only place that knows every concrete component.

## 3. Boundary enforcement

- **Component `REQUIRES`/`PRIV_REQUIRES` in CMakeLists.txt is the mechanism**: `app_logic` declares no ESP-IDF requirements, so `#include "esp_log.h"` inside it fails to build. Driver components require only their peripheral APIs. Review any new `REQUIRES` line like a public-API change.
- Public headers in each component's `include/` are the port surface; internal headers stay private beside the sources.
- No logging inside `app_logic` via `esp_log` — either return status the caller logs, or define a `log_port` (keeps host builds trivial).
- `sdkconfig.defaults` checked in; generated `sdkconfig` gitignored.

## 4. Testing conventions

- **`app_logic` on the host** — this is the payoff of purity: build the component for the **linux target** (`idf.py --preview set-target linux`) or with a plain host CMake harness, and unit-test with **Unity** using fake ports (a fake sensor feeding scripted readings, an in-memory storage port). Runs in milliseconds in CI with no hardware.
- **Driver adapters on target** — pytest-embedded / Unity-on-target tests exercising the real peripheral on a devkit; keep these few and focused (does the wrapper talk to the chip correctly).
- **System smoke** — a hardware-in-the-loop or manual checklist for the composed firmware: boot, connect, publish, sleep/wake.
- Simulators (Wokwi/QEMU) fill the gap for integration flows when hardware access is scarce.

## 5. Smells & refactor moves

- **Business logic inside FreeRTOS tasks in `main.c`** (the 1000-line `app_main`) → extract decision logic into `app_logic` functions taking inputs and returning commands; the task shrinks to read-ports → call logic → apply outputs.
- **`esp_*` calls scattered through application code** → for each capability, define a port in `app_logic` and move the ESP-IDF calls into an adapter component; do one capability at a time, most-used first.
- **State machines driven by `vTaskDelay` sprinkled in logic** → make the state machine a pure `tick(state, event, now)` function; the task owns timing and feeds it. This single move usually makes the whole device testable.
- **Config via `#define` magic numbers spread across files** → centralize in Kconfig (`Kconfig.projbuild`) or a config struct injected at wiring time.
- **ISRs doing work** (parsing, deciding, publishing in interrupt context) → ISR pushes a raw event to a queue; a task feeds it to the pure logic. Keeps ISRs minimal and the logic testable.
