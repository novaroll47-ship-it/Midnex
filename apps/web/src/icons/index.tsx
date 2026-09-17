/** Иконки интерфейса. Инлайн-SVG: без внешних запросов и без зависимостей. */
import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 18, children, ...rest }: P) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const MenuIcon = (p: P) => (
  <Svg {...p}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Svg>
);

export const DotsIcon = (p: P) => (
  <Svg {...p} strokeWidth={2.4}>
    <path d="M7 12h.01M12 12h.01M17 12h.01" />
  </Svg>
);

export const GearIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z" />
  </Svg>
);

export const SlidersIcon = (p: P) => (
  <Svg {...p}>
    <path d="M4 8h10M18 8h2M4 16h4M12 16h8" />
    <circle cx="16" cy="8" r="2" />
    <circle cx="10" cy="16" r="2" />
  </Svg>
);

export const ChevronRightIcon = (p: P) => (
  <Svg {...p} size={p.size ?? 16}>
    <path d="m9 5 7 7-7 7" />
  </Svg>
);

export const ChevronDownIcon = (p: P) => (
  <Svg {...p} size={p.size ?? 14}>
    <path d="m5 9 7 7 7-7" />
  </Svg>
);

export const BoltIcon = (p: P) => (
  <Svg {...p}>
    <path d="M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12l1-8.5Z" />
  </Svg>
);

export const FilterIcon = (p: P) => (
  <Svg {...p} size={p.size ?? 15}>
    <path d="M3 5h18l-7 8.2V20l-4 1.5v-8.3L3 5Z" />
  </Svg>
);

export const LinkIcon = (p: P) => (
  <Svg {...p} size={p.size ?? 13}>
    <path d="M9.5 14.5a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 1 0-5-5l-1 1" />
    <path d="M14.5 9.5a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 1 0 5 5l1-1" />
  </Svg>
);

export const PencilIcon = (p: P) => (
  <Svg {...p} size={p.size ?? 14}>
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4 11.5-11.5Z" />
  </Svg>
);

export const DetailsIcon = (p: P) => (
  <Svg {...p} size={p.size ?? 14}>
    <path d="M4 7h6M14 7h6M4 17h10M18 17h2" />
    <circle cx="12" cy="7" r="1.8" />
    <circle cx="16" cy="17" r="1.8" />
  </Svg>
);

export const ShieldIcon = (p: P) => (
  <Svg {...p} size={p.size ?? 15}>
    <path d="M12 3 5 6v5.5c0 4 2.9 7.7 7 9.5 4.1-1.8 7-5.5 7-9.5V6l-7-3Z" />
  </Svg>
);

export const ChartIcon = (p: P) => (
  <Svg {...p} size={p.size ?? 21}>
    <rect x="3" y="3" width="18" height="18" rx="4" />
    <path d="m7 14 3-3.5 2.5 2L17 8" />
  </Svg>
);

export const BriefcaseIcon = (p: P) => (
  <Svg {...p} size={p.size ?? 21}>
    <rect x="3" y="7" width="18" height="13" rx="3" />
    <path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7M3 12h18" />
  </Svg>
);

export const CheckIcon = (p: P) => (
  <Svg {...p} size={p.size ?? 13} strokeWidth={3}>
    <path d="m4.5 12.5 5 5 10-11" />
  </Svg>
);

export const PlusIcon = (p: P) => (
  <Svg {...p} size={p.size ?? 16}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

export const ArrowUpIcon = (p: P) => (
  <Svg {...p} size={p.size ?? 11} strokeWidth={2.4}>
    <path d="M12 19V5M6 11l6-6 6 6" />
  </Svg>
);

export const ArrowDownIcon = (p: P) => (
  <Svg {...p} size={p.size ?? 11} strokeWidth={2.4}>
    <path d="M12 5v14M6 13l6 6 6-6" />
  </Svg>
);

export const LogoutIcon = (p: P) => (
  <Svg {...p} size={p.size ?? 17}>
    <path d="M15 17l5-5-5-5M20 12H9M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h6" />
  </Svg>
);

export const ChevronLeftIcon = (p: P) => (
  <Svg {...p} size={p.size ?? 20}>
    <path d="m15 5-7 7 7 7" />
  </Svg>
);

export const KeyIcon = (p: P) => (
  <Svg {...p} size={p.size ?? 16}>
    <circle cx="8" cy="15" r="4" />
    <path d="m11 12 8-8 2 2-2 2 2 2-2 2-2-2-2 2" />
  </Svg>
);

export const AlertIcon = (p: P) => (
  <Svg {...p} size={p.size ?? 15}>
    <path d="M12 4 2.5 20h19L12 4Z" />
    <path d="M12 10v4M12 17.5v.01" />
  </Svg>
);

export const CircleIcon = (p: P) => (
  <Svg {...p} size={p.size ?? 18}>
    <circle cx="12" cy="12" r="8.5" />
  </Svg>
);

export const CircleDotIcon = (p: P) => (
  <Svg {...p} size={p.size ?? 18}>
    <circle cx="12" cy="12" r="8.5" />
    <circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" />
  </Svg>
);

export const ClockIcon = (p: P) => (
  <Svg {...p} size={p.size ?? 15}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </Svg>
);

export const XIcon = (p: P) => (
  <Svg {...p} size={p.size ?? 18}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Svg>
);

export const SearchIcon = (p: P) => (
  <Svg {...p} size={p.size ?? 15}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 4 4" />
  </Svg>
);

export const SwapIcon = (p: P) => (
  <Svg {...p} size={p.size ?? 14}>
    <path d="M4 8h13l-3-3M20 16H7l3 3" />
  </Svg>
);

export const CoinsIcon = (p: P) => (
  <Svg {...p} size={p.size ?? 15}>
    <ellipse cx="12" cy="7" rx="7.5" ry="3.2" />
    <path d="M4.5 7v5c0 1.8 3.4 3.2 7.5 3.2s7.5-1.4 7.5-3.2V7" />
    <path d="M4.5 12v5c0 1.8 3.4 3.2 7.5 3.2s7.5-1.4 7.5-3.2v-5" />
  </Svg>
);

export const BellIcon = (p: P) => (
  <Svg {...p}>
    <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" />
    <path d="M10 20a2 2 0 0 0 4 0" />
  </Svg>
);

export const StarIcon = (p: P) => (
  <Svg {...p} fill="currentColor" stroke="none">
    <path d="M12 2.6l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.4l-5.8 3.1 1.1-6.5L2.6 9.4l6.5-.9z" />
  </Svg>
);
