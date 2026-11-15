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

    this.preRollBuffer = [];
    this.pcmBuffer = [];
    this.isCollectingSpeech = false;
    this.voiceSamples = 0;
    this.silenceSamples = 0;
    this.audioJobQueue = [];
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
    const inTokens = usageMeta?.promptTokenCount || 360;
    const outTokens = (usageMeta?.candidatesTokenCount || 35) + (usageMeta?.thoughtsTokenCount || 0);

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
    const msg = "앞부분 누락 방지 동시통역 엔진이 준비되었습니다.";
    this.recordSpokenEcho(msg);
    this.enqueueSpeech(msg);
  }

  async start(customStream = null) {
    if (customStream) {
      return this.startWithStream(customStream, "system_audio");
    }
    try {
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      return this.startWithStream(mic, "mic");
    } catch (e) {
      return this.startWithStream(null, "text_only");
    }
  }

  async startWithStream(stream, modeLabel = "mic") {
    this.stop();
    this.isRunning = true;
    this.globalBackoffUntil = 0;

    let finalStream = stream || null;
    const cfg = this.cb.getConfig();
    const isAndroid = /Android/i.test(navigator.userAgent);

    if (finalStream && modeLabel === "mic" && isAndroid && (cfg.autoMode !== "auto_both" || cfg.duplexMode === "full_duplex")) {
      try {
        const rawMic = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: true
          }
        });
        finalStream.getTracks().forEach((t) => t.stop());
        finalStream = rawMic;
      } catch (e) {}
    }

    this.stream = finalStream;
    this.driverMode = this.stream ? modeLabel : "text_only";

    if (this.stream) {
      await this.setupAudioCapture();
      this.cb.onChannelState(modeLabel === "system_audio" ? "PC 소리 수신 중" : "연속 수음 중", "대기");
    } else if (this.cb.onNoMicFallback) {
      this.cb.onNoMicFallback();
    }
    this.startScheduler();
    return this.driverMode;
  }

  restartForModeChange() {
    this.preRollBuffer = [];
    this.pcmBuffer = [];
    this.audioJobQueue = [];
    this.isCollectingSpeech = false;
    this.voiceSamples = 0;
    this.silenceSamples = 0;
  }

  flushRemainingLiveText() {
    if (this.pcmBuffer.length >= 8000 && this.voiceSamples >= 3200 && Date.now() >= this.globalBackoffUntil) {
      const rest = new Float32Array(this.pcmBuffer);
      this.pcmBuffer = [];
      this.preRollBuffer = [];
      this.isCollectingSpeech = false;
      this.voiceSamples = 0;
      this.silenceSamples = 0;
      const seq = ++this.seqCounter;
      this.dispatchTimes.set(seq, Date.now());
      this.translateAudioSlice(seq, rest, false);
    }
  }

  shouldMuteMicForEcho() {
    if (this.driverMode !== "mic") return false;
    const cfg = this.cb.getConfig();
    if (cfg.duplexMode === "full_duplex") return false;
    if (cfg.autoMode === "to_ko_only" || cfg.autoMode === "from_ko_only") return false;
    return this.isSpeaking || Date.now() < this.muteUntilTime;
  }

  // 발화 시작 전 0.65초(10400샘플) 프리롤 버퍼를 상시 유지하여 문장 첫 음절 잘림을 원천 차단
  handleIncomingPcmChunk(rawFloat32, nativeRate) {
    if (!this.isRunning) return;
    if (this.shouldMuteMicForEcho()) {
      this.preRollBuffer = [];
      this.pcmBuffer = [];
      this.isCollectingSpeech = false;
      this.voiceSamples = 0;
      this.silenceSamples = 0;
      return;
    }

    const pcm16k = this.downsampleTo16k(rawFloat32, nativeRate);
    let sum = 0;
    for (let i = 0; i < pcm16k.length; i++) sum += pcm16k[i] * pcm16k[i];
    const rms = Math.sqrt(sum / pcm16k.length);
    const hasVoiceEnergy = rms > 0.0042;

    if (!this.isCollectingSpeech) {
      for (let i = 0; i < pcm16k.length; i++) this.preRollBuffer.push(pcm16k[i]);
      if (this.preRollBuffer.length > 10400) {
        this.preRollBuffer = this.preRollBuffer.slice(-10400);
      }
      if (hasVoiceEnergy) {
        this.pcmBuffer = this.preRollBuffer.slice();
        this.preRollBuffer = [];
        this.isCollectingSpeech = true;
        this.voiceSamples = pcm16k.length;
        this.silenceSamples = 0;
      }
    } else {
      for (let i = 0; i < pcm16k.length; i++) this.pcmBuffer.push(pcm16k[i]);
      if (hasVoiceEnergy) {
        this.voiceSamples += pcm16k.length;
        this.silenceSamples = 0;
      } else {
        this.silenceSamples += pcm16k.length;
        if (this.voiceSamples < 3200 && this.silenceSamples >= 12800) {
          this.preRollBuffer = this.pcmBuffer.slice(-10400);
          this.pcmBuffer = [];
          this.isCollectingSpeech = false;
          this.voiceSamples = 0;
          this.silenceSamples = 0;
        }
      }
    }
  }

  async setupAudioCapture() {
    this.inputCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.inputCtx.state === "suspended") await this.inputCtx.resume();
    const nativeRate = this.inputCtx.sampleRate || 48000;

    this.audioSourceNode = this.inputCtx.createMediaStreamSource(this.stream);
    this.analyser = this.inputCtx.createAnalyser();
    this.analyser.fftSize = 1024;
    const meterArray = new Float32Array(this.analyser.fftSize);

    this.processor = this.inputCtx.createScriptProcessor(4096, 1, 1);
    this.muteGain = this.inputCtx.createGain();
    this.muteGain.gain.value = 0;

    this.processor.onaudioprocess = (e) => {
      if (!this.isRunning) return;
      if (this.outputCtx && this.outputCtx.state === "suspended") {
        this.outputCtx.resume().catch(() => {});
      }
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
      this.cb.onVolume(Math.min(100, Math.round(rms * 720)));
    }, 80);

    this.audioSourceNode.connect(this.analyser);
    this.analyser.connect(this.processor);
    this.processor.connect(this.muteGain);
    this.muteGain.connect(this.inputCtx.destination);
  }

  findCleanSplitIndex(samples, limitLen) {
    const len = Math.min(samples.length, limitLen);
    const win = 800;
    const start = Math.max(20000, len - 14400);
    let minE = Infinity;
    let best = len;
    for (let p = start; p <= len - win; p += 320) {
      let e = 0;
      for (let j = 0; j < win; j++) e += samples[p + j] * samples[p + j];
      if (e < minE) {
        minE = e;
        best = p + 400;
      }
    }
    return best;
  }

  startScheduler() {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = setInterval(() => {
      if (!this.isRunning) return;
      this.sliceAudioIntoQueue();
      this.pumpAudioJobQueue();
      this.releaseStalledSequence();
    }, 150);
  }

  sliceAudioIntoQueue() {
    if (!this.isCollectingSpeech || this.pcmBuffer.length === 0) return;

    const cfg = this.cb.getConfig();
    const isFree = cfg.activeTier !== "paid";
    const baseMs = Math.max(2400, parseInt(cfg.chunkMs, 10) || 3000);
    const minClauseSamples = Math.round(((isFree ? Math.max(3800, baseMs) : baseMs) / 1000) * 16000);
    const maxClauseSamples = minClauseSamples + 27200; // 문맥 유지를 위해 최대 +1.7초까지 자연 휴지 탐색

    if (this.voiceSamples > 1600) {
      const sec = (this.pcmBuffer.length / 16000).toFixed(1);
      this.cb.onChannelState(`문장 수음 중 (${sec}초)`, this.isSpeaking ? "음성 송출 중" : "대기");
    }

    const sentenceEndCut = this.pcmBuffer.length >= 22400 && this.voiceSamples >= 5600 && this.silenceSamples >= 8000;
    const clauseBreathCut = this.pcmBuffer.length >= minClauseSamples && this.voiceSamples >= 6400 && this.silenceSamples >= 3520;
    const maxContinuousCut = this.pcmBuffer.length >= maxClauseSamples && this.voiceSamples >= 6400;

    if (!sentenceEndCut && !clauseBreathCut && !maxContinuousCut) return;

    let sendSlice = null;
    let hasPrefixOverlap = false;

    if (sentenceEndCut || clauseBreathCut) {
      sendSlice = new Float32Array(this.pcmBuffer);
      this.preRollBuffer = this.pcmBuffer.slice(-6400);
      this.pcmBuffer = [];
      this.isCollectingSpeech = false;
      this.voiceSamples = 0;
      this.silenceSamples = 0;
      hasPrefixOverlap = false;
    } else {
      const idx = this.findCleanSplitIndex(this.pcmBuffer, maxClauseSamples);
      sendSlice = new Float32Array(this.pcmBuffer.slice(0, idx));
      // 연속 연설 강제 분할 시 다음 구절 첫 단어 손실 방지를 위해 직전 0.35초(5600샘플)를 앞머리에 보존
      const overlapStart = Math.max(0, idx - 5600);
      this.pcmBuffer = this.pcmBuffer.slice(overlapStart);
      this.isCollectingSpeech = true;
      this.voiceSamples = Math.floor(this.pcmBuffer.length * 0.5);
      this.silenceSamples = 0;
      hasPrefixOverlap = true;
    }

    this.audioJobQueue.push({ samples: sendSlice, overlapped: hasPrefixOverlap });
    if (this.audioJobQueue.length > 10) {
      this.audioJobQueue.shift();
    }
  }

  pumpAudioJobQueue() {
    const now = Date.now();
    if (now < this.globalBackoffUntil || this.audioJobQueue.length === 0) return;

    const cfg = this.cb.getConfig();
    const isFree = cfg.activeTier !== "paid";
    const maxConcurrent = isFree ? 1 : 3;
    const minIntervalMs = isFree ? 4300 : 500;

    while (this.audioJobQueue.length > 0 && this.inFlightCount < maxConcurrent) {
      if (Date.now() - this.lastDispatchAt < minIntervalMs) break;
      const job = this.audioJobQueue.shift();
      this.lastDispatchAt = Date.now();
      const seq = ++this.seqCounter;
      this.dispatchTimes.set(seq, this.lastDispatchAt);
      this.translateAudioSlice(seq, job.samples, job.overlapped);
    }
  }

  // 원거리 유튜브 스피커의 작은 첫머리 발음도 선명하게 들리도록 피크 음량 자동 증폭
  normalizeAudioSlice(samples) {
    let peak = 0;
    for (let i = 0; i < samples.length; i++) {
      const a = Math.abs(samples[i]);
      if (a > peak) peak = a;
    }
    if (peak < 0.006 || peak >= 0.82) return samples;
    const gain = Math.min(8.0, 0.85 / peak);
    const out = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      out[i] = Math.max(-0.98, Math.min(0.98, samples[i] * gain));
    }
    return out;
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
      if (norm === pNorm || (pNorm.length >= 14 && norm.length >= 8 && pNorm.includes(norm))) return true;
      if (norm.length >= 16 && pNorm.length >= 16) {
        let hit = 0;
        for (let i = 0; i < norm.length - 1; i++) {
          if (pNorm.includes(norm.slice(i, i + 2))) hit++;
        }
        if (hit / (norm.length - 1) >= 0.84 && norm.length <= pNorm.length * 1.15) return true;
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
    if (cfg.autoMode === "to_ko_only" && (oKo > 0.35 || tKo < 0.3)) return { orig: "", trans: "" };
    if (cfg.autoMode === "from_ko_only" && (oKo < 0.25 || tKo > 0.3)) return { orig: "", trans: "" };
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

  async callSingleModel(modelId, apiKey, parts, temperature = 0.1, timeoutMs = 12000) {
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

  async callWithSmartFailover(primaryModel, cfg, parts, temperature = 0.1, timeoutMs = 12000) {
    const now = Date.now();
    // 유료 키 사용 시 문맥과 앞부분 청취력이 뛰어난 gemini-3.8-flash를 최우선 후보에 포함
    const effectivePrimary = (cfg.activeTier === "paid" && primaryModel === "gemini-3.5-flash-lite")
      ? "gemini-3.8-flash"
      : primaryModel;
    const candidates = [effectivePrimary, "gemini-3.8-flash", "gemini-3.5-flash-lite", "gemini-3.6-flash"]
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
      return await this.callSingleModel("gemini-3.8-flash", cfg.backupPaidKey, parts, temperature, timeoutMs);
    }

    if (lastErr && lastErr.status === 429) {
      this.globalBackoffUntil = Date.now() + 8000;
      const quotaErr = new Error("호출 한도 초과(429): 유료 키 확인 또는 잠시 대기");
      quotaErr.status = 429;
      throw quotaErr;
    }
    throw lastErr || new Error("통신 지연");
  }

  buildCompactDirectionPrompt(cfg) {
    const pInfo = INTERPRETER_LANGS[cfg.partnerLang] || INTERPRETER_LANGS.en;
    const toneDesc = cfg.tone === "formal" ? "격식체" : (cfg.tone === "casual" ? "구어체" : "존댓말");
    if (cfg.autoMode === "to_ko_only") {
      return `[${pInfo.ko}→한국어(${toneDesc})] 배경에 섞인 한국어 통역기 소리는 무시하되, 오디오의 맨 앞 첫 단어부터 끝 단어까지 ${pInfo.ko}(${pInfo.en}) 발화를 앞부분 생략 없이 전부 받아적고(ORIG) 정확한 의미의 한국어(TRANS)로 번역하십시오. ${pInfo.ko} 말소리가 전혀 없으면 NONE만 출력.`;
    }
    if (cfg.autoMode === "from_ko_only") {
      return `[한국어→${pInfo.ko}(${toneDesc})] 외국어 에코는 무시하되, 오디오 맨 앞 첫 단어부터 끝 단어까지 한국어 발화를 생략 없이 전부 받아적고(ORIG) 자연스러운 ${pInfo.en}(TRANS)로 번역하십시오. 한국어 말소리가 없으면 NONE만 출력.`;
    }
    return `오디오의 첫 단어부터 끝까지 생략 없이 받아적고(ORIG), 한국어는 ${pInfo.en}(${toneDesc})로, 외국어는 한국어(${toneDesc})로 통역(TRANS). 말소리 없으면 NONE.`;
  }

  async translateAudioSlice(seq, float32Samples, hasPrefixOverlap = false) {
    const cfg = this.cb.getConfig();
    if (!cfg.apiKey) return;
    this.inFlightCount += 1;
    this.cb.onChannelState("연속 수음 중", `#${seq} 정밀 통역 중`);

    const boostedSamples = this.normalizeAudioSlice(float32Samples);
    const wavBase64 = this.encodeWavBase64(boostedSamples, 16000);

    const lastOrig = this.recentOrigList.slice(-1)[0] || "";
    const lastOrigTail = lastOrig ? lastOrig.split(/\s+/).slice(-4).join(" ") : "";
    const lastTrans = this.recentTranslations.slice(-1)[0] || "";

    const prompt = [
      this.buildCompactDirectionPrompt(cfg),
      hasPrefixOverlap && lastOrigTail
        ? `경계 참고: 오디오 시작부 0.3초에 직전 끝단어("${lastOrigTail}")와 똑같은 단어가 겹치면 그 겹친 1~2단어만 빼고 바로 다음 단어부터 끝까지 빠짐없이 작성하십시오.`
        : "주의: 오디오 앞부분의 주어·접속사·동사를 절대 생략하지 말고 첫 음절부터 끝까지 온전히 받아적고 번역하십시오.",
      lastTrans ? `직전 번역 문맥(내용 연결 참고용): ${lastTrans}` : "",
      cfg.glossary ? `전문 용어: ${cfg.glossary}` : "",
      "출력형식(설명 없이 정확히 2줄만):",
      "ORIG: 들린 원문 전체",
      "TRANS: 문맥에 맞는 정확한 통역문"
    ].filter(Boolean).join("\n");

    const parts = [{ text: prompt }, { inlineData: { mimeType: "audio/wav", data: wavBase64 } }];
    try {
      const out = await this.callWithSmartFailover(cfg.modelId, cfg, parts, 0.1, 12000);
      this.pendingResults.set(seq, this.validateAndDeduplicate(this.parseOrigAndTrans(out), cfg));
    } catch (err) {
      this.pendingResults.set(seq, { orig: "", trans: "" });
      if (this.cb.onError) this.cb.onError(err.message || "API 지연", err.status === 429);
    } finally {
      this.inFlightCount = Math.max(0, this.inFlightCount - 1);
      this.commitReadyChunks();
      this.pumpAudioJobQueue();
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
        [{ text: `다음 문장을 앞뒤 생략 없이 ${target}로 정확히 통역해 결과만 출력:\n${trimmed}` }],
        0.1,
        10000
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
      if (!this.pendingResults.has(this.nextCommitSeq) && Date.now() - sentAt > 13000 && this.pendingResults.has(this.nextCommitSeq + 1)) {
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
        this.cb.onChannelState(this.driverMode === "system_audio" ? "PC 소리 수신 중" : "연속 수음 중", "대기");
      }
    }
  }

  enqueueSpeech(text) {
    const clean = (text || "").trim();
    if (!clean) return;
    if (this.isSpeaking && this.speechQueue.length >= 1) {
      this.speechQueue = [this.speechQueue.join(" ") + " " + clean];
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
    this.muteUntilTime = Date.now() + 450;
    if (this.cb.onSpeakingChange) this.cb.onSpeakingChange(false);
  }

  async tryFastGeminiRestTts(text, cfg) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3200);
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

      const isAndroid = /Android/i.test(navigator.userAgent);
      if (!isAndroid) {
        const best = this.pickNeuralBrowserVoice(targetLang);
        if (best) utter.voice = best;
      }

      let rate = parseFloat(cfg.ttsRate) || 1.15;
      if (text.length > 45 || this.speechQueue.length >= 1) {
        rate = Math.min(1.38, rate + 0.12);
      }
      utter.rate = rate;
      utter.volume = 1.0;

      const guard = setTimeout(() => {
        try { window.speechSynthesis.cancel(); } catch (e) {}
        resolve();
      }, Math.max(9000, text.length * 350));

      utter.onend = () => { clearTimeout(guard); resolve(); };
      utter.onerror = () => { clearTimeout(guard); resolve(); };
      try {
        if (!isAndroid && window.speechSynthesis.paused) {
          window.speechSynthesis.resume();
        }
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
    this.preRollBuffer = [];
    this.pcmBuffer = [];
    this.audioJobQueue = [];
    this.isCollectingSpeech = false;
    this.voiceSamples = 0;
    this.silenceSamples = 0;
    if (this.cb.onVolume) this.cb.onVolume(0);
  }
}

window.INTERPRETER_LANGS = INTERPRETER_LANGS;
window.GeminiInterpreterEngine = GeminiInterpreterEngine;