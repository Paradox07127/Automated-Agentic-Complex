// Self-drawn marks of the mission panel: type icons (mission/typeicon), the vital mark, the micro barcode, the location pin, the logo watermark.

/** Type icon: the downward triangle plate with a person (role task), code brackets (coding session) or a clock (schedule). */
export function TypeIcon({ kind }: { kind: 'role' | 'code' | 'sched' }) {
  return (
    <svg viewBox="0 0 48 48" fill="currentColor" aria-hidden="true">
      <path d="M4 6h40L24 44z" opacity=".9" />
      {kind === 'role' && (
        <g fill="var(--ef-canvas)">
          <circle cx="24" cy="17" r="5" />
          <path d="M17 31a7 7 0 0 1 14 0z" />
        </g>
      )}
      {kind === 'code' && <path d="M18 14l3 3-5 5 5 5-3 3-8-8zM30 14l8 8-8 8-3-3 5-5-5-5z" fill="var(--ef-canvas)" />}
      {kind === 'sched' && (
        <g fill="var(--ef-canvas)">
          <path fillRule="evenodd" d="M24 10a9 9 0 1 1 0 18 9 9 0 0 1 0-18zm0 3a6 6 0 1 0 0 12 6 6 0 0 0 0-12z" />
          <path d="M23 14h2.4v5H29v2.4h-6z" />
        </g>
      )}
    </svg>
  );
}

/** icon_mission_vital: yellow block with two exclamation marks and offset corner ticks. */
export function Vital({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 30 26" aria-hidden="true">
      <rect x="3" y="3" width="22" height="20" fill="var(--ef-accent)" />
      <rect x="0" y="0" width="3" height="3" fill="var(--ef-accent)" />
      <rect x="25" y="23" width="5" height="3" fill="var(--ef-accent)" />
      <path d="M9 7h3v9H9zM16 7h3v9h-3zM9 18h3v3H9zM16 18h3v3h-3z" fill="var(--ef-on-accent)" />
    </svg>
  );
}

/** deco_mission_left_01: a strip of bars, rules and boxes. */
export function Micro({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 60 8" fill="currentColor" aria-hidden="true">
      <path d="M0 0h3v8H0zM5 0h1v8H5zM8 0h4v8H8zM14 0h1v8h-1zM17 0h2v8h-2zM22 2h14v1H22zM22 5h10v1H22zM40 0h8v8h-8zM41 1v6h6V1zM52 0h8v8h-8z" />
    </svg>
  );
}

export function Pin() {
  return (
    <svg viewBox="0 0 16 24" width="14" height="20" fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" d="M8 1a7 7 0 0 1 7 7c0 5-7 12-7 12S1 13 1 8a7 7 0 0 1 7-7zm0 4a3 3 0 1 0 0 6 3 3 0 0 0 0-6z" />
      <path d="M3 22h3v2H3zM10 22h3v2h-3z" />
    </svg>
  );
}

/** The house-shaped logo watermark of BgContent. */
export function Logo({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 120 104" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M60 2l14 14-14 14-14-14z" />
      <path d="M4 70l26-26 30 30 30-30 26 26v30H86V82L60 98 34 82v18H4z" />
    </svg>
  );
}

/** Box with a lid: RewardsNode's faded reward icon. */
export function Box({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 1l10 5v12l-10 5-10-5V6z" opacity=".35" />
      <path d="M12 1l10 5-10 5L2 6z" />
      <path d="M13 12.6l9-4.5v9.9l-9 4.5zM14 17h2v3h-2zM17 15.5h1v3h-1zM19 14.5h1.5v3H19z" />
    </svg>
  );
}

export function Clock({ size = 12 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zM12 5a7 7 0 1 0 0 14 7 7 0 0 0 0-14z" />
      <path d="M11 7h2v5h4v2h-6z" />
    </svg>
  );
}

export function Warn({ size = 22 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true">
      <path fillRule="evenodd" d="M12 2l11 19H1zM11 9v6h2V9zM11 16.5v2h2v-2z" />
    </svg>
  );
}
