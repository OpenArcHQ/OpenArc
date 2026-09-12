import { Link } from "../navigation.js";
import { Logo } from "../components/Brand";

const docs = [
  { label: "Engineering source of truth", to: "/docs?doc=source-of-truth" },
  { label: "Backend architecture", to: "/docs?doc=backend" },
  { label: "Frontend architecture", to: "/docs?doc=frontend" },
];
const navigation = [
  { label: "Stack", href: "#stack" },
  { label: "About", href: "#about" },
  { label: "Product", href: "#product" },
  { label: "Pillars", href: "#pillars" },
  { label: "Case Study", href: "#case-study" },
  { label: "Roadmap", href: "#roadmap" },
];
const resources = ["Privacy Policy", "Terms of Service", "Network Status"];

export default function Footer() {

  return (
    <footer className="relative overflow-hidden border-t border-line bg-[#eef3fa]">
      <div className="grid-lines absolute inset-0 opacity-60" />

      <div className="relative mx-auto max-w-[1400px] px-6 pt-20 pb-10">
        {/* top row */}
        <div className="reveal flex flex-col gap-10 md:flex-row md:items-start md:justify-between">
          <div className="max-w-[420px]">
            <div className="flex items-center gap-2.5">
              <Logo size={30} />
              <span className="text-[19px] font-bold tracking-[0.02em] text-ink">
                OPENARC
              </span>
            </div>
            <p className="mt-5 text-[15px] leading-[1.7] text-ink-2">
              A read-only evidence and investigation workspace for agent
              activity on Arc Testnet. Observe bounded public sources, keep
              private records in a local encrypted Vault, and label every
              conclusion by its source. The commerce target is in development.
            </p>
            <span className="mono mt-5 inline-block rounded-lg border border-line bg-white px-3 py-1.5 text-[11px] text-ink-2">
              ARC TESTNET · EIP-155:5042002
            </span>
          </div>
          <div className="md:text-right">
            <span className="mono text-[13px] text-ink-2">
              [ read-only · local workspace ]
            </span>
            <p
              className="mt-3 block text-[26px] md:text-[32px] font-bold tracking-[-0.02em] text-ink hover:text-blue transition-colors"
            >
              OpenArc
            </p>
          </div>
        </div>

        {/* middle card row */}
        <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="v-card reveal p-6">
            <span className="mono text-[13px] text-ink-2">[ newsletter ]</span>
            <h3 className="mt-3 text-[17px] font-semibold text-ink">
              Stay connected
            </h3>
            <p className="mt-4 text-[15px] text-ink-2">Newsletter signup is not enabled. This preview does not collect email addresses.</p>
          </div>

          <div className="v-card reveal p-6" style={{ transitionDelay: "0.08s" }}>
            <span className="mono text-[13px] text-ink-2">[ docs ]</span>
            <ul className="mt-4 space-y-2.5">
              {docs.map((d) => (
                <li key={d.label}>
                  <Link
                    to={d.to}
                    className="text-[15px] text-ink-2 transition-colors hover:text-ink"
                  >
                    {d.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <div className="v-card reveal p-6" style={{ transitionDelay: "0.16s" }}>
            <span className="mono text-[13px] text-ink-2">[ navigation ]</span>
            <ul className="mt-4 space-y-2.5">
              {navigation.map((n) => (
                <li key={n.label}>
                  <a
                    href={`/design${n.href}`}
                    className="text-[15px] text-ink-2 transition-colors hover:text-ink"
                  >
                    {n.label}
                  </a>
                </li>
              ))}
              <li>
                <Link
                  to="/app"
                  className="text-[15px] font-medium text-blue transition-colors hover:text-ink"
                >
                  Dashboard →
                </Link>
              </li>
            </ul>
          </div>

          <div className="v-card reveal p-6" style={{ transitionDelay: "0.24s" }}>
            <span className="mono text-[13px] text-ink-2">[ resources ]</span>
            <ul className="mt-4 space-y-2.5">
              {resources.map((r) => (
                <li key={r}>
                  <span
                    className="text-[15px] text-ink-2 transition-colors hover:text-ink"
                  >
                    {r} · pending
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* bottom bar */}
        <div className="mt-14 flex flex-col gap-3 border-t border-line pt-7 text-[13px] text-ink-2 md:flex-row md:items-center md:justify-between">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <span>© 2026 OpenArc | All Rights Reserved</span>
            <span>Built on Arc</span>
          </div>
          <span className="mono text-[12px]">NON-CUSTODIAL · READ-ONLY · ARC TESTNET</span>
        </div>
      </div>
    </footer>
  );
}
