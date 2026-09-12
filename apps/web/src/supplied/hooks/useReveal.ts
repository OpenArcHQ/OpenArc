import { useEffect, useRef } from 'react'

/**
 * Reveal-on-scroll. Applies inline styles (not class names) once visible,
 * so later React re-renders that recompute className can never wipe the
 * visible state and make elements vanish.
 */
export function useReveal<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const targets = el.querySelectorAll<HTMLElement>('.reveal')
    const show = (t: HTMLElement) => {
      t.style.opacity = '1'
      t.style.transform = 'none'
    }
    const io = new IntersectionObserver(
      entries => entries.forEach(e => {
        if (e.isIntersecting) {
          show(e.target as HTMLElement)
          io.unobserve(e.target)
        }
      }),
      { threshold: 0.12 }
    )
    targets.forEach(t => {
      // if it was already revealed before a re-render, keep it visible
      if (t.classList.contains('is-visible') || t.style.opacity === '1') show(t)
      io.observe(t)
    })
    return () => io.disconnect()
  }, [])
  return ref
}
