import { useEffect, useRef, useState } from 'react'

/**
 * Scroll progress (0..1) of an element travelling through the viewport.
 * 0 when its top crosses `startVh` of the viewport height,
 * 1 when its top reaches `(startVh - spanVh)` of the viewport height.
 */
export function useScrollProgress<T extends HTMLElement>(startVh = 0.88, spanVh = 0.45) {
  const ref = useRef<T>(null)
  const [p, setP] = useState(0)

  useEffect(() => {
    let raf = 0
    const update = () => {
      raf = 0
      const el = ref.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const vh = window.innerHeight
      const start = vh * startVh
      const end = vh * (startVh - spanVh)
      const v = (start - r.top) / (start - end)
      setP(Math.max(0, Math.min(1, v)))
    }
    const on = () => { if (!raf) raf = requestAnimationFrame(update) }
    update()
    window.addEventListener('scroll', on, { passive: true })
    window.addEventListener('resize', on)
    return () => {
      window.removeEventListener('scroll', on)
      window.removeEventListener('resize', on)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [startVh, spanVh])

  return { ref, p }
}
