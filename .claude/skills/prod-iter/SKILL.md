---
name: prod-iter
description: >-
  Fast local install of Runwa for manual iteration: runs scripts/prod-iter.sh
  (macOS) or scripts/prod-iter-run.ps1 (Windows), which commit, build while the
  app keeps running, then stop / install / relaunch it and push. Skips all tests by
  design. Trigger on "prod iter", "PROD ITER", or a request to get the
  current changes installed and running as fast as possible.
---

# PROD ITER

The whole loop lives in the script. Run it from the repo root and don't
re-implement or pre-run any of its steps — no separate native build, no
tests, no typecheck, no separate push (the script pushes last).

macOS:

```bash
scripts/prod-iter.sh "<commit message>"
```

Windows:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\prod-iter-run.ps1 "<commit message>"
```

The script commits everything first (the pre-commit hook bumps the
version), so pass a real message describing the uncommitted change, not a
placeholder. With a clean tree, omit the message: the script ships the
current version if it isn't installed yet, and otherwise stops without
rebuilding.

The build takes minutes; run it in the background and wait for it to exit.
Report the version from the final `Shipped <version>` line. On failure,
report the failing step and its output instead of retrying — the script
stops at the first error and leaves the running Runwa alone until the build
has succeeded.

## Windows: the scheduled task

Runwa runs as administrator, so `scripts\prod-iter.ps1` itself only works
from an elevated shell. `scripts\prod-iter-run.ps1` works from a normal one:
it starts the scheduled task `Runwa prod-iter`, which runs
`scripts\prod-iter.ps1 -Unattended` elevated, then waits and prints the end
of `release\prod-iter.log`. The last line is the verdict, `RESULT: OK
<version>` or `RESULT: FAIL <step>: <reason>`, and the exit code matches
(0 shipped, 1 failed, 2 the task is missing or already running). The full
output of the build is in `release\prod-iter.log`.

If it says the task does not exist, don't try to create it: creating it
needs elevation. Ask the user to run this once from an elevated PowerShell
in the repo root, then start `prod-iter-run.ps1` again:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-prod-iter-task.ps1
```

The user can still run `scripts\prod-iter.ps1 "<commit message>"` by hand
from an elevated PowerShell; that path is unchanged.
