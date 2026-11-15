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
    this.isVoiceMuted = false;
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
    this.lastCommitAt = 0;

    this.apiCallCount = 0;
    this.estimatedKrw = 0;
    this.modelCooldowns = new Map();
    this.globalBackoffUntil = 0;
    this.restTtsCooldownUntil = 0;

    this.recentOrigList = [];
    this.recentTranslations = [];
    this.spokenEchoHistory = [];

    this.speechQueue = [];
    this.currentActiveText = "";
    this.volRestartTimer = null;
    this.isSpeaking = false;
    this.muteUntilTime = 0;
    this.voices = [];

    if ("speechSynthesis" in window) {
      this.refreshVoices();
      window.speechSynthesis.onvoiceschanged = () => this.refreshVoices();
    }
  }

  setVoiceMuted(muted, replayRecent = false) {
    this.isVoiceMuted = !!muted;
    if (this.isVoiceMuted) {
      this.stopSpeechOnly();
      if (this.cb.onSpeakingChange) this.cb.onSpeakingChange(false);
    } else {
      this.applyOutputVolume(false);
      if (replayRecent && this.isRunning && this.recentTranslations.length >= 1 && (Date.now() - this.lastCommitAt < 10000)) {
        const latest = this.recentTranslations[this.recentTranslations.length - 1];
        if (latest) this.enqueueSpeech(latest);
      }
    }
  }

  applyOutputVolume(restartActiveBrowserSpeech = false) {
    if (this.outGain && this.outputCtx) {
      const cfg = this.cb.getConfig();
      const vol = this.isVoiceMuted ? 0 : Math.max(0, Math.min(1, parseFloat(cfg.ttsVolume ?? "1.0")));
      this.outGain.gain.setValueAtTime(1.35 * vol, this.outputCtx.currentTime);
    }

    if (restartActiveBrowserSpeech && !this.isVoiceMuted && this.isSpeaking && this.currentActiveText && "speechSynthesis" in window) {
      if (this.volRestartTimer) clearTimeout(this.volRestartTimer);
      this.volRestartTimer = setTimeout(() => {
        if (!this.isVoiceMuted && this.isSpeaking && this.currentActiveText) {
          const replayText = this.currentActiveText;
          this.currentActiveText = "";
          this.speechQueue.unshift(replayText);
          try { window.speechSynthesis.cancel(); } catch (e) {}
        }
      }, 180);
    }
  }

  playInstantFeedbackTone(volFloat, isMutedTone = false) {
    try {
      this.unlockAudio(false);
      if (!this.outputCtx) return;
      const now = this.outputCtx.currentTime;
      const osc = this.outputCtx.createOscillator();
      const g = this.outputCtx.createGain();
      osc.type = "sine";
      if (isMutedTone) {
        osc.frequency.setValueAtTime(320, now);
        g.gain.setValueAtTime(0.12, now);
      } else {
        osc.frequency.setValueAtTime(460 + volFloat * 260, now);
        g.gain.setValueAtTime(Math.max(0.05, 0.35 * volFloat), now);
      }
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
      osc.connect(g);
      g.connect(this.outputCtx.destination);
      osc.start(now);
      osc.stop(now + 0.13);
    } catch (e) {}
  }

  resetCostStats() {
    this.apiCallCount = 0;
    this.estimatedKrw = 0;
    if (this.cb.onCostUpdate) this.cb.onCostUpdate(0, 0);
  }

  addUsageCost(modelId, usageMeta, isTtsAudioOut = false) {
    this.apiCallCount += 1;
    const m = (modelId || "").toLowerCase();
    const inTokens = usageMeta?.promptTokenCount || 450;
    const outTokens = (usageMeta?.candidatesTokenCount || 65) + (usageMeta?.thoughtsTokenCount || 0);

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
        this.outGain.connect(this.outputCtx.destination);
      }
      this.applyOutputVolume(false);

      if (playChime && !this.isVoiceMuted) {
        const cfg = this.cb.getConfig();
        const vol = Math.max(0.1, Math.min(1, parseFloat(cfg.ttsVolume ?? "1.0")));
        this.playInstantFeedbackTone(vol, false);
      }
      this.refreshVoices();
    } catch (e) {}
  }

  async testSound() {
    if (this.isVoiceMuted) {
      this.isVoiceMuted = false;
      if (this.cb.onForceUnmute) this.cb.onForceUnmute();
    }
    this.unlockAudio(true);
    this.stopSpeechOnly();
    this.muteUntilTime = Date.now() + 3000;
    const cfg = this.cb.getConfig();
    const pct = Math.round(parseFloat(cfg.ttsVolume ?? "1.0") * 100);
    const msg = `무삭제 완역 모드가 음량 ${pct}퍼센트로 준비되었습니다.`;
    this.recordSpokenEcho(msg);
    this.enqueueSpeech(msg);
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
          audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: true }
        });
        finalStream.getTracks().forEach((t) => t.stop());
        finalStream = rawMic;
      } catch (e) {}
    }

    this.stream = finalStream;
    this.driverMode = this.stream ? modeLabel : "text_only";

    if (this.stream) {
      await this.setupAudioCapture();
      this.cb.onChannelState(modeLabel === "system_audio" ? "PC 소리 수신 중" : "문장 전체 수음 중", this.isVoiceMuted ? "음성 꺼짐(자막전용)" : "대기");
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
    if (this.pcmBuffer.length >= 12000 && this.voiceSamples >= 4800 && Date.now() >= this.globalBackoffUntil) {
      const rest = new Float32Array(this.pcmBuffer);
      this.pcmBuffer = [];
      this.preRollBuffer = [];
      this.isCollectingSpeech = false;
      this.voiceSamples = 0;
      this.silenceSamples = 0;
      const seq = ++this.seqCounter;
      this.dispatchTimes.set(seq, Date.now());
      this.translateAudioSlice(seq, rest);
    }
  }

  shouldMuteMicForEcho() {
    if (this.driverMode !== "mic" || this.isVoiceMuted) return false;
    const cfg = this.cb.getConfig();
    if (cfg.duplexMode === "full_duplex") return false;
    if (cfg.autoMode === "to_ko_only" || cfg.autoMode === "from_ko_only") return false;
    return this.isSpeaking || Date.now() < this.muteUntilTime;
  }

  // 발화 전 0.85초(13600샘플) 프리롤을 보존하고 약한 중간 구절에서도 절대 버퍼를 비우지 않음
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
    const hasVoiceEnergy = rms > 0.0038;

    if (!this.isCollectingSpeech) {
      for (let i = 0; i < pcm16k.length; i++) this.preRollBuffer.push(pcm16k[i]);
      if (this.preRollBuffer.length > 13600) {
        this.preRollBuffer = this.preRollBuffer.slice(-13600);
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
        // 0.1초 미만의 단순 클릭 잡음만 들어오고 1.3초 이상 침묵일 때만 대기 상태로 복귀
        if (this.voiceSamples < 1600 && this.silenceSamples >= 20800) {
          this.preRollBuffer = this.pcmBuffer.slice(-13600);
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
      if (!this.isVoiceMuted && this.outputCtx && this.outputCtx.state === "suspended") {
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

  // 무호흡 연속 발화 시 단어 중간이 잘리지 않도록 가장 조용한 골짜기 지점을 정밀 탐색
  findCleanSplitIndex(samples, limitLen) {
    const len = Math.min(samples.length, limitLen);
    const win = 960; // 60ms 무음 구간 탐색
    const start = Math.max(48000, len - 32000);
    let minE = Infinity;
    let best = len;
    for (let p = start; p <= len - win; p += 240) {
      let e = 0;
      for (let j = 0; j < win; j++) e += samples[p + j] * samples[p + j];
      if (e < minE) {
        minE = e;
        best = p + 480;
      }
    }
    return best;
  }

  resolveSentenceWindowSamples(cfg) {
    const raw = parseInt(cfg.chunkMs, 10) || 3000;
    let minMs = 5500;
    let maxMs = 9200;
    if (raw <= 2500) {
      minMs = 4200;
      maxMs = 7600;
    } else if (raw >= 3500) {
      minMs = 6800;
      maxMs = 10800;
    }
    return {
      minClauseSamples: Math.round((minMs / 1000) * 16000),
      maxClauseSamples: Math.round((maxMs / 1000) * 16000)
    };
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

  // 0.22초 조각 절단을 폐지하고 온전한 문장 호흡 단위로만 절단하여 어순 붕괴와 중간 누락을 차단
  sliceAudioIntoQueue() {
    if (!this.isCollectingSpeech || this.pcmBuffer.length === 0) return;

    const cfg = this.cb.getConfig();
    const { minClauseSamples, maxClauseSamples } = this.resolveSentenceWindowSamples(cfg);

    if (this.voiceSamples > 1600) {
      const sec = (this.pcmBuffer.length / 16000).toFixed(1);
      const rightLabel = this.isVoiceMuted ? "음성 꺼짐(자막전용)" : (this.isSpeaking ? "음성 송출 중" : "대기");
      this.cb.onChannelState(`완전 문장 수음 (${sec}초)`, rightLabel);
    }

    // 1) 화자가 문장을 완전히 끝맺고 0.78초(12480샘플) 이상 확실히 멈췄을 때 절단
    const fullSentenceStop = this.pcmBuffer.length >= 32000 && this.voiceSamples >= 9600 && this.silenceSamples >= 12480;
    // 2) 최소 5.5초 이상 충분한 문맥이 모인 뒤 0.48초(7680샘플) 절 경계 숨고르기가 나왔을 때 절단
    const coherentClauseStop = this.pcmBuffer.length >= minClauseSamples && this.voiceSamples >= 16000 && this.silenceSamples >= 7680;
    // 3) 쉼 없이 9초 이상 이어지는 빠른 연설일 때 단어 사이 무음 골짜기에서 무손실 연결 분할
    const maxContinuousSplit = this.pcmBuffer.length >= maxClauseSamples && this.voiceSamples >= 16000;

    if (!fullSentenceStop && !coherentClauseStop && !maxContinuousSplit) return;

    let sendSlice = null;
    if (fullSentenceStop || coherentClauseStop) {
      sendSlice = new Float32Array(this.pcmBuffer);
      this.preRollBuffer = this.pcmBuffer.slice(-4800);
      this.pcmBuffer = [];
      this.isCollectingSpeech = false;
      this.voiceSamples = 0;
      this.silenceSamples = 0;
    } else {
      const idx = this.findCleanSplitIndex(this.pcmBuffer, maxClauseSamples);
      sendSlice = new Float32Array(this.pcmBuffer.slice(0, idx));
      // 오버랩 삭제 지시 없이 분할점 직후부터 1샘플도 빠짐없이 다음 문장으로 이어붙임
      this.pcmBuffer = this.pcmBuffer.slice(idx);
      this.isCollectingSpeech = this.pcmBuffer.length > 0;
      this.voiceSamples = Math.floor(this.pcmBuffer.length * 0.6);
      this.silenceSamples = 0;
    }

    this.audioJobQueue.push(sendSlice);
    if (this.audioJobQueue.length > 30) {
      this.audioJobQueue.shift();
    }
  }

  pumpAudioJobQueue() {
    const now = Date.now();
    if (now < this.globalBackoffUntil || this.audioJobQueue.length === 0) return;

    const cfg = this.cb.getConfig();
    const isFree = cfg.activeTier !== "paid";
    const maxConcurrent = isFree ? 1 : 3;
    const minIntervalMs = isFree ? 4300 : 400;

    while (this.audioJobQueue.length > 0 && this.inFlightCount < maxConcurrent) {
      if (Date.now() - this.lastDispatchAt < minIntervalMs) break;
      const slice = this.audioJobQueue.shift();
      this.lastDispatchAt = Date.now();
      const seq = ++this.seqCounter;
      this.dispatchTimes.set(seq, this.lastDispatchAt);
      this.translateAudioSlice(seq, slice);
    }
  }

  normalizeAudioSlice(samples) {
    let peak = 0;
    for (let i = 0; i < samples.length; i++) {
      const a = Math.abs(samples[i]);
      if (a > peak) peak = a;
    }
    if (peak < 0.005 || peak >= 0.85) return samples;
    const gain = Math.min(8.5, 0.88 / peak);
    const out = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      out[i] = Math.max(-0.98, Math.min(0.98, samples[i] * gain));
    }
    return out;
  }

  normalizeCompact(str) {
    return (str || "").toLowerCase().replace(/[^a-z0-9가-힣\u4e00-\u9fff\u3040-\u30ff]/g, "");
  }

  recordSpokenEcho(text) {
    const norm = this.normalizeCompact(text);
    if (norm.length < 2) return;
    this.spokenEchoHistory.push({ norm, at: Date.now() });
    if (this.spokenEchoHistory.length > 10) this.spokenEchoHistory.shift();
  }

  isEchoOfSpokenTts(origText) {
    if (this.isVoiceMuted) return false;
    const norm = this.normalizeCompact(origText);
    if (norm.length < 4) return false;
    const now = Date.now();
    for (const item of this.spokenEchoHistory) {
      if (now - item.at > 20000) continue;
      if (item.norm === norm || (item.norm.length >= 10 && norm.length >= 8 && item.norm.includes(norm))) {
        return true;
      }
    }
    return false;
  }

  getHangulRatio(str) {
    const clean = (str || "").replace(/[0-9\s.,?!'"()\-:;\/\\]/g, "");
    if (!clean.length) return 0;
    return ((str || "").match(/[가-힣]/g) || []).length / clean.length;
  }

  // 고유명사·숫자가 포함된 중간 구절을 오삭제하던 필터를 제거하고 100% 동일 에코만 걸러냄
  validateResult(parsed, cfg) {
    const orig = (parsed.orig || "").trim();
    const trans = (parsed.trans || "").trim();
    if (!orig || !trans) return { orig: "", trans: "" };
    if (this.isEchoOfSpokenTts(orig)) return { orig: "", trans: "" };

    const normOrig = this.normalizeCompact(orig);
    const lastOrig = this.recentOrigList.length > 0 ? this.normalizeCompact(this.recentOrigList[this.recentOrigList.length - 1]) : "";
    if (normOrig && normOrig === lastOrig) return { orig: "", trans: "" };

    const oKo = this.getHangulRatio(orig);
    const tKo = this.getHangulRatio(trans);
    if (cfg.autoMode === "to_ko_only" && oKo > 0.75) return { orig: "", trans: "" };
    if (cfg.autoMode === "to_ko_only" && tKo === 0 && orig.length > 10) return { orig: "", trans: "" };
    if (cfg.autoMode === "from_ko_only" && oKo < 0.15 && orig.length > 10) return { orig: "", trans: "" };

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

  // 여러 줄로 길게 출력되는 원문과 완역문도 뒷부분 잘림 없이 100% 추출
  parseOrigAndTrans(rawText) {
    if (!rawText || /^NONE$/i.test(rawText.trim())) return { orig: "", trans: "" };
    const cleaned = rawText.replace(/```[a-z]*\n?/gi, "").replace(/```/g, "").trim();

    const pairMatch = cleaned.match(/ORIG\s*:\s*([\s\S]*?)\n+\s*TRANS\s*:\s*([\s\S]*)$/i);
    if (pairMatch) {
      const o = pairMatch[1].replace(/\s+/g, " ").trim();
      const t = pairMatch[2].replace(/\s+/g, " ").trim();
      if (!o || !t || /^NONE$/i.test(o) || /^NONE$/i.test(t)) return { orig: "", trans: "" };
      return { orig: o, trans: t };
    }

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

  async callSingleModel(modelId, apiKey, parts, temperature = 0.1, timeoutMs = 16000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const generationConfig = {
      temperature,
      maxOutputTokens: 1024
    };
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

  async callWithSmartFailover(primaryModel, cfg, parts, temperature = 0.1, timeoutMs = 16000) {
    const now = Date.now();
    const effectivePrimary = (cfg.activeTier === "paid" && primaryModel === "gemini-3.5-flash-lite")
      ? "gemini-3.8-flash"
      : primaryModel;
    const candidates = [effectivePrimary, "gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.5-flash-lite"]
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

  buildVerbatimDirectionPrompt(cfg) {
    const pInfo = INTERPRETER_LANGS[cfg.partnerLang] || INTERPRETER_LANGS.en;
    const toneDesc = cfg.tone === "formal" ? "격식 있는 합쇼체" : (cfg.tone === "casual" ? "자연스러운 구어체" : "정중한 해요체");
    if (cfg.autoMode === "to_ko_only") {
      return `방향: [${pInfo.ko}(${pInfo.en}) 원음 → 한국어(${toneDesc}) 100% 완역]. 배경의 한국어 기계음만 무시하고, 원어민이 말한 ${pInfo.ko} 문장 전체를 빠짐없이 받아적고 한국어로 완역하십시오.`;
    }
    if (cfg.autoMode === "from_ko_only") {
      return `방향: [한국어 원음 → ${pInfo.ko}(${pInfo.en}, ${toneDesc}) 100% 완역]. 배경 외국어 기계음만 무시하고, 한국어 발화 전체를 받아적고 ${pInfo.en}로 완역하십시오.`;
    }
    return `한국어 발화는 ${pInfo.en}(${toneDesc})로, 외국어 발화는 한국어(${toneDesc})로 100% 완역하십시오.`;
  }

  async translateAudioSlice(seq, float32Samples) {
    const cfg = this.cb.getConfig();
    if (!cfg.apiKey) return;
    this.inFlightCount += 1;
    this.cb.onChannelState("문장 전체 수음 중", this.isVoiceMuted ? `#${seq} 무삭제 번역 중` : `#${seq} 무삭제 완역 중`);

    const boostedSamples = this.normalizeAudioSlice(float32Samples);
    const wavBase64 = this.encodeWavBase64(boostedSamples, 16000);
    const lastOrig = this.recentOrigList.slice(-1)[0] || "";
    const lastTrans = this.recentTranslations.slice(-1)[0] || "";

    const prompt = [
      "당신은 요약이나 축약을 절대 하지 않는 '무삭제 정밀 속기사 겸 1:1 완역 번역가'입니다.",
      this.buildVerbatimDirectionPrompt(cfg),
      "절대 준수 규칙:",
      "1. 요약·생략 절대 금지: 주어와 서술어만 남기고 중간 구절을 빼먹는 압축 번역을 엄격히 금지합니다.",
      "2. 오디오의 처음부터 끝까지 들리는 모든 단어, 목적어, 형용사·부사 수식어, 관계절·종속절, 중간 예시, 고유명사, 숫자를 단 하나도 빠뜨리지 말고 ORIG에 있는 그대로 100% 받아적으십시오.",
      "3. ORIG에 적힌 모든 구절과 세부 의미를 하나도 버리지 말고 한국어 어순에 맞춰 TRANS에 100% 온전하게 완역하십시오.",
      "4. 문장이 도중에 끊긴 구절이더라도 들린 구절 안에 있는 수식어와 목적어를 절대 생략하지 말고 그대로 다 번역하십시오.",
      "5. 사람 말소리가 전혀 없는 순수 무음·백색소음일 때만 NONE 네 글자만 출력하십시오.",
      lastOrig ? `직전 원문(문맥 연결 참고용): ${lastOrig}` : "",
      lastTrans ? `직전 번역(어투·대명사 연결 참고용): ${lastTrans}` : "",
      cfg.glossary ? `전문 용어집: ${cfg.glossary}` : "",
      "출력 형식(설명 없이 아래 두 항목만 출력):",
      "ORIG: 들린 원문 전체 100% 받아쓰기",
      "TRANS: 중간 생략 없는 100% 완역문"
    ].filter(Boolean).join("\n");

    const parts = [{ text: prompt }, { inlineData: { mimeType: "audio/wav", data: wavBase64 } }];
    try {
      const out = await this.callWithSmartFailover(cfg.modelId, cfg, parts, 0.1, 16000);
      this.pendingResults.set(seq, this.validateResult(this.parseOrigAndTrans(out), cfg));
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
        [{ text: `다음 문장의 모든 수식어와 중간 내용을 단 한 단어도 생략하지 말고 ${target}로 100% 완역해 결과만 출력하십시오:\n${trimmed}` }],
        0.1,
        12000
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
      if (!this.pendingResults.has(this.nextCommitSeq) && Date.now() - sentAt > 20000 && this.pendingResults.has(this.nextCommitSeq + 1)) {
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
        this.lastCommitAt = Date.now();
        this.recentOrigList.push(item.orig);
        if (this.recentOrigList.length > 6) this.recentOrigList.shift();
        this.recentTranslations.push(item.trans);
        if (this.recentTranslations.length > 6) this.recentTranslations.shift();

        if (!this.isVoiceMuted) {
          this.recordSpokenEcho(item.trans);
          this.enqueueSpeech(item.trans);
        }
        this.cb.onChunkCommitted(seq, item.orig, item.trans);
      } else if (!this.isSpeaking && Date.now() >= this.globalBackoffUntil) {
        const rightState = this.isVoiceMuted ? "음성 꺼짐(자막전용)" : "대기";
        this.cb.onChannelState(this.driverMode === "system_audio" ? "PC 소리 수신 중" : "문장 전체 수음 중", rightState);
      }
    }
  }

  enqueueSpeech(text) {
    if (this.isVoiceMuted) return;
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
    if (this.isVoiceMuted || this.isSpeaking || this.speechQueue.length === 0) return;
    this.isSpeaking = true;
    if (this.cb.onSpeakingChange) this.cb.onSpeakingChange(true);

    while (this.speechQueue.length > 0 && !this.isVoiceMuted) {
      const text = this.speechQueue.shift();
      const cfg = this.cb.getConfig();
      let playedAi = false;

      if (cfg.activeTier === "paid" && cfg.voiceModel === "hybrid_ai" && cfg.apiKey && Date.now() >= this.restTtsCooldownUntil) {
        playedAi = await this.tryFastGeminiRestTts(text, cfg);
      }
      if (!playedAi && !this.isVoiceMuted) {
        await this.playBrowserNeuralTts(text, cfg);
      }
    }

    this.currentActiveText = "";
    this.isSpeaking = false;
    this.muteUntilTime = Date.now() + 450;
    if (this.cb.onSpeakingChange) this.cb.onSpeakingChange(false);
  }

  async tryFastGeminiRestTts(text, cfg) {
    if (this.isVoiceMuted) return false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
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
      if (!res.ok || json.error || this.isVoiceMuted) {
        if (!res.ok) this.restTtsCooldownUntil = Date.now() + 60000;
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
    if (this.isVoiceMuted) return;
    this.unlockAudio(false);
    if (!this.outputCtx) return;
    this.applyOutputVolume(false);

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
        if (this.activeSources.size === 0 || this.isVoiceMuted) resolve();
        else setTimeout(check, 60);
      };
      check();
    });
  }

  playBrowserNeuralTts(text, cfg) {
    if (!("speechSynthesis" in window) || this.isVoiceMuted) return Promise.resolve();
    return new Promise((resolve) => {
      this.currentActiveText = text;
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

      const freshCfg = this.cb.getConfig();
      let rate = parseFloat(freshCfg.ttsRate) || 1.15;
      if (text.length > 55 || this.speechQueue.length >= 1) {
        rate = Math.min(1.38, rate + 0.14);
      }
      utter.rate = rate;
      utter.volume = Math.max(0.05, Math.min(1.0, parseFloat(freshCfg.ttsVolume ?? "1.0")));

      const guard = setTimeout(() => {
        try { window.speechSynthesis.cancel(); } catch (e) {}
        resolve();
      }, Math.max(12000, text.length * 380));

      const done = () => {
        clearTimeout(guard);
        if (this.currentActiveText === text) this.currentActiveText = "";
        resolve();
      };

      utter.onend = done;
      utter.onerror = done;
      try {
        if (!isAndroid && window.speechSynthesis.paused) {
          window.speechSynthesis.resume();
        }
        window.speechSynthesis.speak(utter);
      } catch (e) {
        done();
      }
    });
  }

  stopSpeechOnly() {
    if (this.volRestartTimer) {
      clearTimeout(this.volRestartTimer);
      this.volRestartTimer = null;
    }
    this.speechQueue = [];
    this.currentActiveText = "";
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
      `다음은 한국어와 ${pInfo.ko}(${pInfo.en}) 통역 대화 기록입니다. (경과 ${elapsedLabel})`,
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