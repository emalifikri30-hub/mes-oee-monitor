import { traced } from "./postgres.js";

import type { GoldDB } from "./postgres.js";

// How far the pipeline has loaded one Gold table, as a plant-local business day —
// or null when it has never stamped it.
//
// WHAT IT IS FOR, because a one-line read does not obviously deserve its own file.
// This value is the only thing that separates two empty payloads which look
// identical on screen and mean opposite things:
//
//   loaded      ->  the machine genuinely produced nothing / stopped for nothing
//   not loaded  ->  the rows have not arrived, and the card is about to lie
//
// The flattering reading is the wrong one, and TODOS.md §8 and §14 are both items
// filed after a card shipped making it. Every surface that can be empty for either
// reason reads one of these.
//
// EXTRACTED when the LINE report's Losses page and SKU View became the fifth and
// sixth callers of a query that was already written four times in
// work-unit-repository.ts, identical except for the table name. That is this
// directory's rule — a thing moves here once a second caller appears — and the
// duplication was the kind that fails quietly: a copy that named the wrong table
// would report a watermark for a table nobody asked about, and every empty card
// would then claim the pipeline had caught up.
//
// `table` IS NOT A FRAGMENT and must not become one. It is bound as a parameter,
// so no caller can name a column or a subquery here.
async function getWatermark(db: GoldDB, table: string): Promise<string | null> {
  return await traced("SELECT", "oee.etl_watermarks", async () => {
    const rows = await db<{ lastBusinessDate: string | null }[]>`
      SELECT to_char(last_business_date, 'YYYY-MM-DD') AS last_business_date
      FROM oee.etl_watermarks
      WHERE table_name = ${table}
      LIMIT 1
    `;

    // Two different nulls collapse deliberately: no row at all (the pipeline has
    // never run for this table) and a row whose last_business_date is null. Both
    // mean "cannot vouch for any day", which is the only thing a caller does with
    // this value.
    return rows[0]?.lastBusinessDate ?? null;
  });
}

export { getWatermark };
