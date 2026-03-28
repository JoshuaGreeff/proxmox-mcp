# Branching Workflow

`proxmox-mcp` uses a two-stage branch model:

- `main`
  - production-ready only
  - protected more strictly
  - intended to reflect what is ready to deploy
- `dev`
  - integration and pre-release branch
  - protected more lightly
  - default target for normal development

## Normal Development

For normal changes:

1. branch from `dev`
2. develop in a short-lived `feature/*` branch
3. open a PR into `dev`
4. let CI pass on `dev`
5. merge into `dev`
6. promote `dev` to `main` only when the integrated state is fully tested and ready for production

The intent is to keep `main` stable while still giving maintainers a shared integration branch for in-flight work.

## Release Promotion

Promote to production by opening a PR from `dev` into `main`.

That promotion should happen only after:

- `npm run check`
- `npm run test`
- `npm run build`
- any required disposable live validation for the release candidate
- doc updates are included for workflow or surface-area changes

`main` should not be the day-to-day development branch.

## Hotfixes

If an urgent production fix is required:

1. branch from `main` into `hotfix/*`
2. merge the hotfix into `main`
3. back-merge the same fix into `dev` immediately

This avoids long-lived drift between production and integration.

## Protection Model

GitHub branch protection is intentionally asymmetric:

- `main`
  - requires CI and CodeQL
  - requires the branch to be up to date
  - requires conversation resolution
  - blocks force-push and deletion
- `dev`
  - requires CI
  - requires the branch to be up to date
  - blocks force-push and deletion
  - does not require CodeQL or conversation resolution

Admin enforcement is left off so the repository owner can still bypass protections when necessary. That bypass is for emergencies, not the default workflow.
