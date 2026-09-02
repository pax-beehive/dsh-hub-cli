# Repository maintenance runbook

**English** · [简体中文](maintaining.zh-CN.md)

This runbook is the operating source of truth for `pax-beehive/dsh-hub-cli`.

## Weekly rotation

### Tuesday: triage

1. Review new Issues and Discussions.
2. Apply one `type:*`, one `area:*`, and one `status:*` label where applicable.
3. Request a minimal reproduction for unconfirmed bugs and apply `status:needs-repro`.
4. Move accepted, scoped work to `status:accepted` and record its success criteria.
5. Review Dependabot pull requests; merge only after required checks and compatibility review.

### Friday: review and release readiness

1. Review open pull requests and confirm every significant change links to an accepted Issue.
2. Check failed or flaky Actions runs and open an Issue for failures that can recur.
3. Review accepted Issues with no update for 30 days and post a status note.
4. Decide whether accumulated user-visible changes justify a release candidate.

Maintainers rotate weekly. The active maintainer owns initial responses; the second maintainer supplies required review and escalation coverage.

## Service targets

- New Issues: first triage within two business days.
- Pull requests: first review within three business days.
- Complete vulnerability reports: acknowledgement within three business days.
- Current-release regressions: highest non-security priority.

## Issue lifecycle

`status:needs-triage` → `status:needs-repro` or `status:accepted` → linked pull request → closed by merge.

- Close duplicates with a link to the canonical Issue.
- Close declined requests with a short product or compatibility reason.
- Do not use an automatic stale bot during the initial operating period.
- Convert a Discussion to an Issue only after the problem and desired outcome are clear.

## Pull request controls

- Target `main`; direct pushes are blocked by the branch ruleset.
- Require one approving review, resolved conversations, `CI / verify`, CodeQL, pull request title policy, dependency review, and any required code-owner review.
- Dismiss approvals when new commits are pushed.
- Use squash merge and a Conventional Commit-style title suitable for the changelog.
- Delete the source branch after merge.
- Never bypass checks for convenience. Emergency security work follows a private advisory and still receives review before release.

## Label model

- `type:*` describes why the work exists: bug, feature, docs, security, breaking, question, release, showcase.
- `area:*` identifies ownership: cli, agent, registry, schemas, docs, github.
- `status:*` captures workflow state: needs-triage, needs-repro, accepted, blocked.
- `good first issue` and `help wanted` advertise contribution opportunities.
- `skip-changelog` excludes internal-only pull requests from generated release notes.

## Release control

Follow [releasing.md](releasing.md). A release requires:

1. One shared exact version in the root and all four packages.
2. An updated `CHANGELOG.md` and synchronized user-facing English and Chinese docs.
3. Green required checks and `pnpm check` on the release commit.
4. An immutable protected `v<version>` tag.
5. Verified npm `latest`, provenance, repository metadata, and clean-install smoke test.

Do not publish an empty scheduled release. Publish security fixes as soon as the coordinated disclosure is ready.

## Monthly review

Post one maintainer Discussion summarizing:

- Stars, forks, unique visitors, clones, and external contributors;
- Issue response time, closures, and untriaged backlog;
- pull request review and merge time;
- CI, dependency, security, and release failures; and
- npm download trend and aggregate CLI success/failure signals.

Record actions for the next month as Issues with owners and acceptance criteria.

## One-time repository settings

Keep these settings aligned with this runbook:

- homepage `https://dshpluginhub.ai` and curated repository topics;
- Issues and Discussions enabled; unused Wiki and Projects disabled;
- squash merge and automatic head-branch deletion enabled;
- private vulnerability reporting, Dependabot alerts and updates, secret scanning, and push protection enabled;
- a `main` ruleset requiring pull requests, one approval, code-owner review, resolved conversations, linear history, and required Actions checks; and
- tag protection for `v*`, with release creation restricted to maintainers.
