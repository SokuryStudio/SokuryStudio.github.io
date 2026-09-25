// middleware.js — Vercel Edge Middleware
//
// 아래 경로들만 HTTP Basic 인증으로 막습니다. 그 외(메인 사이트, 신청서 제출,
// 일정 조회, 좋아요)는 그대로 통과합니다. 비밀번호는 ADMIN_USER / ADMIN_PASSWORD
// 환경변수로만 읽고, 이 파일 어디에도 실제 값을 적지 않습니다.
//
// 인증이 필요한 것:
//   - /admin, /admin/*                         (관리자 페이지 자체)
//   - POST   /api/schedules                     (일정 생성)
//   - PUT/DELETE /api/schedules/:id              (일정 수정/삭제)
//   - GET    /api/applications                   (신청 목록 조회 — 개인정보 포함)
//   - PATCH/DELETE /api/applications/:id          (신청 처리/삭제)
// 인증이 필요 없는 것(공개):
//   - GET  /api/schedules                        (일정 조회)
//   - POST /api/schedules/:id/like                (좋아요)
//   - POST /api/applications                      (신청서 제출)

export const config = {
  matcher: [
    '/admin',
    '/admin/:path*',
    '/api/schedules',
    '/api/schedules/:path*',
    '/api/applications',
    '/api/applications/:path*',
  ],
};

const REALM = 'Admin Area';
// 아이디가 틀렸는지 비밀번호가 틀렸는지 구분하지 않는 단 하나의 메시지.
const GENERIC_MESSAGE = '인증이 필요합니다.';

function unauthorized() {
  return new Response(GENERIC_MESSAGE, {
    status: 401,
    headers: {
      'WWW-Authenticate': `Basic realm="${REALM}", charset="UTF-8"`,
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
}

// Edge Runtime에는 Node의 crypto.timingSafeEqual이 없어서, Web Crypto로
// 고정 길이(SHA-256, 32바이트) 해시를 만든 뒤 상수 시간으로 비교합니다.
async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return new Uint8Array(digest);
}

function timingSafeEqualBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

function base64Decode(base64) {
  // atob은 Edge Runtime에서 전역으로 사용 가능합니다.
  try {
    return atob(base64);
  } catch (e) {
    return null;
  }
}

// /api/schedules 계열 중 관리자 인증이 필요한 조합만 true.
// (schedules 자체는 POST만 관리자, :id는 PUT/DELETE만 관리자, :id/like는 항상 공개)
function scheduleNeedsAuth(segments, method) {
  if (segments.length === 2) return method === 'POST'; // /api/schedules
  if (segments.length === 3) return method === 'PUT' || method === 'DELETE'; // /api/schedules/:id
  if (segments.length === 4 && segments[3] === 'like') return false; // /api/schedules/:id/like
  return true; // 알 수 없는 하위 경로는 안전하게 막음
}
// /api/applications 계열: 목록 조회(GET)와 처리(PATCH/DELETE)만 관리자, 제출(POST)은 공개.
function applicationNeedsAuth(segments, method) {
  if (segments.length === 2) return method === 'GET'; // /api/applications
  if (segments.length === 3) return method === 'PATCH' || method === 'DELETE'; // /api/applications/:id
  return true;
}

function pathNeedsAuth(pathname, method) {
  if (pathname === '/admin' || pathname.startsWith('/admin/')) return true;
  const segments = pathname.split('/').filter(Boolean); // 예: ['api','schedules','abc','like']
  if (segments[0] !== 'api') return false;
  if (segments[1] === 'schedules') return scheduleNeedsAuth(segments, method);
  if (segments[1] === 'applications') return applicationNeedsAuth(segments, method);
  return false;
}

export default async function middleware(request) {
  const { pathname } = new URL(request.url);
  const method = request.method.toUpperCase();

  if (!pathNeedsAuth(pathname, method)) {
    return; // 인증 불필요 — 그대로 통과
  }

  const adminUser = process.env.ADMIN_USER;
  const adminPassword = process.env.ADMIN_PASSWORD;

  // 환경변수가 비어 있으면 "잠금 없이 조용히 통과"시키지 않고 무조건 막습니다.
  // (서버리스 환경엔 "시작 시점"이 따로 없으므로, 매 요청마다 확인해서
  //  절대 인증 없이 열리는 일이 없게 합니다.)
  if (!adminUser || !adminPassword) {
    return new Response(
      '서버 설정 오류: ADMIN_USER / ADMIN_PASSWORD 환경변수가 설정되지 않았습니다.',
      { status: 500, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
    );
  }

  const authHeader = request.headers.get('authorization') || '';
  if (!authHeader.startsWith('Basic ')) {
    return unauthorized();
  }

  const decoded = base64Decode(authHeader.slice('Basic '.length).trim());
  if (decoded === null) return unauthorized();

  const sepIndex = decoded.indexOf(':');
  if (sepIndex === -1) return unauthorized();

  const inputUser = decoded.slice(0, sepIndex);
  const inputPassword = decoded.slice(sepIndex + 1);

  const [userHash, expectedUserHash, passHash, expectedPassHash] = await Promise.all([
    sha256(inputUser),
    sha256(adminUser),
    sha256(inputPassword),
    sha256(adminPassword),
  ]);

  // 둘 다 항상 계산한 뒤 합쳐서 판단 — "아이디가 틀리면 더 빨리 끝난다" 같은
  // 타이밍 차이를 만들지 않습니다.
  const userOk = timingSafeEqualBytes(userHash, expectedUserHash);
  const passOk = timingSafeEqualBytes(passHash, expectedPassHash);

  if (!(userOk && passOk)) {
    // 여기서 authHeader, inputUser, inputPassword를 로그로 남기지 마세요.
    return unauthorized();
  }

  // 통과 — 이후 정적 파일(/admin/index.html) 또는 API 함수가 그대로 실행됩니다.
}
