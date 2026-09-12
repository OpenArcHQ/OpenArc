import { useEffect, useRef, useState } from 'react'
import { DotSparkle } from '../components/Brand'
import { useReducedMotion } from '../hooks/useReducedMotion'

type Status = 'shipped' | 'progress' | 'paused' | 'blocked'

const STATUS: Record<Status, { label: string; color: string; bg: string }> = {
  shipped: { label: 'READ-ONLY / LOCAL', color: '#8fbf2f', bg: 'rgba(143,191,47,.12)' },
  progress: { label: 'IN DEVELOPMENT', color: '#0f62fe', bg: 'rgba(15,98,254,.10)' },
  paused: { label: 'PAUSED', color: '#e8a93b', bg: 'rgba(232,169,59,.12)' },
  blocked: { label: 'BLOCKED / READ-ONLY', color: '#8a96a8', bg: 'rgba(138,150,168,.12)' },
}

const milestones: { id: string; status: Status; title: string; desc: string }[] = [
  { id: 'M00', status: 'shipped', title: 'Repository foundation', desc: 'Repository, verification tooling, and the fixed Arc Testnet registry.' },
  { id: 'M01', status: 'shipped', title: 'Evidence engine', desc: 'Versioned evidence classes, state distinctions, and fail-closed reconciliation rules.' },
  { id: 'M02', status: 'shipped', title: 'Encrypted workspace', desc: 'Local encrypted Vault with lock, export, import, recovery, and deletion paths.' },
  { id: 'M03', status: 'shipped', title: 'API and privacy boundary', desc: 'Read-only capability boundary, consent receipts, and privacy-safe request controls.' },
  { id: 'M04', status: 'shipped', title: 'Arc account and transaction evidence', desc: 'Bounded, consented Testnet account and transaction observations.' },
  { id: 'M05', status: 'shipped', title: 'ERC-8004 agent evidence', desc: 'Named-source agent identity observations; no unsupported verification or reputation inference.' },
  { id: 'M06', status: 'shipped', title: 'ERC-8183 job evidence', desc: 'Bounded job-state observations kept separate from execution or quality claims.' },
  { id: 'M07', status: 'shipped', title: 'x402 and Gateway evidence', desc: 'Read-only payment metadata and consented evidence paths; no payment dispatch.' },
  { id: 'M08', status: 'shipped', title: 'Local agent import and policy comparison', desc: 'Owner-controlled imports and local monitoring-policy comparison.' },
  { id: 'M09', status: 'shipped', title: 'Investigation operations', desc: 'Local investigation views that preserve evidence relationships and missing links.' },
  { id: 'M10', status: 'paused', title: 'Public Testnet hardening', desc: 'Launch-hardening work is paused, not complete; no public execution or promotion is implied.' },
  { id: 'A01', status: 'progress', title: 'Commerce foundation', desc: 'Strict contracts, identifiers, and money handling for the commerce target. No route, payment, authentication, or execution is enabled yet.' },
  { id: 'M11', status: 'blocked', title: 'Arc mainnet adapter', desc: 'Separately approved, read-only future work; blocked pending its network, audit, and economic gates.' },
]

export default function Roadmap() {
  const stripRef = useRef<HTMLDivElement>(null)
  const [idx, setIdx] = useState(0)
  const [paused, setPaused] = useState(false)
  const reduced = useReducedMotion()

  const step = () => {
    const el = stripRef.current
    const card = el?.querySelector<HTMLElement>('[data-card]')
    return card ? card.offsetWidth + 20 : 350
  }

  const scrollBy = (dir: 1 | -1) => {
    stripRef.current?.scrollBy({ left: dir * step(), behavior: reduced ? 'auto' : 'smooth' })
  }

  /* counter from scroll position */
  useEffect(() => {
    const el = stripRef.current
    if (!el) return
    let raf = 0
    const on = () => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        setIdx(Math.max(0, Math.min(milestones.length - 1, Math.round(el.scrollLeft / step()))))
      })
    }
    el.addEventListener('scroll', on, { passive: true })
    return () => { el.removeEventListener('scroll', on); if (raf) cancelAnimationFrame(raf) }
  }, [])

  /* auto-advance with loop */
  useEffect(() => {
    if (paused || reduced) return
    const t = setInterval(() => {
      const el = stripRef.current
      if (!el) return
      if (el.scrollLeft + el.clientWidth >= el.scrollWidth - 24) {
        el.scrollTo({ left: 0, behavior: reduced ? 'auto' : 'smooth' })
      } else {
        el.scrollBy({ left: step(), behavior: reduced ? 'auto' : 'smooth' })
      }
    }, 4200)
    return () => clearInterval(t)
  }, [paused, reduced])

  return (
    <section className="section-shell relative overflow-hidden py-24" id="roadmap">

      <div className="relative mx-auto max-w-[1400px] px-6">
        {/* header: title + counter + arrows */}
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div className="max-w-[640px] text-left">
            <p className="tag-label reveal">[ roadmap ]</p>
            <h2 className="reveal reveal-d1 mt-4 text-[40px] font-bold leading-[1.08] tracking-[-0.03em] text-ink md:text-[56px]">
              Read-only foundation,<br />commerce in development
            </h2>
          </div>
          <div className="reveal reveal-d2 flex items-center gap-4">
            <span className="mono text-[14px] text-ink-3">
              {String(idx + 1).padStart(2, '0')} / {String(milestones.length).padStart(2, '0')}
            </span>
            <div className="flex gap-2">
              <button onClick={() => scrollBy(-1)} aria-label="Previous milestone" className="btn-ghost flex h-11 w-11 items-center justify-center rounded-xl text-[20px]">‹</button>
              <button onClick={() => scrollBy(1)} aria-label="Next milestone" className="btn-grad flex h-11 w-11 items-center justify-center rounded-xl text-[20px] text-white">›</button>
            </div>
          </div>
        </div>

        {/* legend */}
        <div className="reveal reveal-d2 mt-8 flex flex-wrap gap-2">
          {(Object.keys(STATUS) as Status[]).map(k => (
            <span key={k} className="mono flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-medium" style={{ color: STATUS[k].color, background: STATUS[k].bg }}>
              <i className="h-1.5 w-1.5 rounded-full" style={{ background: STATUS[k].color }} />
              {STATUS[k].label}
            </span>
          ))}
        </div>
      </div>

      {/* card strip — gradient contour cards */}
      <div
        ref={stripRef}
        onPointerEnter={() => setPaused(true)}
        onPointerLeave={() => setPaused(false)}
        className="reveal reveal-d2 mt-10 flex snap-x snap-mandatory gap-5 overflow-x-auto px-6 pb-4 pt-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden lg:px-[max(24px,calc((100vw-1400px)/2+24px))]"
      >
        {milestones.map((m, i) => {
          const s = STATUS[m.status]
          return (
            <div
              key={m.id}
              data-card
              className={`grad-border w-[300px] shrink-0 snap-start rounded-2xl p-6 text-left transition-all duration-300 hover:-translate-y-1 md:w-[330px] ${
                m.status === 'progress' ? 'shadow-[0_24px_60px_-24px_rgba(10,79,208,0.4)]' : 'shadow-[0_14px_40px_-24px_rgba(13,27,46,0.25)]'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="mono text-[13px] font-medium text-ink-3">{String(i + 1).padStart(2, '0')}</span>
                <span className="flex items-center gap-1">
                  {Array.from({ length: 5 }).map((_, d) => (
                    <i key={d} className="h-1.5 w-1.5 rounded-full" style={{ background: s.color, opacity: d < 3 ? 1 : 0.35 }} />
                  ))}
                </span>
              </div>
              <div className="mt-5 flex items-center justify-between gap-2">
                <span className="mono text-[15px] font-semibold text-ink">{m.id}</span>
                <span className="mono rounded-md px-2 py-1 text-[9.5px] font-medium tracking-wide" style={{ color: s.color, background: s.bg }}>{s.label}</span>
              </div>
              <h3 className="mt-3 min-h-[52px] text-[18px] font-semibold leading-snug tracking-tight text-ink">{m.title}</h3>
              <p className="mt-2 min-h-[88px] text-[13.5px] leading-relaxed text-ink-2">{m.desc}</p>
              {m.status === 'progress' && (
                <div className="meter mt-2"><i style={{ width: '62%' }} /></div>
              )}
            </div>
          )
        })}
      </div>

      {/* progress line */}
      <div className="relative mx-auto mt-6 max-w-[1400px] px-6">
        <div className="h-1 overflow-hidden rounded-full bg-[#e5e9f0]">
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{ width: `${((idx + 1) / milestones.length) * 100}%`, background: 'var(--grad)', backgroundSize: '220% 220%' }}
          />
        </div>
        <div className="reveal mt-8 flex items-center justify-center gap-3 text-[13.5px] italic text-[#8a96a8]">
          <DotSparkle color="#e8a93b" cell={4} gap={3} />
          Dates land when gates pass, not before.
        </div>
      </div>
    </section>
  )
}
