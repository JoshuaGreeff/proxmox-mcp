# Security Policy

If you find a vulnerability in `proxmox-mcp`, do not open a public issue with exploit details, proof-of-concept payloads, or live credentials.

## Reporting

Report vulnerabilities privately through [GitHub Security Advisories for this repository](https://github.com/JoshuaGreeff/proxmox-mcp/security/advisories/new).

If that path is unavailable, contact the maintainer directly through GitHub and include:

- affected version or commit
- impact summary
- reproduction steps
- any required configuration details with secrets redacted
- whether the issue affects only local maintainer mode, remote HTTP mode, or both

## Response Targets

- initial acknowledgement within 7 days
- follow-up status update within 14 days after acknowledgement when the issue is reproducible
- coordinated disclosure after a fix or mitigation is available, unless a longer embargo is clearly necessary

## Handling Expectations

- redact secrets, tokens, API keys, private keys, and internal host details from all reports
- avoid public discussion until the issue is triaged and disclosure timing is agreed
- use least privilege when validating a report against disposable lab infrastructure and clean up temporary resources afterward

## Supported Versions

This project is currently `Beta`. Security fixes are targeted at the latest commit on `main` first. Older commits and unpublished intermediate branch states should not be assumed to receive backported fixes.

Please avoid testing against systems you do not own or operate.
