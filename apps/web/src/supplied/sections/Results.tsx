import { Link } from "../navigation.js"
import { Logo, DotSparkle } from '../components/Brand'

const classes = [
  { label: 'local', color: '#8a96a8' },
  { label: 'signed', color: '#0f62fe' },
  { label: 'agent-reported', color: '#0fb5d6' },
  { label: 'provider', color: '#e8a93b' },
  { label: 'openarc-derived', color: '#8fbf2f' },
  { label: 'Gateway', color: '#0a4fd0' },
  { label: 'onchain', color: '#0f62fe' },
  { label: 'evaluator', color: '#e05a4e' },
  { label: 'OpenArc-derived', color: '#0d1b2e' },
]

export default function Results() {
  return (
    <section className="section-shell py-24" id="evidence">
      <div className="mx-auto max-w-[1400px] px-6 text-center">
        <p className="tag-label reveal">[ proof ]</p>
        <h2 className="reveal reveal-d1 mt-4 text-[40px] md:text-[56px] leading-[1.08] font-bold tracking-[-0.03em] text-ink">
          Every claim cites its source
        </h2>
        <p className="reveal reveal-d2 mx-auto mt-5 max-w-[560px] text-[17px] text-ink-2">
          Evidence classes and action states stay distinct in one local graph.<br className="hidden md:block" /> Missing links remain something you can see.
        </p>

        <div className="mt-14 grid gap-5 lg:grid-cols-3 text-left">
          {/* big card */}
          <div className="reveal v-card flex flex-col p-8 lg:row-span-2">
            <div className="flex items-center gap-2">
              <Logo size={22} />
              <span className="text-[14px] font-bold tracking-tight text-ink">OPENARC</span>
            </div>
            <div className="mt-auto pt-24">
              <h3 className="text-[26px] font-semibold tracking-tight text-ink">Stay in control</h3>
              <p className="mt-3 text-[15px] leading-relaxed text-ink-2">
                Review imported, observed, and synthetic action records without implying real-time execution. OpenArc never holds agent keys.
              </p>
              <p className="mt-3 text-[13.5px] italic text-[#8a96a8]">No more trusting screenshots and status pages.</p>
              <Link to="/app" className="btn-grad mt-6 inline-block rounded-lg px-5 py-2.5 text-[14px] font-semibold text-white">
                Open the Console
              </Link>
            </div>
          </div>

          {/* settlement is not quality */}
          <div className="reveal reveal-d1 v-card p-7 lg:col-span-2">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-start gap-3.5">
                <DotSparkle color="#e8a93b" />
                <div>
                  <h3 className="text-[20px] font-semibold tracking-tight text-ink">Settlement is not quality</h3>
                  <p className="mt-1 text-[13.5px] italic text-[#8a96a8]">States are explicit and separate; nothing skips ahead silently.</p>
                </div>
              </div>
              <div className="hidden sm:flex items-center gap-1 rounded-lg border border-[#e5e9f0] bg-white px-2 py-1.5 text-ink-2">
                <span className="mono px-1.5 text-[11px] font-medium text-[#0f62fe]">AUTHORIZED</span>
                <span className="text-[#c3c4c4]">≠</span>
                <span className="mono px-1.5 text-[11px] font-medium text-[#e8a93b]">PROPOSED</span>
                <span className="text-[#c3c4c4]">≠</span>
                <span className="mono px-1.5 text-[11px] font-medium text-[#0fb5d6]">UNVERIFIED</span>
                <span className="text-[#c3c4c4]">≠</span>
                <span className="mono px-1.5 text-[11px] font-medium text-[#8fbf2f]">UNVERIFIED</span>
              </div>
            </div>
          </div>

          {/* stats */}
          <div className="reveal reveal-d1 v-card p-7">
            <p className="mono text-[12px] uppercase tracking-wide text-ink-2">Evidence classes</p>
            <p className="grad-text mt-3 text-[52px] font-semibold leading-none tracking-[-0.03em]">9</p>
            <p className="mt-4 border-t border-[#f0f0f0] pt-4 text-[14px] leading-relaxed text-ink-2">
              Distinct, fail-closed classes where missing evidence stays missing, never interpolated.
            </p>
          </div>
          <div className="reveal reveal-d2 v-card p-7">
            <p className="mono text-[12px] uppercase tracking-wide text-ink-2">Target summary states</p>
            <p className="grad-text mt-3 text-[52px] font-semibold leading-none tracking-[-0.03em]">17</p>
            <p className="mt-4 border-t border-[#f0f0f0] pt-4 text-[14px] leading-relaxed text-ink-2">
              A bounded target lifecycle defined by the in-development commerce contracts, with each
              available transition attributable. Not an enabled payment or delivery flow.
            </p>
          </div>

          {/* evidence class row */}
          <div className="reveal reveal-d2 v-card p-7 lg:col-span-2">
            <h3 className="text-[20px] font-semibold tracking-tight text-ink">One graph, every source</h3>
            <p className="mt-1 text-[13.5px] italic text-[#8a96a8]">From local traces to bounded observations.</p>
            <div className="mt-6 flex flex-wrap items-center gap-3 overflow-hidden">
              {classes.map((c) => (
                <span key={c.label} className="mono flex h-[52px] shrink-0 items-center gap-2 rounded-xl border border-[#e5e9f0] bg-white px-4 shadow-sm text-[12px] text-ink-2">
                  <i className="h-2 w-2 rounded-full" style={{ background: c.color }} />
                  {c.label}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
