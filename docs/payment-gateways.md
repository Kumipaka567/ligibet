# Deposit payment gateways

Each installation has one active gateway for **new M-Pesa deposits**. An authenticated admin selects **PayHero** or **Nexus Pay** in **Admin dashboard → Payment settings → Deposit payment gateway** and clicks **Save active gateway**. The choice is stored in that installation's MongoDB database and is read for each new request. PayHero is the default. Customers keep the normal deposit screen and cannot select or override the gateway.

Every deposit records its provider before an STK prompt is sent. Changing the active gateway does not move, retry or cancel existing payments. Their status checks and confirmations continue with the original provider. There is no automatic gateway failover.

## Nexus Pay configuration

On each backend hosting service, configure:

```dotenv
NEXUSPAY_BASE_URL=https://makamescopay.com/api
NEXUSPAY_API_KEY=<your private Nexus Pay key>
```

Optional routing, when needed:

```dotenv
NEXUSPAY_SETTLEMENT_ACCOUNT_ID=<positive settlement account ID>
NEXUSPAY_TENANT_CODE=<tenant code>
```

Tenant routing takes priority over the settlement account, as specified by the provider. If both are omitted, the provider uses its default settlement/platform wallet. Configure the appropriate account for each site. Keys remain on the backend; the dashboard reports only whether each gateway is configured. Never put keys in frontend settings or commit real keys.

Nexus Pay uses the supplied Makamesco Pay endpoints: `POST /payments/stkpush` and `GET /payments/status/:checkoutRequestId`, authenticated with `X-API-Key`. The live status API can omit `checkoutRequestId` from its response despite the documentation example; the authenticated request URL identifies the payment. If the response includes an ID, it must match. A completed result still requires the matching amount, phone and a valid receipt. Its Daraja callback belongs to the provider at `https://makamescopay.com/api/payments/callback`; it is not an application webhook and is not registered on our server. The application verifies payments by authenticated server-side polling.

The customer's foreground checks run every four seconds for up to sixty seconds. The backend also reconciles pending payments every five seconds, including after a restart, an admin switch, or closing the prompt. Missing confirmation or a transport timeout is not treated as proof of failed payment. A local close action stops waiting; it cannot cancel an STK payment at the provider. A confirmed cancellation or failure is recorded as failed in the existing transaction display.

## Payment integrity and rollout

Completed payments require a matching amount, Nexus checkout ID and payer phone, plus a receipt. A receipt ledger prevents the same M-Pesa receipt from crediting two deposits across either gateway. Deposit status, balance credit, receipt ownership and the transaction history update commit in one MongoDB transaction. Atlas or a replica set is required. A failed operation rolls back; concurrent polls and callbacks cannot credit twice.

PayHero retains its existing authentication/channel/callback settings. A callback with a configured shared secret must authenticate. When no callback secret is configured, a callback is only a hint: the backend verifies through PayHero's authenticated API before crediting. Exact stored request references are used; matching amount, phone and time alone is insufficient.

Deploy the backend and frontend together. Add the Nexus API key and restart the backend; Nexus Pay becomes selectable when its required configuration is valid. Configuration readiness checks do not authenticate the key with the provider. After deployment, use an authorized small test deposit, confirm receipt and balance once, then check that switching back still lets an older pending Nexus payment settle. No live prompts are sent by the automated tests, and no gateway is switched in the live database by this code change.

These APIs cover deposits only. The existing withdrawal approval/payout flow stays as implemented; Nexus payout APIs were not included in the supplied documentation.
