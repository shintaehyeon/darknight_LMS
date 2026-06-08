/**
 * 다크나이트 - 백그라운드 서비스 워커 (background.js)
 * 
 * 주요 기능:
 * 1. 활성 탭의 네트워크 요청을 실시간 감시하여 M3U8, MP4, MPD 등 비디오 스트리밍 주소 감지 및 수집.
 * 2. 탭 ID별 감지 상태 관리 (기본 주소가 완전히 바뀌면 컨텐트 스크립트에 리셋 명령을 보내 자동 재탐색 유도).
 * 3. 팝업이 켜져 있을 경우 실시간 리스트 갱신 신호 송출.
 */

// 탭별로 감지된 미디어 정보를 저장하는 객체
const detectedMedia = {};

// 탭별로 마지막으로 기록된 기본 주소(Base URL)
const lastBaseUrls = {};

// 현재 진행 중인 백그라운드 다운로드 세션 상태 객체
let activeDownloadSession = null;

// 현재 다운로드 세션용으로 임시 추가된 DNR 규칙 ID 목록 (다운로드 전체 생명주기 동안 유지!)
let downloadSessionRuleIds = [];
let dynamicRuleIdCounter = 3001;
// 이미 규칙이 등록된 호스트명 캐시 (중복 등록 방지)
let registeredHostnames = new Set();

/**
 * 특정 호스트명에 매칭되는 모든 쿠키 수집
 */
async function getCookiesForDomain(hostname) {
  try {
    const allCookies = await chrome.cookies.getAll({});
    const matchedCookies = allCookies.filter(cookie => {
      const domain = cookie.domain;
      if (hostname === domain) return true;
      if (domain.startsWith('.')) {
        const parentDomain = domain.slice(1);
        if (hostname.endsWith('.' + parentDomain) || hostname === parentDomain) {
          return true;
        }
      } else {
        if (hostname.endsWith('.' + domain)) {
          return true;
        }
      }
      return false;
    });
    return matchedCookies.map(c => `${c.name}=${c.value}`).join('; ');
  } catch (e) {
    console.error("[다크나이트] 쿠키 수집 오류:", e);
    return "";
  }
}

/**
 * Mixed Content 차단 예방을 위한 HTTPS 강제 전환 헬퍼
 */
function ensureHttps(url) {
  if (typeof url !== 'string') return url;
  if (url.startsWith('http://')) {
    return url.replace('http://', 'https://');
  }
  return url;
}

/**
 * [신규] 다운로드 세션 전용 DNR 규칙 추가 등록 (기존 규칙과 병합, 중복 방지)
 * 
 * 핵심 차이점: 이전 executeWithMultiBypasses와 달리, 콜백 완료 후 규칙을 즉시 해제하지 않습니다!
 * 규칙은 다운로드가 완전히 끝날 때(성공/실패 모두) clearDownloadRules()로 명시적 해제합니다.
 * 이를 통해 M3U8 파싱 → TS 다운로드 전환 구간에서 규칙 공백이 발생하지 않습니다.
 */
async function setupDownloadRules(urls) {
  const extensionOrigin = chrome.runtime.getURL('').slice(0, -1);
  const hostnames = [...new Set(urls.map(url => {
    try {
      return new URL(ensureHttps(url)).hostname;
    } catch (e) {
      return null;
    }
  }).filter(Boolean))];

  // 이미 등록된 호스트는 건너뛰기 (중복 규칙 방지)
  const newHostnames = hostnames.filter(h => !registeredHostnames.has(h));
  if (newHostnames.length === 0) {
    console.log("[다크나이트] 모든 호스트 규칙이 이미 등록되어 있음, 스킵:", hostnames);
    return;
  }

  const newRules = [];
  
  for (const hostname of newHostnames) {
    const cookieStr = await getCookiesForDomain(hostname);
    
    // ReadyStream/NaverCloud 특화 매핑
    let refererValue, originValue;
    if (hostname.includes('hducc.handong.edu') || hostname.includes('naverncp.com')) {
      refererValue = "https://hducc.handong.edu/";
      originValue = "https://hducc.handong.edu";
    } else {
      originValue = `https://${hostname}`;
      refererValue = originValue + "/";
    }

    const requestHeaders = [
      { header: "Referer", operation: "set", value: refererValue },
      { header: "Origin", operation: "set", value: originValue }
    ];

    if (cookieStr) {
      requestHeaders.push({ header: "Cookie", operation: "set", value: cookieStr });
    }

    const ruleId = dynamicRuleIdCounter++;
    downloadSessionRuleIds.push(ruleId);
    registeredHostnames.add(hostname);

    newRules.push({
      id: ruleId,
      priority: 100,
      action: {
        type: "modifyHeaders",
        requestHeaders: requestHeaders,
        responseHeaders: [
          { header: "Access-Control-Allow-Origin", operation: "set", value: extensionOrigin },
          { header: "Access-Control-Allow-Credentials", operation: "set", value: "true" }
        ]
      },
      condition: {
        urlFilter: "||" + hostname,
        tabIds: [-1], // 백그라운드 fetch 요청에만 한정 (사용자 브라우저 탭 세션 오염 및 충돌 방지)
        resourceTypes: ["xmlhttprequest", "other"]
      }
    });
  }

  if (newRules.length > 0) {
    try {
      await chrome.declarativeNetRequest.updateSessionRules({
        addRules: newRules
      });
      console.log("[다크나이트] 다운로드 세션 DNR 규칙 추가 등록:", newHostnames);
    } catch (e) {
      console.error("[다크나이트] DNR 규칙 추가 등록 실패:", e);
    }
  }
}

/**
 * [신규] 다운로드 세션 전용 DNR 규칙 전체 해제 (다운로드 완전 종료 시에만 호출!)
 */
async function clearDownloadRules() {
  if (downloadSessionRuleIds.length > 0) {
    try {
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: downloadSessionRuleIds
      });
      console.log("[다크나이트] 다운로드 세션 DNR 규칙 전체 해제 완료:", downloadSessionRuleIds.length, "개");
    } catch (e) {
      console.warn("[다크나이트] DNR 세션 규칙 해제 실패:", e);
    }
    downloadSessionRuleIds = [];
    registeredHostnames.clear();
  }
}

// 시작 시 또는 확장 프로그램 설치 시 declarativeNetRequest 규칙 동적 등록 (CORS 및 Referer 보안 완벽 우회!)
chrome.runtime.onInstalled.addListener(() => {
  setupNetRequestRules();
});

chrome.runtime.onStartup.addListener(() => {
  setupNetRequestRules();
});

// 즉시 로딩 대비 실행
setupNetRequestRules();

async function setupNetRequestRules() {
  const extensionOrigin = chrome.runtime.getURL('').slice(0, -1);

  const rules = [
    {
      id: 1001,
      priority: 2, // 높은 우선순위로 iframe 페이지 요청 처리
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          { header: "Referer", operation: "set", value: "https://lms.handong.edu/" },
          { header: "Origin", operation: "set", value: "https://lms.handong.edu" }
        ]
      },
      condition: {
        urlFilter: "*hducc.handong.edu/em/*",
        resourceTypes: ["main_frame", "sub_frame", "xmlhttprequest"]
      }
    },
    {
      id: 1002,
      priority: 1, // 일반 미디어 및 API 요청 처리
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          { header: "Referer", operation: "set", value: "https://hducc.handong.edu/" },
          { header: "Origin", operation: "set", value: "https://hducc.handong.edu" }
        ],
        responseHeaders: [
          { header: "Access-Control-Allow-Origin", operation: "set", value: extensionOrigin },
          { header: "Access-Control-Allow-Credentials", operation: "set", value: "true" }
        ]
      },
      condition: {
        urlFilter: "||hducc.handong.edu",
        resourceTypes: [
          "main_frame", "sub_frame", "stylesheet", "script", "image", 
          "font", "object", "xmlhttprequest", "ping", "csp_report", 
          "media", "websocket", "other"
        ]
      }
    },
    {
      id: 1003,
      priority: 1, // 네이버 클라우드 CDN MP4 및 미디어 요청 처리 (15바이트 에러 해결)
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          { header: "Referer", operation: "set", value: "https://hducc.handong.edu/" },
          { header: "Origin", operation: "set", value: "https://hducc.handong.edu" }
        ],
        responseHeaders: [
          { header: "Access-Control-Allow-Origin", operation: "set", value: extensionOrigin },
          { header: "Access-Control-Allow-Credentials", operation: "set", value: "true" }
        ]
      },
      condition: {
        urlFilter: "||naverncp.com",
        resourceTypes: [
          "main_frame", "sub_frame", "stylesheet", "script", "image", 
          "font", "object", "xmlhttprequest", "ping", "csp_report", 
          "media", "websocket", "other"
        ]
      }
    },
    {
      id: 1004,
      priority: 2, // hducc.handong.edu에서 호출한 naverncp.com CORS 허용
      action: {
        type: "modifyHeaders",
        responseHeaders: [
          { header: "Access-Control-Allow-Origin", operation: "set", value: "https://hducc.handong.edu" },
          { header: "Access-Control-Allow-Credentials", operation: "set", value: "true" }
        ]
      },
      condition: {
        urlFilter: "||naverncp.com",
        initiatorDomains: ["hducc.handong.edu"],
        resourceTypes: [
          "main_frame", "sub_frame", "stylesheet", "script", "image", 
          "font", "object", "xmlhttprequest", "ping", "csp_report", 
          "media", "websocket", "other"
        ]
      }
    },
    {
      id: 1005,
      priority: 2, // lms.handong.edu에서 호출한 naverncp.com CORS 허용
      action: {
        type: "modifyHeaders",
        responseHeaders: [
          { header: "Access-Control-Allow-Origin", operation: "set", value: "https://lms.handong.edu" },
          { header: "Access-Control-Allow-Credentials", operation: "set", value: "true" }
        ]
      },
      condition: {
        urlFilter: "||naverncp.com",
        initiatorDomains: ["lms.handong.edu"],
        resourceTypes: [
          "main_frame", "sub_frame", "stylesheet", "script", "image", 
          "font", "object", "xmlhttprequest", "ping", "csp_report", 
          "media", "websocket", "other"
        ]
      }
    },
    {
      id: 1006,
      priority: 2, // lms.handong.edu에서 호출한 hducc.handong.edu CORS 허용
      action: {
        type: "modifyHeaders",
        responseHeaders: [
          { header: "Access-Control-Allow-Origin", operation: "set", value: "https://lms.handong.edu" },
          { header: "Access-Control-Allow-Credentials", operation: "set", value: "true" }
        ]
      },
      condition: {
        urlFilter: "||hducc.handong.edu",
        initiatorDomains: ["lms.handong.edu"],
        resourceTypes: [
          "main_frame", "sub_frame", "stylesheet", "script", "image", 
          "font", "object", "xmlhttprequest", "ping", "csp_report", 
        ]
      }
    },
    {
      id: 1020,
      priority: 3, // LMS에서 호출하는 모든 외부 CDN (Naver Cloud 등) CORS 강제 허용
      action: {
        type: "modifyHeaders",
        responseHeaders: [
          { header: "Access-Control-Allow-Origin", operation: "set", value: "*" },
          { header: "Access-Control-Allow-Credentials", operation: "set", value: "true" }
        ]
      },
      condition: {
        urlFilter: "*darkknight_cors_bypass=1*",
        resourceTypes: ["xmlhttprequest", "media", "other"]
      }
    },
    // === v2.0 SNS 플랫폼 CORS 우회 규칙 ===
    {
      id: 1007,
      priority: 1, // 트위터(X) 비디오 CDN CORS 허용
      action: {
        type: "modifyHeaders",
        responseHeaders: [
          { header: "Access-Control-Allow-Origin", operation: "set", value: "*" },
          { header: "Access-Control-Allow-Credentials", operation: "set", value: "true" }
        ]
      },
      condition: {
        urlFilter: "||video.twimg.com",
        resourceTypes: ["media", "xmlhttprequest", "other"]
      }
    },
    {
      id: 1008,
      priority: 1, // 블루스카이 비디오 프로세서 CORS 허용
      action: {
        type: "modifyHeaders",
        responseHeaders: [
          { header: "Access-Control-Allow-Origin", operation: "set", value: "*" },
          { header: "Access-Control-Allow-Credentials", operation: "set", value: "true" }
        ]
      },
      condition: {
        urlFilter: "||video.bsky.app",
        resourceTypes: ["media", "xmlhttprequest", "other"]
      }
    },
    {
      id: 1009,
      priority: 1, // 블루스카이 CDN CORS 허용
      action: {
        type: "modifyHeaders",
        responseHeaders: [
          { header: "Access-Control-Allow-Origin", operation: "set", value: "*" },
          { header: "Access-Control-Allow-Credentials", operation: "set", value: "true" }
        ]
      },
      condition: {
        urlFilter: "||video.cdn.bsky.app",
        resourceTypes: ["media", "xmlhttprequest", "other"]
      }
    },
    {
      id: 1010,
      priority: 1, // 틱톡 비디오 CDN CORS 허용
      action: {
        type: "modifyHeaders",
        responseHeaders: [
          { header: "Access-Control-Allow-Origin", operation: "set", value: "*" },
          { header: "Access-Control-Allow-Credentials", operation: "set", value: "true" }
        ]
      },
      condition: {
        urlFilter: "||tiktok.com",
        resourceTypes: ["media", "xmlhttprequest", "other"]
      }
    },
    {
      id: 1011,
      priority: 1, // 틱톡 CDN (tiktokcdn) CORS 허용
      action: {
        type: "modifyHeaders",
        responseHeaders: [
          { header: "Access-Control-Allow-Origin", operation: "set", value: "*" },
          { header: "Access-Control-Allow-Credentials", operation: "set", value: "true" }
        ]
      },
      condition: {
        urlFilter: "||tiktokcdn.com",
        resourceTypes: ["media", "xmlhttprequest", "other"]
      }
    },
    {
      id: 1012,
      priority: 1, // 도우인(抖音) 비디오 CDN CORS 허용
      action: {
        type: "modifyHeaders",
        responseHeaders: [
          { header: "Access-Control-Allow-Origin", operation: "set", value: "*" },
          { header: "Access-Control-Allow-Credentials", operation: "set", value: "true" }
        ]
      },
      condition: {
        urlFilter: "||douyinvod.com",
        resourceTypes: ["media", "xmlhttprequest", "other"]
      }
    },
    {
      id: 1013,
      priority: 1, // 인스타그램/페이스북 CDN (cdninstagram + fbcdn) CORS 허용
      action: {
        type: "modifyHeaders",
        responseHeaders: [
          { header: "Access-Control-Allow-Origin", operation: "set", value: "*" },
          { header: "Access-Control-Allow-Credentials", operation: "set", value: "true" }
        ]
      },
      condition: {
        urlFilter: "||cdninstagram.com",
        resourceTypes: ["media", "xmlhttprequest", "other"]
      }
    },
    {
      id: 1014,
      priority: 1, // 페이스북 비디오 CDN CORS 허용
      action: {
        type: "modifyHeaders",
        responseHeaders: [
          { header: "Access-Control-Allow-Origin", operation: "set", value: "*" },
          { header: "Access-Control-Allow-Credentials", operation: "set", value: "true" }
        ]
      },
      condition: {
        urlFilter: "||fbcdn.net",
        resourceTypes: ["media", "xmlhttprequest", "other"]
      }
    },
    {
      id: 1015,
      priority: 1, // AV19 (vdnext.com) 비디오 CDN CORS 허용
      action: {
        type: "modifyHeaders",
        responseHeaders: [
          { header: "Access-Control-Allow-Origin", operation: "set", value: "*" },
          { header: "Access-Control-Allow-Credentials", operation: "set", value: "true" }
        ]
      },
      condition: {
        urlFilter: "||vdnext.com",
        resourceTypes: ["media", "xmlhttprequest", "other"]
      }
    },
    {
      id: 1016,
      priority: 1, // AV19 (nnvivi.site) 플레이어 CORS 허용
      action: {
        type: "modifyHeaders",
        responseHeaders: [
          { header: "Access-Control-Allow-Origin", operation: "set", value: "*" },
          { header: "Access-Control-Allow-Credentials", operation: "set", value: "true" }
        ]
      },
      condition: {
        urlFilter: "||nnvivi.site",
        resourceTypes: ["media", "xmlhttprequest", "other", "sub_frame"]
      }
    }
  ];

  const sessionRules = [
    {
      id: 1030,
      priority: 3, // Service Worker(background.js)에서 직접 fetch하는 모든 비디오/청크 요청에 대한 범용 CORS 강제 허용 (탭과 무관한 요청 = tabIds: [-1])
      action: {
        type: "modifyHeaders",
        responseHeaders: [
          { header: "Access-Control-Allow-Origin", operation: "set", value: "*" }
        ]
      },
      condition: {
        urlFilter: "*",
        tabIds: [-1], // 백그라운드 스크립트에서 발생한 요청에만 적용 (보안 유지)
        resourceTypes: ["xmlhttprequest", "other"]
      }
    },
    {
      id: 1031,
      priority: 4, // LMS CDN (Naver Cloud) Access Denied (403) 방지용 Referer 강제 주입
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          { header: "Referer", operation: "set", value: "https://lms.handong.edu/" }
        ]
      },
      condition: {
        requestDomains: ["naverncp.com", "hducc.handong.edu"],
        tabIds: [-1], // 백그라운드 요청 전용
        resourceTypes: ["xmlhttprequest", "media", "other"]
      }
    },
    {
      id: 1032,
      priority: 4, // AV19 CDN Access Denied 방지용 Referer 강제 주입
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          { header: "Referer", operation: "set", value: "https://av19.fit/" }
        ]
      },
      condition: {
        requestDomains: ["nnvivi.site", "av19.fit"],
        tabIds: [-1],
        resourceTypes: ["xmlhttprequest", "media", "other"]
      }
    }
  ];

  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014, 1015, 1016, 1017, 1018, 1019, 1020, 1021, 1022, 1023, 1024, 1025, 1026, 1027, 1028, 1029],
      addRules: rules
    });
    
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [1030, 1031, 1032],
      addRules: sessionRules
    });
    
    console.log("다크나이트 v2.0 - 범용 CORS 및 세션(Referer) 네트워크 규칙 등록 완료! (한동대 LMS + SNS 8개 플랫폼 + AV19 암호화 뚫기)");
  } catch (err) {
    console.error("DNR 규칙 등록 오류:", err);
  }
}

// 미디어 파일 패턴 정의
const MEDIA_PATTERNS = [
  { regex: /\.m3u8([\?#]|$)/i, type: 'HLS (M3U8) 스트림' },
  { regex: /\.mp4([\?#]|$)/i, type: 'MP4 비디오' },
  { regex: /\.mpd([\?#]|$)/i, type: 'DASH (MPD) 스트림' },
  { regex: /\.webm([\?#]|$)/i, type: 'WebM 비디오' },
  { regex: /\.mov([\?#]|$)/i, type: 'MOV 비디오' },
  { regex: /\.ts([\?#]|$)/i, type: 'MPEG-TS 비디오' }
];

// v2.0 플랫폼별 CDN 자동 식별 패턴 (감지 시 스마트 라벨 자동 부여)
const PLATFORM_PATTERNS = [
  { regex: /video\.twimg\.com/i, platform: 'twitter', label: '🐦 X (트위터) 비디오' },
  { regex: /video\.bsky\.app|video\.cdn\.bsky\.app/i, platform: 'bluesky', label: '🦋 블루스카이 비디오' },
  { regex: /tiktokcdn\.com|v\d+-webapp.*\.tiktok\.com/i, platform: 'tiktok', label: '🎵 틱톡 비디오' },
  { regex: /douyinvod\.com|douyincdn\.com/i, platform: 'douyin', label: '🎶 도우인(抖音) 비디오' },
  { regex: /cdninstagram\.com|scontent.*instagram/i, platform: 'instagram', label: '📸 인스타그램 비디오' },
  { regex: /fbcdn\.net|video.*facebook\.com/i, platform: 'facebook', label: '📘 페이스북 비디오' },
  { regex: /hducc\.handong\.edu|naverncp\.com/i, platform: 'readystream', label: 'ReadyStream 강의 비디오' },
  { regex: /googlevideo\.com|youtube\.com/i, platform: 'youtube', label: '▶️ YouTube 비디오' },
  { regex: /vimeo\.com|vimeocdn\.com/i, platform: 'vimeo', label: '🎬 Vimeo 비디오' },
  { regex: /nnvivi\.site|vdnext\.com|av19/i, platform: 'av19', label: '🔞 AV19 암호화 비디오 (복호화 가능)' }
];

// 제외할 일반 주소 패턴
const EXCLUDE_PATTERNS = /googlesyndication|doubleclick|analytics\.google|log\.tiktok|tracker|adsystem|favicon|beacon/i;

/**
 * URL에서 플랫폼 감지 후 스마트 라벨 반환
 */
function detectPlatformLabel(url) {
  for (const pattern of PLATFORM_PATTERNS) {
    if (pattern.regex.test(url)) {
      return pattern.label;
    }
  }
  return null;
}

// 네트워크 요청 감시 리스너 설정
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const { url, tabId, type } = details;
    
    if (tabId < 0 || EXCLUDE_PATTERNS.test(url)) return;

    let matchedType = null;

    if (type === 'media') {
      matchedType = 'MP4 비디오';
      for (const pattern of MEDIA_PATTERNS) {
        if (pattern.regex.test(url)) {
          matchedType = pattern.type;
          break;
        }
      }
    } else {
      for (const pattern of MEDIA_PATTERNS) {
        if (pattern.regex.test(url)) {
          matchedType = pattern.type;
          break;
        }
      }
    }

    if (matchedType) {
      // v2.0 플랫폼 스마트 라벨 자동 적용
      const platformLabel = detectPlatformLabel(url);
      const finalType = platformLabel || matchedType;

      addMedia(tabId, {
        url: url,
        type: finalType,
        title: extractFileName(url, finalType),
        frameId: details.frameId,
        source: 'network',
        timestamp: Date.now()
      });
    }
  },
  { urls: ["<all_urls>"] }
);

/**
 * 감지된 미디어를 탭 메모리에 추가 (중복 방지 및 팝업 실시간 갱신 알림)
 */
function addMedia(tabId, mediaItem) {
  if (!detectedMedia[tabId]) {
    detectedMedia[tabId] = [];
  }

  const exists = detectedMedia[tabId].some(item => item.url === mediaItem.url);
  if (!exists) {
    detectedMedia[tabId].push(mediaItem);
    updateBadge(tabId);

    // 팝업이 열려 있는 경우 실시간 화면 갱신 메시지 송출
    chrome.runtime.sendMessage({ 
      action: 'mediaListUpdated', 
      tabId: tabId 
    }).catch(() => {
      // 팝업이 닫혀 있을 때 발생하는 에러는 정상적이므로 무시 처리
    });
  }
}

/**
 * 파일 이름 추출 유틸리티
 */
function extractFileName(url, type) {
  try {
    const decodedUrl = decodeURIComponent(url);
    const urlObj = new URL(decodedUrl);
    const pathname = urlObj.pathname;
    const filename = pathname.substring(pathname.lastIndexOf('/') + 1);
    
    if (filename && filename.includes('.')) {
      return filename;
    }
  } catch (e) {
    // 예외 발생 시 기본값 대체
  }
  
  return `감지된 스트리밍 동영상 (${type})`;
}

/**
 * 탭의 배지(감지된 개수) 업데이트
 */
function updateBadge(tabId) {
  const count = detectedMedia[tabId] ? detectedMedia[tabId].length : 0;
  if (count > 0) {
    chrome.action.setBadgeText({ text: count.toString(), tabId: tabId });
    chrome.action.setBadgeBackgroundColor({ color: "#FFB800", tabId: tabId });
  } else {
    chrome.action.setBadgeText({ text: "", tabId: tabId });
  }
}

/**
 * URL의 쿼리 스트링(?) 및 해시(#) 정보를 제거한 기본 주소 반환
 */
function getBaseUrl(url) {
  try {
    const urlObj = new URL(url);
    return urlObj.origin + urlObj.pathname;
  } catch (e) {
    return url;
  }
}

// 탭의 URL이 실제로 변경되었을 때 목록을 비우고,
// 컨텐트 스크립트에게도 탐색기 초기화(리셋) 명령을 내려 새로운 영상 탐색 준비
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    const newBaseUrl = getBaseUrl(changeInfo.url);
    const oldBaseUrl = lastBaseUrls[tabId];
    
    if (oldBaseUrl && newBaseUrl !== oldBaseUrl) {
      // [레이스 컨디션 완벽 방지] 페이지 로딩/전환 중에 네트워크 스니퍼가 먼저 감지한 미디어를
      // URL 변경 이벤트가 즉시 비워버려 목록이 사라지는 오류를 해결하기 위해, 8초 이내 감지된 최신 미디어는 삭제 보류합니다.
      const now = Date.now();
      const preservationThreshold = 8000; // 8초 이내 감지 항목 보존
      
      const preservedMedia = (detectedMedia[tabId] || []).filter(item => {
        return (now - item.timestamp) < preservationThreshold;
      });
      
      detectedMedia[tabId] = preservedMedia;
      updateBadge(tabId);

      // 컨텐트 스크립트에 리셋 및 재스캔 지시 전송 (동적 프레임 대응을 위해 전송 후 catch)
      chrome.tabs.sendMessage(tabId, { action: 'resetScanner' }).catch(() => {
        // 컨텐트 스크립트 미탑재 탭 예외 대응
      });
    }
    
    lastBaseUrls[tabId] = newBaseUrl;
  }
});

// 탭이 닫히면 메모리 해제
chrome.tabs.onRemoved.addListener((tabId) => {
  delete detectedMedia[tabId];
  delete lastBaseUrls[tabId];
});

/**
 * 일반화된 HLS (M3U8) 실시간 자동 분할 다운로드 및 바이너리 머지 처리기 (백그라운드 서비스 워커 버전)
 * 
 * [v3.0 근본 재설계] setupDownloadRules → 다운로드 전체 → clearDownloadRules 생명주기 적용
 * 이전 버전의 executeWithMultiBypasses 콜백 패턴에서 발생하던 규칙 해제 공백 문제를 완전 제거!
 */
async function downloadHlsInBackground(m3u8Url, title, tabId) {
  m3u8Url = ensureHttps(m3u8Url);
  const session = {
    tabId,
    url: m3u8Url,
    title,
    progress: 0,
    statusText: 'M3U8 플레이리스트 분석 중...',
    isError: false,
    isComplete: false,
    errorMsg: ''
  };
  activeDownloadSession = session;

  const updateProgress = (progress, statusText, isError = false, isComplete = false, errorMsg = '') => {
    session.progress = progress;
    session.statusText = statusText;
    session.isError = isError;
    session.isComplete = isComplete;
    session.errorMsg = errorMsg;

    chrome.runtime.sendMessage({
      action: 'hlsDownloadProgress',
      progress,
      statusText,
      isError,
      isComplete,
      errorMsg
    }).catch(() => {
      // 팝업이 닫혀 있을 때 발생하는 에러 무시
    });
  };

  try {
    updateProgress(5, 'M3U8 마스터 플레이리스트 파일 수집 중...');

    // [v3.0] 다운로드 세션 시작 시 DNR 규칙 등록 (M3U8 도메인)
    await setupDownloadRules([m3u8Url]);

    // 1. M3U8 메인 주소 파싱
    const response = await fetch(m3u8Url, { credentials: 'include' });
    if (!response.ok) throw new Error(`M3U8 플레이리스트 요청 실패 (상태 코드: ${response.status})`);
    const text = await response.text();

    const baseUrl = m3u8Url.substring(0, m3u8Url.lastIndexOf('/') + 1);
    const lines = text.split('\n');
    const tsUrls = [];

    // 2. 플레이리스트 내의 TS 비디오 청크 리스트 추출
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line && !line.startsWith('#')) {
        let tsUrl = line;
        if (!line.startsWith('http://') && !line.startsWith('https://')) {
          if (line.startsWith('/')) {
            const urlObj = new URL(m3u8Url);
            tsUrl = urlObj.origin + line;
          } else {
            tsUrl = baseUrl + line;
          }
        }
        tsUrls.push(ensureHttps(tsUrl));
      }
    }

    // 3. 다중 화질 마스터 플레이리스트 대응
    if (tsUrls.length === 0) {
      const subPlaylists = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line && !line.startsWith('#') && (line.toLowerCase().includes('.m3u8') || line.toLowerCase().includes('m3u8'))) {
          let subUrl = line;
          if (!line.startsWith('http://') && !line.startsWith('https://')) {
            subUrl = baseUrl + line;
          }
          subPlaylists.push(ensureHttps(subUrl));
        }
      }

      if (subPlaylists.length > 0) {
        updateProgress(10, '고화질 서브 스트리밍 리스트 감지, 주소 전환 중...');
        // [v3.0] clearDownloadRules를 호출하지 않고 재귀 호출! (규칙은 유지됨)
        return await downloadHlsInBackground(ensureHttps(subPlaylists[0]), title, tabId);
      }

      throw new Error('M3U8 스트리밍 내에서 분할 비디오 조각(TS)을 찾지 못했습니다.');
    }

    // [v3.0] TS 도메인에 대한 DNR 규칙 추가 등록 (기존 M3U8 규칙과 병합!)
    await setupDownloadRules(tsUrls);

    // 4. TS 파일 다운로드 가동 (5개 채널 동시 고속 다운로드)
    await _downloadTsChunks(tsUrls, title, tabId, session, updateProgress);

  } catch (err) {
    console.error("백그라운드 HLS 다운로드 실패:", err);
    updateProgress(0, '다운로드 실패', true, false, err.message || err.toString());
  } finally {
    // [v3.0] 다운로드 완전 종료 후에만 규칙 해제! (성공/실패 모두)
    await clearDownloadRules();
  }
}

/**
 * [v3.0 신규] content.js가 이미 파싱한 TS URL 목록을 직접 받아 즉시 다운로드 시작
 * M3U8 재파싱을 완전히 건너뛰므로 403 발생 가능성이 원천 차단됩니다!
 */
async function downloadTsChunksDirectly(tsUrls, m3u8Url, title, tabId) {
  const session = {
    tabId,
    url: m3u8Url,
    title,
    progress: 0,
    statusText: 'TS 다운로드 직접 연결 중...',
    isError: false,
    isComplete: false,
    errorMsg: ''
  };
  activeDownloadSession = session;

  const updateProgress = (progress, statusText, isError = false, isComplete = false, errorMsg = '') => {
    session.progress = progress;
    session.statusText = statusText;
    session.isError = isError;
    session.isComplete = isComplete;
    session.errorMsg = errorMsg;

    chrome.runtime.sendMessage({
      action: 'hlsDownloadProgress',
      progress,
      statusText,
      isError,
      isComplete,
      errorMsg
    }).catch(() => {});
  };

  try {
    updateProgress(12, '보안 채널 통과, TS 다운로드 코어 엔진 직접 가동 중...');

    // TS 도메인에 대한 DNR 규칙 등록
    await setupDownloadRules(tsUrls);

    // TS 파일 다운로드 가동
    await _downloadTsChunks(tsUrls, title, tabId, session, updateProgress);

  } catch (err) {
    console.error("백그라운드 TS 직접 다운로드 실패:", err);
    updateProgress(0, '다운로드 실패', true, false, err.message || err.toString());
  } finally {
    await clearDownloadRules();
  }
}

/**
 * [v3.0 내부 헬퍼] TS 청크 실제 다운로드 및 content.js 디스크 스풀링 공통 로직
 */
async function _downloadTsChunks(tsUrls, title, tabId, session, updateProgress) {
  const total = tsUrls.length;
  updateProgress(15, `비디오 조각 다운로드 시작... (총 ${total}개 파편)`);

  // 백그라운드 메모리 터짐(OOM) 방지를 위해 content.js에 Blob 배열 초기화 명령 전송
  await chrome.tabs.sendMessage(tabId, { action: 'initBlobChunks', total: total });

  let completedChunks = 0;
  const concurrencyLimit = 5;

  for (let i = 0; i < tsUrls.length; i += concurrencyLimit) {
    if (activeDownloadSession !== session) return;

    const batch = tsUrls.slice(i, i + concurrencyLimit);
    const promises = batch.map(async (url, index) => {
      const currentIndex = i + index;
      
      // 개별 TS fetch 실패 시 3회 재시도 (네트워크 불안정 대응)
      let lastError;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await fetch(ensureHttps(url));
          if (!res.ok) throw new Error(`비디오 파편 다운로드 오류 (${res.status})`);
          
          const buffer = await res.arrayBuffer();
          
          // ArrayBuffer를 Base64로 변환하여 IPC 전송 (단일 청크 크기가 작으므로 안전)
          let binary = '';
          const bytes = new Uint8Array(buffer);
          const len = bytes.byteLength;
          const chunkSize = 8192;
          for (let j = 0; j < len; j += chunkSize) {
            binary += String.fromCharCode.apply(null, bytes.subarray(j, j + chunkSize));
          }
          const base64Data = btoa(binary);

          // 즉시 content.js로 전송하여 Blob화(디스크 스풀링) 유도 -> 백그라운드 메모리 즉시 해제!
          await chrome.tabs.sendMessage(tabId, {
            action: 'storeBlobChunk',
            index: currentIndex,
            base64Data: base64Data
          });
          
          completedChunks++;
          const progressPct = Math.round((completedChunks / total) * 83) + 15; // 15% ~ 98% 진행
          updateProgress(progressPct, `비디오 파편 수집 및 캐싱 중: ${completedChunks} / ${total} 개 완료`);
          
          lastError = null;
          break; // 성공 시 재시도 루프 탈출
        } catch (e) {
          lastError = e;
          if (attempt < 2) {
            console.warn(`[다크나이트] TS 파편 ${currentIndex} 다운로드 재시도 (${attempt + 1}/3):`, e.message);
            await new Promise(r => setTimeout(r, 1000 * (attempt + 1))); // 지수 백오프
          }
        }
      }
      if (lastError) throw lastError;
    });

    await Promise.all(promises);
  }

  // 바이너리 스트림 고속 병합 명령 하달
  updateProgress(98, '수집된 비디오 파편 고속 병합 중...');
  
  // 브라우저 최종 파일 다운로드 트리거 (.ts 포맷 무손실 원본 저장)
  updateProgress(99, '다운로드 완료 처리 및 로컬 저장 중...');
  
  chrome.tabs.sendMessage(tabId, {
    action: 'finalizeBlobDownload',
    title: title,
    extension: 'ts'
  }, { frameId: 0 }, (response) => {
    // 완료 성공
  });
  
  updateProgress(100, '다운로드 완료 및 무손실 파일 소장 완료!', false, true);
}

/**
 * AV19 암호화 HLS 실시간 복호화 및 병합 처리기 (AES-128)
 */
async function downloadEncryptedHlsInBackground(fragments, title, tabId) {
  const session = {
    tabId,
    url: 'encrypted_hls_stream',
    title,
    progress: 0,
    statusText: '암호화된 파편 다운로드 및 복호화 준비 중...',
    isError: false,
    isComplete: false,
    errorMsg: ''
  };
  activeDownloadSession = session;

  const updateProgress = (progress, statusText, isError = false, isComplete = false, errorMsg = '') => {
    session.progress = progress;
    session.statusText = statusText;
    session.isError = isError;
    session.isComplete = isComplete;
    session.errorMsg = errorMsg;

    chrome.runtime.sendMessage({
      action: 'hlsDownloadProgress',
      progress,
      statusText,
      isError,
      isComplete,
      errorMsg
    }).catch(() => {});
  };

  try {
    const total = fragments.length;
    updateProgress(5, `암호화 파편 다운로드 및 실시간 복호화 시작... (총 ${total}개 파편)`);

    await chrome.tabs.sendMessage(tabId, { action: 'initBlobChunks', total: total });

    let completedChunks = 0;
    const concurrencyLimit = 5;

    const fragmentUrls = fragments.map(f => ensureHttps(f.url));
    // [v3.0] 다운로드 세션 시작 시 DNR 규칙 등록
    await setupDownloadRules(fragmentUrls);

    for (let i = 0; i < total; i += concurrencyLimit) {
      if (activeDownloadSession !== session) return;

      const batch = fragments.slice(i, i + concurrencyLimit);
      const promises = batch.map(async (frag, index) => {
        const currentIndex = i + index;
        
        // 1. 파편 다운로드
        const res = await fetch(ensureHttps(frag.url));
        if (!res.ok) throw new Error(`암호화 파편 다운로드 오류 (${res.status})`);
        const encryptedBuffer = await res.arrayBuffer();

        // 2. WebCrypto API를 이용한 AES-128-CBC 복호화
        let decryptedBuffer = encryptedBuffer;
        if (frag.key && frag.iv) {
          const keyData = new Uint8Array(frag.key);
          const ivData = new Uint8Array(frag.iv);
          
          const cryptoKey = await crypto.subtle.importKey(
            "raw",
            keyData,
            { name: "AES-CBC" },
            false,
            ["decrypt"]
          );

          decryptedBuffer = await crypto.subtle.decrypt(
            { name: "AES-CBC", iv: ivData },
            cryptoKey,
            encryptedBuffer
          );
        }

        // 3. Base64 스트리밍 전송
        let binary = '';
        const bytes = new Uint8Array(decryptedBuffer);
        const len = bytes.byteLength;
        const chunkSize = 8192;
        for (let j = 0; j < len; j += chunkSize) {
          binary += String.fromCharCode.apply(null, bytes.subarray(j, j + chunkSize));
        }
        const base64Data = btoa(binary);

        await chrome.tabs.sendMessage(tabId, {
          action: 'storeBlobChunk',
          index: currentIndex,
          base64Data: base64Data
        });
        
        completedChunks++;
        const progressPct = Math.round((completedChunks / total) * 83) + 15; // 15% ~ 98% 진행
        
        updateProgress(progressPct, `복호화 및 디스크 캐싱 중: ${completedChunks} / ${total} 개 완료`);
      });

      await Promise.all(promises);
    }

    // 4. 로컬 저장 요청
    updateProgress(98, '복호화된 파편 고속 병합 중...');
    updateProgress(99, '다운로드 완료 처리 및 로컬 저장 중...');
    
    chrome.tabs.sendMessage(tabId, {
      action: 'finalizeBlobDownload',
      title: title,
      extension: 'ts'
    }, { frameId: 0 }, (response) => {});
    
    updateProgress(100, '다운로드 및 복호화 무손실 파일 소장 완료!', false, true);

  } catch (err) {
    console.error("암호화 다운로드 실패:", err);
    updateProgress(0, '다운로드 실패', true, false, err.message || err.toString());
  } finally {
    // [v3.0] 다운로드 완전 종료 후에만 규칙 해제!
    await clearDownloadRules();
  }
}

/**
 * 대용량 단일 MP4 파일 백그라운드 다운로드 (Service Worker에서 실행하여 CORS 우회 및 메모리 OOM 방지)
 */
async function downloadMp4InBackground(mp4Url, title, tabId) {
  mp4Url = ensureHttps(mp4Url);
  const session = Date.now();
  activeDownloadSession = session;

  function updateProgress(progress, statusText, isError = false, isComplete = false, errorMsg = '') {
    if (activeDownloadSession !== session) return;
    chrome.tabs.sendMessage(tabId, {
      action: 'hlsDownloadProgress', progress, statusText, isError, isComplete, errorMsg
    }).catch(() => {});
  }

  try {
    updateProgress(5, '동영상 원본 데이터 연결 시도 중...');
    
    const bypassUrl = new URL(mp4Url);
    bypassUrl.searchParams.set('darkknight_cors_bypass', '1');
    
    // [v3.0] 다운로드 세션 시작 시 DNR 규칙 등록
    await setupDownloadRules([bypassUrl.href]);

    const res = await fetch(bypassUrl.href);
    if (!res.ok) throw new Error(`비디오 서버 연결 실패 (상태 코드: ${res.status})`);

    const reader = res.body.getReader();
    const contentLength = +res.headers.get('Content-Length') || 0;
    
    let receivedLength = 0;
    let chunkIndex = 0;
    
    // content.js에 초기화 신호 전송 (크기를 모르므로 빈 배열 생성 유도, total은 지정안함)
    await chrome.tabs.sendMessage(tabId, { action: 'initBlobChunks', total: 0 });
    
    updateProgress(10, '데이터 수집 채널 연결 성공. 스트림 다운로드 가동!');

    while (true) {
      if (activeDownloadSession !== session) {
        reader.cancel();
        return;
      }
      
      const { done, value } = await reader.read();
      if (done) break;

      // Base64 스트리밍 전송
      let binary = '';
      const len = value.length;
      const chunkSize = 8192;
      for (let j = 0; j < len; j += chunkSize) {
        binary += String.fromCharCode.apply(null, value.subarray(j, j + chunkSize));
      }
      const base64Data = btoa(binary);

      await chrome.tabs.sendMessage(tabId, {
        action: 'storeBlobChunk',
        index: chunkIndex++, // 배열에 순서대로 push되도록
        base64Data: base64Data
      });

      receivedLength += len;

      const progressPct = contentLength ? Math.round((receivedLength / contentLength) * 88) + 10 : 50;
      const mbLoaded = (receivedLength / 1024 / 1024).toFixed(1);
      const totalMb = contentLength ? (contentLength / 1024 / 1024).toFixed(1) + 'MB' : '알 수 없음';
      
      updateProgress(progressPct, `비디오 디스크 스풀링 다운로드 중: ${mbLoaded}MB / ${totalMb}`);
    }

    updateProgress(98, '수집된 데이터를 무손실 파일로 저장 준비 중...');
    updateProgress(99, '다운로드 완료 처리 및 로컬 저장 중...');
    
    chrome.tabs.sendMessage(tabId, {
      action: 'finalizeBlobDownload',
      title: title,
      extension: 'mp4'
    }, { frameId: 0 }, () => {});
    
    updateProgress(100, '다운로드 완료 및 MP4 소장 완료!', false, true);

  } catch (err) {
    console.error("백그라운드 MP4 다운로드 실패:", err);
    updateProgress(0, '다운로드 실패', true, false, err.message || err.toString());
  } finally {
    // [v3.0] 다운로드 완전 종료 후에만 규칙 해제!
    await clearDownloadRules();
  }
}

// 팝업 및 컨텐트 스크립트 통신 처리
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = message.tabId || (sender.tab && sender.tab.id);

  if (message.action === 'getMediaList') {
    sendResponse({ mediaList: detectedMedia[tabId] || [] });
  } 
  
  else if (message.action === 'getActiveDownload') {
    sendResponse({ activeSession: activeDownloadSession });
  }

  else if (message.action === 'clearActiveDownload') {
    activeDownloadSession = null;
    sendResponse({ success: true });
  }

  else if (message.action === 'registerDownloadSession') {
    activeDownloadSession = {
      tabId: tabId,
      url: message.url,
      title: message.title,
      progress: 0,
      statusText: '다운로드 준비 중...',
      isError: false,
      isComplete: false,
      errorMsg: ''
    };
    sendResponse({ success: true });
  }

  else if (message.action === 'hlsDownloadProgress') {
    // content.js 또는 타 스크립트에서 보낸 진행 상황을 백그라운드 세션에 동기화
    if (activeDownloadSession) {
      activeDownloadSession.progress = message.progress;
      activeDownloadSession.statusText = message.statusText;
      activeDownloadSession.isError = message.isError;
      activeDownloadSession.isComplete = message.isComplete;
      activeDownloadSession.errorMsg = message.errorMsg;
    }
    sendResponse({ success: true });
  }

  else if (message.action === 'startHlsBackgroundFetch') {
    const { url, title } = message;
    downloadHlsInBackground(url, title, tabId);
    sendResponse({ success: true, message: '백그라운드 HLS 다운로드 프로세스 시작됨' });
  } 

  else if (message.action === 'startMp4BackgroundFetch') {
    const { url, title } = message;
    downloadMp4InBackground(url, title, tabId);
    sendResponse({ success: true, message: '백그라운드 MP4 다운로드 프로세스 시작됨' });
  }

  else if (message.action === 'startEncryptedHlsDownload') {
    const { fragments, title } = message;
    downloadEncryptedHlsInBackground(fragments, title, tabId);
    sendResponse({ success: true, message: '백그라운드 암호화 복호화 프로세스 시작됨' });
  }

  // [v3.0 신규] content.js가 이미 파싱한 TS URL 목록을 직접 수신하여 M3U8 재파싱 없이 즉시 다운로드!
  else if (message.action === 'startHlsBackgroundFetchWithTsUrls') {
    const { tsUrls, m3u8Url, title } = message;
    downloadTsChunksDirectly(tsUrls, m3u8Url, title, tabId);
    sendResponse({ success: true, message: '백그라운드 TS 직접 다운로드 프로세스 시작됨' });
  }
  
  else if (message.action === 'addDomMedia') {
    if (tabId) {
      const items = message.mediaItems || [];
      items.forEach(item => {
        addMedia(tabId, {
          ...item,
          frameId: sender.frameId,
          source: 'dom',
          timestamp: Date.now()
        });
      });
      sendResponse({ success: true, count: detectedMedia[tabId].length });
    } else {
      sendResponse({ success: false });
    }
  }

  else if (message.action === 'fetchReadyStreamHtml') {
    const targetUrl = ensureHttps(message.url);
    // [v3.0] 백그라운드 특권을 사용하여 CORS/CSP 우회하며 로그인 세션 쿠키를 안전하게 동봉 요청!
    (async () => {
      try {
        await setupDownloadRules([targetUrl]);
        const res = await fetch(targetUrl, { credentials: 'include' });
        if (!res.ok) throw new Error(`ReadyStream 페이지 수집 실패 (HTTP 상태 코드: ${res.status})`);
        const html = await res.text();
        sendResponse({ success: true, html: html });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      } finally {
        await clearDownloadRules();
      }
    })();
    return true; // 비동기 응답 처리
  }

  else if (message.action === 'triggerDirectDownload') {
    const { url, title } = message;
    const strippedTitle = title.replace(/^\[(ReadyStream|DarkKnight)\]\s*/i, '');
    const safeTitle = strippedTitle.replace(/[\\/:*?"<>|]/g, '_');
    const cleanTitle = safeTitle.replace(/\.(mp4|ts|m3u8)$/i, '');
    const extension = url.toLowerCase().includes('.mp4') ? 'mp4' : 'ts';
    const prefix = title.includes('ReadyStream') ? '[ReadyStream]' : '[DarkKnight]';
    const filename = `${prefix}_${cleanTitle}.${extension}`;

    chrome.downloads.download({
      url: url,
      filename: filename,
      saveAs: true
    }, () => {
      // 완료 후 프로그레스 모달 상태 업데이트 피드백 송신
      setTimeout(() => {
        chrome.runtime.sendMessage({
          action: 'hlsDownloadProgress',
          progress: 100,
          statusText: '다운로드 및 파일 소장 완료!',
          isComplete: true
        }).catch(() => {});
      }, 1000);
    });
    
    sendResponse({ success: true });
  }
  
  else if (message.action === 'triggerBlobDownload') {
    const { arrayBuffer, title, extension } = message;
    if (tabId) {
      chrome.tabs.sendMessage(tabId, {
        action: 'executeBlobDownload',
        arrayBuffer: arrayBuffer,
        title: title,
        extension: extension
      }, { frameId: 0 }, (response) => {
        // 응답 무시 또는 로깅
      });
    }
    sendResponse({ success: true });
  }
  
  else if (message.action === 'startBackgroundFetch') {
    const { url, referer, title } = message;
    
    (async () => {
      const sendProgress = (progress, statusText, isError = false, isComplete = false, errorMsg = '') => {
        activeDownloadSession = {
          tabId,
          url,
          title,
          progress,
          statusText,
          isError,
          isComplete,
          errorMsg
        };
        chrome.runtime.sendMessage({
          action: 'hlsDownloadProgress',
          progress,
          statusText,
          isError,
          isComplete,
          errorMsg
        }).catch(() => {
          // 팝업이 닫혀 있을 때 발생하는 에러 무시
        });
      };

      try {
        sendProgress(5, '백그라운드 보안 우회 다운로더 가동 중...');

        const urlObj = new URL(url);
        
        // 1. 해당 도메인에 매칭되는 모든 상위/서브 쿠키 추출 (SSO 및 통합 로그인 토큰 완벽 수집!)
        const allCookies = await chrome.cookies.getAll({});
        const matchedCookies = allCookies.filter(cookie => {
          const domain = cookie.domain;
          if (urlObj.hostname === domain) return true;
          if (domain.startsWith('.')) {
            const parentDomain = domain.slice(1);
            if (urlObj.hostname.endsWith('.' + parentDomain) || urlObj.hostname === parentDomain) {
              return true;
            }
          } else {
            if (urlObj.hostname.endsWith('.' + domain)) {
              return true;
            }
          }
          return false;
        });
        const cookieStr = matchedCookies.map(c => `${c.name}=${c.value}`).join('; ');
        console.log("백그라운드 감지 최적 쿠키 개수:", matchedCookies.length);

        // 2. fetch 요청 실행 주소 정규화 (HTTPS 강제 전환으로 Mixed Content 방지!)
        let secureUrl = url;
        if (secureUrl.startsWith('http://')) {
          secureUrl = secureUrl.replace('http://', 'https://');
        }

        // 3. 동적 DNR 규칙 추가 ( fetch 시 쿠키 및 레퍼러 완벽 주입 )
        const extensionOrigin = chrome.runtime.getURL('').slice(0, -1);
        const ruleId = 2001;
        let refererHeaderValue = referer;
        let originHeaderValue = urlObj.origin;
        if (urlObj.hostname.includes('hducc.handong.edu') || urlObj.hostname.includes('naverncp.com')) {
          refererHeaderValue = "https://hducc.handong.edu/";
          originHeaderValue = "https://hducc.handong.edu";
        } else if (!refererHeaderValue) {
          refererHeaderValue = urlObj.origin + "/";
        }
        const requestHeaders = [
          { header: "Referer", operation: "set", value: refererHeaderValue },
          { header: "Origin", operation: "set", value: originHeaderValue }
        ];
        if (cookieStr) {
          requestHeaders.push({ header: "Cookie", operation: "set", value: cookieStr });
        }

        const rule = {
          id: ruleId,
          priority: 100,
          action: {
            type: "modifyHeaders",
            requestHeaders: requestHeaders,
            responseHeaders: [
              { header: "Access-Control-Allow-Origin", operation: "set", value: extensionOrigin },
              { header: "Access-Control-Allow-Credentials", operation: "set", value: "true" }
            ]
          },
          condition: {
            urlFilter: "||" + urlObj.hostname, // 도메인 전체 매칭으로 프로토콜/경로/파라미터 변경 완벽 무력화!
            resourceTypes: ["xmlhttprequest", "other"] // background fetch인 경우 other 매핑 대비 추가
          }
        };

        await chrome.declarativeNetRequest.updateDynamicRules({
          removeRuleIds: [ruleId],
          addRules: [rule]
        });

        console.log("백그라운드 우회 DNR 규칙 주입 완료 (레퍼러 연동:", refererHeaderValue + ")");
        sendProgress(10, '데이터 채널 보안 우회 수집 연결 시도 중...');

        const res = await fetch(secureUrl, { credentials: 'include' });
        if (!res.ok) throw new Error(`비디오 서버 백그라운드 연결 실패 (상태 코드: ${res.status})`);

        const reader = res.body.getReader();
        const contentLength = +res.headers.get('Content-Length') || 0;
        
        let receivedLength = 0;
        const chunks = [];
        sendProgress(15, '보안 채널 통과 성공! 고속 스트림 데이터 다운로드 시작...');

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          chunks.push(value);
          receivedLength += value.length;

          const progressPct = contentLength ? Math.round((receivedLength / contentLength) * 83) + 15 : 50;
          const mbLoaded = (receivedLength / 1024 / 1024).toFixed(1);
          const totalMb = contentLength ? (contentLength / 1024 / 1024).toFixed(1) + 'MB' : '알 수 없음';
          
          sendProgress(progressPct, `비디오 백그라운드 수집 중: ${mbLoaded}MB / ${totalMb} 완료`);
        }

        sendProgress(98, '수집된 데이터를 무손실 파일로 저장 준비 중...');

        // 4. 병합 및 메인 프레임 다운로드 지시
        const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
        const mergedArray = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
          mergedArray.set(chunk, offset);
          offset += chunk.length;
        }

        if (tabId) {
          chrome.tabs.sendMessage(tabId, {
            action: 'executeBlobDownload',
            arrayBuffer: mergedArray.buffer,
            title: title,
            extension: 'mp4'
          }, { frameId: 0 }, (response) => {
            // 성공 피드백
          });
        }

        sendProgress(100, '다운로드 완료 및 MP4 소장 완료!', false, true);

        // 5. 사용 완료된 규칙 제거
        await chrome.declarativeNetRequest.updateDynamicRules({
          removeRuleIds: [ruleId]
        });

      } catch (err) {
        console.error("백그라운드 다운로드 실패:", err);
        sendProgress(0, '다운로드 실패', true, false, err.stack || err.message || err.toString());
      }
    })();

    sendResponse({ success: true, message: '백그라운드 우회 다운로드 프로세스 시동됨' });
  }
  
  return true;
});
