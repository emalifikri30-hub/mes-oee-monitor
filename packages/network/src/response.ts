import type { PageMeta } from "./page.js";

function buildPageMeta(page: number, size: number, totalElements: number): PageMeta {
  const totalPages = totalElements === 0 ? 0 : Math.ceil(totalElements / size);
  const first = page <= 1;
  const last = totalElements === 0 || page >= totalPages;
  return {
    page,
    size,
    totalElements,
    totalPages,
    first,
    last,
  };
}

type WebResponseShape<T> = {
  data: T | null;
  meta?: PageMeta;
  error: string | null;
};

class WebResponseBuilder<T> {
  private _data: T | null = null;
  private _meta: PageMeta | undefined = undefined;
  private _error: string | null = null;

  data(d: T): WebResponseBuilder<T> {
    this._data = d;
    return this;
  }

  meta(m: PageMeta): WebResponseBuilder<T> {
    this._meta = m;
    return this;
  }

  error(err: string): WebResponseBuilder<T> {
    this._error = err;
    this._data = null;
    return this;
  }

  build(): WebResponseShape<T> {
    const out: WebResponseShape<T> = {
      data: this._data,
      error: this._error,
    };
    if (this._meta !== undefined) out.meta = this._meta;
    return out;
  }
}

class WebResponse {
  static builder<T>(): WebResponseBuilder<T> {
    return new WebResponseBuilder<T>();
  }
}

export { WebResponse, buildPageMeta };
export type { WebResponseShape };
