import { z } from "zod";

/**
 * Browser-only CSP bootstrap. Zod's JIT compiler probes `new Function(...)`
 * while a schema is constructed, and a strict `script-src 'self'` policy reports
 * that probe as a securitypolicyviolation. Disabling JIT before any schema is
 * constructed keeps the production console clean without weakening the policy.
 *
 * This module must be imported before `./App.js`, which pulls in
 * `@openarc/shared` and constructs zod schemas at module evaluation time.
 */
z.config({ jitless: true });
