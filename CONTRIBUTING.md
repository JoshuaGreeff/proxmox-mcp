# Contributing

Thanks for contributing to `proxmox-mcp`.

## Branch Flow

This repo uses a staged branch model:

- branch normal work from `dev`
- use short-lived `feature/*` branches for implementation
- merge finished feature work into `dev`
- promote `dev` into `main` only when the integrated state is fully tested and ready for production
- branch urgent fixes from `main` as `hotfix/*`, then back-merge those fixes into `dev`

`main` is the production-ready branch. `dev` is the integration branch.

## Local Checks

Run these before opening a PR or merging a non-trivial change:

```bash
npm run check
npm run test
npm run build
```

If a change affects disposable live validation paths, run the documented live checks as well.

## Repo Safety Rules

- do not commit secrets, credentials, private keys, audit logs, or confidential lab details
- keep runtime secrets in env or the configured secret backend, never in tracked files
- keep docs aligned with actual behavior, validated workflows, and current repo policy
- prefer small, auditable changes over broad rewrites when updating validated Proxmox behavior

## Docs Expectations

Documentation is part of the product surface. Update the relevant docs in the same change whenever you alter:

- setup or deployment behavior
- tool names or tool behavior
- branching or maintainer workflow
- validated lab assumptions

## Pull Requests

When opening a PR:

- target `dev` for normal work
- target `main` only for release promotions from `dev` or urgent `hotfix/*` work
- when work is tracked by a GitHub issue, keep that work in a dedicated issue-owned branch and PR
- prefer branch names that keep the issue association obvious, for example `feature/issue-13-pci-passthrough`
- use `Refs #<issue>` while the work is still in `dev` or under review so the issue stays open during integration
- close the issue when the change is actually promoted to `main`, either manually or through the `main` promotion PR if you intentionally want GitHub to auto-close it at that point
- summarize operator-visible behavior changes clearly
- call out any high-risk shell, file, or mutation-path changes explicitly
