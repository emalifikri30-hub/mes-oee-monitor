function serializeError(err: unknown): { name?: string; message: string } | string {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return String(err);
}

export { serializeError };
