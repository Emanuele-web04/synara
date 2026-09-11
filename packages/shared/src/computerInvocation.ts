/** User-authored invocation only; never inspect attachments, tool output or past turns. */
export function isComputerInvocation(input: {
  text?: string | undefined;
  skills?: readonly { name: string }[] | undefined;
}): boolean {
  if (input.skills?.some(({ name }) => /^(?:synara-)?computer-use$/i.test(name))) return true;
  // Appended excerpts can contain imperative text. Only the opening user
  // instruction, or an explicitly selected skill, can activate a capability.
  const request =
    (input.text ?? "")
      .split("\n")
      .find((line) => line.trim().length > 0)
      ?.trim() ?? "";
  if (/^[>"“`~<]/.test(request)) return false;
  if (/^(?:\/|\$)(?:synara-)?computer-use(?:\s|$)/i.test(request)) return true;
  return /^(?:(?:please|can you|could you|i want you to|per favore|puoi)\s+)?(?:use|using|invoke|start|usa|utilizza|attiva)\s+(?:(?:the|il|native|nativo|synara)\s+)*computer[ -]use\b/i.test(
    request,
  );
}
