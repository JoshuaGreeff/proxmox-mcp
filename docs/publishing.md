# Publishing

`proxmox-mcp` publishes from GitHub Actions through `.github/workflows/release.yml`.

## First Publish

The first publish can use the repo `NPM_TOKEN` secret because the package does not exist on npm yet.

Release flow:

1. make sure `main` is the release-ready branch
2. run:

```bash
npm run check
npm run test
npm run test:fuzz
npm run build
npm run pack:check
```

3. create and push a release tag like `v0.1.0`
4. let the `Release` workflow publish the package to npm

## Trusted Publishing Steady State

After the package exists on npm, switch away from the long-lived token and use npm trusted publishing.

Use the npm package settings to add a trusted publisher with:

- provider: `GitHub Actions`
- owner or user: `JoshuaGreeff`
- repository: `proxmox-mcp`
- workflow filename: `release.yml`

The workflow already has the required `id-token: write` permission.

After the trusted publisher is configured and verified:

1. remove the `NPM_TOKEN` GitHub secret from this repo
2. in npm package settings, restrict publishing access to trusted publishing and disallow token publishing
3. revoke any no-longer-needed npm publish token

This repo is now expected to stay in that trusted-publishing state for future releases.

## Package Contents

The npm package intentionally ships only:

- built runtime files under `dist/`
- the vendored Proxmox API schema file required at runtime
- top-level package metadata and policy files

It should not publish source, tests, GitHub workflow files, or the full vendored upstream docs tree.
