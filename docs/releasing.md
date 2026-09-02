# Releasing

All four packages use one lockstep version and one Git tag.

1. Update the root and all package versions to the same exact SemVer.
2. Update `CHANGELOG.md` and synchronized English and Chinese user documentation.
3. Confirm merged pull requests carry accurate `type:*` labels, generate the GitHub Release Notes draft, and review every entry.
4. Run `pnpm check` and complete a clean-install CLI smoke test.
5. Commit the release and push a signed or protected `v<version>` tag.
6. The publish workflow verifies the tag and versions, packs workspace
   dependencies into exact versions, then uses npm OIDC to publish in dependency
   order with provenance.
7. Verify npm `latest`, provenance, repository links, and a clean `npx` smoke
   test before announcing the release.

## First-time npm trusted publisher setup

Each package must trust the exact GitHub OIDC identity used by the release job:

- repository: `pax-beehive/dsh-hub-cli`
- workflow file: `publish.yml`
- environment: `npm`
- permission: publish

Authenticate an npm maintainer with account-level 2FA, then use npm CLI
`11.15.0` or later:

```bash
pnpm dlx npm@11.15.0 login --auth-type=web
pnpm dlx npm@11.15.0 trust github @dsh-plugin-hub/schemas --repo pax-beehive/dsh-hub-cli --file publish.yml --env npm --allow-publish --yes
pnpm dlx npm@11.15.0 trust github @dsh-plugin-hub/registry --repo pax-beehive/dsh-hub-cli --file publish.yml --env npm --allow-publish --yes
pnpm dlx npm@11.15.0 trust github @dsh-plugin-hub/cli --repo pax-beehive/dsh-hub-cli --file publish.yml --env npm --allow-publish --yes
pnpm dlx npm@11.15.0 trust github @dsh-plugin-hub/dsh-plugin --repo pax-beehive/dsh-hub-cli --file publish.yml --env npm --allow-publish --yes
```

The npm web flow may request another 2FA confirmation for a high-privilege
operation. Use its five-minute skip window to configure all four packages, then
verify every package with
`pnpm dlx npm@11.15.0 trust list <package> --json`.

If a tagged publish fails before any package is accepted, fix the trusted
publisher configuration and rerun the failed GitHub Actions job. Keep the tag
on the audited release commit instead of moving it.
