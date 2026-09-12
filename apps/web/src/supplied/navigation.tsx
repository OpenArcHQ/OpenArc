import type { AnchorHTMLAttributes } from "react";

/** Map a design-packet route to the real URL it should point at. */
export function designHref(to: string): string {
  if (to.startsWith("/docs")) return `/design/docs${to.slice(5)}`;
  if (to.startsWith("/faq")) return `/design/faq${to.slice(4)}`;
  if (to === "/app") return "/workspace";
  if (to === "/") return "/design";
  return to;
}

export function Link({ to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  return <a {...props} href={designHref(to)} />;
}

/** View of the current pathname from the perspective of the design router. */
export function useLocation() {
  const pathname = window.location.pathname;
  if (pathname === "/design" || pathname === "/design/") return { pathname: "/" };
  if (pathname === "/design/docs") return { pathname: "/docs" };
  if (pathname === "/design/faq") return { pathname: "/faq" };
  return { pathname };
}

export function useNavigate() {
  return (to: string) => {
    window.location.assign(designHref(to));
  };
}
