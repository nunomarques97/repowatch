// Line icons from the design mocks (docs/design/shared/data.js), 16x16, drawn
// with the current text colour. Decorative: always paired with words or an
// accessible name on the control.

const PATHS = {
  search: (
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.5 10.5 3 3" />
    </>
  ),
  refresh: (
    <>
      <path d="M13 8a5 5 0 1 1-1.5-3.6" />
      <path d="M13 2.5v3h-3" />
    </>
  ),
  settings: (
    <>
      <circle cx="8" cy="8" r="2" />
      <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
    </>
  ),
  branch: (
    <>
      <circle cx="4.5" cy="3.5" r="1.5" />
      <circle cx="4.5" cy="12.5" r="1.5" />
      <circle cx="11.5" cy="5.5" r="1.5" />
      <path d="M4.5 5v6M11.5 7c0 3-7 2-7 4" />
    </>
  ),
  stash: (
    <>
      <path d="M2.5 9.5h3l1 1.5h3l1-1.5h3" />
      <path d="M2.5 9.5 4 4h8l1.5 5.5V13h-11z" />
    </>
  ),
  worktree: (
    <>
      <path d="M2.5 4.5h4l1 1.5h6v6.5h-11z" />
      <path d="M8 8.5v2.5M6.5 9.75h3" />
    </>
  ),
  lost: (
    <>
      <path d="M3 8a5 5 0 1 0 1.5-3.6" />
      <path d="M3 2.5v3h3" />
      <path d="M8 5.5V8l1.8 1.2" />
    </>
  ),
  detached: (
    <>
      <path d="M6.5 9.5 9.5 6.5" />
      <path d="M7 4.5 8.5 3a2.5 2.5 0 0 1 3.5 3.5L10.5 8M9 11.5 7.5 13A2.5 2.5 0 0 1 4 9.5L5.5 8" />
    </>
  ),
  cloudOff: (
    <>
      <path d="M4.5 12.5h7a2.5 2.5 0 0 0 .4-5A4 4 0 0 0 4.6 6 3.3 3.3 0 0 0 4.5 12.5z" />
      <path d="m2 2 12 12" />
    </>
  ),
  alert: (
    <>
      <path d="M8 2.5 14 13H2z" />
      <path d="M8 6.5v3M8 11.2v.1" />
    </>
  ),
  check: <path d="m3.5 8.5 3 3 6-7" />,
  up: <path d="M8 13V3M4 7l4-4 4 4" />,
  down: <path d="M8 3v10M4 9l4 4 4-4" />,
  folder: <path d="M2 4.5h4l1.2 1.5H14v7H2z" />,
  back: <path d="M10 4 6 8l4 4" />,
  plus: <path d="M8 3v10M3 8h10" />,
  minus: <path d="M3 8h10" />,
  close: <path d="m4 4 8 8M12 4l-8 8" />,
  commit: (
    <>
      <circle cx="8" cy="8" r="2.5" />
      <path d="M1.5 8h4M10.5 8h4" />
    </>
  ),
  eye: (
    <>
      <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="2" />
    </>
  ),
  keyboard: (
    <>
      <rect x="1.5" y="4" width="13" height="8.5" rx="1.5" />
      <path d="M4 7h.5M6.5 7h.5M9 7h.5M11.5 7h.5M5 10h6" />
    </>
  ),
  theme: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 2.5v11a5.5 5.5 0 0 0 0-11z" fill="currentColor" stroke="none" />
    </>
  ),
  terminal: (
    <>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="m4.5 6 2 2-2 2M8 10.5h3.5" />
    </>
  ),
  code: <path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5" />,
  go: <path d="M3 8h10M9 4l4 4-4 4" />,
  filter: <path d="M2 3.5h12L9.5 9v4l-3-1.5V9z" />,
  sort: <path d="M5 2.5v11M2.5 11 5 13.5 7.5 11M11 13.5v-11M8.5 5 11 2.5 13.5 5" />,
  rows: <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />,
  fetch: (
    <>
      <path d="M8 2v8M5 7l3 3 3-3" />
      <path d="M2.5 11.5v2h11v-2" />
    </>
  ),
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg className={className ? `icon ${className}` : 'icon'} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {PATHS[name]}
    </svg>
  );
}
