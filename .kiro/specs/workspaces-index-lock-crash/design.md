# Workspaces Index Lock Crash Bugfix Design

## Overview

Task operations crash the application intermittently with an unhandled `ECOMPROMISED` error originating from `proper-lockfile`'s background lock-refresh timer. The crash happens when the workspaces index lock (`workspaces/index.json.lock`) is released in the small window between the refresh timer firing and its `utime`/`stat` syscall executing against the now-removed lock file. The syscall fails with `ENOENT`, `proper-lockfile` tags it `ECOMPROMISED`, and because no `onCompromised` handler is supplied, its default handler (`(err) => { throw err; }`) throws from a timer callback, surfacing as an unhandled rejection that terminates the process.

The fix is targeted and minimal: install a safe default `onCompromised` handler in `createLockOptions` (`src/fs/locked-file-system.ts`) that tolerates a benign release-race compromise (an `ENOENT`-backed `ECOMPROMISED` on a lock the critical section has already completed) without crashing, while still surfacing genuine compromises. Because the handler is centralized in `createLockOptions`, it protects every lock request (index, workspace directory, workspaces root, board/sessions/meta, runtime config, task worktree setup) uniformly, which is the correct scope: the refresh/release race is a property of the locking layer, not of the index lock specifically. The critical section's result is unaffected because the compromise signal only ever arrives after the lock has been acquired and the protected operation has run; mutual exclusion and persistence remain unchanged.

## Glossary

- **Bug_Condition (C)**: The condition that triggers the bug — `proper-lockfile`'s background refresh timer runs `stat`/`utime` on a lock file that has already been removed by lock release, producing an `ENOENT`-backed `ECOMPROMISED` error that is thrown from the timer with no handler.
- **Property (P)**: The desired behavior for the bug condition — the release-race compromise is caught and tolerated so no unhandled error is raised and the process keeps running; the already-completed critical section's result stands.
- **Preservation**: Normal lock acquisition, mutual exclusion (serialized access), index/board/sessions/meta persistence, and genuine lock-failure surfacing that must remain unchanged by the fix.
- **`createLockOptions`**: The function in `src/fs/locked-file-system.ts` that builds the `proper-lockfile` `LockOptions` (stale, retries, realpath, lockfilePath, and optional `onCompromised`) from a `LockRequest`. The fix centralizes the default `onCompromised` here.
- **`onCompromised`**: The `proper-lockfile` callback invoked when a held lock is deemed compromised. Its library default (`(err) => { throw err; }`) throws; the index lock request supplies none, so the default throws and crashes.
- **`getWorkspaceIndexLockRequest`**: The function in `src/state/workspace-state.ts` that produces the `LockRequest` for `workspaces/index.json`. It is used by `loadWorkspaceContext`, `removeWorkspaceIndexEntry`, etc., via `lockedFileSystem.withLock`.
- **Release race**: The timing window where `unlock` sets `lock.released = true` and clears the refresh timeout, but a previously scheduled refresh callback's async `stat`/`utimes` continues and observes the removed lock file as `ENOENT`.

## Bug Details

### Bug Condition

The bug manifests when `proper-lockfile`'s background refresh timer, having already been scheduled for a held lock, runs its `stat`/`utimes` syscall against the lock file after that lock file has been removed by release. In `updateLock` (`node_modules/proper-lockfile/lib/lockfile.js`), the `stat` callback's `err.code === 'ENOENT'` branch calls `setLockAsCompromised(... { code: 'ECOMPROMISED' })` with no `lock.released` guard, so a release-race ENOENT reaches `onCompromised`. The index lock request supplies no `onCompromised`, so `proper-lockfile`'s default handler throws the error from the timer, producing an unhandled rejection.

**Formal Specification:**
```
FUNCTION isBugCondition(input)
  INPUT: input of type CompromisedLockEvent
  OUTPUT: boolean

  RETURN input.error.code == "ECOMPROMISED"
         AND input.error.syscall IN ["utime", "utimes", "stat"]
         AND input.error.underlyingCode == "ENOENT"
         AND input.criticalSectionCompleted == true   // release already initiated
         AND NOT input.handledByOnCompromised           // no handler tolerated it
END FUNCTION
```

The underlying error retains the original syscall metadata (`errno: -4058`, `syscall: 'utime'`, `code: 'ECOMPROMISED'`, with the ENOENT text preserved on the message/path), which is exactly what lets the handler distinguish a benign release-race compromise from a genuine one.

### Examples

- **Observed crash (verified):** A task operation acquires the index lock; mid-operation the lock is released; the refresh timer fires `utime` on `C:\Users\...\workspaces\index.json.lock`, which no longer exists. Error: `[Error: ENOENT: no such file or directory, utime '...index.json.lock'] errno: -4058, code: 'ECOMPROMISED', syscall: 'utime'`. Expected: the operation completes and the app keeps running. Actual: unhandled rejection crashes the process.
- **`stat` ENOENT path:** The refresh timer's `fs.stat(lockfilePath)` returns `ENOENT` because the lock was just released; `proper-lockfile` tags it `ECOMPROMISED` and invokes the (default, throwing) handler. Expected: tolerated. Actual: crash.
- **Rapid sequential task operations:** Two quick operations each acquire and release the index lock; the first lock's trailing refresh callback fires after its release, hitting the removed lock file. Expected: both operations succeed, no crash. Actual: intermittent crash depending on timer alignment.
- **Edge case — genuine compromise:** The lock file is deleted or its mtime changes while the critical section is still running and the lock was NOT released by us (e.g., another process removed it, or the stale threshold was exceeded). Expected behavior: this is NOT the bug condition and SHALL still surface as an error.

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- Normal lock acquisition and release for the index, workspace directory, workspaces root, and runtime config locks continues to work exactly as before.
- Mutual exclusion is preserved: when two operations contend for the same lock, only one holds it at a time (retries/stale behavior from `DEFAULT_LOCK_RETRIES` / `DEFAULT_LOCK_STALE_MS` are untouched).
- Atomic persistence of `index.json`, `board.json`, `sessions.json`, and `meta.json` via `writeJsonFileAtomic` remains byte-for-byte identical.
- Genuine lock failures (lock cannot be acquired, `ELOCKED`, or a real compromise unrelated to our own release) continue to surface rather than being silently swallowed.

**Scope:**
All inputs that do NOT satisfy the release-race compromise condition should be completely unaffected by this fix. This includes:
- Successful lock acquisition/release with no compromise signal at all (the common case — the handler is never invoked).
- Lock acquisition failures and contention (`ELOCKED`, retry exhaustion) — handled by `proper-lockfile.lock`, not by `onCompromised`.
- Genuine compromises while the critical section is still live (mtime stolen, lock removed by another party, stale-threshold overrun) — still raised.

**Note:** The actual expected correct behavior for the bug condition is defined in the Correctness Properties section (Property 1). This section focuses on what must NOT change.

## Hypothesized Root Cause

Based on the verified code path (`src/state/workspace-state.ts` → `LockedFileSystem.withLock` in `src/fs/locked-file-system.ts` → `proper-lockfile`), the cause is:

1. **Missing `onCompromised` handler on the index lock (primary, verified)**: `getWorkspaceIndexLockRequest()` supplies no `onCompromised`, and `createLockOptions` only sets `options.onCompromised` when the request provides one. So `proper-lockfile` falls back to its default handler `(err) => { throw err; }`, which throws from the refresh timer and escapes as an unhandled rejection.

2. **Release/refresh timing race in `proper-lockfile` (verified)**: In `updateLock`, the refresh timer is scheduled with `setTimeout`. `unlock` sets `lock.released = true` and clears the timeout, but a refresh callback already in flight continues its async `stat`/`utimes`. The `stat` ENOENT branch calls `setLockAsCompromised` with no `lock.released` guard, so release-race ENOENTs still reach `onCompromised`. This is intrinsic to the library version in use and cannot be fixed by us except by handling the resulting signal.

3. **Centralization gap (contributing)**: Because the default is per-request rather than applied in `createLockOptions`, every lock that omits `onCompromised` is equally exposed. The index lock happens to be the one exercised most by task operations, so it surfaces first, but the directory/root/config locks share the same latent risk.

4. **Not a selector/indexing/DOM issue**: Unlike a UI-event bug, there is no wrong element or index; the defect is purely in unhandled asynchronous lock-lifecycle error handling.

## Correctness Properties

Property 1: Bug Condition - Release-race compromise must not crash

_For any_ input where the bug condition holds (`isBugCondition` returns true — an `ECOMPROMISED` error whose underlying syscall is `ENOENT` arriving after the critical section's lock release), the fixed locking layer SHALL tolerate the compromise via the installed `onCompromised` handler so that no unhandled error is raised and the process keeps running, while the already-completed critical section's result stands.

**Validates: Requirements 2.1, 2.2, 2.3**

Property 2: Preservation - Non-release-race behavior unchanged

_For any_ input where the bug condition does NOT hold (`isBugCondition` returns false — normal acquire/release with no compromise, lock-acquisition failures, contention, or a genuine compromise while the critical section is live), the fixed locking layer SHALL produce the same result as the original layer, preserving mutual exclusion, atomic persistence of the index and other state files, and the surfacing of genuine lock failures.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4**

## Fix Implementation

### Changes Required

Assuming the root cause analysis is correct, the fix is scoped to the locking layer so it covers the index lock and all other locks uniformly.

**File**: `src/fs/locked-file-system.ts`

**Function**: `createLockOptions`

**Specific Changes**:
1. **Install a safe default `onCompromised`**: When a `LockRequest` does not supply its own `onCompromised`, set `options.onCompromised` to a default handler instead of leaving it unset (which falls back to `proper-lockfile`'s throwing default). A request-supplied `onCompromised` still takes precedence, preserving the existing override capability.

2. **Distinguish benign release-race from genuine compromise**: Add a small predicate (e.g. `isReleaseRaceCompromise(error)`) that returns true only when the error is an `ECOMPROMISED` whose underlying cause is `ENOENT` on the lock file (inspect `error.code === 'ECOMPROMISED'` together with the preserved `syscall`/`errno`/message indicating `ENOENT`). This is the signature of the refresh-timer-after-release race.

3. **Tolerate benign, surface genuine**: In the default handler, if `isReleaseRaceCompromise(error)` is true, swallow it (optionally log at debug level for observability) and return without throwing — the critical section has already completed and the lock has already been released, so there is nothing left to protect. Otherwise, preserve existing behavior by re-throwing so genuine compromises are not masked.

4. **Keep behavior centralized and minimal**: The change lives entirely in `createLockOptions`; no changes to `withLock`/`withLocks`, the `LockRequest` shape (the optional `onCompromised` field already exists), or any caller. `getWorkspaceIndexLockRequest` and the other request builders are left untouched, so persistence and ordering logic are unchanged.

5. **No swallowing of acquisition/contention errors**: `onCompromised` is only invoked by `proper-lockfile` for a held, then-compromised lock. Acquisition failures (`ELOCKED`, retry exhaustion) flow through `lockfile.lock`'s callback/promise and are unaffected, so genuine "cannot lock" failures still propagate.

### Illustrative Pseudocode

```
FUNCTION isReleaseRaceCompromise(error)
  RETURN error.code == "ECOMPROMISED"
         AND ( error.syscall IN ["utime", "utimes", "stat"] )
         AND errorIndicatesEnoent(error)   // underlying ENOENT on the lock file
END FUNCTION

FUNCTION defaultOnCompromised(error)
  IF isReleaseRaceCompromise(error) THEN
    // benign: refresh timer fired after our own release removed the lock file
    debugLog("tolerated release-race lock compromise", error)
    RETURN            // do NOT throw -> no crash, critical section already done
  END IF
  THROW error         // genuine compromise -> preserve existing surfacing
END FUNCTION

// in createLockOptions:
options.onCompromised = request.onCompromised ?? defaultOnCompromised
```

## Testing Strategy

### Validation Approach

The strategy follows two phases: first surface counterexamples that demonstrate the crash on the unfixed code and confirm the root cause, then verify the fix tolerates the benign compromise while preserving all normal locking behavior. Because the trigger is a timer/release race, tests inject a synthetic `ECOMPROMISED`/`ENOENT` error into the `onCompromised` path rather than relying on wall-clock timing, keeping tests deterministic.

### Exploratory Bug Condition Checking

**Goal**: Surface counterexamples that demonstrate the crash BEFORE implementing the fix, and confirm (or refute) that the release-race ENOENT compromise is what reaches `onCompromised`. If refuted, re-hypothesize.

**Test Plan**: Drive `createLockOptions`/`LockedFileSystem.withLock` with a stubbed `proper-lockfile` (or a stubbed `fs`) whose refresh path emits an `ECOMPROMISED` error carrying an underlying `ENOENT` on the lock file after the critical section has completed. On the UNFIXED code, assert that the error escapes (unhandled) — demonstrating the crash path.

**Test Cases**:
1. **Index lock release-race (utime)**: Simulate a refresh `utime` ENOENT on `index.json.lock` after `withLock`'s operation resolves (will throw/escape on unfixed code).
2. **Index lock release-race (stat)**: Simulate the `stat` ENOENT branch producing `ECOMPROMISED` after release (will throw/escape on unfixed code).
3. **Directory/root lock release-race**: Same injection on a directory lock request to show the latent crash is not index-specific (will throw/escape on unfixed code).
4. **Edge — genuine compromise while live**: Inject an `ECOMPROMISED` that is NOT an ENOENT release race (e.g., mtime-stolen) while the critical section is still running (should throw on both unfixed and fixed code).

**Expected Counterexamples**:
- The injected `ECOMPROMISED`/`ENOENT` error propagates out of the locking layer as an unhandled error on the unfixed code.
- Possible causes confirmed: missing default `onCompromised`, refresh-after-release race, library default `(err) => { throw err; }`.

### Fix Checking

**Goal**: Verify that for all inputs where the bug condition holds, the fixed locking layer tolerates the compromise without raising an unhandled error and keeps the process running.

**Pseudocode:**
```
FOR ALL input WHERE isBugCondition(input) DO
  result := runIndexLockedOperationWithInjectedCompromise'(input)
  ASSERT no_unhandled_error(result)
  ASSERT process_still_running(result)
  ASSERT critical_section_result_preserved(result)
END FOR
```

### Preservation Checking

**Goal**: Verify that for all inputs where the bug condition does NOT hold, the fixed layer produces the same result as the original layer.

**Pseudocode:**
```
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT runLockedOperation(input) = runLockedOperation'(input)
END FOR
```

**Testing Approach**: Property-based testing is recommended for preservation checking because:
- It generates many `(request, operation, error-event)` combinations across the input domain.
- It catches edge cases (contention timing, non-ENOENT compromises, varied syscalls) that fixed unit tests might miss.
- It gives strong confidence that only the benign release-race ENOENT path is affected and nothing else changes.

**Test Plan**: Observe behavior on the UNFIXED code first for successful locking, contention, and genuine compromises, then write property-based and unit tests that assert the FIXED code matches that behavior for every non-bug input.

**Test Cases**:
1. **Successful acquire/release preservation**: Observe that `withLock` runs the operation and persists `index.json` with no compromise on unfixed code; assert identical result after the fix.
2. **Mutual exclusion preservation**: Observe serialized access under contention on unfixed code; assert the fix still serializes (retries/stale unchanged).
3. **Genuine compromise surfacing preservation**: Observe that a non-ENOENT `ECOMPROMISED` throws on unfixed code; assert the fix still throws it.
4. **Request-supplied `onCompromised` preservation**: Observe that a caller-provided `onCompromised` is honored on unfixed code; assert the fix still prefers it over the default.

### Unit Tests

- `createLockOptions` installs a default `onCompromised` when the request omits one, and preserves a request-supplied handler when present.
- The default handler returns (does not throw) for an `ECOMPROMISED` with an underlying ENOENT on the lock file, and re-throws for any other compromise.
- `withLock`/`withLocks` acquire in sorted order and release in reverse order exactly as before (ordering regression guard).

### Property-Based Tests

- Generate random `LockRequest`s and injected error events; assert that only the benign release-race ENOENT path is swallowed and every other event is re-thrown (Property 1 and Property 2 together).
- Generate random successful lock/operation sequences; assert persistence output is identical with and without the fix.
- Generate contention scenarios; assert mutual exclusion holds unchanged.

### Integration Tests

- Run a representative task operation flow (`loadWorkspaceContext` / `removeWorkspaceIndexEntry`) with the refresh race simulated around release; assert the operation completes, `index.json` is correct, and the process does not crash.
- Run rapid sequential index-locked operations to exercise trailing-refresh timing; assert no unhandled rejection and correct final index state.
- Run a flow with a genuine (non-ENOENT) compromise injected mid-critical-section; assert the error surfaces to the caller as before.
