import { describe, expect, it } from "vite-plus/test";

import { slugifyCode } from "@/lib/slug";

// The code an operator never types, derived from the action name they do.
//
// THE STAKE IS CROSS-REPO. mes-master-data slugifies the same way when its own
// Downtime Action form pre-fills Code from Action
// (`apps/web/src/lib/downtime-action-schema.ts` there, which has a matching
// suite). If the two disagree, the same action name yields two different codes
// and whichever app creates it second gets a 409 on the unique (code, region)
// key — reported as a duplicate over a name the operator can plainly see is not
// in the list. These cases ARE that contract; they are duplicated deliberately,
// because there is no schema package between the repos to share.
describe("slugifyCode", () => {
  it("lowercases and joins words with a single underscore", () => {
    expect(slugifyCode("Replace Belt")).toBe("replace_belt");
  });

  it("collapses a run of separators rather than repeating underscores", () => {
    expect(slugifyCode("Belt  /  Chain")).toBe("belt_chain");
  });

  it("trims leading and trailing separators", () => {
    expect(slugifyCode("  (Reset)  ")).toBe("reset");
  });

  it("keeps digits, which appear in real action names", () => {
    expect(slugifyCode("Reset PLC 3")).toBe("reset_plc_3");
  });

  // core-api's createDowntimeActionSchema floors `code` at 3 characters, so this
  // is rejected as a 400 the dialog renders rather than silently creating a row
  // with an empty code. Pinned so nobody "fixes" it into a generated placeholder,
  // which would put an unreadable code in a catalogue people curate by hand.
  it("yields an empty string when there is nothing to slug", () => {
    expect(slugifyCode("!!!")).toBe("");
    expect(slugifyCode("   ")).toBe("");
  });

  // The picker trims before calling this, but a name arriving padded must not
  // produce a leading underscore — that would be a different code for the same
  // action, which is exactly the 409 the cross-repo agreement above exists to
  // avoid.
  it("is unaffected by surrounding whitespace", () => {
    expect(slugifyCode("  Replace Belt  ")).toBe(slugifyCode("Replace Belt"));
  });
});
