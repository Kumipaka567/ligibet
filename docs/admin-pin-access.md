# Admin PIN access

The normal dashboard login stays the same. The **Admin PIN** button selects a separate R, G, S, or V identity, even when people share a login account. PIN access lasts 15 minutes, stays in memory, and clears when leaving the dashboard or reloading the page. Use **Lock** before handing over a shared device.

Without a PIN, claimed clients' numbers are masked (for example `071*****78`). With a PIN, lists show that admin's clients and unclaimed clients. Unclaimed clients remain fully visible. Superadmin has exactly the same phone rules; its login does not reveal other admins' numbers or permit taking their clients.

Claiming requires a completed **deposit** and the PIN matching the selected initial. The first claim owns the client across transactions, users, withdrawals, online players, game monitoring, CSV export, audit logs, and support. Subsequent deposits cannot transfer ownership. Existing completed deposit claims are respected; if legacy deposits have conflicting initials, the earliest claim wins. Transaction and ownership writes commit together using a MongoDB transaction, so MongoDB must support transactions (Atlas or a replica set).

## Private setup for the platform owner

1. In a private terminal run `npm --prefix backend run setup-pin-owner`. Choose a strong owner key, at least 12 characters. The terminal hides your input. This command needs no database access and makes no account changes.
2. Copy the generated `ADMIN_PIN_SETUP_KEY_HASH=...` into the backend hosting environment (or `backend/.env` for local use), then restart/redeploy the backend. Store the **original owner key** privately in your password manager. The hash is not the key you enter in the dashboard.
3. Sign in as superadmin, open **Administrators → Private PIN setup**, enter your original owner key, and choose a different 6–8 digit PIN for R, G, S, and V. Submit **Save private PINs**. Leave a field blank when keeping an existing PIN.
4. Give each admin only their own PIN privately. Keep the owner key to yourself. Someone sharing your superadmin login can see the setup button but cannot change PINs without that key. Knowing an admin's PIN grants that admin's client access; anyone you give the PIN to has that access.

PINs are stored as bcrypt hashes. Saved PINs and the owner key cannot be displayed in the dashboard. Neither plaintext PINs nor the owner key are logged or stored by this feature. Setup requires both superadmin login and the private owner key, and setup does not unlock client phone numbers. Changing a PIN invalidates that admin's existing PIN sessions. Changing the owner key requires updating its backend environment hash.

Five PIN attempts per initial per 15 minutes are allowed across accounts/server replicas; owner setup has its own five-attempt limit. Sessions use random tokens stored as hashes, are bound to the account login token, and check expiry and current PIN configuration on the server. Admin responses use `Cache-Control: no-store`. Failed privacy lookups block the response. Player-facing flows are unchanged.

Deploy the backend and frontend together. No default PINs or owner key are installed. Before owner setup, claimed numbers remain masked and claiming requires a configured PIN. New owner/session indexes are created at startup; confirm successful index setup in the deployment logs.
