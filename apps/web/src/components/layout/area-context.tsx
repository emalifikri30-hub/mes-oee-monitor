import { createContext, useContext, useMemo, useState } from "react";

import { useAreas } from "@/lib/queries";

import type { ReactNode } from "react";

// The area picker sits in the header but scopes filters on the pages below it,
// so the selection lives in context rather than in either component. It is
// deliberately NOT a search param: it survives navigation between reports, and
// it never filters a request on its own — it only decides which work centers a
// page may offer (core-api has no areaId filter).
type AreaContextValue = {
  areaId: number | undefined;
  setAreaId: (id: number) => void;
};

const AreaContext = createContext<AreaContextValue | null>(null);

const STORAGE_KEY = "oee.area-id";

function readStoredAreaId(): number | undefined {
  const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
  if (raw === null || raw === undefined) return undefined;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : undefined;
}

function AreaProvider({ children }: { children: ReactNode }) {
  const [chosen, setChosen] = useState(readStoredAreaId);
  const { data: areas } = useAreas();

  const value = useMemo<AreaContextValue>(() => {
    // Derived, not synced through an effect: while areas are loading the stored
    // id stands, and once they land an id the user can no longer see falls back
    // to the first area rather than silently filtering to nothing.
    const areaId =
      areas === undefined
        ? chosen
        : areas.some((area) => area.id === chosen)
          ? chosen
          : areas[0]?.id;

    return {
      areaId,
      setAreaId: (id: number) => {
        setChosen(id);
        globalThis.localStorage?.setItem(STORAGE_KEY, String(id));
      },
    };
  }, [areas, chosen]);

  return <AreaContext value={value}>{children}</AreaContext>;
}

function useSelectedArea(): AreaContextValue {
  const value = useContext(AreaContext);
  if (!value) throw new Error("useSelectedArea must be used inside <AreaProvider>");
  return value;
}

export { AreaProvider, useSelectedArea };
