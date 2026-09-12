import { Link } from "../navigation.js";
import { SUPPLIED_FAQ_GROUPS } from "../faq-content.js";

export default function FaqPage() {
  return (
    <div className="supplied-home min-h-screen bg-bg font-sans text-ink antialiased">
      <main id="supplied-main-content" tabIndex={-1} className="supplied-faq-page">
        <div className="supplied-faq-page__inner">
          <p className="tag-label">[ faq ]</p>
          <h1 className="supplied-faq-page__title">Dedicated questions and answers</h1>
          <p className="supplied-faq-page__lede">
            Short answers about what is live today, the in-development commerce target, and how
            accounts, access and privacy are intended to work.
          </p>

          {SUPPLIED_FAQ_GROUPS.map((group) => (
            <section key={group.id} className="supplied-faq-group" aria-labelledby={`supplied-faq-${group.id}`}>
              <h2 id={`supplied-faq-${group.id}`} className="supplied-faq-group__title">
                {group.title}
              </h2>
              <div className="supplied-faq-group__items">
                {group.items.map((item) => (
                  <details key={item.id} className="supplied-faq-item" data-testid={`supplied-faq-item-${item.id}`}>
                    <summary className="supplied-faq-item__summary">{item.question}</summary>
                    <p className="supplied-faq-item__answer">{item.answer}</p>
                  </details>
                ))}
              </div>
            </section>
          ))}

          <nav className="supplied-faq-page__nav" aria-label="FAQ navigation">
            <Link to="/" className="btn-ghost">
              Back to overview
            </Link>
            <Link to="/docs" className="btn-ghost">
              Read the docs
            </Link>
          </nav>
        </div>
      </main>
    </div>
  );
}
