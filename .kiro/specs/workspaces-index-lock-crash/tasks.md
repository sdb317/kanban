# Implementation Plan

- [x] 1. Write bug condition exploration test (BEFORE implementing the fix)
  - **Property 1: Bug Condition** - Release-race compromise must not crash
  - **CRITICAL**: This test MUST FAIL on unfixed code - failure confirms the bug exists
  - **DO NOT attempt to fix the test or the code when it fails** - the failure is the expected outcome at this stage
  - **NOTE**: This test encodes the expected behavior; it will validate the fix when it passes after implementation (reused in task 3.2)
  - **GOAL**: Surface counterexamples that demonstrate the crash and confirm the release-race ENOENT compromise is what reaches `onCompromised`
  - **Scoped PBT Approach**: For determinism, inject a synthetic `ECOMPROMISED`/`ENOENT` event via the stubbed `proper-lockfile`/`fs` rather than relying on wall-clock timer timing; scope the property to the concrete release-race signatures (`syscall` in `utime`/`utimes`/`stat`, underlying `ENOENT`, arriving after the critical section completed)
  - Add the test in `test/runtime/locked-file-system.test.ts`, extending the existing `proper-lockfile` mock so the refresh path emits an `ECOMPROMISED` error carrying an underlying `ENOENT` on the lock file after `withLock`'s operation resolves
  - Cover the bug condition from the design `isBugCondition(input)`: `error.code == "ECOMPROMISED"` AND `error.syscall IN ["utime","utimes","stat"]` AND `error.underlyingCode == "ENOENT"` AND `criticalSectionCompleted == true` AND NOT `handledByOnCompromised`
  - Test cases (from Exploratory Bug Condition Checking in design):
    1. Index lock release-race (`utime`) - inject `ECOMPROMISED` with underlying `ENOENT` on `index.json.lock` after the operation resolves
    2. Index lock release-race (`stat`) - inject the `stat` ENOENT branch producing `ECOMPROMISED` after release
    3. Directory/root lock release-race - same injection on a directory lock request to show the crash is not index-specific
  - Assertions should match the Expected Behavior Properties: on fixed code the compromise is tolerated (no unhandled error, process keeps running, critical-section result preserved)
  - Run test on UNFIXED code
  - **EXPECTED OUTCOME**: Test FAILS - the injected `ECOMPROMISED`/`ENOENT` error escapes the locking layer as an unhandled error (confirms missing default `onCompromised`, refresh-after-release race, and the library default `(err) => { throw err; }`)
  - Document counterexamples found (e.g., "`utime 'index.json.lock'` ENOENT tagged `ECOMPROMISED` propagates out of `withLock` after the operation resolved")
  - Mark task complete when the test is written, run, and the failure is documented
  - _Requirements: 1.1, 1.2, 1.3_

- [x] 2. Write preservation property tests (BEFORE implementing the fix)
  - **Property 2: Preservation** - Non-release-race behavior unchanged
  - **IMPORTANT**: Follow the observation-first methodology - run the UNFIXED code first, record actual outputs, then assert those outputs
  - Observe behavior on UNFIXED code for inputs where `isBugCondition` returns false, then write property-based and unit tests capturing the observed patterns from the Preservation Requirements in the design
  - Property-based testing is recommended here: generate random `(request, operation, error-event)` combinations across the input domain to catch edge cases (contention timing, non-ENOENT compromises, varied syscalls) and give strong confidence only the benign path changes
  - Test cases (from Preservation Checking in design):
    1. **Successful acquire/release preservation** - observe `withLock` runs the operation and persists `index.json` with no compromise; generate random successful lock/operation sequences and assert persistence output is byte-for-byte identical
    2. **Mutual exclusion preservation** - observe serialized access under contention; generate contention scenarios and assert only one holder at a time (retries/stale from `DEFAULT_LOCK_RETRIES` / `DEFAULT_LOCK_STALE_MS` unchanged)
    3. **Genuine compromise surfacing preservation** - observe that a non-ENOENT `ECOMPROMISED` (e.g., mtime-stolen) throws; assert it still throws
    4. **Request-supplied `onCompromised` preservation** - observe that a caller-provided `onCompromised` is honored; assert it is still preferred over the default
  - Run tests on UNFIXED code
  - **EXPECTED OUTCOME**: Tests PASS (this confirms the baseline behavior to preserve)
  - **NOTE**: The existing `test/runtime/locked-file-system.test.ts` case "omits onCompromised when no handler is provided" asserts the pre-fix behavior; note it here as a baseline that the fix will intentionally change (see task 3.1) so it is updated rather than treated as a regression
  - Mark task complete when the tests are written, run, and passing on unfixed code
  - _Requirements: 3.1, 3.2, 3.3, 3.4_

- [x] 3. Fix for unhandled release-race compromised-lock crash in the locking layer

  - [x] 3.1 Implement the fix in `createLockOptions`
    - **File**: `src/fs/locked-file-system.ts`, **Function**: `createLockOptions`
    - Add an `isReleaseRaceCompromise(error)` predicate that returns true only when `error.code === "ECOMPROMISED"` AND the underlying syscall is `utime`/`utimes`/`stat` AND the error indicates an underlying `ENOENT` on the lock file (inspect preserved `syscall`/`errno`/message)
    - Add a `defaultOnCompromised(error)` handler: if `isReleaseRaceCompromise(error)` is true, log at debug level for observability and return without throwing (benign - critical section already completed, lock already released); otherwise re-throw to preserve existing surfacing of genuine compromises
    - Set `options.onCompromised = request.onCompromised ?? defaultOnCompromised` so a request-supplied handler still takes precedence
    - Keep the change centralized and minimal: no changes to `withLock`/`withLocks`, the `LockRequest` shape, or any caller (`getWorkspaceIndexLockRequest` and other request builders untouched)
    - Update the existing unit test "omits onCompromised when no handler is provided" to reflect the new default (a default `onCompromised` is now installed when the request omits one)
    - _Bug_Condition: isBugCondition(input) from design - `ECOMPROMISED` + underlying `ENOENT` (syscall utime/utimes/stat) + criticalSectionCompleted + not already handled_
    - _Expected_Behavior: expectedBehavior(result) from design - tolerate benign release-race compromise, no unhandled error, process keeps running, critical-section result stands_
    - _Preservation: Preservation Requirements from design - normal acquire/release, mutual exclusion, atomic persistence, genuine-failure surfacing, request-supplied handler precedence unchanged_
    - _Requirements: 2.1, 2.2, 2.3, 3.1, 3.2, 3.3, 3.4_

  - [x] 3.2 Verify bug condition exploration test now passes
    - **Property 1: Expected Behavior** - Release-race compromise must not crash
    - **IMPORTANT**: Re-run the SAME test from task 1 - do NOT write a new test
    - The test from task 1 encodes the expected behavior; when it passes it confirms the fix tolerates the benign release-race compromise
    - Run the bug condition exploration test from task 1
    - **EXPECTED OUTCOME**: Test PASSES - no unhandled error, process still running, critical-section result preserved (confirms the bug is fixed)
    - Confirm the edge case (genuine, non-ENOENT compromise while the critical section is live) still throws on the fixed code
    - _Requirements: 2.1, 2.2, 2.3_

  - [x] 3.3 Verify preservation tests still pass
    - **Property 2: Preservation** - Non-release-race behavior unchanged
    - **IMPORTANT**: Re-run the SAME tests from task 2 - do NOT write new tests
    - Run the preservation property/unit tests from task 2
    - **EXPECTED OUTCOME**: Tests PASS - successful acquire/release, mutual exclusion, genuine-compromise surfacing, and request-supplied `onCompromised` precedence all unchanged (confirms no regressions)
    - _Requirements: 3.1, 3.2, 3.3, 3.4_

- [x] 4. Add integration coverage for the task-operation flow
  - Run a representative task operation flow (`loadWorkspaceContext` / `removeWorkspaceIndexEntry` in `src/state/workspace-state.ts`) with the refresh race simulated around release; assert the operation completes, `index.json` is correct, and the process does not crash
  - Run rapid sequential index-locked operations to exercise trailing-refresh timing; assert no unhandled rejection and a correct final index state
  - Run a flow with a genuine (non-ENOENT) compromise injected mid-critical-section; assert the error surfaces to the caller as before
  - Add a `withLocks`/`withLock` ordering regression guard: locks acquired in sorted order and released in reverse order exactly as before
  - _Requirements: 2.1, 2.2, 2.3, 3.1, 3.2, 3.3, 3.4_

- [x] 5. Checkpoint - Ensure all tests pass
  - Run the full test suite (vitest, single run) and the build/compile step; ensure Fix Checking, Preservation Checking, unit, property-based, and integration tests all pass
  - Confirm no unhandled rejections remain and no unrelated tests regressed
  - Ask the user if questions arise
