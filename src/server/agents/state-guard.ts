// Agent state is server-authoritative.
//
// The agents SDK lets any connected WebSocket client replace an Agent's whole
// state by sending a `cf_agent_state` message, unless the Agent rejects it in
// `validateStateChange`. Publicly routable agents must therefore refuse every
// state change that didn't originate on the server; clients change state only
// through @callable methods, which do their own authorization.

/** Throw unless the state change came from server code (`source === 'server'`). */
export function rejectClientStateWrites(source: unknown): void {
  if (source !== 'server') throw new Error('Agent state is read-only for clients');
}
