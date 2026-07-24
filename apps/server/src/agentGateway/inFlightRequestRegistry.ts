export type AgentGatewayJsonRpcRequestId = string | number | null;

export interface AgentGatewayInFlightRequestRegistration {
  readonly sessionKey: string;
  readonly turnId: string | null;
  readonly requestId: AgentGatewayJsonRpcRequestId;
  readonly cancel: () => Promise<void>;
}

export interface AgentGatewayInFlightRequestSelector {
  readonly sessionKey: string;
  readonly turnId?: string;
  readonly requestId?: AgentGatewayJsonRpcRequestId;
}

export interface AgentGatewayInFlightRequestRegistry {
  readonly register: (registration: AgentGatewayInFlightRequestRegistration) => () => void;
  readonly cancel: (selector: AgentGatewayInFlightRequestSelector) => AgentGatewayCancellation;
  readonly cancelTurn: (sessionKey: string, turnId: string) => AgentGatewayCancellation;
  readonly revokeSession: (sessionKey: string) => AgentGatewayCancellation;
}

export interface AgentGatewayCancellation {
  readonly count: number;
  readonly settled: Promise<void>;
}

interface RegisteredRequest extends AgentGatewayInFlightRequestRegistration {
  readonly token: symbol;
}

/**
 * Process-local cancellation ownership for MCP calls.
 *
 * MCP clients are allowed to omit `notifications/cancelled` when their parent
 * operation is interrupted. The provider adapter therefore cancels the turn
 * directly through this registry. Interrupted turn ids are retained for the
 * lifetime of the provider session so a request racing with Stop is cancelled
 * at registration instead of escaping the first cancellation sweep.
 */
export function makeAgentGatewayInFlightRequestRegistry(): AgentGatewayInFlightRequestRegistry {
  const requests = new Map<symbol, RegisteredRequest>();
  const cancelledTurns = new Map<string, Set<string>>();

  const cancel = (selector: AgentGatewayInFlightRequestSelector): AgentGatewayCancellation => {
    const matches = Array.from(requests.values()).filter(
      (request) =>
        request.sessionKey === selector.sessionKey &&
        (selector.turnId === undefined || request.turnId === selector.turnId) &&
        (selector.requestId === undefined || request.requestId === selector.requestId),
    );
    for (const request of matches) requests.delete(request.token);
    const cancellations = matches.map((request) => {
      try {
        return request.cancel();
      } catch {
        // Cancellation is best-effort at this synchronous boundary. Each
        // request still owns its cleanup/finalizers and the caller must never
        // be prevented from interrupting the provider turn itself.
        return Promise.resolve();
      }
    });
    return {
      count: matches.length,
      settled: Promise.allSettled(cancellations).then(() => undefined),
    };
  };

  return {
    register: (registration) => {
      if (
        registration.turnId !== null &&
        cancelledTurns.get(registration.sessionKey)?.has(registration.turnId)
      ) {
        void registration.cancel();
        return () => undefined;
      }
      const token = Symbol("agent-gateway-in-flight-request");
      requests.set(token, { ...registration, token });
      return () => {
        requests.delete(token);
      };
    },
    cancel,
    cancelTurn: (sessionKey, turnId) => {
      let turns = cancelledTurns.get(sessionKey);
      if (!turns) {
        turns = new Set();
        cancelledTurns.set(sessionKey, turns);
      }
      turns.add(turnId);
      return cancel({ sessionKey, turnId });
    },
    revokeSession: (sessionKey) => {
      const cancelled = cancel({ sessionKey });
      cancelledTurns.delete(sessionKey);
      return cancelled;
    },
  };
}
