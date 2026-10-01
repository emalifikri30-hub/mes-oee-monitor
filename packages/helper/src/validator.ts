import * as z from "zod";
import { zValidator } from "@hono/zod-validator";

import type { ZodType } from "zod";

import { WebResponse } from "@molca/network";

type FlattenedErrors = {
  formErrors: string[];
  fieldErrors: Record<string, string[] | undefined>;
};

type BadRequestPayload = {
  message: string;
  fields: FlattenedErrors;
};

const MAX_PAGE_SIZE = 100;

function jsonValidator<T extends ZodType>(schema: T) {
  return zValidator("json", schema, (result, c) => {
    if (!result.success) {
      return c.json(
        WebResponse.builder<BadRequestPayload>()
          .error("invalid request")
          .data(buildBadRequestPayload(result.error))
          .build(),
        400,
      );
    }
  });
}

function queryValidator<T extends ZodType>(schema: T) {
  return zValidator("query", schema, (result, c) => {
    if (!result.success) {
      return c.json(
        WebResponse.builder<BadRequestPayload>()
          .error("invalid request")
          .data(buildBadRequestPayload(result.error))
          .build(),
        400,
      );
    }
  });
}

function buildBadRequestPayload(error: unknown): BadRequestPayload {
  const flat = z.flattenError(error as z.core.$ZodError) as FlattenedErrors;
  return {
    message: "invalid request",
    fields: flat,
  };
}

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(10),
});

const validatorPaginationReq = queryValidator(paginationSchema);

type PaginationQuery = z.infer<typeof paginationSchema>;

export { validatorPaginationReq, MAX_PAGE_SIZE, paginationSchema, queryValidator, jsonValidator };
export type { FlattenedErrors, BadRequestPayload, PaginationQuery };
