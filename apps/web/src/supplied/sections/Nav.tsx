import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from "../navigation.js"
import { Logo } from '../components/Brand'
import WalletButton from '../components/WalletButton'

const links = [
  { label: 'Stack', href: '#stack' },
  { label: 'About', href: '#about' },
  { label: 'Product', href: '#product' },
  { label: 'Pillars', href: '#pillars' },
  { label: 'Case Study', href: '#case-study' },
  { label: 'Roadmap', href: '#roadmap' },
]

export default function Nav() {
  const [open, setOpen] = useState(false)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const loc = useLocation()
  const nav = useNavigate()

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(false)
      toggleRef.current?.focus()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open])

  const goAnchor = (href: string) => {
    setOpen(false)
    if (loc.pathname !== '/') {
      nav('/')
      setTimeout(() => document.querySelector(href)?.scrollIntoView({ behavior: 'smooth' }), 120)
    } else {
      document.querySelector(href)?.scrollIntoView({ behavior: 'smooth' })
    }
  }

  return (
    <header className="fixed top-0 left-0 right-0 z-50">
      <div className="mx-auto max-w-[1400px] px-6">
        <div className="rounded-b-2xl bg-white/85 backdrop-blur border border-t-0 border-[#e5e9f0] px-5">
          <div className="flex h-[68px] items-center justify-between">
            <Link to="/" className="flex items-center gap-2.5" aria-label="OpenArc home">
              <Logo size={26} />
              <span className="text-[17px] font-bold tracking-tight text-ink">OPENARC</span>
            </Link>
            <nav className="hidden lg:flex items-center gap-6">
              {links.map(l => (
                <button key={l.label} onClick={() => goAnchor(l.href)} className="text-[15px] font-medium text-ink hover:opacity-60 transition-opacity">
                  {l.label}
                </button>
              ))}
              <Link to="/docs" className="text-[15px] font-medium text-ink hover:opacity-60 transition-opacity">
                Docs
              </Link>
            </nav>
            <div className="hidden lg:flex items-center gap-2.5">
              <Link to="/app" className="btn-grad rounded-lg px-5 py-2.5 text-[14px] font-semibold text-white">
                Dashboard
              </Link>
              <WalletButton compact />
            </div>
            {/* mobile toggle */}
            <button
              ref={toggleRef}
              type="button"
              className="flex h-10 w-10 items-center justify-center rounded-lg border border-line lg:hidden"
              onClick={() => setOpen(v => !v)}
              aria-label={open ? 'Close menu' : 'Open menu'}
              aria-expanded={open}
              aria-controls="supplied-mobile-menu"
            >
              <div className="space-y-1.5">
                <span className={`block h-[2px] w-5 bg-ink transition-transform ${open ? 'translate-y-[7.5px] rotate-45' : ''}`} />
                <span className={`block h-[2px] w-5 bg-ink transition-opacity ${open ? 'opacity-0' : ''}`} />
                <span className={`block h-[2px] w-5 bg-ink transition-transform ${open ? '-translate-y-[8px] -rotate-45' : ''}`} />
              </div>
            </button>
          </div>

          {/* mobile menu */}
          <div
            id="supplied-mobile-menu"
            className={`acc-body lg:hidden ${open ? 'open' : ''}`}
            inert={!open}
            aria-hidden={!open}
          >
            <div className="acc-inner">
              <div className="space-y-1 border-t border-line py-4">
                {links.map(l => (
                  <button
                    key={l.label}
                    onClick={() => goAnchor(l.href)}
                    className="block w-full rounded-lg px-3 py-2.5 text-left text-[15px] font-medium text-ink-2 hover:bg-canvas hover:text-ink"
                  >
                    {l.label}
                  </button>
                ))}
                <Link
                  to="/docs"
                  onClick={() => setOpen(false)}
                  className="block rounded-lg px-3 py-2.5 text-[15px] font-medium text-ink-2 hover:bg-canvas hover:text-ink"
                >
                  Docs
                </Link>
                <div className="flex flex-col gap-2 px-1 pt-3">
                  <Link
                    to="/app"
                    onClick={() => setOpen(false)}
                    className="btn-grad inline-flex h-[46px] items-center justify-center rounded-xl px-5 text-[14px] font-semibold text-white"
                  >
                    Dashboard
                  </Link>
                  <WalletButton />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </header>
  )
}
