---
name: release
description: Increment the package version, commit the release, create a matching version tag, and push main plus the tag. Use when releasing this repo, publishing the package, bumping the version, tagging a release, or when the user asks to "release", "bump ver", "tag", or "push tags".
---

# Release

Use this workflow to publish a new `relay-pi` version through the GitHub release workflow.

## Steps

1. Confirm the working tree and branch:
   - Run `git status --short --branch`.
   - If there are unrelated changes, ask before including them.
   - Release from `main` unless the user explicitly says otherwise.

2. Choose the next version:
   - Read `package.json`.
   - Increment the patch version by default.
   - Use the tag name `relay-pi-v<version>`, for example `relay-pi-v0.1.12`.
   - Check that the tag does not already exist locally or remotely.

3. Update release metadata:
   - Change only `package.json` for a normal version bump.
   - Do not edit `bun.lock` unless the package manager updates it as part of a dependency change.

4. Verify before committing:
   - Run `bun run check-types`.
   - Run `bun run lint`.
   - Run broader tests only when the release includes code changes or the user asks for them.

5. Commit:
   - Stage `package.json`.
   - Commit with `chore: release relay-pi-v<version>`.

6. Tag and push:
   - Create an annotated tag: `git tag -a relay-pi-v<version> -m "relay-pi-v<version>"`.
   - Push `main`: `git push origin main`.
   - Push the tag: `git push origin relay-pi-v<version>`.

7. Report back:
   - Include the new version, commit SHA, tag name, pushed refs, and verification commands.
