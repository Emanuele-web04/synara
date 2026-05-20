export const HERMES_ACTIVE_PROFILE_DESCRIPTION = "hermes-active-profile";

export function resolveActiveHermesProfileName(
  agents:
    | ReadonlyArray<{
        readonly name: string;
        readonly description?: string | undefined;
        readonly displayName?: string | undefined;
        readonly model?: string | undefined;
      }>
    | null
    | undefined,
): string | null {
  if (!agents || agents.length === 0) {
    return null;
  }
  const active = agents.find((agent) => agent.description === HERMES_ACTIVE_PROFILE_DESCRIPTION);
  return active?.name ?? agents[0]?.name ?? null;
}
