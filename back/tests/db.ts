// Shared test-database helpers. Every DB test truncates tables, so they all go
// through here and the guard below cannot be skipped by accident.
import prisma from "@/db.ts";

type Row = { db: string };

let guard: Promise<void> | null = null;

/**
 * The suite truncates whole tables with CASCADE, so refuse to run anywhere but
 * a *_test database. A copied --env-file or a renamed database is how this goes
 * wrong; it fails here, loudly, instead of silently emptying the dev data.
 */
export function assertTestDatabase(): Promise<void> {
  guard ??= (async () => {
    const [row] = await prisma.$queryRaw<
      Row[]
    >`select current_database() as db`;
    const name = row?.db ?? "";
    if (!name.endsWith("_test")) {
      throw new Error(
        `Refusing to run: the database is "${
          name || "unknown"
        }", not a *_test one. ` +
          `deno task test loads .env.test; check that its DATABASE_URL points at a copy.`,
      );
    }
  })();
  return guard;
}

/** Empties the given tables, and everything that cascades from them. */
export async function truncate(...tables: string[]): Promise<void> {
  await assertTestDatabase();
  const list = tables.map((table) => `"${table}"`).join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE ${list} CASCADE`);
}

export async function closeDb(): Promise<void> {
  await prisma.$disconnect();
}
