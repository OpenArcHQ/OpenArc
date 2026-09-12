import { DotChip } from '../components/Brand'

const blindLog = [
  { row: 'tx 0x8f3e…2a1c · 240.00 USDC', chip: 'NO RECEIPT', color: '#e05a4e' },
  { row: 'job #4412 · status: “done”', chip: 'UNVERIFIED', color: '#e05a4e' },
  { row: 'agent 7b9f · keys held by platform', chip: 'CUSTODIAL', color: '#8a96a8' },
]

const receipt = [
  { row: 'synthetic action · listing reference', states: ['PROPOSED', 'REVIEW ONLY'], done: false },
  { row: 'delivery reference · unverified', states: ['FULFILLMENT UNVERIFIED', 'SETTLEMENT UNVERIFIED'], done: false },
]

const STATE_COLORS: Record<string, string> = {
  AUTHORIZED: '#0f62fe',
  'REVIEW ONLY': '#e8a93b',
  'FULFILLMENT UNVERIFIED': '#0fb5d6',
  'SETTLEMENT UNVERIFIED': '#8fbf2f',
}

export default function Difference() {
  return (
    <section className="section-shell py-24" id="product">
      <div className="mx-auto max-w-[1400px] px-6 text-center">
        <p className="tag-label reveal">[ the difference ]</p>
        <h2 className="reveal reveal-d1 mt-4 text-[40px] font-bold leading-[1.08] tracking-[-0.03em] text-ink md:text-[56px]">
          Where blind trust ends,<br />verifiable evidence begins
        </h2>
        <p className="reveal reveal-d2 mx-auto mt-5 max-w-[560px] text-[17px] text-ink-2">
          Two failure modes dominate agent activity today. OpenArc keeps both visible: missing
          receipts stay missing, and no claim runs ahead of its source.
        </p>

        <div className="mt-14 grid items-stretch gap-5 text-left lg:grid-cols-[1fr_72px_1.12fr]">
          {/* the old way */}
          <div className="reveal group relative overflow-hidden v-card p-8 transition-all duration-300 hover:-translate-y-1 hover:shadow-[0_24px_60px_-24px_rgba(13,27,46,0.18)]">
            <span className="absolute inset-x-0 top-0 h-[4px] bg-gradient-to-r from-[#e05a4e] to-[#e05a4e]/30 transition-all duration-300 group-hover:h-[6px]" />
            <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-[#0d1b2e]">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#e05a4e" strokeWidth="2.6" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
            </span>
            <h3 className="mt-6 text-[26px] font-semibold tracking-tight text-ink">The old way</h3>
            <p className="mt-2.5 text-[15px] leading-relaxed text-ink-2">
              Agents spend first and explain later, if they can. Platforms hold the keys, and “it worked” is the only receipt you get.
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              <DotChip color="#e05a4e">ungated spend</DotChip>
              <DotChip color="#8a96a8">no receipts</DotChip>
              <DotChip color="#e05a4e">irreversible mistakes</DotChip>
            </div>
            {/* blind log visual */}
            <div className="mt-7 rounded-xl border border-[#edf0f5] bg-[#fafbfc] p-4">
              <p className="mono mb-3 text-[10.5px] uppercase tracking-[0.14em] text-ink-3">what you actually get</p>
              <div className="space-y-2.5">
                {blindLog.map(l => (
                  <div key={l.row} className="flex flex-wrap items-center justify-between gap-2">
                    <span className="mono text-[12px] text-ink-2 line-through decoration-[#e05a4e]/50">{l.row}</span>
                    <span className="mono rounded-md px-2 py-0.5 text-[9.5px] font-medium tracking-wide" style={{ color: l.color, background: `${l.color}14` }}>{l.chip}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* versus divider */}
          <div className="reveal reveal-d1 relative flex items-center justify-center py-2 lg:py-0">
            <span className="absolute inset-y-0 left-1/2 hidden w-px bg-gradient-to-b from-transparent via-[#d6dce6] to-transparent lg:block" />
            <span className="absolute inset-x-0 top-1/2 h-px bg-gradient-to-r from-transparent via-[#d6dce6] to-transparent lg:hidden" />
            <span className="btn-grad mono relative z-10 flex h-[60px] w-[60px] items-center justify-center rounded-full text-[13px] font-bold text-white shadow-[0_16px_40px_-12px_rgba(10,79,208,0.5)]">
              VS
            </span>
          </div>

          {/* the openarc way */}
          <div className="reveal reveal-d2 grad-border group relative overflow-hidden rounded-[16px] p-8 shadow-[0_28px_70px_-24px_rgba(10,79,208,0.35)]">
            <span className="absolute inset-x-0 top-0 h-[5px]" style={{ background: 'var(--grad)', backgroundSize: '220% 220%', backgroundPosition: '18% 50%' }} />
            <span className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-[#0f62fe]/10 blur-3xl" />
            <span className="btn-grad flex h-12 w-12 items-center justify-center rounded-xl">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 13l4 4L19 7" /></svg>
            </span>
            <h3 className="mt-6 text-[26px] font-semibold tracking-tight text-ink">The OpenArc way</h3>
            <p className="mt-2.5 text-[15px] leading-relaxed text-ink-2">
          Every available observation is scoped, consented, and labelled by evidence class. This is an interface you can inspect, not a claim of commerce.
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              <DotChip color="#0f62fe">scoped authority</DotChip>
              <DotChip color="#0fb5d6">9 evidence classes</DotChip>
              <DotChip color="#8fbf2f">fail closed</DotChip>
            </div>
            {/* evidence receipt visual */}
            <div className="mt-7 rounded-xl border border-[#dfe8fd] bg-gradient-to-br from-[#f4f8ff] to-white p-4">
              <div className="mb-3 flex items-center justify-between">
                <p className="mono text-[10.5px] uppercase tracking-[0.14em] text-ink-3">the openarc receipt</p>
                <p className="mono text-[10.5px] font-medium text-[#e8a93b]">REVIEW ONLY</p>
              </div>
              <div className="space-y-3">
                {receipt.map(r => (
                  <div key={r.row}>
                    <p className="mono text-[12px] text-ink">{r.row}</p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      {r.states.map((s, i) => (
                        <span key={s} className="flex items-center gap-1.5">
                          <span className="mono rounded-md px-2 py-0.5 text-[9.5px] font-medium tracking-wide" style={{ color: STATE_COLORS[s], background: `${STATE_COLORS[s]}12`, border: `1px solid ${STATE_COLORS[s]}33` }}>{s}</span>
                          {i < r.states.length - 1 && <span className="text-[10px] text-ink-3">→</span>}
                        </span>
                      ))}
                      {r.done && <span className="mono text-[10px] text-[#8fbf2f]">✓</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
