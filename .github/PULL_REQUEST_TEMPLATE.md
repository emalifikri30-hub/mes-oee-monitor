<!-- Thanks for the contribution! Keep the PR focused and the description scannable. -->

## Summary

<!-- What does this PR change and why? Link the motivating issue. -->

Closes #

## Affected apps

- [ ] `core-api`
- [ ] `bff`
- [ ] `web`
- [ ] repo-wide (CI, docker, docs, tooling)

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor / chore
- [ ] Docs
- [ ] CI / build / deploy

## How was this tested?

<!-- Commands you ran and what you observed. -->

- [ ] `vp check` (format + lint + types)
- [ ] `vp test` (or `pnpm --filter <app> run test`)
- [ ] `vp run -r build`
- [ ] Manual / Docker (`docker build -f apps/<app>/Dockerfile -t <app> .`)

## Checklist

- [ ] Docs updated (app `README.md` / root `README.md`) if behavior or setup changed
- [ ] New environment variables are documented in the relevant `README.md`
- [ ] DB schema change includes a new numbered `.sql` file under `apps/api/src/shared/database/migration/`, applied with `pnpm --filter api db:migrate`
- [ ] No secrets / `.env` values committed

## Screenshots / notes

<!-- For `web` changes, add before/after screenshots. Anything else reviewers should know. -->
