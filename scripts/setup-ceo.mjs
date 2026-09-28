import postgres from 'postgres';
import { configureCeo } from './ceo-setup.ts';

// Run only from a trusted terminal/CI setup job, never from a browser or public route.
const email = process.env.CEO_EMAIL?.trim().toLowerCase();
const connection = process.env.DATABASE_URL;
if (!email || !connection) {
  console.error('CEO_EMAIL and DATABASE_URL are required. Values are never printed.');
  process.exit(1);
}
const sql = postgres(connection, { max: 1, onnotice: () => {} });
try {
  await sql.begin(async tx => {
    await configureCeo({ query: async (text, params) => Array.from(await tx.unsafe(text, params)) }, email);
  });
  console.log('CEO and default Mock agents configured. Existing configuration preserved.');
} catch {
  // DB/driver errors may contain connection details or bound parameters.
  console.error('Setup failed. Check account confirmation, existing CEO and database permissions. No configuration was committed.');
  process.exitCode = 1;
} finally { await sql.end(); }
