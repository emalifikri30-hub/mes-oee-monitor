import { HTTPException } from "hono/http-exception";

function mapDomainError(err: unknown): HTTPException | null {
  if (err instanceof HTTPException) return err;

  return null;
}

export { mapDomainError };
