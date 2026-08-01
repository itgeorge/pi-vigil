export function getVigilSessionDir(): string | undefined {
  const value = process.env.PI_VIGIL_SESSION_DIR?.trim();
  return value ? value : undefined;
}
