import { Link } from "../navigation.js"
import { DotSparkle } from '../components/Brand'

const tabs = [
  { label: 'x402 Lane', color: '#0f62fe' },
  { label: 'Budget Policy', color: '#8fbf2f' },
  { label: 'ERC-8183 Job', color: '#e8a93b' },
  { label: 'Evidence', color: '#0fb5d6' },
]

/** agent request bar — separator into the product story */
export default function RequestSeparator() {
  return (
    <section className="section-shell py-16">
      <div className="reveal mx-auto max-w-[720px] px-6">
        <div className="floaty rounded-2xl border border-[#e5e9f0] bg-white p-2 shadow-[0_24px_60px_-20px_rgba(13,27,46,0.18)]">
          <div className="flex items-center gap-2 rounded-xl border border-[#e5e9f0] bg-white px-4 py-3.5">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="#0f62fe"><path d="M12 2l2.1 7.9L22 12l-7.9 2.1L12 22l-2.1-7.9L2 12l7.9-2.1z"/></svg>
            <span className="mono truncate text-[13px] text-[#8a96a8]">local_review: synthetic proposal · max 25.00 USDC · scope: dataset</span>
          </div>
          <div className="mt-2 flex items-center justify-between px-1 pb-1">
            <div className="flex flex-wrap items-center gap-1.5">
              {tabs.map((t, i) => (
                <span
                  key={t.label}
                  className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-medium ${i === 0 ? 'border border-[#d9e6fd] bg-[#eef4fe] text-ink' : 'border border-transparent text-ink-2'}`}
                >
                  <DotSparkle color={t.color} cell={3} gap={1.5} />
                  {t.label}
                </span>
              ))}
            </div>
            <Link to="/app" className="btn-grad ml-2 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg" aria-label="Open console">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round">
                <path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4"/>
              </svg>
            </Link>
          </div>
        </div>
      </div>
    </section>
  )
}
