/**
 * 다크나이트 - 컨텐트 스크립트 (content.js)
 * 
 * 주요 기능:
 * 1. 활성 LMS 페이지의 DOM 구조를 크롤링하여 진짜 비디오 및 임베디드 플레이어 주소만 정밀 추출.
 * 2. 단순 레이아웃용 iframe(예: external_tools)은 제외하고, ReadyStream, YouTube, Vimeo 등 실제 비디오가 송출되는 프레임만 식별.
 * 3. 한동대 ReadyStream 비디오(hducc.handong.edu) 감지 시 맞춤형 라벨 지정으로 직관성 향상.
 */

// 이미 감지된 URL 추적을 위한 전역 Set (리셋 가능)
const uniqueUrls = new Set();

// 페이지 로드 및 동적 노드 추가 감지를 위한 분석 실행 함수
function scanDOMForVideos() {
  const detectedItems = [];

  // 1. <video> 태그 및 하위 <source> 태그 검사
  const videoElements = document.querySelectorAll('video');
  videoElements.forEach((video) => {
    // video 태그 자체의 src 속성
    if (video.src && isValidMediaUrl(video.src)) {
      const absoluteUrl = makeAbsoluteUrl(video.src);
      if (!uniqueUrls.has(absoluteUrl)) {
        uniqueUrls.add(absoluteUrl);
        detectedItems.push({
          url: absoluteUrl,
          type: getMediaTypeFromUrl(absoluteUrl, 'HTML5 Video'),
          title: video.getAttribute('title') || document.title || 'LMS 비디오 플레이어'
        });
      }
    }

    // video 내부의 <source> 자식 태그들
    const sources = video.querySelectorAll('source');
    sources.forEach((source) => {
      if (source.src && isValidMediaUrl(source.src)) {
        const absoluteUrl = makeAbsoluteUrl(source.src);
        if (!uniqueUrls.has(absoluteUrl)) {
          uniqueUrls.add(absoluteUrl);
          detectedItems.push({
            url: absoluteUrl,
            type: getMediaTypeFromUrl(absoluteUrl, source.type || 'HTML5 Video Source'),
            title: video.getAttribute('title') || document.title || 'LMS 비디오 소스'
          });
        }
      }
    });
  });

  // 2. <script> 태그 내부 전역 스캔 (ReadyStream 슬라이드 분할 강의 자동 탐지)
  //    ReadyStream 플레이어는 슬라이드(PPT) 전환에 맞춰 여러 개의 개별 MP4/M3U8 파일을
  //    순차 교체하며 재생합니다. 페이지의 script 태그에 이 모든 파일 주소가 포함되어 있으므로
  //    전역 정규식으로 한 번에 수집합니다.
  const scriptElements = document.querySelectorAll('script');
  const scriptMediaUrls = [];
  const scriptMediaRegex = /(https?:\/\/[^"'\s]+\.(?:mp4|m3u8)[^"'\s]*)/gi;

  scriptElements.forEach((scriptEl) => {
    const content = scriptEl.textContent;
    if (!content) return;

    let match;
    while ((match = scriptMediaRegex.exec(content)) !== null) {
      const detectedUrl = match[1];
      // preloader, loader, 로고, 광고 관련 URL 필터링
      if (/preloader|loader|logo|advert|analytics/i.test(detectedUrl)) continue;
      // 이미 video/source 태그로 수집한 URL이면 건너뜀
      if (uniqueUrls.has(detectedUrl)) continue;

      scriptMediaUrls.push(detectedUrl);
    }
  });

  // 스크립트 내에서 발견된 슬라이드 파트별 비디오를 등록
  if (scriptMediaUrls.length > 0) {
    const pageTitle = document.title.replace(/\s*:\s*알고리즘.*$/i, '').trim() || 'ReadyStream 강의';
    scriptMediaUrls.forEach((mediaUrl, index) => {
      if (uniqueUrls.has(mediaUrl)) return;
      uniqueUrls.add(mediaUrl);

      // 원본 파일명 추출 (예: main_(662e3858-...).mp4)
      let originalFilename = '';
      try {
        const urlObj = new URL(mediaUrl);
        originalFilename = urlObj.pathname.substring(urlObj.pathname.lastIndexOf('/') + 1);
      } catch (e) { /* 무시 */ }

      const partNumber = index + 1;
      const isReadyStreamCdn = mediaUrl.includes('hducc.handong.edu') || mediaUrl.includes('naverncp.com') || mediaUrl.includes('handong');
      const typeLabel = mediaUrl.toLowerCase().includes('.m3u8') ? 'HLS 스트리밍 (M3U8)' : 'MP4 비디오 파일';

      detectedItems.push({
        url: mediaUrl,
        type: isReadyStreamCdn ? 'ReadyStream 강의 비디오' : typeLabel,
        title: isReadyStreamCdn
          ? `[ReadyStream] ${pageTitle} (파트 ${partNumber} - ${originalFilename})`
          : `${pageTitle} (파트 ${partNumber} - ${originalFilename})`
      });
    });
  }

  // 3. <iframe> 요소 정밀 검사
  const iframes = document.querySelectorAll('iframe');
  iframes.forEach((iframe) => {
    const src = iframe.src || iframe.getAttribute('data-src');
    if (src) {
      const isReadyStream = src.includes('hducc.handong.edu/em/') || src.includes('hducc.handong.edu/index.php/vod/view_page/');
      const isYoutube = src.includes('youtube.com') || src.includes('youtu.be');
      const isVimeo = src.includes('vimeo.com');
      const isTikTok = src.includes('tiktok.com');
      const isInstagram = src.includes('instagram.com');
      const isFacebook = src.includes('facebook.com') || src.includes('fb.watch');
      const isBluesky = src.includes('bsky.app');
      const isAv19 = src.includes('nnvivi.site') || src.includes('av19.fit') || src.includes('vdnext.com');

      // 진짜 비디오 임베드인 경우만 필터링 통과
      if (isReadyStream || isYoutube || isVimeo || isTikTok || isInstagram || isFacebook || isBluesky || isAv19 || isValidMediaUrl(src)) {
        
        // [필터링 꿀팁] LMS 자체 껍데기 iframe (예: external_tools)은 사용자 혼란 방지를 위해 완전히 무시 처리!
        if (src.includes('lms.handong.edu') && src.includes('external_tools')) {
          return;
        }

        const isXVideo = src.includes('twitter.com') || src.includes('x.com');

        let typeLabel = '임베디드 비디오';
        if (isReadyStream) {
          typeLabel = 'ReadyStream 강의 비디오';
        } else if (isYoutube) {
          typeLabel = '▶️ YouTube 비디오';
        } else if (isVimeo) {
          typeLabel = '🎬 Vimeo 비디오';
        } else if (isXVideo) {
          typeLabel = '🐦 X (트위터) 비디오';
        } else if (isTikTok) {
          typeLabel = '🎵 틱톡 비디오';
        } else if (isInstagram) {
          typeLabel = '📸 인스타그램 비디오';
        } else if (isFacebook) {
          typeLabel = '📘 페이스북 비디오';
        } else if (isBluesky) {
          typeLabel = '🦋 블루스카이 비디오';
        } else if (isAv19) {
          typeLabel = '🔞 AV19 암호화 비디오 (복호화 가능)';
        }

        const absoluteUrl = makeAbsoluteUrl(src);
        if (!uniqueUrls.has(absoluteUrl)) {
          uniqueUrls.add(absoluteUrl);
          
          // 강의실 제목 정돈
          let title = iframe.title || iframe.name || document.title || '외부 임베드 비디오';
          if (isReadyStream) {
            title = `[ReadyStream] ${document.title.replace(' : 알고리즘분석(Algorithm Analysis) 02분반', '')}`;
          }

          detectedItems.push({
            url: absoluteUrl,
            type: typeLabel,
            title: title
          });
        }
      }
    }
  });

  // 4. 백그라운드 서비스 워커로 전송
  if (detectedItems.length > 0) {
    chrome.runtime.sendMessage({
      action: 'addDomMedia',
      mediaItems: detectedItems
    });
  }
}

/**
 * 상대 경로 주소를 절대 경로로 복원
 */
function makeAbsoluteUrl(url) {
  try {
    return new URL(url, document.baseURI).href;
  } catch (e) {
    return url;
  }
}

/**
 * 유효한 미디어 주소인지 검증 (base64 데이터 스키마 등 제외)
 */
function isValidMediaUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const trimmed = url.trim().toLowerCase();
  return trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.startsWith('//') || trimmed.startsWith('/');
}

/**
 * URL 분석을 통해 미디어 타입 한글 명칭 도출
 */
function getMediaTypeFromUrl(url, defaultType) {
  const lowercaseUrl = url.toLowerCase();
  if (lowercaseUrl.includes('.m3u8')) return 'HLS 스트리밍 (M3U8)';
  if (lowercaseUrl.includes('.mp4')) return 'MP4 비디오 파일';
  if (lowercaseUrl.includes('.mpd')) return 'DASH 스트리밍 (MPD)';
  if (lowercaseUrl.includes('.webm')) return 'WebM 비디오 파일';
  return defaultType;
}

// 1. 페이지 로딩 완료 시점에 자동 1차 스캔 실행
scanDOMForVideos();

// 2. SPA 환경 대응 MutationObserver (노드 추가 및 src 속성 변경 실시간 감시)
let mutationTimeout;
const observer = new MutationObserver(() => {
  clearTimeout(mutationTimeout);
  mutationTimeout = setTimeout(() => {
    scanDOMForVideos();
  }, 1000);
});

observer.observe(document.body, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['src']
});

// 3. 백그라운드로부터 리셋 및 다운로드 위임 명령을 수신
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'resetScanner') {
    uniqueUrls.clear();
    scanDOMForVideos();
    sendResponse({ success: true, message: '탐색기 리셋 및 재스캔 완료' });
  } else if (message.action === 'startHlsDownload') {
    // 1단계: 플레이어 DOM 내부에서 진짜 미디어 소스 주소 다이렉트 역추적! (CORS/네트워크 차단 완벽 원천회피)
    const extractedUrl = extractVideoUrlFromDOM();
    const targetUrl = extractedUrl || message.url;

    console.log("ReadyStream 다이렉트 소스 추적 완료:", targetUrl);

    if (targetUrl.toLowerCase().includes('.mp4') || (!targetUrl.toLowerCase().includes('.m3u8') && extractedUrl)) {
      // MP4 직접 다운로드 실행 (content.js 내부에서 동일 출처 fetch 실행!)
      downloadMp4FromContent(targetUrl, message.title)
        .then(() => {
          sendResponse({ success: true, message: '동일 출처 MP4 다운로드 프로세스 가동 완료' });
        })
        .catch((err) => {
          console.error("MP4 다운로드 구동 실패:", err);
          sendResponse({ success: false, error: err.message });
        });
    } else {
      // HLS (.m3u8) 스트리밍 케이스: 병렬 청크 분할 고속 수집 머지 가동!
      downloadHlsStreamFromContent(targetUrl, message.title)
        .then(() => {
          sendResponse({ success: true, message: '동일 출처 HLS 다운로드 프로세스 가동 완료' });
        })
        .catch((err) => {
          console.error("다운로드 백그라운드 구동 실패:", err);
          sendResponse({ success: false, error: err.message });
        });
    }
  } else if (message.action === 'startMp4Download') {
    // MP4 직접 다운로드 실행 (content.js 내부에서 동일 출처 fetch 실행!)
    downloadMp4FromContent(message.url, message.title)
      .then(() => {
        sendResponse({ success: true, message: '동일 출처 MP4 다운로드 프로세스 가동 완료' });
      })
      .catch((err) => {
        console.error("MP4 다운로드 구동 실패:", err);
        sendResponse({ success: false, error: err.message });
      });
  } else if (message.action === 'executeBlobDownload') {
    const { arrayBuffer, title, extension } = message;
    try {
      const blob = new Blob([arrayBuffer], { type: extension === 'mp4' ? 'video/mp4' : 'video/mp2t' });
      const blobUrl = URL.createObjectURL(blob);
      
      const strippedTitle = title.replace(/^\[(ReadyStream|DarkKnight)\]\s*/i, '');
      const safeTitle = strippedTitle.replace(/[\\/:*?"<>|]/g, '_');
      const cleanTitle = safeTitle.replace(/\.(mp4|ts|m3u8)$/i, '');
      const prefix = title.includes('ReadyStream') ? '[ReadyStream]' : '[DarkKnight]';
      const filename = `${prefix}_${cleanTitle}.${extension}`;

      const downloadAnchor = document.createElement('a');
      downloadAnchor.href = blobUrl;
      downloadAnchor.download = filename;
      document.body.appendChild(downloadAnchor);
      downloadAnchor.click();

      setTimeout(() => {
        document.body.removeChild(downloadAnchor);
        URL.revokeObjectURL(blobUrl);
      }, 10000);
      
      sendResponse({ success: true, message: '메인 프레임 다운로드 시작됨' });
    } catch (e) {
      console.error("다운로드 실행 실패:", e);
      sendResponse({ success: false, error: e.message });
    }
  } else if (message.action === 'startAv19Download') {
    // 인젝션 스크립트에 파편 추출 명령 하달
    window.postMessage({ action: 'extractAv19Hls', title: message.title }, '*');
    sendResponse({ success: true, message: 'AV19 복호화 인젝션 스크립트 호출됨' });
  }
  return true;
});

// --- AV19 메인 월드 스크립트 인젝션 (AES-128 키 및 조각 탈취용) ---
const script = document.createElement('script');
script.textContent = `
  window.addEventListener('message', (event) => {
    if (event.data && event.data.action === 'extractAv19Hls') {
      try {
        const video = document.querySelector('video');
        if (!video || !video._l5 || !video._l5.hls) {
          window.postMessage({ action: 'av19HlsExtracted', success: false, error: 'HLS 인스턴스를 찾을 수 없습니다. 영상이 재생 중인지 확인해주세요.' }, '*');
          return;
        }
        
        const hls = video._l5.hls;
        if (!hls.levels || hls.levels.length === 0) {
          window.postMessage({ action: 'av19HlsExtracted', success: false, error: 'HLS 레벨 정보가 아직 로드되지 않았습니다.' }, '*');
          return;
        }
        
        const level = hls.levels[hls.currentLevel === -1 ? 0 : hls.currentLevel];
        if (!level || !level.details || !level.details.fragments) {
          window.postMessage({ action: 'av19HlsExtracted', success: false, error: 'HLS 파편 정보가 없습니다.' }, '*');
          return;
        }
        
        const fragments = level.details.fragments.map(frag => {
          let keyArray = null;
          let ivArray = null;
          if (frag.decryptdata && frag.decryptdata.key) {
            keyArray = Array.from(new Uint8Array(frag.decryptdata.key));
            if (frag.decryptdata.iv) {
              ivArray = Array.from(new Uint8Array(frag.decryptdata.iv));
            } else {
              // IV가 없는 경우 HLS 스펙에 따라 Sequence Number (sn)로 IV 생성
              let iv = new Uint8Array(16);
              let sn = frag.sn;
              if (typeof sn !== 'number') sn = parseInt(sn, 10) || 0;
              for (let i = 15; i >= 12; i--) {
                iv[i] = sn & 0xff;
                sn >>= 8;
              }
              ivArray = Array.from(iv);
            }
          }
          return {
            url: frag.url,
            key: keyArray,
            iv: ivArray
          };
        });
        
        window.postMessage({ action: 'av19HlsExtracted', success: true, fragments: fragments, title: event.data.title }, '*');
      } catch (e) {
        window.postMessage({ action: 'av19HlsExtracted', success: false, error: e.message }, '*');
      }
    }
  });
`;
document.documentElement.appendChild(script);
script.remove();

window.addEventListener('message', (event) => {
  if (event.data && event.data.action === 'av19HlsExtracted') {
    if (event.data.success) {
      chrome.runtime.sendMessage({
        action: 'startEncryptedHlsDownload',
        fragments: event.data.fragments,
        title: event.data.title || 'AV19 암호화 비디오'
      });
    } else {
      chrome.runtime.sendMessage({
        action: 'hlsDownloadProgress',
        progress: 0,
        statusText: '다운로드 실패',
        isError: true,
        errorMsg: event.data.error
      }).catch(() => {});
    }
  }
});

/**
 * 플레이어 DOM 내부를 파싱하여 진짜 미디어 스트리밍/MP4 주소 강제 추출
 */
function extractVideoUrlFromDOM() {
  // 1. video 태그 또는 source 태그 직접 탐색
  const videoEl = document.querySelector('video');
  if (videoEl) {
    if (videoEl.src && isValidMediaUrl(videoEl.src)) return makeAbsoluteUrl(videoEl.src);
    const sourceEl = videoEl.querySelector('source');
    if (sourceEl && sourceEl.src && isValidMediaUrl(sourceEl.src)) return makeAbsoluteUrl(sourceEl.src);
  }

  // 2. script 태그 내부 텍스트에서 mp4 또는 m3u8 주소 추출 (정규식 강제 파싱)
  const scripts = document.querySelectorAll('script');
  for (const script of scripts) {
    const content = script.textContent;
    if (content) {
      const match = content.match(/["'](https?:\/\/[^"'\s]+\.(?:mp4|m3u8)[^"'\s]*)["']/i) ||
                    content.match(/file\s*:\s*["']([^"'\s]+\.(?:mp4|m3u8)[^"'\s]*)["']/i);
      if (match && match[1]) {
        return makeAbsoluteUrl(match[1]);
      }
    }
  }
  return null;
}

/**
 * HLS (M3U8) 실시간 자동 분할 다운로드 및 바이너리 머지 처리기 (컨텐트 스크립트 전용 버전)
 */
async function downloadHlsStreamFromContent(m3u8Url, title) {
  // 실시간 진행률 팝업창 전달 헬퍼 함수
  function sendProgress(progress, statusText, isError = false, isComplete = false, errorMsg = '') {
    chrome.runtime.sendMessage({
      action: 'hlsDownloadProgress',
      progress,
      statusText,
      isError,
      isComplete,
      errorMsg
    }).catch(() => {
      // 팝업창이 이미 닫힌 경우 정상적인 에러이므로 무시
    });
  }

  // 백그라운드 다운로드 세션 상태 초기 등록
  chrome.runtime.sendMessage({
    action: 'registerDownloadSession',
    url: m3u8Url,
    title: title
  }).catch(() => {});

  try {
    sendProgress(0, 'M3U8 마스터 플레이리스트 파일 수집 중...');

    // [ReadyStream 전용 우회 기법] 플레이어 주소가 들어온 경우 HTML을 분석하여 실제 내부 M3U8 스트리밍 주소 강제 역추적!
    // 컨텐트 스크립트 내부에서의 fetch 차단(CORS/CSP)을 방지하기 위해 백그라운드로 안전하게 HTML 수집 위임 처리!
    if (m3u8Url.includes('hducc.handong.edu/em/') || m3u8Url.includes('/em/')) {
      sendProgress(5, 'ReadyStream 비디오 스트리밍 주소 역추적 중...');
      
      const fetchRes = await new Promise((resolve) => {
        chrome.runtime.sendMessage({
          action: 'fetchReadyStreamHtml',
          url: m3u8Url
        }, (res) => {
          resolve(res);
        });
      });

      if (!fetchRes || !fetchRes.success) {
        throw new Error(`ReadyStream 페이지 수집 실패: ${fetchRes ? fetchRes.error : '백그라운드 통신 오류'}`);
      }

      const pageHtml = fetchRes.html;

      // ReadyStream 플레이어 안의 진짜 미디어 주소(M3U8 또는 MP4) 추출 (정규식 검사)
      const mediaMatch = pageHtml.match(/["'](https?:\/\/[^"'\s]+\.(?:m3u8|mp4)[^"'\s]*)["']/i) || 
                         pageHtml.match(/file\s*:\s*["']([^"'\s]+\.(?:m3u8|mp4)[^"'\s]*)["']/i);
      
      if (mediaMatch && mediaMatch[1]) {
        const detectedUrl = mediaMatch[1];
        if (detectedUrl.toLowerCase().includes('.mp4')) {
          // MP4 파일이 검출된 경우 즉시 백그라운드 직접 다운로드 엔진 가동!
          sendProgress(30, 'ReadyStream 내 MP4 직접 다운로드 감지, 주소 전환 중...');
          chrome.runtime.sendMessage({
            action: 'triggerDirectDownload',
            url: detectedUrl,
            title: title
          });
          return;
        }
        m3u8Url = detectedUrl;
        sendProgress(10, '진짜 스트리밍 주소 감지 성공! 다운로드 버퍼 준비 중...');
      } else {
        throw new Error('ReadyStream 비디오 소스에서 동영상 파일(M3U8 또는 MP4) 경로를 추출하는 데 실패했습니다.');
      }
    }

    // 1. M3U8 메인 주소 파싱 (동일 출처 요청)
    const response = await fetch(m3u8Url, { credentials: 'include' });
    if (!response.ok) throw new Error(`M3U8 요청 실패 (${response.status})`);
    const text = await response.text();

    // M3U8 주소에서 베이스 URL 경로 추출
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
        if (line && !line.startsWith('#') && line.endsWith('.m3u8')) {
          let subUrl = line;
          if (!line.startsWith('http://') && !line.startsWith('https://')) {
            subUrl = baseUrl + line;
          }
          subPlaylists.push(subUrl);
        }
      }

      if (subPlaylists.length > 0) {
        sendProgress(12, '고화질 서브 스트리밍 리스트 감지, 주소 전환 중...');
        return downloadHlsStreamFromContent(subPlaylists[0], title);
      }
      throw new Error('M3U8 스트리밍 내에서 분할 비디오 조각(TS)을 찾지 못했습니다.');
    }

    // 1시간 이상 대용량 파일의 안정성(OOM 방지)과 외부 CDN(네이버 클라우드 등)의 CSP/CORS 완전 우회를 위해 
    // 모든 실제 다운로드 처리를 백그라운드로 위임! 백그라운드는 다운로드한 데이터를 스트리밍으로 content.js에 넘겨 디스크 캐싱을 유도함.
    // [v3.0] TS URL 목록을 직접 전달하여 백그라운드의 M3U8 재파싱을 완전히 제거! (403 원천 차단!)
    sendProgress(12, '보안 채널 통과, 백그라운드 다운로드 코어 엔진 가동 중...');
    
    chrome.runtime.sendMessage({
      action: 'startHlsBackgroundFetchWithTsUrls',
      tsUrls: tsUrls,
      m3u8Url: m3u8Url,
      title: title
    });

  } catch (err) {
    console.error("M3U8 파싱 실패:", err);
    sendProgress(0, '다운로드 준비 실패', true, false, err.message || err.toString());
  }
}

// =========================================================================
// [백그라운드 통신] 대용량 비디오 청크 Base64 스트리밍 수신 및 디스크 스풀링 모듈
// =========================================================================
let backgroundTsChunks = [];

function base64ToUint8Array(base64) {
  const binary_string = window.atob(base64);
  const len = binary_string.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary_string.charCodeAt(i);
  }
  return bytes;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'initBlobChunks') {
    backgroundTsChunks = new Array(message.total);
    sendResponse({ success: true });
  } 
  else if (message.action === 'storeBlobChunk') {
    const { index, base64Data } = message;
    const uint8Array = base64ToUint8Array(base64Data);
    // 메모리에 쌓이지 않고 브라우저 임시 스토리지(디스크)로 자동 스풀링되도록 즉시 Blob화!
    backgroundTsChunks[index] = new Blob([uint8Array]); 
    sendResponse({ success: true });
  } 
  else if (message.action === 'finalizeBlobDownload') {
    const { title, extension } = message;
    
    try {
      // 배열로 된 Blob들을 단일 파일 Blob으로 병합
      const finalBlob = new Blob(backgroundTsChunks, { type: extension === 'mp4' ? 'video/mp4' : 'video/mp2t' });
      const blobUrl = URL.createObjectURL(finalBlob);
      
      const strippedTitle = title.replace(/^\[(ReadyStream|DarkKnight)\]\s*/i, '');
      const safeTitle = strippedTitle.replace(/[\\/:*?"<>|]/g, '_');
      const cleanTitle = safeTitle.replace(/\.(mp4|ts|m3u8)$/i, '');
      const prefix = title.includes('ReadyStream') ? '[ReadyStream]' : '[DarkKnight]';
      const filename = `${prefix}_${cleanTitle}.${extension}`;

      const downloadAnchor = document.createElement('a');
      downloadAnchor.href = blobUrl;
      downloadAnchor.download = filename;
      document.body.appendChild(downloadAnchor);
      downloadAnchor.click();

      setTimeout(() => {
        document.body.removeChild(downloadAnchor);
        URL.revokeObjectURL(blobUrl);
        backgroundTsChunks = []; // 메모리 완전 해제
      }, 10000);
      
      sendResponse({ success: true });
    } catch (e) {
      console.error("최종 다운로드 처리 실패:", e);
      sendResponse({ success: false, error: e.message });
    }
  }
});

/**
 * 동일 출처(Same-Origin) 환경에서 스트리밍 방식으로 단일 MP4 파일을 직접 Fetch하여 바이너리 병합 다운로드
 */
async function downloadMp4FromContent(mp4Url, title) {
  function sendProgress(progress, statusText, isError = false, isComplete = false, errorMsg = '') {
    chrome.runtime.sendMessage({
      action: 'hlsDownloadProgress', progress, statusText, isError, isComplete, errorMsg
    }).catch(() => {});
  }

  try {
    sendProgress(12, '보안 채널 통과, MP4 백그라운드 다운로드 코어 엔진 가동 중...');
    chrome.runtime.sendMessage({
      action: 'startMp4BackgroundFetch',
      url: mp4Url,
      title: title
    });
  } catch (err) {
    console.error("MP4 다운로드 준비 실패:", err);
    sendProgress(0, '다운로드 실패', true, false, err.message || err.toString());
  }
}
