# db/migrations

Numbered, immutable SQL files, applied in lexical filename order by `server/migrate.mjs` after
its schema.sql/seed.sql bootstrap. Each one is recorded by filename in `public.schema_migrations`
once it succeeds, so every file here runs at most once against any given database.

**The rule: changing `db/schema.sql` and changing a running database are two different jobs.**
`db/schema.sql` is only ever read by a database that has never run anything - `server/migrate.mjs`
skips it outright once it is recorded as applied, which every database (production included) is,
the moment it first boots. Editing `db/schema.sql` alone changes nothing on any database that
already exists; it only changes what a brand-new one gets.

So: whenever you change something `db/schema.sql` defines (a function body, a column, a default,
a grant), do both:

1. Edit `db/schema.sql` itself, so a fresh database is created in the new state directly.
2. Add a new file here, numbered one higher than the last, that brings an already-running
   database from the old state to the new one. `create or replace function` is the natural tool
   for a function body; write it defensively (idempotent, safe whether or not the old or new
   state is already present) since you cannot know which databases will run it and in what
   state you'll find them.

Never edit a migration file once it has shipped - if a migration was wrong, add a new one that
corrects it. Never renumber or delete one either; `schema_migrations` remembers files by name.

See the three files here for the pattern (`0001`-`0003`), and `server/migrate.mjs`'s own header
comment for how they're applied, ordered and locked against concurrent runs.
