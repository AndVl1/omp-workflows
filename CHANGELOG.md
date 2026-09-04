## [0.28.4] — 2026-09-04
### Fixed
- **CTO state identity guidance** — `/cto` now explicitly distinguishes canonical CTO `CtoState.id` in `.work-state/cto/<id>/state.json` from `/do-work` `TeamState.run_key`, and requires CTO slice markers to use the canonical CTO run identity. Added a regression guard for the state-family boundary.
