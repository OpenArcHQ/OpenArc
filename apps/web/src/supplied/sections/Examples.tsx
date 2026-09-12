import { DotSparkle } from '../components/Brand'
import consoleAnswer from '../media/console-answer.png'
import consoleEntity from '../media/console-entity.png'
import consoleSessions from '../media/console-sessions.png'

function Chrome({ label, color }: { label: string; color: string }) {
  return (
    <div className="flex items-center gap-2 border-b border-[#e5e9f0] px-5 py-3">
      <span className="h-2.5 w-2.5 rounded-full bg-[#ec6b5e]" />
      <span className="h-2.5 w-2.5 rounded-full bg-[#e8a93b]" />
      <span className="h-2.5 w-2.5 rounded-full bg-[#8fbf2f]" />
      <span className="mono ml-3 text-[11px] uppercase tracking-wide" style={{ color }}>{label}</span>
    </div>
  )
}

const rows = [
  {
    color: '#0f62fe',
    title: 'Review a proposed purchase',
    desc: 'Use the local action lab to compare a synthetic request with policy and payment constraints. No USDC moves and no provider is called.',
    foot: 'Local simulation | policy | no execution',
    shot: consoleAnswer,
    shotLabel: 'ILLUSTRATIVE EVIDENCE VIEW',
    caption: 'Illustrative only',
  },
  {
    color: '#e8a93b',
    title: 'Audit any action',
    desc: 'Inspect imported or observed evidence and keep authorization, fulfillment, and settlement distinct. Missing evidence remains visible.',
    foot: 'Proof | Evidence | Graph',
    shot: consoleEntity,
    shotLabel: 'ILLUSTRATIVE ENTITY SUMMARY',
    caption: 'Illustrative only',
  },
  {
    color: '#0fb5d6',
    title: 'Compare policy constraints',
    desc: 'Review local policy inputs and synthetic proposals before any future execution boundary is considered; financial reservations are not enabled.',
    foot: 'Control | Policies | Local review',
    shot: consoleSessions,
    shotLabel: 'ILLUSTRATIVE SESSIONS VIEW',
    caption: 'Illustrative only',
  },
]

export default function Examples() {
  return (
    <section className="section-shell py-24" id="examples">
      <div className="mx-auto max-w-[1400px] px-6 text-center">
        <p className="tag-label reveal">[ examples ]</p>
        <h2 className="reveal reveal-d1 mt-4 text-[40px] md:text-[56px] leading-[1.08] font-bold tracking-[-0.03em] text-ink">
          See how OpenArc labels<br />what it can inspect
        </h2>
        <p className="reveal reveal-d2 mx-auto mt-5 max-w-[620px] text-[17px] text-ink-2">
          From encrypted workspace review and bounded network observations to local action simulations and<br className="hidden md:block" /> evidence audits, OpenArc keeps conclusions attributable without claiming execution.
        </p>

        <div className="mt-14 space-y-6">
          {rows.map((r, i) => {
            const flip = i % 2 === 1
            const text = (
              <div className="group relative flex min-h-[320px] flex-col overflow-hidden v-card p-8 text-left transition-all duration-300 hover:shadow-[0_24px_60px_-24px_rgba(13,27,46,0.18)] lg:p-10">
                <span className="absolute inset-x-0 top-0 h-[4px] transition-all duration-300 group-hover:h-[6px]" style={{ background: `linear-gradient(90deg, ${r.color}, ${r.color}66)` }} />
                <DotSparkle color={r.color} />
                <h3 className="mt-8 text-[24px] font-semibold tracking-tight text-ink">{r.title}</h3>
                <p className="mt-2.5 max-w-[480px] text-[15px] leading-relaxed text-ink-2">{r.desc}</p>
                <p className="mt-auto pt-8 text-[13.5px] italic text-[#8a96a8]">{r.foot}</p>
              </div>
            )
            const shot = (
              <div className="v-card group overflow-hidden text-left transition-all duration-300 hover:shadow-[0_24px_60px_-24px_rgba(13,27,46,0.18)]">
                <Chrome label={r.shotLabel} color={r.color} />
                <div className="relative h-[300px] overflow-hidden bg-[#f6f7f9]">
                  <img
                    src={r.shot}
                    alt={r.shotLabel}
                    className="h-full w-full object-cover object-top transition-transform duration-500 group-hover:scale-[1.03]"
                  />
                  <span className="mono absolute bottom-3 right-3 rounded-lg border border-[#e5e9f0] bg-white/90 px-2.5 py-1 text-[10.5px] text-ink-2 backdrop-blur">
                    {r.caption}
                  </span>
                  <span className="mono absolute left-3 top-3 rounded-lg border border-[#e5e9f0] bg-white/90 px-2.5 py-1 text-[10.5px] text-ink-2 backdrop-blur">
                    ILLUSTRATIVE
                  </span>
                </div>
              </div>
            )
            return (
              <div key={r.title} className={`reveal ${i === 1 ? 'reveal-d1' : i === 2 ? 'reveal-d2' : ''} grid items-stretch gap-5 lg:grid-cols-2`}>
                {flip ? <>{shot}{text}</> : <>{text}{shot}</>}
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
