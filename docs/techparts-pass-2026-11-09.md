# techparts-pass full pipeline, 2026-11-09 (completion record)

Standing order executed in one run: audit -> remediation -> refactoring -> cleaning -> test hardening (feature batch not invoked: no items were supplied). Every pass read its own prompt file at dispatch time and ran its baseline ritual. Approval: the operator's standing blanket approval plus the explicit instruction to proceed without further approval gates.

## Gates (measured, not assumed)

- Start of run: `npm run build:css` exit 0; `npm test` 536/536, 26 s.
- End of run: `npm run build:css` exit 0 (93 ms); `npm test` 541/541, 0 fail (536 baseline + 4 remediation/hardening tests + 1 packaging test).

## 1. Audit

Report: docs/audit-2026-11-09.md (landed complete before the first fix; never edited after). Headline closures vs the v8 brief: the claim stub now has an ESC/POS encoder and queue route; the believed-present suite race is actually fixed (PORT 0); SSE is store-scoped; the release pipeline is idempotent by reading; the two v8-named updater defects are gone; tests/remediation-final.test.js does not touch real shop.db. Findings: 2 MEDIUM source, 1 MEDIUM docs/integrity, 1 MEDIUM ops, 5 LOW. Method: four parallel sweeps (XSS, enqueue, test quality, i18n) plus direct reads of updater.js, sync.js, server.js routes, cloud-deploy/server.js, publish-release.ps1.

## 2. Remediation (one finding at a time, gate after each)

- F4 (cloud PIN print): the rotate-pin echo removed from BOTH cloud-deploy/server.js and cloud/server.js; the credential travels via its 0600 file only. Regression test in tests/packaging-workflows.test.js; explicit update of the behavioral test in tests/cloud-hardening.test.js that used to pin the print.
- F2 (updater :restore silent failure): errorlevel guards plus handoff log lines for a blocked clear and a failed rename-back in buildApplyScript; assertions added to tests/updater.test.js.
- L7 (staged update destroyed on checksum-fetch outage): the staged exe and marker now survive a digest FETCH failure (fail closed, keep retry material); a verified mismatch still cleans. Behavioral test: "updater: a digest-fetch outage keeps the staged retry material".
- F5 (five numeric-only raw interpolations): wrapped in txt() in the audit sentence builders; assertions added to the audit feed test.
- L8 (startup repairs bypassed the outbox): ensureSyncTables now runs before the repair writes; renamed SKU rows and opening-balance movements enqueue. Behavioral test in tests/db.test.js (legacy trailing-space collision shape, real outbox rows asserted).
- F3 (pairing timeout strands the shop): the 15 s abort now answers 504 and names the possibly-completed pairing plus the recovery path; source-contract test in tests/server.test.js (a behavioral test would need a >15 s hang); OPERATIONS_AND_DEPLOYMENT.md 5.3 documents the state.
- Docs: API_REFERENCE.md completeness disclaimer; docs/code-audit-prompt.md port bound corrected +21 -> +20 (ARCHITECTURE.md already said +20).
- Deliberate NON-FIX: F1, the dirty CHANGELOG.md/RELEASE_NOTES.md rewrite. Both pass prompts' tree-state blocks classify the dirty files as in-flight operator work to leave as-is; restoring them risks exactly the concurrent-interference hazard this tree has a history of. The three claims in the rewrite describe behaviors that exist in committed code; only the release framing is off.

## 3. Refactoring

Empty honest proposal, zero structural steps. Every candidate is protected structure (route chain, money paths, outbox, updater pure/apply split), mechanical (route registrations, sample data), or already factored (fixedWindowBudget shared by all four budget limiters). Flagged but left: applyUpdateInner (~202 lines, linear and test-covered), createServer (~1388, protected), createWarrantyReturn/createSale/drainOutbox (transactional, protected). The honesty clause governs: manufactured work is the failure mode.

## 4. Cleaning

- Deleted: dead reservePort and its orphaned node:net import in tests/remediation-final.test.js (zero call sites, proven).
- Deleted: pos-server.log at the repo root (591KB, regenerable runtime debris), cloud-deploy.zip at the repo root (37KB, stale 2026-11-05 artifact, unreferenced).
- Declined: publish.bat/publish-release.bat (documented entry points, one test-pinned), publish/ and dist/ runtime state (report only), all TRAPS-list items (browser print fallback, license transition key, legacy PIN leg, scan gates, i18n fallbacks, .part sidecars, cloud twin trees), unused-export deletions (no reliable proof).

## 5. Test hardening (additive only, source read-only)

- Added: tests/analytics-parity.test.js "cloud standing equals the workstation for the same dataset" - the audit's standing parity gap (outstanding utang, case-folded debtor count, debtor list balance, inventory retail and cost values) compared to the centavo through the real /sync pipeline, including a partial settlement and a voided sale.
- Judged adequately covered, no test added: i18n en/tl key parity (existing test), updater pure parts (22 tests), money paths (sales/credits/returns/reconcile behavioral suites), auth/roles, sync outbox/backfill/heartbeat, printer layout and transport, RMA caps, port drift, release packaging.
- Gaps that need source changes (recorded, not worked around): the cloud manager app's client-side dashboard computation has no vm seam (creating one is a source edit); a behavioral SSE store-scoping test needs streaming-client infrastructure; the real update install and the physical scanner remain counter-only manual exercises (audit report Measurement List).

## Deliberate non-goals this run

- No commits (the operator did not ask; never --amend here).
- The dirty operator files were preserved byte-for-byte except the two test files and sources this run deliberately edited.
- i18n coverage of the roughly 30 hardcoded English strings and the multi-store SSE null-target churn: recorded as LOW findings, not fixed (cosmetic; behavior breadth beyond the findings' scope).
