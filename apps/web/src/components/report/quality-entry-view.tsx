import { useEffect, useMemo, useState } from "react";
import { isAxiosError } from "axios";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatQuantity } from "@/lib/format";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useLineProductOptions, useProductDetail, useRejectReasonOptions } from "@/lib/queries";

import type { UseMutationResult } from "@tanstack/react-query";
import type { QualityEntry, QualityEntryDraft, QualityEntryKind } from "@/lib/types";

// Recording reject or rework by hand. THE FORM ONLY — it knows nothing about which
// report it is serving.
//
// ---------------------------------------------------------------------------
// IT TAKES DATA, NEVER A REPORT AND NEVER A `subject` FLAG
// ---------------------------------------------------------------------------
//
// THE ACCEPTANCE TEST FOR THIS FILE IS ITS IMPORT LIST: if `LineReportDetail` or
// `SkuReportDetail` appears in it, the separation has been undone. A
// `report: LineReportDetail | SkuReportDetail` prop would be a subject flag
// wearing a union's clothes — every read inside becomes
// `report.subject === "sku" ? … : …`, and worse, WHICH MACHINES ENDPOINT ANSWERS
// would move in here, which is exactly what line-report-actions.tsx forbids ("the
// wiring stays explicit and testable") and what activity-log-view.tsx was
// extracted to avoid. Seven report tables with seven independent id sequences: a
// shared component that picks its own query is how one subject's screen comes to
// write against another's report.
//
// Two thin callers name their own queries and their own mutation:
// line-quality-entry-dialog.tsx and sku-quality-entry-dialog.tsx.
//
// THE MUTATION ARRIVES AS A RESULT, not as an address — confirm-write-dialog.tsx's
// rule, "takes the MUTATION RESULT, so which write it performs stays at the call
// site where a test can assert it." This view therefore calls no useMutation and
// holds no address at all.
//
// `fixedShift` AND `datePicker` RATHER THAN A GRAIN, because grain is not what
// those fields are about: "is the shift already known" and "does this report span
// more than one business day" are. Passing a grain would re-open the half-right
// (grain, id) shape ReportAddress exists to close.
//
// THE DESCRIPTION COPY NEEDS NO PROP. "Record reject the line's count points did
// not see" is true on both screens — a SKU ran on a line, and the count point that
// missed them is the line's. Do not add a `subjectNoun`.
//
// ---------------------------------------------------------------------------
// THE FIELD ORDER IS LOAD-BEARING: SKU BEFORE UNIT
// ---------------------------------------------------------------------------
//
// There is NO GLOBAL uom-to-uom conversion anywhere in this system. Conversion is
// per product, through `packages[]` — several units sharing one base — so the
// Unit picker's options and their factors are a property OF THE CHOSEN SKU.
//
// The requirement described this field as "one of uom from master data (global)".
// A global list would offer units the product has no factor for, and the
// conversion would then be undefined or silently 1.0 — a wrong number that looks
// entirely ordinary. So the field CASCADES: pick a SKU, and the units are that
// product's.
//
// Changing the SKU CLEARS the unit rather than keeping it. A unit carried over
// from the previous product would still be selectable and would carry the
// PREVIOUS product's factor, which is the same silent-wrong-number one step
// further along.
//
// ON A SKU REPORT THE FIELD IS FIXED, NOT REMOVED, and it stays ABOVE the unit.
// The report IS one SKU, so a picker there would be a control that looks like a
// choice and is not — the argument this file already makes 150 lines down for
// `noPackages`. But the field has to remain visible and in place, because the
// operator must see WHOSE packages[] the unit list came from; hiding it would
// leave the unit picker's options unexplained.
//
// ---------------------------------------------------------------------------
// WHAT THIS DOES NOT DO, SAID BEFORE THE OPERATOR SUBMITS
// ---------------------------------------------------------------------------
//
// It moves the reported reject or rework COUNT and NO PERCENTAGE. The line's
// rates are time-derived — quality = value_added_time / net_time (contract
// §16.10a(b)) — so 500 rejects typed in do not change Quality, OEE or TEEP by one
// decimal. That is correct, and it is the first thing that will be reported as a
// bug, so the dialog says it rather than leaving it to be discovered.
//
// And the figure does not move IMMEDIATELY either: the entry is composed into the
// report by the pipeline (§18), so the tile is unchanged until the next DAG run.
// The card's ledger line is what confirms the entry landed.
type FixedSku = { kind: "fixed"; id: number; name: string };
type PickSku = { kind: "pick"; ran: { productId: number; productName: string }[] };

function QualityEntryView({
  kind,
  open,
  onOpenChange,
  workCenterId,
  infeedUomCode,
  sku,
  machines,
  fixedShift,
  datePicker,
  mutation,
}: {
  kind: QualityEntryKind;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // The two catalogues this form needs: reject reasons, and — in `pick` mode —
  // the products the line is set up to run.
  workCenterId: number;
  // The line's infeed unit: the conversion TARGET, and the fixed unit shown when
  // the chosen SKU has no packages. Null when the report says its members
  // disagreed, in which case there is nothing to convert into.
  infeedUomCode: string | null;
  sku: FixedSku | PickSku;
  // NARROWED TO TWO FIELDS, never LineMachineList. That type carries a `reportId`
  // per row — a MACHINE report's id — and a shared form must not be able to reach
  // one; the same argument losses-card-shell.tsx makes about not reaching a unit,
  // an id or a grain.
  machines: { workUnitId: number; workUnitName: string | null }[];
  // The shift, when the report already names one. Null means ASK — a day, month
  // or SKU report spans three, and every entry is shift-keyed whatever screen
  // produced it.
  fixedShift: number | null;
  // Non-null only when the report spans more than one business day, i.e. a month.
  // `min` bounds the picker to that month; the server re-checks it.
  datePicker: { min: string } | null;
  mutation: UseMutationResult<QualityEntry, unknown, QualityEntryDraft>;
}) {
  const { t } = useTranslation("oee");
  const label = kind === "reject" ? t("report.reject") : t("report.rework");
  const kindLower =
    kind === "reject" ? t("report.reject").toLowerCase() : t("report.rework").toLowerCase();

  // ONE requestId PER OPEN, not per submit. It is the idempotency key: a
  // double-click sends the same one twice and the server makes the second a
  // no-op, where a fresh id per attempt would guard nothing. Regenerated when the
  // dialog reopens, because that IS a new entry.
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());

  const [workUnitId, setWorkUnitId] = useState<string>("");
  // FIXED MODE SEEDS IT AND NEVER OFFERS A CHANGE. It is still state rather than a
  // derived constant so the rest of the form below reads one variable either way.
  const [productId, setProductId] = useState<string>(sku.kind === "fixed" ? String(sku.id) : "");
  const [packageId, setPackageId] = useState<string>("");
  const [quantity, setQuantity] = useState<string>("");
  const [reasonId, setReasonId] = useState<string>("");
  const [shift, setShift] = useState<string>(fixedShift === null ? "" : String(fixedShift));
  const [businessDate, setBusinessDate] = useState<string>("");
  const [note, setNote] = useState<string>("");

  // Catalogues, both REFERENCE_STALE_TIME-cached and shared across every open of
  // this dialog, so after the first the pickers open with their lists rather than
  // with a spinner.
  //
  // THE PRODUCT CATALOGUE IS GATED ON `pick` MODE. A SKU report already knows its
  // product, so fetching a list to choose from would be a request whose answer
  // cannot be used — and `useLineProductOptions` is gated rather than skipped
  // because React forbids a conditional hook.
  const catalogue = useLineProductOptions(workCenterId, sku.kind === "pick");
  const reasons = useRejectReasonOptions(workCenterId);
  const product = useProductDetail(productId === "" ? undefined : Number(productId));

  // THE SKU LIST IS WHAT RAN, THEN THE CATALOGUE — and this order is a bug fix,
  // not a preference.
  //
  // It was the catalogue alone, on the reasoning that a picklist is a CATALOGUE
  // question rather than a MEASUREMENT. That reasoning is fine and the result was
  // wrong: `product_work_centers` is a separate assignment upstream, so a line
  // routinely runs SKUs nobody has linked to it. The observed symptom was a
  // report whose SKU View showed a product and whose Add Reject dialog offered an
  // empty dropdown — the screen contradicting itself, which is the failure this
  // codebase treats as worse than an error.
  //
  // So what RAN comes first: it is what an operator is recording against, and it
  // cannot disagree with the card above. The catalogue follows for anything that
  // did not run this window but legitimately could have.
  const skuOptions = useMemo(() => {
    if (sku.kind === "fixed") return [];

    const seen = new Set<number>();
    const options: { id: number; name: string; ran: boolean }[] = [];

    for (const item of sku.ran) {
      if (seen.has(item.productId)) continue;
      seen.add(item.productId);
      options.push({ id: item.productId, name: item.productName, ran: true });
    }
    for (const item of catalogue.data ?? []) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      options.push({ id: item.id, name: item.name, ran: false });
    }
    return options;
  }, [sku, catalogue.data]);

  // The unit options, sorted as master data sorts them, with the product's main
  // package first — that is the unit the line most likely reports in, and it is
  // the one that makes the conversion an identity.
  const packages = useMemo(
    () => [...(product.data?.packages ?? [])].sort((a, b) => a.sortOrder - b.sortOrder),
    [product.data],
  );

  // A SKU MASTER DATA DOES NOT HAVE has no packages to offer, and that is a real
  // case rather than a load failure — see skuOptions. The quantity is then
  // entered in the LINE'S OWN unit, the conversion is the identity, and no
  // packageId is sent: the server resolves both from the report row.
  //
  // `product.isFetched` gates it so the field does not flash "no packages" while
  // the lookup is still in flight.
  const noPackages = productId !== "" && product.isFetched && packages.length === 0;

  // THE CASCADE'S CLEAR. See the header: a unit left selected across a SKU change
  // carries the previous product's factor. In fixed mode `productId` never
  // changes, so this fires once with nothing to clear.
  useEffect(() => {
    setPackageId("");
  }, [productId]);

  function reset() {
    setRequestId(crypto.randomUUID());
    setWorkUnitId("");
    // BACK TO THE FIXED PRODUCT, not to empty: on a SKU report there is no other
    // value the form can hold, and clearing it would disable submit with no field
    // the operator could use to re-enable it.
    setProductId(sku.kind === "fixed" ? String(sku.id) : "");
    setPackageId("");
    setQuantity("");
    setReasonId("");
    setShift(fixedShift === null ? "" : String(fixedShift));
    setBusinessDate("");
    setNote("");
    mutation.reset();
  }

  const chosenPackage = packages.find((pkg) => String(pkg.id) === packageId);
  const qty = Number(quantity);

  // THE CONVERSION PREVIEW — "10 CTN = 120 BAG".
  //
  // Shown because the operator is entering a number in one unit that lands in
  // another, and a conversion they cannot see is a conversion they cannot check.
  //
  // ADVISORY, NOT AUTHORITATIVE. The factor here is the cached catalogue's; the
  // one the entry is written with is re-resolved server-side and never cached, so
  // these can differ by up to the cache TTL. The ledger renders the RESPONSE
  // after a save, never this figure.
  //
  // Null when the line's target unit is unknown — `targetUomCode` is null when the
  // report says its members disagreed — because there is then nothing to convert
  // INTO, and the server will refuse the write for the same reason.
  const preview =
    !noPackages &&
    chosenPackage?.uom != null &&
    infeedUomCode !== null &&
    Number.isFinite(qty) &&
    qty > 0
      ? previewConversion(qty, chosenPackage, packages, infeedUomCode, t)
      : null;

  const missingMachine = kind === "reject" && workUnitId === "";
  const canSubmit =
    !mutation.isPending &&
    !missingMachine &&
    productId !== "" &&
    // No package is required on the identity path — see `noPackages`.
    (packageId !== "" || noPackages) &&
    reasonId !== "" &&
    shift !== "" &&
    (datePicker === null || businessDate !== "") &&
    Number.isFinite(qty) &&
    qty > 0;

  function submit() {
    mutation.mutate(
      {
        kind,
        productId: Number(productId),
        ...(noPackages ? {} : { packageId: Number(packageId) }),
        quantity: qty,
        shift: Number(shift),
        reasonId: Number(reasonId),
        ...(kind === "reject" ? { workUnitId: Number(workUnitId) } : {}),
        ...(datePicker === null ? {} : { businessDate }),
        ...(note.trim() === "" ? {} : { note: note.trim() }),
        requestId,
      },
      {
        onSuccess: (entry) => {
          // The RESPONSE's converted figure, not the preview's — see above.
          toast.success(
            t("report.recordedOf", {
              qty: formatQuantity(entry.targetQty, entry.targetUomCode),
              kind: kindLower,
            }),
          );
          onOpenChange(false);
          reset();
        },
      },
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // THE DIALOG STAYS OPEN ON FAILURE, confirm-write-dialog.tsx's rule: the
        // operator is about to press the button again and the message has to stay
        // beside it. Closing is only ever deliberate, and it resets.
        if (!next && mutation.isPending) return;
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("common.add", { label })}</DialogTitle>
          <DialogDescription>{t("report.qualityEntryBody", { kind: kindLower })}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          {/* REJECT ONLY, per the requirement. Provenance: it records which
              machine the operator saw them on and does NOT move that machine's own
              report — a line is measured at its own count points. */}
          {kind === "reject" ? (
            <Field label={t("table.machine")} htmlFor="qe-machine">
              <Select value={workUnitId} onValueChange={setWorkUnitId}>
                <SelectTrigger id="qe-machine" className="w-full">
                  <SelectValue placeholder={t("report.pickMachine")} />
                </SelectTrigger>
                <SelectContent>
                  {machines.map((machine) => (
                    <SelectItem key={machine.workUnitId} value={String(machine.workUnitId)}>
                      {machine.workUnitName ??
                        t("report.machineFallback", { id: machine.workUnitId })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : null}

          {/* IN PLACE AND ABOVE THE UNIT IN BOTH MODES — see the header. On a SKU
              report it is a read-only field rather than a list of one: a control
              that looks like a choice and is not, which is the same call the
              `noPackages` unit input makes below. It must not be REMOVED, because
              the unit options are that product's packages[] and hiding the product
              leaves them unexplained. */}
          <Field label={t("common.sku")} htmlFor="qe-sku">
            {sku.kind === "fixed" ? (
              <Input id="qe-sku" value={sku.name} readOnly />
            ) : (
              <Select value={productId} onValueChange={setProductId}>
                <SelectTrigger id="qe-sku" className="w-full">
                  <SelectValue placeholder={t("report.pickProduct")} />
                </SelectTrigger>
                <SelectContent>
                  {skuOptions.map((option) => (
                    <SelectItem key={option.id} value={String(option.id)}>
                      {option.name}
                      {option.ran ? "" : t("report.notRunThisShift")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </Field>

          <div className="grid grid-cols-2 gap-4">
            <Field label={t("common.quantity")} htmlFor="qe-qty">
              <Input
                id="qe-qty"
                type="number"
                min="0"
                step="0.001"
                inputMode="decimal"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
              />
            </Field>

            {/* CASCADES FROM THE SKU — see the header. Disabled until there is a
                product, because until then there is no conversion to offer. */}
            <Field label={t("common.packageUnit")} htmlFor="qe-unit">
              {noPackages ? (
                // FIXED, NOT A PICKER. There is one unit this can be — the line's
                // own — and offering a list of one is a control that looks like a
                // choice and is not.
                <Input
                  id="qe-unit"
                  value={infeedUomCode ?? ""}
                  readOnly
                  aria-describedby="qe-unit-note"
                />
              ) : (
                <Select value={packageId} onValueChange={setPackageId} disabled={productId === ""}>
                  <SelectTrigger id="qe-unit" className="w-full">
                    <SelectValue
                      placeholder={productId === "" ? t("report.pickSkuFirst") : t("report.unit")}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {packages.map((pkg) => (
                      <SelectItem key={pkg.id} value={String(pkg.id)}>
                        {pkg.uom?.code ?? "—"}
                        {pkg.main ? t("report.baseSuffix") : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </Field>
          </div>

          {noPackages ? (
            <p className="text-muted-foreground text-xs" id="qe-unit-note">
              {t("report.noPackaging")}
            </p>
          ) : null}

          {preview !== null ? (
            <p className="text-muted-foreground text-xs tabular-nums" data-testid="qe-preview">
              {preview}
            </p>
          ) : null}

          <Field label={t("report.reason")} htmlFor="qe-reason">
            <Select value={reasonId} onValueChange={setReasonId}>
              <SelectTrigger id="qe-reason" className="w-full">
                <SelectValue placeholder={t("report.pickReason")} />
              </SelectTrigger>
              <SelectContent>
                {(reasons.data ?? []).map((reason) => (
                  <SelectItem key={reason.id} value={String(reason.id)}>
                    {reason.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <div className="grid grid-cols-2 gap-4">
            {/* PREFILLED AND FIXED when the report names one shift; a picker when
                it spans three — a line day, a line month, or a SKU day. At month
                grain the date beside it is what makes the shift identify one.
                
                Every entry is shift-keyed whatever screen produced it, which is
                what lets contract §18 be ONE dbt join — so this field is never
                absent, only sometimes already answered. */}
            <Field label={t("report.shift")} htmlFor="qe-shift">
              <Select value={shift} onValueChange={setShift} disabled={fixedShift !== null}>
                <SelectTrigger id="qe-shift" className="w-full">
                  <SelectValue placeholder={t("report.shift")} />
                </SelectTrigger>
                <SelectContent>
                  {["1", "2", "3"].map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            {/* ONLY WHERE THE REPORT SPANS MORE THAN ONE BUSINESS DAY — a month.
                A month report covers ~30 of them, so a shift alone does not
                identify one, and an entry keyed to the wrong day is applied by the
                pipeline to a report nobody is looking at. Bounded to the report's
                own month, which the server re-checks.
                
                A SKU DAY REPORT HAS NO DATE FIELD, deliberately: it covers exactly
                one business date and the server takes it off the row, refusing a
                client that sends a different one. */}
            {datePicker !== null ? (
              <Field label={t("common.businessDate")} htmlFor="qe-date">
                <Input
                  id="qe-date"
                  type="date"
                  value={businessDate}
                  min={datePicker.min}
                  onChange={(e) => setBusinessDate(e.target.value)}
                />
              </Field>
            ) : null}
          </div>

          <Field label={t("common.noteOptional")} htmlFor="qe-note">
            <Textarea
              id="qe-note"
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>

          {mutation.error !== null ? (
            <Alert variant="destructive">
              <AlertDescription>{messageFor(mutation.error, kindLower, t)}</AlertDescription>
            </Alert>
          ) : null}
        </div>

        <DialogFooter>
          {/* BOTH DISABLED IN FLIGHT, confirm-write-dialog.tsx's other rule:
              Cancel would otherwise close over a write still going to land. */}
          <Button
            variant="outline"
            disabled={mutation.isPending}
            onClick={() => {
              reset();
              onOpenChange(false);
            }}
          >
            {t("common.cancel")}
          </Button>
          <Button disabled={!canSubmit} onClick={submit}>
            {mutation.isPending ? t("common.recording") : t("common.add", { label })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// "10 CTN = 120 BAG", or a sentence saying why it cannot be shown.
//
// THROUGH THE PRODUCT'S BASE, not to it — the same arithmetic the database
// performs, kept here only as a preview. Several packages share one base, so any
// two convert through it. When the line's unit is not one of this product's
// packages there is no path, and the server will refuse the write: saying so here
// is the difference between a form that explains itself and a 400 on submit.
function previewConversion(
  qty: number,
  from: { factorToBase: number; uom: { code: string } | null },
  packages: { factorToBase: number; uom: { id: number; code: string } | null }[],
  targetCode: string,
  t: (key: string, opts?: Record<string, string | number>) => string,
): string {
  const target = packages.find((pkg) => pkg.uom?.code === targetCode);
  if (target === undefined) {
    return t("report.noConversion", { unit: targetCode });
  }
  if (from.uom?.code === targetCode) {
    return t("report.recordedAs", { qty: formatQuantity(qty, targetCode) });
  }

  const converted = (qty * from.factorToBase) / target.factorToBase;
  return t("report.equalsQty", {
    from: formatQuantity(qty, from.uom?.code ?? null),
    to: formatQuantity(Math.round(converted * 1000) / 1000, targetCode),
  });
}

// Per-status copy, like confirm-write-dialog's. 409 is the one status where "try
// again" is actively bad advice, and here it covers two genuinely different
// recoveries — so the message names both rather than guessing.
function messageFor(
  error: unknown,
  kind: string,
  t: (key: string, opts?: Record<string, string>) => string,
): string {
  if (!isAxiosError(error)) return t("report.qualityRecordError", { kind });
  const status = error.response?.status;
  const body = (error.response?.data as { error?: string } | undefined)?.error;

  if (status === 409) {
    return body ?? t("report.qualityFrozen");
  }
  if (status === 400) return body ?? t("report.qualityRejected");
  if (status === 403) return t("report.qualityForbidden");
  return t("report.qualityFallback", { kind });
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  );
}

export { QualityEntryView };
export type { FixedSku, PickSku };
