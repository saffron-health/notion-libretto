# notion-libretto

A collection of Notion Workers. Each worker is an independent deployment unit with its own `package.json`, `tsconfig.json`, and `src/`. Treat each subdirectory under `workers/` as a self-contained project — `cd` into it before running `npm`, `ntn workers deploy`, etc.

## Layout

```
workers/
  insert-into-database/   # Webhook: POST { database_id, data } → insert page
    src/
    package.json
    tsconfig.json
    .env.example
    README.md
```

## Workers

- **[insert-into-database](workers/insert-into-database/README.md)** — Generic webhook that accepts `{ database_id, data }` and writes a new page into any Notion database the worker can access. Handles arbitrary schemas by introspecting the database's properties at request time.

## Adding a new worker

```bash
mkdir -p workers/<name>
cd workers/<name>
# scaffold package.json, tsconfig.json, src/index.ts using @notionhq/workers
```

Then deploy from inside the new directory with `ntn workers deploy`.
