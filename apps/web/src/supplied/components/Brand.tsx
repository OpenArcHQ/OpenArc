import logoUrl from "../media/openarc-logo.png";

export function Logo({ size = 26 }: { size?: number }) {
  return (
    <img
      src={logoUrl}
      alt="OpenArc logo"
      width={size}
      height={size}
      style={{ display: 'block' }}
      className="rounded-full"
    />
  )
}

export function Wordmark({ size = 26, dark = false }: { size?: number; dark?: boolean }) {
  return (
    <span className="flex items-center gap-2.5">
      <Logo size={size} />
      <span className={`text-[17px] font-bold tracking-tight ${dark ? 'text-white' : 'text-ink'}`}>OPENARC</span>
    </span>
  )
}

/** pill chip with a coloured dot — services-card style */
export function DotChip({ color, children, dark = false }: { color: string; children: React.ReactNode; dark?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12.5px] font-medium ${dark ? 'bg-white/10 text-white/85' : 'bg-[#f3f5f8] text-ink'}`}>
      <i className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      {children}
    </span>
  )
}

/** 3x3 dotted sparkle used across the design */
export function DotSparkle({ color = '#0d1b2e', cell = 6, gap = 5, className = '' }: { color?: string; cell?: number; gap?: number; className?: string }) {
  return (
    <span className={`dot-sparkle ${className}`} style={{ color, gridTemplateColumns: `repeat(3, ${cell}px)`, gap }}>
      {Array.from({ length: 9 }).map((_, i) => <i key={i} style={{ width: cell, height: cell }} />)}
    </span>
  )
}
