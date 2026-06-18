import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useLocation } from 'react-router-dom';
import { api, type LoginWallpaper } from '../api';
import { useUI } from '../ui';
import { errorMessage } from '../utils/errors';

export default function Login() {
  const loc = useLocation();
  const { toast } = useUI();
  const err = useMemo(() => new URLSearchParams(loc.search).get('error') || '', [loc.search]);
  const [wallpaper, setWallpaper] = useState<LoginWallpaper | null>(null);

  useEffect(() => {
    let disposed = false;
    api.loginWallpaper()
      .then((value) => {
        if (!disposed) setWallpaper(value);
      })
      .catch((error) => {
        if (disposed) return;
        setWallpaper(null);
        toast(errorMessage(error, '登录壁纸加载失败'), 'error');
      });
    return () => {
      disposed = true;
    };
  }, [toast]);

  const login = () => {
    window.location.assign(api.loginUrl('/'));
  };

  return (
    <div
      className={'center-screen login-screen' + (wallpaper ? ' has-wallpaper' : '')}
      style={wallpaper ? { '--login-wallpaper': `url("${wallpaper.imageUrl}")` } as CSSProperties : undefined}
    >
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
        <div className="login-foot" title={wallpaper?.copyright || undefined}>
          服务端应用 · 多端共享
        </div>
      </div>
    </div>
  );
}
