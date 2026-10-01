import { QueryClient } from "@tanstack/react-query";

// One instance, shared by <QueryClientProvider> in main.tsx and the router context
// in router.ts. They must be the same object: otherwise route loaders warm a cache
// the components never read.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

export { queryClient };
