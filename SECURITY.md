# Security Policy

## Reporting Vulnerabilities

Report security issues privately to the project owner or through GitHub security
advisories when available. Do not publish browser profile data, cookies, local
paths, screenshots containing secrets, or working exploit details in public
issues.

Include:

- Affected version.
- Chrome, CDP port, and operating system details.
- Steps to reproduce.
- Expected impact.
- Whether browser profile data, cookies, filesystem access, or command
  execution is involved.

## Operational Safety

Treat PBC browser profiles as sensitive. They may contain login state, cookies,
password manager access, and private browsing data.

Never commit browser profiles, traces containing secrets, screenshots with
private account data, or machine-specific config files.
