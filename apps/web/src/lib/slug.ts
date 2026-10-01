// Derives a master-data code from a name an operator typed.
//
// USED FOR ONE THING: creating a downtime action from the edit dialog. The
// operator types "Replace Belt", presses Enter, and the action is created with
// code `replace_belt` — they are recording what they did, not filling in a
// master-data form, so the code has to come from somewhere and there is nothing
// else to derive it from.
//
// THE SAME SHAPE mes-master-data's own form uses when it pre-fills the Code
// field from the Action field (`apps/web/src/lib/downtime-action-schema.ts`
// there). The two are separate implementations because there is no schema
// package between the repos — the same reason ui/tag-input.ts duplicates the
// server's list rules. If this changes, change that one in the same breath: the
// same action name producing two different codes means whichever app goes second
// gets a 409 on the unique (code, region) key, with a message about a duplicate
// the operator cannot act on.
//
// NOT REVERSIBLE, and nothing tries to reverse it: the code is upstream's key,
// the NAME is what gets written onto the downtime.
function slugifyCode(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      // Any run of non-alphanumerics collapses to ONE underscore, so "Belt  /
      // Chain" is `belt_chain` rather than `belt___chain`.
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
  );
}

export { slugifyCode };
