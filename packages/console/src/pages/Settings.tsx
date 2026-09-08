const PARAMS: Array<[string, string]> = [
  ['offer TTL(project)', '300s'],
  ['lease(project)', '400s'],
  ['max_attempts', '3'],
  ['max_dispatch_rounds', '3'],
  ['exp 漂移预算', '10 分钟'],
  ['max_hops', '8'],
];
export default function Settings() {
  return (
    <div>
      <div className="page-head">
        <h1 className="page-title">系统设置</h1>
        <p className="page-sub">全局运行参数(只读)</p>
      </div>
      <div className="card">
        <h2 className="card-title">全局参数</h2>
        <dl className="dl dl-wide">
          {PARAMS.map(([k, v]) => <div key={k} style={{ display: 'contents' }}><dt>{k}</dt><dd className="mono">{v}</dd></div>)}
        </dl>
      </div>
      <div className="card">
        <h2 className="card-title">Owner</h2>
        <dl className="dl dl-wide">
          <dt>owner_user_id</dt><dd className="mono">u1</dd>
          <dt>邮箱</dt><dd>owner@qlong.io</dd>
        </dl>
      </div>
    </div>
  );
}
