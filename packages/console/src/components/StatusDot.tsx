export function StatusDot({ online, status }: { online: boolean; status: string }) {
  const color = status === 'suspended' ? '#f5a623' : online ? '#16c784' : '#cbd5e0';
  const label = status === 'suspended' ? 'suspended' : online ? '在线' : '离线';
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 9, height: 9, borderRadius: '50%', background: color }} />{label}</span>;
}