/**
 * Public-shell account link.
 *
 * This is a plain navigation link to the dedicated `/account` page; it never
 * mounts the account UI, inspects a wallet or calls an auth endpoint. The
 * account page itself decides whether access is enabled for the deployment.
 */
export default function WalletButton({ compact = false }: { compact?: boolean }) {
  return (
    <a
      className="btn-ghost rounded-lg px-5 py-2.5 text-[14px] font-semibold"
      href="/account"
    >
      {compact ? "Account" : "Account & passkeys"}
    </a>
  );
}
