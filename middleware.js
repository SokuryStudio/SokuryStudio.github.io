// middleware.js — Vercel Routing Middleware
// 관리자 페이지(/manage)와 관리자 전용 데이터 요청만 아이디/비밀번호로 막습니다.
// 비밀번호는 Vercel 환경변수 ADMIN_USER / ADMIN_PASSWORD 에만 있고, 이 파일엔 없습니다.

export const config = {
  matcher: ['/manage', '/manage.html', '/manage/:path*', '/api/data'],
};

const REALM = 'Manage Area';

function unauthorized() {
  return new Response('인증이 필요합니다.', {
    status: 401,
    headers: {
      'WWW-Authenticate': `Basic realm="${REALM}", charset="UTF-8"`,
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
}

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return new Uint8Array(digest);
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// 이 요청에 관리자 인증이 필요한지 판단
function needsAuth(url, method) {
  const p = url.pathname;
  if (p === '/manage' || p === '/manage.html' || p.startsWith('/manage/')) return true;

  if (p === '/api/data') {
    const resource = url.searchParams.get('resource');
    const id = url.searchParams.get('id');
    const action = url.searchParams.get('action');
    if (resource === 'health') return false;                       // 진단: 공개
    if (resource === 'schedules') {
      if (method === 'GET') return false;                          // 일정 조회: 공개
      if (method === 'POST' && id && action === 'like') return false; // 좋아요: 공개
      return true;                                                 // 추가/수정/삭제: 관리자
    }
    if (resource === 'applications') {
      if (method === 'POST' && !id) return false;                  // 신청서 제출: 공개
      return true;                                                 // 목록/처리/삭제: 관리자
    }
    return true; // 알 수 없는 요청은 안전하게 막음
  }
  return false;
}

export default async function middleware(request) {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  if (!needsAuth(url, method)) return;

  const user = process.env.ADMIN_USER;
  const pass = process.env.ADMIN_PASSWORD;
  if (!user || !pass) {
    // 비밀번호가 설정 안 됐으면 절대 열어주지 않음
    return new Response('서버 설정 오류: ADMIN_USER / ADMIN_PASSWORD 환경변수가 없습니다.', {
      status: 500,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  const header = request.headers.get('authorization') || '';
  if (!header.startsWith('Basic ')) return unauthorized();

  let decoded;
  try { decoded = atob(header.slice(6).trim()); } catch (e) { return unauthorized(); }
  const sep = decoded.indexOf(':');
  if (sep === -1) return unauthorized();

  const [a, b, c, d] = await Promise.all([
    sha256(decoded.slice(0, sep)), sha256(user),
    sha256(decoded.slice(sep + 1)), sha256(pass),
  ]);
  const ok = timingSafeEqual(a, b) & timingSafeEqual(c, d);
  if (!ok) return unauthorized(); // 아이디/비밀번호 중 뭐가 틀렸는지 알려주지 않음, 로그도 남기지 않음
}
