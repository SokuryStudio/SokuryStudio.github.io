// middleware.js — Vercel Routing Middleware
// 관리자 페이지(/manage)와 관리자 전용 데이터 요청을 지킵니다.
//
// 관리자로 인정되는 경우 (둘 중 하나):
//   1) 구글 로그인 세션의 이메일이 환경변수 ADMIN_EMAILS 목록에 있음
//   2) 비상용: ADMIN_USER / ADMIN_PASSWORD 아이디·비밀번호 (주소: /manage?pw=1)
// 비밀번호·서명 키·관리자 목록은 전부 Vercel 환경변수에만 있고, 이 파일엔 없습니다.

export const config = {
  matcher: ['/manage', '/manage.html', '/manage/:path*', '/api/data', '/og/:path*'],
};

const REALM = 'Manage Area';
const SESSION_COOKIE = 'sokury_session';
const enc = new TextEncoder();

// ---------- 이 요청에 관리자 권한이 필요한가 ----------
function needsAdmin(url, method) {
  const p = url.pathname;
  if (p === '/manage' || p === '/manage.html' || p.startsWith('/manage/')) return true;
  if (p.startsWith('/og/')) return method !== 'GET' && method !== 'HEAD';

  if (p === '/api/data') {
    const resource = url.searchParams.get('resource');
    const id = url.searchParams.get('id');
    const action = url.searchParams.get('action');
    if (['health', 'share', 'config', 'auth', 'myapplications'].includes(resource)) return false; // 공개(내 신청은 서버가 본인 확인)
    if (resource === 'ogimage') return method !== 'GET' && method !== 'HEAD';
    if (resource === 'schedules') {
      if (method === 'GET') return false;                              // 일정 조회
      if (method === 'POST' && id && action === 'like') return false;  // 좋아요
      return true;                                                     // 추가/수정/삭제
    }
    if (resource === 'applications') {
      if (method === 'POST' && !id) return false;                      // 신청서 제출
      return true;                                                     // 목록/처리/삭제
    }
    return true;
  }
  return false;
}

// ---------- 구글 로그인 세션 확인 (data.js와 같은 방식으로 서명 검증) ----------
function b64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function readSession(request) {
  const secret = process.env.SESSION_SECRET;
  const cookie = request.headers.get('cookie') || '';
  const m = cookie.match(new RegExp('(?:^|;\\s*)' + SESSION_COOKIE + '=([^;]+)'));
  if (!secret || !m) return null;
  const [body, sig] = m[1].split('.');
  if (!body || !sig) return null;
  try {
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('HMAC', key, b64urlToBytes(sig), enc.encode(body));
    if (!ok) return null;
    const p = JSON.parse(new TextDecoder().decode(b64urlToBytes(body)));
    return p.exp && p.exp > Date.now() ? p : null;
  } catch (e) { return null; }
}
function isAdminEmail(email) {
  const list = (process.env.ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  return !!email && list.includes(String(email).toLowerCase());
}

// ---------- 비상용 아이디/비밀번호 ----------
async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
async function basicAuthOk(request) {
  const user = process.env.ADMIN_USER, pass = process.env.ADMIN_PASSWORD;
  const header = request.headers.get('authorization') || '';
  if (!user || !pass || !header.startsWith('Basic ')) return false;
  let decoded;
  try { decoded = atob(header.slice(6).trim()); } catch (e) { return false; }
  const sep = decoded.indexOf(':');
  if (sep === -1) return false;
  const [a, b, c, d] = await Promise.all([
    sha256(decoded.slice(0, sep)), sha256(user), sha256(decoded.slice(sep + 1)), sha256(pass),
  ]);
  return (timingSafeEqual(a, b) & timingSafeEqual(c, d)) === 1;
}

// ---------- 응답들 ----------
function basicChallenge() {
  return new Response('인증이 필요합니다.', {
    status: 401,
    headers: { 'WWW-Authenticate': `Basic realm="${REALM}", charset="UTF-8"`, 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
function gatePage(session) {
  const who = session
    ? `<p class="sub"><b>${String(session.email).replace(/[<>&"]/g, '')}</b> 계정에는 관리자 권한이 없습니다.</p>`
    : `<p class="sub">관리자 권한이 있는 구글 계정으로 로그인해주세요.</p>`;
  const html = `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>관리자 로그인 | Sokury</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f5f6fa;
font-family:'Noto Sans KR','Apple SD Gothic Neo','Malgun Gothic',sans-serif;color:#1c1e26}
.box{background:#fff;border:1px solid #e3e5ec;border-radius:16px;padding:36px 32px;max-width:340px;width:90%;text-align:center;box-shadow:0 8px 24px rgba(20,20,40,.08)}
h1{font-size:20px;margin:0 0 10px;color:#6C5CFC}.sub{font-size:13px;color:#6b6f80;line-height:1.6;margin:0 0 22px}
a.btn{display:block;padding:12px;border-radius:10px;background:#6C5CFC;color:#fff;font-weight:700;text-decoration:none;font-size:14px}
a.alt{display:inline-block;margin-top:16px;font-size:12px;color:#9a9db0}
</style></head><body><div class="box">
<h1>🔒 관리자 페이지</h1>${who}
<a class="btn" href="/#/login?next=%2Fmanage">${session ? '다른 계정으로 로그인' : '구글로 로그인'}</a>
<a class="alt" href="/manage?pw=1">비밀번호로 로그인</a>
</div></body></html>`;
  return new Response(html, { status: 403, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

export default async function middleware(request) {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  if (!needsAdmin(url, method)) return;

  // 다른 사이트에서 몰래 보내는 수정 요청 차단
  if (method !== 'GET' && method !== 'HEAD') {
    const origin = request.headers.get('origin');
    if (origin && new URL(origin).host !== url.host) return jsonError(403, '허용되지 않은 요청입니다.');
  }

  const session = await readSession(request);
  if (session && isAdminEmail(session.email)) return; // 구글 관리자 → 통과
  if (await basicAuthOk(request)) return;             // 비상용 비밀번호 → 통과

  const isPage = url.pathname.startsWith('/manage');
  if (isPage) {
    if (url.searchParams.get('pw') === '1') {
      if (!process.env.ADMIN_USER || !process.env.ADMIN_PASSWORD) {
        return new Response('비밀번호 로그인이 설정되어 있지 않습니다.', { status: 500, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }
      return basicChallenge();
    }
    return gatePage(session);
  }
  return jsonError(401, '관리자 권한이 필요합니다. 다시 로그인해주세요.');
}
