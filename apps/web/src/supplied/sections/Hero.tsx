import { Link } from "../navigation.js"
import { DotSparkle } from '../components/Brand'
import heroBg from '../media/hero-bg.mp4'
import consoleHero from '../media/console-hero.png'
import { useEffect, useRef, useState } from 'react'

export default function Hero() {
  const video = useRef<HTMLVideoElement>(null)
  const [playing, setPlaying] = useState(false)
  const [unavailable, setUnavailable] = useState(false)
  useEffect(() => {
    const element = video.current
    if (!element) return
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)')
    const failed = () => { setUnavailable(true); setPlaying(false) }
    const sync = () => {
      if (element.error) { failed(); return }
      if (preference.matches) element.pause()
      else void element.play().catch(() => { if (element.error) failed(); else setPlaying(false) })
    }
    element.addEventListener('error', failed)
    sync()
    preference.addEventListener('change', sync)
    return () => { preference.removeEventListener('change', sync); element.removeEventListener('error', failed) }
  }, [])
  return (
    <section className="oa-hero relative overflow-hidden bg-[#f6f7f9] pt-[150px]">
      {/* ambient brand video, all the way in the back */}
      <video
        ref={video}
        className="absolute inset-0 h-full w-full object-cover"
        src={heroBg}
        preload="metadata"
        muted
        loop
        playsInline
        aria-hidden
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onError={() => { setUnavailable(true); setPlaying(false) }}
      />
      {/* readability tint over the video, under everything else */}
      <div className="absolute inset-0 bg-gradient-to-b from-white/35 via-[#eef3fb]/10 to-[#f6f7f9]/70 pointer-events-none" />
      <div className="grid-lines absolute inset-0 pointer-events-none" />
      {/* decorative dot sparkles */}
      <div className="absolute left-[6%] top-[220px] text-[#0d1b2e]/25 hidden lg:block"><DotSparkle /></div>
      <div className="absolute right-[7%] top-[260px] text-[#0d1b2e]/25 hidden lg:block"><DotSparkle /></div>
      <div className="absolute left-[13%] top-[430px] text-[#0f62fe]/40 hidden lg:block"><DotSparkle color="#0f62fe" /></div>
      <div className="absolute right-[13%] top-[470px] text-[#e8a93b]/50 hidden lg:block"><DotSparkle color="#e8a93b" /></div>

      <div className="relative mx-auto max-w-[1400px] px-6 text-center">
        <p className="tag-label reveal">[ commerce target · in development · evidence live today ]</p>
        <h1 className="reveal reveal-d1 mt-5 text-[52px] md:text-[76px] leading-[1.04] font-bold tracking-[-0.03em] text-ink">
          The commerce layer<br />for <span className="grad-text">AI agents</span> on Arc
        </h1>
        <p className="reveal reveal-d2 mx-auto mt-6 max-w-[680px] text-[18px] leading-relaxed text-ink-2">
          The commerce layer is under development and is not a live capability. Today OpenArc is a
          read-only evidence and investigation workspace: observe bounded public Arc activity and
          keep source-backed reports in your private, locally encrypted workspace.
        </p>
        <div className="reveal reveal-d3 mt-9 flex flex-wrap items-center justify-center gap-3">
          <Link to="/app" className="btn-grad rounded-xl px-7 py-3.5 text-[15px] font-semibold text-white">
            Open workspace
          </Link>
          <Link to="/docs" className="btn-ghost rounded-xl px-7 py-3.5 text-[15px] font-semibold">
            Read the Docs
          </Link>
        </div>
        {unavailable ? <p className="oa-motion-status" role="status">Background animation unavailable. All features remain usable.</p> : <button className="oa-motion-control" onClick={() => {
          if (playing) video.current?.pause()
          else void video.current?.play().catch(() => setUnavailable(true))
        }}>{playing ? 'Pause background animation' : 'Play background animation'}</button>}
      </div>

      {/* app window mockup — oversized, wider than everything else */}
      <div className="relative mx-auto mt-16 max-w-[1800px] px-6">
        <div
          aria-hidden
          className="absolute inset-x-[8%] top-10 bottom-20 rounded-[60px] opacity-70 blur-3xl"
          style={{ background: 'linear-gradient(120deg, rgba(10,79,208,.22) 0%, rgba(15,98,254,.18) 45%, rgba(232,169,59,.22) 100%)' }}
        />
        <div className="floaty relative overflow-hidden rounded-t-[24px] border border-b-0 border-[#dfe5ee] shadow-[0_80px_160px_-40px_rgba(13,27,46,0.4)]">
          <div className="h-[5px] w-full" style={{ background: 'var(--grad)', backgroundSize: '220% 220%', backgroundPosition: '18% 50%' }} />
          <img
            src={consoleHero}
            alt="Illustrative OpenArc console preview"
            className="block w-full [mask-image:linear-gradient(180deg,black_52%,transparent_96%)]"
          />
          <span className="mono absolute left-4 top-4 rounded-lg border border-[#e5e9f0] bg-white/90 px-2.5 py-1 text-[10.5px] text-ink-2 backdrop-blur">
            ILLUSTRATIVE PREVIEW · NOT LIVE OUTPUT
          </span>
        </div>
      </div>
    </section>
  )
}
