import { useTranslation } from "react-i18next";

import { useSelectedArea } from "@/components/layout/area-context";
import { useAreas } from "@/lib/queries";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// Header-wide area picker. It scopes the line options a report page can offer;
// it is not itself a report filter, because core-api's shift-report endpoint
// takes a workCenterId and knows nothing about areas.
function AreaSelect() {
  const { t } = useTranslation("oee");
  const { data: areas, isPending, isError } = useAreas();
  const { areaId, setAreaId } = useSelectedArea();

  if (isPending) return <Skeleton className="h-9 w-24" />;
  // No areas means no line filter is possible; say so rather than showing an
  // empty dropdown that looks broken.
  if (isError || areas.length === 0) {
    return <span className="text-muted-foreground text-sm">{t("area.none")}</span>;
  }

  return (
    <Select
      value={areaId === undefined ? "" : String(areaId)}
      onValueChange={(v) => setAreaId(Number(v))}
    >
      <SelectTrigger className="w-40" aria-label={t("area.label")}>
        <SelectValue placeholder={t("area.label")} />
      </SelectTrigger>
      <SelectContent>
        {areas.map((area) => (
          <SelectItem key={area.id} value={String(area.id)}>
            {area.code}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export { AreaSelect };
