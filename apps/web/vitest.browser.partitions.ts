// Keep the same two ChatView runners. Seven measured interaction cases add
// 30–32s to the shorter follow lane instead of extending the workflow tail.
// Complementary patterns assign every future stable case exactly once.
const followPattern = [
  "restores streaming follow",
  "refreshes the full conversation when an approval was already answered",
  "keeps near-cap composer work bounded while live activities arrive",
  "preserves three answers",
  "remembers Local and New worktree choices",
  "runs the setup action from the newly-created worktree",
].join("|");

export function chatPatterns(stablePattern: RegExp): { follow: RegExp; workflows: RegExp } {
  return {
    follow: new RegExp(`${stablePattern.source}(?=.*(?:${followPattern}))`),
    workflows: new RegExp(`${stablePattern.source}(?!.*(?:${followPattern}))`),
  };
}
