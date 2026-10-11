# Coordination verification receipt

The historical receipt previously stored here is superseded by the
[public handoff checklist](https://github.com/nucleoid/continuum/issues/16).
Its earlier test counts and review verdicts do not approve the current candidate.

The handoff requires regression-first repairs, bounded local PostgreSQL tests,
fresh-install and upgrade coverage, build and installed-package checks, and
independent review of the exact final commit. Both Linux and Windows CI must
pass for that commit before [PR 15](https://github.com/nucleoid/continuum/pull/15)
can merge. Master verification follows the merge.

Current operational behavior and recovery commands are documented in
[coordination](coordination.md) and [offboarding](offboarding.md). Deployment,
production migrations and package publication require separate authorization.
