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
    this.driverMode = "text_only";
    this.stream = null;
    this.inputCtx = null;
    this.audioSourceNode = null;
    this.analyser = null;
    this.meterTimer = null;
    this.processor = null;
    this.muteGain = null;

    this.outputCtx = null;
    this.outGain = null;
    this.nextPlayTime = 0;
    this.activeSources = new Set();

    this.pcmBuffer = [];
    this.voiceSamples = 0;
    this.silenceSamples = 0;
    this.tickTimer = null;
    this.lastDispatchAt = 0;

    this.seqCounter = 0;
    this.nextCommitSeq = 1;
    this.pendingResults = new Map();
    this.dispatchTimes = new Map();
    this.inFlightCount = 0;

    this.apiCallCount = 0;
    this.estimatedKrw = 0;
    this.modelCooldowns = new Map();
    this.globalBackoffUntil = 0;
    this.restTtsCooldownUntil = 0;

    this.recentOrigList = [];
    this.recentTranslations = [];
    this.spokenEchoHistory = [];

    this.speechQueue = [];
    this.isSpeaking = false;
    this.muteUntilTime = 0;
    this.voices = [];

    if ("speechSynthesis" in window) {
      this.refreshVoices();
      window.speechSynthesis.onvoiceschanged = () => this.refreshVoices();
    }
  }

  resetCostStats() {
    this.apiCallCount = 0;
    this.estimatedKrw = 0;
    if (this.cb.onCostUpdate) this.cb.onCostUpdate(0, 0);
  }

  addUsageCost(modelId, usageMeta, isTtsAudioOut = false) {
    this.apiCallCount += 1;
    const m = (modelId || "").toLowerCase();
    const inTokens = usageMeta?.promptTokenCount || 320;
    const outTokens = (usageMeta?.candidatesTokenCount || 30) + (usageMeta?.thoughtsTokenCount || 0);

    let usd = 0;
    if (isTtsAudioOut) {
      usd = 0.0018;
    } else if (m.includes("flash-lite")) {
      usd = (inTokens * 0.25 + outTokens * 0.40) / 1000000;
    } else if (m.includes("carbon") || m.includes("pro")) {
      usd = (inTokens * 2.00 + outTokens * 12.00) / 1000000;
    } else {
      usd = (inTokens * 0.70 + outTokens * 2.50) / 1000000;
    }

    const cfg = this.cb.getConfig();
    if (cfg.activeTier === "paid") this.estimatedKrw += usd * 1420;
    if (this.cb.onCostUpdate) this.cb.onCostUpdate(this.apiCallCount, Math.round(this.estimatedKrw));
  }

  refreshVoices() {
    if ("speechSynthesis" in window) this.voices = window.speechSynthesis.getVoices() || [];
  }

  pickNeuralBrowserVoice(targetLang) {
    if (/Android/i.test(navigator.userAgent) || this.voices.length === 0) return null;
    const prefix = targetLang.slice(0, 2).toLowerCase();
    const list = this.voices.filter((v) => v.lang.toLowerCase().startsWith(prefix));
    if (list.length === 0) return null;
    list.sort((a, b) => {
      const score = (v) => {
        const n = (v.name || "").toLowerCase();
        return (n.includes("natural") || n.includes("neural") ? 50 : 0) + (n.includes("google") || n.includes("online") ? 30 : 0);
      };
      return score(b) - score(a);
    });
    return list[0];
  }

  unlockAudio(playChime = false) {
    try {
      if (!this.outputCtx || this.outputCtx.state === "closed") {
        this.outputCtx = new (window.AudioContext || window.webkitAudioContext)();
        this.outGain = null;
      }
      if (this.outputCtx.state === "suspended") this.outputCtx.resume();
      if (!this.outGain) {
        this.outGain = this.outputCtx.createGain();
        this.outGain.gain.value = 1.35;
        this.outGain.connect(this.outputCtx.destination);
      }
      if (playChime) {
        const now = this.outputCtx.currentTime;
        const osc = this.outputCtx.createOscillator();
        const g = this.outputCtx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(523.25, now);
        osc.frequency.setValueAtTime(659.25, now + 0.11);
        g.gain.setValueAtTime(0.25, now);
        g.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
        osc.connect(g);
        g.connect(this.outputCtx.destination);
        osc.start(now);
        osc.stop(now + 0.32);
      }
      this.refreshVoices();
    } catch (e) {}
  }

  async testSound() {
    this.unlockAudio(true);
    this.stopSpeechOnly();
    this.muteUntilTime = Date.now() + 3000;
    const msg = "동시통역 음성 출력이 정상 작동합니다.";
    this.recordSpokenEcho(msg);
    this.enqueueSpeech(msg);
  }

  async startWithStream(stream, modeLabel = "mic") {
    this.stop();
    this.isRunning = true;
    this.globalBackoffUntil = 0;
    this.stream = stream || null;
    this.driverMode = this.stream ? modeLabel : "text_only";

    if (this.stream) {
      await this.setupAudioCapture();
      this.cb.onChannelState(modeLabel === "system_audio" ? "PC 소리 수신 중" : "마이크 수신 중", "대기");
    } else if (this.cb.onNoMicFallback) {
      this.cb.onNoMicFallback();
    }
    this.startScheduler();
  }

  restartForModeChange() {
    this.pcmBuffer = [];
    this.voiceSamples = 0;
    this.silenceSamples = 0;
  }

  flushRemainingLiveText() {
    if (this.pcmBuffer.length >= 6400 && this.voiceSamples >= 3200 && Date.now() >= this.globalBackoffUntil) {
      const rest = new Float32Array(this.pcmBuffer);
      this.pcmBuffer = [];
      this.voiceSamples = 0;
      this.silenceSamples = 0;
      const seq = ++this.seqCounter;
      this.dispatchTimes.set(seq, Date.now());
      this.translateAudioSlice(seq, rest);
    }
  }

  shouldMuteMicForEcho() {
    if (this.driverMode !== "mic") return false;
    const cfg = this.cb.getConfig();
    if (cfg.duplexMode === "full_duplex") return false;
    if (cfg.autoMode === "to_ko_only" || cfg.autoMode === "from_ko_only") return false;
    return this.isSpeaking || Date.now() < this.muteUntilTime;
  }

  handleIncomingPcmChunk(rawFloat32, nativeRate) {
    if (!this.isRunning) return;
    if (this.shouldMuteMicForEcho()) {
      this.pcmBuffer = [];
      this.voiceSamples = 0;
      this.silenceSamples = 0;
      return;
    }

    const pcm16k = this.downsampleTo16k(rawFloat32, nativeRate);
    let sum = 0;
    for (let i = 0; i < pcm16k.length; i++) sum += pcm16k[i] * pcm16k[i];
    const rms = Math.sqrt(sum / pcm16k.length);

    for (let i = 0; i < pcm16k.length; i++) this.pcmBuffer.push(pcm16k[i]);
    if (rms > 0.008) {
      this.voiceSamples += pcm16k.length;
      this.silenceSamples = 0;
    } else {
      this.silenceSamples += pcm16k.length;
    }
    if (this.pcmBuffer.length > 112000) this.pcmBuffer = this.pcmBuffer.slice(-80000);
  }

  async setupAudioCapture() {
    this.inputCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.inputCtx.state === "suspended") await this.inputCtx.resume();
    const nativeRate = this.inputCtx.sampleRate || 48000;

    this.audioSourceNode = this.inputCtx.createMediaStreamSource(this.stream);
    this.analyser = this.inputCtx.createAnalyser();
    this.analyser.fftSize = 1024;
    const meterArray = new Float32Array(this.analyser.fftSize);

    this.processor = this.inputCtx.createScriptProcessor(2048, 1, 1);
    this.muteGain = this.inputCtx.createGain();
    this.muteGain.gain.value = 0;

    this.processor.onaudioprocess = (e) => {
      if (!this.isRunning) return;
      this.handleIncomingPcmChunk(e.inputBuffer.getChannelData(0), nativeRate);
    };

    if (this.meterTimer) clearInterval(this.meterTimer);
    this.meterTimer = setInterval(() => {
      if (!this.isRunning || !this.analyser) return;
      if (this.shouldMuteMicForEcho()) {
        this.cb.onVolume(0);
        return;
      }
      this.analyser.getFloatTimeDomainData(meterArray);
      let sum = 0;
      for (let i = 0; i < meterArray.length; i++) sum += meterArray[i] * meterArray[i];
      const rms = Math.sqrt(sum / meterArray.length);
      this.cb.onVolume(Math.min(100, Math.round(rms * 650)));
    }, 60);

    this.audioSourceNode.connect(this.analyser);
    this.analyser.connect(this.processor);
    this.processor.connect(this.muteGain);
    this.muteGain.connect(this.inputCtx.destination);
  }

  findCleanSplitIndex(samples) {
    const len = samples.length;
    const win = 800;
    const start = Math.max(16000, len - 9600);
    let minE = Infinity;
    let best = len;
    for (let p = start; p <= len - win; p += 400) {
      let e = 0;
      for (let j = 0; j < win; j++) e += samples[p + j] * samples[p + j];
      if (e < minE) { minE = e; best = p + 400; }
    }
    return best;
  }

  startScheduler() {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = setInterval(() => {
      if (!this.isRunning) return;
      this.checkAndSliceAudio();
      this.releaseStalledSequence();
    }, 150);
  }

  checkAndSliceAudio() {
    const now = Date.now();
    if (now < this.globalBackoffUntil) return;

    const cfg = this.cb.getConfig();
    const isFree = cfg.activeTier !== "paid";
    const maxConcurrent = isFree ? 1 : 2;
    if (this.pcmBuffer.length === 0 || this.inFlightCount >= maxConcurrent) return;

    const minIntervalMs = isFree ? 4300 : 1300;
    if (now - this.lastDispatchAt < minIntervalMs) return;

    if (this.voiceSamples > 2000) {
      const sec = (this.pcmBuffer.length / 16000).toFixed(1);
      this.cb.onChannelState(`음성 수집 (${sec}초)`, this.isSpeaking ? "음성 송출 중" : "대기");
    }

    const baseMs = Math.max(2000, parseInt(cfg.chunkMs, 10) || 2800);
    const targetMs = isFree ? Math.max(4200, baseMs) : baseMs;
    const targetSamples = Math.round((targetMs / 1000) * 16000);
    const maxSamples = targetSamples + 11200;

    const minBreathLen = isFree ? 48000 : 25600;
    const breathCut = this.pcmBuffer.length >= minBreathLen && this.voiceSamples >= 6400 && this.silenceSamples >= 3520;
    const maxCut = this.pcmBuffer.length >= maxSamples && this.voiceSamples >= 6400;

    if (!breathCut && !maxCut) {
      if (this.voiceSamples < 1600 && this.pcmBuffer.length > 24000) {
        this.pcmBuffer = this.pcmBuffer.slice(-2400);
        this.voiceSamples = 0;
      }
      return;
    }

    let sendSlice = null;
    if (breathCut) {
      sendSlice = new Float32Array(this.pcmBuffer);
      this.pcmBuffer = [];
      this.voiceSamples = 0;
      this.silenceSamples = 0;
    } else {
      const idx = this.findCleanSplitIndex(this.pcmBuffer);
      sendSlice = new Float32Array(this.pcmBuffer.slice(0, idx));
      this.pcmBuffer = this.pcmBuffer.slice(idx);
      this.voiceSamples = Math.floor(this.pcmBuffer.length * 0.4);
      this.silenceSamples = 0;
    }

    this.lastDispatchAt = now;
    const seq = ++this.seqCounter;
    this.dispatchTimes.set(seq, now);
    this.translateAudioSlice(seq, sendSlice);
  }

  normalizeCompact(str) {
    return (str || "").toLowerCase().replace(/[^a-z0-9가-힣\u4e00-\u9fff\u3040-\u30ff]/g, "");
  }

  isNearDuplicate(text, historyList) {
    const norm = this.normalizeCompact(text);
    if (norm.length < 2) return true;
    for (const prev of historyList) {
      const pNorm = this.normalizeCompact(prev);
      if (!pNorm) continue;
      if (norm === pNorm || (pNorm.length >= 8 && pNorm.includes(norm))) return true;
      if (norm.length >= 10 && pNorm.length >= 10) {
        let hit = 0;
        for (let i = 0; i < norm.length - 1; i++) {
          if (pNorm.includes(norm.slice(i, i + 2))) hit++;
        }
        if (hit / (norm.length - 1) >= 0.72 && norm.length <= pNorm.length * 1.25) return true;
      }
    }
    return false;
  }

  recordSpokenEcho(text) {
    const norm = this.normalizeCompact(text);
    if (norm.length < 2) return;
    this.spokenEchoHistory.push({ norm, at: Date.now() });
    if (this.spokenEchoHistory.length > 10) this.spokenEchoHistory.shift();
  }

  isEchoOfSpokenTts(origText) {
    const norm = this.normalizeCompact(origText);
    if (norm.length < 3) return false;
    const now = Date.now();
    for (const item of this.spokenEchoHistory) {
      if (now - item.at > 22000) continue;
      if (item.norm.includes(norm) || (item.norm.length >= 5 && norm.includes(item.norm))) return true;
    }
    return false;
  }

  getHangulRatio(str) {
    const clean = (str || "").replace(/[0-9\s.,?!'"()\-:;\/\\]/g, "");
    if (!clean.length) return 0;
    return ((str || "").match(/[가-힣]/g) || []).length / clean.length;
  }

  validateAndDeduplicate(parsed, cfg) {
    const orig = (parsed.orig || "").trim();
    const trans = (parsed.trans || "").trim();
    if (!orig || !trans) return { orig: "", trans: "" };
    if (this.isEchoOfSpokenTts(orig)) return { orig: "", trans: "" };
    if (this.isNearDuplicate(orig, this.recentOrigList)) return { orig: "", trans: "" };
    if (this.isNearDuplicate(trans, this.recentTranslations)) return { orig: "", trans: "" };

    const oKo = this.getHangulRatio(orig);
    const tKo = this.getHangulRatio(trans);
    if (cfg.autoMode === "to_ko_only" && (oKo > 0.3 || tKo < 0.35)) return { orig: "", trans: "" };
    if (cfg.autoMode === "from_ko_only" && (oKo < 0.25 || tKo > 0.25)) return { orig: "", trans: "" };
    return { orig, trans };
  }

  buildThinkingConfig(modelId) {
    const m = (modelId || "").toLowerCase();
    if (m.includes("flash-lite") || m.includes("3.6-flash")) return { thinkingLevel: "MINIMAL" };
    if (m.startsWith("gemini-3") || m.startsWith("gemini-4")) return { thinkingLevel: "LOW" };
    return undefined;
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

  parseOrigAndTrans(rawText) {
    if (!rawText || /^NONE$/i.test(rawText.trim())) return { orig: "", trans: "" };
    const cleaned = rawText.replace(/```[a-z]*\n?/gi, "").replace(/```/g, "").trim();
    const origM = cleaned.match(/ORIG\s*:\s*(.+)/i);
    const transM = cleaned.match(/TRANS\s*:\s*(.+)/i);
    if (origM && transM) {
      const o = origM[1].trim();
      const t = transM[1].trim();
      if (/^NONE$/i.test(o) || /^NONE$/i.test(t)) return { orig: "", trans: "" };
      return { orig: o, trans: t };
    }
    return { orig: "", trans: "" };
  }

  async callSingleModel(modelId, apiKey, parts, temperature = 0.1, timeoutMs = 8500) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const generationConfig = { temperature };
    const thinkingCfg = this.buildThinkingConfig(modelId);
    if (thinkingCfg) generationConfig.thinkingConfig = thinkingCfg;

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
        const err = new Error(json.error?.message || `HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      this.addUsageCost(modelId, json.usageMetadata, false);
      return this.extractVisibleText(json);
    } finally {
      clearTimeout(timer);
    }
  }

  async callWithSmartFailover(primaryModel, cfg, parts, temperature = 0.1, timeoutMs = 8500) {
    const now = Date.now();
    const candidates = [primaryModel, "gemini-3.5-flash-lite", "gemini-3.8-flash", "gemini-3.6-flash"]
      .filter((m, idx, arr) => m && arr.indexOf(m) === idx);

    let lastErr = null;
    for (const model of candidates) {
      const cdKey = `${cfg.apiKey.slice(-6)}:${model}`;
      if ((this.modelCooldowns.get(cdKey) || 0) > now) continue;

      try {
        return await this.callSingleModel(model, cfg.apiKey, parts, temperature, timeoutMs);
      } catch (err) {
        lastErr = err;
        if (err.status === 429) {
          this.modelCooldowns.set(cdKey, Date.now() + 45000);
          continue;
        }
        if (err.status === 404 || err.status === 403) {
          this.modelCooldowns.set(cdKey, Date.now() + 300000);
          continue;
        }
        break;
      }
    }

    if (lastErr && lastErr.status === 429 && cfg.activeTier === "free" && cfg.backupPaidKey && cfg.backupPaidKey !== cfg.apiKey) {
      if (this.cb.onAutoSwitchPaid) this.cb.onAutoSwitchPaid();
      return await this.callSingleModel(primaryModel, cfg.backupPaidKey, parts, temperature, timeoutMs);
    }

    if (lastErr && lastErr.status === 429) {
      this.globalBackoffUntil = Date.now() + 8000;
      const quotaErr = new Error("호출 한도 초과(429): 유료 키 확인 또는 잠시 대기");
      quotaErr.status = 429;
      throw quotaErr;
    }
    throw lastErr || new Error("API 응답 실패");
  }

  buildCompactDirectionPrompt(cfg) {
    const pInfo = INTERPRETER_LANGS[cfg.partnerLang] || INTERPRETER_LANGS.en;
    const toneDesc = cfg.tone === "formal" ? "격식체" : (cfg.tone === "casual" ? "구어체" : "존댓말");
    if (cfg.autoMode === "to_ko_only") {
      return `[${pInfo.ko}→한국어(${toneDesc})] 한국어 소리는 무시. ${pInfo.ko} 발화만 듣고 ORIG와 한국어 TRANS 출력. 말소리 없으면 NONE.`;
    }
    if (cfg.autoMode === "from_ko_only") {
      return `[한국어→${pInfo.ko}(${toneDesc})] 외국어 소리는 무시. 한국어만 듣고 ORIG와 ${pInfo.en} TRANS 출력. 말소리 없으면 NONE.`;
    }
    return `한국어는 ${pInfo.en}(${toneDesc})로, 외국어는 한국어(${toneDesc})로 통역. 말소리 없으면 NONE.`;
  }

  async translateAudioSlice(seq, float32Samples) {
    const cfg = this.cb.getConfig();
    if (!cfg.apiKey) return;
    this.inFlightCount += 1;
    this.cb.onChannelState("원음 분석 중", `#${seq} 번역 중`);

    const wavBase64 = this.encodeWavBase64(float32Samples, 16000);
    const prevOrig = this.recentOrigList.slice(-1)[0] || "";
    const prompt = [
      this.buildCompactDirectionPrompt(cfg),
      "출력형식(2줄만): ORIG: 원문 / TRANS: 통역문 (직전구절 반복금지)",
      cfg.glossary ? `용어: ${cfg.glossary}` : "",
      prevOrig ? `직전원문: ${prevOrig}` : ""
    ].filter(Boolean).join("\n");

    const parts = [{ text: prompt }, { inlineData: { mimeType: "audio/wav", data: wavBase64 } }];
    try {
      const out = await this.callWithSmartFailover(cfg.modelId, cfg, parts, 0.1, 8500);
      this.pendingResults.set(seq, this.validateAndDeduplicate(this.parseOrigAndTrans(out), cfg));
    } catch (err) {
      this.pendingResults.set(seq, { orig: "", trans: "" });
      if (this.cb.onError) this.cb.onError(err.message || "API 오류", err.status === 429);
    } finally {
      this.inFlightCount = Math.max(0, this.inFlightCount - 1);
      this.commitReadyChunks();
    }
  }

  async translateManualText(text) {
    const cfg = this.cb.getConfig();
    const trimmed = (text || "").trim();
    if (!cfg.apiKey || !trimmed) return;
    const seq = ++this.seqCounter;
    this.dispatchTimes.set(seq, Date.now());
    const pInfo = INTERPRETER_LANGS[cfg.partnerLang] || INTERPRETER_LANGS.en;
    const target = this.getHangulRatio(trimmed) >= 0.3 ? `${pInfo.ko}(${pInfo.en})` : "한국어";

    try {
      const out = await this.callWithSmartFailover(
        cfg.modelId,
        cfg,
        [{ text: `다음 문장을 ${target}로 통역해 결과만 출력:\n${trimmed}` }],
        0.1,
        8500
      );
      this.pendingResults.set(seq, { orig: trimmed, trans: out.trim() });
    } catch (err) {
      this.pendingResults.set(seq, { orig: trimmed, trans: "" });
      if (this.cb.onError) this.cb.onError(err.message || "번역 오류", err.status === 429);
    }
    this.commitReadyChunks();
  }

  releaseStalledSequence() {
    while (this.dispatchTimes.has(this.nextCommitSeq)) {
      const sentAt = this.dispatchTimes.get(this.nextCommitSeq);
      if (!this.pendingResults.has(this.nextCommitSeq) && Date.now() - sentAt > 4500 && this.pendingResults.has(this.nextCommitSeq + 1)) {
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

      if (item && item.trans) {
        this.recentOrigList.push(item.orig);
        if (this.recentOrigList.length > 6) this.recentOrigList.shift();
        this.recentTranslations.push(item.trans);
        if (this.recentTranslations.length > 6) this.recentTranslations.shift();

        this.recordSpokenEcho(item.trans);
        this.enqueueSpeech(item.trans);
        this.cb.onChunkCommitted(seq, item.orig, item.trans);
      } else if (!this.isSpeaking && Date.now() >= this.globalBackoffUntil) {
        this.cb.onChannelState(this.driverMode === "system_audio" ? "PC 소리 수신 중" : "원음 수신 중", "대기");
      }
    }
  }

  enqueueSpeech(text) {
    const clean = (text || "").trim();
    if (!clean) return;
    if (this.speechQueue.length >= 2) {
      const last = this.speechQueue[this.speechQueue.length - 1];
      this.speechQueue = [last + " " + clean];
    } else {
      this.speechQueue.push(clean);
    }
    this.pumpSpeechQueue();
  }

  async pumpSpeechQueue() {
    if (this.isSpeaking || this.speechQueue.length === 0) return;
    this.isSpeaking = true;
    if (this.cb.onSpeakingChange) this.cb.onSpeakingChange(true);

    while (this.speechQueue.length > 0) {
      const text = this.speechQueue.shift();
      const cfg = this.cb.getConfig();
      let playedAi = false;

      if (cfg.activeTier === "paid" && cfg.voiceModel === "hybrid_ai" && cfg.apiKey && Date.now() >= this.restTtsCooldownUntil) {
        playedAi = await this.tryFastGeminiRestTts(text, cfg);
      }
      if (!playedAi) {
        await this.playBrowserNeuralTts(text, cfg);
      }
    }

    this.isSpeaking = false;
    this.muteUntilTime = Date.now() + 500;
    if (this.cb.onSpeakingChange) this.cb.onSpeakingChange(false);
  }

  async tryFastGeminiRestTts(text, cfg) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2400);
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${encodeURIComponent(cfg.apiKey)}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text }] }],
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: cfg.voiceName || "Kore" } }
            }
          }
        }),
        signal: controller.signal
      });
      const json = await res.json();
      if (!res.ok || json.error) {
        this.restTtsCooldownUntil = Date.now() + 60000;
        return false;
      }
      const parts = json?.candidates?.[0]?.content?.parts || [];
      let count = 0;
      for (const p of parts) {
        if (p.inlineData && p.inlineData.data) {
          this.schedulePcm24k(p.inlineData.data, cfg.ttsRate);
          count += 1;
        }
      }
      if (count === 0) return false;
      this.addUsageCost("preview-tts", json.usageMetadata, true);
      await this.waitAudioSourcesDone();
      return true;
    } catch (e) {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  schedulePcm24k(base64Data, ttsRate) {
    this.unlockAudio(false);
    if (!this.outputCtx) return;
    const bin = window.atob(base64Data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

    const offset = (bytes.length > 44 && bytes[0] === 0x52 && bytes[1] === 0x49) ? 44 : 0;
    const samples = Math.floor((bytes.length - offset) / 2);
    if (samples <= 0) return;

    const view = new DataView(bytes.buffer, offset, samples * 2);
    const f32 = new Float32Array(samples);
    for (let i = 0; i < samples; i++) f32[i] = view.getInt16(i * 2, true) / 32768.0;

    const buf = this.outputCtx.createBuffer(1, samples, 24000);
    buf.getChannelData(0).set(f32);

    const src = this.outputCtx.createBufferSource();
    src.buffer = buf;
    const rate = parseFloat(ttsRate) || 1.15;
    src.playbackRate.value = rate;
    src.connect(this.outGain || this.outputCtx.destination);

    const now = this.outputCtx.currentTime;
    if (this.nextPlayTime < now + 0.02) this.nextPlayTime = now + 0.08;
    src.start(this.nextPlayTime);
    this.nextPlayTime += buf.duration / rate;

    this.activeSources.add(src);
    src.onended = () => this.activeSources.delete(src);
  }

  waitAudioSourcesDone() {
    return new Promise((resolve) => {
      const check = () => {
        if (this.activeSources.size === 0) resolve();
        else setTimeout(check, 60);
      };
      check();
    });
  }

  playBrowserNeuralTts(text, cfg) {
    if (!("speechSynthesis" in window)) return Promise.resolve();
    return new Promise((resolve) => {
      this.refreshVoices();
      const utter = new SpeechSynthesisUtterance(text);
      window.__activeTtsUtterance = utter;

      const isKo = this.getHangulRatio(text) >= 0.3;
      const pInfo = INTERPRETER_LANGS[cfg.partnerLang] || INTERPRETER_LANGS.en;
      const targetLang = isKo ? "ko-KR" : pInfo.bcp47;
      utter.lang = targetLang;

      const best = this.pickNeuralBrowserVoice(targetLang);
      if (best) utter.voice = best;

      let rate = parseFloat(cfg.ttsRate) || 1.15;
      if (this.speechQueue.length >= 1) rate = Math.min(1.42, rate + 0.15);
      utter.rate = rate;
      utter.volume = 1.0;

      const guard = setTimeout(() => {
        try { window.speechSynthesis.cancel(); } catch (e) {}
        resolve();
      }, Math.max(4000, text.length * 200));

      utter.onend = () => { clearTimeout(guard); resolve(); };
      utter.onerror = () => { clearTimeout(guard); resolve(); };
      try {
        window.speechSynthesis.resume();
        window.speechSynthesis.speak(utter);
      } catch (e) {
        clearTimeout(guard);
        resolve();
      }
    });
  }

  stopSpeechOnly() {
    this.speechQueue = [];
    for (const s of this.activeSources) {
      try { s.stop(); } catch (e) {}
    }
    this.activeSources.clear();
    if (this.outputCtx) this.nextPlayTime = this.outputCtx.currentTime;
    if ("speechSynthesis" in window) {
      try { window.speechSynthesis.cancel(); } catch (e) {}
    }
    this.isSpeaking = false;
  }

  async generateBilingualSummary(dialogueText, elapsedLabel) {
    const cfg = this.cb.getConfig();
    const pInfo = INTERPRETER_LANGS[cfg.partnerLang] || INTERPRETER_LANGS.en;
    const prompt = [
      `다음은 한국어와 ${pInfo.ko}(${pInfo.en}) 동시통역 대화 기록입니다. (경과 ${elapsedLabel})`,
      "별표나 샵, 하이픈 글머리 기호를 쓰지 말고 순수 텍스트와 숫자 번호(1., 2., 3., 4.)만 사용해 이중 언어 회의록 요약을 작성하십시오.",
      "먼저 [한국어 회의록 요약] 아래에 1. 전체 대화 주제 및 개요, 2. 주요 논의 안건 및 핵심 내용, 3. 합의 및 결정 사항, 4. 향후 조치 및 후속 일정 순서로 작성하십시오.",
      `다음 줄에 하이픈 20개 구분선(--------------------)만 단독 줄로 넣고, 그 아래에 [${pInfo.native} Meeting Summary] 제목과 함께 동일한 4개 항목을 격식 있는 ${pInfo.ko}(${pInfo.en})로 작성하십시오.`,
      cfg.glossary ? `전문 용어집:\n${cfg.glossary}` : "",
      `대화 기록:\n${dialogueText}`
    ].filter(Boolean).join("\n\n");
    return await this.callWithSmartFailover(cfg.summaryModelId, cfg, [{ text: prompt }], 0.2, 35000);
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
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }
    if (this.meterTimer) { clearInterval(this.meterTimer); this.meterTimer = null; }
    this.stopSpeechOnly();
    if (this.audioSourceNode) { this.audioSourceNode.disconnect(); this.audioSourceNode = null; }
    if (this.analyser) { this.analyser.disconnect(); this.analyser = null; }
    if (this.processor) { this.processor.disconnect(); this.processor = null; }
    if (this.muteGain) { this.muteGain.disconnect(); this.muteGain = null; }
    if (this.inputCtx) { this.inputCtx.close().catch(() => {}); this.inputCtx = null; }
    if (this.stream) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; }
    this.pcmBuffer = [];
    this.voiceSamples = 0;
    this.silenceSamples = 0;
    if (this.cb.onVolume) this.cb.onVolume(0);
  }
}

window.INTERPRETER_LANGS = INTERPRETER_LANGS;
window.GeminiInterpreterEngine = GeminiInterpreterEngine;