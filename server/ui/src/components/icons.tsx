import type { SVGProps } from "react";

// A handful of 16px stroke icons, inline so the page needs no icon font.
const Svg = ({ children, ...rest }: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
    {children}
  </svg>
);

export const IconRuns = () => (
  <Svg>
    <path d="M2 12.5 6 8l3 2.5L14 4" />
    <path d="M10.5 4H14v3.5" />
  </Svg>
);
export const IconDatasets = () => (
  <Svg>
    <ellipse cx="8" cy="3.75" rx="5.25" ry="1.75" />
    <path d="M2.75 3.75v8.5c0 .97 2.35 1.75 5.25 1.75s5.25-.78 5.25-1.75v-8.5" />
    <path d="M2.75 8c0 .97 2.35 1.75 5.25 1.75S13.25 8.97 13.25 8" />
  </Svg>
);
export const IconEvals = () => (
  <Svg>
    <path d="M3 13.25V8.5M8 13.25V2.75M13 13.25V6" />
  </Svg>
);
export const IconUsage = () => (
  <Svg>
    <rect x="2" y="3" width="12" height="10" rx="2" />
    <path d="M2 6.5h12M5 10h2" />
  </Svg>
);
export const IconHealth = () => (
  <Svg>
    <path d="M1.5 8h3l1.5-3.5 3 7L10.5 8h4" />
  </Svg>
);
export const IconSearch = () => (
  <Svg>
    <circle cx="7" cy="7" r="4.25" />
    <path d="m10.25 10.25 3.25 3.25" />
  </Svg>
);
export const IconChevron = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <path d="m6 3.5 4.5 4.5L6 12.5" />
  </Svg>
);
export const IconCopy = () => (
  <Svg>
    <rect x="5.25" y="5.25" width="8" height="8" rx="1.5" />
    <path d="M10.75 5.25V3.5a1 1 0 0 0-1-1H3.5a1 1 0 0 0-1 1v6.25a1 1 0 0 0 1 1h1.75" />
  </Svg>
);
export const IconCheck = () => (
  <Svg>
    <path d="m3 8.5 3 3 7-7" />
  </Svg>
);
export const IconDownload = () => (
  <Svg>
    <path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M2.75 13.25h10.5" />
  </Svg>
);
export const IconAlert = () => (
  <Svg>
    <path d="M8 1.75 14.5 13.5h-13L8 1.75Z" />
    <path d="M8 6.25v3M8 11.25v.01" />
  </Svg>
);
export const IconInfo = () => (
  <Svg>
    <circle cx="8" cy="8" r="6.25" />
    <path d="M8 7.25v4M8 4.75v.01" />
  </Svg>
);
export const IconStop = () => (
  <Svg>
    <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" />
  </Svg>
);
export const IconPlay = () => (
  <Svg>
    <path d="M4.5 3v10L13 8 4.5 3Z" />
  </Svg>
);
export const IconRefresh = () => (
  <Svg>
    <path d="M13.25 8a5.25 5.25 0 1 1-1.54-3.71" />
    <path d="M13.25 2.5v3h-3" />
  </Svg>
);
export const IconLogout = () => (
  <Svg>
    <path d="M6 2.75H3.75a1 1 0 0 0-1 1v8.5a1 1 0 0 0 1 1H6M10.5 11 13.5 8l-3-3M13.5 8H6" />
  </Svg>
);
export const IconCpu = () => (
  <Svg>
    <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" />
    <path d="M6 1.5v2M10 1.5v2M6 12.5v2M10 12.5v2M1.5 6h2M1.5 10h2M12.5 6h2M12.5 10h2" />
  </Svg>
);
export const IconImport = () => (
  <Svg>
    <path d="M8 1.75v7.5M5 6.5l3 3 3-3" />
    <path d="M2.5 10.5v1.75a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V10.5" />
  </Svg>
);
export const IconSun = () => (
  <Svg>
    <circle cx="8" cy="8" r="2.75" />
    <path d="M8 1.75v1.5M8 12.75v1.5M1.75 8h1.5M12.75 8h1.5M3.6 3.6l1.06 1.06M11.34 11.34l1.06 1.06M3.6 12.4l1.06-1.06M11.34 4.66l1.06-1.06" />
  </Svg>
);
export const IconMoon = () => (
  <Svg>
    <path d="M13.25 9.6A5.5 5.5 0 0 1 6.4 2.75a5.5 5.5 0 1 0 6.85 6.85Z" />
  </Svg>
);
export const IconInbox = () => (
  <Svg>
    <path d="M2 9.5 3.75 3.5h8.5L14 9.5v3a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-3Z" />
    <path d="M2 9.5h3.5l1 1.5h3l1-1.5H14" />
  </Svg>
);

/** The grad wordmark (docs/assets/grad-wordmark.svg): strokes in currentColor, the dot in --mark. */
export const Wordmark = ({ className = "wordmark" }: { className?: string }) => (
  <svg className={className} viewBox="0 0 306 126" role="img" aria-label="grad">
    <g fill="none" stroke="currentColor" strokeWidth={11} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="40" cy="60" r="26" />
      <path d="M66 34V92A26 26 0 0 1 19 107" />
      <path d="M96 86V60A26 26 0 0 1 122 34" />
      <circle cx="170" cy="60" r="26" />
      <path d="M196 34V86" />
      <circle cx="244" cy="60" r="26" />
      <path d="M270 8V86" />
    </g>
    <circle cx="292" cy="80.5" r="7" fill="var(--mark)" />
  </svg>
);
