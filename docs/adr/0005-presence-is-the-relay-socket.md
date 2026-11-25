---
status: superseded by ADR-0010
---

# Presence is the relay control socket; the relay dial is mandatory and singular

Historical decision. [ADR 0010](0010-attempt-based-reachability.md) supersedes its presence rule; [ADR 0016](0016-managed-cloudflare-remote.md) retires the mandatory relay dial and replaces its revocation channel.

A host is online iff its relay control socket is currently connected. Every registered host holds a supervisor-kept relay dial — there is no relay opt-out, and no heartbeat-based presence (heartbeats lag and duplicate what the socket proves). `lastSeenAt` is historical metadata only.

The relay is also not modeled as an endpoint on the host record: there is one relay per deployment, and relay reachability is derived from presence. This rejects regional/multiple relays for now; introducing them later means adding relay-selection state, which we deferred deliberately.
