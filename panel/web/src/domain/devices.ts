function browserName(userAgent: string): string {
  if (/MicroMessenger/i.test(userAgent)) return '微信内置浏览器';
  if (/Edg\//i.test(userAgent)) return 'Edge';
  if (/Firefox\//i.test(userAgent)) return 'Firefox';
  if (/CriOS\//i.test(userAgent) || /Chrome\//i.test(userAgent)) return 'Chrome';
  if (/Safari\//i.test(userAgent)) return 'Safari';
  return '未知浏览器';
}

function osName(userAgent: string): string {
  if (/Windows NT/i.test(userAgent)) return 'Windows';
  if (/Android/i.test(userAgent)) return 'Android';
  if (/iPhone/i.test(userAgent)) return 'iPhone';
  if (/iPad/i.test(userAgent)) return 'iPad';
  if (/Mac OS X/i.test(userAgent)) return 'macOS';
  if (/Linux/i.test(userAgent)) return 'Linux';
  return '未知系统';
}

export function deviceName(userAgent: string): string {
  return `${browserName(userAgent)} · ${osName(userAgent)}`;
}
