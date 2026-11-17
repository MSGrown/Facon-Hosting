import React from 'react';

interface BrandMarkProps {
  className?: string;
}

export function BrandMark({ className = '' }: BrandMarkProps) {
  return (
    <span className={`inline-flex items-center gap-2.5 whitespace-nowrap shrink-0 ${className}`}>
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
        className="shrink-0"
      >
        <path
          d="M3 17L12 3L21 17L12 13.5L3 17Z"
          stroke="#00FFFF"
          strokeWidth="1.75"
          strokeLinejoin="round"
        />
        <path
          d="M12 3V13.5M7.5 15.25L12 21L16.5 15.25"
          stroke="#00FFFF"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span className="font-display text-lg font-bold tracking-tight text-white whitespace-nowrap shrink-0">
        FACON HOST
      </span>
    </span>
  );
}
