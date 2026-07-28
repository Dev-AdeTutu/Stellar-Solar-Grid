"use client";

import styles from './Skeleton.module.css';

export function Skeleton({ width = "100%", height = 20 }: { width?: string; height?: number }) {
  return (
    <div
      className={styles.skeleton}
      style={{ width, height }}
    />
  );
}
