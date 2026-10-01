import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

// Mirrors the real page's block structure so the layout does not jump when the
// report lands.
function ReportSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <Card className="flex-row items-center justify-between px-6 py-4">
        <div className="flex gap-10">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-32" />
          ))}
        </div>
        <Skeleton className="h-9 w-28" />
      </Card>

      <Card className="gap-0 py-0">
        <CardHeader className="py-4">
          <Skeleton className="h-4 w-28" />
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4 pb-5 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-9">
          {Array.from({ length: 9 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </CardContent>
      </Card>

      {/* The downtime strip plus its legend row. The card has no header, so this
          block is shorter than the ones either side of it. */}
      <Card className="gap-0 py-0">
        <CardContent className="flex flex-col gap-3 py-4">
          <Skeleton className="h-7 w-full rounded-sm" />
          <div className="flex flex-wrap gap-5">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-4 w-32" />
            ))}
          </div>
        </CardContent>
      </Card>

      <Card className="gap-0 py-0">
        <CardHeader className="py-4">
          <Skeleton className="h-4 w-36" />
        </CardHeader>
        <CardContent className="pb-5">
          <Skeleton className="h-[340px] w-full" />
        </CardContent>
      </Card>

      <Card className="gap-0 py-0">
        <CardHeader className="py-4">
          <Skeleton className="h-4 w-20" />
        </CardHeader>
        <CardContent className="flex flex-wrap gap-10 pb-5">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-28" />
          ))}
        </CardContent>
      </Card>

      {/* Downtime Details: header strip, five rows at the default page size,
          then the pager. */}
      <Card className="gap-0 py-0">
        <CardHeader className="py-4">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="col-start-2 row-start-1 h-8 w-64 justify-self-end" />
        </CardHeader>
        <CardContent className="flex flex-col gap-3 pb-5">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </CardContent>
      </Card>

      {/* SKU View: a product name over a row of four tiles. One block, because the
          row count is not knowable before the response and guessing high would make
          the page jump downwards when a single-SKU shift lands. */}
      <Card className="gap-0 py-0">
        <CardHeader className="py-4">
          <Skeleton className="h-4 w-24" />
        </CardHeader>
        <CardContent className="flex flex-col gap-3 pb-5">
          <Skeleton className="h-5 w-32" />
          <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export { ReportSkeleton };
