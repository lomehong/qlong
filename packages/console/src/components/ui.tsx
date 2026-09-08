import { useEffect, useState } from 'react';
import { useStore } from '../store/useStore';

/** 居中加载态 */
export function Loading({ text = '加载中…' }: { text?: string }) {
  return <div className="loading"><span className="spinner" />{text}</div>;
}

/** 表格/区块空态 */
export function Empty({ icon = '🗂️', text }: { icon?: string; text: string }) {
  return <div className="empty"><div className="empty-icon">{icon}</div>{text}</div>;
}

/**
 * 全局错误 Toast:监听 store.error,自动 4.5s 消退,可手动关闭。
 * 替代散落的 alert() 与页面内联错误。
 */
export function ErrorToast() {
  const error = useStore((s) => s.error);
  const setError = useStore((s) => s.setError);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (!error) return;
    setLeaving(false);
    const t1 = setTimeout(() => setLeaving(true), 4300);
    const t2 = setTimeout(() => setError(null), 4500);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [error, setError]);

  if (!error) return null;
  return (
    <div className="toast-stack" role="alert" aria-live="assertive">
      <div className={`toast${leaving ? ' leaving' : ''}`}>
        <span aria-hidden>⚠️</span>
        <span style={{ flex: 1 }}>{error}</span>
        <button className="toast-close" aria-label="关闭" onClick={() => setError(null)}>✕</button>
      </div>
    </div>
  );
}
