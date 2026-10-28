# Audit remediation record

The numbered findings refer to the preceding risk-directed audit.

1. Sample, New, Paste, and Open replacement paths now request confirmation before discarding an active dataset or results; confirmed replacements reset history and associated session state. `replacement.test.js` covers cancelled file replacement and the shared dataset/project session-reset operations.
2. Single-column CSV import preserves blank records without adding a case for the final line terminator. `io.test.js` covers leading, interior, trailing, and quoted empty cases.
3. AI result explanations require approval of the displayed payload. Frequency category values are replaced with generic labels, while counts remain available. Other tables can still identify individuals; the preview is not an anonymization guarantee. `ai-privacy.test.js` exercises cancellation, exact preview delivery, duplicate approval, and session-generation invalidation at the controller level. In-flight replies are ignored after a dataset or chat reset; requests already sent are not cancelled.
4. AI-proposed formulas are validated as a group, evaluated with the existing expression evaluator, and applied in one undoable dataset/formula event. Collisions are rejected rather than silently renamed. `ai-compute.test.js` covers missing values, chained formulas, invalid input, undo and redo.
5. XLSX import respects explicit string/date metadata and cell types, preserves text tokens and empty strings, validates metadata, and preserves trailing missing rows in ARAStat-generated workbooks via a row-count marker. `io.test.js` covers numeric-looking IDs, missing tokens, dates, mixed cells, trailing missing cases, and malformed metadata. An external workbook that contains no stored record of a trailing blank row cannot convey that row count.
6. The golden-test client drains stderr, detects failed startup, bounds startup, requests and shutdown, terminates on timeout, and filters notifications by run ID. A repo-local CPython 3.12.15 was installed inside ignored `engine/.venv` and the existing venv was repaired without changing a global Python installation.
7. README and empty-state format descriptions now match UI save/import support and the SAV compression limitations.
8. Quality callout colors use existing light/dark tokens. This is not a substitute for live visual or accessibility testing.
9. Architecture and agent documentation describe the current bridge, archive, OS credential store, engine invocation, and LAN HTTP policy.

## Verification

- `npm test`: 137 passed, including 25 golden analyses.
- `cargo test --manifest-path src-tauri/Cargo.toml -- --skip settings::tests`: 38 unit tests and 3 live-engine seam tests passed; 9 settings tests filtered out to avoid modifying the OS credential store outside this repository.
- `npm run typecheck` and `npm run build:vite`: passed.
- `git diff --check`: passed. An active LSP probe found no errors; most push-only checks could not independently confirm clean.
- No running Tauri window, screen reader, desktop visual comparison, signed/packaged installer, or keychain mutation test was performed. The local Python repair is a development environment setup, not proof that a relocated installer bundles a working Python runtime.
