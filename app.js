document.addEventListener("DOMContentLoaded", () => {
  const el = {
    headerTierBadge: document.getElementById("headerTierBadge"),
    statusBadge: document.getElementById("statusBadge"),
    toggleSettingsBtn: document.getElementById("toggleSettingsBtn"),
    settingsPanel: document.getElementById("settingsPanel"),
    selectFreeTierBtn: document.getElementById("selectFreeTierBtn"),
    selectPaidTierBtn: document.getElementById("selectPaidTierBtn"),
    freeApiKeyInput: document.getElementById("freeApiKeyInput"),
    paidApiKeyInput: document.getElementById("paidApiKeyInput"),
    freeKeyFileInput: document.getElementById("freeKeyFileInput"),
    paidKeyFileInput: document.getElementById("paidKeyFileInput"),
    keyStatusMsg: document.getElementById("keyStatusMsg"),
    modelSelect: document.getElementById("modelSelect"),
    summaryModelSelect: document.getElementById("summaryModelSelect"),
    partnerLangSelect: document.getElementById("partnerLangSelect"),
    autoModeSelect: document.getElementById("autoModeSelect"),
    chunkIntervalSelect: document.getElementById("chunkIntervalSelect"),
    ttsRateSelect: document.getElementById("ttsRateSelect"),
    duplexModeSelect: document.getElementById("duplexModeSelect"),
    toneSelect: document.getElementById("toneSelect"),
    glossaryInput: document.getElementById("glossaryInput"),
    quickLangBtns: document.querySelectorAll(".quick-lang-btn"),
    dirLockBtns: document.querySelectorAll(".dir-lock-btn"),
    btnLockToKo: document.getElementById("btnLockToKo"),
    btnLockFromKo: document.getElementById("btnLockFromKo"),
    sessionTimerBadge: document.getElementById("sessionTimerBadge"),
    soundTestBtn: document.getElementById("soundTestBtn"),
    summarizeBtn: document.getElementById("summarizeBtn"),
    shareLogBtn: document.getElementById("shareLogBtn"),
    copyLogBtn: document.getElementById("copyLogBtn"),
    downloadTxtBtn: document.getElementById("downloadTxtBtn"),
    origLangLabel: document.getElementById("origLangLabel"),
    ch1StateText: document.getElementById("ch1StateText"),
    ch2StateText: document.getElementById("ch2StateText"),
    liveOriginalStream: document.getElementById("liveOriginalStream"),
    liveTranslatedStream: document.getElementById("liveTranslatedStream"),
    transcriptBox: document.getElementById("transcriptBox"),
    volumeFill: document.getElementById("volumeFill"),
    micStateLabel: document.getElementById("micStateLabel"),
    manualTextInput: document.getElementById("manualTextInput"),
    sendTextBtn: document.getElementById("sendTextBtn"),
    mainActionBtn: document.getElementById("mainActionBtn"),
    sysAudioBtn: document.getElementById("sysAudioBtn"),
    clearBtn: document.getElementById("clearBtn")
  };

  let activeTier = "free";
  let committedOrigHistory = "";
  let livePreviewCard = null;
  let cardMap = new Map();
  let timerInterval = null;
  let elapsedSec = 1;
  let wakeLock = null;

  function renderOriginalMonitor(liveTypingText) {
    el.liveOriginalStream.innerHTML = "";
    if (committedOrigHistory) {
      const histSpan = document.createElement("span");
      histSpan.textContent = committedOrigHistory + (liveTypingText ? " " : "");
      el.liveOriginalStream.appendChild(histSpan);
    }
    if (liveTypingText) {
      const activeSpan = document.createElement("span");
      activeSpan.className = "live-active-span";
      activeSpan.textContent = liveTypingText;
      el.liveOriginalStream.appendChild(activeSpan);
    }
    el.liveOriginalStream.scrollTop = el.liveOriginalStream.scrollHeight;
  }

  function updateLivePreviewBubble(liveTypingText) {
    if (!liveTypingText) {
      if (livePreviewCard && livePreviewCard.parentNode) {
        livePreviewCard.parentNode.removeChild(livePreviewCard);
      }
      livePreviewCard = null;
      return;
    }
    if (!livePreviewCard) {
      livePreviewCard = document.createElement("div");
      livePreviewCard.className = "bubble live-typing";
      livePreviewCard.innerHTML = `<div class="bubble-header"><span class="bubble-label">실시간 음성 받아쓰기 중...</span></div><div class="live-typing-body"></div>`;
    }
    livePreviewCard.querySelector(".live-typing-body").textContent = liveTypingText;
    el.transcriptBox.appendChild(livePreviewCard);
    el.transcriptBox.scrollTop = el.transcriptBox.scrollHeight;
  }

  const engine = new window.GeminiInterpreterEngine({
    getConfig: () => ({
      apiKey: activeTier === "paid" ? el.paidApiKeyInput.value.trim() : el.freeApiKeyInput.value.trim(),
      modelId: el.modelSelect.value,
      summaryModelId: el.summaryModelSelect.value,
      partnerLang: el.partnerLangSelect.value,
      autoMode: el.autoModeSelect.value,
      chunkLen: el.chunkIntervalSelect.value,
      chunkMs: el.chunkIntervalSelect.value,
      ttsRate: el.ttsRateSelect.value,
      duplexMode: el.duplexModeSelect.value,
      tone: el.toneSelect.value,
      glossary: el.glossaryInput.value.trim()
    }),
    onVolume: (level) => {
      el.volumeFill.style.width = level + "%";
    },
    onChannelState: (s1, s2) => {
      if (s1) el.ch1StateText.textContent = s1;
      if (s2) el.ch2StateText.textContent = s2;
    },
    onLiveTyping: (liveText) => {
      renderOriginalMonitor(liveText);
      updateLivePreviewBubble(liveText);
    },
    onOrigClauseLocked: (seq, origText) => {
      committedOrigHistory = committedOrigHistory ? (committedOrigHistory + " " + origText) : origText;
      renderOriginalMonitor(engine.lastLiveUnconsumed || "");
      createOrUpdateChunkCard(seq, origText, "통역 생성 중...");
    },
    onSpeakingChange: (speaking) => {
      if (speaking) {
        el.ch2StateText.textContent = "음성 송출 중";
        setStatus("음성 송출 중", "speaking");
      } else {
        el.ch2StateText.textContent = "대기";
        if (engine.isRunning) setStatus("동시통역 중", "connected");
      }
      updateMicVisual(speaking);
    },
    onChunkCommitted: (seq, orig, trans, preLockedOrig) => {
      if (!preLockedOrig && orig) {
        committedOrigHistory = committedOrigHistory ? (committedOrigHistory + " " + orig) : orig;
        renderOriginalMonitor("");
      }
      if (trans) {
        el.liveTranslatedStream.textContent += (el.liveTranslatedStream.textContent ? " " : "") + trans;
        el.liveTranslatedStream.scrollTop = el.liveTranslatedStream.scrollHeight;
      }
      createOrUpdateChunkCard(seq, orig, trans || "(통역 생략)");
      if (engine.isRunning && !engine.isSpeaking) setStatus("동시통역 중", "connected");
    },
    onNoMicFallback: () => {
      updateMicVisual(false);
      el.ch1StateText.textContent = "마이크 없음 (텍스트/탭소리)";
    },
    onError: (msg) => {
      setStatus("오류 확인", "error");
      el.ch2StateText.textContent = msg.slice(0, 32);
    }
  });

  function nowTimeStr() {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
  }

  function getFileTimestamp() {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    return `${yyyy}${mo}${dd}_${hh}${mm}${ss}`;
  }

  function createOrUpdateChunkCard(seq, orig, trans) {
    let card = cardMap.get(seq);
    if (!card) {
      card = document.createElement("div");
      card.className = "bubble chunk-pair";
      card.innerHTML = `<div class="bubble-header"><span class="bubble-label">#${seq}</span><span class="bubble-time">${nowTimeStr()}</span></div><div class="chunk-orig-line"></div><div class="chunk-trans-line"></div>`;
      cardMap.set(seq, card);
      if (livePreviewCard && livePreviewCard.parentNode === el.transcriptBox) {
        el.transcriptBox.insertBefore(card, livePreviewCard);
      } else {
        el.transcriptBox.appendChild(card);
      }
    }
    if (orig) card.querySelector(".chunk-orig-line").textContent = orig;
    if (trans) card.querySelector(".chunk-trans-line").textContent = trans;
    el.transcriptBox.scrollTop = el.transcriptBox.scrollHeight;
  }

  function updateHeaderLangLabels() {
    const code = el.partnerLangSelect.value;
    const pName = window.INTERPRETER_LANGS[code].ko;
    if (el.btnLockToKo) el.btnLockToKo.textContent = `${pName} → 한국어 고정`;
    if (el.btnLockFromKo) el.btnLockFromKo.textContent = `한국어 → ${pName} 고정`;

    if (el.origLangLabel) {
      const mode = el.autoModeSelect.value;
      if (mode === "to_ko_only") {
        el.origLangLabel.textContent = `실시간 원문 연속 타이핑 (${pName} 음성 인식)`;
      } else if (mode === "from_ko_only") {
        el.origLangLabel.textContent = "실시간 원문 연속 타이핑 (한국어 음성 인식)";
      } else {
        el.origLangLabel.textContent = `실시간 원문 기록 (한국어·${pName} 자동 감지)`;
      }
    }
  }

  function syncQuickLangUI(code) {
    el.quickLangBtns.forEach((b) => b.classList.toggle("active", b.dataset.lang === code));
    updateHeaderLangLabels();
  }

  function syncDirectionLockUI() {
    const mode = el.autoModeSelect.value;
    el.dirLockBtns.forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
    updateHeaderLangLabels();
  }

  function setStatus(text, cls) {
    el.statusBadge.textContent = text;
    el.statusBadge.className = "status-badge" + (cls ? " " + cls : "");
  }

  function updateMicVisual(speaking) {
    el.volumeFill.classList.remove("muted", "no-mic");
    el.micStateLabel.classList.remove("muted", "no-mic");
    if (!engine.isRunning) {
      el.volumeFill.style.width = "0%";
      el.micStateLabel.textContent = "대기";
      return;
    }
    if (engine.driverMode === "text_only") {
      el.volumeFill.classList.add("no-mic");
      el.micStateLabel.classList.add("no-mic");
      el.micStateLabel.textContent = "텍스트 전용";
      return;
    }
    if (speaking && (el.duplexModeSelect.value === "smart_guard" || el.duplexModeSelect.value === "speaker_mute")) {
      el.volumeFill.classList.add("muted");
      el.micStateLabel.classList.add("muted");
      el.micStateLabel.textContent = "에코 방지 중";
    } else {
      el.micStateLabel.textContent = engine.driverMode === "system_audio" ? "탭 소리 연속수신" : "연속 받아쓰기 활성";
    }
  }

  function loadSettings() {
    const legacy = localStorage.getItem("gemini_rt_api_key") || "";
    el.freeApiKeyInput.value = localStorage.getItem("gemini_rt_free_key") || legacy;
    el.paidApiKeyInput.value = localStorage.getItem("gemini_rt_paid_key") || "";
    activeTier = localStorage.getItem("gemini_rt_active_tier") === "paid" ? "paid" : "free";

    const map = [
      ["gemini_rt_model_v7", el.modelSelect],
      ["gemini_rt_sum_model_v7", el.summaryModelSelect],
      ["gemini_rt_partner_lang", el.partnerLangSelect],
      ["gemini_rt_auto_mode_v7", el.autoModeSelect],
      ["gemini_rt_chunk_len_v7", el.chunkIntervalSelect],
      ["gemini_rt_tts_rate", el.ttsRateSelect],
      ["gemini_rt_duplex_mode_v7", el.duplexModeSelect],
      ["gemini_rt_tone", el.toneSelect],
      ["gemini_rt_glossary", el.glossaryInput]
    ];
    map.forEach(([k, node]) => {
      const val = localStorage.getItem(k);
      if (val && node) node.value = val;
    });

    if (el.freeApiKeyInput.value.trim() || el.paidApiKeyInput.value.trim()) {
      el.settingsPanel.classList.add("hidden");
    }
    updateTierUI();
    syncQuickLangUI(el.partnerLangSelect.value);
    syncDirectionLockUI();
  }

  function saveSettings() {
    localStorage.setItem("gemini_rt_free_key", el.freeApiKeyInput.value.trim());
    localStorage.setItem("gemini_rt_paid_key", el.paidApiKeyInput.value.trim());
    localStorage.setItem("gemini_rt_active_tier", activeTier);
    localStorage.setItem("gemini_rt_model_v7", el.modelSelect.value);
    localStorage.setItem("gemini_rt_sum_model_v7", el.summaryModelSelect.value);
    localStorage.setItem("gemini_rt_partner_lang", el.partnerLangSelect.value);
    localStorage.setItem("gemini_rt_auto_mode_v7", el.autoModeSelect.value);
    localStorage.setItem("gemini_rt_chunk_len_v7", el.chunkIntervalSelect.value);
    localStorage.setItem("gemini_rt_tts_rate", el.ttsRateSelect.value);
    localStorage.setItem("gemini_rt_duplex_mode_v7", el.duplexModeSelect.value);
    localStorage.setItem("gemini_rt_tone", el.toneSelect.value);
    localStorage.setItem("gemini_rt_glossary", el.glossaryInput.value.trim());
  }

  function updateTierUI() {
    if (activeTier === "free") {
      el.selectFreeTierBtn.classList.add("active-free");
      el.selectPaidTierBtn.classList.remove("active-paid");
      el.headerTierBadge.textContent = "무료 키";
      el.headerTierBadge.classList.remove("paid");
      el.keyStatusMsg.style.color = "#60a5fa";
      el.keyStatusMsg.textContent = el.freeApiKeyInput.value.trim() ? "일상용 무료 키 선택됨" : "무료 키를 입력해 주세요.";
    } else {
      el.selectPaidTierBtn.classList.add("active-paid");
      el.selectFreeTierBtn.classList.remove("active-free");
      el.headerTierBadge.textContent = "유료 키";
      el.headerTierBadge.classList.add("paid");
      el.keyStatusMsg.style.color = "#fbbf24";
      el.keyStatusMsg.textContent = el.paidApiKeyInput.value.trim() ? "미팅·학술 유료 키 선택됨 (카본 사용 가능)" : "유료 키를 입력해 주세요.";
    }
  }

  function bindFileLoader(fileEl, inputEl, tier) {
    fileEl.addEventListener("change", (ev) => {
      const f = ev.target.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = (e) => {
        const raw = (e.target.result || "").trim();
        const match = raw.match(/AIza[0-9A-Za-z\-_]{30,}/);
        const key = match ? match[0] : raw.split(/\r?\n/)[0].trim();
        if (key) {
          inputEl.value = key;
          activeTier = tier;
          saveSettings();
          updateTierUI();
        }
      };
      reader.readAsText(f, "UTF-8");
    });
  }

  bindFileLoader(el.freeKeyFileInput, el.freeApiKeyInput, "free");
  bindFileLoader(el.paidKeyFileInput, el.paidApiKeyInput, "paid");

  document.querySelectorAll(".btn-key-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const t = document.getElementById(btn.dataset.target);
      t.type = t.type === "password" ? "text" : "password";
      btn.textContent = t.type === "password" ? "표시" : "숨김";
    });
  });

  document.querySelectorAll(".btn-file-load").forEach((btn) => {
    btn.addEventListener("click", () => {
      const f = document.getElementById(btn.dataset.fileTarget);
      f.value = "";
      f.click();
    });
  });

  el.selectFreeTierBtn.addEventListener("click", () => { activeTier = "free"; saveSettings(); updateTierUI(); });
  el.selectPaidTierBtn.addEventListener("click", () => { activeTier = "paid"; saveSettings(); updateTierUI(); });
  el.headerTierBadge.addEventListener("click", () => el.settingsPanel.classList.remove("hidden"));
  el.toggleSettingsBtn.addEventListener("click", () => el.settingsPanel.classList.toggle("hidden"));

  [el.freeApiKeyInput, el.paidApiKeyInput, el.glossaryInput].forEach((n) => {
    n.addEventListener("input", () => { saveSettings(); updateTierUI(); });
  });

  [el.modelSelect, el.summaryModelSelect, el.chunkIntervalSelect, el.ttsRateSelect, el.duplexModeSelect, el.toneSelect].forEach((n) => {
    n.addEventListener("change", () => {
      if (el.modelSelect.value === "gemini-4-carbon" && activeTier === "free" && el.paidApiKeyInput.value.trim()) {
        activeTier = "paid";
        updateTierUI();
      }
      saveSettings();
    });
  });

  el.autoModeSelect.addEventListener("change", () => {
    syncDirectionLockUI();
    saveSettings();
    if (typeof engine.restartForModeChange === "function") engine.restartForModeChange();
  });

  el.quickLangBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      el.partnerLangSelect.value = btn.dataset.lang;
      syncQuickLangUI(btn.dataset.lang);
      saveSettings();
      if (typeof engine.restartForModeChange === "function") engine.restartForModeChange();
    });
  });

  el.partnerLangSelect.addEventListener("change", () => {
    syncQuickLangUI(el.partnerLangSelect.value);
    saveSettings();
    if (typeof engine.restartForModeChange === "function") engine.restartForModeChange();
  });

  el.dirLockBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      el.autoModeSelect.value = btn.dataset.mode;
      syncDirectionLockUI();
      saveSettings();
      if (typeof engine.restartForModeChange === "function") engine.restartForModeChange();
    });
  });

  el.soundTestBtn.addEventListener("click", () => engine.testSound(el.ttsRateSelect.value));

  async function startInterpreter(customStream = null) {
    const key = activeTier === "paid" ? el.paidApiKeyInput.value.trim() : el.freeApiKeyInput.value.trim();
    if (!key) {
      alert("설정창에서 API 키를 먼저 등록해 주세요.");
      el.settingsPanel.classList.remove("hidden");
      return;
    }

    engine.unlockAudio(false);
    saveSettings();
    el.settingsPanel.classList.add("hidden");

    await engine.start(customStream);

    el.mainActionBtn.textContent = "통역 중지";
    el.mainActionBtn.className = "btn-main btn-stop";
    setStatus("동시통역 중", "connected");
    updateMicVisual(false);

    if (timerInterval) clearInterval(timerInterval);
    elapsedSec = 1;
    el.sessionTimerBadge.textContent = "1초";
    timerInterval = setInterval(() => {
      elapsedSec += 1;
      const m = Math.floor(elapsedSec / 60);
      const s = elapsedSec % 60;
      el.sessionTimerBadge.textContent = m >= 1 ? `${m}분 ${s}초` : `${s}초`;
    }, 1000);

    try {
      if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen");
    } catch (e) {}
  }

  function stopInterpreter() {
    if (typeof engine.flushRemainingLiveText === "function") {
      engine.flushRemainingLiveText();
    }
    engine.stop();
    updateLivePreviewBubble("");
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
    if (wakeLock) {
      wakeLock.release().catch(() => {});
      wakeLock = null;
    }
    el.mainActionBtn.textContent = "통역 시작";
    el.mainActionBtn.className = "btn-main btn-start";
    el.ch1StateText.textContent = "대기";
    el.ch2StateText.textContent = "대기";
    setStatus("대기", "");
    updateMicVisual(false);
  }

  el.mainActionBtn.addEventListener("click", () => {
    if (engine.isRunning) stopInterpreter();
    else startInterpreter(null);
  });

  el.sysAudioBtn.addEventListener("click", async () => {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      alert("PC 크롬 또는 엣지에서 탭 오디오 공유를 지원합니다.");
      return;
    }
    engine.unlockAudio(false);
    try {
      const disp = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      disp.getVideoTracks().forEach((t) => t.stop());
      const aTracks = disp.getAudioTracks();
      if (aTracks.length === 0) {
        alert("공유 창 하단의 탭 오디오 공유 스위치를 켜고 선택해 주세요.");
        return;
      }
      el.duplexModeSelect.value = "full_duplex";
      saveSettings();
      const sysStream = new MediaStream(aTracks);
      aTracks[0].onended = () => stopInterpreter();
      await startInterpreter(sysStream);
    } catch (err) {
      if (err.name !== "NotAllowedError") {
        alert("탭 오디오 연결 오류: " + err.message);
      }
    }
  });

  function sendManual() {
    const txt = el.manualTextInput.value.trim();
    if (!txt) return;
    const key = activeTier === "paid" ? el.paidApiKeyInput.value.trim() : el.freeApiKeyInput.value.trim();
    if (!key) {
      alert("설정창에서 API 키를 먼저 등록해 주세요.");
      el.settingsPanel.classList.remove("hidden");
      return;
    }
    engine.unlockAudio(false);
    engine.translateManualText(txt);
    el.manualTextInput.value = "";
  }

  el.sendTextBtn.addEventListener("click", sendManual);
  el.manualTextInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      sendManual();
    }
  });

  el.clearBtn.addEventListener("click", () => {
    el.transcriptBox.innerHTML = "";
    el.liveOriginalStream.innerHTML = "";
    el.liveTranslatedStream.textContent = "";
    committedOrigHistory = "";
    cardMap.clear();
    updateLivePreviewBubble("");
    if (engine.recentTranslations) engine.recentTranslations = [];
    if (typeof engine.lastLiveUnconsumed === "string") engine.lastLiveUnconsumed = "";
  });

  async function copyText(str) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(str);
    } else {
      const area = document.createElement("textarea");
      area.value = str;
      area.style.position = "fixed";
      area.style.left = "-9999px";
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      document.body.removeChild(area);
    }
  }

  function flashToolFeedback(btn, doneText) {
    const origLabel = btn.textContent;
    btn.textContent = doneText;
    btn.classList.add("success");
    setTimeout(() => {
      btn.textContent = origLabel;
      btn.classList.remove("success");
    }, 1500);
  }

  function getDialogueLog() {
    return Array.from(el.transcriptBox.querySelectorAll(".bubble.chunk-pair")).map((b) => {
      const t = b.querySelector(".bubble-time")?.textContent || "";
      const o = b.querySelector(".chunk-orig-line")?.textContent || "";
      const tr = b.querySelector(".chunk-trans-line")?.textContent || "";
      return `[${t}] 원문: ${o}\n통역: ${tr}`;
    }).join("\n\n");
  }

  function getFullExport() {
    const dlg = getDialogueLog();
    const cards = el.transcriptBox.querySelectorAll(".bubble.summary-card .bubble-content");
    const sum = cards.length >= 1 ? cards[cards.length - 1].textContent.trim() : "";
    return [
      sum ? `[이중 언어 회의록 요약]\n${sum}` : "",
      dlg ? `[전체 통역 기록]\n${dlg}` : ""
    ].filter(Boolean).join("\n\n====================\n\n");
  }

  el.summarizeBtn.addEventListener("click", async () => {
    const dlg = getDialogueLog();
    if (!dlg) {
      alert("요약할 대화 기록이 없습니다.");
      return;
    }
    const key = activeTier === "paid" ? el.paidApiKeyInput.value.trim() : el.freeApiKeyInput.value.trim();
    if (!key) {
      alert("설정창에서 API 키를 먼저 등록해 주세요.");
      el.settingsPanel.classList.remove("hidden");
      return;
    }

    el.summarizeBtn.disabled = true;
    el.summarizeBtn.textContent = "요약 중...";
    try {
      const pInfo = window.INTERPRETER_LANGS[el.partnerLangSelect.value];
      const text = await engine.generateBilingualSummary(dlg, el.sessionTimerBadge.textContent);
      const parts = text.split(/\n\s*-{10,}\s*\n/);
      const [firstPart, ...restParts] = parts;
      const koPart = (firstPart || text).trim();
      const forPart = (restParts.join("\n\n") || text).trim();

      const card = document.createElement("div");
      card.className = "bubble summary-card";
      card.innerHTML = `<div class="bubble-header"><span class="bubble-label">이중 언어 요약 (한국어 + ${pInfo.ko})</span><span class="bubble-time">${nowTimeStr()}</span></div><span class="bubble-content"></span><div class="summary-card-actions"><button type="button" class="btn-summary-copy">한국어 요약만 복사하기</button><button type="button" class="btn-summary-copy foreign">${pInfo.ko} 요약만 복사하기</button></div>`;
      card.querySelector(".bubble-content").textContent = text;

      const [copyKoBtn, copyForBtn] = card.querySelectorAll(".btn-summary-copy");
      copyKoBtn.addEventListener("click", async () => {
        await copyText(koPart);
        const prev = copyKoBtn.textContent;
        copyKoBtn.textContent = "한국어 요약 복사됨";
        copyKoBtn.classList.add("copied");
        setTimeout(() => {
          copyKoBtn.textContent = prev;
          copyKoBtn.classList.remove("copied");
        }, 1500);
      });

      copyForBtn.addEventListener("click", async () => {
        await copyText(forPart);
        const prev = copyForBtn.textContent;
        copyForBtn.textContent = `${pInfo.ko} 요약 복사됨`;
        copyForBtn.classList.add("copied");
        setTimeout(() => {
          copyForBtn.textContent = prev;
          copyForBtn.classList.remove("copied");
        }, 1500);
      });

      if (livePreviewCard && livePreviewCard.parentNode === el.transcriptBox) {
        el.transcriptBox.insertBefore(card, livePreviewCard);
      } else {
        el.transcriptBox.appendChild(card);
      }
      el.transcriptBox.scrollTop = el.transcriptBox.scrollHeight;
    } catch (err) {
      alert("요약 오류: " + err.message);
    } finally {
      el.summarizeBtn.disabled = false;
      el.summarizeBtn.textContent = "이중언어 요약";
    }
  });

  el.copyLogBtn.addEventListener("click", async () => {
    const txt = getFullExport();
    if (!txt) {
      alert("복사할 대화 기록이 없습니다.");
      return;
    }
    await copyText(txt);
    flashToolFeedback(el.copyLogBtn, "복사됨");
  });

  el.shareLogBtn.addEventListener("click", async () => {
    const txt = getFullExport();
    if (!txt) {
      alert("공유할 대화 기록이 없습니다.");
      return;
    }
    if (navigator.share) {
      try {
        await navigator.share({ title: "AI 동시통역 회의록", text: txt });
        flashToolFeedback(el.shareLogBtn, "공유됨");
      } catch (err) {
        if (err.name !== "AbortError") {
          await copyText(txt);
          alert("클립보드에 전체 내용을 복사했습니다.");
        }
      }
    } else {
      await copyText(txt);
      flashToolFeedback(el.shareLogBtn, "복사됨");
      alert("PC 브라우저에서는 전체 내용을 클립보드에 복사했습니다.");
    }
  });

  el.downloadTxtBtn.addEventListener("click", () => {
    const txt = getFullExport();
    if (!txt) {
      alert("저장할 대화 기록이 없습니다.");
      return;
    }
    const blob = new Blob(["\uFEFF" + txt], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `동시통역_회의록_${getFileTimestamp()}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    flashToolFeedback(el.downloadTxtBtn, "저장됨");
  });

  loadSettings();
});