import React, { useId, useState } from 'react';

export interface TelemetryPoint {
  label: string;
  value: number;
}

interface TelemetryChartProps {
  title: string;
  currentValue: string;
  limitLabel: string;
  unit: string;
  max: number;
  data: TelemetryPoint[];
  accentColor?: string;
}

export function TelemetryChart({
  title,
  currentValue,
  limitLabel,
  unit,
  max,
  data,
  accentColor = '#00FFFF',
}: TelemetryChartProps) {
  const gradId = useId().replace(/:/g, '');
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const width = 420;
  const height = 140;
  const padX = 8;
  const padTop = 12;
  const padBottom = 10;
  const usableW = width - padX * 2;
  const usableH = height - padTop - padBottom;

  const safeData = data.length >= 2 ? data : [{ label: '00:00', value: 0 }, { label: 'Now', value: 0 }];

  const points = safeData.map((pt, idx) => {
    const x = padX + (idx / Math.max(1, safeData.length - 1)) * usableW;
    const ratio = Math.max(0, Math.min(1, pt.value / Math.max(1, max)));
    const y = padTop + usableH - ratio * usableH;
    return { x, y, ...pt };
  });

  const linePath = points
    .map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(' ');

  const areaPath = `${linePath} L ${points[points.length - 1].x.toFixed(1)} ${(padTop + usableH).toFixed(1)} L ${points[0].x.toFixed(1)} ${(padTop + usableH).toFixed(1)} Z`;

  const activePoint = hoverIdx !== null && points[hoverIdx] ? points[hoverIdx] : null;

  return (
    <div className="facon-glass rounded-xl p-5 flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs font-medium text-zinc-400 truncate">{title}</p>
          <p className="font-mono text-2xl font-semibold text-white tabular-nums mt-0.5">
            {activePoint ? `${activePoint.value}${unit}` : currentValue}
          </p>
        </div>
        <div className="text-right shrink-0">
          <p className="text-xs text-zinc-500">Quota</p>
          <p className="font-mono text-xs text-zinc-300 tabular-nums">{limitLabel}</p>
        </div>
      </div>

      <div className="relative w-full h-[140px]">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="w-full h-full overflow-visible"
          preserveAspectRatio="none"
          onMouseLeave={() => setHoverIdx(null)}
        >
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={accentColor} stopOpacity="0.28" />
              <stop offset="100%" stopColor={accentColor} stopOpacity="0.01" />
            </linearGradient>
          </defs>

          {[0.25, 0.5, 0.75].map((pct) => {
            const y = padTop + usableH * pct;
            return (
              <line
                key={pct}
                x1={padX}
                y1={y}
                x2={width - padX}
                y2={y}
                stroke="rgba(255,255,255,0.06)"
                strokeDasharray="3 4"
              />
            );
          })}

          <path d={areaPath} fill={`url(#${gradId})`} />
          <path
            d={linePath}
            fill="none"
            stroke={accentColor}
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
          />

          {activePoint && (
            <g>
              <line
                x1={activePoint.x}
                y1={padTop}
                x2={activePoint.x}
                y2={padTop + usableH}
                stroke="rgba(255,255,255,0.22)"
                strokeDasharray="2 3"
              />
              <circle
                cx={activePoint.x}
                cy={activePoint.y}
                r="4"
                fill="#000000"
                stroke={accentColor}
                strokeWidth="2"
              />
            </g>
          )}

          {points.map((pt, idx) => {
            const sliceW = usableW / points.length;
            return (
              <rect
                key={`${pt.label}-${idx}`}
                x={pt.x - sliceW / 2}
                y={0}
                width={sliceW}
                height={height}
                fill="transparent"
                className="cursor-crosshair"
                onMouseEnter={() => setHoverIdx(idx)}
              />
            );
          })}
        </svg>
      </div>

      <div className="flex items-center justify-between text-[11px] font-mono text-zinc-500 tabular-nums">
        <span>{safeData[0]?.label}</span>
        <span>{activePoint ? `Sample ${activePoint.label}` : 'Live 5s interval'}</span>
        <span>{safeData[safeData.length - 1]?.label}</span>
      </div>
    </div>
  );
}
