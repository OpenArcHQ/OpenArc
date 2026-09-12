import { useState } from "react";

const faqs = [
  {
    q: "What is OpenArc?",
    a: "OpenArc is a read-only evidence and investigation workspace for agent activity on Arc Testnet. The live features are bounded public-source observations and a locally encrypted Vault for private records. It is not a live marketplace, payment executor, or agent runner.",
  },
  {
    q: "Does OpenArc ever hold my keys or funds?",
    a: "OpenArc does not hold private keys, sign, broadcast, or execute transactions, and it is not a payment authority. Wallet sign-in, linking a payment wallet, and granting an agent spending permission are separate actions that are being implemented separately.",
  },
  {
    q: "How do budget guardrails work?",
    a: "The current interface supports local policy comparison and read-only evidence review. Durable financial budgets, reservations, grants, and revocation are an in-development commerce target, not shipped; proposed, authorized, fulfilled, and settled states remain distinct.",
  },
  {
    q: "What is the difference between x402 and ERC-8183?",
    a: "The commerce target separates x402 payment-request metadata from ERC-8183 job-state evidence. Payment evidence and job evidence answer different questions; neither the current app nor the target dispatches payments or runs jobs on your behalf.",
  },
  {
    q: "Which network does OpenArc launch on?",
    a: "Arc Testnet (eip155:5042002) is the only configured network context. Mainnet is not enabled and no launch or marketplace readiness is claimed.",
  },
  {
    q: "What does OpenArc not do?",
    a: "It does not custody funds, invent missing evidence, or treat settlement as proof of quality. Local monitoring rules do not enforce the behavior of external agents. Passkey accounts require minimum credential and security records and are not zero-retention; an account-free guest path is available for public browsing.",
  },
];

export default function Faq() {
  const [open, setOpen] = useState(0);

  return (
    <section className="section-shell py-24 md:py-28">
      <div className="mx-auto max-w-[1400px] px-6">
        <div className="reveal text-center">
          <span className="tag-label">[ faq ]</span>
          <h2 className="mt-4 text-[40px] md:text-[56px] font-bold leading-[1.05] tracking-[-0.03em] text-ink">
            Everything you need
            <br />
            to know
          </h2>
          <p className="mx-auto mt-5 max-w-[560px] text-[17px] leading-[1.6] text-ink-2">
            The short answers on private records, evidence, and what is available today.
          </p>
        </div>

        <div className="mt-14 grid gap-4 md:grid-cols-2 items-start">
          {faqs.map((f, i) => {
            const isOpen = open === i;
            return (
              <div
                key={i}
                className={`v-card reveal overflow-hidden transition-shadow duration-300 ${
                  isOpen ? "shadow-[0_18px_40px_-24px_rgba(13,27,46,0.25)]" : ""
                }`}
                style={{ transitionDelay: `${(i % 2) * 0.08}s` }}
              >
                <button
                  aria-expanded={isOpen}
                  aria-controls={`supplied-faq-${i}`}
                  onClick={() => setOpen(isOpen ? -1 : i)}
                  className="flex w-full items-center justify-between gap-4 px-7 py-6 text-left"
                >
                  <span className="text-[17px] font-semibold tracking-[-0.01em] text-ink">
                    {f.q}
                  </span>
                  <span
                    className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border text-[18px] leading-none transition-colors duration-300 ${
                      isOpen
                        ? "btn-grad border-transparent text-white"
                        : "border-line bg-bg text-ink"
                    }`}
                  >
                    {isOpen ? "−" : "+"}
                  </span>
                </button>
                <div id={`supplied-faq-${i}`} aria-hidden={!isOpen} className={`acc-body ${isOpen ? "open" : ""}`}>
                  <div className="acc-inner">
                    <p className="px-7 pb-7 text-[15px] leading-[1.7] text-ink-2">
                      {f.a}
                    </p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
