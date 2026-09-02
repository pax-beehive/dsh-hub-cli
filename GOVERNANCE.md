# Governance

**English** · [简体中文](GOVERNANCE.zh-CN.md)

DSH Hub CLI is maintained in public by the repository maintainers listed in [CODEOWNERS](.github/CODEOWNERS). This document defines how work is accepted, reviewed, released, and escalated.

## Principles

- Protect users first. Reproducibility, reviewable local mutations, privacy, and secret handling are release gates.
- Keep public contracts coherent. Schema, resolver, CLI, and agent-tool changes ship together when they depend on one another.
- Discuss significant work before implementation. New commands, public schema changes, compatibility changes, and large dependencies require an accepted Issue.
- Keep decisions visible. Product and technical decisions belong in Issues, Discussions, pull requests, or repository documentation.
- Prefer reversible operations and small, reviewable pull requests.

## Roles

### Maintainers

Maintainers triage Issues, moderate Discussions, review pull requests, manage security reports, approve releases, and administer repository settings. A maintainer may merge a pull request after required checks and approvals pass.

### Contributors

Anyone may report a problem, join a Discussion, improve documentation, or submit an approved change. Repeated, constructive contributions may lead to expanded triage or review permissions by maintainer consensus.

## Decision process

1. Questions and early ideas start in Discussions.
2. Reproducible bugs and scoped changes use an Issue.
3. A maintainer labels accepted work `status:accepted` and records the expected outcome.
4. Implementation proceeds through a linked pull request.
5. Public contract, security, privacy, or release changes require review from a code owner for the affected area.

Maintainers seek consensus. When consensus cannot be reached, the pull request remains open or the proposal is deferred; repository stability takes priority over schedule.

## Pull request policy

- Pull requests target `main` and must link to an accepted Issue for significant changes.
- Required CI, CodeQL, and code-owner review must pass before merge.
- Maintainers use squash merge and delete the source branch after merge.
- Force pushes to `main`, bypassing required checks, and moving published release tags are prohibited.
- A contributor may be asked to split unrelated changes or add compatibility, security, documentation, and regression coverage.

## Releases

All four packages share one SemVer version and one `v<version>` tag. Releases follow [docs/releasing.md](docs/releasing.md). User-visible changes update the changelog and English and Chinese documentation in the same release. Security releases may use an accelerated private disclosure process.

## Moderation and conflicts

Maintainers apply the [Code of Conduct](CODE_OF_CONDUCT.md). A maintainer involved in a conduct report or material conflict of interest must recuse themselves. Conduct concerns go to [hello@dshpluginhub.ai](mailto:hello@dshpluginhub.ai); vulnerabilities use the private security-advisory flow.

## Changes to governance

Governance changes require a public pull request and approval from at least two current code owners. The pull request must explain the operational impact and any migration required for open work.
