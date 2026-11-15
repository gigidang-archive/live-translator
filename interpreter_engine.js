const INTERPRETER_LANGS = {
  en: { ko: "영어", en: "English", native: "English", bcp47: "en-US" },
  zh: { ko: "중국어", en: "Mandarin Chinese", native: "中文", bcp47: "zh-CN" },
  ja: { ko: "일본어", en: "Japanese", native: "日本語", bcp47: "ja-JP" },
  es: { ko: "스페인어", en: "Spanish", native: "Español", bcp47: "es-ES" }
};

class GeminiInterpreterEngine {
  constructor(callbacks) {
    this.cb = callbacks || {};
    this.isRunning = false;
    this.driverMode = "none";

    this.recognition = null;
    this.recRestartTimer = null;
    this.pauseFlushTimer = null;
    this.finalConsumedLen = 0;
    this.lastInterimAnchor = "";
    this.lastLiveUnconsumed = "";

    this.stream = null;
    this.inputCtx = null;
    this.processor = null;
    this.muteGain = null;
    this.outputCtx = null;
    this.pcmBuffer = [];
    this.voiceSamples = 0;
    this.silenceSamples = 0;
    this.tickTimer = null;
    this.inFlightAudio = 0;

    this.seqCounter = 0;
    this.nextCommitSeq = 1;
    this.pendingResults = new Map();
    this.dispatchTimes = new Map();
    this.recentTranslations = [];
    this.spokenEchoHistory = [];
    this.noThinkingModels = new Set();

    this.speechQueue = [];
    this.isSpeaking = false;
    this.muteUntilTime = 0;
    this.activeUtterance = null;
    this.ttsWatchdog = null;
    this.voices = [];

    if ("speechSynthesis" in window) {
      this.refreshVoices();
      window.speechSynthesis.onvoiceschanged = () => this.refreshVoices();
    }
  }

  refreshVoices() {
    if ("speechSynthesis" in window) {
      this.voices = window.speechSynthesis.getVoices() || [];
    }
  }

  unlockAudio(playChime = false) {
    try {
      if (!this.outputCtx || this.outputCtx.state === "closed") {
        this.outputCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (this.outputCtx.state === "suspended") this.outputCtx.resume();
      if (playChime) {
        const now = this.outputCtx.currentTime;
        const osc = this.outputCtx.createOscillator();
        const gain = this.outputCtx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(523.25, now);
        osc.frequency.setValueAtTime(659.25, now + 0.11);
        gain.gain.setValueAtTime(0.28, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.32);
        osc.connect(gain);
        gain.connect(this.outputCtx.destination);
        osc.start(now);
        osc.stop(now + 0.33);
      } else {
        const buf = this.outputCtx.createBuffer(1, 1, this.outputCtx.sampleRate || 48000);
        const src = this.outputCtx.createBufferSource();
        src.buffer = buf;
        src.connect(this.outputCtx.destination);
        src.start(0);
      }
      this.refreshVoices();
    } catch (e) {}
  }

  testSound(rate) {
    this.unlockAudio(true);
    if ("speechSynthesis" in window) {
      try { window.speechSynthesis.cancel(); } catch (e) {}
      const msg = "동시통역 음성 출력이 정상 작동합니다.";
      this.recordSpokenEcho(msg);
      const utter = new SpeechSynthesisUtterance(msg);
      this.activeUtterance = utter;
      utter.lang = "ko-KR";
      const v = this.pickBestVoice("ko-KR");
      if (v) utter.voice = v;
      utter.rate = parseFloat(rate) || 1.15;
      window.speechSynthesis.speak(utter);
    }
  }

  async start(customStream = null) {
    this.stop();
    this.isRunning = true;
    const cfg = this.cb.getConfig();
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!customStream && SpeechRec && cfg.autoMode !== "auto_both") {
      this.driverMode = "speech_rec";
      this.startLiveSpeechRecognition();
      this.startWatchLoop();
      return "speech_rec";
    }

    let targetStream = customStream;
    if (!targetStream && navigator.mediaDevices?.getUserMedia) {
      try {
        targetStream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        });
      } catch (e) {
        targetStream = null;
      }
    }

    if (targetStream) {
      this.stream = targetStream;
      this.driverMode = customStream ? "system_audio" : "mic_audio";
      this.setupAudioCapture();
      this.startWatchLoop();
      return this.driverMode;
    }

    this.driverMode = "text_only";
    this.startWatchLoop();
    return "text_only";
  }

  restartForModeChange() {
    if (!this.isRunning || this.driverMode === "system_audio") return;
    this.flushRemainingLiveText();
    this.start(null);
  }

  getSourceRecLang(cfg) {
    if (cfg.autoMode === "from_ko_only") return "ko-KR";
    return (INTERPRETER_LANGS[cfg.partnerLang] || INTERPRETER_LANGS.en).bcp47;
  }

  startLiveSpeechRecognition() {
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRec || !this.isRunning) return;

    const cfg = this.cb.getConfig();
    const rec = new SpeechRec();
    this.recognition = rec;
    rec.lang = this.getSourceRecLang(cfg);
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    this.finalConsumedLen = 0;
    this.lastInterimAnchor = "";
    this.lastLiveUnconsumed = "";

    rec.onstart = () => {
      if (this.recognition !== rec || !this.isRunning) return;
      this.cb.onChannelState("실시간 타이핑 수신 중", this.isSpeaking ? "음성 송출 중" : "대기");
    };

    rec.onresult = (event) => {
      if (this.recognition !== rec || !this.isRunning) return;
      const curCfg = this.cb.getConfig();

      if (curCfg.duplexMode === "smart_guard" && (this.isSpeaking || Date.now() < this.muteUntilTime)) {
        return;
      }

      const { finalStr, interimStr } = this.assembleTranscript(event.results);
      this.cb.onVolume(interimStr ? 72 : 35);
      setTimeout(() => { if (this.isRunning) this.cb.onVolume(12); }, 180);

      let newFinal = finalStr.slice(this.finalConsumedLen).trim();
      if (this.lastInterimAnchor && newFinal) {
        newFinal = this.stripAfterAnchor(newFinal, this.lastInterimAnchor);
      }

      let liveInterim = interimStr;
      if (this.lastInterimAnchor && liveInterim && !newFinal) {
        liveInterim = this.stripAfterAnchor(liveInterim, this.lastInterimAnchor);
      }

      const activeUnconsumed = [newFinal, liveInterim].filter(Boolean).join(" ").trim();
      this.lastLiveUnconsumed = activeUnconsumed;
      this.cb.onLiveTyping(activeUnconsumed);

      if (this.pauseFlushTimer) {
        clearTimeout(this.pauseFlushTimer);
        this.pauseFlushTimer = null;
      }

      if (newFinal) {
        if (this.isClauseLongEnough(newFinal, curCfg)) {
          this.finalConsumedLen = finalStr.length;
          this.lastInterimAnchor = "";
          this.lastLiveUnconsumed = liveInterim;
          this.cb.onLiveTyping(liveInterim);
          this.dispatchClause(newFinal);
          return;
        }
        this.pauseFlushTimer = setTimeout(() => {
          if (!this.isRunning || this.recognition !== rec) return;
          let pending = finalStr.slice(this.finalConsumedLen).trim();
          if (this.lastInterimAnchor && pending) {
            pending = this.stripAfterAnchor(pending, this.lastInterimAnchor);
          }
          if (pending) {
            this.finalConsumedLen = finalStr.length;
            this.lastInterimAnchor = "";
            this.lastLiveUnconsumed = "";
            this.cb.onLiveTyping("");
            this.dispatchClause(pending);
          }
        }, 550);
        return;
      }

      if (curCfg.duplexMode === "full_duplex" && liveInterim.length >= 48) {
        const split = this.findNaturalClauseSplit(liveInterim, curCfg);
        if (split) {
          this.lastInterimAnchor = split.head;
          this.lastLiveUnconsumed = split.tail;
          this.cb.onLiveTyping(split.tail);
          this.dispatchClause(split.head);
          return;
        }
      }

      if (liveInterim.length >= 4) {
        this.pauseFlushTimer = setTimeout(() => {
          if (!this.isRunning || this.recognition !== rec) return;
          if (this.lastLiveUnconsumed) {
            const chunk = this.lastLiveUnconsumed;
            this.lastInterimAnchor = chunk;
            this.lastLiveUnconsumed = "";
            this.cb.onLiveTyping("");
            this.dispatchClause(chunk);
          }
        }, 950);
      }
    };

    rec.onerror = (ev) => {
      if (this.recognition !== rec || !this.isRunning) return;
      if (ev.error === "audio-capture" || ev.error === "not-allowed" || ev.error === "service-not-allowed") {
        this.recognition = null;
        this.driverMode = "text_only";
        this.cb.onNoMicFallback();
      }
    };

    rec.onend = () => {
      if (this.recognition !== rec || !this.isRunning) return;
      this.flushRemainingLiveText();
      if (this.recRestartTimer) clearTimeout(this.recRestartTimer);
      this.recRestartTimer = setTimeout(() => {
        if (this.isRunning && this.driverMode === "speech_rec") {
          this.startLiveSpeechRecognition();
        }
      }, 120);
    };

    try {
      rec.start();
    } catch (e) {}
  }

  flushRemainingLiveText() {
    if (this.pauseFlushTimer) {
      clearTimeout(this.pauseFlushTimer);
      this.pauseFlushTimer = null;
    }
    if (this.lastLiveUnconsumed && this.lastLiveUnconsumed.trim().length >= 2) {
      const leftover = this.lastLiveUnconsumed.trim();
      this.lastLiveUnconsumed = "";
      this.cb.onLiveTyping("");
      this.dispatchClause(leftover);
    }
  }

  assembleTranscript(results) {
    let finalStr = "";
    let interimStr = "";
    let prevNorm = "";
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const txt = (r[0]?.transcript || "").trim();
      if (!txt) continue;
      if (r.isFinal) {
        if (finalStr && txt.toLowerCase().startsWith(finalStr.toLowerCase())) {
          finalStr = txt;
        } else if (prevNorm && txt.toLowerCase() === prevNorm) {
          continue;
        } else {
          finalStr = finalStr ? (finalStr + " " + txt) : txt;
        }
        prevNorm = txt.toLowerCase();
      } else {
        if (finalStr && txt.toLowerCase().startsWith(finalStr.toLowerCase())) {
          interimStr = txt.slice(finalStr.length).trim();
        } else {
          interimStr = interimStr ? (interimStr + " " + txt) : txt;
        }
      }
    }
    return { finalStr, interimStr };
  }

  stripAfterAnchor(text, anchorChunk) {
    if (!text || !anchorChunk) return text;
    const normChars = [];
    const origIdx = [];
    for (let i = 0; i < text.length; i++) {
      if (/[a-zA-Z0-9가-힣\u4e00-\u9fff\u3040-\u30ff]/.test(text[i])) {
        normChars.push(text[i].toLowerCase());
        origIdx.push(i);
      }
    }
    const normText = normChars.join("");
    const normAnc = anchorChunk.toLowerCase().replace(/[^a-z0-9가-힣\u4e00-\u9fff\u3040-\u30ff]/g, "");
    if (!normAnc) return text;
    const key = normAnc.slice(-Math.min(12, normAnc.length));
    const pos = normText.indexOf(key);
    if (pos !== -1) {
      const cutPos = origIdx[pos + key.length - 1] + 1;
      return text.slice(cutPos).replace(/^[\s,.:;?!。、？！\-]+/, "").trim();
    }
    return text;
  }

  isClauseLongEnough(text, cfg) {
    if (/[.?!。？！]$/.test(text)) return true;
    const minWords = cfg.chunkLen === "short" ? 3 : (cfg.chunkLen === "long" ? 8 : 5);
    const minChars = cfg.chunkLen === "short" ? 8 : (cfg.chunkLen === "long" ? 22 : 13);
    const hasCjk = /[가-힣\u4e00-\u9fff\u3040-\u30ff]/.test(text);
    if (hasCjk) return text.length >= minChars;
    return text.split(/\s+/).filter(Boolean).length >= minWords;
  }

  findNaturalClauseSplit(interimText, cfg) {
    const safeLimit = interimText.length - 14;
    if (safeLimit < 24) return null;
    const searchable = interimText.slice(0, safeLimit);
    const patterns = [
      /[.,?!。、？！]\s+/g,
      /\s+(and|but|because|so|which|that|when|while|if|although|however)\s+/gi,
      /(고|며|는데|지만|해서|니까|므로|습니다|어요|아요)\s+/g
    ];
    let bestCut = -1;
    for (const re of patterns) {
      let m;
      while ((m = re.exec(searchable)) !== null) {
        const idx = m.index + (m[0].startsWith(" ") ? 1 : m[0].length);
        if (idx >= 22 && idx > bestCut) bestCut = idx;
      }
    }
    if (bestCut === -1 && interimText.length >= (cfg.chunkLen === "short" ? 75 : 105)) {
      bestCut = searchable.lastIndexOf(" ");
    }
    if (bestCut > 20) {
      return {
        head: interimText.slice(0, bestCut).trim(),
        tail: interimText.slice(bestCut).trim()
      };
    }
    return null;
  }

  dispatchClause(origClause) {
    const clean = (origClause || "").trim();
    if (!clean || this.isEchoOfRecentSpeech(clean)) return;
    const seq = ++this.seqCounter;
    this.dispatchTimes.set(seq, Date.now());
    this.cb.onOrigClauseLocked(seq, clean);
    this.translateClauseText(seq, clean);
  }

  setupAudioCapture() {
    this.inputCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.inputCtx.state === "suspended") this.inputCtx.resume();
    const nativeRate = this.inputCtx.sampleRate || 48000;
    const source = this.inputCtx.createMediaStreamSource(this.stream);
    this.processor = this.inputCtx.createScriptProcessor(1024, 1, 1);
    this.muteGain = this.inputCtx.createGain();
    this.muteGain.gain.value = 0;

    this.processor.onaudioprocess = (e) => {
      if (!this.isRunning) return;
      const cfg = this.cb.getConfig();
      if (this.driverMode === "mic_audio" && cfg.duplexMode === "smart_guard" && (this.isSpeaking || Date.now() < this.muteUntilTime)) {
        this.cb.onVolume(0);
        return;
      }

      const raw = e.inputBuffer.getChannelData(0);
      const pcm16k = this.downsampleTo16k(raw, nativeRate);
      let sum = 0;
      for (let i = 0; i < pcm16k.length; i++) sum += pcm16k[i] * pcm16k[i];
      const rms = Math.sqrt(sum / pcm16k.length);
      this.cb.onVolume(Math.min(100, Math.round(rms * 450)));

      for (let i = 0; i < pcm16k.length; i++) this.pcmBuffer.push(pcm16k[i]);
      if (rms > 0.012) {
        this.voiceSamples += pcm16k.length;
        this.silenceSamples = 0;
      } else {
        this.silenceSamples += pcm16k.length;
      }
      if (this.pcmBuffer.length > 128000) this.pcmBuffer = this.pcmBuffer.slice(-80000);
    };

    source.connect(this.processor);
    this.processor.connect(this.muteGain);
    this.muteGain.connect(this.inputCtx.destination);
  }

  startWatchLoop() {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = setInterval(() => {
      if (!this.isRunning) return;
      if (this.driverMode === "system_audio" || this.driverMode === "mic_audio") {
        this.checkAudioClauseReady();
      }
      this.releaseStalledSequence();
    }, 200);
  }

  checkAudioClauseReady() {
    if (this.pcmBuffer.length === 0 || this.inFlightAudio >= 2) return;
    const pauseDone = this.voiceSamples >= 16000 && this.silenceSamples >= 7200;
    const maxClauseDone = this.pcmBuffer.length >= 60800 && this.voiceSamples >= 12000 && this.silenceSamples >= 1600;

    if (!pauseDone && !maxClauseDone && this.pcmBuffer.length < 76800) {
      if (this.voiceSamples === 0 && this.pcmBuffer.length > 16000) {
        this.pcmBuffer = this.pcmBuffer.slice(-3200);
      }
      return;
    }
    if (this.voiceSamples < 6400) {
      this.pcmBuffer = [];
      this.voiceSamples = 0;
      this.silenceSamples = 0;
      return;
    }

    const samples = new Float32Array(this.pcmBuffer);
    this.pcmBuffer = [];
    this.voiceSamples = 0;
    this.silenceSamples = 0;

    const seq = ++this.seqCounter;
    this.dispatchTimes.set(seq, Date.now());
    this.translateAudioSlice(seq, samples);
  }

  normalizeCompact(str) {
    return (str || "").toLowerCase().replace(/[^a-z0-9가-힣\u4e00-\u9fff\u3040-\u30ff]/g, "");
  }

  recordSpokenEcho(text) {
    const norm = this.normalizeCompact(text);
    if (norm.length < 3) return;
    this.spokenEchoHistory.push({ norm, at: Date.now() });
    if (this.spokenEchoHistory.length > 10) this.spokenEchoHistory.shift();
  }

  isEchoOfRecentSpeech(origText) {
    const normOrig = this.normalizeCompact(origText);
    if (normOrig.length < 4) return false;
    const now = Date.now();
    for (const item of this.spokenEchoHistory) {
      if (now - item.at > 18000) continue;
      if (item.norm.includes(normOrig) || normOrig.includes(item.norm)) return true;
    }
    return false;
  }

  extractVisibleText(result) {
    const parts = result?.candidates?.[0]?.content?.parts || [];
    const visible = parts.filter((p) => !p.thought && typeof p.text === "string");
    if (visible.length > 0) return visible.map((p) => p.text).join("\n").trim();
    for (let i = parts.length - 1; i >= 0; i--) {
      if (typeof parts[i].text === "string") return parts[i].text.trim();
    }
    return "";
  }

  async callGenerateContent(modelId, apiKey, parts, temperature = 0.1, timeoutMs = 10000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const generationConfig = { temperature };

    const m = (modelId || "").toLowerCase();
    if (!this.noThinkingModels.has(modelId)) {
      if (m.includes("flash-lite") || m.includes("3.6-flash")) {
        generationConfig.thinkingConfig = { thinkingLevel: "MINIMAL" };
      } else if (m.startsWith("gemini-3") || m.startsWith("gemini-4")) {
        generationConfig.thinkingConfig = { thinkingLevel: "LOW" };
      }
    }

    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig }),
        signal: controller.signal
      });
      const json = await res.json();
      if (!res.ok || json.error) {
        const msg = json.error?.message || `HTTP ${res.status}`;
        if (res.status === 400 && generationConfig.thinkingConfig && /thinking/i.test(msg)) {
          this.noThinkingModels.add(modelId);
          clearTimeout(timer);
          return await this.callGenerateContent(modelId, apiKey, parts, temperature, timeoutMs);
        }
        const err = new Error(msg);
        err.status = res.status;
        throw err;
      }
      return this.extractVisibleText(json);
    } finally {
      clearTimeout(timer);
    }
  }

  getTargetInstruction(cfg, sampleText = "") {
    const pInfo = INTERPRETER_LANGS[cfg.partnerLang] || INTERPRETER_LANGS.en;
    const toneDesc = cfg.tone === "formal" ? "격식체" : (cfg.tone === "casual" ? "친근한 구어체" : "정중한 존댓말");
    if (cfg.autoMode === "to_ko_only") {
      return `자연스러운 한국어(${toneDesc})로 완전하게 통역하십시오.`;
    }
    if (cfg.autoMode === "from_ko_only") {
      return `자연스러운 ${pInfo.ko}(${pInfo.en}, ${toneDesc})로 완전하게 통역하십시오.`;
    }
    const koCount = ((sampleText || "").match(/[가-힣]/g) || []).length;
    if (koCount >= 2) {
      return `자연스러운 ${pInfo.ko}(${pInfo.en}, ${toneDesc})로 완전하게 통역하십시오.`;
    }
    return `자연스러운 한국어(${toneDesc})로 완전하게 통역하십시오.`;
  }

  async translateClauseText(seq, origText) {
    const cfg = this.cb.getConfig();
    if (!cfg.apiKey) return;

    this.cb.onChannelState("실시간 수신 중", `#${seq} 통역 중`);
    const prevCtx = this.recentTranslations.slice(-2).join(" ");
    const prompt = [
      "당신은 전문 실시간 동시통역사입니다.",
      `지침 1. 아래 [원문 구절]의 주어, 목적어, 서술어 의미를 빠짐없이 살려 ${this.getTargetInstruction(cfg, origText)}`,
      "지침 2. 절대 서술어 한 단어만 남기거나 앞부분 내용을 생략하지 마십시오.",
      "지침 3. 설명, 인사말, 따옴표 없이 오직 통역된 문장 한 줄만 출력하십시오.",
      cfg.glossary ? `전문 용어집: ${cfg.glossary}` : "",
      prevCtx ? `앞 문맥 참고(이 내용은 다시 번역하지 말 것): ${prevCtx}` : "",
      `[원문 구절]\n${origText}`
    ].filter(Boolean).join("\n");

    try {
      let trans = "";
      try {
        trans = await this.callGenerateContent(cfg.modelId, cfg.apiKey, [{ text: prompt }], 0.1, 9000);
      } catch (e1) {
        if ((e1.status === 429 || e1.status === 404 || e1.status === 403) && cfg.modelId !== "gemini-3.5-flash-lite") {
          trans = await this.callGenerateContent("gemini-3.5-flash-lite", cfg.apiKey, [{ text: prompt }], 0.1, 8000);
        } else throw e1;
      }
      const cleaned = trans.replace(/^["'「『]|["'」』]$/g, "").trim();
      this.pendingResults.set(seq, { orig: origText, trans: cleaned, preLockedOrig: true });
    } catch (err) {
      this.pendingResults.set(seq, { orig: origText, trans: "", preLockedOrig: true });
      this.cb.onError(err.message || "번역 오류");
    }
    this.commitReadyChunks();
  }

  async translateAudioSlice(seq, float32Samples) {
    const cfg = this.cb.getConfig();
    if (!cfg.apiKey) return;
    this.inFlightAudio += 1;
    this.cb.onChannelState("오디오 분석 중", `#${seq} 통역 중`);

    const wavBase64 = this.encodeWavBase64(float32Samples, 16000);
    const pInfo = INTERPRETER_LANGS[cfg.partnerLang] || INTERPRETER_LANGS.en;
    const dirRule = cfg.autoMode === "from_ko_only"
      ? `한국어 음성을 받아적고 ${pInfo.ko}(${pInfo.en})로 완전한 문장으로 통역하십시오.`
      : (cfg.autoMode === "to_ko_only"
        ? `외국어 음성을 받아적고 한국어로 완전한 문장으로 통역하십시오.`
        : `한국어 음성은 ${pInfo.ko}(${pInfo.en})로, 외국어 음성은 한국어로 완전한 문장으로 통역하십시오.`);

    const prompt = [
      "당신은 전문 실시간 동시통역사입니다.",
      dirRule,
      "사람의 말소리가 없으면 오직 NONE 네 글자만 출력하십시오.",
      "말소리가 있으면 서술어만 남기지 말고 전체 구절을 빠짐없이 번역하여 아래 2줄로만 출력하십시오.",
      "ORIG: 들린 원문 전체",
      "TRANS: 완전한 통역 문장",
      cfg.glossary ? `전문 용어집: ${cfg.glossary}` : ""
    ].filter(Boolean).join("\n");

    const parts = [{ text: prompt }, { inlineData: { mimeType: "audio/wav", data: wavBase64 } }];
    try {
      const out = await this.callGenerateContent(cfg.modelId, cfg.apiKey, parts, 0.1, 11000);
      const oMatch = out.match(/ORIG\s*:\s*([^\n]+)/i);
      const tMatch = out.match(/TRANS\s*:\s*([^\n]+)/i);
      const orig = oMatch ? oMatch[1].trim() : "";
      const trans = tMatch ? tMatch[1].trim() : "";
      if (/^NONE$/i.test(out.trim()) || /^NONE$/i.test(trans)) {
        this.pendingResults.set(seq, { orig: "", trans: "", preLockedOrig: false });
      } else {
        this.pendingResults.set(seq, { orig, trans, preLockedOrig: false });
      }
    } catch (err) {
      this.pendingResults.set(seq, { orig: "", trans: "", preLockedOrig: false });
      this.cb.onError(err.message || "오디오 통역 오류");
    } finally {
      this.inFlightAudio = Math.max(0, this.inFlightAudio - 1);
      this.commitReadyChunks();
    }
  }

  translateManualText(text) {
    const clean = (text || "").trim();
    if (!clean) return;
    const seq = ++this.seqCounter;
    this.dispatchTimes.set(seq, Date.now());
    this.cb.onOrigClauseLocked(seq, clean);
    this.translateClauseText(seq, clean);
  }

  releaseStalledSequence() {
    while (this.dispatchTimes.has(this.nextCommitSeq)) {
      const sentAt = this.dispatchTimes.get(this.nextCommitSeq);
      if (!this.pendingResults.has(this.nextCommitSeq) && (Date.now() - sentAt > 6000) && this.pendingResults.has(this.nextCommitSeq + 1)) {
        this.dispatchTimes.delete(this.nextCommitSeq);
        this.nextCommitSeq += 1;
      } else break;
    }
    if (this.pendingResults.has(this.nextCommitSeq)) this.commitReadyChunks();
  }

  commitReadyChunks() {
    while (this.pendingResults.has(this.nextCommitSeq)) {
      const seq = this.nextCommitSeq;
      const item = this.pendingResults.get(seq);
      this.pendingResults.delete(seq);
      this.dispatchTimes.delete(seq);
      this.nextCommitSeq += 1;

      if (item && (item.orig || item.trans)) {
        if (item.trans) {
          this.recentTranslations.push(item.trans);
          if (this.recentTranslations.length > 6) this.recentTranslations.shift();
          this.recordSpokenEcho(item.trans);
          this.enqueueSpeech(item.trans);
        }
        this.cb.onChunkCommitted(seq, item.orig, item.trans, item.preLockedOrig);
      }
    }
  }

  pickBestVoice(targetLang) {
    this.refreshVoices();
    if (/Android/i.test(navigator.userAgent) || this.voices.length === 0) return null;
    const prefix = targetLang.slice(0, 2).toLowerCase();
    const candidates = this.voices.filter((v) => v.lang.toLowerCase().startsWith(prefix));
    return candidates.find((v) => /Google|Natural/i.test(v.name)) || candidates[0] || null;
  }

  enqueueSpeech(text) {
    const clean = (text || "").replace(/\s+/g, " ").trim();
    if (!clean) return;
    this.speechQueue.push(clean);
    this.pumpSpeech();
  }

  pumpSpeech() {
    if (this.isSpeaking || this.speechQueue.length === 0 || !("speechSynthesis" in window)) return;

    const text = this.speechQueue.shift();
    const cfg = this.cb.getConfig();
    this.isSpeaking = true;
    this.cb.onSpeakingChange(true);

    const utter = new SpeechSynthesisUtterance(text);
    this.activeUtterance = utter;

    const koChars = (text.match(/[가-힣]/g) || []).length;
    const pInfo = INTERPRETER_LANGS[cfg.partnerLang] || INTERPRETER_LANGS.en;
    const targetLang = koChars >= 2 ? "ko-KR" : pInfo.bcp47;
    utter.lang = targetLang;

    const bestVoice = this.pickBestVoice(targetLang);
    if (bestVoice) utter.voice = bestVoice;

    let rate = parseFloat(cfg.ttsRate) || 1.15;
    if (this.speechQueue.length >= 2) rate = Math.min(1.38, rate + 0.12);
    utter.rate = rate;
    utter.volume = 1.0;

    const armWatchdog = () => {
      if (this.ttsWatchdog) clearTimeout(this.ttsWatchdog);
      this.ttsWatchdog = setTimeout(() => {
        if (this.isSpeaking) {
          try { window.speechSynthesis.cancel(); } catch (e) {}
          this.finishSpeech();
        }
      }, Math.max(15000, text.length * 450));
    };
    armWatchdog();

    utter.onstart = () => armWatchdog();
    utter.onend = () => this.finishSpeech();
    utter.onerror = () => this.finishSpeech();

    try {
      window.speechSynthesis.resume();
      window.speechSynthesis.speak(utter);
    } catch (e) {
      this.finishSpeech();
    }
  }

  finishSpeech() {
    if (this.ttsWatchdog) {
      clearTimeout(this.ttsWatchdog);
      this.ttsWatchdog = null;
    }
    this.isSpeaking = false;
    this.activeUtterance = null;
    if (this.speechQueue.length > 0) {
      this.pumpSpeech();
      return;
    }
    this.muteUntilTime = Date.now() + 300;
    this.cb.onSpeakingChange(false);
  }

  async generateBilingualSummary(dialogueText, elapsedLabel) {
    const cfg = this.cb.getConfig();
    const pInfo = INTERPRETER_LANGS[cfg.partnerLang] || INTERPRETER_LANGS.en;
    const prompt = [
      `다음은 한국어와 ${pInfo.ko}(${pInfo.en}) 동시통역 대화 기록입니다. (${elapsedLabel})`,
      "별표나 샵, 하이픈 글머리 기호를 쓰지 말고 순수 텍스트와 숫자 번호(1., 2., 3., 4.)만 사용해 이중 언어 회의록 요약을 작성하십시오.",
      "먼저 [한국어 회의록 요약] 아래에 1. 전체 대화 주제 및 개요, 2. 주요 논의 안건 및 핵심 내용, 3. 합의 및 결정 사항, 4. 향후 조치 및 후속 일정 순서로 작성하십시오.",
      `다음 줄에 하이픈 20개 구분선(--------------------)만 단독 줄로 넣고, 그 아래에 [${pInfo.native} Meeting Summary] 제목과 함께 동일한 4개 항목을 격식 있는 ${pInfo.ko}(${pInfo.en})로 작성하십시오.`,
      cfg.glossary ? `전문 용어집:\n${cfg.glossary}` : "",
      `대화 기록:\n${dialogueText}`
    ].filter(Boolean).join("\n\n");
    return await this.callGenerateContent(cfg.summaryModelId, cfg.apiKey, [{ text: prompt }], 0.2, 35000);
  }

  downsampleTo16k(buffer, inputRate) {
    if (inputRate === 16000) return buffer;
    const ratio = inputRate / 16000;
    const outLen = Math.round(buffer.length / ratio);
    const out = new Float32Array(outLen);
    let offsetResult = 0, offsetBuffer = 0;
    while (offsetResult < outLen) {
      const nextOffset = Math.round((offsetResult + 1) * ratio);
      let sum = 0, count = 0;
      for (let i = offsetBuffer; i < nextOffset && i < buffer.length; i++) { sum += buffer[i]; count++; }
      out[offsetResult] = count > 0 ? sum / count : 0;
      offsetResult++;
      offsetBuffer = nextOffset;
    }
    return out;
  }

  encodeWavBase64(samples, sampleRate) {
    const buf = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buf);
    const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
    writeStr(0, "RIFF");
    view.setUint32(4, 36 + samples.length * 2, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, "data");
    view.setUint32(40, samples.length * 2, true);
    let offset = 44;
    for (let i = 0; i < samples.length; i++, offset += 2) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
    const bytes = new Uint8Array(buf);
    let bin = "";
    for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
    return window.btoa(bin);
  }

  stop() {
    this.isRunning = false;
    this.driverMode = "none";
    if (this.recRestartTimer) { clearTimeout(this.recRestartTimer); this.recRestartTimer = null; }
    if (this.pauseFlushTimer) { clearTimeout(this.pauseFlushTimer); this.pauseFlushTimer = null; }
    if (this.recognition) {
      const r = this.recognition;
      this.recognition = null;
      try { r.abort(); } catch (e) {}
    }
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }
    if (this.ttsWatchdog) { clearTimeout(this.ttsWatchdog); this.ttsWatchdog = null; }
    if ("speechSynthesis" in window) { try { window.speechSynthesis.cancel(); } catch (e) {} }
    if (this.processor) { this.processor.disconnect(); this.processor = null; }
    if (this.muteGain) { this.muteGain.disconnect(); this.muteGain = null; }
    if (this.inputCtx) { this.inputCtx.close().catch(() => {}); this.inputCtx = null; }
    if (this.stream) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; }

    this.speechQueue = [];
    this.isSpeaking = false;
    this.activeUtterance = null;
    this.pcmBuffer = [];
    this.voiceSamples = 0;
    this.silenceSamples = 0;
    this.lastLiveUnconsumed = "";
  }
}

window.INTERPRETER_LANGS = INTERPRETER_LANGS;
window.GeminiInterpreterEngine = GeminiInterpreterEngine;