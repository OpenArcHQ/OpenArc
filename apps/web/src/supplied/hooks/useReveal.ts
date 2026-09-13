import { useEffect, useRef } from 'react'

const QUERY = '(prefers-reduced-motion: reduce)'

/**
 * Reveal-on-scroll. Applies inline styles (not class names) once visible,
 * so later React re-renders that recompute className can never wipe the
 * visible state and make elements vanish.
 *
 * Falls back to showing everything when IntersectionObserver is unavailable,
 * and shows everything immediately while reduced motion is requested.
 */
export function useReveal<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const targets = Array.from(el.querySelectorAll<HTMLElement>('.reveal'))
    if (targets.length === 0) return

    const show = (t: HTMLElement) => {
      t.style.opacity = '1'
      t.style.transform = 'none'
      t.classList.add('is-visible')
    }
    const showAll = () => targets.forEach(show)

    // Keep any element that was already revealed by a previous mount visible.
    targets.forEach(t => {
      if (t.classList.contains('is-visible') || t.style.opacity === '1') show(t)
    })

    if (typeof IntersectionObserver === 'undefined') {
      showAll()
      return
    }

    let io: IntersectionObserver
    try {
      io = new IntersectionObserver(
        entries => entries.forEach(e => {
          if (e.isIntersecting) {
            show(e.target as HTMLElement)
            io.unobserve(e.target)
          }
        }),
        { threshold: 0.12 }
      )
    } catch {
      // A present-but-unusable observer is treated the same as a missing one.
      showAll()
      return
    }
    const observeRemaining = () => targets.forEach(t => {
      if (t.style.opacity !== '1') io.observe(t)
    })

    const media = typeof window.matchMedia === 'function' ? window.matchMedia(QUERY) : null
    const applyPreference = () => {
      if (media?.matches) {
        showAll()
        io.disconnect()
      } else {
        observeRemaining()
      }
    }

    applyPreference()
    media?.addEventListener('change', applyPreference)
    return () => {
      media?.removeEventListener('change', applyPreference)
      io.disconnect()
    }
  }, [])
  return ref
}
