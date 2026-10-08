# Security

Please report vulnerabilities privately through this repository's GitHub **Security → Advisories → Report a vulnerability** form. Include the affected revision, reproduction steps using synthetic data, likely impact and any suggested fix. Keep credentials and personal records out of the report. Do not publish exploit details in an issue or pull request.

The repository owner must enable GitHub private vulnerability reporting before public launch. There is no promised response time yet; this is an early 0.1 release maintained by one person.

Meridian is intended for loopback or a trusted private tailnet. Its server includes file, process, agent and personal-data authority. This release makes no claim that internet exposure, a public reverse proxy or Tailscale Funnel is safe. The optional tester service has a separate synthetic-data and consent boundary; it must never proxy an owner's daemon.

Use temporary profiles and fixture services for security checks. [The security model](docs/open-source/security.md) describes the current trust boundary and remaining auth work.
