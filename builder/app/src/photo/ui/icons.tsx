// Icons used only by the Photo to Bricks flow (same 24px stroke style as app/src/ui/Icons.tsx).
import type { ReactNode, SVGProps } from 'react';

type P = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 20, children, ...rest }: P & { children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      {children}
    </svg>
  );
}

export const IconPhoto = (p: P) => (
  <Svg {...p}>
    <path d="M4 8a2 2 0 0 1 2-2h1.6l1.4-2h6l1.4 2H18a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
    <circle cx="12" cy="13" r="3.6" />
  </Svg>
);
export const IconGallery = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2.5" />
    <circle cx="9" cy="10" r="1.8" />
    <path d="m21 16-5-5-9 9" />
  </Svg>
);
export const IconBack = (p: P) => <Svg {...p}><path d="m15 18-6-6 6-6" /></Svg>;
export const IconRuler = (p: P) => (
  <Svg {...p}>
    <path d="m3 17 14-14 4 4L7 21z" />
    <path d="m7 13 2 2M10 10l2 2M13 7l2 2" />
  </Svg>
);
export const IconSparkle = (p: P) => (
  <Svg {...p}>
    <path d="M12 3v3M12 18v3M3 12h3M18 12h3" />
    <path d="M12 7.5 13.4 10.6 16.5 12 13.4 13.4 12 16.5 10.6 13.4 7.5 12 10.6 10.6z" />
  </Svg>
);
export const IconUpload = (p: P) => (
  <Svg {...p}>
    <path d="M7 18a4.5 4.5 0 0 1-.6-9A6 6 0 0 1 18 8a4 4 0 0 1 0 8" />
    <path d="M12 12v9M9 15l3-3 3 3" />
  </Svg>
);
export const IconCube = (p: P) => (
  <Svg {...p}>
    <path d="M12 2 3 7v10l9 5 9-5V7z" />
    <path d="m3 7 9 5 9-5M12 12v10" />
  </Svg>
);
export const IconGrid = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M9 3v18M15 3v18M3 9h18M3 15h18" />
  </Svg>
);
export const IconGhost = (p: P) => (
  <Svg {...p}>
    <path d="M5 20V10a7 7 0 0 1 14 0v10l-2.3-1.6L14.3 20 12 18.4 9.7 20l-2.4-1.6z" />
    <circle cx="9.5" cy="10.5" r="1" /><circle cx="14.5" cy="10.5" r="1" />
  </Svg>
);
export const IconAlert = (p: P) => (
  <Svg {...p}>
    <path d="M12 3 2 20h20z" />
    <path d="M12 10v4M12 17.5v.01" />
  </Svg>
);
export const IconLock = (p: P) => (
  <Svg {...p}>
    <rect x="4" y="11" width="16" height="10" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </Svg>
);
export const IconTurn = (p: P) => <Svg {...p}><path d="M3 12a9 9 0 0 1 15.4-6.4L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-15.4 6.4L3 16" /><path d="M3 21v-5h5" /></Svg>;

/** Small isometric 2×2 brick (filled illustration, LEGO red) for the reference-brick hints. */
export const Brick2x2Art = ({ size = 32, ...rest }: P) => {
  // Isometric 2x2: top rhombus, left + right faces, four studs.
  const studs: Array<[number, number]> = [[24, 11], [33, 15.5], [15, 15.5], [24, 20]];
  return (
    <svg width={size} height={(size * 40) / 48} viewBox="0 0 48 40" aria-hidden="true" {...rest}>
      <path d="M6 15 24 24v14L6 29z" fill="#8F0F0A" />
      <path d="M42 15 24 24v14l18-9z" fill="#B8231A" />
      <path d="M24 6 42 15 24 24 6 15z" fill="#E3392B" />
      {studs.map(([x, y]) => (
        <g key={`${x},${y}`}>
          <path d={`M${x - 4.5} ${y - 2.6}v2.6a4.5 2.3 0 0 0 9 0v-2.6z`} fill="#B8231A" />
          <ellipse cx={x} cy={y - 2.6} rx="4.5" ry="2.3" fill="#F2574A" />
        </g>
      ))}
    </svg>
  );
};
