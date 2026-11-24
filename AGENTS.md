# Agent guidance

## Tests

- `just test` runs the plugin tests (vitest, including real-server tests) and the Go tests with `-race`. Run these freely.
- **Ask before running the end-to-end suite** (`just e2e`, anything under `e2e/`, or any script that launches Obsidian via wdio-obsidian-service). It opens several real Obsidian windows that keep coming to the front and take keyboard focus, which interrupts whatever the user is doing. Get approval for each run, say which specs you want to run and why, and keep the run as narrow as possible (`just e2e <filter>`).
- `just sim` (the headless simulator) doesn't open windows and is fine to run.
