// Canonical runtime guard for unknown boundary values (engine IPC,
// archived JSON, AI output). Import this; never redefine it per file.
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
