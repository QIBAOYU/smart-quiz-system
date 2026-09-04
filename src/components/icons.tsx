/** 线性图标：模板禁用 @expo/vector-icons，统一用 react-native-svg 手绘 */
import React from 'react';
import Svg, { Path, Circle, Rect } from 'react-native-svg';

interface IconProps {
  size?: number;
  color?: string;
  focused?: boolean;
}

const base = (size: number) => ({ width: size, height: size, viewBox: '0 0 24 24' });

export function HomeIcon({ size = 22, color = '#6b7280' }: IconProps) {
  return (
    <Svg {...base(size)}>
      <Path
        d="M3.5 10.5 12 3.8l8.5 6.7v8.2a1.6 1.6 0 0 1-1.6 1.6h-4.2v-6h-5.4v6H4.9a1.4 1.4 0 0 1-1.4-1.4z"
        fill="none"
        stroke={color}
        strokeWidth={1.8}
        strokeLinejoin="round"
      />
    </Svg>
  );
}

export function ChartIcon({ size = 22, color = '#6b7280' }: IconProps) {
  return (
    <Svg {...base(size)}>
      <Path d="M4 20h16" stroke={color} strokeWidth={1.8} strokeLinecap="round" />
      <Rect x={5.5} y={11} width={3.4} height={6.4} rx={1.2} fill={color} opacity={0.85} />
      <Rect x={10.3} y={6.5} width={3.4} height={10.9} rx={1.2} fill={color} />
      <Rect x={15.1} y={9} width={3.4} height={8.4} rx={1.2} fill={color} opacity={0.6} />
    </Svg>
  );
}

export function GearIcon({ size = 22, color = '#6b7280' }: IconProps) {
  return (
    <Svg {...base(size)}>
      <Circle cx={12} cy={12} r={3.1} fill="none" stroke={color} strokeWidth={1.8} />
      <Path
        d="M12 2.8v2.6M12 18.6v2.6M4.4 7.6l2.2 1.3M17.4 15.1l2.2 1.3M4.4 16.4l2.2-1.3M17.4 8.9l2.2-1.3"
        stroke={color}
        strokeWidth={1.8}
        strokeLinecap="round"
      />
    </Svg>
  );
}

export function UploadIcon({ size = 22, color = '#ffffff' }: IconProps) {
  return (
    <Svg {...base(size)}>
      <Path d="M12 16.5V4.8M7.6 9.2 12 4.8l4.4 4.4" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <Path d="M4.5 15v3.2a1.6 1.6 0 0 0 1.6 1.6h11.8a1.6 1.6 0 0 0 1.6-1.6V15" stroke={color} strokeWidth={2} strokeLinecap="round" fill="none" />
    </Svg>
  );
}

export function DocIcon({ size = 22, color = '#6366f1' }: IconProps) {
  return (
    <Svg {...base(size)}>
      <Path d="M6 3.5h7.5L18.5 8v12.5H6z" fill="none" stroke={color} strokeWidth={1.7} strokeLinejoin="round" />
      <Path d="M13.2 3.6V8.2h4.9" fill="none" stroke={color} strokeWidth={1.7} strokeLinejoin="round" />
      <Path d="M8.8 12.5h6.4M8.8 15.6h6.4M8.8 18h4" stroke={color} strokeWidth={1.5} strokeLinecap="round" />
    </Svg>
  );
}

export function SparkIcon({ size = 16, color = '#8b5cf6' }: IconProps) {
  return (
    <Svg {...base(size)}>
      <Path d="M12 3.2 13.7 9l5.8 1.7-5.8 1.7L12 18.2l-1.7-5.8-5.8-1.7L10.3 9z" fill={color} />
      <Path d="M18.4 3.4 19 5.3l1.9.6-1.9.6-.6 1.9-.6-1.9-1.9-.6 1.9-.6z" fill={color} opacity={0.7} />
    </Svg>
  );
}

export function CloseIcon({ size = 18, color = '#6b7280' }: IconProps) {
  return (
    <Svg {...base(size)}>
      <Path d="M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5" stroke={color} strokeWidth={2} strokeLinecap="round" />
    </Svg>
  );
}

export function ChevronIcon({ size = 18, color = '#9ca3af', dir = 'right' }: IconProps & { dir?: 'right' | 'left' | 'down' }) {
  const d =
    dir === 'left'
      ? 'M14.5 5.5 8 12l6.5 6.5'
      : dir === 'down'
        ? 'M5.5 9.5 12 16l6.5-6.5'
        : 'M9.5 5.5 16 12l-6.5 6.5';
  return (
    <Svg {...base(size)}>
      <Path d={d} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

export function CheckIcon({ size = 18, color = '#10b981' }: IconProps) {
  return (
    <Svg {...base(size)}>
      <Path d="m5 12.6 4.6 4.6L19 7.4" fill="none" stroke={color} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

export function TrashIcon({ size = 18, color = '#ef4444' }: IconProps) {
  return (
    <Svg {...base(size)}>
      <Path d="M4.8 6.6h14.4M9.4 6.6V4.4h5.2v2.2M6.6 6.6l1 12.6a1.4 1.4 0 0 0 1.4 1.3h6a1.4 1.4 0 0 0 1.4-1.3l1-12.6" fill="none" stroke={color} strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

export function ShareIcon({ size = 16, color = '#6366f1' }: IconProps) {
  return (
    <Svg {...base(size)}>
      <Path
        d="M12 3.2v11.4M12 3.2 8.2 7M12 3.2 15.8 7"
        fill="none"
        stroke={color}
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M4.6 12.4v5.4a2 2 0 0 0 2 2h10.8a2 2 0 0 0 2-2v-5.4"
        fill="none"
        stroke={color}
        strokeWidth={1.8}
        strokeLinecap="round"
      />
    </Svg>
  );
}

export function BookIcon({ size = 20, color = '#6366f1' }: IconProps) {
  return (
    <Svg {...base(size)}>
      <Path d="M4 5.2A1.7 1.7 0 0 1 5.7 3.5H11v17H5.7A1.7 1.7 0 0 1 4 18.8z" fill="none" stroke={color} strokeWidth={1.7} strokeLinejoin="round" />
      <Path d="M20 5.2a1.7 1.7 0 0 0-1.7-1.7H13v17h5.3A1.7 1.7 0 0 0 20 18.8z" fill="none" stroke={color} strokeWidth={1.7} strokeLinejoin="round" />
    </Svg>
  );
}
