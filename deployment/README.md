# PayHero callback host

The two forwarding rules are published in the Feva Vercel project's CDN Routing
Rules. They run before the website's SPA fallback. No Feva source deployment or
frontend-domain change is required.

| App | Callback URL | Existing handler |
| --- | --- | --- |
| BetPesa | https://www.fevaafrica.com/api/callbacks/betpesa | https://api.betpesa.site/api/mpesa/callback |
| Ligitok | https://www.fevaafrica.com/api/callbacks/ligitok | https://api.ligibet.site/api/mpesa/callback |

Use the canonical www hostname to avoid the existing apex-to-www redirect. The
forwarding rules preserve POST payloads, query parameters and upstream responses.
Empty callbacks returned the existing callback JSON response; malformed JSON
returned the backend's 400 response. Both app sites, Feva and both API health
checks remained available. No real payment was initiated during these checks.

Local .env and example settings point to these URLs. Set PAYHERO_CALLBACK_URL on
each Render service separately, preserving any existing token query parameter
and PAYHERO_CALLBACK_TOKEN. Do not change API credentials, channel, database,
frontend API origin or other payment settings. After switching, the owner should
verify a controlled deposit on each app through receipt and wallet credit.

fevaafrica.rewrites.json is an optional source-configuration equivalent. Merge its
rules before the SPA catch-all in Feva's existing frontend/vercel.json if moving
routing into source control; do not replace the rest of Feva's configuration.

## Rollback

Restore only PAYHERO_CALLBACK_URL to the previous direct API URL, retaining any
token query parameter. Keep the Feva forwarding routes available for callbacks
from payments initiated with the Feva URLs. No database migration is needed.

References: https://docs.payhero.co.ke/docs/payment-callback and
https://vercel.com/docs/routing/project-routing-rules.
