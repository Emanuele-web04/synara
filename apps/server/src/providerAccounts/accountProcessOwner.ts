/** An inaccessible process may still own an account operation; only ESRCH proves it is gone. */
export function accountOwnerIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
