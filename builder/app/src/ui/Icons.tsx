import type { ReactNode, SVGProps } from 'react';

type P = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 20, children, ...rest }: P & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconUndo = (p: P) => <Svg {...p}><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></Svg>;
export const IconRedo = (p: P) => <Svg {...p}><path d="m15 14 5-5-5-5" /><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" /></Svg>;
export const IconPlace = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="10" width="18" height="10" rx="2" />
    <path d="M7 10V8h3v2M14 10V8h3v2" />
    <path d="M12 2v4M10 4h4" />
  </Svg>
);
export const IconSelect = (p: P) => <Svg {...p}><path d="m4 4 7 17 2.5-7.5L21 11z" /></Svg>;
export const IconPaint = (p: P) => (
  <Svg {...p}>
    <path d="M19 11 11 3 3.5 10.5a2 2 0 0 0 0 2.8l5.2 5.2a2 2 0 0 0 2.8 0z" />
    <path d="M5 2l3 3M3 12h15" />
    <path d="M20 14s2 2.5 2 4a2 2 0 0 1-4 0c0-1.5 2-4 2-4z" />
  </Svg>
);
export const IconErase = (p: P) => (
  <Svg {...p}>
    <path d="m7 21-4.3-4.3a1 1 0 0 1 0-1.4l10-10a1 1 0 0 1 1.4 0l5.6 5.6a1 1 0 0 1 0 1.4L13 19" />
    <path d="M22 21H7M5 11l9 9" />
  </Svg>
);
export const IconRotate = (p: P) => <Svg {...p}><path d="M21 12a9 9 0 1 1-3-6.7L21 8" /><path d="M21 3v5h-5" /></Svg>;
export const IconFit = (p: P) => (
  <Svg {...p}>
    <path d="M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3" />
    <rect x="8" y="8" width="8" height="8" rx="1" />
  </Svg>
);
export const IconCamera = (p: P) => (
  <Svg {...p}>
    <path d="M12 2 3 7v10l9 5 9-5V7z" />
    <path d="m3 7 9 5 9-5M12 12v10" />
  </Svg>
);
export const IconShare = (p: P) => (
  <Svg {...p}>
    <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" />
    <path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4" />
  </Svg>
);
export const IconImport = (p: P) => <Svg {...p}><path d="M12 3v12M7 10l5 5 5-5" /><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /></Svg>;
export const IconExport = (p: P) => <Svg {...p}><path d="M12 15V3M7 8l5-5 5 5" /><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /></Svg>;
export const IconNew = (p: P) => <Svg {...p}><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 3v6h6M12 12v6M9 15h6" /></Svg>;
export const IconMore = (p: P) => <Svg {...p}><circle cx="5" cy="12" r="1.2" /><circle cx="12" cy="12" r="1.2" /><circle cx="19" cy="12" r="1.2" /></Svg>;
export const IconMenu = (p: P) => <Svg {...p}><path d="M4 6h16M4 12h16M4 18h16" /></Svg>;
export const IconClose = (p: P) => <Svg {...p}><path d="M18 6 6 18M6 6l12 12" /></Svg>;
export const IconSearch = (p: P) => <Svg {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></Svg>;
export const IconCopy = (p: P) => <Svg {...p}><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" /></Svg>;
export const IconCheck = (p: P) => <Svg {...p}><path d="M20 6 9 17l-5-5" /></Svg>;
export const IconUp = (p: P) => <Svg {...p}><path d="m18 15-6-6-6 6" /></Svg>;
export const IconDown = (p: P) => <Svg {...p}><path d="m6 9 6 6 6-6" /></Svg>;
export const IconUpDouble = (p: P) => <Svg {...p}><path d="m17 11-5-5-5 5M17 18l-5-5-5 5" /></Svg>;
export const IconDownDouble = (p: P) => <Svg {...p}><path d="m7 13 5 5 5-5M7 6l5 5 5-5" /></Svg>;
export const IconLayers = (p: P) => <Svg {...p}><path d="m12 2 10 5-10 5L2 7z" /><path d="m2 17 10 5 10-5M2 12l10 5 10-5" /></Svg>;
export const IconBricks = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="13" width="18" height="8" rx="1.5" />
    <rect x="3" y="5" width="9" height="8" rx="1.5" />
    <path d="M6 5V3.5M9 5V3.5M7 13v-1.5M11 13v-1.5M15 13v-1.5M18 13v-1.5" />
  </Svg>
);
export const IconPalette = (p: P) => (
  <Svg {...p}>
    <path d="M12 22a10 10 0 1 1 10-10c0 2.8-2.2 4-4 4h-2a2 2 0 0 0-1.5 3.3A1.6 1.6 0 0 1 12 22z" />
    <circle cx="7.5" cy="11" r="1.2" /><circle cx="10.5" cy="7" r="1.2" /><circle cx="15.5" cy="7.5" r="1.2" />
  </Svg>
);
export const IconChevron = (p: P) => <Svg {...p}><path d="m6 9 6 6 6-6" /></Svg>;
export const IconWhatsApp = (p: P) => (
  <svg width={p.size ?? 20} height={p.size ?? 20} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8s-.4-.1-.6.1-.7.8-.8 1-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.3-.4.2-.4.7-1.4.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.7 11.8 11.8 0 0 0 4.5 4c1.7.7 2.3.8 3.2.6a2.7 2.7 0 0 0 1.8-1.2 2.2 2.2 0 0 0 .1-1.3c0-.1-.2-.2-.4-.3z" />
  </svg>
);

/** The Brickyard logo: a friendly red 2x2 brick, isometric. */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <path d="M32 22 6 34v14l26 12 26-12V34z" fill="#B3261E" />
      <path d="M32 22 6 34l26 12 26-12z" fill="#E5483A" />
      <path d="M6 34v14l26 12V46z" fill="#C7352A" />
      <g fill="#F26B5B" stroke="#B3261E" strokeWidth="1.2">
        <ellipse cx="32" cy="26" rx="5" ry="2.6" />
        <ellipse cx="19" cy="32" rx="5" ry="2.6" />
        <ellipse cx="45" cy="32" rx="5" ry="2.6" />
        <ellipse cx="32" cy="38" rx="5" ry="2.6" />
      </g>
      <g fill="#F7897B">
        <path d="M27 26v-4h10v4" /><path d="M14 32v-4h10v4" /><path d="M40 32v-4h10v4" /><path d="M27 38v-4h10v4" />
      </g>
      <g fill="#FF9C8F">
        <ellipse cx="32" cy="22" rx="5" ry="2.6" />
        <ellipse cx="19" cy="28" rx="5" ry="2.6" />
        <ellipse cx="45" cy="28" rx="5" ry="2.6" />
        <ellipse cx="32" cy="34" rx="5" ry="2.6" />
      </g>
    </svg>
  );
}

// ---- mobile redesign icons ----
export const IconDuplicate = (p: P) => (
  <Svg {...p}>
    <rect x="8" y="8" width="13" height="13" rx="2" />
    <path d="M4 16V5a1 1 0 0 1 1-1h11M14.5 11.5v6M11.5 14.5h6" />
  </Svg>
);
export const IconTrash = (p: P) => (
  <Svg {...p}>
    <path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
  </Svg>
);
export const IconAddMore = (p: P) => (
  <Svg {...p}>
    <path d="m3 3 6 15 2-6.5L17.5 9z" />
    <path d="M18 14v7M14.5 17.5h7" />
  </Svg>
);
export const IconLeft = (p: P) => <Svg {...p}><path d="m15 18-6-6 6-6" /></Svg>;
export const IconRight = (p: P) => <Svg {...p}><path d="m9 18 6-6-6-6" /></Svg>;
export const IconArrowUp = (p: P) => <Svg {...p}><path d="M12 19V5M6 11l6-6 6 6" /></Svg>;
export const IconArrowDown = (p: P) => <Svg {...p}><path d="M12 5v14M6 13l6 6 6-6" /></Svg>;
export const IconArrowLeft = (p: P) => <Svg {...p}><path d="M19 12H5M11 6l-6 6 6 6" /></Svg>;
export const IconArrowRight = (p: P) => <Svg {...p}><path d="M5 12h14M13 6l6 6-6 6" /></Svg>;
export const IconLift = (p: P) => (
  <Svg {...p}>
    <path d="M12 3v9M8 7l4-4 4 4" />
    <rect x="5" y="15" width="14" height="6" rx="1.5" />
  </Svg>
);
export const IconLower = (p: P) => (
  <Svg {...p}>
    <path d="M12 3v9M8 8l4 4 4-4" />
    <rect x="5" y="15" width="14" height="6" rx="1.5" />
  </Svg>
);
export const IconEyedropper = (p: P) => (
  <Svg {...p}>
    <path d="m14 7 3 3M5 19l1-4 8.5-8.5a2.1 2.1 0 0 1 3 3L9 18z" />
    <path d="m16 5 1.5-1.5a2.1 2.1 0 0 1 3 3L19 8" />
  </Svg>
);
export const IconStar = ({ filled, ...p }: P & { filled?: boolean }) => (
  <Svg {...p} fill={filled ? 'currentColor' : 'none'}>
    <path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z" />
  </Svg>
);
export const IconHand = (p: P) => (
  <Svg {...p}>
    <path d="M9 11V5a1.5 1.5 0 0 1 3 0v5M12 10V4a1.5 1.5 0 0 1 3 0v6M15 10V6a1.5 1.5 0 0 1 3 0v8a7 7 0 0 1-7 7h-.5a6 6 0 0 1-5-2.7L3 14.5a1.6 1.6 0 0 1 2.5-2L9 15.5V11" />
  </Svg>
);
export const IconKeyboard = (p: P) => (
  <Svg {...p}>
    <rect x="2" y="6" width="20" height="12" rx="2" />
    <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" />
  </Svg>
);
export const IconVibrate = (p: P) => (
  <Svg {...p}>
    <rect x="8" y="4" width="8" height="16" rx="2" />
    <path d="M4 8v8M2 10v4M20 8v8M22 10v4" />
  </Svg>
);
export const IconPencil = (p: P) => <Svg {...p}><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z" /><path d="m13.5 6.5 4 4" /></Svg>;
export const IconFocus = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3" />
  </Svg>
);
export const IconGrid = (p: P) => <Svg {...p}><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></Svg>;
export const IconBack = (p: P) => <Svg {...p}><path d="M19 12H5M11 18l-6-6 6-6" /></Svg>;
