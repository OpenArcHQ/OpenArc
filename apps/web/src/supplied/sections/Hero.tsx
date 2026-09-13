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
    <section className="oa-hero relative overflow-hidden bg-[#f6f7f9]">
      {/* ambient brand video, all the way in the back */}
      <video
        ref={video}
        className="oa-hero__video absolute inset-0 h-full w-full object-cover"
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
      <div className="oa-hero__tint absolute inset-0 bg-gradient-to-b from-white/35 via-[#eef3fb]/10 to-[#f6f7f9]/70 pointer-events-none" />
      <div className="grid-lines absolute inset-0 pointer-events-none" />
      {/* decorative dot sparkles */}
      <div className="oa-sparkle oa-sparkle--a absolute left-[6%] top-[220px] text-[#0d1b2e]/25 hidden lg:block"><DotSparkle /></div>
      <div className="oa-sparkle oa-sparkle--b absolute right-[7%] top-[260px] text-[#0d1b2e]/25 hidden lg:block"><DotSparkle /></div>
      <div className="oa-sparkle oa-sparkle--c absolute left-[13%] top-[430px] text-[#0f62fe]/40 hidden lg:block"><DotSparkle color="#0f62fe" /></div>
      <div className="oa-sparkle oa-sparkle--d absolute right-[13%] top-[470px] text-[#e8a93b]/50 hidden lg:block"><DotSparkle color="#e8a93b" /></div>

      <div className="oa-hero__inner relative mx-auto max-w-[1400px] px-6 pt-[150px] text-center">
        <p className="oa-hero__strapline tag-label reveal">[ commerce target · in development · evidence live today ]</p>
        <h1 className="oa-hero__title reveal reveal-d1 mt-5 text-ink">
          The commerce layer<br />for <span className="grad-text">AI agents</span> on Arc
        </h1>
        <div className="oa-hero__lede-group reveal reveal-d2 mx-auto mt-6 max-w-[680px] text-ink-2">
          <p className="oa-hero__lede">
            The commerce layer is under development and is not a live capability.
          </p>
          <p className="oa-hero__lede">
            Today OpenArc is a read-only evidence and investigation workspace: observe bounded public
            Arc activity and keep source-backed reports in your private, locally encrypted workspace.
          </p>
        </div>
        <div className="oa-hero__actions reveal reveal-d3 mt-9 flex flex-wrap items-center justify-center gap-3">
          <Link to="/app" className="btn-grad rounded-xl px-7 py-3.5 text-[15px] font-semibold text-white">
            Open workspace
          </Link>
          <Link to="/docs" className="btn-ghost rounded-xl px-7 py-3.5 text-[15px] font-semibold">
            Read the Docs
          </Link>
        </div>
        {unavailable ? <p className="oa-motion-status" role="status">Background animation unavailable. All features remain usable.</p> : <button
          type="button"
          className="oa-motion-control"
          aria-label={playing ? 'Pause background animation' : 'Play background animation'}
          onClick={() => {
            if (playing) video.current?.pause()
            else void video.current?.play().catch(() => setUnavailable(true))
          }}
        >
          <svg className="oa-motion-control__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            {playing ? <path d="M8 5h3v14H8zM13 5h3v14h-3z" /> : <path d="M8 5l11 7-11 7z" />}
          </svg>
          <span className="oa-motion-control__label">{playing ? 'Pause' : 'Play'}</span>
        </button>}
      </div>

      {/* app window mockup — oversized, wider than everything else */}
      <div className="oa-console relative mx-auto mt-16 px-6">
        <div
          aria-hidden
          className="oa-console__glow absolute inset-x-[8%] top-10 bottom-20 rounded-[60px] opacity-70 blur-3xl"
          style={{ background: 'linear-gradient(120deg, rgba(10,79,208,.22) 0%, rgba(15,98,254,.18) 45%, rgba(232,169,59,.22) 100%)' }}
        />
        <div className="oa-console__frame relative overflow-hidden rounded-t-[24px] rounded-b-[20px]">
          <div className="h-[5px] w-full" style={{ background: 'var(--grad)', backgroundSize: '220% 220%', backgroundPosition: '18% 50%' }} />
          <img
            src={consoleHero}
            alt="Illustrative OpenArc console preview"
            className="block w-full [mask-image:linear-gradient(180deg,black_52%,transparent_96%)]"
          />
          <span className="oa-console__badge mono absolute left-4 top-4 rounded-lg border border-[#e5e9f0] bg-white/90 px-2.5 py-1 text-[10.5px] text-ink-2 backdrop-blur">
            ILLUSTRATIVE PREVIEW · NOT LIVE OUTPUT
          </span>
        </div>
      </div>
    </section>
  )
}
