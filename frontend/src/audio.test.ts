import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AudioCapture, AudioTranscriptionError } from "./audio";
import type { AudioStatus } from "./audio";

class Track {
  kind: "audio" | "video";
  label: string;
  readyState = "live";
  enabled = true;
  onended: (() => void) | null = null;
  onmute: (() => void) | null = null;
  stop = vi.fn(() => {
    this.readyState = "ended";
  });
  constructor(kind: "audio" | "video") {
    this.kind = kind;
    this.label = `test ${kind}`;
  }
}

class Stream {
  constructor(readonly tracks: Track[]) {}
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks.filter((track) => track.kind === "audio");
  }
  getVideoTracks() {
    return this.tracks.filter((track) => track.kind === "video");
  }
}

class Node {
  connect = vi.fn();
  disconnect = vi.fn();
}

class Worklet extends Node {
  static instances: Worklet[] = [];
  port = {
    onmessage: null as ((event: { data: ArrayBuffer }) => void) | null,
    close: vi.fn(),
  };
  onprocessorerror: (() => void) | null = null;
  constructor() {
    super();
    Worklet.instances.push(this);
  }
}

class Context {
  static instances: Context[] = [];
  state = "running";
  sampleRate = 16000;
  destination = {};
  audioWorklet = { addModule: vi.fn(async () => undefined) };
  createMediaStreamSource = vi.fn((_stream: Stream) => new Node());
  createGain = vi.fn(() => Object.assign(new Node(), { gain: { value: 1 } }));
  resume = vi.fn(async () => undefined);
  close = vi.fn(async () => {
    this.state = "closed";
  });
  constructor() {
    Context.instances.push(this);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("browser audio lifecycle", () => {
  let capture: AudioCapture;
  let states: AudioStatus[];
  let media: {
    getUserMedia: ReturnType<typeof vi.fn>;
    getDisplayMedia: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    Worklet.instances = [];
    Context.instances = [];
    states = [];
    media = {
      getUserMedia: vi.fn(async () => new Stream([new Track("audio")])),
      getDisplayMedia: vi.fn(
        async () => new Stream([new Track("audio"), new Track("video")]),
      ),
    };
    vi.stubGlobal("navigator", { mediaDevices: media });
    vi.stubGlobal("MediaStream", Stream);
    vi.stubGlobal("AudioContext", Context);
    vi.stubGlobal("AudioWorkletNode", Worklet);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test-worklet");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await capture?.stop();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function create(
    onChunk = vi.fn<(blob: Blob) => Promise<void>>(async () => undefined),
  ) {
    capture = new AudioCapture({
      onChunk,
      onState: (state) => states.push(state),
    });
    return onChunk;
  }

  function audio(
    seconds: number,
    value: number,
    node = Worklet.instances.at(-1)!,
  ) {
    let remaining = Math.round(seconds * 16000);
    while (remaining > 0) {
      const count = Math.min(2048, remaining);
      node.port.onmessage?.({
        data: new Float32Array(count).fill(value).buffer,
      });
      remaining -= count;
    }
  }

  it("rejects a screen capture without an audio track and releases every track", async () => {
    const video = new Track("video");
    media.getDisplayMedia.mockResolvedValue(new Stream([video]));
    const onChunk = create();
    await capture.start("online");
    expect(states.at(-1)?.state).toBe("error");
    expect(states.at(-1)?.error).toContain("音声を取得できません");
    expect(video.stop).toHaveBeenCalledOnce();
    expect(media.getUserMedia).not.toHaveBeenCalled();
    expect(onChunk).not.toHaveBeenCalled();
  });

  it("stops a late permission result after the user already stopped", async () => {
    const picker = deferred<Stream>();
    const track = new Track("audio");
    media.getUserMedia.mockReturnValue(picker.promise);
    create();
    const starting = capture.start("in_person");
    await capture.stop();
    picker.resolve(new Stream([track]));
    await starting;
    expect(track.stop).toHaveBeenCalledOnce();
    expect(Context.instances).toHaveLength(0);
    expect(states.at(-1)?.state).toBe("idle");
  });

  it("passes only audio to the graph and encodes actual mono PCM samples", async () => {
    const voice = new Track("audio");
    const video = new Track("video");
    media.getDisplayMedia.mockResolvedValue(new Stream([voice, video]));
    const onChunk = create();
    await capture.start("online");
    expect(video.enabled).toBe(false);
    const sourceCalls = Context.instances[0].createMediaStreamSource.mock.calls;
    expect(sourceCalls[0][0].tracks).toEqual([voice]);
    expect(states.at(-1)?.state).toBe("silent");
    audio(0.4, 0.5);
    expect(states.at(-1)?.state).toBe("listening");
    audio(0.9, 0);
    expect(states.at(-1)?.state).toBe("silent");
    expect(onChunk).toHaveBeenCalledOnce();
    const blob = onChunk.mock.calls[0][0];
    expect(blob.type).toBe("audio/wav");
    const data = await blob.arrayBuffer();
    const view = new DataView(data);
    expect(new TextDecoder().decode(data.slice(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(data.slice(8, 12))).toBe("WAVE");
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getInt16(44, true)).toBe(16384);
    expect(view.getUint32(40, true)).toBe(data.byteLength - 44);
  });

  it("does not transcribe silence or a short click and bounds long voice to six seconds", async () => {
    const onChunk = create();
    await capture.start("in_person");
    audio(3, 0);
    audio(0.1, 0.5);
    audio(1, 0);
    expect(onChunk).not.toHaveBeenCalled();
    audio(7, 0.5);
    audio(1, 0);
    await tick();
    expect(onChunk).toHaveBeenCalledTimes(2);
    for (const [blob] of onChunk.mock.calls) {
      expect(blob.size).toBeLessThanOrEqual(44 + 16000 * 6 * 2);
    }
  });

  it("the worklet downmixes stereo into transferable mono blocks without audio playback", async () => {
    create();
    await capture.start("in_person");
    const moduleBlob = vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob;
    const script = await moduleBlob.text();
    class ProcessorBase {
      port = { postMessage: vi.fn() };
    }
    type Processor = ProcessorBase & {
      process: (input: Float32Array[][], output: Float32Array[][]) => boolean;
    };
    let ProcessorClass!: new () => Processor;
    const register = (name: string, processorClass: new () => Processor) => {
      expect(name).toBe("sokuto-pcm");
      ProcessorClass = processorClass;
    };
    // Execute only the worklet code produced by this module, with its browser
    // globals substituted. No uploaded document or external code is evaluated.
    new Function("AudioWorkletProcessor", "registerProcessor", script)(
      ProcessorBase,
      register,
    );
    const processor = new ProcessorClass();
    const output = new Float32Array(2048);
    expect(
      processor.process(
        [[new Float32Array(2048).fill(0.8), new Float32Array(2048).fill(0.2)]],
        [[output]],
      ),
    ).toBe(true);
    expect(processor.port.postMessage).toHaveBeenCalledOnce();
    const [buffer, transfer] = processor.port.postMessage.mock.calls[0];
    expect(new Float32Array(buffer)[0]).toBeCloseTo(0.5);
    expect(transfer).toEqual([buffer]);
    expect(output.every((sample) => sample === 0)).toBe(true);
  });

  it("serializes chunks and discards queued and late worklet data on stop", async () => {
    const request = deferred<void>();
    const onChunk = create(
      vi.fn<(blob: Blob) => Promise<void>>(() => request.promise),
    );
    await capture.start("in_person");
    const node = Worklet.instances[0];
    const lateMessage = node.port.onmessage!;
    audio(0.4, 0.5);
    audio(1, 0);
    audio(0.4, 0.5);
    audio(1, 0);
    expect(onChunk).toHaveBeenCalledOnce();
    await capture.stop();
    lateMessage({ data: new Float32Array(16000).fill(0.5).buffer });
    request.resolve();
    await tick();
    expect(onChunk).toHaveBeenCalledOnce();
    expect(node.port.close).toHaveBeenCalledOnce();
    expect(Context.instances[0].close).toHaveBeenCalledOnce();
    expect(states.at(-1)?.state).toBe("idle");
  });

  it("continues a new session after an old upload rejects without parallel uploads", async () => {
    const oldRequest = deferred<void>();
    const onChunk = create(
      vi
        .fn<(blob: Blob) => Promise<void>>()
        .mockImplementationOnce(() => oldRequest.promise)
        .mockResolvedValue(undefined),
    );
    await capture.start("in_person");
    audio(0.4, 0.5);
    audio(1, 0);
    await capture.stop();
    await capture.start("online");
    audio(0.4, 0.5);
    audio(1, 0);
    expect(onChunk).toHaveBeenCalledOnce();
    oldRequest.reject(new Error("aborted old request"));
    await tick();
    expect(onChunk).toHaveBeenCalledTimes(2);
    expect(states.at(-1)?.state).toBe("silent");
  });

  it("stops with an actionable error instead of silently dropping an unbounded backlog", async () => {
    const request = deferred<void>();
    const onChunk = create(
      vi.fn<(blob: Blob) => Promise<void>>(() => request.promise),
    );
    await capture.start("in_person");
    for (let index = 0; index < 6; index++) {
      audio(0.4, 0.5);
      audio(1, 0);
    }
    expect(states.at(-1)?.state).toBe("error");
    expect(states.at(-1)?.error).toContain("処理が追いつかない");
    expect(onChunk).toHaveBeenCalledOnce();
    request.resolve();
    await tick();
    expect(onChunk).toHaveBeenCalledOnce();
  });

  it("releases resources when input is disconnected and handles permission rejection", async () => {
    const track = new Track("audio");
    media.getUserMedia.mockResolvedValue(new Stream([track]));
    create();
    await capture.start("in_person");
    track.onended?.();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(states.at(-1)?.error).toContain("切断");
    media.getUserMedia.mockRejectedValue(
      new DOMException("denied", "NotAllowedError"),
    );
    await capture.start("in_person");
    expect(states.at(-1)?.error).toContain("許可されていません");
    expect(states.at(-1)?.error).not.toContain("denied");
  });

  it("shows a safe transcription timeout and stops queued audio", async () => {
    const request = deferred<void>();
    const onChunk = create(vi.fn<(blob: Blob) => Promise<void>>(() => request.promise));
    await capture.start("in_person");
    audio(0.4, 0.5);
    audio(1, 0);
    audio(0.4, 0.5);
    audio(1, 0);
    request.reject(new AudioTranscriptionError("Whisperの音声認識が時間切れになりました。"));
    await tick();
    expect(states.at(-1)?.state).toBe("error");
    expect(states.at(-1)?.error).toContain("時間切れ");
    expect(Context.instances[0].close).toHaveBeenCalledOnce();
    expect(onChunk).toHaveBeenCalledOnce();
  });
});
