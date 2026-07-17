// The desktop preflight and server recovery guard must agree on the durable marker name.
export function migrationRecoveryMarkerPath(dbPath: string): string {
  return `${dbPath}.migration-recovery.json`;
}

export function migrationBackupDirectory(dbPath: string): string {
  return `${dbPath}.backups`;
}
