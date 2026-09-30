export type AudioStatus = {
  state: "idle" | "requesting" | "listening" | "silent" | "error";
  inputLabel: string;
  error?: string;
};

// Only deliberately user-facing transcription errors are shown verbatim.
export class AudioTranscriptionError extends Error {}

type CaptureOptions = {
  onChunk: (blob: Blob) => Promise<void>;
  onState: (status: AudioStatus) => void;
};

// These are prototype signal thresholds, not validated transcription guarantees.
const VOICE_RMS = 0.012;
const SILENCE_SECONDS = 0.8;
const PRE_ROLL_SECONDS = 0.2;
const MIN_VOICE_SECONDS = 0.2;
const MAX_CHUNK_SECONDS = 6;
const MAX_PENDING_CHUNKS = 3;

// AudioWorklet receives audio only. Its output remains zero so the microphone
// cannot feed back through the speakers. Transfer bounded blocks to the UI thread.
const PROCESSOR_SOURCE = `
class SokutoPCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(2048);
    this.offset = 0;
  }
  process(inputs, outputs) {
    const channels = inputs[0] || [];
    const count = channels[0]?.length || outputs[0]?.[0]?.length || 128;
    for (let i = 0; i < count; i++) {
      let mono = 0;
      for (let channel = 0; channel < channels.length; channel++) {
        mono += channels[channel][i] || 0;
      }
      this.buffer[this.offset++] = channels.length ? mono / channels.length : 0;
      if (this.offset === this.buffer.length) {
        this.port.postMessage(this.buffer.buffer, [this.buffer.buffer]);
        this.buffer = new Float32Array(2048);
        this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor('sokuto-pcm', SokutoPCMProcessor);
`;

function wavBlob(
  blocks: Float32Array[],
  sampleCount: number,
  sampleRate: number,
): Blob {
  const buffer = new ArrayBuffer(44 + sampleCount * 2);
  const view = new DataView(buffer);
  const writeText = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index++) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };
  writeText(0, "RIFF");
  view.setUint32(4, 36 + sampleCount * 2, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // Linear PCM.
  view.setUint16(22, 1, true); // Mono.
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, sampleCount * 2, true);
  let offset = 44;
  for (const block of blocks) {
    for (const value of block) {
      const sample = Math.max(-1, Math.min(1, value));
      view.setInt16(
        offset,
        Math.round(sample * (sample < 0 ? 32768 : 32767)),
        true,
      );
      offset += 2;
    }
  }
  return new Blob([buffer], { type: "audio/wav" });
}

function captureError(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "SecurityError") {
      return "音声へのアクセスが許可されていません。入力設定を確認するか、質問を手入力してください。";
    }
    if (error.name === "NotFoundError") {
      return "音声の入力元が見つかりません。入力機器を確認するか、質問を手入力してください。";
    }
    if (error.name === "NotReadableError") {
      return "音声の入力元を開けませんでした。OSの権限と入力機器を確認してください。";
    }
    if (error.name === "InvalidStateError") {
      return "音声取り込みを開始できませんでした。この画面で開始ボタンを押し直してください。";
    }
  }
  return "音声取り込みを開始できませんでした。入力元を確認するか、質問を手入力してください。";
}

/**
 * Browser capture for synthetic-data evaluation. Desktop meeting audio support
 * must still be verified on each target OS/browser/application combination.
 * getDisplayMedia may return no audio even with audio:true:
 * https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia
 *
 * Call start() directly from a user click; screen capture needs user activation.
 * stop() discards unsent audio. A callback already in flight cannot be revoked
 * through this API; the caller must abort/fence its HTTP request on stop/unmount.
 */
export class AudioCapture {
  private readonly options: CaptureOptions;
  private generation = 0;
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: AudioWorkletNode | null = null;
  private gain: GainNode | null = null;
  private moduleUrl: string | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private lastBlockAt = 0;
  private lastState: AudioStatus = { state: "idle", inputLabel: "未接続" };
  private sampleRate = 48000;
  private preRoll: Float32Array[] = [];
  private preRollSamples = 0;
  private blocks: Float32Array[] = [];
  private samples = 0;
  private voicedSamples = 0;
  private silentSamples = 0;
  private pending: Array<{ blob: Blob; generation: number }> = [];
  private delivering = false;

  constructor(options: CaptureOptions) {
    this.options = options;
  }

  async start(mode: "online" | "in_person"): Promise<void> {
    const generation = ++this.generation;
    // Release synchronously without awaiting: preserve transient user activation
    // for the permission picker even when changing input sources.
    void this.release();
    const inputLabel =
      mode === "online" ? "共有する画面・タブの音声" : "マイク";
    this.emit({ state: "requesting", inputLabel });

    const mediaDevices = navigator.mediaDevices;
    if (
      !mediaDevices ||
      typeof AudioContext === "undefined" ||
      typeof AudioWorkletNode === "undefined"
    ) {
      this.fail(
        generation,
        "このブラウザでは音声取り込みを利用できません。HTTPSまたはlocalhostで開き、対応ブラウザを使うか質問を手入力してください。",
      );
      return;
    }
    if (
      mode === "online" &&
      typeof mediaDevices.getDisplayMedia !== "function"
    ) {
      this.fail(
        generation,
        "この環境では会議音声の共有を利用できません。質問を手入力してください。",
      );
      return;
    }

    try {
      // The browser requires video:true for screen capture. No video frame is
      // read, encoded, saved or sent. Only getAudioTracks() enters the graph.
      // The disabled video track stays alive until stop to keep shared audio
      // active in browsers where stopping the video also ends screen sharing.
      const displayOptions: DisplayMediaStreamOptions & {
        systemAudio: "include";
      } = {
        video: true,
        audio: true,
        systemAudio: "include",
      };
      const stream = await (mode === "online"
        ? mediaDevices.getDisplayMedia(displayOptions)
        : mediaDevices.getUserMedia({
            video: false,
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            },
          }));
      if (generation !== this.generation) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.stream = stream;
      const audioTracks = stream
        .getAudioTracks()
        .filter((track) => track.readyState === "live");
      if (!audioTracks.length) {
        this.fail(
          generation,
          "共有元から音声を取得できませんでした。音声共有の設定と入力元を確認してください。マイクだけでは会議相手の音声を取得したことにはなりません。質問は手入力できます。",
        );
        return;
      }
      for (const track of stream.getVideoTracks()) track.enabled = false;
      for (const track of stream.getTracks()) {
        track.onended = () =>
          this.fail(
            generation,
            "音声入力が切断されました。入力元を選び直すか、質問を手入力してください。",
          );
      }
      for (const track of audioTracks) {
        track.onmute = () => {
          if (generation === this.generation)
            this.emit({
              state: "silent",
              inputLabel: this.lastState.inputLabel,
            });
        };
      }
      const actualLabel = audioTracks
        .map((track) => track.label)
        .filter(Boolean)
        .join(" / ");
      this.emit({
        state: "requesting",
        inputLabel: actualLabel ? `${inputLabel}：${actualLabel}` : inputLabel,
      });

      const context = new AudioContext();
      this.context = context;
      if (!context.audioWorklet) {
        this.fail(
          generation,
          "この環境では音声の解析を開始できません。対応ブラウザを使うか、質問を手入力してください。",
        );
        return;
      }
      this.sampleRate = context.sampleRate;
      const moduleUrl = URL.createObjectURL(
        new Blob([PROCESSOR_SOURCE], { type: "text/javascript" }),
      );
      this.moduleUrl = moduleUrl;
      await context.audioWorklet.addModule(moduleUrl);
      URL.revokeObjectURL(moduleUrl);
      if (this.moduleUrl === moduleUrl) this.moduleUrl = null;
      if (generation !== this.generation) return;

      this.source = context.createMediaStreamSource(
        new MediaStream(audioTracks),
      );
      this.processor = new AudioWorkletNode(context, "sokuto-pcm", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      this.processor.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        if (generation === this.generation)
          this.consume(new Float32Array(event.data), generation);
      };
      this.processor.onprocessorerror = () =>
        this.fail(
          generation,
          "音声の解析が停止しました。取り込みを開始し直すか、質問を手入力してください。",
        );
      this.gain = context.createGain();
      this.gain.gain.value = 0;
      this.source.connect(this.processor);
      this.processor.connect(this.gain);
      this.gain.connect(context.destination);
      await context.resume();
      if (generation !== this.generation) return;
      this.lastBlockAt = Date.now();
      this.emit({ state: "silent", inputLabel: this.lastState.inputLabel });
      // A suspended/interrupted audio graph produces no callbacks. Do not leave
      // a stale "listening" indicator indefinitely when the source disappears.
      this.watchdog = setInterval(() => {
        if (
          generation === this.generation &&
          Date.now() - this.lastBlockAt > 3000
        ) {
          this.emit({ state: "silent", inputLabel: this.lastState.inputLabel });
        }
      }, 1000);
    } catch (error) {
      this.fail(generation, captureError(error));
    }
  }

  async stop(): Promise<void> {
    ++this.generation;
    const closed = this.release();
    this.emit({ state: "idle", inputLabel: "未接続" });
    await closed;
  }

  private consume(block: Float32Array, generation: number): void {
    const room = Math.ceil(this.sampleRate * MAX_CHUNK_SECONDS) - this.samples;
    if (this.samples > 0 && block.length > room) {
      this.consume(block.subarray(0, room), generation);
      if (generation === this.generation)
        this.consume(block.subarray(room), generation);
      return;
    }
    this.lastBlockAt = Date.now();
    let energy = 0;
    for (const sample of block) energy += sample * sample;
    const voiced = Math.sqrt(energy / Math.max(1, block.length)) >= VOICE_RMS;

    if (voiced) {
      this.emit({ state: "listening", inputLabel: this.lastState.inputLabel });
      if (!this.blocks.length) {
        this.blocks = this.preRoll;
        this.samples = this.preRollSamples;
        this.preRoll = [];
        this.preRollSamples = 0;
      }
      this.voicedSamples += block.length;
      this.silentSamples = 0;
    } else {
      this.silentSamples += block.length;
      if (this.silentSamples >= this.sampleRate * SILENCE_SECONDS) {
        this.emit({ state: "silent", inputLabel: this.lastState.inputLabel });
      }
    }

    if (this.samples > 0 || voiced) {
      this.blocks.push(block);
      this.samples += block.length;
      if (
        this.samples >= this.sampleRate * MAX_CHUNK_SECONDS ||
        this.silentSamples >= this.sampleRate * SILENCE_SECONDS
      ) {
        if (this.voicedSamples >= this.sampleRate * MIN_VOICE_SECONDS) {
          const blob = wavBlob(this.blocks, this.samples, this.sampleRate);
          if (this.pending.length >= MAX_PENDING_CHUNKS) {
            this.fail(
              generation,
              "音声の処理が追いつかないため、取り込みを停止しました。接続を確認して開始し直すか、質問を手入力してください。",
            );
            return;
          }
          this.pending.push({ blob, generation });
          void this.deliver();
        }
        this.blocks = [];
        this.samples = 0;
        this.voicedSamples = 0;
      }
    } else {
      this.preRoll.push(block);
      this.preRollSamples += block.length;
      while (
        this.preRollSamples > this.sampleRate * PRE_ROLL_SECONDS &&
        this.preRoll.length > 1
      ) {
        this.preRollSamples -= this.preRoll.shift()!.length;
      }
    }
  }

  private async deliver(): Promise<void> {
    if (this.delivering) return;
    this.delivering = true;
    try {
      while (this.pending.length) {
        const next = this.pending.shift()!;
        if (next.generation !== this.generation) continue;
        try {
          await this.options.onChunk(next.blob);
        } catch (error) {
          this.fail(
            next.generation,
            error instanceof AudioTranscriptionError ? error.message : "音声を文字起こしに送れませんでした。接続と音声サービスの設定を確認し、取り込みを開始し直してください。質問は手入力できます。",
          );
        }
      }
    } finally {
      this.delivering = false;
    }
  }

  private emit(status: AudioStatus): void {
    if (
      status.state === this.lastState.state &&
      status.inputLabel === this.lastState.inputLabel &&
      status.error === this.lastState.error
    )
      return;
    this.lastState = status;
    this.options.onState(status);
  }

  private fail(generation: number, error: string): void {
    if (generation !== this.generation) return;
    ++this.generation;
    const inputLabel = this.lastState.inputLabel;
    void this.release();
    this.emit({ state: "error", inputLabel, error });
  }

  private release(): Promise<void> {
    if (this.watchdog !== null) clearInterval(this.watchdog);
    this.watchdog = null;
    if (this.processor) {
      this.processor.port.onmessage = null;
      this.processor.onprocessorerror = null;
      this.processor.port.close();
      this.processor.disconnect();
    }
    this.source?.disconnect();
    this.gain?.disconnect();
    for (const track of this.stream?.getTracks() ?? []) {
      track.onended = null;
      track.onmute = null;
      track.stop();
    }
    if (this.moduleUrl) URL.revokeObjectURL(this.moduleUrl);
    const context = this.context;
    this.stream = null;
    this.context = null;
    this.source = null;
    this.processor = null;
    this.gain = null;
    this.moduleUrl = null;
    this.pending = [];
    this.preRoll = [];
    this.preRollSamples = 0;
    this.blocks = [];
    this.samples = 0;
    this.voicedSamples = 0;
    this.silentSamples = 0;
    return context && context.state !== "closed"
      ? context.close().catch(() => undefined)
      : Promise.resolve();
  }
}
