// 协议缺省参数(编译期常量,与 packages/core DEFAULT_PARAMS 一致;中心运行值暂无查询 API)
const PARAMS: Array<[string, string]> = [
  ['offer TTL(project)', '300s'],
  ['lease(project)', '400s'],
  ['max_attempts', '3'],
  ['max_dispatch_rounds', '3'],
  ['exp 漂移预算', '10 分钟'],
  ['max_hops', '8'],
];
export default function Settings({ username }: { username: string }) {
  return (
    <div>
      <div className="page-head">
        <h1 className="page-title">系统设置</h1>
        <p className="page-sub">中心与账号信息(只读)</p>
      </div>
      <div className="card">
        <h2 className="card-title">当前账号</h2>
        <dl className="dl dl-wide">
          <dt>登录用户</dt><dd className="mono">{username || '—'}</dd>
          <dt>中心地址</dt><dd className="mono">{location.origin}</dd>
        </dl>
      </div>
      <div className="card">
        <h2 className="card-title">全局参数</h2>
        <dl className="dl dl-wide">
          {PARAMS.map(([k, v]) => <div key={k} style={{ display: 'contents' }}><dt>{k}</dt><dd className="mono">{v}</dd></div>)}
        </dl>
      </div>
    </div>
  );
}
