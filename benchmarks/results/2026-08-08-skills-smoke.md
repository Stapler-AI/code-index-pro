# Benchmark report: skills-smoke

Date: 2026-08-08 · Runs: 24

## Headline — three-way token ratios (per agent)

Ratios are medians of per-task paired ratios within one agent. `—` = arm absent.

| Agent | token ratio with/without | with-skill/with | with-skill/without | correctness Δ (skill vs without) | adoption (skill) | index build s |
|---|---|---|---|---|---|---|
| claude | 0.97 | 1.01 | 0.98 | +0.00 | 0.00 | 0.77 |
| codex | 1.47 | 1.89 | 1.81 | -0.47 ⚠ correctness regression | 0.93 | 0.93 |

## Structure-heavy subset (gate G1: callers-impact + cross-file-navigation + rename-refactor)

| Agent | token ratio with/without | with-skill/with | with-skill/without | correctness Δ (skill vs without) | adoption (skill) | index build s |
|---|---|---|---|---|---|---|
| claude | 0.97 | 1.01 | 0.98 | +0.00 | 0.00 | 0.77 |
| codex | 1.47 | 1.89 | 1.81 | -0.47 ⚠ correctness regression | 0.93 | 0.93 |

## Win / loss / tie per task pair (token cost, per agent)

### with vs without

| Agent | win (index cheaper) | loss | tie |
|---|---|---|---|
| claude | 4 | 0 | 0 |
| codex | 1 | 3 | 0 |

### with-skill vs without

| Agent | win (skill cheaper) | loss | tie |
|---|---|---|---|
| claude | 2 | 2 | 0 |
| codex | 0 | 4 | 0 |

## Per-category × per-arm medians

| Category | Arm | runs | tokens | fresh-in | cache-read | out | cost $ | wall s | tool calls | correctness | index build s |
|---|---|---|---|---|---|---|---|---|---|---|---|
| callers-impact | claude-with | 1 | 54069 | 5567 | 35711 | 1013 | 0.1894 | 12.45 | 1 | 0.07 | 0.77 |
| callers-impact | claude-with-skill | 1 | 54949 | 5722 | 35721 | 1558 | 0.2055 | 17.18 | 1 | 0.07 | 0.76 |
| callers-impact | claude-without | 1 | 54551 | 5838 | 35708 | 987 | 0.1925 | 11.22 | 1 | 0.07 | — |
| callers-impact | codex-with | 1 | 126718 | 65897 | 59904 | 917 | 0.0874 | 27.54 | 3 | 0.07 | 0.76 |
| callers-impact | codex-with-skill | 1 | 275421 | 150418 | 123904 | 1099 | 0.2275 | 38.24 | 7 | 0.07 | 0.94 |
| callers-impact | codex-without | 1 | 58569 | 30478 | 27392 | 699 | 0.0501 | 18.24 | 1 | 0.07 | — |
| cross-file-navigation | claude-with | 2 | 62769 | 5568 | 47245 | 240 | 0.1552 | 7.18 | 1.5 | 0.50 | 0.63 |
| cross-file-navigation | claude-with-skill | 2 | 63148 | 5723 | 47327 | 234 | 0.1574 | 6.30 | 1.5 | 0.50 | 0.59 |
| cross-file-navigation | claude-without | 2 | 64628.5 | 7110 | 47365 | 233 | 0.1649 | 6.31 | 1.5 | 0.50 | — |
| cross-file-navigation | codex-with | 2 | 68260.5 | 37473 | 30656 | 131.5 | 0.0534 | 10.80 | 1.5 | 1.00 | 0.60 |
| cross-file-navigation | codex-with-skill | 2 | 128912.5 | 70706.5 | 58048 | 158 | 0.0971 | 11.45 | 3 | 1.00 | 0.68 |
| cross-file-navigation | codex-without | 2 | 72351 | 37445 | 34752 | 154 | 0.0355 | 9.95 | 1.5 | 1.00 | — |
| rename-refactor | claude-with | 1 | 131951 | 5573 | 114006 | 1330 | 0.2292 | 20.56 | 7 | 0.00 | 0.86 |
| rename-refactor | claude-with-skill | 1 | 214041 | 5952 | 195276 | 1428 | 0.2776 | 28.15 | 7 | 0.00 | 1.08 |
| rename-refactor | claude-without | 1 | 229682 | 8497 | 205780 | 1452 | 0.3218 | 27.08 | 7 | 0.00 | — |
| rename-refactor | codex-with | 1 | 602698 | 310213 | 289408 | 3077 | 0.3410 | 153.07 | 19 | 1.00 | 0.89 |
| rename-refactor | codex-with-skill | 1 | 424194 | 217532 | 205312 | 1350 | 0.2043 | 47.22 | 17 | 0.00 | 0.91 |
| rename-refactor | codex-without | 1 | 310136 | 173124 | 134528 | 2484 | 0.3348 | 90.99 | 17 | 1.00 | — |

_Index build time is reported alongside and is never subtracted from the token or wall figures._
