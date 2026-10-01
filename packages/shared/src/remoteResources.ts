import {
  RemoteResourceReference,
  type RemoteResource,
  SERVER_VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@synara/contracts";
import { Schema } from "effect";

export const REMOTE_RESOURCE_PATH = "/v2/resource";
export const REMOTE_RESOURCE_LOCAL_PREFIX = "/api/remote/resource/";
export const MAX_REMOTE_RESOURCE_METADATA_BYTES = 16 * 1024;

/** Only this manifest can select a host route. There is no caller-supplied URL. */
export function remoteResourceRoute(resource: RemoteResource): {
  path: string;
  method: "GET" | "POST";
  maxBodyBytes: number;
} {
  let path: string;
  let params: Record<string, string> = {};
  let maxBodyBytes = 0;
  switch (resource.kind) {
    case "attachment":
      path = `/attachments/${encodeURIComponent(resource.attachmentId)}`;
      break;
    case "attachment-upload":
      path = "/api/attachments/upload";
      params = {
        threadId: resource.threadId,
        type: resource.type,
        name: resource.name,
        mimeType: resource.mimeType,
      };
      maxBodyBytes =
        resource.type === "image"
          ? PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
          : PROVIDER_SEND_TURN_MAX_FILE_BYTES;
      break;
    case "attachment-cancel":
      path = "/api/attachments/cancel";
      maxBodyBytes = 4096;
      break;
    case "workspace-preview":
      path = "/api/local-image";
      params = {
        path: resource.path,
        ...(resource.cwd ? { cwd: resource.cwd } : {}),
        ...(resource.grant ? { grant: resource.grant } : {}),
        ...(resource.revision ? { v: resource.revision } : {}),
        ...(resource.download ? { download: "1" } : {}),
      };
      break;
    case "thread-export":
      path = "/api/thread-export";
      params = { threadId: resource.threadId };
      break;
    case "project-favicon":
      path = "/api/project-favicon";
      params = { cwd: resource.cwd, fallback: "none" };
      break;
    case "site-favicon":
      path = "/api/site-favicon";
      params = { domain: resource.domain };
      break;
    case "editor-icon":
      path = "/api/editor-icon";
      params = { id: resource.editorId };
      break;
    case "voice-upload":
      path = "/api/voice/transcribe";
      params = {
        provider: resource.provider,
        ...(resource.providerInstanceId ? { providerInstanceId: resource.providerInstanceId } : {}),
        cwd: resource.cwd,
        mimeType: resource.mimeType,
        sampleRateHz: String(resource.sampleRateHz),
        durationMs: String(resource.durationMs),
        ...(resource.threadId ? { threadId: resource.threadId } : {}),
      };
      maxBodyBytes = SERVER_VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES;
      break;
  }
  const query = new URLSearchParams(params).toString();
  return {
    path: `${path}${query ? `?${query}` : ""}`,
    method: maxBodyBytes ? "POST" : "GET",
    maxBodyBytes,
  };
}

export function decodeRemoteResourceReference(value: string): RemoteResourceReference {
  if (value.length > MAX_REMOTE_RESOURCE_METADATA_BYTES)
    throw new Error("Resource metadata exceeds limit");
  return Schema.decodeUnknownSync(RemoteResourceReference)(JSON.parse(value));
}

export function remoteResourcePresentationUrl(
  environmentId: string,
  encodedReference: string,
): string {
  return `synara://remote/${encodeURIComponent(environmentId)}${REMOTE_RESOURCE_PATH}/${encodeURIComponent(encodedReference)}`;
}
