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

  // 2. <iframe> 요소 정밀 검사
  const iframes = document.querySelectorAll('iframe');
  iframes.forEach((iframe) => {
    const src = iframe.src || iframe.getAttribute('data-src');
    if (src) {
      const isReadyStream = src.includes('hducc.handong.edu/em/') || src.includes('hducc.handong.edu/index.php/vod/view_page/');
      const isYoutube = src.includes('youtube.com') || src.includes('youtu.be');
      const isVimeo = src.includes('vimeo.com');

      // 진짜 비디오 임베드인 경우만 필터링 통과
      if (isReadyStream || isYoutube || isVimeo || isValidMediaUrl(src)) {
        
        // [필터링 꿀팁] LMS 자체 껍데기 iframe (예: external_tools)은 사용자 혼란 방지를 위해 완전히 무시 처리!
        if (src.includes('lms.handong.edu') && src.includes('external_tools')) {
          return;
        }

        const isXVideo = src.includes('twitter.com') || src.includes('x.com');

        let typeLabel = '임베디드 비디오';
        if (isReadyStream) {
          typeLabel = 'ReadyStream 강의 비디오';
        } else if (isYoutube) {
          typeLabel = 'YouTube 비디오';
        } else if (isVimeo) {
          typeLabel = 'Vimeo 비디오';
        } else if (isXVideo) {
          typeLabel = 'X (트위터) 비디오';
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

  // 3. 백그라운드 서비스 워커로 전송
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

// 2. SPA 환경 대응 MutationObserver
let mutationTimeout;
const observer = new MutationObserver(() => {
  clearTimeout(mutationTimeout);
  mutationTimeout = setTimeout(() => {
    scanDOMForVideos();
  }, 1000);
});

observer.observe(document.body, {
  childList: true,
  subtree: true
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
      // MP4 직접 다운로드 실행 (백그라운드 위임하여 네이티브 다운로드!)
      chrome.runtime.sendMessage({
        action: 'triggerDirectDownload',
        url: targetUrl,
        title: message.title
      }, (response) => {
        sendResponse(response);
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
  } else if (message.action === 'executeBlobDownload') {
    const { arrayBuffer, title, extension } = message;
    try {
      const blob = new Blob([arrayBuffer], { type: extension === 'mp4' ? 'video/mp4' : 'video/mp2t' });
      const blobUrl = URL.createObjectURL(blob);
      
      const safeTitle = title.replace(/[\\/:*?"<>|]/g, '_');
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
  }
  return true;
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

    // 4. TS 파일 다운로드 가동 (5개 채널 동시 고속 다운로드)
    const total = tsUrls.length;
    const tsChunks = new Array(total);
    sendProgress(15, `비디오 조각 다운로드 대기 중... (총 ${total}개 파편)`);

    const concurrencyLimit = 5;
    for (let i = 0; i < tsUrls.length; i += concurrencyLimit) {
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
            
            // 다운로드 퍼센트 실시간 UI 반영
            const completed = tsChunks.filter(Boolean).length;
            const progressPct = Math.round((completed / total) * 83) + 15; // 15% ~ 98% 진행
            
            sendProgress(progressPct, `비디오 파편 수집 중: ${completed} / ${total} 개 완료`);
          });
      });

      await Promise.all(promises);
    }

    // 5. 바이너리 스트림 고속 병합
    sendProgress(98, '수집된 비디오 파편 고속 병합 중... 잠시만 기다려주세요.');
    
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
    sendProgress(99, '다운로드 완료 처리 및 로컬 저장 중...');
    
    chrome.runtime.sendMessage({
      action: 'triggerBlobDownload',
      arrayBuffer: mergedArray.buffer,
      title: title,
      extension: 'ts'
    });
    
    sendProgress(100, '다운로드 완료 및 무손실 파일 소장 완료!', false, true);

  } catch (err) {
    console.warn("HLS 동일 출처 다운로드 실패, 백그라운드 우회 다운로드로 전환합니다...", err);
    sendProgress(5, '보안 정책(CSP/CORS) 감지됨. 백그라운드 우회 다운로더 가동 중...');
    chrome.runtime.sendMessage({
      action: 'startHlsBackgroundFetch',
      url: m3u8Url,
      title: title
    });
  }
}

/**
 * 동일 출처(Same-Origin) 환경에서 스트리밍 방식으로 단일 MP4 파일을 직접 Fetch하여 바이너리 병합 다운로드
 */
async function downloadMp4FromContent(mp4Url, title) {
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
      // 팝업창이 닫힌 경우 무시
    });
  }

  try {
    sendProgress(5, '동영상 원본 데이터 연결 시도 중...');

    // 동일 출처(Same-Origin) 패치이므로 CORS 우회와 동시에 로그인 세션 쿠키가 온전히 동봉됩니다.
    const res = await fetch(mp4Url, { credentials: 'include' });
    if (!res.ok) throw new Error(`비디오 서버 연결 실패 (상태 코드: ${res.status})`);

    const reader = res.body.getReader();
    const contentLength = +res.headers.get('Content-Length') || 0;
    
    let receivedLength = 0;
    const chunks = [];
    sendProgress(10, '데이터 수집 채널 연결 성공. 스트림 다운로드 가동!');

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      chunks.push(value);
      receivedLength += value.length;

      const progressPct = contentLength ? Math.round((receivedLength / contentLength) * 88) + 10 : 50;
      const mbLoaded = (receivedLength / 1024 / 1024).toFixed(1);
      const totalMb = contentLength ? (contentLength / 1024 / 1024).toFixed(1) + 'MB' : '알 수 없음';
      
      sendProgress(progressPct, `비디오 다운로드 중: ${mbLoaded}MB / ${totalMb} 완료`);
    }

    sendProgress(98, '수집된 데이터를 무손실 파일로 저장 준비 중...');

    // chunks 배열(Uint8Array 조각들)을 하나로 병합
    const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
    const mergedArray = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      mergedArray.set(chunk, offset);
      offset += chunk.length;
    }

    chrome.runtime.sendMessage({
      action: 'triggerBlobDownload',
      arrayBuffer: mergedArray.buffer,
      title: title,
      extension: 'mp4'
    });

    sendProgress(100, '다운로드 완료 및 MP4 소장 완료!', false, true);

  } catch (err) {
    console.warn("MP4 동일 출처 다운로드 실패, 백그라운드 우회 다운로드로 전환합니다...", err);
    sendProgress(5, '보안 정책(CSP/CORS) 감지됨. 백그라운드 우회 다운로더 가동 중...');
    chrome.runtime.sendMessage({
      action: 'startBackgroundFetch',
      url: mp4Url,
      referer: window.location.href,
      title: title
    });
  }
}
