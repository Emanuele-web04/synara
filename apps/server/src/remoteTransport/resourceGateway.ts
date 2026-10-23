import type { RemoteIngressContext } from "./tunnel";
import type http from "node:http";
import { randomUUID } from "node:crypto";
import { Duration, Effect } from "effect";
import {
  decodeRemoteResourceReference,
  remoteResourcePresentationUrl,
  remoteResourceRoute,
  REMOTE_RESOURCE_PATH,
} from "@synara/shared/remoteResources";
import { JwtReplayCache, verifySessionCredential } from "../hostAuth";
import type { RemoteConnectionGatewayOptions } from "../remoteSessions/gateway";
import type { SessionCredentialServiceShape } from "../auth/Services/SessionCredentialService";
import { bindRemoteAttachmentSession } from "../managedAttachmentPrincipal";
import { proxyResourceRequest, resourceRequestHeaders } from "./resourceProxy";

export function createRemoteResourceGateway(
  options: Pick<
    RemoteConnectionGatewayOptions,
    "identity" | "environmentId" | "keyGeneration" | "authorizeDevice" | "sessions"
  > & {
    readonly rootFingerprint: string;
    readonly listeningPort: number;
    readonly localSessions: SessionCredentialServiceShape;
  },
): (
  request: http.IncomingMessage,
  response: http.ServerResponse,
  ingress?: RemoteIngressContext,
) => void {
  const replays = new JwtReplayCache();
  return (request, response, ingress) => {
    void (async () => {
      let release: (() => void) | undefined;
      let expired: NodeJS.Timeout | undefined;
      let unbind: (() => void) | undefined;
      let lease: Awaited<ReturnType<typeof issue>> | undefined;
      let closed = false;
      const cleanup = () => {
        if (closed) return;
        closed = true;
        release?.();
        unbind?.();
        clearTimeout(expired);
        if (lease)
          void Effect.runPromise(options.localSessions.revoke(lease.sessionId)).catch(() => {});
      };
      const issue = (ttl: number, userId: string) =>
        Effect.runPromise(
          options.localSessions.issue({
            ttl: Duration.millis(ttl),
            subject: userId,
            role: "client",
            method: "bearer-session-token",
            client: { label: "Synara remote resource", deviceType: "unknown" },
          }),
        );
      response.once("close", cleanup);
      try {
        const url = new URL(request.url ?? "", "http://remote.invalid");
        if (
          url.pathname !== REMOTE_RESOURCE_PATH ||
          [...url.searchParams.keys()].some((key) => key !== "reference") ||
          url.searchParams.getAll("reference").length !== 1
        )
          throw new Error("Invalid resource endpoint");
        const encoded = url.searchParams.get("reference")!;
        const reference = decodeRemoteResourceReference(encoded);
        if (reference.environmentId !== options.environmentId)
          throw new Error("Wrong resource environment");
        const route = remoteResourceRoute(reference.resource);
        if (request.method !== route.method) throw new Error("Wrong resource method");
        const headers = resourceRequestHeaders(request.headers, route.maxBodyBytes);
        const authorization = request.headers.authorization;
        const dpop = request.headers.dpop;
        if (!authorization?.startsWith("DPoP ") || typeof dpop !== "string")
          throw new Error("Missing resource authorization");
        const peer = await verifySessionCredential({
          credential: authorization.slice(5),
          dpop,
          identity: options.identity,
          environmentId: options.environmentId,
          keyGeneration: options.keyGeneration,
          expectedHtu: remoteResourcePresentationUrl(options.environmentId, encoded),
          expectedHtm: route.method,
          replayCache: replays,
        });
        await options.authorizeDevice(peer.userId, peer.deviceJkt, peer.trustGeneration);
        if (closed) return;
        release = options.sessions.add({
          id: randomUUID(),
          ...peer,
          startedAt: new Date().toISOString(),
          via: ingress?.via ?? "direct",
          close: () => {
            response.destroy();
            request.destroy();
            cleanup();
          },
        });
        await options.authorizeDevice(peer.userId, peer.deviceJkt, peer.trustGeneration);
        if (closed) return;
        const ttl = Math.max(1, peer.expiresAtSeconds * 1000 - Date.now());
        expired = setTimeout(() => {
          response.destroy();
          request.destroy();
          cleanup();
        }, ttl);
        expired.unref();
        lease = await issue(ttl, peer.userId);
        // A revoke during the asynchronous lease write must not leak that lease.
        if (closed) {
          await Effect.runPromise(options.localSessions.revoke(lease.sessionId));
          return;
        }
        unbind = bindRemoteAttachmentSession(lease.sessionId, {
          ...peer,
          environmentId: options.environmentId,
          rootFingerprint: options.rootFingerprint,
        });
        proxyResourceRequest({
          request,
          response,
          maxBodyBytes: route.maxBodyBytes,
          target: {
            hostname: "127.0.0.1",
            port: options.listeningPort,
            path: route.path,
            method: route.method,
            headers: {
              ...headers,
              authorization: `Bearer ${lease.token}`,
              origin: `http://127.0.0.1:${options.listeningPort}`,
            },
          },
          onDone: cleanup,
        });
      } catch {
        cleanup();
        if (!response.headersSent && !response.destroyed)
          response
            .writeHead(403, { "Cache-Control": "no-store" })
            .end("Remote resource request refused");
        else response.destroy();
      }
    })();
  };
}
