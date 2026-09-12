import { CommerceListingIdSchema } from "@openarc/shared";

/**
 * Protected provider-listing route parser.
 *
 * The three protected routes root under `/app/provider/listings`:
 *   - `/app/provider/listings`                 (bounded owner root list)
 *   - `/app/provider/listings/new`             (first-draft create form)
 *   - `/app/provider/listings/:listingId`      (root detail + version history)
 *
 * `/new` is matched BEFORE the dynamic id branch so it can never be read as a
 * listing id. A dynamic id is decoded EXACTLY once and must round-trip to its
 * own canonical percent-encoding: residual escapes, slashes, backslashes,
 * control characters, non-ASCII lookalikes and unknown suffixes are rejected
 * without constructing any listing client or issuing any request.
 */

export const LISTING_ROOTS_PATH = "/app/provider/listings" as const;
export const LISTING_NEW_PATH = "/app/provider/listings/new" as const;

export type ListingRoute =
  | { readonly kind: "roots" }
  | { readonly kind: "new" }
  | { readonly kind: "detail"; readonly listingId: string }
  | { readonly kind: "invalid" };

/** A stable href for a parsed route; a detail route always re-encodes once. */
export function listingRouteHref(route: ListingRoute): string {
  switch (route.kind) {
    case "roots":
      return LISTING_ROOTS_PATH;
    case "new":
      return LISTING_NEW_PATH;
    case "detail":
      return `${LISTING_ROOTS_PATH}/${encodeURIComponent(route.listingId)}`;
    case "invalid":
      return LISTING_ROOTS_PATH;
  }
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      return true;
    }
  }
  return false;
}

/**
 * Rejects any segment that is not the canonical single encoding of a listing
 * id. `%25` (a literal percent sign) would decode to a residual escape, a
 * slash/backslash cannot appear in a path segment, and a non-ASCII character
 * would be a lookalike. The round-trip re-encode check also rejects a segment
 * whose escapes are non-canonical (for example lowercase/uppercase hex
 * differences or unnecessary escapes).
 */
function decodeCanonicalListingId(rawSegment: string): string | null {
  if (rawSegment.length === 0) return null;
  if (rawSegment.includes("/") || rawSegment.includes("\\")) return null;
  if (hasControlCharacter(rawSegment)) return null;
  if (!/^[\x20-\x7e]*$/u.test(rawSegment)) return null;
  if (rawSegment.includes("%25")) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawSegment);
  } catch {
    return null;
  }
  if (decoded.includes("%") || decoded.includes("/") || decoded.includes("\\")) return null;
  const parsed = CommerceListingIdSchema.safeParse(decoded);
  if (!parsed.success) return null;
  if (encodeURIComponent(parsed.data) !== rawSegment) return null;
  return parsed.data;
}

/**
 * Parses a pathname into a listing route, or returns null when the pathname is
 * not part of the listing subtree at all. A pathname inside the subtree whose
 * dynamic segment is malformed yields `{ kind: "invalid" }` so the caller can
 * render an honest unavailable state without any request.
 */
export function parseListingRoute(pathname: string): ListingRoute | null {
  const normalized = pathname.replace(/\/+$/u, "") || "/";
  if (normalized === LISTING_ROOTS_PATH) return { kind: "roots" };
  if (!normalized.startsWith(`${LISTING_ROOTS_PATH}/`)) return null;
  const rest = normalized.slice(LISTING_ROOTS_PATH.length + 1);
  if (rest === "new") return { kind: "new" };
  if (rest.includes("/")) return { kind: "invalid" };
  const listingId = decodeCanonicalListingId(rest);
  if (listingId === null) return { kind: "invalid" };
  return { kind: "detail", listingId };
}

/** True for any pathname in the protected listing subtree. */
export function isListingPath(pathname: string): boolean {
  return parseListingRoute(pathname) !== null;
}
