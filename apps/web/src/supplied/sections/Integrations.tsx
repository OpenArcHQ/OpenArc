const tools = [
  { label: 'Arc Testnet', w: 150 },
  { label: 'Circle Gateway', w: 190 },
  { label: 'USDC', w: 80 },
  { label: 'x402', w: 70 },
  { label: 'ERC-8004', w: 120 },
  { label: 'ERC-8183', w: 120 },
  { label: 'MetaMask', w: 140 },
  { label: 'Blockscout', w: 150 },
]

export default function Integrations() {
  return (
    <section className="section-shell py-20">
      <p className="text-center text-[15px] font-medium text-ink-2 reveal">Reviews the agent commerce stack</p>
      <div className="relative mt-9 overflow-hidden [mask-image:linear-gradient(90deg,transparent,black_12%,black_88%,transparent)]">
        <div className="marquee-track slow items-center gap-24 pr-24">
          {[...tools, ...tools].map((t, i) => (
            <span key={i} style={{ width: t.w }} className="shrink-0 text-center text-[24px] font-bold tracking-[-0.02em] text-[#b8c0cd]">
              {t.label}
            </span>
          ))}
        </div>
      </div>
    </section>
  )
}
