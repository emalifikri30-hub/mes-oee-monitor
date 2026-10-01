import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  // apps/web/src/routeTree.gen.ts is generated and formatted by
  // @tanstack/router-plugin. The pre-commit hook above runs from this root config,
  // so the ignore has to live here too, not only in apps/web/vite.config.ts.
  fmt: { ignorePatterns: ["**/routeTree.gen.ts"] },
  lint: { options: { typeAware: true, typeCheck: true } },
  run: {
    cache: true,
  },
});
