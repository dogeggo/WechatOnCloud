import { useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { api } from '../api';

export default function Login() {
  const loc = useLocation();
  const err = useMemo(() => new URLSearchParams(loc.search).get('error') || '', [loc.search]);

  const login = () => {
    window.location.assign(api.loginUrl('/'));
  };

  return (
    <div className="center-screen login-screen">
      <div className="login-wrap">
        <div className="card login-card">
          <div className="brand">
            <div className="brand-logo">
              <img src="/favicon.svg" alt="" />
            </div>
            <h1>云应用</h1>
            <p className="muted">使用 Google / OIDC 登录以访问应用面板</p>
          </div>
          {err && <div className="error">{err}</div>}
          <button className="btn btn-primary" onClick={login}>
            使用 Google / OIDC 登录
          </button>
        </div>
        <div className="login-foot">服务端应用 · 多端共享</div>
      </div>
    </div>
  );
}
