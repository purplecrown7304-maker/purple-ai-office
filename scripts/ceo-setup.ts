export interface SetupDatabase {
  query(sql: string, params?: string[]): Promise<Record<string, unknown>[]>;
}
/** Must run inside a caller-owned transaction. Does not create Auth users. */
export async function configureCeo(db: SetupDatabase, email: string): Promise<void> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) throw new Error('CEO_EMAIL_REQUIRED');
  await db.query('select pg_advisory_xact_lock(810001)');
  const users = await db.query('select id from auth.users where lower(email)=$1 and email_confirmed_at is not null and coalesce(is_anonymous,false)=false', [normalized]);
  if (users.length !== 1) throw new Error('CEO_ACCOUNT_NOT_UNIQUE_OR_UNCONFIRMED');
  const id = String(users[0].id);
  const settings = await db.query('select ceo_user_id from private.office_settings');
  if (settings.length && settings[0].ceo_user_id !== id) throw new Error('CEO_ALREADY_CONFIGURED');
  await db.query('insert into private.office_settings(ceo_user_id) values($1) on conflict(singleton) do nothing', [id]);
  await db.query(`insert into public.agents(owner_id,slug,display_name,provider,model) values
    ($1,'gpt','GPT','mock','mock-v1'),($1,'claude','Claude','mock','mock-v1') on conflict(owner_id,slug) do nothing`, [id]);
}
