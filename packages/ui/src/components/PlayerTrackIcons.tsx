interface PlayerTrackIconProps {
  size?: number;
}

/** A video camera distinguishes the video representation/track picker. */
export function VideoTrackIcon({ size = 18 }: PlayerTrackIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="6" width="13" height="12" rx="2" />
      <path d="m16 10 5-3v10l-5-3" />
    </svg>
  );
}

/** Uneven level bars read as an audio track without looking like volume. */
export function AudioTrackIcon({ size = 18 }: PlayerTrackIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M4 9v6" />
      <path d="M8 5v14" />
      <path d="M12 8v8" />
      <path d="M16 3v18" />
      <path d="M20 7v10" />
    </svg>
  );
}

export function SubtitleTrackIcon({ size = 18 }: PlayerTrackIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="M6 10h6M15 10h3M6 14h9" />
    </svg>
  );
}
