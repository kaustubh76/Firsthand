import type { SVGProps } from "react";

/** The icons the app uses, as 24-unit stroke paths — no icon package, no font. */
const PATHS = {
  check: "M20 6 9 17l-5-5",
  x: "M18 6 6 18M6 6l12 12",
  copy: "M8 8h12v12H8zM16 8V4H4v12h4",
  external: "M14 4h6v6M20 4l-9 9M19 14v6H4V5h6",
  settings:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z",
  camera: "M4 8h3l2-3h6l2 3h3v11H4zM12 17a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z",
  lock: "M6 11V8a6 6 0 0 1 12 0v3M5 11h14v10H5zM12 15v2",
  replay: "M3 12a9 9 0 1 0 3-6.7M3 4v5h5",
  shield: "M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3ZM9 12l2 2 4-4",
  chart: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  alert: "M12 3 2 21h20L12 3ZM12 10v5M12 18v.5",
  info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 11v6M12 7v.5",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 2",
  zap: "M13 2 4 14h7l-1 8 9-12h-7l1-8Z",
  upload: "M12 16V4M6 10l6-6 6 6M4 20h16",
  download: "M12 4v12M6 10l6 6 6-6M4 20h16",
  file: "M6 3h8l4 4v14H6zM14 3v4h4M9 13h6M9 17h6",
  image: "M4 5h16v14H4zM8 11a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM4 17l5-5 4 4 3-3 4 4",
  link: "M10 14a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1M14 10a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1",
  key: "M15 3a6 6 0 1 0-5.7 8L3 17.3V21h3.7L8 19.6V17h2.4l1.3-1.3A6 6 0 0 0 15 3ZM15 9v.5",
  fingerprint:
    "M6 11a6 6 0 0 1 12 0v2M9 11a3 3 0 0 1 6 0v6M12 11v9M5 15c0 3 1 5 2 6M18 15c0 2-.5 4-1.5 5.5",
  chevron: "m6 9 6 6 6-6",
  refresh: "M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5",
  sun: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10ZM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
  moon: "M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z",
  monitor: "M3 4h18v12H3zM8 20h8M12 16v4",
  wallet: "M3 7h16a2 2 0 0 1 2 2v10H3zM3 7V5h13v2M17 13v.5",
  receipt: "M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6",
  arrow: "M5 12h14M13 6l6 6-6 6",
  hash: "M4 9h16M4 15h16M10 3 8 21M16 3l-2 18",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12ZM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
  ban: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM5.6 5.6l12.8 12.8",
  stamp:
    "M12 3a3 3 0 0 0-3 3c0 2 1 3 1 5H7a3 3 0 0 0-3 3v1h16v-1a3 3 0 0 0-3-3h-3c0-2 1-3 1-5a3 3 0 0 0-3-3ZM5 19h14",
  plus: "M12 5v14M5 12h14",
  inbox: "M4 13h5l1 2h4l1-2h5M4 13V6h16v7M4 13v5h16v-5",
  scissors:
    "M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12",
  box: "M3 8 12 3l9 5v8l-9 5-9-5zM3 8l9 5 9-5M12 13v8",
  layers: "M12 3 3 8l9 5 9-5-9-5ZM3 12l9 5 9-5M3 16l9 5 9-5",
  send: "M22 2 11 13M22 2 15 22l-4-9-9-4z",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({
  name,
  size,
  className,
  ...rest
}: { name: IconName; size?: number | undefined; className?: string | undefined } & Omit<
  SVGProps<SVGSVGElement>,
  "name" | "className"
>) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      className={className ? `icon ${className}` : "icon"}
      style={size ? { width: size, height: size } : undefined}
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
