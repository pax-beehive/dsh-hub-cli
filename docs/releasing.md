# Releasing

All four packages use one lockstep version and one Git tag.

1. Update the root and all package versions to the same exact SemVer.
2. Update release notes and run `pnpm check`.
3. Commit the release and push a signed or protected `v<version>` tag.
4. The publish workflow verifies the tag and versions, packs workspace
   dependencies into exact versions, then uses npm OIDC to publish in dependency
   order with provenance.
5. Verify npm `latest`, provenance, repository links, and a clean `npx` smoke
   test before announcing the release.

Each npm package must configure this GitHub repository and
`.github/workflows/publish.yml` as its trusted publisher before the first
release from the new repository.
