import { useEffect, useState, type ReactElement } from 'react'
import { Logo } from '../components/Brand'
import { useReducedMotion } from '../hooks/useReducedMotion'

type StackItem = {
  name: string
  spec: string
  desc: string
  color: string
  ring: 0 | 1
  angle: number
  icon: (c: string) => ReactElement
}

const stroke = (c: string, d: string, extra = '') => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />{extra ? <path d={extra} /> : null}
  </svg>
)

const items: [StackItem, ...StackItem[]] = [
  {
    name: 'Arc Testnet', spec: 'eip155:5042002', color: '#2f8cff', ring: 0, angle: 270,
    desc: 'Current bounded network context: Arc Testnet (eip155:5042002). Mainnet is not enabled.',
    icon: c => stroke(c, 'M12 3a9 9 0 1 0 9 9', 'M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18'),
  },
  {
    name: 'USDC', spec: 'settlement asset', color: '#0fb5d6', ring: 0, angle: 30,
    desc: 'USDC is the reviewed Testnet asset context for observations and local intent comparisons; no payout or reservation is enabled.',
    icon: c => stroke(c, 'M12 2v20M17 7.5c-.8-1.8-2.7-2.5-5-2.5-2.8 0-4.5 1.3-4.5 3.3 0 4.4 9.7 2.3 9.7 6.9 0 2-1.9 3.3-4.7 3.3-2.5 0-4.5-.9-5.2-2.8'),
  },
  {
    name: 'x402 Lane', spec: 'HTTP-native payments', color: '#e8a93b', ring: 0, angle: 150,
    desc: 'x402 and Gateway are reviewed evidence domains for a future boundary; the current app does not dispatch or settle payments.',
    icon: c => stroke(c, 'M13 2 4.5 13.5H11L9.5 22 19 10h-6.5L13 2Z'),
  },
  {
    name: 'ERC-8004', spec: 'agent identity', color: '#8fbf2f', ring: 1, angle: 215,
    desc: 'A reviewed evidence domain for agent identity. OpenArc does not infer verified identity or reputation without named evidence.',
    icon: c => stroke(c, 'M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6Z', 'M8.5 10a1.8 1.8 0 1 0 0-.01M7 15c.4-1.7 1.6-2.5 3-2.5s2.6.8 3 2.5M14.5 8.5H18M14.5 12H18'),
  },
  {
    name: 'ERC-8183', spec: 'job contracts', color: '#0f62fe', ring: 1, angle: 250,
    desc: 'A reviewed evidence domain for job lifecycle observations; no job execution or on-chain writes are performed by OpenArc.',
    icon: c => stroke(c, 'M8 3h8l4 4v12a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z', 'M15 3v5h5M9.5 13.5l2 2 3.5-4'),
  },
  {
    name: 'Circle Gateway', spec: 'USDC rail', color: '#0fb5d6', ring: 1, angle: 325,
    desc: 'A reviewed Testnet payment rail context. OpenArc neither holds funds nor connects to a payment executor in the current phase.',
    icon: c => stroke(c, 'M20 12a8 8 0 1 1-2.3-5.6', 'M20 3v4h-4M4 12a8 8 0 0 0 2.3 5.6M4 21v-4h4'),
  },
  {
    name: 'Blockscout', spec: 'public explorer', color: '#e8a93b', ring: 1, angle: 8,
    desc: 'Public explorer observations can be imported or read within bounded, consented scopes; authorization and settlement are never inferred.',
    icon: c => stroke(c, 'M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Z', 'M15.3 15.3 21 21'),
  },
  {
    name: 'Evidence Graph', spec: 'openarc native', color: '#8fbf2f', ring: 1, angle: 75,
    desc: 'Our local layer keeps evidence classes and action states distinct, with missing links and conflicts preserved rather than inferred.',
    icon: c => stroke(c, 'M6 5a2 2 0 1 0 0 .01M18 5a2 2 0 1 0 0 .01M12 19a2 2 0 1 0 0 .01', 'M7.8 6 10.5 17.4M16.2 6 13.5 17.4M8 5h8'),
  },
]

const RADII = [29, 41.5] as const

export default function StackOrbit() {
  const [active, setActive] = useState(0)
  const [paused, setPaused] = useState(false)
  const reduced = useReducedMotion()
  const cur = items[active] ?? items[0]

  useEffect(() => {
    if (paused || reduced) return
    const t = setInterval(() => setActive(a => (a + 1) % items.length), 4000)
    return () => clearInterval(t)
  }, [paused, reduced])

  return (
    <section id="stack" className="relative overflow-hidden bg-white py-24 md:py-28">
      {/* ambient brand blur behind everything */}
      <div
        className="pointer-events-none absolute left-1/2 top-1/2 h-[820px] w-[820px] -translate-x-1/2 -translate-y-1/2 rounded-full opacity-[0.13] blur-[110px]"
        style={{ background: 'var(--grad)' }}
      />

      <div className="relative mx-auto max-w-[1400px] px-6 text-center">
        <p className="tag-label reveal">[ the stack ]</p>
        <h2 className="reveal reveal-d1 mt-4 text-[40px] font-bold leading-[1.08] tracking-[-0.03em] text-ink md:text-[56px]">
          What <span className="grad-text">OpenArc</span> is built on
        </h2>
        <p className="reveal reveal-d2 mx-auto mt-5 max-w-[560px] text-[17px] text-ink-2">
          Eight pieces of public infrastructure, orbiting one evidence layer.<br className="hidden md:block" /> Tap a bubble to see the role it plays.
        </p>

        {/* orbit stage */}
        <div
          className="reveal reveal-d2 relative mx-auto mt-10 aspect-square w-full max-w-[680px]"
          onPointerEnter={() => setPaused(true)}
          onPointerLeave={() => setPaused(false)}
        >
          {/* rings */}
          <div className="absolute rounded-full border border-[#0d1b2e]/10" style={{ inset: `${50 - RADII[0]}%` }} />
          <div className="absolute rounded-full border border-[#0d1b2e]/[0.07]" style={{ inset: `${50 - RADII[1]}%` }} />
          {/* rotating dashed rings for life */}
          <div className="orbit-spin absolute rounded-full border border-dashed border-[#0d1b2e]/10" style={{ inset: '14%' }} />
          <div className="orbit-spin-rev absolute rounded-full border border-dashed border-[#0d1b2e]/[0.06]" style={{ inset: '4%' }} />

          {/* centre logo */}
          <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
            <span className="ping-slow absolute inset-0 rounded-full border-2 border-[#2f8cff]" />
            <div className="relative flex h-24 w-24 items-center justify-center rounded-full bg-white shadow-[0_18px_50px_-16px_rgba(47,140,255,0.55)] ring-1 ring-[#e5e9f0] md:h-28 md:w-28">
              <Logo size={72} />
            </div>
          </div>

          {/* bubbles */}
          {items.map((it, i) => {
            const r = RADII[it.ring] ?? RADII[0]
            const rad = (it.angle * Math.PI) / 180
            const x = 50 + r * Math.cos(rad)
            const y = 50 + r * Math.sin(rad)
            const isActive = active === i
            return (
              <div
                key={it.name}
                className="bubble-float absolute"
                style={{ left: `${x}%`, top: `${y}%`, animationDelay: `${i * 0.65}s`, zIndex: isActive ? 10 : 1 }}
              >
                <button
                  onClick={() => setActive(i)}
                  aria-label={it.name}
                  className={`flex h-11 w-11 items-center justify-center rounded-full border transition-all duration-300 md:h-16 md:w-16 ${
                    isActive
                      ? 'scale-125 border-transparent bg-[#101f38] shadow-[0_16px_36px_-14px_rgba(13,27,46,0.5)]'
                      : 'border-[#e5e9f0] bg-white shadow-[0_10px_26px_-14px_rgba(13,27,46,0.25)] hover:scale-110 hover:border-[#c9d3e2]'
                  }`}
                  style={isActive ? { boxShadow: `0 0 0 2px ${it.color}, 0 16px 36px -12px ${it.color}99` } : undefined}
                >
                  {it.icon(isActive ? it.color : '#4d5b72')}
                </button>
                <span
                  className="mono pointer-events-none absolute left-1/2 top-full mt-1.5 hidden -translate-x-1/2 whitespace-nowrap text-[9.5px] tracking-wide transition-opacity duration-300 sm:block"
                  style={{ color: isActive ? it.color : '#8a96a8' }}
                >
                  {it.name.toUpperCase()}
                </span>
              </div>
            )
          })}
        </div>

        {/* readout — the opened bubble */}
        <div className="reveal reveal-d3 mx-auto mt-12 max-w-[560px] text-left">
          <div
            key={active}
            className="swap-in v-card p-6 shadow-[0_20px_50px_-24px_rgba(13,27,46,0.2)]"
            onPointerEnter={() => setPaused(true)}
            onPointerLeave={() => setPaused(false)}
          >
            <div className="flex items-center gap-4">
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl" style={{ background: `${cur.color}1f` }}>
                {cur.icon(cur.color)}
              </span>
              <div className="min-w-0">
                <p className="text-[18px] font-semibold tracking-tight text-ink">{cur.name}</p>
                <p className="mono text-[11.5px]" style={{ color: cur.color }}>{cur.spec}</p>
              </div>
              <span className="mono ml-auto text-[12px] text-ink-3">{String(active + 1).padStart(2, '0')} / {String(items.length).padStart(2, '0')}</span>
            </div>
            <p className="mt-4 text-[14.5px] leading-relaxed text-ink-2">{cur.desc}</p>
            <div className="mt-5 flex items-center gap-1.5">
              {items.map((it, i) => (
                <button
                  key={it.name}
                  onClick={() => setActive(i)}
                  aria-label={`Show ${it.name}`}
                  className="h-1.5 rounded-full transition-all duration-300"
                  style={{ width: i === active ? 26 : 10, background: i === active ? it.color : '#d6dce6' }}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
