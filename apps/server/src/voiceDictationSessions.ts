// FILE: voiceDictationSessions.ts
// Purpose: Tracks live dictation sessions so audio and finish RPCs reach the stream that owns them.
// Layer: Server transport utility
// Exports: VoiceDictationSessionRegistry, voiceDictationSessions

import { randomUUID } from "node:crypto";

import { SERVER_VOICE_DICTATION_MAX_CHUNK_BYTES } from "@synara/contracts";

import type { VoiceDictationSession } from "./provider/Services/ProviderAdapter.ts";

const MAX_CONCURRENT_DICTATION_SESSIONS = 4;
export const VOICE_DICTATION_CAPACITY_ERROR_MESSAGE =
  "Too many live dictation sessions are already open. Try again shortly.";
export const VOICE_DICTATION_SESSION_GONE_MESSAGE = "The dictation session is no longer active.";

export class VoiceDictationSessionRegistry {
  private readonly sessions = new Map<string, VoiceDictationSession>();

  constructor(private readonly maxSessions: number) {
    if (!Number.isSafeInteger(maxSessions) || maxSessions < 1) {
      throw new Error("Live dictation concurrency must be a positive integer.");
    }
  }

  hasCapacity(): boolean {
    return this.sessions.size < this.maxSessions;
  }

  // Ids are random and only travel to the client that opened the stream, so an
  // id is enough to address a session on the same authenticated server.
  register(session: VoiceDictationSession): string {
    if (!this.hasCapacity()) {
      throw new Error(VOICE_DICTATION_CAPACITY_ERROR_MESSAGE);
    }
    const sessionId = randomUUID();
    this.sessions.set(sessionId, session);
    return sessionId;
  }

  release(sessionId: string): void {
    this.sessions.get(sessionId)?.close();
    this.sessions.delete(sessionId);
  }

  appendAudio(sessionId: string, audioBase64: string): void {
    const session = this.require(sessionId);
    session.appendAudio(decodePcm16Chunk(audioBase64));
  }

  finish(sessionId: string): void {
    this.require(sessionId).finish();
  }

  private require(sessionId: string): VoiceDictationSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(VOICE_DICTATION_SESSION_GONE_MESSAGE);
    }
    return session;
  }
}

function decodePcm16Chunk(audioBase64: string): Uint8Array {
  if (audioBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(audioBase64)) {
    throw new Error("The dictation audio chunk could not be decoded.");
  }
  const bytes = Buffer.from(audioBase64, "base64");
  if (bytes.byteLength % 2 !== 0) {
    throw new Error("Dictation audio must be 16-bit PCM.");
  }
  if (bytes.byteLength > SERVER_VOICE_DICTATION_MAX_CHUNK_BYTES) {
    throw new Error("The dictation audio chunk is too large.");
  }
  return bytes;
}

export const voiceDictationSessions = new VoiceDictationSessionRegistry(
  MAX_CONCURRENT_DICTATION_SESSIONS,
);
