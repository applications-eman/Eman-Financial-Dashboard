# WhatsApp router

One public webhook address for Meta. It checks Meta's signature and forwards each message to the service that owns the
sender's WhatsApp number. Code: `router/`. Tests: `cd router && npm test` (14 tests, no dependencies).

## Rules (what the code guarantees)
1. Unsigned or wrongly signed requests are dropped (401) and never forwarded.
2. A message goes to the service that owns the sender's number. Delivery receipts follow the recipient's number.
3. An unknown number, or a number whose service is switched off, is never forwarded.
4. A message id already forwarded is not forwarded again (Meta retries).
5. One POST with people of several services is split; each service gets only its own events, re-signed so its own
   signature check passes. A POST for one service is forwarded byte for byte.
6. If a service fails the router answers 502 so Meta retries.
7. Target addresses must be public https addresses (no IPs, no localhost, no internal names).
8. A number can belong to one service only.

Not routed here: the encrypted WhatsApp Flow data requests. Those go straight to the Flow's own address.

## Registry (first version: one secret)
Stored as the secret `eman-router-registry`, one line of JSON:

```json
{"targets":[{"id":"expense","name":"Expense capture","url":"https://YOUR-EXPENSE-SERVICE/whatsapp/webhook","enabled":true}],
 "numbers":[{"phone":"966500000001","target":"expense"}]}
```

The admin screen will later manage the same two lists (add a service = paste its address) without redeploying.

## Deploy
```
cd ~/Eman-Financial-Dashboard && git pull
PROJECT_ID=eman-expenses REGION=europe-west1 ./scripts/deploy-router.sh
```
The script asks for the secrets once and prints the webhook address. It never changes Meta.

## Switching Meta over (later, deliberately)
1. Test the router address with `curl <url>/health`.
2. Only then paste `<url>/webhook` and the verify token in Meta. Keep the old address written down: pointing Meta back is the rollback.
