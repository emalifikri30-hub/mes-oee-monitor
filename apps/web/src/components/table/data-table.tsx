import { flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table";

import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import type { ColumnDef, TableOptions } from "@tanstack/react-table";

type DataTableProps<TData> = {
  // Display columns only, so one array type covers every caller.
  columns: ColumnDef<TData, unknown>[];
  rows: TData[];
  getRowId: (row: TData) => string;
  isPending: boolean;
  isError: boolean;
  errorMessage: string;
  emptyMessage: string;
  // Skeleton row count while pending — the requested page size, so the table
  // does not resize once the real page lands.
  skeletonRows?: number;
  // Forwarded to useReactTable. `meta` is the reason this exists: columns need
  // the current page/size to number rows continuously across pages.
  meta?: TableOptions<TData>["meta"];
};

// The app's one server-paginated table body: header, the three non-data states,
// and the rows. Paging chrome is a separate concern — render <TablePagination />
// alongside it.
function DataTable<TData>({
  columns,
  rows,
  getRowId,
  isPending,
  isError,
  errorMessage,
  emptyMessage,
  skeletonRows = 10,
  meta,
}: DataTableProps<TData>) {
  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId,
    manualPagination: true,
    meta,
  });

  return (
    <div className="w-full overflow-x-auto">
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id} className="hover:bg-transparent">
              {headerGroup.headers.map((header) => (
                <TableHead
                  key={header.id}
                  className={header.column.columnDef.meta?.headerClassName}
                >
                  {flexRender(header.column.columnDef.header, header.getContext())}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {isPending ? (
            Array.from({ length: Math.min(skeletonRows, 10) }).map((_, i) => (
              <TableRow key={i} className="hover:bg-transparent">
                {columns.map((_col, j) => (
                  <TableCell key={j}>
                    <Skeleton className="h-4 w-full" />
                  </TableCell>
                ))}
              </TableRow>
            ))
          ) : isError ? (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={columns.length} className="h-24 text-center text-destructive">
                {errorMessage}
              </TableCell>
            </TableRow>
          ) : rows.length === 0 ? (
            <TableRow className="hover:bg-transparent">
              <TableCell
                colSpan={columns.length}
                className="h-24 text-center text-muted-foreground"
              >
                {emptyMessage}
              </TableCell>
            </TableRow>
          ) : (
            table.getRowModel().rows.map((row) => (
              <TableRow key={row.id}>
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id} className={cell.column.columnDef.meta?.cellClassName}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}

export { DataTable };
