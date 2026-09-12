import { DotSparkle } from '../components/Brand'

const trace = [
  { t: '14:02:11', cls: 'local', color: '#8a96a8', msg: 'session scoped: dataset · cap 25.00 USDC · 1h' },
  { t: '14:02:12', cls: 'local', color: '#0f62fe', msg: 'synthetic proposal compared with local policy → REVIEW ONLY' },
  { t: '14:02:14', cls: 'agent_reported', color: '#e8a93b', msg: 'illustrative provider listing supplied as untrusted input' },
  { t: '14:02:18', cls: 'local', color: '#8fbf2f', msg: 'payment intent constraints compared locally · no reservation' },
  { t: '14:02:19', cls: 'onchain', color: '#0f62fe', msg: 'illustrative settlement reference shown · not verified by this scenario' },
  { t: '14:02:24', cls: 'provider', color: '#e8a93b', msg: 'illustrative delivery record shown · no provider call made' },
  { t: '14:02:31', cls: 'OpenArc-derived', color: '#e05a4e', msg: 'missing execution and fulfillment evidence preserved' },
  { t: '14:02:40', cls: 'OpenArc-derived', color: '#0d1b2e', msg: 'local review complete · illustrative scenario only' },
]

const findings = [
  {
    id: 'F-01',
    title: 'Constraints are explicit',
    quote: 'The synthetic proposal binds a 25.00 USDC maximum for comparison. It does not create a reservation or authorize a payment.',
  },
  {
    id: 'F-02',
    title: 'Evidence stays separate',
    quote: 'The scenario keeps proposed, authorized, fulfilled, and settled states distinct. Missing evidence is not upgraded by the interface.',
  },
  {
    id: 'F-03',
    title: 'No execution is claimed',
    quote: 'This illustrative record does not measure custody events or paid execution. OpenArc has no signing or broadcasting interface.',
  },
]

export default function CaseStudy() {
  return (
    <section className="section-shell py-24" id="case-study">
      <div className="mx-auto max-w-[1400px] px-6 text-center">
        <p className="tag-label reveal">[ illustrative scenario ]</p>
        <h2 className="reveal reveal-d1 mt-4 text-[40px] md:text-[56px] leading-[1.08] font-bold tracking-[-0.03em] text-ink">
          A local review,<br />not a paid case study
        </h2>
        <p className="reveal reveal-d2 mx-auto mt-5 max-w-[560px] text-[17px] text-ink-2">
          This illustrative scenario shows how a synthetic purchase proposal could be reviewed locally;<br className="hidden md:block" /> it is not a verified purchase or a report of executed work.
        </p>

        {/* case file */}
        <div className="reveal reveal-d2 v-card mt-14 overflow-hidden text-left">
          <div className="flex flex-wrap items-center gap-x-8 gap-y-2 border-b border-[#e5e9f0] px-7 py-4">
            <span className="mono text-[12px] uppercase tracking-wide text-[#8a96a8]">CASE FILE</span>
            <span className="mono text-[13px] text-ink">openarc:action:3fa9…81bd</span>
            <span className="mono text-[12px] text-ink-2">NETWORK eip155:5042002</span>
            <span className="mono text-[12px] text-ink-2">RULE recon.v2.3</span>
            <span className="mono ml-auto text-[12px] text-[#e8a93b]">● ILLUSTRATIVE</span>
          </div>
          <div className="grid lg:grid-cols-[1fr_1.2fr]">
            <div className="p-7 md:p-8">
              <p className="mono text-[12px] uppercase tracking-wide text-[#8a96a8]">Method</p>
              <p className="mt-3 text-[15px] leading-relaxed text-ink-2">
                An illustrative operator review compares a synthetic agent proposal for a dataset listing against a 25.00 USDC constraint. No agent ran, provider was called, payment was signed, or content was delivered.
              </p>
              <p className="mono mt-6 text-[12px] uppercase tracking-wide text-[#8a96a8]">What this illustrates</p>
              <p className="mt-3 text-[15px] leading-relaxed text-ink-2">
                The example keeps local, agent-reported, provider, and onchain references visibly separate; it does not establish authorization, payment, delivery, or settlement.
              </p>
              <div className="mt-6 flex flex-wrap gap-2">
                {['illustrative', 'local review', 'no provider call', 'no execution'].map(s => (
                  <span key={s} className="mono rounded-lg border border-[#e5e9f0] bg-[#fafbfc] px-3 py-1.5 text-[12px] text-ink-2">{s}</span>
                ))}
              </div>
            </div>
            <div className="bg-[#0d1b2e] p-6 md:p-8">
              <p className="mono text-[12px] uppercase tracking-wide text-[#8a96a8]">Evidence log</p>
              <div className="mt-4 space-y-3">
                {trace.map((r, i) => (
                  <div key={i} className="flex items-start gap-3">
                    <span className="mono shrink-0 pt-[2px] text-[11px] text-[#8a96a8]">{r.t}</span>
                    <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: r.color }} />
                    <div className="min-w-0">
                      <span className="mono mr-2 rounded bg-white/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide" style={{ color: r.color }}>{r.cls}</span>
                      <span className="text-[13px] leading-snug text-[#d7e3f8]">{r.msg}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* findings */}
        <div className="mt-5 grid gap-5 md:grid-cols-3 text-left">
          {findings.map((f, i) => (
            <div key={f.id} className={`reveal ${i === 1 ? 'reveal-d1 shadow-[0_24px_60px_-24px_rgba(13,27,46,0.16)] md:-translate-y-3' : i === 2 ? 'reveal-d2' : ''} v-card flex flex-col p-8`}>
              <div className="flex items-start justify-between">
                <DotSparkle color="#0f62fe" />
                <span className="mono flex items-center gap-1.5 text-[12px] text-[#8fbf2f]">
                  ILLUSTRATIVE
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#8fbf2f" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 13l4 4L19 7"/></svg>
                </span>
              </div>
              <h3 className="mt-6 text-[19px] font-semibold tracking-tight text-ink">
                <span className="mono mr-2 text-[13px] text-[#8a96a8]">{f.id}</span>
                {f.title}
              </h3>
              <p className="mt-3 text-[15px] leading-relaxed text-ink-2">"{f.quote}"</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
