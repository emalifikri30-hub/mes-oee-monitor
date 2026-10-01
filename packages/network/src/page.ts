type PageMeta = {
  page: number;
  size: number;
  totalElements: number;
  totalPages: number;
  first: boolean;
  last: boolean;
};

type Paged<T> = { items: T[]; totalElements: number };
type PagedResult<T> = { items: T[]; meta: PageMeta };

export type { PageMeta, Paged, PagedResult };
