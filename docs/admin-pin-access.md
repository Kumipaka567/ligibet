# Admin PIN access

The normal dashboard login stays the same. Click **Unlock my clients**, choose R, G, S, or V and enter your **4-digit PIN** to reveal that admin's clients, even when people share a login account. PIN access lasts 15 minutes, stays in memory, and clears when leaving the dashboard or reloading the page. Use **Lock** before handing over a shared device.

Without a PIN, claimed clients' numbers are masked (for example `071*****78`), including in failed transactions. Failed unclaimed transaction numbers are also hidden; other unclaimed numbers remain visible. With a PIN, lists show that admin's clients and unclaimed clients. Superadmin has exactly the same phone rules; its login does not reveal other admins' numbers or permit taking their clients.

To claim a completed **deposit**, click your initial. **Claiming requires no PIN and does not reveal the phone number.** The first claim owns the normalized phone number across transactions, users, withdrawals, online players, game monitoring, CSV export, audit logs, and support. All existing and future transactions for that number inherit its owner's initials, including failed transactions and different accounts with the same number. Admin/superadmin accounts and their numbers are excluded from ownership. Subsequent transactions cannot transfer ownership. Existing completed deposit claims are respected; if legacy deposits have conflicting initials, the earliest claim wins. Ownership survives deposit resets or client deletion. Transaction and ownership writes commit together using a MongoDB transaction, so MongoDB must support transactions (Atlas or a replica set).

## Private setup for the platform owner

1. In a private terminal connected to the backend's database, run `npm --prefix backend run setup-pin-owner`. Choose your private owner key (4–72 bytes). The terminal hides your input and saves its bcrypt hash directly in MongoDB. On Render's shell, run `npm run setup-pin-owner` from the backend directory.
2. Keep the **original owner key** privately in your password manager. No PIN or owner-key environment variable is needed.
3. Sign in as superadmin, open **Administrators → Private PIN setup**, enter your original owner key, and choose a different 4-digit PIN for R, G, S, and V. Admin PINs must also differ from your owner key. Submit **Save private PINs**. Leave a field blank when keeping an existing PIN.
4. Give each admin only their own PIN privately. Keep the owner key to yourself. Someone sharing your superadmin login can see the setup button but cannot change PINs without that key. Knowing an admin's PIN grants that admin's client access; anyone you give the PIN to has that access.

Admin PINs and the owner key are stored as bcrypt hashes in MongoDB. Saved PINs and the owner key cannot be displayed in the dashboard; reset forgotten PINs through Private PIN setup. Plaintext PINs and the owner key are never logged or persisted. Setup requires both superadmin login and the private owner key, and setup does not unlock client phone numbers. Changing a PIN invalidates that admin's existing PIN sessions. Changing the owner key uses the same private terminal setup command.

Older environment hashes are imported into MongoDB once at backend startup, or with `npm --prefix backend run setup-pin-owner -- --migrate`. Existing database values take priority. After migration, remove obsolete `ADMIN_PIN_SETUP_KEY_HASH` and `ADMIN_PIN_R_HASH`/`G`/`S`/`V` variables. Runtime verification reads the database only.

Five PIN attempts per initial per 15 minutes are allowed across accounts/server replicas; owner setup has its own five-attempt limit. Sessions use random tokens stored as hashes, are bound to the account login token, and check expiry and current PIN configuration on the server. Admin responses use `Cache-Control: no-store`. Failed privacy lookups block the response. Player-facing flows are unchanged.

Deploy the backend and frontend together. No default PINs or owner key are installed. Claiming works before PIN setup; claimed numbers remain masked until their owner's PIN is configured and entered through **Unlock my clients**. New owner/session indexes are created at startup; confirm successful index setup in the deployment logs.
