import { useEffect, useState, type ReactElement } from 'react'
import { DotChip } from '../components/Brand'
import { useReducedMotion } from '../hooks/useReducedMotion'
import consoleAnswer from '../media/console-answer.png'
import consoleEntity from '../media/console-entity.png'
import consoleHero from '../media/console-hero.png'
import consoleSessions from '../media/console-sessions.png'
import consoleGrant from '../media/console-grant.png'

type Case = {
  color: string
  label: string
  title: string
  desc: string
  chips: string[]
  shots: { src: string; label: string }[]
  icon: ReactElement
}

const ic = (d: string, extra = '') => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />{extra ? <path d={extra} /> : null}
  </svg>
)

const cases: Case[] = [
  {
    color: '#0f62fe', label: 'FOR OPERATORS', title: 'For operators',
    desc: 'Review local policies and synthetic agent-action proposals without handing over keys. Financial budgets, execution, and revocation are not enabled.',
    chips: ['local policies', 'synthetic actions', 'no signing'],
    shots: [
      { src: consoleSessions, label: 'session control' },
      { src: consoleGrant, label: 'budget grant' },
      { src: consoleHero, label: 'agent console' },
    ],
    icon: ic('M4 8h10M18 8h2M4 16h2M10 16h10', 'M14 5.5v5M6 13.5v5'),
  },
  {
    color: '#e8a93b', label: 'FOR PROVIDERS', title: 'For providers',
    desc: 'Use the interface to inspect illustrative capability and provider evidence. Listings, payouts, delivery, and reputation are proposed, not live services.',
    chips: ['illustrative listings', 'evidence labels', 'no payouts'],
    shots: [
      { src: consoleAnswer, label: 'evidence answer' },
      { src: consoleEntity, label: 'listing entity' },
      { src: consoleHero, label: 'agent console' },
    ],
    icon: ic('M3.5 12.5V5a1.5 1.5 0 0 1 1.5-1.5h7.5L21 12l-8.5 8.5-9-8Z', 'M8 8h.01'),
  },
  {
    color: '#0fb5d6', label: 'FOR AGENTS', title: 'For agents',
    desc: 'Import or review bounded agent-reported and network evidence, then compare a synthetic action locally. OpenArc does not run agents or transact.',
    chips: ['agent evidence', 'local simulation', 'attributable context'],
    shots: [
      { src: consoleEntity, label: 'entity summary' },
      { src: consoleAnswer, label: 'evidence answer' },
      { src: consoleSessions, label: 'session control' },
    ],
    icon: ic('M7 7h10v10H7z', 'M4 10v4M20 10v4M10 4h4M10 20h4M12 10.5v3'),
  },
]

function CaseCard({ c, revealClass }: { c: Case; revealClass: string }) {
  const [shot, setShot] = useState(0)
  const [paused, setPaused] = useState(false)
  const reduced = useReducedMotion()

  useEffect(() => {
    if (paused || reduced) return
    const t = setInterval(() => setShot(s => (s + 1) % c.shots.length), 4500)
    return () => clearInterval(t)
  }, [paused, reduced, c.shots.length])

  return (
    <div
      className={`reveal ${revealClass} group relative flex flex-col overflow-hidden v-card p-7 transition-all duration-300 hover:-translate-y-1 hover:shadow-[0_28px_60px_-24px_rgba(13,27,46,0.2)]`}
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
    >
      <span className="absolute inset-x-0 top-0 h-[4px] transition-all duration-300 group-hover:h-[7px]" style={{ background: `linear-gradient(90deg, ${c.color}, ${c.color}66)` }} />

      <div className="flex items-center justify-between">
        <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-[#0d1b2e] transition-transform duration-300 group-hover:scale-110">{c.icon}</span>
        <span className="mono text-[10.5px] font-medium tracking-[0.12em]" style={{ color: c.color }}>{c.label}</span>
      </div>

      <h3 className="mt-6 text-[24px] font-semibold tracking-tight text-ink">{c.title}</h3>
      <p className="mt-2.5 min-h-[132px] text-[14.5px] leading-relaxed text-ink-2">{c.desc}</p>

      <div className="mt-4 flex flex-wrap gap-2">
        {c.chips.map(ch => <DotChip key={ch} color={c.color}>{ch}</DotChip>)}
      </div>

      {/* mini carousel */}
      <div className="mt-6">
        <div className="relative overflow-hidden rounded-xl border border-[#e5e9f0]">
          <img
            key={shot}
            src={c.shots[shot]?.src}
            alt={c.shots[shot]?.label ?? "Illustrative preview"}
            className="swap-in h-[200px] w-full object-cover object-top"
            loading="lazy"
          />
          <span className="mono absolute bottom-2.5 right-2.5 rounded-md bg-[#0d1b2e]/85 px-2 py-1 text-[10px] text-white backdrop-blur">
            {c.shots[shot]?.label}
          </span>
          <span className="mono absolute left-2.5 top-2.5 rounded-md bg-white/90 px-2 py-1 text-[10px] text-ink-2 backdrop-blur">
            ILLUSTRATIVE
          </span>
        </div>
        <div className="mt-3.5 flex items-center justify-center gap-1.5">
          {c.shots.map((s, i) => (
            <button
              key={s.label}
              onClick={() => setShot(i)}
              aria-label={`Show ${s.label}`}
              className="h-1.5 rounded-full transition-all duration-300"
              style={{ width: i === shot ? 24 : 8, background: i === shot ? c.color : '#d5dae2' }}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

export default function UseCases() {
  return (
    <section className="section-shell relative overflow-hidden py-24" id="use-cases">
      <div className="relative mx-auto max-w-[1400px] px-6">
        {/* two-column header, services style */}
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div className="max-w-[640px] text-left">
            <p className="reveal inline-flex items-center gap-2 rounded-full border border-[#e5e9f0] bg-white px-4 py-1.5">
              <i className="h-2 w-2 rounded-full bg-[#0f62fe]" />
              <span className="mono text-[12px] font-medium tracking-[0.14em] text-ink-2">USE CASES</span>
            </p>
            <h2 className="reveal reveal-d1 mt-5 text-[40px] font-bold leading-[1.08] tracking-[-0.03em] text-ink md:text-[56px]">
              Built for everyone in<br />the agent economy
            </h2>
          </div>
          <p className="reveal reveal-d2 max-w-[360px] text-left text-[16px] leading-relaxed text-ink-2 lg:text-right">
            Whether you investigate agent activity or review a proposed action, OpenArc keeps the evidence and permission boundaries explicit.
          </p>
        </div>

        <div className="mt-14 grid gap-5 text-left md:grid-cols-2 xl:grid-cols-3">
          {cases.map((c, i) => (
            <CaseCard key={c.title} c={c} revealClass={i === 1 ? 'reveal-d1' : i === 2 ? 'reveal-d2' : ''} />
          ))}
        </div>
      </div>
    </section>
  )
}
