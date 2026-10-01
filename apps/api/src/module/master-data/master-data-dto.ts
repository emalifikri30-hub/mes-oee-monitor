import * as z from "zod";

import { jsonValidator, queryValidator } from "@molca/helper";

// `areaId` is REQUIRED, unlike the optional filters on the shift report.
//
// Upstream treats a missing (or `0`) areaId as "no filter" and answers with every
// work center in the region — so an unvalidated param would silently turn a
// scoped lookup into a full catalogue dump. A 400 here is the whole point.
//
// No `paginationSchema`: these lists are option sets fetched whole, not pages.
// See the fetchSummaryList comment in master-data-client.ts.
const listWorkCenterInputSchema = z.object({
  areaId: z.coerce.number().check(z.int(), z.positive()),
});

// `workCenterId` is REQUIRED for the same reason `areaId` is above, and the
// consequence of omitting it is worse here: upstream answers an unscoped
// downtime-reason request with the whole REGION's catalogue, so the operator
// picking a reason for a stop on the filler would be offered the palletiser's.
// A wrong reason is not a cosmetic error — it is the key the Availability Pareto
// groups the stop under.
const listDowntimeReasonInputSchema = z.object({
  workCenterId: z.coerce.number().check(z.int(), z.positive()),
});

// The REJECT reason list, and the products a line runs. Both REQUIRE the scope
// for the reason above, one catalogue over: unscoped, upstream answers with the
// whole region, and the reason on an entry is what the Quality Pareto groups it
// under.
const listByWorkCenterInputSchema = z.object({
  workCenterId: z.coerce.number().check(z.int(), z.positive()),
});

// The create body, matching mes-master-data's `createDowntimeActionSchema`.
//
// VALIDATED HERE RATHER THAN FORWARDED BLIND, so a bad payload is a 400 from
// this service with a message the dialog can render, instead of a 502 wrapping
// somebody else's 400. The floors are upstream's — keep them in step, because a
// looser rule here just moves the rejection one hop further away.
//
// `color` is `#rrggbb`: upstream's column is a varchar(10), so a longer value
// would be TRUNCATED there rather than rejected, and a truncated hex is a
// different colour with nothing to say so.
const createDowntimeActionSchema = z.object({
  code: z.string().check(z.minLength(3), z.maxLength(100)),
  name: z.string().check(z.minLength(3), z.maxLength(100)),
  color: z.string().check(z.regex(/^#[0-9a-fA-F]{6}$/)),
});

const masterDataValidator = {
  listByWorkCenter: queryValidator(listByWorkCenterInputSchema),
  listWorkCenter: queryValidator(listWorkCenterInputSchema),
  listDowntimeReason: queryValidator(listDowntimeReasonInputSchema),
  createDowntimeAction: jsonValidator(createDowntimeActionSchema),
};

type ListWorkCenterQuery = z.infer<typeof listWorkCenterInputSchema>;
type ListDowntimeReasonQuery = z.infer<typeof listDowntimeReasonInputSchema>;
type CreateDowntimeActionBody = z.infer<typeof createDowntimeActionSchema>;

export {
  masterDataValidator,
  listWorkCenterInputSchema,
  listDowntimeReasonInputSchema,
  createDowntimeActionSchema,
};
export type { ListWorkCenterQuery, ListDowntimeReasonQuery, CreateDowntimeActionBody };
