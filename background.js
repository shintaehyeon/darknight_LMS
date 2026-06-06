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
    }
  ];

  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [1001, 1002, 1003],
      addRules: rules
    });
    console.log("다크나이트 - Referer/Origin 우회 네트워크 규칙 등록 완료!");
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
  { regex: /\.mov([\?#]|$)/i, type: 'MOV 비디오' }
];

// 제외할 일반 주소 패턴
const EXCLUDE_PATTERNS = /googlesyndication|doubleclick|analytics|log|tracker|adsystem|favicon/i;

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
      addMedia(tabId, {
        url: url,
        type: matchedType,
        title: extractFileName(url, matchedType),
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
      detectedMedia[tabId] = [];
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
 */
async function downloadHlsInBackground(m3u8Url, title, tabId) {
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
        tsUrls.push(tsUrl);
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
          subPlaylists.push(subUrl);
        }
      }

      if (subPlaylists.length > 0) {
        updateProgress(10, '고화질 서브 스트리밍 리스트 감지, 주소 전환 중...');
        return downloadHlsInBackground(subPlaylists[0], title, tabId);
      }

      throw new Error('M3U8 스트리밍 내에서 분할 비디오 조각(TS)을 찾지 못했습니다.');
    }

    // 4. TS 파일 다운로드 가동 (5개 채널 동시 고속 다운로드)
    const total = tsUrls.length;
    const tsChunks = new Array(total);
    updateProgress(15, `비디오 조각 다운로드 시작... (총 ${total}개 파편)`);

    const concurrencyLimit = 5;
    for (let i = 0; i < tsUrls.length; i += concurrencyLimit) {
      // 세션이 도중에 리셋되었는지 검증
      if (activeDownloadSession !== session) return;

      const batch = tsUrls.slice(i, i + concurrencyLimit);
      const promises = batch.map((url, index) => {
        const currentIndex = i + index;
        return fetch(url, { credentials: 'include' })
          .then(res => {
            if (!res.ok) throw new Error(`비디오 파편 다운로드 오류 (${res.status})`);
            return res.arrayBuffer();
          })
          .then(buffer => {
            tsChunks[currentIndex] = new Uint8Array(buffer);
            
            const completed = tsChunks.filter(Boolean).length;
            const progressPct = Math.round((completed / total) * 83) + 15; // 15% ~ 98% 진행
            
            updateProgress(progressPct, `비디오 파편 수집 중: ${completed} / ${total} 개 완료`);
          });
      });

      await Promise.all(promises);
    }

    // 5. 바이너리 스트림 고속 병합
    updateProgress(98, '수집된 비디오 파편 고속 병합 중...');
    
    const totalLength = tsChunks.reduce((acc, chunk) => acc + (chunk ? chunk.length : 0), 0);
    const mergedArray = new Uint8Array(totalLength);
    let offset = 0;
    
    for (const chunk of tsChunks) {
      if (chunk) {
        mergedArray.set(chunk, offset);
        offset += chunk.length;
      }
    }

    // 6. 브라우저 최종 파일 다운로드 트리거 (.ts 포맷 무손실 원본 저장)
    updateProgress(99, '다운로드 완료 처리 및 로컬 저장 중...');
    
    chrome.tabs.sendMessage(tabId, {
      action: 'executeBlobDownload',
      arrayBuffer: mergedArray.buffer,
      title: title,
      extension: 'ts'
    }, { frameId: 0 }, (response) => {
      // 완료 성공
    });
    
    updateProgress(100, '다운로드 완료 및 무손실 파일 소장 완료!', false, true);

  } catch (err) {
    console.error("백그라운드 HLS 다운로드 실패:", err);
    updateProgress(0, '다운로드 실패', true, false, err.message || err.toString());
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

  else if (message.action === 'startHlsBackgroundFetch') {
    const { url, title } = message;
    downloadHlsInBackground(url, title, tabId);
    sendResponse({ success: true, message: '백그라운드 HLS 다운로드 프로세스 시작됨' });
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
    // 백그라운드 특권을 사용하여 CORS/CSP 우회하며 로그인 세션 쿠키를 안전하게 동봉 요청!
    fetch(message.url, { credentials: 'include' })
      .then(res => {
        if (!res.ok) throw new Error(`ReadyStream 페이지 수집 실패 (HTTP 상태 코드: ${res.status})`);
        return res.text();
      })
      .then(html => {
        sendResponse({ success: true, html: html });
      })
      .catch(err => {
        sendResponse({ success: false, error: err.message });
      });
    return true; // 비동기 응답 처리
  }

  else if (message.action === 'triggerDirectDownload') {
    const { url, title } = message;
    const safeTitle = title.replace(/[\\/:*?"<>|]/g, '_');
    const cleanTitle = safeTitle.replace(/\.(mp4|ts|m3u8)$/i, '');
    const extension = url.toLowerCase().includes('.mp4') ? 'mp4' : 'ts';
    const filename = `[ReadyStream]_${cleanTitle}.${extension}`;

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
        const rule = {
          id: ruleId,
          priority: 100,
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              { header: "Referer", operation: "set", value: refererHeaderValue },
              { header: "Origin", operation: "set", value: originHeaderValue },
              { header: "Cookie", operation: "set", value: cookieStr }
            ],
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
