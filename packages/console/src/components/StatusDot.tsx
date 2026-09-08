export function StatusDot({ online, status }: { online: boolean; status: string }) {
  const suspended = status === 'suspended';
  const color = suspended ? 'var(--warning)' : online ? 'var(--success)' : 'var(--border-strong)';
  const label = suspended ? '已暂停' : online ? '在线' : '离线';
  return (
    <span className="status-dot">
      <span className={`dot${online && !suspended ? ' online' : ''}`} style={{ background: color }} />
      {label}
    </span>
  );
}
