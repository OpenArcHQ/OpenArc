import { useEffect, useState } from 'react'
import { DotSparkle } from '../components/Brand'
import { useReducedMotion } from '../hooks/useReducedMotion'

const steps = [
  {
    badge: 'STEP 1',
    color: '#0f62fe',
    title: 'Review local consent',
    desc: 'The owner reviews a bounded read request with an explicit scope. Private keys stay outside OpenArc.',
    points: ['Scope: what may be observed, and where', 'Consent: persist the receipt before a network read', 'Vault: lock, export, import, and delete locally'],
    caption: 'Consent for observation is not permission to spend',
  },
  {
    badge: 'STEP 2',
    color: '#e8a93b',
    title: 'Simulate an action',
    desc: 'A local simulator compares a synthetic proposal with its constraints. No AI runner, provider call, signing, or payment is enabled.',
    points: ['Proposal: exact task and payment constraints', 'Review: repeated local comparison is allowed', 'Execution: intentionally unavailable in A01'],
    caption: 'A simulated action is not a purchase',
  },
  {
    badge: 'STEP 3',
    color: '#0fb5d6',
    title: 'Keep evidence distinct',
    desc: 'The workspace links available local, imported, agent-reported, provider, and bounded onchain evidence without filling gaps.',
    points: ['Classes: source type remains explicit', 'Recon: conflicts fail closed', 'Quality: fulfillment never proves quality'],
    caption: 'PROPOSED ≠ AUTHORIZED ≠ FULFILLED ≠ SETTLED',
  },
]

/* ---------- step mockups ---------- */

function MockSession() {
  return (
    <div className="swap-in mx-auto max-w-[420px]">
      <div className="v-card overflow-hidden text-left shadow-[0_18px_44px_-22px_rgba(13,27,46,0.18)]">
        <div className="flex items-center justify-between border-b border-[#e5e9f0] px-5 py-3">
          <span className="mono text-[12px] font-medium text-ink">SESSION ses_8f21c4</span>
          <span className="mono rounded-md bg-[#8fbf2f]/15 px-2 py-1 text-[10px] font-medium text-[#6a9422]">LOCAL REVIEW</span>
        </div>
        <div className="space-y-2.5 p-5">
          {[
            ['AGENT', 'atlas-04 · erc8004:0x7f3a…9c2e'],
            ['SCOPE', 'bounded read · Testnet only'],
            ['EXPIRES', 'consent receipt required'],
          ].map(([k, v]) => (
            <div key={k} className="flex items-center justify-between gap-3">
              <span className="mono text-[11px] text-ink-3">{k}</span>
              <span className="mono text-[12px] text-ink">{v}</span>
            </div>
          ))}
          <div className="pt-1.5">
            <div className="mono flex justify-between text-[11px] text-ink-3"><span>NETWORK</span><span className="text-ink-2">eip155:5042002</span></div>
            <div className="meter mt-1.5"><i style={{ width: '55%' }} /></div>
            <div className="mono mt-2 flex justify-between text-[11px] text-ink-3"><span>PRIVATE DATA</span><span className="text-[#e8a93b]">LOCAL VAULT</span></div>
          </div>
        </div>
        <div className="border-t border-[#e5e9f0] bg-[#fafbfc] px-5 py-3">
          <p className="mono text-[11px] text-ink-3">READ-ONLY CONSENT · NO SIGNING</p>
        </div>
      </div>
    </div>
  )
}

function MockTransact() {
  return (
    <div className="swap-in">
      <div className="flex justify-end">
        <div className="max-w-[320px] rounded-2xl rounded-br-md border border-[#e5e9f0] bg-white px-5 py-4 text-[15px] leading-snug text-ink shadow-sm">
          Review synthetic dataset proposal · max 25.00 USDC
        </div>
      </div>
      <div className="mt-5 flex items-center gap-2 text-[13px] text-[#8a96a8]">
        <span className="flex gap-1">
          <i className="pulse-dot h-1.5 w-1.5 rounded-full bg-[#c3c4c4]" />
          <i className="pulse-dot h-1.5 w-1.5 rounded-full bg-[#c3c4c4]" style={{ animationDelay: '.2s' }} />
          <i className="pulse-dot h-1.5 w-1.5 rounded-full bg-[#c3c4c4]" style={{ animationDelay: '.4s' }} />
        </span>
        Comparing constraints locally…
      </div>
      <div className="v-card mx-auto mt-4 max-w-[420px] overflow-hidden text-left shadow-[0_18px_44px_-22px_rgba(13,27,46,0.18)]">
        <div className="flex items-center justify-between border-b border-[#e5e9f0] px-5 py-3">
          <span className="mono text-[12px] font-medium text-ink">PURCHASE INTENT REVIEW</span>
          <span className="mono rounded-md bg-[#e8a93b]/15 px-2 py-1 text-[10px] font-medium text-[#b07f1e]">SIMULATED</span>
        </div>
        <div className="space-y-2.5 p-5">
          {[
            ['PROPOSAL', 'synthetic · scope: dataset'],
            ['AMOUNT', '25.00 USDC'],
            ['LANE', 'x402 reference · not called'],
            ['COUNTERPARTY', 'illustrative only'],
          ].map(([k, v]) => (
            <div key={k} className="flex items-center justify-between gap-3">
              <span className="mono text-[11px] text-ink-3">{k}</span>
              <span className="mono text-[12px] text-ink">{v}</span>
            </div>
          ))}
        </div>
        <div className="border-t border-[#e5e9f0] bg-[#fafbfc] px-5 py-3">
          <p className="mono text-[11px] text-ink-3">NO PROVIDER CALL · NO SIGNING · NO PAYMENT</p>
        </div>
      </div>
    </div>
  )
}

function MockEvidence() {
  const rows = [
    { s: 'PROPOSED', t: 'local', c: '#0f62fe' },
    { s: 'REVIEWED', t: 'local', c: '#e8a93b' },
    { s: 'FULFILLMENT UNVERIFIED', t: 'missing', c: '#0fb5d6' },
    { s: 'SETTLEMENT UNVERIFIED', t: 'missing', c: '#8fbf2f' },
  ]
  return (
    <div className="swap-in mx-auto max-w-[420px]">
      <div className="v-card overflow-hidden text-left shadow-[0_18px_44px_-22px_rgba(13,27,46,0.18)]">
        <div className="flex items-center justify-between border-b border-[#e5e9f0] px-5 py-3">
          <span className="mono text-[12px] font-medium text-ink">ACTION 3fa9…81bd</span>
          <span className="mono rounded-md bg-[#e8a93b]/15 px-2 py-1 text-[10px] font-medium text-[#b07f1e]">REVIEW ONLY</span>
        </div>
        <div className="space-y-2.5 p-5">
          {rows.map((r, i) => (
            <div key={r.s} className="flex items-center justify-between gap-3">
              <span className="mono flex items-center gap-2 text-[11px] text-ink-3">
                <i className="h-1.5 w-1.5 rounded-full" style={{ background: r.c }} />
                <span className="font-medium tracking-wide" style={{ color: r.c }}>{r.s}</span>
              </span>
              <span className="mono text-[12px] text-ink">{r.t} · rcpt_{i + 1}</span>
            </div>
          ))}
        </div>
        <div className="border-t border-[#e5e9f0] bg-[#fafbfc] px-5 py-3">
          <p className="mono text-[11px] text-ink-3">ILLUSTRATIVE · MISSING LINKS PRESERVED</p>
        </div>
      </div>
    </div>
  )
}

/* ---------- section ---------- */

export default function HowItWorks() {
  const [active, setActive] = useState(0)
  const reduced = useReducedMotion()

  useEffect(() => {
    if (reduced) return
    const t = setInterval(() => setActive(a => (a + 1) % steps.length), 5000)
    return () => clearInterval(t)
  }, [reduced])

  const pick = (i: number) => setActive(i)

  return (
    <section className="section-shell py-24">
      <div className="mx-auto max-w-[1400px] px-6 text-center">
        <p className="tag-label reveal">[ how it works ]</p>
        <h2 className="reveal reveal-d1 mt-4 text-[40px] md:text-[56px] leading-[1.08] font-bold tracking-[-0.03em] text-ink">
          From local intent to<br />evidence you can inspect
        </h2>
        <p className="reveal reveal-d2 mx-auto mt-5 max-w-[560px] text-[17px] text-ink-2">
          No key custody and no blind signing. You review the limits,<br className="hidden md:block" /> and simulated actions stay local.
        </p>

        <div className="mt-14 grid items-stretch gap-5 lg:grid-cols-[1fr_1.35fr] text-left">
          {/* steps — clickable */}
          <div className="flex flex-col gap-4">
            {steps.map((s, i) => {
              const isActive = active === i
              return (
                <button
                  key={s.badge}
                  onClick={() => pick(i)}
                  className={`reveal ${i === 1 ? 'reveal-d1' : i === 2 ? 'reveal-d2' : ''} group relative flex-1 overflow-hidden rounded-[16px] p-7 text-left transition-all duration-300 ${
                    isActive ? 'grad-border shadow-[0_24px_60px_-24px_rgba(10,79,208,0.3)]' : 'v-card hover:shadow-[0_16px_40px_-22px_rgba(13,27,46,0.16)]'
                  }`}
                >
                  <span
                    className={`absolute inset-y-0 left-0 w-[4px] transition-opacity duration-300 ${isActive ? 'opacity-100' : 'opacity-0'}`}
                    style={{ background: `linear-gradient(180deg, ${s.color}, ${s.color}55)` }}
                  />
                  <div className="flex items-center justify-between">
                    <span className={`mono inline-block rounded-md px-2.5 py-1.5 text-[12px] font-medium ${isActive ? 'btn-grad text-white' : 'bg-[#f4f4f4] text-ink-2'}`}>{s.badge}</span>
                    {isActive && <DotSparkle color={s.color} cell={4} gap={3} />}
                  </div>
                  <h3 className="mt-5 text-[24px] font-semibold tracking-tight text-ink">{s.title}</h3>
                  <p className="mt-2.5 text-[15px] leading-relaxed text-ink-2">{s.desc}</p>
                  <ul className="mt-4 space-y-2 border-t border-[#eef1f6] pt-4">
                    {s.points.map(p => (
                      <li key={p} className="flex items-start gap-2.5 text-[13.5px] leading-snug text-ink-2">
                        <span className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: s.color }} />
                        {p}
                      </li>
                    ))}
                  </ul>
                  {/* progress bar while active */}
                  {isActive && (
                    <span className="absolute bottom-0 left-0 h-[3px] w-full origin-left bg-black/5">
                      <i
                        key={active}
                        className="block h-full"
                        style={{ background: s.color, animation: 'step-progress 5s linear forwards' }}
                      />
                    </span>
                  )}
                </button>
              )
            })}
          </div>

          {/* flipping mockup panel */}
          <div className="reveal reveal-d1 v-card relative overflow-hidden bg-gradient-to-b from-[#eaf1fc] to-white p-6 md:p-8">
            <div className="flex items-center justify-center gap-2">
              {steps.map((s, i) => (
                <button
                  key={s.badge}
                  onClick={() => pick(i)}
                  aria-label={`Show ${s.title}`}
                  className="h-1.5 rounded-full transition-all duration-300"
                  style={{ width: active === i ? 28 : 10, background: active === i ? s.color : '#d6dce6' }}
                />
              ))}
            </div>
            <p className="mt-4 text-center text-[13.5px] italic text-ink-2">{steps[active]?.caption}</p>
            <div className="mt-6" key={active}>
              {active === 0 && <MockSession />}
              {active === 1 && <MockTransact />}
              {active === 2 && <MockEvidence />}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
