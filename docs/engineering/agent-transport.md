# Writing an agent client for the OpenArc agent surfaces

The agent and headless surfaces refuse requests that look like they came from a
browser. This is deliberate: a browser-originated call must never reach a
surface that spends an agent's budget, and the check is part of the audience
separation between browser, agent and provider credentials.

## Node's global `fetch` cannot call these routes

Node's built-in `fetch` (undici) always sends `sec-fetch-mode: cors`. The agent
transport guard rejects that, so **every** call made with global `fetch` is
answered with `400 INVALID_REQUEST`, whatever the credential. `sec-fetch-*` is a
forbidden header name, so a caller cannot remove or override it.

The identical request made with `node:http` or `node:https` is accepted.

```js
// Refused with 400 INVALID_REQUEST, even with a valid commerce session.
await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}` } });
```

Write the request directly instead:

```js
import { request } from "node:https";
// or node:http for a loopback development stack
```

The reference implementations do exactly that: `tools/agent-harness` for the
buyer side and `tools/x402-reference-provider` for the seller side. Both send
only the headers the surface expects and never set a `sec-fetch-*` header.

## What the guard checks

- No `sec-fetch-mode`, `sec-fetch-site` or other browser fetch metadata.
- Exactly one credential, in the namespace that surface accepts: `oacs_v1_` for
  a buyer commerce session, `oas_pr_` with a grant token for a provider claim.
  A machine credential (`oas_ag_`) is refused on spending surfaces; it is valid
  only when exchanging it for a commerce session.
- No browser session cookie, CSRF token or browser client marker.

A browser client calls the browser audience with a cookie, an Origin, a client
marker and a CSRF token, and never carries an `Authorization` header. The two
sets are mutually exclusive by design: presenting both is refused.
