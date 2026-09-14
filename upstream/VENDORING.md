# Internalized upstream source policy

This directory contains complete upstream implementation snapshots used by
Noema. They are repository source, not `package.el` or VC-package runtime
dependencies.

See [`../UPSTREAMS.md`](../UPSTREAMS.md) for repositories, revisions and roles.

Policy:

- retain source, tests, documentation, prompts, static assets and licenses;
- exclude only upstream Git metadata and generated build/cache artifacts;
- keep upstream feature and symbol names intact;
- load the trees deterministically through `lisp/noema-upstream.el`;
- put Noema-owned product commands and domain adapters in `../lisp/`;
- do not replace these mature implementations with partial rewrites;
- do not let an upstream buffer/session/domain object replace Noema's
  Project, WorkNode, DAG, Run or Artifact model;
- audit source and license changes before updating a snapshot.

The complete trees are retained now because the eventual useful subset is not
yet known. Any later pruning requires evidence from real Noema workflows and
tests.

