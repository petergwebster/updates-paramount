# Security notes — updates-paramount

Last reviewed: 27 July 2026 (Peter Webster)

This file exists so that whoever inherits this repo does not have to guess
whether a gap was considered or overlooked. If you change any of the below,
update this file in the same commit.

---

## Row Level Security: three tables are deliberately open

`vena_monthly`, `order_ledger` and `inventory_snapshot` have RLS **disabled**.
Every other table in the schema has RLS enabled with a single policy granting
all operations to the `authenticated` role.

This is a deliberate decision, reviewed 27 July 2026, not an oversight.

**Reasoning.** The exposure is Paramount divisional operating data, not FSCO
consolidated financials and not personal data:

- `vena_monthly` — monthly P&L by cost centre. The most sensitive line is an
  aggregate salaries figure; there is no individual compensation in it.
- `order_ledger` — order numbers, yardage, invoiced revenue. No customer names.
- `inventory_snapshot` — SKU-level position and supplier cost.

Nothing here is regulated, and payroll detail is excluded at source (`sf_pull.py`
skips any filename containing "pay detail" or "ssn").

Against that, enabling RLS means changing access control on three live tables
that both the floor and the automated feeds read. The dominant failure mode in
this application is a data query that fails silently and renders zero rather
than an error — four instances of it were found and fixed on 27 July alone. A
broken RLS policy would present exactly that way. The risk of the change was
judged higher than the risk it removes.

**Worth understanding before you "fix" this.** The policies on the other tables
are `for all to authenticated using (true)`. That is not row-level security in
any meaningful sense — it is a login requirement. The real gap between the
protected tables and these three is narrower than the RLS flag suggests.

**Revisit if any of these become true:**

- Individual compensation or any personal data lands in one of these tables.
- The dashboard is opened to anyone outside Paramount/FSCO staff.
- FSCO adopts a formal data classification policy that covers divisional P&L.
- Consolidated FSCO financials (not just cost centres 609/610/612) are ingested.

---

## What actually protects the data today

Access requires a Supabase login against `profiles`, which is role-gated
(`admin` / `exec` / `manager` / `qa`). The anon key is public by design — it
ships in the browser bundle — so it is the login, not the key, that is the
control.

The service role key is used only by Netlify functions, is never in code, and
is set as a Netlify environment variable. It bypasses RLS, which is why the
ShareFile and LIFT feeds are unaffected by any RLS decision above.

## One table where RLS is doing real work

`integration_state` holds the ShareFile OAuth refresh token. It has RLS enabled
with a **single narrow policy**: anon/authenticated may `SELECT` only where
`key = 'sharefile_health'`. This is not the blanket pattern used elsewhere and
must not be widened. If a new browser-readable piece of state is needed, put it
in its own table rather than adding a policy here.

This one was originally created with RLS off and a browser component pointed at
it, which would have exposed the refresh token to anyone holding the anon key.
It was caught and fixed. That is the reason for the narrow policy.

## Credentials on disk

`C:\Dev\TriadBridge\sf_conf.json` (ShareFile client id/secret) and `token.json`
(refresh token) sit in plaintext. Confirm both are gitignored before that folder
is ever pushed to a remote.
