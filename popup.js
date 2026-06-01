/**
 * 다크나이트 - 팝업 제어 스크립트 (popup.js)
 * 
 * 주요 기능:
 * 1. 활성 탭의 도메인 및 타이틀 정보 수집 후 UI 출력.
 * 2. 백그라운드 서비스 워커에 감지된 미디어 목록 요청 및 실시간 리스트 동적 바인딩.
 * 3. 플레이어 프레임과 스트리밍 주소의 다운로드 단추 다각화 (사용자 혼란 완벽 방지).
 * 4. 백그라운드 갱신 알림을 수신하여 팝업이 켜진 상태에서도 화면 자동 업데이트.
 */

document.addEventListener('DOMContentLoaded', async () => {
  const pageTitleEl = document.getElementById('page-title');
  const domainBadgeEl = document.getElementById('domain-badge');
  const mediaListEl = document.getElementById('media-list');
  const mediaCountEl = document.getElementById('media-count');

  const overlay = document.getElementById('progress-overlay');
  const fill = document.getElementById('progress-bar-fill');
  const percent = document.getElementById('progress-percentage');
  const status = document.getElementById('progress-status');
  const closeBtn = document.getElementById('progress-close-btn');

  // 닫기 버튼 이벤트 바인딩
  closeBtn.addEventListener('click', () => {
    overlay.classList.add('hidden');
  });

  // HLS 다운로드 실시간 진행 상태 리스너 추가
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'hlsDownloadProgress') {
      const { progress, statusText, isError, isComplete, errorMsg } = message;

      if (isError) {
        const progressCard = document.querySelector('.progress-card');
        progressCard.classList.add('error');
        status.innerHTML = `<span style="font-weight: 700; color: #FF4444;">❌ 스트리밍 다운로드 에러:</span><br>${errorMsg || '알 수 없는 네트워크 오류가 발생했습니다.'}`;
        closeBtn.classList.remove('hidden');
        sendResponse({ success: true });
        return;
      }

      fill.style.width = `${progress}%`;
      percent.textContent = `${progress}%`;
      status.textContent = statusText || '수집 작업 진행 중...';

      if (isComplete) {
        setTimeout(() => {
          overlay.classList.add('hidden');
        }, 1500);
      }
      sendResponse({ success: true });
    }
    return true;
  });

  // 1. 활성 탭 정보 가져오기
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  
  if (activeTab) {
    // 도메인 추출 및 출력
    try {
      const urlObj = new URL(activeTab.url);
      domainBadgeEl.textContent = urlObj.hostname.replace('www.', '');
      pageTitleEl.textContent = activeTab.title || '활성 페이지';
    } catch (e) {
      domainBadgeEl.textContent = '웹 페이지';
      pageTitleEl.textContent = activeTab.title || '활성 페이지';
    }

    // 2. 초기 리스트 로딩 실행
    refreshMediaList();

    // 3. 백그라운드로부터 실시간 갱신 신호가 오면, 열려있는 팝업 화면 자동 갱신 (사용자가 수동으로 새로고침할 필요 전혀 없음!)
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.action === 'mediaListUpdated' && message.tabId === activeTab.id) {
        refreshMediaList();
        sendResponse({ success: true, message: '팝업 리스트 실시간 자동 갱신 완료' });
      }
      return true;
    });
  } else {
    pageTitleEl.textContent = '분석할 수 있는 활성화된 브라우저 창이 없습니다.';
  }

  /**
   * 백그라운드로부터 수집된 미디어 목록을 다시 읽어와 화면에 반영하는 함수
   */
  function refreshMediaList() {
    chrome.runtime.sendMessage({ 
      action: 'getMediaList', 
      tabId: activeTab.id 
    }, (response) => {
      if (response && response.mediaList) {
        renderMediaList(response.mediaList);
      }
    });
  }

  /**
   * 미디어 목록 동적 렌더링 함수
   */
  function renderMediaList(list) {
    if (!list || list.length === 0) {
      return;
    }

    // 리스트 초기화 및 카운트 반영
    mediaListEl.innerHTML = '';
    mediaCountEl.textContent = list.length.toString();

    // 시간 역순(최신 감지 순)으로 정렬
    const sortedList = [...list].sort((a, b) => b.timestamp - a.timestamp);

    sortedList.forEach((item, index) => {
      const card = document.createElement('div');
      card.className = 'media-item';

      // 미디어 타입에 따른 CSS 클래스 매핑
      let typeClass = 'mp4';
      const typeStr = item.type.toLowerCase();
      if (typeStr.includes('readystream')) typeClass = 'readystream';
      else if (typeStr.includes('youtube')) typeClass = 'youtube';
      else if (typeStr.includes('vimeo')) typeClass = 'vimeo';
      else if (typeStr.includes('twitter') || typeStr.includes('x (')) typeClass = 'twitter';
      else if (typeStr.includes('m3u8')) typeClass = 'm3u8';

      // DOM 소스 한글화 명칭 매핑
      const sourceKorean = item.source === 'network' ? '네트워크 스니퍼 감지' : '페이지 소스(DOM) 추출';

      // [핵심 업그레이드] 임베드 플레이어 껍데기(틀)는 직접 파일 다운로드가 불가능하므로,
      // "다운로드" 대신 "플레이어 열기" 버튼을 표기하여 사용자 혼란을 전면 방지!
      // 단, 한동대 ReadyStream 강의 비디오의 경우, 복사된 플레이어 주소를 통해 내부 스트리밍 데이터를 역추적하여 
      // 1클릭 다이렉트 다운로드를 보조 실행할 수 있도록 특별 다운로드 버튼을 함께 노출합니다!
      const isEmbedPlayer = ['readystream', 'youtube', 'vimeo'].includes(typeClass);

      let actionButtons = '';
      if (typeClass === 'readystream') {
        // 한동대 ReadyStream 전용 버튼셋: 플레이어 열기 + 1클릭 결합 다운로드 + 주소 복사
        actionButtons = `
          <button class="btn btn-primary download-btn" data-url="${item.url}" data-type="M3U8" data-frame-id="${item.frameId || ''}">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="margin-right: 4px;">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>
            </svg>
            1클릭 다운로드
          </button>
          <button class="btn btn-secondary open-player-btn" data-url="${item.url}">
            플레이어 열기
          </button>
          <button class="btn btn-secondary copy-btn" data-url="${item.url}">
            주소 복사
          </button>
        `;
      } else if (isEmbedPlayer) {
        actionButtons = `
          <button class="btn btn-primary open-player-btn" data-url="${item.url}">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="margin-right: 4px;">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/>
            </svg>
            플레이어 단독 열기
          </button>
          <button class="btn btn-secondary copy-btn" data-url="${item.url}">
            주소 복사
          </button>
        `;
      } else {
        actionButtons = `
          <button class="btn btn-primary download-btn" data-url="${item.url}" data-type="${item.type}" data-frame-id="${item.frameId || ''}">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="margin-right: 4px;">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>
            </svg>
            다운로드
          </button>
          <button class="btn btn-secondary copy-btn" data-url="${item.url}">
            주소 복사
          </button>
        `;
      }

      card.innerHTML = `
        <div class="media-info">
          <div class="media-title-row">
            <div class="media-title" title="${item.title}">${item.title}</div>
          </div>
          <div class="badge-group">
            <span class="media-type-badge ${typeClass}">${item.type}</span>
            <span class="media-source-badge">${sourceKorean}</span>
          </div>
        </div>
        <div class="media-action-row" style="flex-wrap: wrap;">
          ${actionButtons}
        </div>
      `;

      mediaListEl.appendChild(card);
    });

    // 이벤트 리스너 바인딩
    bindActionEvents();
  }

  /**
   * 다운로드, 주소 복사 및 플레이어 열기 버튼 클릭 이벤트 바인딩
   */
  function bindActionEvents() {
    // 1. 다운로드 처리 (MP4는 즉시 다운로드, M3U8은 고성능 청크 분할 병합 다운로드 실행!)
    document.querySelectorAll('.download-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const url = btn.getAttribute('data-url');
        const type = btn.getAttribute('data-type');
        const card = btn.closest('.media-item');
        const title = card.querySelector('.media-title').textContent;
        const frameIdStr = btn.getAttribute('data-frame-id');
        const frameId = (frameIdStr !== null && frameIdStr !== '') ? parseInt(frameIdStr, 10) : null;
        const progressCard = document.querySelector('.progress-card');

        if (type.includes('M3U8') || type.includes('m3u8') || url.includes('.m3u8') || url.includes('hducc.handong.edu') || url.includes('/em/')) {
          // 다크나이트 1클릭 자동 다운로더 가동!
          
          if (url.includes('/em/') || url.includes('hducc.handong.edu')) {
            // [스마트 네트워크 매핑 기술]
            // 백그라운드에 수집된 미디어 목록을 다시 조회하여, 동일 탭에서 스니퍼가 감지한 실제 MP4/M3U8 동영상 주소를 우선 연결합니다!
            chrome.runtime.sendMessage({ action: 'getMediaList', tabId: activeTab.id }, (response) => {
              const list = response ? response.mediaList : [];
              
              // preloader나 광고가 아닌 진짜 동영상 주소 필터링
              const realMedia = list.find(item => 
                (item.type.includes('MP4') || item.type.includes('M3U8') || item.url.includes('.mp4') || item.url.includes('.m3u8')) &&
                !item.url.toLowerCase().includes('preloader') &&
                !item.url.toLowerCase().includes('loader')
              );

              const targetUrl = realMedia ? realMedia.url : url;
              console.log("최종 우회 다운로드 대상 주소:", targetUrl);

              // HTTPS 강제 전환으로 Mixed Content 차단 완벽 예방!
              let secureTargetUrl = targetUrl;
              if (secureTargetUrl.startsWith('http://')) {
                secureTargetUrl = secureTargetUrl.replace('http://', 'https://');
              }

              // [초강력 프레임 위임 방식]
              // CSP와 SameSite 제한을 자연스럽게 우회하기 위해, hducc.handong.edu 도메인에서 구동되는 content.js에 다운로드 작업을 전격 위임합니다!
              let targetFrameId = frameId;
              if (targetFrameId === null || targetFrameId === undefined || targetFrameId === 0) {
                const matchingItem = list.find(item => 
                  item.frameId !== null && 
                  item.frameId !== undefined && 
                  item.frameId !== 0 && 
                  (item.url.includes('hducc.handong.edu') || item.type.toLowerCase().includes('readystream'))
                );
                if (matchingItem) {
                  targetFrameId = matchingItem.frameId;
                }
              }

              console.log("최종 다운로드 위임 대상 frameId:", targetFrameId);

              // UI 모달 표출
              overlay.classList.remove('hidden');
              progressCard.classList.remove('error');
              closeBtn.classList.add('hidden');
              fill.style.width = '0%';
              percent.textContent = '0%';
              status.textContent = '다운로드 요청을 플레이어 프레임에 전달 중...';

              chrome.tabs.sendMessage(activeTab.id, {
                action: 'startHlsDownload',
                url: secureTargetUrl,
                title: title
              }, { frameId: targetFrameId }, (res) => {
                if (chrome.runtime.lastError) {
                  console.warn("아이프레임 전송 실패, 메인 프레임으로 폴백 전송 시도:", chrome.runtime.lastError);
                  // 메인 프레임으로 폴백 전송 (예: 플레이어 새 창으로 연 경우)
                  chrome.tabs.sendMessage(activeTab.id, {
                    action: 'startHlsDownload',
                    url: secureTargetUrl,
                    title: title
                  }, { frameId: 0 }, (fallbackRes) => {
                    if (chrome.runtime.lastError) {
                      console.error("메인 프레임 전송 실패:", chrome.runtime.lastError);
                      // 최후의 수단으로 팝업에서 직접 실행
                      if (secureTargetUrl.toLowerCase().includes('.mp4')) {
                        downloadMp4FromPopup(secureTargetUrl, title);
                      } else {
                        downloadHlsStream(secureTargetUrl, title);
                      }
                    }
                  });
                }
              });
            });
          } else {
            downloadHlsStream(url, title);
          }
        } else {
          // 일반 MP4 등 원본 다운로드 실행
          if (url.includes('hducc.handong.edu')) {
            chrome.runtime.sendMessage({ action: 'getMediaList', tabId: activeTab.id }, (response) => {
              const list = response ? response.mediaList : [];
              
              let targetFrameId = frameId;
              if (targetFrameId === null || targetFrameId === undefined || targetFrameId === 0) {
                const matchingItem = list.find(item => 
                  item.frameId !== null && 
                  item.frameId !== undefined && 
                  item.frameId !== 0 && 
                  (item.url.includes('hducc.handong.edu') || item.type.toLowerCase().includes('readystream'))
                );
                if (matchingItem) {
                  targetFrameId = matchingItem.frameId;
                }
              }

              // UI 모달 표출
              overlay.classList.remove('hidden');
              progressCard.classList.remove('error');
              closeBtn.classList.add('hidden');
              fill.style.width = '0%';
              percent.textContent = '0%';
              status.textContent = '다운로드 요청을 플레이어 프레임에 전달 중...';

              let secureUrl = url;
              if (secureUrl.startsWith('http://')) {
                secureUrl = secureUrl.replace('http://', 'https://');
              }

              chrome.tabs.sendMessage(activeTab.id, {
                action: 'startHlsDownload',
                url: secureUrl,
                title: title
              }, { frameId: targetFrameId }, (res) => {
                if (chrome.runtime.lastError) {
                  chrome.tabs.sendMessage(activeTab.id, {
                    action: 'startHlsDownload',
                    url: secureUrl,
                    title: title
                  }, { frameId: 0 }, (fallbackRes) => {
                    if (chrome.runtime.lastError) {
                      downloadMp4FromPopup(secureUrl, title);
                    }
                  });
                }
              });
            });
          } else {
            chrome.downloads.download({
              url: url,
              saveAs: true
            }, (downloadId) => {
              if (chrome.runtime.lastError) {
                console.error("다운로드 에러:", chrome.runtime.lastError);
                alert("다운로드 실행 도중 오류가 발생했습니다. '주소 복사' 후 외부 다운로더를 활용해 주세요.");
              }
            });
          }
        }
      });
    });

    // 2. 플레이어 단독 열기 처리 (새 탭에서 로딩)
    document.querySelectorAll('.open-player-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const url = btn.getAttribute('data-url');
        chrome.tabs.create({ url: url });
      });
    });

    // 3. 주소 복사 처리 및 토스트 피드백 효과
    document.querySelectorAll('.copy-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const url = btn.getAttribute('data-url');
        
        try {
          await navigator.clipboard.writeText(url);
          
          const originalHTML = btn.innerHTML;
          btn.innerHTML = `
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#FFB800" stroke-width="3" style="margin-right: 4px;">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
            <span style="color: #FFB800;">복사 완료!</span>
          `;
          btn.style.borderColor = "#FFB800";
          
          setTimeout(() => {
            btn.innerHTML = originalHTML;
            btn.style.borderColor = "";
          }, 1500);
          
        } catch (err) {
          console.error("클립보드 복사 실패:", err);
          alert("주소 복사에 실패했습니다. 수동으로 주소를 복사해 주세요.");
        }
      });
    });
  }

  /**
   * HLS (M3U8) 실시간 자동 분할 다운로드 및 바이너리 머지 처리기 (1클릭 소장 실현!)
   */
  async function downloadHlsStream(m3u8Url, title) {
    const overlay = document.getElementById('progress-overlay');
    const fill = document.getElementById('progress-bar-fill');
    const percent = document.getElementById('progress-percentage');
    const status = document.getElementById('progress-status');

    // UI 모달 표출
    overlay.classList.remove('hidden');
    const progressCard = document.querySelector('.progress-card');
    progressCard.classList.remove('error');
    closeBtn.classList.add('hidden');
    fill.style.width = '0%';
    percent.textContent = '0%';
    status.textContent = 'M3U8 마스터 플레이리스트 파일 수집 중...';

    try {
      // [ReadyStream 전용 우회 기법] 플레이어 주소가 들어온 경우 HTML을 분석하여 실제 내부 M3U8 스트리밍 주소 강제 역추적!
      // 교내 인증을 통과하기 위해 credentials: 'include' 옵션을 사용하여 로그인 세션 쿠키를 반드시 실어 보냅니다!
      if (m3u8Url.includes('hducc.handong.edu/em/') || m3u8Url.includes('/em/')) {
        status.textContent = 'ReadyStream 비디오 스트리밍 주소 역추적 중...';
        const pageRes = await fetch(m3u8Url, { credentials: 'include' });
        if (!pageRes.ok) throw new Error(`ReadyStream 페이지 읽기 실패 (${pageRes.status})`);
        const pageHtml = await pageRes.text();

        // ReadyStream 플레이어 안의 master.m3u8 주소 추출 (정규식 검사)
        const m3u8Match = pageHtml.match(/["'](https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)["']/i) || 
                          pageHtml.match(/file\s*:\s*["']([^"'\s]+\.m3u8[^"'\s]*)["']/i);
        
        if (m3u8Match && m3u8Match[1]) {
          m3u8Url = m3u8Match[1];
          status.textContent = '진짜 스트리밍 주소 감지 성공! 다운로드 버퍼 준비 중...';
        } else {
          throw new Error('ReadyStream 비디오 소스에서 스트리밍 파일(.m3u8) 경로를 추출하는 데 실패했습니다.');
        }
      }

      // 1. M3U8 메인 주소 파싱 (세션 유지를 위해 credentials: 'include' 필수 적용)
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

      // 3. 다중 화질 마스터 플레이리스트 대응 (서브 M3U8이 있는 경우 첫 번째 고화질 파일 파싱)
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
          status.textContent = '고화질 서브 스트리밍 리스트 감지, 주소 전환 중...';
          return downloadHlsStream(subPlaylists[0], title);
        }

        throw new Error('M3U8 스트리밍 내에서 분할 비디오 조각(TS)을 찾지 못했습니다.');
      }

      // 4. TS 파일 다운로드 가동 (5개 채널 동시 고속 다운로드 구현)
      const total = tsUrls.length;
      const tsChunks = new Array(total);
      status.textContent = `비디오 조각 다운로드 대기 중... (총 ${total}개 파편)`;

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
              const progressPct = Math.round((completed / total) * 100);
              
              fill.style.width = `${progressPct}%`;
              percent.textContent = `${progressPct}%`;
              status.textContent = `비디오 파편 수집 중: ${completed} / ${total} 개 완료`;
            });
        });

        await Promise.all(promises);
      }

      // 5. 바이너리 스트림 고속 병합
      status.textContent = '수집된 비디오 파편 고속 병합 중... 잠시만 기다려주세요.';
      
      const totalLength = tsChunks.reduce((acc, chunk) => acc + (chunk ? chunk.length : 0), 0);
      const mergedArray = new Uint8Array(totalLength);
      let offset = 0;
      
      for (const chunk of tsChunks) {
        if (chunk) {
          mergedArray.set(chunk, offset);
          offset += chunk.length;
        }
      }

      // 6. 브라우저 최종 파일 다운로드 트리거 (.ts 포맷으로 무손실 원본 저장)
      // [신뢰성 향상 기법]: 크롬 확장 프로그램 백샌드박스 정책 우회를 위해,
      // 가상 앵커(a) 태그 클릭을 사용하여 브라우저 네이티브 파일 다운로드를 확실하게 실행시킵니다.
      status.textContent = '다운로드 완료 처리 및 로컬 저장 중...';
      
      const videoBlob = new Blob([mergedArray], { type: 'video/mp2t' });
      const blobUrl = URL.createObjectURL(videoBlob);
      
      const safeTitle = title.replace(/[\\/:*?"<>|]/g, '_');
      const filename = `[ReadyStream]_${safeTitle}.ts`;

      const downloadAnchor = document.createElement('a');
      downloadAnchor.href = blobUrl;
      downloadAnchor.download = filename;
      document.body.appendChild(downloadAnchor);
      downloadAnchor.click();
      
      // 다운로드 트리거 완료 후 뒤처리
      setTimeout(() => {
        document.body.removeChild(downloadAnchor);
        URL.revokeObjectURL(blobUrl);
      }, 10000);
      
      overlay.classList.add('hidden');

    } catch (err) {
      console.error(err);
      const errMsg = err.stack || err.message || err || '알 수 없는 네트워크 오류가 발생했습니다.';
      
      const progressCard = document.querySelector('.progress-card');
      progressCard.classList.add('error');
      status.innerHTML = `<span style="font-weight: 700; color: #FF4444;">❌ 스트리밍 다운로드 에러:</span><br>${errMsg}`;
      closeBtn.classList.remove('hidden');
    }
  }

  /**
   * 동일 출처(Same-Origin) 환경에서 스트리밍 방식으로 단일 MP4 파일을 직접 Fetch하여 바이너리 병합 다운로드 (팝업 특권 버전)
   */
  async function downloadMp4FromPopup(mp4Url, title) {
    // UI 모달 표출
    overlay.classList.remove('hidden');
    const progressCard = document.querySelector('.progress-card');
    progressCard.classList.remove('error');
    closeBtn.classList.add('hidden');
    fill.style.width = '0%';
    percent.textContent = '0%';
    status.textContent = '동영상 원본 데이터 연결 시도 중...';

    try {
      // DNR 룰에 의해 쿠키 및 Referer/Origin이 완벽하게 세팅되어 통과합니다.
      const res = await fetch(mp4Url, { credentials: 'include' });
      if (!res.ok) throw new Error(`비디오 서버 연결 실패 (상태 코드: ${res.status})`);

      const reader = res.body.getReader();
      const contentLength = +res.headers.get('Content-Length') || 0;
      
      let receivedLength = 0;
      const chunks = [];
      status.textContent = '데이터 수집 채널 연결 성공. 스트림 다운로드 가동!';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        chunks.push(value);
        receivedLength += value.length;

        const progressPct = contentLength ? Math.round((receivedLength / contentLength) * 88) + 10 : 50;
        const mbLoaded = (receivedLength / 1024 / 1024).toFixed(1);
        const totalMb = contentLength ? (contentLength / 1024 / 1024).toFixed(1) + 'MB' : '알 수 없음';
        
        fill.style.width = `${progressPct}%`;
        percent.textContent = `${progressPct}%`;
        status.textContent = `비디오 다운로드 중: ${mbLoaded}MB / ${totalMb} 완료`;
      }

      status.textContent = '수집된 데이터를 무손실 파일로 저장 준비 중...';

      const videoBlob = new Blob(chunks, { type: 'video/mp4' });
      const blobUrl = URL.createObjectURL(videoBlob);
      
      const safeTitle = title.replace(/[\\/:*?"<>|]/g, '_');
      const filename = `[ReadyStream]_${safeTitle}.mp4`;

      const downloadAnchor = document.createElement('a');
      downloadAnchor.href = blobUrl;
      downloadAnchor.download = filename;
      document.body.appendChild(downloadAnchor);
      downloadAnchor.click();

      setTimeout(() => {
        document.body.removeChild(downloadAnchor);
        URL.revokeObjectURL(blobUrl);
      }, 10000);

      fill.style.width = '100%';
      percent.textContent = '100%';
      status.textContent = '다운로드 완료 및 MP4 소장 완료!';
      
      setTimeout(() => {
        overlay.classList.add('hidden');
      }, 1500);

    } catch (err) {
      console.error("MP4 스트림 다운로드 오류:", err);
      
      progressCard.classList.add('error');
      status.innerHTML = `<span style="font-weight: 700; color: #FF4444;">❌ 스트리밍 다운로드 에러:</span><br>${err.stack || err.message || err.toString()}`;
      closeBtn.classList.remove('hidden');
    }
  }
});
