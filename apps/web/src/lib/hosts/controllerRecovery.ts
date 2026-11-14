import { ExecutionEnvironmentDescriptor } from "@synara/contracts";
import { Schema } from "effect";

const key = "synara:verified-controller:v1";
/**
 * The last descriptor the local backend verified. It never authorizes a
 * connection. It labels the recovery screen, and `bootstrapLocalExecutionEarly`
 * may start from it only while the desktop confirms the same data home.
 */
export function rememberVerifiedController(descriptor: ExecutionEnvironmentDescriptor): void {
  try {
    localStorage.setItem(key, JSON.stringify(descriptor));
  } catch {
    /* A full storage must not block local startup. */
  }
}
export function readVerifiedControllerForRecovery(): ExecutionEnvironmentDescriptor | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor)(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}
