# Implementation ledger — plan: docs/requirements/product.md sections 12–16

Started 2026-11-24 on codex/targeted-resume. Existing documentation changes belong to the approved plan; retain them. Baseline: 23 tests passed. Sandbox Vitest EPERM requires normal-permission npm test; git branch creation succeeded with normal permissions.

- T1: complete — contracts, migration, stable resume documents and backup compatibility; scoped independent re-review passed after fixes. Initial full regression 28 passed; follow-up migration/backup targeted regression 5 passed and typecheck passed.
- T1 review round 1: 28 tests passed; reviewer found meaningful-data backup confirmation gap and legacy JSON/migration initialization failure safety. Sent both to t1_data for regression fixes before dependent implementation.
- T2: complete — material extraction, explicit fact confirmation and reusable intake UI; root full regression 39 passed, final component fix targeted 10 passed/typecheck passed. Independent scoped review passed after project-switching fix. UI integration/visual QA pending T5.
- T3–T4: complete — full JD assessment, bounded model tasks, targeted draft and atomic suggestion acceptance; scoped independent re-review passed after 4 issue categories fixed; full 68 tests and typecheck passed.
- T3–T4 review round 1: core/routed full regression 59 passed and typecheck passed; independent reviewer found active-analysis stale handling, post-accept draft cache identity, clause-specific guard boundaries and frozen backup payload references. Scoped fixes dispatched with concrete regressions.
- T5: complete — Jobs/Resume/Project UI integration, save concurrency, review, history and overflow. Final six-issue fix wave independently approved; root production-browser checks passed.
- T5 initial integration: 70 tests/typecheck passed. Root browser confirmed save JD, material extraction/confirmation, full analysis, proposal acceptance, target profile/summary, edit/export interlock and submitted snapshot retention. HTTP export verified correct Markdown/download headers and v2 backup roundtrip retaining history.
- Final review: one consolidated fix wave dispatched for explicit blank edits, per-sentence provenance, dirty in-app navigation, discovery of new live projects, over-limit paste preservation, and consistent pre-upgrade backups. Sidebar confirmed-material progress fix separately passed before this review.
- Continuation: prior T5 run was interrupted by usage quota after JobsWorkspace, MaterialIntake, TailoringReview and save queue landed. Resumed the same implementer to finish ResumeWorkspace, paper projection, project entry and cancellation; no completed backend stages redispatched.
- T6: complete for offline implementation verification — root independently ran 77 tests, typecheck, production build and diff check. Real provider quality and printer/PDF configuration testing remain separate external validation.
- T7: requires real target users; prepare exploration protocol, do not claim research performed.

No real provider calls, credentials provisioning, deployment, push or PR in this implementation run.

## Final evidence — 2026-11-25

- Branch: `codex/targeted-resume`; all changes kept local, no commits/push/merge. Existing approved requirement edits retained.
- Root `npm test`: 19 files / 77 passed; `npm run typecheck`: exit 0; `npm run build`: exit 0 (Next.js 15.5.29). All data API routes dynamic. Existing Vite CJS deprecation warning remains.
- Development browser, synthetic data: saved JD; created active experience; extracted and explicitly confirmed done subfact; analyzed full JD; created proposal; accepted sentence; edited target profile/summary; saved working revision 3 and submitted snapshot 4; manual edit advanced working revision 5 while print snapshot 4 retained original numbers.
- Production browser: confirmed-material progress 100%; explicitly clearing text saved revision 6 blank. Dirty profile followed by sidebar Jobs link produced confirmation; dismiss retained local name. Native paste retained 12001 JD characters, no maxlength attribute, visible limit and disabled save. Later-created project appeared separately and entered snapshot only after checking, revision 7.
- Production layout: long Chinese manual content yielded a 1734px paper height; one-page target warned, two-page target removed warning. This verifies layout hints, not a physical PDF artifact or every printer setting.
- Production HTTP: Markdown has correct UTF-8 type and attachment header, summary/status consistent, submitted snapshot excludes later manual edits/new project. v2 import/export retained historical Markdown; a separate newly empty test DB accepted v2 without overwrite confirmation and restored revision 9 plus confirmed fact and original snapshot 4.
- Test services used `data/qa-*`, `AI_PROVIDER=fake`, loopback only; all started server sessions stopped. Personal DB was not accessed or migrated; no credential provisioning, plaintext inspection or exposure occurred. Next.js loaded its normal local environment configuration, but no real provider request was made. Browser download-event tooling timed out; export content was verified through actual HTTP instead of claiming a completed browser download.
- Final review: all six specified findings closed. Known parked boundary: same-document browser Back/Forward is outside link/page-unload dirty confirmation; README and product requirements explicitly state save-first limitation. No absolute semantic-truth or pagination guarantees.
- T7 has protocol only (`validation-protocol.md`), no invented participant results. Real model quality and target-user usability need follow-up.

## Release verification — 2026-11-25

- User explicitly requested merging and deploying the current feature, prioritizing working AI and the complete workflow.
- Fresh verification: 77 tests / 19 files passed; TypeScript validation passed; isolated production build passed. Isolation avoided the developer's running Next.js service and its locked `.next/trace`.
- Real configured DeepSeek provider, synthetic data only: material extraction returned two facts; explicit confirmation; full JD analysis returned three requirements; draft returned two supported bullets; acceptance, Markdown export and submitted snapshot all passed. No private resume or project material was sent in this smoke test.
- Test service used loopback port 3102 and `data/qa-release-live`; real personal database was not used. Credential values were never printed or committed.
- Existing hosting instructions specify a personal Tencent Lighthouse instance, persistent `/var/lib/careerdesk` and Tailscale access. Deployment connection address is not present in the repository or SSH configuration; requested it from the user. No claim of online deployment until remote verification succeeds.
