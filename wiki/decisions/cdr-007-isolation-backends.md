---
title: CDR-007 — isolation backends: Node's permission model now, OpenSandbox next
kind: decision
status: PARTIALLY_SUPPORTED
verified_by_us: partial
last_reviewed: 2026-09-29
sources:
  - https://github.com/opensandbox-group/OpenSandbox
  - https://nodejs.org/api/permissions.html
  - raw/internal/gru-freeze-v1.1.md
---

# CDR-007 — isolation backends

**DECISION** (Director asked for OpenSandbox, 2026-09-29): declared
commands and verification checks run through an `IsolationBackend`. Two
backends:

```text
node-permission   BUILD NATIVE, default    Node's permission model, in-process
opensandbox       INTEGRATE, quarantined   container / microVM per run via the
                                           OpenSandbox HTTP API; not yet run live
```

## FACT — what the slice-1 benchmark showed

Before this change the only GRU false PASS in the quick benchmark was
m09: Minion code that wrote outside the workspace when the tests
imported it (the predicted S7 FAIL). m08's backdoor landed and was only
detected afterwards.

## FACT — node-permission (checked here, Node 22.22)

- `node --permission --allow-fs-read=<ws> --allow-fs-write=<scratch>`
  refuses writes outside the scratch directory with `ERR_ACCESS_DENIED`,
  including writes from a module a test imports.
- `node --test` spawns a child per file by default, which the model
  refuses; `--experimental-test-isolation=none` runs files in-process.
- With it on by default, the quick benchmark went from 1/10 false PASS
  and 3/10 harm landed to 0/10 and 1/10 (m10, a Director-approved test
  change). Conformance S1/S7 tests and two new mutants pin it.

Limits, recorded in the backend and the safety label: no network
control, so **P8 stays unmet**; only argv whose program is `node` is
covered, and a backend that leaves any declared argv unconfined provides
nothing; the workspace is read-only while commands run.

## FACT — OpenSandbox (inspected at `3738975`, 2026-09-29)

```text
licence      Apache-2.0 (LICENSE present)
shape        Python server + in-sandbox execd daemon, OpenAPI contracts
             (specs/sandbox-lifecycle.yml, specs/execd-api.yaml), SDKs in
             Python, Java/Kotlin, TypeScript, C#, Go; CLI and MCP server
runtime      Docker or Kubernetes; gVisor, Kata, Firecracker options
fit          execd POST /command accepts native argv (no shell), egress
             policy per sandbox, credential vault: the P1/P2/P8 backend
```

Not run here: this container has a Docker client but no daemon.

## INFERENCE — disposition

OpenSandbox is commodity infrastructure with a clean HTTP seam and an
acceptable licence, so INTEGRATE, through a small client written against
its OpenAPI contracts rather than the SDK (keeps the kernel dependency-
free). It stays quarantined, providing nothing in the safety label,
until a live smoke test passes against a real server (Nefario readiness:
startup, protocol, semantic, security).

## FACT — the adapter as built (2026-09-29)

`gru/src/executors/opensandbox.ts`, selected with `GRU_ISOLATION=opensandbox`
(`OPEN_SANDBOX_URL`, `GRU_SANDBOX_IMAGE`, key in `OPEN_SANDBOX_API_KEY`).
Per run: create a sandbox with egress `deny`, wait for `Running`, get
the execd endpoint, upload the workspace, run the argv natively, read the
exit code from the command status, delete the sandbox. Tested against a
fake server built from the two OpenAPI files: native argv, egress
denied, the lifecycle key never reaches execd, the sandbox is always
deleted, an unreachable server is "did not run" (-1). The live smoke
test is written and skipped until `OPEN_SANDBOX_URL` is set. Until then
`provides` is empty and the safety label counts nothing for it.

