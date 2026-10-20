# Bugfix Requirements Document

## Introduction

The application intermittently crashes while performing operations on kanban tasks. The crash surfaces as an unhandled error from the file-locking layer:

```
[Error: ENOENT: no such file or directory, utime 'C:\Users\Bells\.cline\kanban\workspaces\index.json.lock']
  errno: -4058,
  code: 'ECOMPROMISED',
  syscall: 'utime',
  path: 'C:\\Users\\Bells\\.cline\\kanban\\workspaces\\index.json.lock'
```

Task operations acquire a lock on the workspaces index (`workspaces/index.json`) through `getWorkspaceIndexLockRequest()` in `src/state/workspace-state.ts`, which routes through `LockedFileSystem.withLock` in `src/fs/locked-file-system.ts` and ultimately `proper-lockfile`. `proper-lockfile` keeps a lock fresh with a background timer that periodically runs `utime` against the lock file. When the lock is released (and its lock file removed) in the small window between the refresh timer firing and the `utime` syscall executing, `utime` fails with `ENOENT`. `proper-lockfile` reports this as a compromised lock (`ECOMPROMISED`). Because the index lock request does not supply an `onCompromised` handler, the default behavior throws, the error escapes as an unhandled rejection, and the app crashes.

The behavior is intermittent because it depends on a timing race between the refresh interval and lock release, which is why only some task operations trigger it. The impact is a full application crash that interrupts the user mid-operation.

## Bug Analysis

### Current Behavior (Defect)

When the lock-refresh timer for the workspaces index lock fires at the moment the lock is being (or has just been) released, the resulting compromised-lock error is not handled and crashes the app.

1.1 WHEN the workspaces index lock file is removed during lock release and the background refresh timer runs `utime` against the now-missing lock file THEN the system raises an unhandled `ENOENT`/`ECOMPROMISED` error
1.2 WHEN a task operation acquires the workspaces index lock without an `onCompromised` handler and the lock becomes compromised THEN the system crashes instead of continuing
1.3 WHEN the `ECOMPROMISED` error propagates during a task operation THEN the system terminates the running operation and the application process

### Expected Behavior (Correct)

The compromised-lock condition caused by the refresh/release race must not crash the application. The critical section's result must still be honored, and a spurious compromised-lock signal that occurs around release must be tolerated.

2.1 WHEN the workspaces index lock file is removed during lock release and the background refresh timer runs `utime` against the now-missing lock file THEN the system SHALL handle the condition without raising an unhandled error
2.2 WHEN a task operation acquires the workspaces index lock and the lock becomes compromised due to the refresh/release race THEN the system SHALL NOT crash and SHALL allow the operation to complete or fail gracefully
2.3 WHEN the `ECOMPROMISED` error occurs during a task operation THEN the system SHALL keep the application process running

### Unchanged Behavior (Regression Prevention)

Normal locking, mutual exclusion, and persistence of the workspaces index and other state files must continue to work exactly as before.

3.1 WHEN a task operation acquires and releases the workspaces index lock with no refresh/release race THEN the system SHALL CONTINUE TO complete the operation and persist `index.json` correctly
3.2 WHEN two task operations contend for the workspaces index lock THEN the system SHALL CONTINUE TO serialize access so only one holds the lock at a time
3.3 WHEN a genuine lock failure occurs (for example, the lock cannot be acquired or a real compromise unrelated to release) THEN the system SHALL CONTINUE TO surface that failure rather than silently ignoring it
3.4 WHEN other locked files (workspace directory locks, board, sessions, meta) are written THEN the system SHALL CONTINUE TO lock and persist them as before

## Bug Condition and Properties

### Bug Condition

```pascal
FUNCTION isBugCondition(X)
  INPUT: X of type IndexLockOperation
  OUTPUT: boolean

  // The index lock's background refresh runs utime on the lock file
  // after that lock file has been removed by release (the release race).
  RETURN X.lockfile = "workspaces/index.json.lock"
         AND X.refreshTimerFiresAfterLockReleased = true
END FUNCTION
```

### Fix Checking

```pascal
// Property: Fix Checking - Compromised index lock must not crash
FOR ALL X WHERE isBugCondition(X) DO
  result <- runTaskOperationWithIndexLock'(X)
  ASSERT no_unhandled_error(result) AND process_still_running(result)
END FOR
```

### Preservation Checking

```pascal
// Property: Preservation Checking - Normal locking unchanged
FOR ALL X WHERE NOT isBugCondition(X) DO
  ASSERT runTaskOperationWithIndexLock(X) = runTaskOperationWithIndexLock'(X)
END FOR
```

Where `F` is the current index-locking behavior and `F'` is the behavior after the fix.
