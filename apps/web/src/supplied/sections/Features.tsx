import { useEffect, useRef, useState, type ReactElement } from 'react'
import { DotChip } from '../components/Brand'

type Pillar = {
  color: string
  num: string
  title: string
  desc: string
  chips: string[]
  stat: string
  statLabel: string
  pct: number
  icon: ReactElement
}

const ic = (d: string, extra = '') => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />{extra ? <path d={extra} /> : null}
  </svg>
)

const pillars: Pillar[] = [
  {
    color: '#0f62fe', num: '01', title: 'Market',
    desc: 'A local evidence workspace for reviewing bounded agent and network signals. Marketplace discovery and paid capability hiring remain proposed.',
    chips: ['evidence review', 'proposed discovery'],
    stat: '0', statLabel: 'LISTINGS ENABLED', pct: 0,
    icon: ic('M4 7h16l-1.2 12.2a2 2 0 0 1-2 1.8H7.2a2 2 0 0 1-2-1.8L4 7Z', 'M8 10V6a4 4 0 0 1 8 0v4'),
  },
  {
    color: '#e8a93b', num: '02', title: 'Control',
    desc: 'Local policies and read-only consent receipts make network access explicit. Financial budgets, reservations, and revocation are not shipped.',
    chips: ['local policies', 'read-only consent'],
    stat: '0', statLabel: 'EXECUTION BUDGETS', pct: 0,
    icon: ic('M4 8h10M18 8h2M4 16h2M10 16h10', 'M14 5.5v5M6 13.5v5'),
  },
  {
    color: '#0fb5d6', num: '03', title: 'Proof',
    desc: 'The reviewed evidence model keeps local, imported, provider, and bounded onchain observations distinct; missing links stay missing.',
    chips: ['evidence classes', 'fail closed'],
    stat: '9', statLabel: 'EVIDENCE CLASSES', pct: 90,
    icon: ic('M12 3 4.5 6v5.2c0 4.6 3.2 8.3 7.5 9.8 4.3-1.5 7.5-5.2 7.5-9.8V6L12 3Z', 'M9 11.8l2.1 2.1 3.9-4.3'),
  },
  {
    color: '#8fbf2f', num: '04', title: 'Privacy',
    desc: 'The encrypted local Vault stores workspace context, while network reads require explicit consent. OpenArc does not hold keys or sign transactions.',
    chips: ['encrypted Vault', 'no signing'],
    stat: '0', statLabel: 'SIGNING INTERFACES', pct: 100,
    icon: ic('M7 11V8a5 5 0 0 1 10 0v3', 'M5.5 11h13v9h-13zM12 14.5v2.5'),
  },
]

export default function Features() {
  const gridRef = useRef<HTMLDivElement>(null)
  const [fill, setFill] = useState(false)

  useEffect(() => {
    const el = gridRef.current
    if (!el) return
    if (typeof IntersectionObserver === 'undefined') { setFill(true); return }
    let io: IntersectionObserver
    try {
      io = new IntersectionObserver(
        ([e]) => { if (e?.isIntersecting) { setFill(true); io.disconnect() } },
        { threshold: 0.2 },
      )
    } catch {
      setFill(true)
      return
    }
    io.observe(el)
    return () => io.disconnect()
  }, [])

  return (
    <section className="section-shell py-24" id="pillars">
      <div className="mx-auto max-w-[1400px] px-6 text-center">
        <p className="tag-label reveal">[ pillars ]</p>
        <h2 className="reveal reveal-d1 mt-4 text-[40px] font-bold leading-[1.08] tracking-[-0.03em] text-ink md:text-[56px]">
          Four pillars to investigate<br />agent activity safely
        </h2>
        <p className="reveal reveal-d2 mx-auto mt-5 max-w-[560px] text-[17px] text-ink-2">
          Market, control, proof, and privacy, designed to fail closed. Today these are read-only
          evidence and a local encrypted workspace; the commerce target is in development.
        </p>

        <div ref={gridRef} className="mt-14 grid gap-5 text-left md:grid-cols-2 xl:grid-cols-4">
          {pillars.map((p, i) => (
            <div
              key={p.title}
              className={`reveal ${i === 1 ? 'reveal-d1' : i === 2 ? 'reveal-d2' : i === 3 ? 'reveal-d3' : ''} group relative flex flex-col overflow-hidden v-card p-7 transition-all duration-300 hover:-translate-y-1 hover:shadow-[0_28px_60px_-24px_rgba(13,27,46,0.2)]`}
            >
              <span className="absolute inset-x-0 top-0 h-[4px] transition-all duration-300 group-hover:h-[7px]" style={{ background: `linear-gradient(90deg, ${p.color}, ${p.color}66)` }} />
              <span className="pointer-events-none absolute -right-12 -top-12 h-36 w-36 rounded-full opacity-0 blur-3xl transition-opacity duration-500 group-hover:opacity-25" style={{ background: p.color }} />

              <div className="flex items-center justify-between">
                <span className="flex h-12 w-12 items-center justify-center rounded-xl transition-transform duration-300 group-hover:scale-110" style={{ background: `${p.color}14`, color: p.color }}>
                  {p.icon}
                </span>
                <span className="mono text-[13px] font-medium text-ink-3">{p.num}</span>
              </div>

              <h3 className="mt-6 text-[23px] font-semibold tracking-tight text-ink">{p.title}</h3>
              <p className="mt-2 min-h-[110px] text-[14.5px] leading-relaxed text-ink-2">{p.desc}</p>

              <div className="mt-4 flex flex-wrap gap-2">
                {p.chips.map(c => <DotChip key={c} color={p.color}>{c}</DotChip>)}
              </div>

              {/* stat + animated meter */}
              <div className="mt-6 border-t border-[#eef1f6] pt-5">
                <div className="flex items-end justify-between">
                  <span className="text-[38px] font-bold leading-none tracking-[-0.03em]" style={{ color: p.color }}>{p.stat}</span>
                  <span className="mono text-right text-[10px] font-medium leading-tight tracking-[0.1em] text-ink-3">{p.statLabel}</span>
                </div>
                <div className="meter mt-3">
                  <i style={{ width: fill ? `${p.pct}%` : '0%', transition: `width 1.3s cubic-bezier(.22,.61,.36,1) ${0.15 + i * 0.12}s` }} />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
