import type { ProviderKind, ThreadId } from "@synara/contracts";
import { ServiceMap } from "effect";
import type {
  AgentGatewaySessionIdentity,
  AgentGatewayWriteAuthority,
} from "./AgentGatewaySessionRegistry.ts";
import type {
  AgentGatewayCancellation,
  AgentGatewayInFlightRequestRegistration,
  AgentGatewayInFlightRequestSelector,
} from "../inFlightRequestRegistry.ts";

export interface AgentGatewayMcpConnection {
  readonly url: string;
  readonly bearerToken: string;
}

export interface AgentGatewayStdioProxySpawn {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

export interface AgentGatewayCredentialsShape {
  readonly mcpEndpointUrl: string;
  readonly setListeningPort: (port: number) => void;
  readonly issueSessionToken: (threadId: ThreadId, provider: ProviderKind) => string;
  readonly verifySessionToken: (token: string) => string | null;
  readonly verifySession: (token: string) => AgentGatewaySessionIdentity | null;
  /** one-shot credential a stdio proxy exchanges for the session bearer without exposing it to the provider process */
  readonly issueStdioBootstrapToken: (sessionToken: string) => string | null;
  /** consume a stdio bootstrap credential exactly once */
  readonly exchangeStdioBootstrapToken: (bootstrapToken: string) => string | null;
  /** pin one request/batch to the exact running turn observed at ingress */
  readonly bindWriteAuthority: (token: string, turnId: string) => AgentGatewayWriteAuthority | null;
  /** recheck that previously bound authority still belongs to a live session */
  readonly verifyWriteAuthority: (authority: AgentGatewayWriteAuthority) => boolean;
  readonly registerInFlightRequest: (
    registration: AgentGatewayInFlightRequestRegistration,
  ) => () => void;
  readonly cancelInFlightRequests: (
    selector: AgentGatewayInFlightRequestSelector,
  ) => AgentGatewayCancellation;
  readonly cancelSessionTurnRequests: (token: string, turnId: string) => Promise<void>;
  /** tombstone one terminal turn so this bearer can never gain write authority for a later turn — retirement is synchronous; the promise is only drainage */
  readonly retireSessionTurn: (token: string, turnId: string) => Promise<void>;
  readonly revokeSessionToken: (token: string) => void;
  readonly connectionForThread: (
    threadId: ThreadId,
    provider: ProviderKind,
  ) => AgentGatewayMcpConnection;
  readonly stdioProxy: AgentGatewayStdioProxySpawn;
}

export class AgentGatewayCredentials extends ServiceMap.Service<
  AgentGatewayCredentials,
  AgentGatewayCredentialsShape
>()("synara/agentGateway/Services/AgentGatewayCredentials") {}
