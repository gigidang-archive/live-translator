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
    voiceNameSelect: document.getElementById("voiceNameSelect"),
    voiceModelSelect: document.getElementById("voiceModelSelect"),
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
    costBadge: document.getElementById("costBadge"),
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
  let hasMicHardware = true;
  let lastQuotaWarning = "";
  let committedOrigHistory = "";
  let cardMap = new Map();
  let timerInterval = null;
  let elapsedSec = 1;
  let wakeLock = null;

  async function detectMicHardware() {
    if (!navigator.mediaDevices?.enumerateDevices) {
      hasMicHardware = false;
      return;
    }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      hasMicHardware = devices.some((d) => d.kind === "audioinput");
    } catch (e) {
      hasMicHardware = false;
    }
  }
  detectMicHardware();
  navigator.mediaDevices?.addEventListener?.("devicechange", detectMicHardware);

  async function bindBluetoothOutputSink(audioCtx) {
    if (!audioCtx || typeof audioCtx.setSinkId !== "function" || !navigator.mediaDevices?.enumerateDevices) {
      return;
    }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const btOut = devices.find((d) => d.kind === "audiooutput" && /bluetooth|buds|airpods|headset|earphone|이어폰|버즈/i.test(d.label || ""));
      if (btOut && btOut.deviceId) {
        await audioCtx.setSinkId(btOut.deviceId);
      }
    } catch (e) {}
  }

  const engine = new window.GeminiInterpreterEngine({
    getConfig: () => ({
      activeTier,
      apiKey: activeTier === "paid" ? (el.paidApiKeyInput?.value.trim() || "") : (el.freeApiKeyInput?.value.trim() || ""),
      backupPaidKey: el.paidApiKeyInput?.value.trim() || "",
      voiceName: el.voiceNameSelect?.value || "Kore",
      voiceModel: el.voiceModelSelect?.value || "fast_neural",
      modelId: el.modelSelect?.value || "gemini-3.8-flash",
      summaryModelId: el.summaryModelSelect?.value || "gemini-3.8-flash",
      partnerLang: el.partnerLangSelect?.value || "en",
      autoMode: el.autoModeSelect?.value || "to_ko_only",
      chunkMs: el.chunkIntervalSelect?.value || "2800",
      ttsRate: el.ttsRateSelect?.value || "1.15",
      duplexMode: el.duplexModeSelect?.value || "full_duplex",
      tone: el.toneSelect?.value || "polite",
      glossary: el.glossaryInput?.value.trim() || ""
    }),
    onVolume: (level) => {
      if (el.volumeFill) el.volumeFill.style.width = level + "%";
    },
    onCostUpdate: (calls, krw) => {
      if (el.costBadge) {
        el.costBadge.textContent = activeTier === "paid" ? `${calls}회 · 약 ${krw}원` : `${calls}회 · 무료키`;
      }
    },
    onChannelState: (s1, s2) => {
      if (s1 && el.ch1StateText) el.ch1StateText.textContent = s1;
      if (s2 && el.ch2StateText && !lastQuotaWarning) el.ch2StateText.textContent = s2;
    },
    onSpeakingChange: (speaking) => {
      if (speaking) {
        lastQuotaWarning = "";
        if (el.ch2StateText) el.ch2StateText.textContent = "음성 송출 중";
        setStatus("음성 송출 중", "speaking");
      } else {
        if (el.ch2StateText && !lastQuotaWarning) el.ch2StateText.textContent = "대기";
        if (engine.isRunning && !lastQuotaWarning) setStatus("동시통역 중", "connected");
      }
      updateMicVisual(speaking);
    },
    onChunkCommitted: (seq, orig, trans) => {
      lastQuotaWarning = "";
      if (orig && el.liveOriginalStream) {
        committedOrigHistory = committedOrigHistory ? (committedOrigHistory + " " + orig) : orig;
        el.liveOriginalStream.textContent = committedOrigHistory;
        el.liveOriginalStream.scrollTop = el.liveOriginalStream.scrollHeight;
      }
      if (trans && el.liveTranslatedStream) {
        el.liveTranslatedStream.textContent += (el.liveTranslatedStream.textContent ? " " : "") + trans;
        el.liveTranslatedStream.scrollTop = el.liveTranslatedStream.scrollHeight;
      }
      createOrUpdateChunkCard(seq, orig, trans || "(통역 생략)");
      if (engine.isRunning && !engine.isSpeaking) setStatus("동시통역 중", "connected");
    },
    onAutoSwitchPaid: () => {
      activeTier = "paid";
      saveSettings();
      updateTierUI();
      if (el.ch2StateText) el.ch2StateText.textContent = "무료 한도 초과 → 유료 키 전환됨";
    },
    onNoMicFallback: () => {
      updateMicVisual(false);
      if (el.ch1StateText) el.ch1StateText.textContent = "텍스트 전용 대기";
    },
    onError: (msg, isQuota429) => {
      setStatus(isQuota429 ? "한도 초과(429)" : "오류 확인", "error");
      if (isQuota429) lastQuotaWarning = msg;
      if (el.ch2StateText) el.ch2StateText.textContent = msg;
    }
  });

  function nowTimeStr() {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
  }

  function getFileTimestamp() {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}_${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}${String(d.getSeconds()).padStart(2, "0")}`;
  }

  function createOrUpdateChunkCard(seq, orig, trans) {
    if (!el.transcriptBox) return;
    let card = cardMap.get(seq);
    if (!card) {
      card = document.createElement("div");
      card.className = "bubble chunk-pair";
      card.innerHTML = `<div class="bubble-header"><span class="bubble-label">#${seq}</span><span class="bubble-time">${nowTimeStr()}</span></div><div class="chunk-orig-line"></div><div class="chunk-trans-line"></div>`;
      cardMap.set(seq, card);
      el.transcriptBox.appendChild(card);
    }
    if (orig) card.querySelector(".chunk-orig-line").textContent = orig;
    if (trans) card.querySelector(".chunk-trans-line").textContent = trans;
    el.transcriptBox.scrollTop = el.transcriptBox.scrollHeight;
  }

  function updateHeaderLangLabels() {
    const code = el.partnerLangSelect?.value || "en";
    const pName = window.INTERPRETER_LANGS[code]?.ko || "영어";
    if (el.btnLockToKo) el.btnLockToKo.textContent = `${pName} → 한국어 고정`;
    if (el.btnLockFromKo) el.btnLockFromKo.textContent = `한국어 → ${pName} 고정`;
    if (el.origLangLabel) {
      const mode = el.autoModeSelect?.value || "to_ko_only";
      el.origLangLabel.textContent = mode === "to_ko_only"
        ? `실시간 원문 기록 (${pName} 원음 인식)`
        : (mode === "from_ko_only" ? "실시간 원문 기록 (한국어 원음 인식)" : `실시간 원문 기록 (한국어·${pName} 자동)`);
    }
  }

  function syncQuickLangUI(code) {
    el.quickLangBtns.forEach((b) => b.classList.toggle("active", b.dataset.lang === code));
    updateHeaderLangLabels();
  }

  function syncDirectionLockUI() {
    const mode = el.autoModeSelect?.value || "to_ko_only";
    el.dirLockBtns.forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
    updateHeaderLangLabels();
  }

  function setStatus(text, cls) {
    if (!el.statusBadge) return;
    el.statusBadge.textContent = text;
    el.statusBadge.className = "status-badge" + (cls ? " " + cls : "");
  }

  function updateMicVisual(speaking) {
    if (!el.volumeFill || !el.micStateLabel) return;
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
    if (speaking && engine.driverMode === "mic" && el.duplexModeSelect?.value === "smart_guard" && el.autoModeSelect?.value === "auto_both") {
      el.volumeFill.classList.add("muted");
      el.micStateLabel.classList.add("muted");
      el.micStateLabel.textContent = "에코 방지 중";
    } else {
      el.micStateLabel.textContent = engine.driverMode === "system_audio" ? "PC 소리 수신 중" : "연속 수음 중";
    }
  }

  function loadSettings() {
    const legacy = localStorage.getItem("gemini_rt_api_key") || "";
    if (el.freeApiKeyInput) el.freeApiKeyInput.value = localStorage.getItem("gemini_rt_free_key") || legacy;
    if (el.paidApiKeyInput) el.paidApiKeyInput.value = localStorage.getItem("gemini_rt_paid_key") || "";
    activeTier = localStorage.getItem("gemini_rt_active_tier") === "paid" ? "paid" : "free";
    if (el.paidApiKeyInput?.value.trim()) activeTier = "paid";

    const map = [
      ["gemini_rt_voice_name_v12", el.voiceNameSelect],
      ["gemini_rt_voice_model_v12", el.voiceModelSelect],
      ["gemini_rt_model_v12", el.modelSelect],
      ["gemini_rt_sum_model_v12", el.summaryModelSelect],
      ["gemini_rt_partner_lang", el.partnerLangSelect],
      ["gemini_rt_auto_mode_v12", el.autoModeSelect],
      ["gemini_rt_chunk_len_v12", el.chunkIntervalSelect],
      ["gemini_rt_tts_rate_v12", el.ttsRateSelect],
      ["gemini_rt_duplex_mode_v12", el.duplexModeSelect],
      ["gemini_rt_tone", el.toneSelect],
      ["gemini_rt_glossary", el.glossaryInput]
    ];
    map.forEach(([k, node]) => {
      const val = localStorage.getItem(k);
      if (val && node) node.value = val;
    });

    if ((el.freeApiKeyInput?.value.trim() || el.paidApiKeyInput?.value.trim()) && el.settingsPanel) {
      el.settingsPanel.classList.add("hidden");
    }
    updateTierUI();
    syncQuickLangUI(el.partnerLangSelect?.value || "en");
    syncDirectionLockUI();
    if (el.ch2StateText) el.ch2StateText.textContent = "블루투스 호환 엔진 준비됨";
  }

  function saveSettings() {
    if (el.freeApiKeyInput) localStorage.setItem("gemini_rt_free_key", el.freeApiKeyInput.value.trim());
    if (el.paidApiKeyInput) localStorage.setItem("gemini_rt_paid_key", el.paidApiKeyInput.value.trim());
    localStorage.setItem("gemini_rt_active_tier", activeTier);
    if (el.voiceNameSelect) localStorage.setItem("gemini_rt_voice_name_v12", el.voiceNameSelect.value);
    if (el.voiceModelSelect) localStorage.setItem("gemini_rt_voice_model_v12", el.voiceModelSelect.value);
    if (el.modelSelect) localStorage.setItem("gemini_rt_model_v12", el.modelSelect.value);
    if (el.summaryModelSelect) localStorage.setItem("gemini_rt_sum_model_v12", el.summaryModelSelect.value);
    if (el.partnerLangSelect) localStorage.setItem("gemini_rt_partner_lang", el.partnerLangSelect.value);
    if (el.autoModeSelect) localStorage.setItem("gemini_rt_auto_mode_v12", el.autoModeSelect.value);
    if (el.chunkIntervalSelect) localStorage.setItem("gemini_rt_chunk_len_v12", el.chunkIntervalSelect.value);
    if (el.ttsRateSelect) localStorage.setItem("gemini_rt_tts_rate_v12", el.ttsRateSelect.value);
    if (el.duplexModeSelect) localStorage.setItem("gemini_rt_duplex_mode_v12", el.duplexModeSelect.value);
    if (el.toneSelect) localStorage.setItem("gemini_rt_tone", el.toneSelect.value);
    if (el.glossaryInput) localStorage.setItem("gemini_rt_glossary", el.glossaryInput.value.trim());
  }

  function updateTierUI() {
    if (!el.selectFreeTierBtn || !el.selectPaidTierBtn || !el.headerTierBadge || !el.keyStatusMsg) return;
    if (activeTier === "free") {
      el.selectFreeTierBtn.classList.add("active-free");
      el.selectPaidTierBtn.classList.remove("active-paid");
      el.headerTierBadge.textContent = "무료 키";
      el.headerTierBadge.classList.remove("paid");
      el.keyStatusMsg.style.color = "#60a5fa";
      el.keyStatusMsg.textContent = el.freeApiKeyInput?.value.trim() ? "무료 키 활성" : "무료 키를 입력해 주세요.";
    } else {
      el.selectPaidTierBtn.classList.add("active-paid");
      el.selectFreeTierBtn.classList.remove("active-free");
      el.headerTierBadge.textContent = "유료 키";
      el.headerTierBadge.classList.add("paid");
      el.keyStatusMsg.style.color = "#fbbf24";
      el.keyStatusMsg.textContent = el.paidApiKeyInput?.value.trim()
        ? "유료 키 활성 (블루투스 미디어 모드 지원)"
        : "유료 키를 입력해 주세요.";
    }
  }

  function bindFileLoader(fileEl, inputEl, tier) {
    if (!fileEl || !inputEl) return;
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
      if (!t) return;
      t.type = t.type === "password" ? "text" : "password";
      btn.textContent = t.type === "password" ? "표시" : "숨김";
    });
  });

  document.querySelectorAll(".btn-file-load").forEach((btn) => {
    btn.addEventListener("click", () => {
      const f = document.getElementById(btn.dataset.fileTarget);
      if (!f) return;
      f.value = "";
      f.click();
    });
  });

  el.selectFreeTierBtn?.addEventListener("click", () => { activeTier = "free"; lastQuotaWarning = ""; saveSettings(); updateTierUI(); });
  el.selectPaidTierBtn?.addEventListener("click", () => { activeTier = "paid"; lastQuotaWarning = ""; saveSettings(); updateTierUI(); });
  el.headerTierBadge?.addEventListener("click", () => el.settingsPanel?.classList.remove("hidden"));
  el.toggleSettingsBtn?.addEventListener("click", () => el.settingsPanel?.classList.toggle("hidden"));

  el.paidApiKeyInput?.addEventListener("input", () => {
    if (el.paidApiKeyInput.value.trim().length >= 20) activeTier = "paid";
    saveSettings();
    updateTierUI();
  });
  el.freeApiKeyInput?.addEventListener("input", () => {
    if (el.freeApiKeyInput.value.trim().length >= 20 && !el.paidApiKeyInput?.value.trim()) activeTier = "free";
    saveSettings();
    updateTierUI();
  });
  el.glossaryInput?.addEventListener("input", saveSettings);

  [el.voiceNameSelect, el.voiceModelSelect, el.modelSelect, el.summaryModelSelect, el.chunkIntervalSelect, el.ttsRateSelect, el.duplexModeSelect, el.toneSelect].forEach((n) => {
    n?.addEventListener("change", () => {
      if (el.modelSelect?.value === "gemini-4-carbon" && activeTier === "free" && el.paidApiKeyInput?.value.trim()) {
        activeTier = "paid";
        updateTierUI();
      }
      saveSettings();
    });
  });

  el.autoModeSelect?.addEventListener("change", () => { syncDirectionLockUI(); saveSettings(); engine.restartForModeChange(); });
  el.quickLangBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      if (el.partnerLangSelect) el.partnerLangSelect.value = btn.dataset.lang;
      syncQuickLangUI(btn.dataset.lang);
      saveSettings();
      engine.restartForModeChange();
    });
  });
  el.partnerLangSelect?.addEventListener("change", () => { syncQuickLangUI(el.partnerLangSelect.value); saveSettings(); engine.restartForModeChange(); });
  el.dirLockBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      if (el.autoModeSelect) el.autoModeSelect.value = btn.dataset.mode;
      syncDirectionLockUI();
      saveSettings();
      engine.restartForModeChange();
    });
  });

  el.soundTestBtn?.addEventListener("click", async () => {
    engine.unlockAudio(false);
    await bindBluetoothOutputSink(engine.outputCtx);
    engine.testSound();
  });

  async function acquireSystemAudioStream() {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      alert("PC 크롬 또는 엣지 브라우저에서 시스템 오디오 공유를 지원합니다.");
      return null;
    }
    try {
      const disp = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
        systemAudio: "include"
      });
      disp.getVideoTracks().forEach((t) => t.stop());
      const aTracks = disp.getAudioTracks();
      if (aTracks.length === 0) {
        alert("공유 창 왼쪽 아래의 오디오 공유 스위치를 꼭 켜주세요.");
        return null;
      }
      if (el.duplexModeSelect) el.duplexModeSelect.value = "full_duplex";
      const sysStream = new MediaStream(aTracks);
      aTracks[0].onended = () => stopInterpreter();
      return sysStream;
    } catch (err) {
      return null;
    }
  }

  async function beginEngineWithStream(stream, modeLabel) {
    lastQuotaWarning = "";
    saveSettings();
    el.settingsPanel?.classList.add("hidden");

    await engine.startWithStream(stream, modeLabel);
    await bindBluetoothOutputSink(engine.outputCtx);

    if (el.mainActionBtn) {
      el.mainActionBtn.textContent = "통역 중지";
      el.mainActionBtn.className = "btn-main btn-stop";
    }
    setStatus("동시통역 중", "connected");
    updateMicVisual(false);

    if (timerInterval) clearInterval(timerInterval);
    elapsedSec = 1;
    if (el.sessionTimerBadge) el.sessionTimerBadge.textContent = "1초";
    timerInterval = setInterval(() => {
      elapsedSec += 1;
      const m = Math.floor(elapsedSec / 60);
      const s = elapsedSec % 60;
      if (el.sessionTimerBadge) el.sessionTimerBadge.textContent = m >= 1 ? `${m}분 ${s}초` : `${s}초`;
    }, 1000);

    try { if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen"); } catch (e) {}
  }

  function ensureApiKeyReady() {
    if (el.paidApiKeyInput?.value.trim() && activeTier === "free" && !el.freeApiKeyInput?.value.trim()) {
      activeTier = "paid";
      updateTierUI();
    }
    const key = activeTier === "paid" ? el.paidApiKeyInput?.value.trim() : el.freeApiKeyInput?.value.trim();
    if (!key) {
      alert("설정창에서 API 키를 먼저 등록해 주세요.");
      el.settingsPanel?.classList.remove("hidden");
      return false;
    }
    return true;
  }

  function stopInterpreter() {
    engine.flushRemainingLiveText();
    engine.stop();
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
    if (el.mainActionBtn) {
      el.mainActionBtn.textContent = "통역 시작";
      el.mainActionBtn.className = "btn-main btn-start";
    }
    if (el.ch1StateText) el.ch1StateText.textContent = "대기";
    if (!lastQuotaWarning) {
      if (el.ch2StateText) el.ch2StateText.textContent = "블루투스 호환 엔진 준비됨";
      setStatus("대기", "");
    }
    updateMicVisual(false);
  }

  el.mainActionBtn?.addEventListener("click", async () => {
    if (engine.isRunning) {
      stopInterpreter();
      return;
    }
    if (!ensureApiKeyReady()) return;
    engine.unlockAudio(false);

    if (!hasMicHardware) {
      const sysStream = await acquireSystemAudioStream();
      if (sysStream) await beginEngineWithStream(sysStream, "system_audio");
      return;
    }

    // 모바일 및 이어폰 모드에서는 통화용 스피커폰 전환(echoCancellation)을 끄고 미디어 오디오 경로를 유지함
    const isMobile = /Android|iPhone|iPad/i.test(navigator.userAgent);
    const keepMediaRoute = isMobile || el.duplexModeSelect?.value === "full_duplex" || el.autoModeSelect?.value !== "auto_both";

    try {
      let BuiltInMicId = undefined;
      if (isMobile && navigator.mediaDevices?.enumerateDevices) {
        const devs = await navigator.mediaDevices.enumerateDevices();
        const phoneMic = devs.find((d) => d.kind === "audioinput" && d.deviceId && !/bluetooth|buds|headset|earphone|블루투스/i.test(d.label || ""));
        if (phoneMic && phoneMic.label) BuiltInMicId = phoneMic.deviceId;
      }

      const audioConstraints = {
        channelCount: 1,
        echoCancellation: !keepMediaRoute,
        noiseSuppression: !keepMediaRoute,
        autoGainControl: true
      };
      if (BuiltInMicId) {
        audioConstraints.deviceId = { ideal: BuiltInMicId };
      }

      const micStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
      await beginEngineWithStream(micStream, keepMediaRoute ? "bt_mic" : "mic");
    } catch (micErr) {
      hasMicHardware = false;
      const sysStream = await acquireSystemAudioStream();
      if (sysStream) await beginEngineWithStream(sysStream, "system_audio");
    }
  });

  el.sysAudioBtn?.addEventListener("click", async () => {
    if (!ensureApiKeyReady()) return;
    engine.unlockAudio(false);
    const sysStream = await acquireSystemAudioStream();
    if (sysStream) await beginEngineWithStream(sysStream, "system_audio");
  });

  function sendManual() {
    const txt = el.manualTextInput?.value.trim() || "";
    if (!txt || !ensureApiKeyReady()) return;
    lastQuotaWarning = "";
    engine.unlockAudio(false);
    engine.translateManualText(txt);
    if (el.manualTextInput) el.manualTextInput.value = "";
  }

  el.sendTextBtn?.addEventListener("click", sendManual);
  el.manualTextInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); sendManual(); }
  });

  el.clearBtn?.addEventListener("click", () => {
    if (el.transcriptBox) el.transcriptBox.innerHTML = "";
    if (el.liveOriginalStream) el.liveOriginalStream.textContent = "";
    if (el.liveTranslatedStream) el.liveTranslatedStream.textContent = "";
    committedOrigHistory = "";
    lastQuotaWarning = "";
    cardMap.clear();
    engine.recentOrigList = [];
    engine.recentTranslations = [];
    engine.resetCostStats();
  });

  async function copyText(str) {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(str);
  }

  function flashToolFeedback(btn, doneText) {
    if (!btn) return;
    const origLabel = btn.textContent;
    btn.textContent = doneText;
    btn.classList.add("success");
    setTimeout(() => { btn.textContent = origLabel; btn.classList.remove("success"); }, 1500);
  }

  function getDialogueLog() {
    if (!el.transcriptBox) return "";
    return Array.from(el.transcriptBox.querySelectorAll(".bubble.chunk-pair")).map((b) => {
      const t = b.querySelector(".bubble-time")?.textContent || "";
      const o = b.querySelector(".chunk-orig-line")?.textContent || "";
      const tr = b.querySelector(".chunk-trans-line")?.textContent || "";
      return `[${t}] 원문: ${o}\n통역: ${tr}`;
    }).join("\n\n");
  }

  function getFullExport() {
    const dlg = getDialogueLog();
    const cards = el.transcriptBox?.querySelectorAll(".bubble.summary-card .bubble-content") || [];
    const sum = cards.length >= 1 ? cards[cards.length - 1].textContent.trim() : "";
    return [sum ? `[이중 언어 회의록 요약]\n${sum}` : "", dlg ? `[전체 통역 기록]\n${dlg}` : ""].filter(Boolean).join("\n\n====================\n\n");
  }

  el.summarizeBtn?.addEventListener("click", async () => {
    const dlg = getDialogueLog();
    if (!dlg) { alert("요약할 대화 기록이 없습니다."); return; }
    el.summarizeBtn.disabled = true;
    el.summarizeBtn.textContent = "요약 중...";
    try {
      const pInfo = window.INTERPRETER_LANGS[el.partnerLangSelect?.value || "en"];
      const text = await engine.generateBilingualSummary(dlg, el.sessionTimerBadge?.textContent || "");
      const [firstPart, ...restParts] = text.split(/\n\s*-{10,}\s*\n/);
      const koPart = (firstPart || text).trim();
      const forPart = (restParts.join("\n\n") || text).trim();

      const card = document.createElement("div");
      card.className = "bubble summary-card";
      card.innerHTML = `<div class="bubble-header"><span class="bubble-label">이중 언어 요약 (한국어 + ${pInfo.ko})</span><span class="bubble-time">${nowTimeStr()}</span></div><span class="bubble-content"></span><div class="summary-card-actions"><button type="button" class="btn-summary-copy">한국어 요약 복사</button><button type="button" class="btn-summary-copy foreign">${pInfo.ko} 요약 복사</button></div>`;
      card.querySelector(".bubble-content").textContent = text;

      const [copyKoBtn, copyForBtn] = card.querySelectorAll(".btn-summary-copy");
      copyKoBtn.addEventListener("click", () => copyText(koPart));
      copyForBtn.addEventListener("click", () => copyText(forPart));

      el.transcriptBox?.appendChild(card);
      if (el.transcriptBox) el.transcriptBox.scrollTop = el.transcriptBox.scrollHeight;
    } catch (err) {
      alert("요약 오류: " + err.message);
    } finally {
      el.summarizeBtn.disabled = false;
      el.summarizeBtn.textContent = "이중언어 요약";
    }
  });

  el.copyLogBtn?.addEventListener("click", async () => {
    const txt = getFullExport();
    if (txt) { await copyText(txt); flashToolFeedback(el.copyLogBtn, "복사됨"); }
  });

  el.shareLogBtn?.addEventListener("click", async () => {
    const txt = getFullExport();
    if (!txt) return;
    if (navigator.share) {
      try { await navigator.share({ title: "AI 동시통역 회의록", text: txt }); flashToolFeedback(el.shareLogBtn, "공유됨"); } catch (e) {}
    } else {
      await copyText(txt);
      flashToolFeedback(el.shareLogBtn, "복사됨");
    }
  });

  el.downloadTxtBtn?.addEventListener("click", () => {
    const txt = getFullExport();
    if (!txt) return;
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