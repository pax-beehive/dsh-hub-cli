---
name: dsh-hub
description: Safely discover, review, install, upgrade, share, and roll back DSH Plugin Hub Profiles through the dsh-hub CLI.
---

# DSH Hub Profile workflow

Use the installed `dsh-hub` CLI as the sole local execution authority.

## Install or upgrade

1. Inspect the public release with `dsh-hub profile apply <slug> --plan --json`.
2. Show the user the target Profile, exact Profile Release, ordered Plugins,
   exact Plugin versions, required local inputs, and current-state precondition.
3. Obtain explicit confirmation for that plan ID.
4. Run `dsh-hub operation apply <plan-id> --json`.
5. Report the final NDJSON event. Never claim success before
   `operation.completed`.

Plans expire after 30 minutes and fail if the target changed after planning.
Create a fresh plan when either condition occurs.

## Share the current Profile

1. Create a plan with `dsh-hub profile share <slug> --profile <name>
   --version <semver> --plan --json`.
2. Present the exact runtime, ordered layers, versions, patch, declared input
   keys, and local Profile hash. Stop on `file:`, `link:`, `workspace:` or
   another unpublished local Plugin source.
3. Obtain explicit confirmation and apply the returned plan ID through
   `dsh-hub operation apply <plan-id> --json`.

Never upload environment values, credentials, session data, logs, or Plugin
code.

## Recover

Use `dsh-hub profile history --profile <name> --json` to inspect revisions.
Create the rollback with `dsh-hub profile rollback [revision] --profile <name>
--plan --json`, present the selected complete revision, then obtain explicit
confirmation before applying its plan ID. Rollback restores Profile files and
installed dependencies; it does not reverse Plugin data migrations or external
effects.
