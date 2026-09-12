import {
  API_CLIENT_HEADER,
  AccountBootstrapResponseSchema,
  AccountEmptyRequestSchema,
  AccountPasskeyAddVerifyRequestSchema,
  AccountPasskeyAuthenticationOptionsResponseSchema,
  AccountPasskeyLoginVerifyRequestSchema,
  AccountPasskeyRegistrationOptionsResponseSchema,
  AccountPasskeyRegisterVerifyRequestSchema,
  AccountRecoveryCodesResponseSchema,
  AccountRecoveryRedeemRequestSchema,
  AccountRegisterOptionsRequestSchema,
  AccountSessionResponseSchema,
  AccountSessionViewSchema,
  AccountWalletAddressRequestSchema,
  AccountWalletOptionsResponseSchema,
  AccountWalletVerifyRequestSchema,
  COMMERCE_API_SCHEMA_VERSION,
  CommerceApiMetaSchema,
  type CommerceApiMeta,
} from "@openarc/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z, type ZodType } from "zod";

import { AUTH_ERRORS, AuthApiError } from "./errors.js";
import {
  parseAuthCookies,
  type AuthCookieNames,
  type ParsedAuthCookies,
} from "./cookies.js";
import type { AuthRequestContext, AuthService } from "./service.js";

/**
 * Encapsulated Fastify plugin for the account-only `/v2/auth/*` surface.
 * Every handler is strict: exact Origin, custom client header, JSON media
 * type, no query string, bounded body and (except bootstrap) a CSRF token
 * bound to the binding cookie and current session hash.
 */

export const AUTH_ROUTES = Object.freeze({
  bootstrap: "/v2/auth/bootstrap",
  session: "/v2/auth/session",
  registerOptions: "/v2/auth/passkeys/register/options",
  registerVerify: "/v2/auth/passkeys/register/verify",
  loginOptions: "/v2/auth/passkeys/login/options",
  loginVerify: "/v2/auth/passkeys/login/verify",
  addOptions: "/v2/auth/passkeys/add/options",
  addVerify: "/v2/auth/passkeys/add/verify",
  walletLoginOptions: "/v2/auth/wallets/login/options",
  walletLoginVerify: "/v2/auth/wallets/login/verify",
  walletLinkOptions: "/v2/auth/wallets/link/options",
  walletLinkVerify: "/v2/auth/wallets/link/verify",
  recoveryCodes: "/v2/auth/recovery/codes",
  recoveryRedeem: "/v2/auth/recovery/redeem",
  logout: "/v2/auth/logout",
} as const);

export const AUTH_ROUTE_PATHS: readonly string[] = Object.values(AUTH_ROUTES);

export interface AuthRoutesOptions {
  appOrigin: string;
  cookieNames: AuthCookieNames;
  service: AuthService;
  buildSha: string;
  enabled: boolean;
}

type HttpMethod = "GET" | "POST";

function meta(request: FastifyRequest, buildSha: string): CommerceApiMeta {
  return CommerceApiMetaSchema.parse({
    schemaVersion: COMMERCE_API_SCHEMA_VERSION,
    requestId: request.id,
    buildSha,
  });
}

function strictHeader(headers: Record<string, unknown>, key: string): unknown {
  const value = headers[key];
  if (Array.isArray(value)) throw AUTH_ERRORS.invalidRequest();
  return value;
}

function enforceTransport(
  request: FastifyRequest,
  options: AuthRoutesOptions,
  method: HttpMethod,
  requireJson: boolean,
): void {
  if (request.url.includes("?")) throw AUTH_ERRORS.invalidRequest();
  if (request.method !== method) throw new AuthApiError("INVALID_REQUEST", 405, "METHOD_NOT_ALLOWED");
  if (strictHeader(request.headers, "authorization") !== undefined) {
    throw AUTH_ERRORS.invalidRequest();
  }
  if (strictHeader(request.headers, "x-openarc-client") !== API_CLIENT_HEADER) {
    throw AUTH_ERRORS.originRejected();
  }
  const origin = strictHeader(request.headers, "origin");
  const site = strictHeader(request.headers, "sec-fetch-site");
  const mode = strictHeader(request.headers, "sec-fetch-mode");
  const destination = strictHeader(request.headers, "sec-fetch-dest");
  if (origin === options.appOrigin) {
    // exact same-origin request
  } else if (
    origin === undefined &&
    method === "GET" &&
    site === "same-origin"
  ) {
    // originless same-origin GET is the only originless allowance
  } else {
    throw AUTH_ERRORS.originRejected();
  }
  if (site !== undefined && site !== "same-origin") throw AUTH_ERRORS.originRejected();
  if (mode !== undefined && mode !== "cors" && mode !== "same-origin") {
    throw AUTH_ERRORS.originRejected();
  }
  if (destination !== undefined && destination !== "empty") {
    throw AUTH_ERRORS.originRejected();
  }
  if (requireJson) {
    const contentType = strictHeader(request.headers, "content-type");
    if (
      typeof contentType !== "string" ||
      !/^application\/json(?:; *charset=utf-8)?$/iu.test(contentType)
    ) {
      throw AUTH_ERRORS.unsupportedMedia();
    }
  }
}

function parseCookies(request: FastifyRequest, names: AuthCookieNames): ParsedAuthCookies {
  try {
    return parseAuthCookies(request.headers.cookie, names);
  } catch {
    throw AUTH_ERRORS.invalidRequest();
  }
}

function parseBody<T>(schema: ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw AUTH_ERRORS.invalidRequest();
  return parsed.data;
}

function send(
  request: FastifyRequest,
  reply: FastifyReply,
  buildSha: string,
  data: unknown,
  headers: {
    setCookies?: readonly string[];
    clearCookies?: readonly string[];
  } = {},
): FastifyReply {
  const cookies = [
    ...(headers.setCookies ?? []),
    ...(headers.clearCookies ?? []),
  ];
  if (cookies.length > 0) reply.header("Set-Cookie", cookies);
  return reply.send({
    ok: true,
    data,
    meta: meta(request, buildSha),
  });
}

export function registerAuthRoutes(
  app: FastifyInstance,
  options: AuthRoutesOptions,
): void {
  if (!options.enabled) {
    for (const path of AUTH_ROUTE_PATHS) {
      app.all(path, { onRequest: async () => {
        throw AUTH_ERRORS.featureDisabled();
      } }, async () => undefined);
    }
    return;
  }

  const requestContext = (request: FastifyRequest): AuthRequestContext => ({
    peerIp: request.ip,
    cookies: parseCookies(request, options.cookieNames),
  });

  const csrfHeader = (request: FastifyRequest): unknown =>
    strictHeader(request.headers, "x-openarc-csrf");

  app.all(AUTH_ROUTES.bootstrap, { onRequest: async (request) => {
    enforceTransport(request, options, "POST", true);
  } }, async (request, reply) => {
    parseBody(AccountEmptyRequestSchema, request.body);
    const result = await options.service.bootstrap(requestContext(request));
    return send(
      request,
      reply,
      options.buildSha,
      AccountBootstrapResponseSchema.parse({
        csrfToken: result.csrfToken,
        session: result.session,
      }),
      { setCookies: result.setCookies, clearCookies: result.clearCookies },
    );
  });

  app.all(AUTH_ROUTES.session, { onRequest: async (request) => {
    enforceTransport(request, options, "GET", false);
  } }, async (request, reply) => {
    const result = await options.service.session(requestContext(request));
    return send(
      request,
      reply,
      options.buildSha,
      { session: AccountSessionViewSchema.parse(result.session) },
      { clearCookies: result.clearCookies },
    );
  });

  const csrfGuard = (request: FastifyRequest): string => {
    const cookies = parseCookies(request, options.cookieNames);
    return options.service.verifyCsrf(cookies, csrfHeader(request));
  };

  app.all(AUTH_ROUTES.registerOptions, { onRequest: async (request) => {
    enforceTransport(request, options, "POST", true);
    csrfGuard(request);
  } }, async (request, reply) => {
    parseBody(AccountRegisterOptionsRequestSchema, request.body);
    const result = await options.service.registerOptions(requestContext(request));
    return send(
      request,
      reply,
      options.buildSha,
      AccountPasskeyRegistrationOptionsResponseSchema.parse(result),
    );
  });

  app.all(AUTH_ROUTES.registerVerify, { onRequest: async (request) => {
    enforceTransport(request, options, "POST", true);
    csrfGuard(request);
  } }, async (request, reply) => {
    const body = parseBody(AccountPasskeyRegisterVerifyRequestSchema, request.body);
    const result = await options.service.registerVerify(
      requestContext(request),
      body,
    );
    return send(
      request,
      reply,
      options.buildSha,
      AccountSessionResponseSchema.parse({
        csrfToken: result.csrfToken,
        session: result.session,
      }),
      { setCookies: result.setCookies },
    );
  });

  app.all(AUTH_ROUTES.loginOptions, { onRequest: async (request) => {
    enforceTransport(request, options, "POST", true);
    csrfGuard(request);
  } }, async (request, reply) => {
    parseBody(AccountEmptyRequestSchema, request.body);
    const result = await options.service.loginOptions(requestContext(request));
    return send(
      request,
      reply,
      options.buildSha,
      AccountPasskeyAuthenticationOptionsResponseSchema.parse(result),
    );
  });

  app.all(AUTH_ROUTES.loginVerify, { onRequest: async (request) => {
    enforceTransport(request, options, "POST", true);
    csrfGuard(request);
  } }, async (request, reply) => {
    const body = parseBody(AccountPasskeyLoginVerifyRequestSchema, request.body);
    const result = await options.service.loginVerify(
      requestContext(request),
      body,
    );
    return send(
      request,
      reply,
      options.buildSha,
      AccountSessionResponseSchema.parse({
        csrfToken: result.csrfToken,
        session: result.session,
      }),
      { setCookies: result.setCookies },
    );
  });

  app.all(AUTH_ROUTES.addOptions, { onRequest: async (request) => {
    enforceTransport(request, options, "POST", true);
    csrfGuard(request);
  } }, async (request, reply) => {
    parseBody(AccountEmptyRequestSchema, request.body);
    const result = await options.service.addOptions(requestContext(request));
    return send(
      request,
      reply,
      options.buildSha,
      AccountPasskeyRegistrationOptionsResponseSchema.parse(result),
    );
  });

  app.all(AUTH_ROUTES.addVerify, { onRequest: async (request) => {
    enforceTransport(request, options, "POST", true);
    csrfGuard(request);
  } }, async (request, reply) => {
    const body = parseBody(AccountPasskeyAddVerifyRequestSchema, request.body);
    const result = await options.service.addVerify(
      requestContext(request),
      body,
    );
    return send(
      request,
      reply,
      options.buildSha,
      AccountSessionResponseSchema.parse({
        csrfToken: result.csrfToken,
        session: result.session,
      }),
    );
  });

  app.all(AUTH_ROUTES.walletLoginOptions, { onRequest: async (request) => {
    enforceTransport(request, options, "POST", true);
    csrfGuard(request);
  } }, async (request, reply) => {
    const body = parseBody(AccountWalletAddressRequestSchema, request.body);
    const result = await options.service.walletLoginOptions(
      requestContext(request),
      body,
    );
    return send(
      request,
      reply,
      options.buildSha,
      AccountWalletOptionsResponseSchema.parse(result),
    );
  });

  app.all(AUTH_ROUTES.walletLoginVerify, { onRequest: async (request) => {
    enforceTransport(request, options, "POST", true);
    csrfGuard(request);
  } }, async (request, reply) => {
    const body = parseBody(AccountWalletVerifyRequestSchema, request.body);
    const result = await options.service.walletLoginVerify(
      requestContext(request),
      body,
    );
    return send(
      request,
      reply,
      options.buildSha,
      AccountSessionResponseSchema.parse({
        csrfToken: result.csrfToken,
        session: result.session,
      }),
      { setCookies: result.setCookies },
    );
  });

  app.all(AUTH_ROUTES.walletLinkOptions, { onRequest: async (request) => {
    enforceTransport(request, options, "POST", true);
    csrfGuard(request);
  } }, async (request, reply) => {
    const body = parseBody(AccountWalletAddressRequestSchema, request.body);
    const result = await options.service.walletLinkOptions(
      requestContext(request),
      body,
    );
    return send(
      request,
      reply,
      options.buildSha,
      AccountWalletOptionsResponseSchema.parse(result),
    );
  });

  app.all(AUTH_ROUTES.walletLinkVerify, { onRequest: async (request) => {
    enforceTransport(request, options, "POST", true);
    csrfGuard(request);
  } }, async (request, reply) => {
    const body = parseBody(AccountWalletVerifyRequestSchema, request.body);
    const result = await options.service.walletLinkVerify(
      requestContext(request),
      body,
    );
    return send(
      request,
      reply,
      options.buildSha,
      AccountSessionResponseSchema.parse({
        csrfToken: result.csrfToken,
        session: result.session,
      }),
    );
  });

  app.all(AUTH_ROUTES.recoveryCodes, { onRequest: async (request) => {
    enforceTransport(request, options, "POST", true);
    csrfGuard(request);
  } }, async (request, reply) => {
    parseBody(AccountEmptyRequestSchema, request.body);
    const result = await options.service.recoveryCodes(requestContext(request));
    return send(
      request,
      reply,
      options.buildSha,
      AccountRecoveryCodesResponseSchema.parse(result),
    );
  });

  app.all(AUTH_ROUTES.recoveryRedeem, { onRequest: async (request) => {
    enforceTransport(request, options, "POST", true);
    csrfGuard(request);
  } }, async (request, reply) => {
    const body = parseBody(AccountRecoveryRedeemRequestSchema, request.body);
    const result = await options.service.recoveryRedeem(
      requestContext(request),
      body,
    );
    return send(
      request,
      reply,
      options.buildSha,
      AccountSessionResponseSchema.parse({
        csrfToken: result.csrfToken,
        session: result.session,
      }),
      { setCookies: result.setCookies },
    );
  });

  app.all(AUTH_ROUTES.logout, { onRequest: async (request) => {
    enforceTransport(request, options, "POST", true);
    csrfGuard(request);
  } }, async (request, reply) => {
    parseBody(AccountEmptyRequestSchema, request.body);
    const result = await options.service.logout(requestContext(request));
    return send(request, reply, options.buildSha, { session: { signedIn: false } }, {
      clearCookies: result.clearCookies,
    });
  });
}

/** Type-only re-export to keep the route module's public surface explicit. */
export type { AuthRoutesOptions as RegisteredAuthRoutesOptions };
export { z };
