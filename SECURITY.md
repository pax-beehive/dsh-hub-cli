# Security policy

**English** · [简体中文](SECURITY.zh-CN.md)

## Supported versions

Security fixes are released for the current npm `latest` version. Upgrade all
four `@dsh-plugin-hub/*` packages together so the contracts, resolver, CLI, and
agent adapter stay aligned.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use this repository's
GitHub **Security → Report a vulnerability** flow to open a private security
advisory. Include the affected command or package, reproduction steps, impact,
and any suggested mitigation.

Maintainers will acknowledge a complete report within three business days,
coordinate a fix and disclosure window, and credit reporters who want public
recognition.

## Sensitive local data

The CLI stores its Hub session at `$DSH_HOME/.hub/auth.json` (or
`~/.dsh/.hub/auth.json`) with mode `0600`. Never attach that file, access or
refresh tokens, `.env` files, or Profile secret values to an issue.
