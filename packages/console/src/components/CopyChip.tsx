import { useState } from 'react';

/**
 * 截断 ID 展示 + 点击复制 + 悬停提示。
 * 解决原来 ID 截断后无法查看/复制全文的问题。
 */
export function CopyChip({ value, head = 8 }: { value: string; head?: number }) {
  const [copied, setCopied] = useState(false);
  const short = value.length > head + 3 ? `${value.slice(0, head)}…` : value;

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch { /* 剪贴板不可用时静默 */ }
  };

  return (
    <button
      type="button"
      className="copy-chip"
      title={copied ? '已复制' : `${value}\n点击复制`}
      onClick={(e) => { e.stopPropagation(); void copy(); }}
    >
      {copied ? '✓ 已复制' : short}
    </button>
  );
}
