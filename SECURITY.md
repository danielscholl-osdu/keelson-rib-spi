# Security Policy

## Supported versions

Security fixes land on the latest release only.

| Version         | Supported          |
|-----------------|--------------------|
| Latest release  | :white_check_mark: |
| Any older       | :x:                |

## Reporting a vulnerability

**Please do not file public GitHub issues for security reports.** Report
privately through either channel:

- GitHub private vulnerability report:
  <https://github.com/danielscholl-osdu/keelson-rib-spi/security/advisories/new>
- Email **degnome@gmail.com** with the subject line `[rib-spi security]`

Include what you observed and its impact, the rib version, `keelson version`,
`gh --version`, `glab --version`, your OS, and the smallest reproduction you
have. Leave out tokens, personal logins and emails.

New reports are acknowledged within **3 business days**, with a fix or
mitigation plan within **14 days** of acknowledgement, sooner when there is a
public proof of concept.

## Threat model

The rib runs inside the Keelson server with the operator's privileges. It
borrows the operator's `gh` and `glab` sign-ins per call and stores no token.
It reads GitHub and GitLab, and writes to GitHub only through verbs in the
side inspector (approve waiting workflow runs, rerun lanes, dispatch Sync
Template or a stack refresh or upgrade, merge template-sync PRs). The model assumes the operator trusts their own
machine, the harness and the ribs they install. Hostile input may arrive from
anything an outside contributor or upstream can write: PR titles and bodies,
branch names, commit messages, issue text, workflow logs and annotations, and
files read at a sha.

### In scope

- A write that does not go through `act()`: a collector, tool or composer that
  mutates, or any write to GitLab or the cluster.
- A verb that acts on a target other than the one its binding names, or that
  proceeds after the target changed since the inspector drew it, for example
  approving runs after a new push to an outside PR.
- An action from the sandboxed console frame other than `inspect` being
  honored.
- A token or `auth status` output reaching a log, the data directory, a board,
  a tool result or an error message.
- Injection through forge data: a title, branch, log line or file that reaches
  console html unescaped, an exec argument, a request path or a filesystem
  path.

### Out of scope

- The Keelson harness itself; report those at
  <https://github.com/danielscholl/keelson>.
- Behavior under a hostile rib, or with an attacker who already has local code
  execution or the operator's `gh` or `glab` session.
- Repository names, logins and PR content shown in boards and kept in the
  rib's data directory. That is by design for a single-operator local
  workbench reading public repositories.
- GitHub, GitLab, `gh` or `glab` defects; report those upstream.

## Disclosure

Once a fix is released, a GitHub security advisory is published crediting the
reporter (unless they prefer otherwise), with a CVE where warranted.
