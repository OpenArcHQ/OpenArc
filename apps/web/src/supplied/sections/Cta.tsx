import { Link } from "../navigation.js";
import { DotSparkle } from "../components/Brand";

export default function Cta() {
  return (
    <section className="relative overflow-hidden border-t border-line">
      {/* blue tinted bg + grid */}
      <div className="absolute inset-0 bg-gradient-to-b from-[#eaf1fc] via-[#f3f7fd] to-bg" />
      <div className="grid-lines absolute inset-0" />

      {/* decorative sparkles */}
      <DotSparkle
        color="#e8a93b"
        className="absolute left-1/2 top-14 hidden -translate-x-1/2 md:block"
      />
      <DotSparkle
        color="#8fbf2f"
        className="absolute left-[8%] top-1/3 hidden md:block"
      />
      <DotSparkle
        color="#0fb5d6"
        className="absolute right-[8%] top-1/3 hidden md:block"
      />
      <DotSparkle
        color="#0d1b2e"
        className="absolute bottom-16 left-[18%] hidden opacity-40 lg:block"
      />
      <DotSparkle
        color="#0f62fe"
        className="absolute bottom-16 right-[18%] hidden opacity-40 lg:block"
      />

      {/* mono agent request log */}
      <div className="mono pointer-events-none absolute bottom-6 left-[6%] hidden text-left text-[11px] leading-[1.9] text-ink/25 lg:block">
        <p>agent_request:</p>
        <p>&gt; review synthetic purchase proposal · max 25.00 USDC</p>
        <p>simulating locally…</p>
        <p>→ checking policy constraints</p>
        <p>→ comparing payment intent</p>
        <p>→ no provider call or signing</p>
        <p>output:</p>
        <p>+ synthetic proposal · scope: dataset</p>
        <p>+ cap 25.00 USDC · local review only</p>
        <p>+ evidence: illustrative record</p>
        <p>status: PROPOSED ✓ (not authorized or paid)</p>
      </div>

      <div className="relative mx-auto max-w-[1400px] px-6 pt-28 pb-24 text-center md:pt-36 md:pb-32">
        <div className="reveal">
          <span className="tag-label">[ explore the preview ]</span>
          <h2 className="mt-4 text-[44px] md:text-[64px] font-bold leading-[1.05] tracking-[-0.03em] text-ink">
            Investigate agent activity
            <br />
            with <span className="grad-text">evidence first</span>
          </h2>
          <p className="mx-auto mt-6 max-w-[620px] text-[17px] leading-[1.6] text-ink-2">
            Explore local evidence, policy comparison, and a simulated action workflow
            with attributable context. This design preview does not execute purchases.
          </p>
          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <Link
              to="/app"
              className="btn-grad inline-flex h-[52px] items-center rounded-xl px-7 text-[15px] font-semibold text-white"
            >
              Open Dashboard
            </Link>
            <Link
              to="/docs"
              className="btn-ghost inline-flex h-[52px] items-center rounded-xl px-7 text-[15px] font-semibold"
            >
              Read the Docs
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
