import { DotSparkle, Logo } from '../components/Brand'
import { useScrollProgress } from '../hooks/useScrollProgress'

/* emphasis phrases wrapped in *asterisks* — they light up in gradient */
const STORY =
  "We're a small crew of *passionate devs* building a private evidence and policy interface for agent activity. *Arc Testnet* is our bounded starting point, and that is exactly the *opportunity to learn carefully.* We are building non-custodial, evidence-backed tooling one gated milestone at a time."

const WORDS: { t: string; em: boolean }[] = STORY.split(/(\*[^*]+\*)/g).flatMap(seg =>
  seg.startsWith('*')
    ? seg.replace(/\*/g, '').split(' ').map((t): { t: string; em: boolean } => ({ t, em: true }))
    : seg.split(' ').filter(Boolean).map((t): { t: string; em: boolean } => ({ t, em: false })),
)

const beliefs = [
  {
    color: '#0f62fe',
    title: 'No shortcuts on trust',
    desc: 'We’d rather ship late than ship blind. If evidence is missing, our system says so instead of papering over it.',
  },
  {
    color: '#e8a93b',
    title: 'Builders, not tourists',
    desc: 'We test the boundaries of agent activity on Arc Testnet without custody or execution. OpenArc is the tooling we wished existed when we started.',
  },
  {
    color: '#8fbf2f',
    title: 'Early is an advantage',
    desc: 'We are early enough to make the evidence and permission boundaries explicit before broader agent activity is enabled.',
  },
]

export default function About() {
  const { ref, p } = useScrollProgress<HTMLDivElement>(0.92, 0.42)
  const lit = Math.round(p * WORDS.length * 1.06)

  return (
    <section className="section-shell py-24 md:py-28" id="about">
      <div className="mx-auto max-w-[1400px] px-6 text-center">
        <p className="tag-label reveal">[ about us ]</p>

        {/* scroll-driven word reveal */}
        <div ref={ref} className="mx-auto mt-8 max-w-[980px]">
          <p className="text-[28px] font-semibold leading-[1.32] tracking-[-0.02em] text-ink md:text-[42px] md:leading-[1.28]">
            {WORDS.map((w, i) => (
              <span key={i} className={`wr-word mr-[0.26em] ${i < lit ? 'lit' : ''} ${w.em && i < lit ? 'grad-text' : ''}`}>
                {w.t}
              </span>
            ))}
          </p>
        </div>

        {/* belief cards */}
        <div className="mt-16 grid gap-5 text-left md:grid-cols-3">
          {beliefs.map((b, i) => (
            <div
              key={b.title}
              className={`reveal ${i === 1 ? 'reveal-d1' : i === 2 ? 'reveal-d2' : ''} group relative overflow-hidden v-card p-7 transition-all duration-300 hover:-translate-y-1 hover:shadow-[0_20px_50px_-22px_rgba(13,27,46,0.2)]`}
            >
              <span
                className="absolute inset-x-0 top-0 h-[4px] transition-all duration-300 group-hover:h-[6px]"
                style={{ background: `linear-gradient(90deg, ${b.color}, ${b.color}55)` }}
              />
              <div className="flex items-center justify-between">
                <DotSparkle color={b.color} cell={5} gap={4} />
                <span className="mono text-[12px] text-ink-3">0{i + 1}</span>
              </div>
              <h3 className="mt-5 text-[19px] font-semibold tracking-tight text-ink">{b.title}</h3>
              <p className="mt-2 text-[14.5px] leading-relaxed text-ink-2">{b.desc}</p>
            </div>
          ))}
        </div>

        <div className="reveal mt-10 flex items-center justify-center gap-4">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white shadow-sm"><Logo size={30} /></span>
          <div className="text-left">
            <p className="text-[15px] font-bold text-ink">The OpenArc team</p>
            <p className="mono text-[12px] text-ink-3">BUILDING ON ARC TESTNET · READ-ONLY + LOCAL</p>
          </div>
        </div>
      </div>
    </section>
  )
}
