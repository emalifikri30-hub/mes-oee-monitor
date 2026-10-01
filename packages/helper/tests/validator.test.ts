import { describe, it, expect } from "vite-plus/test";
import { Hono } from "hono";
import * as z from "zod";

import {
  jsonValidator,
  MAX_PAGE_SIZE,
  paginationSchema,
  queryValidator,
} from "../src/validator.js";

type ErrBody = {
  error: string;
  data: { message: string; fields: { fieldErrors: Record<string, unknown> } };
};

describe("paginationSchema", () => {
  it("applies defaults when nothing is supplied", () => {
    expect(paginationSchema.parse({})).toEqual({ page: 1, size: 10 });
  });

  it("coerces string query values to integers", () => {
    expect(paginationSchema.parse({ page: "3", size: "25" })).toEqual({ page: 3, size: 25 });
  });

  it("rejects page below 1", () => {
    expect(paginationSchema.safeParse({ page: "0" }).success).toBe(false);
  });

  it("rejects size above MAX_PAGE_SIZE", () => {
    expect(paginationSchema.safeParse({ size: String(MAX_PAGE_SIZE + 1) }).success).toBe(false);
  });
});

describe("queryValidator", () => {
  const app = new Hono();
  app.get("/", queryValidator(paginationSchema), (c) => c.json(c.req.valid("query")));

  it("passes valid query through to the handler", async () => {
    const res = await app.request("/?page=2&size=5");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ page: 2, size: 5 });
  });

  it("returns a 400 BadRequest payload for an out-of-range value", async () => {
    const res = await app.request("/?size=999");
    expect(res.status).toBe(400);

    const body = (await res.json()) as ErrBody;
    expect(body.error).toBe("invalid request");
    expect(body.data.message).toBe("invalid request");
    expect(body.data.fields.fieldErrors.size).toBeDefined();
  });
});

describe("jsonValidator", () => {
  const schema = z.object({ content: z.string().min(1) });
  const app = new Hono();
  app.post("/", jsonValidator(schema), (c) => c.json(c.req.valid("json")));

  it("passes a valid JSON body to the handler", async () => {
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "hello" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ content: "hello" });
  });

  it("returns a 400 BadRequest payload when the body fails validation", async () => {
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "" }),
    });
    expect(res.status).toBe(400);

    const body = (await res.json()) as ErrBody;
    expect(body.error).toBe("invalid request");
    expect(body.data.fields.fieldErrors.content).toBeDefined();
  });
});
